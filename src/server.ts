/**
 * server — builds the fleet MCP server (tool registration), shared by both
 * frontends: `mcp.ts` (stdio) and `http.ts` (remote). One place defines the
 * tools; the transports differ. All tools delegate to the `core.ts` actions.
 *
 * Read tools (ls/status/gpu/logs) are always registered. The mutating tools
 * (exec/cp/restart/run) are registered only when `readOnly` is false — the
 * kill-switch (`FLEET_MCP_READONLY=1`) makes them vanish from `tools/list`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FleetConfig } from "./config.ts";
import type { ExecResult } from "./ssh.ts";
import {
  lsHosts, runExec, pushFile, restartService, serviceLogs,
  gpuRows, hostStatus, runRecipe, captureScreenshot, cuRun,
  rebootHosts, bootState, switchMachine, routeSelector, svcStatus,
} from "./core.ts";
import { spawnJob, listJobs, jobLog, jobTail, killJob } from "./jobs.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";

/** Read a local image as base64, then delete it — MCP responses embed the bytes,
 *  so keeping the temp file around would just leak into tmpdir forever. */
async function consumeImage(path: string): Promise<string> {
  const data = Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64");
  await unlink(path).catch(() => {});
  return data;
}

// ── plain-text renderers (no ANSI — agents read text) ─────────────────────────
function indent(s: string, pad = "  "): string {
  return s.split("\n").map((l) => pad + l).join("\n");
}
function renderExec(results: ExecResult[]): string {
  return results.map((r) => {
    const head = `${r.ok ? "✓" : "✗"} ${r.host} · exit ${r.code}`;
    const body = [
      r.stdout && indent(r.stdout),
      r.stderr && indent("stderr: " + r.stderr),
    ].filter(Boolean).join("\n");
    return body ? `${head}\n${body}` : head;
  }).join("\n\n");
}
const text = (t: string, isError = false) =>
  ({ content: [{ type: "text" as const, text: t || "(no output)" }], isError });

function selectorHelp(cfg: FleetConfig): string {
  const hosts = Object.keys(cfg.hosts).join(", ");
  const groups = Object.keys(cfg.groups ?? {}).map((g) => "@" + g).join(" ");
  return `Selector: a host name, an @group, "all", or a comma-mix (e.g. "vps,@gpu"). `
    + `Hosts: ${hosts}. Groups: @linux @windows @mac @gpu${groups ? " " + groups : ""}.`;
}

export interface BuildOpts { readOnly?: boolean }

export function buildServer(cfg: FleetConfig, opts: BuildOpts = {}): McpServer {
  const server = new McpServer({ name: "fleet", version: "0.4.0" });
  const sel = selectorHelp(cfg);
  const recipeNames = Object.keys(cfg.recipes ?? {});

  // ── read-only tools (always registered) ─────────────────────────────────────
  server.registerTool("fleet_ls", {
    title: "List fleet hosts",
    description: "Probe reachability of every configured host and list each host's OS, "
      + "ssh alias, GPU flag, and configured service names.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async () => {
    const rows = await lsHosts(cfg);
    const out = rows.map((h) =>
      `${h.up ? "●" : h.httpUp ? "◍" : "○"} ${h.name.padEnd(10)} ${h.os.padEnd(8)} ${h.ssh.padEnd(16)} `
      + `${h.gpu ? "gpu " : "    "}${!h.up && h.httpUp ? "ssh-down/http-ok " : ""}`
      + `${h.services.length ? "[" + h.services.join(", ") + "]" : ""}`.trimEnd(),
    ).join("\n");
    return text(out);
  });

  server.registerTool("fleet_logs", {
    title: "Read a service's recent logs",
    description: "Fetch recent logs / status for a configured service (journalctl on Linux, "
      + "Get-Service / schtasks query on Windows). Use fleet_ls for valid service names.",
    inputSchema: {
      host: z.string().describe("Host name (or selector — first matched host is used)."),
      service: z.string().describe("Configured service name on that host."),
      lines: z.number().int().positive().optional().describe("How many log lines (default 30)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ host, service, lines }) => {
    const actions = await serviceLogs(cfg, await routeSelector(cfg, host), service, lines ?? 30);
    return text(renderExec(actions.map((a) => a.result)), actions.some((a) => !a.result.ok));
  });

  server.registerTool("fleet_svc", {
    title: "Service status across the fleet",
    description: "At-a-glance up/down status of one named service on every host that defines it "
      + "(systemd is-active / Get-Service / schtasks query). Answers \"is X running everywhere?\" "
      + "in one call. Use fleet_ls for valid service names.",
    inputSchema: {
      service: z.string().describe("Configured service name to check."),
      selector: z.string().optional().describe("Optional host selector to scope it (default: all)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ service, selector }) => {
    const rows = await svcStatus(cfg, selector ?? "all", service);
    const out = rows.map((r) => `${r.up ? "●" : "○"} ${r.host.padEnd(10)} ${r.service.padEnd(16)} ${r.detail} (${r.type})`).join("\n");
    return text(out, rows.some((r) => !r.up));
  });

  server.registerTool("fleet_jobs", {
    title: "List detached jobs",
    description: "List the detached background jobs (fleet spawn) across the fleet — each shows "
      + "host:id, status (running/exited/dead), exit code, pid, and the command. " + sel,
    inputSchema: {
      selector: z.string().optional().describe("Optional host selector to scope the list (default: all)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ selector }) => {
    const errors: string[] = [];
    const rows = await listJobs(cfg, selector ?? "all", (h, e) => errors.push(`✗ ${h}: list failed — ${e}`));
    if (!rows.length && !errors.length) return text("no jobs");
    const out = rows.map((r) =>
      `${r.status === "running" ? "●" : r.status === "exited" ? "○" : "✗"} `
      + `${(r.host + ":" + r.id).padEnd(24)} ${r.status.padEnd(8)} `
      + `${(r.status === "exited" ? "exit " + r.code : "pid " + (r.pid ?? "—")).padEnd(10)} ${r.cmd}`,
    ).join("\n");
    return text([out, ...errors].filter(Boolean).join("\n"), errors.length > 0);
  });

  server.registerTool("fleet_job_log", {
    title: "Read a detached job's output",
    description: "Fetch the captured output of one detached job, addressed as host:id (from "
      + "fleet_jobs). Pass tail to get only the last N lines instead of the full log.",
    inputSchema: {
      ref: z.string().describe("Job reference: \"host:id\" (e.g. \"oracle:mr0gnez7-iqd8\")."),
      tail: z.number().int().positive().optional().describe("Return only the last N lines (default: full log)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ ref, tail }) => {
    const { output } = tail ? await jobTail(cfg, ref, undefined, tail) : await jobLog(cfg, ref);
    return text(output || "(no output yet)");
  });

  server.registerTool("fleet_boot", {
    title: "Which OS is live on a dual-boot machine",
    description: "Report which boot (OS) is currently live on a dual-boot machine, and the "
      + "reachability of each of its boots. Machines: "
      + (Object.keys(cfg.machines ?? {}).join(", ") || "none configured") + ".",
    inputSchema: {
      machine: z.string().describe("Dual-boot machine name."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ machine }) => {
    const st = await bootState(cfg, machine);
    const head = st.live ? `● ${machine}: ${st.live} (via ${st.transport}, ${st.liveHost})`
      : `○ ${machine}: powered off / unreachable`;
    const boots = st.boots.map((b) => `  ${b.reachable ? "●" : "○"} ${b.os.padEnd(10)} ${b.host}`).join("\n");
    return text(`${head}\n${boots}`, !st.live);
  });

  server.registerTool("fleet_gpu", {
    title: "GPU stats across the fleet",
    description: "Every GPU reported by the dashboard: utilisation, free VRAM, temperature, "
      + "power draw, and the currently loaded model (if any).",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async () => {
    const rows = await gpuRows(cfg);
    if (!rows.length) return text("no GPUs reported by the dashboard");
    const out = rows.map((r) =>
      `${r.host.padEnd(9)} ${r.gpu.padEnd(22)} util ${(((r.util ?? 0) | 0) + "%").padEnd(5)} `
      + `free ${(r.free_gb?.toFixed(1) ?? "—") + "g"}  temp ${((r.temp ?? 0) | 0)}°c  `
      + `${r.model || "idle"}`,
    ).join("\n");
    return text(out);
  });

  server.registerTool("fleet_status", {
    title: "Live host stats",
    description: "Live CPU / memory / disk / GPU stats pulled from the dashboard, plus uptime "
      + "checks. Omit `host` for the whole fleet, or pass one host name to scope it.",
    inputSchema: {
      host: z.string().optional().describe("Optional single host name to scope the report."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ host }) => {
    const { nodes, uptime } = await hostStatus(cfg, host);
    const lines: string[] = [];
    for (const [k, n] of Object.entries<any>(nodes)) {
      const mem = n.mem ?? {}, disk = (n.disks ?? [])[0] ?? {}, gpu = (n.gpu ?? [])[0];
      const g = gpu ? `  gpu ${(gpu.util | 0)}% ${(gpu.temp | 0)}°c` : "";
      lines.push(`${n.stale ? "◐" : "●"} ${k.padEnd(9)} cpu ${((n.cpu_pct ?? "—") + "%").padEnd(5)} `
        + `mem ${((mem.pct ?? "—") + "%").padEnd(5)} disk ${((disk.pct ?? "—") + "%").padEnd(5)}${g}`);
    }
    if (!host) for (const e of uptime) {
      const up = e.code && e.code < 400;
      lines.push(`${up ? "●" : "○"} ${e.label.padEnd(16)} ${(e.ms ?? "—")}ms code ${e.code ?? "down"}`);
    }
    return text(lines.join("\n") || `no data${host ? " for " + host : ""}`);
  });

  // ── mutating tools (skipped when readOnly — the kill-switch) ─────────────────
  if (opts.readOnly) return server;

  // Registered behind the kill-switch: capturing runs commands on the host and
  // (on Windows) registers a one-shot scheduled task — not read-only in effect.
  server.registerTool("fleet_screenshot", {
    title: "Screenshot a host's desktop",
    description: "Capture the current desktop of a host and return it as a PNG image — for "
      + "diagnosing what is actually on screen (a hung app, a dialog, a crashed UI). Captures the "
      + "active interactive session on Windows/mac; on Linux needs grim/scrot/imagemagick and a "
      + "reachable display. " + sel,
    inputSchema: {
      host: z.string().describe("Host name (or selector — first matched host is used)."),
    },
    annotations: { openWorldHint: true },
  }, async ({ host }) => {
    const local = join(tmpdir(), `fleet_shot_${Date.now()}.png`);
    try {
      const r = await captureScreenshot(cfg, host, local);
      const data = await consumeImage(r.localPath);
      return { content: [
        { type: "text" as const, text: `screenshot of ${r.host}` },
        { type: "image" as const, data, mimeType: "image/png" },
      ] };
    } catch (e) {
      return text((e as Error).message, true);
    }
  });

  server.registerTool("fleet_exec", {
    title: "Run a command on host(s)",
    description: "Run a shell command on one or more hosts in parallel, over a quoting-proof "
      + "channel (bash via stdin on Linux/mac, PowerShell EncodedCommand on Windows) — pass the "
      + "command verbatim, never pre-escape it. Command syntax is the TARGET's native shell: "
      + "bash for @linux/@mac, PowerShell for @windows (set wsl:true to run bash inside WSL on a "
      + "Windows box). " + sel,
    inputSchema: {
      selector: z.string().describe("Host selector, e.g. \"winbox\", \"@linux\", \"all\", \"vps,@gpu\"."),
      command: z.string().describe("Command to run, verbatim. Quotes/pipes/$ round-trip as-is."),
      wsl: z.boolean().optional().describe("Run the command inside WSL bash on a Windows host."),
      timeout: z.number().int().positive().optional()
        .describe("Wall-clock cap in seconds — a hung command returns exit 124 instead of blocking forever."),
    },
    annotations: { openWorldHint: true },
  }, async ({ selector, command, wsl, timeout }) => {
    const results = await runExec(cfg, selector, command, { wsl, timeoutMs: timeout ? timeout * 1000 : undefined });
    return text(renderExec(results), results.some((r) => !r.ok));
  });

  server.registerTool("fleet_cp", {
    title: "Copy a file to host(s)",
    description: "scp a local file to one or more hosts (fan-out across a group). Remote path is "
      + "passed verbatim (forward slashes and C:\\… both work on Windows OpenSSH). " + sel,
    inputSchema: {
      local: z.string().describe("Path to the local file to push."),
      selector: z.string().describe("Destination host selector."),
      remote: z.string().describe("Remote destination path."),
    },
    annotations: { openWorldHint: true },
  }, async ({ local, selector, remote }) => {
    const results = await pushFile(cfg, local, selector, remote);
    const out = results.map((r) =>
      `${r.ok ? "✓" : "✗"} ${r.host} · ${local} → ${remote}${r.stderr ? "\n" + indent(r.stderr) : ""}`,
    ).join("\n");
    return text(out, results.some((r) => !r.ok));
  });

  server.registerTool("fleet_restart", {
    title: "Restart a configured service",
    description: "Restart a service that is defined in the host's config (systemd / Windows "
      + "service / scheduled task — the right restart verb is chosen automatically). Use fleet_ls "
      + "to see each host's known service names.",
    inputSchema: {
      host: z.string().describe("Host name (or any selector — the first matched host is used)."),
      service: z.string().describe("Configured service name on that host."),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({ host, service }) => {
    const actions = await restartService(cfg, await routeSelector(cfg, host), service);
    const out = actions.map((a) => `↻ ${a.host} :: ${a.service} (${a.type})\n${renderExec([a.result])}`).join("\n\n");
    return text(out, actions.some((a) => !a.result.ok));
  });

  server.registerTool("fleet_spawn", {
    title: "Launch a detached background job",
    description: "Start a long-running command as a DETACHED job that outlives the SSH session "
      + "(builds, training runs, anything slow) — returns a host:id to track with fleet_jobs / "
      + "fleet_job_log. Use this instead of fleet_exec for anything that takes more than a few "
      + "seconds. Works on Linux/mac (setsid) and Windows (interactive Scheduled Task → sees the "
      + "GPU). Command syntax is the target's native shell. " + sel,
    inputSchema: {
      selector: z.string().describe("Host selector (a dual-boot machine name auto-routes to its live OS)."),
      command: z.string().describe("Command to run, verbatim. Quotes/pipes/$ round-trip as-is."),
      cwd: z.string().optional().describe("Working directory to run in (fails fast if missing)."),
      label: z.string().optional().describe("Optional human-readable label prefixed onto the job id."),
    },
    annotations: { openWorldHint: true },
  }, async ({ selector, command, cwd, label }) => {
    const results = await spawnJob(cfg, await routeSelector(cfg, selector), command, { cwd, label });
    const out = results.map((r) => r.ok
      ? `● ${r.host} job ${r.id} · pid ${r.pid}  (track: fleet_jobs / fleet_job_log ${r.host}:${r.id})`
      : `✗ ${r.host} · ${r.error ?? "spawn failed"}`).join("\n");
    return text(out, results.some((r) => !r.ok));
  });

  server.registerTool("fleet_job_kill", {
    title: "Kill a detached job",
    description: "Terminate one detached job (and its whole process tree), addressed as host:id.",
    inputSchema: {
      ref: z.string().describe("Job reference: \"host:id\"."),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({ ref }) => {
    const r = await killJob(cfg, ref);
    return text(renderExec([r]), !r.ok);
  });

  server.registerTool("fleet_reboot", {
    title: "Reboot whole machine(s)",
    description: "Reboot every host the selector resolves to (the OS, not a service). This drops "
      + "the connection. A dual-boot machine name auto-routes to its live OS. " + sel,
    inputSchema: {
      selector: z.string().describe("Host selector to reboot."),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({ selector }) => {
    const actions = await rebootHosts(cfg, await routeSelector(cfg, selector));
    const out = actions.map((a) =>
      `${a.result.ok ? "↻" : "✗"} ${a.host} · ${a.os}${a.result.ok ? " · rebooting" : " · exit " + a.result.code}`,
    ).join("\n");
    return text(out, actions.some((a) => !a.result.ok));
  });

  server.registerTool("fleet_switch", {
    title: "Reboot a dual-boot machine into another OS",
    description: "Switch a dual-boot machine into a target OS (reboots into the other boot and "
      + "waits until it answers). Machines: " + (Object.keys(cfg.machines ?? {}).join(", ") || "none") + ".",
    inputSchema: {
      machine: z.string().describe("Dual-boot machine name."),
      to: z.string().describe("Target OS/boot label to switch into."),
      wait: z.boolean().optional().describe("Wait until the target boot is reachable (default true)."),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({ machine, to, wait }) => {
    const r = await switchMachine(cfg, machine, to, { wait: wait ?? true });
    if (wait === false) return text(`↻ ${machine}: switch to ${to} issued (from ${r.from ?? "?"}); not waiting`);
    return text(r.arrived
      ? `● ${machine} now in ${to} (${Math.round(r.waitedMs / 1000)}s)`
      : `✗ ${machine} did not reach ${to} in time`, !r.arrived);
  });

  server.registerTool("fleet_cu", {
    title: "Computer-use on a host (cua-driver)",
    description: "Drive a host's desktop via the cua-driver computer-use tool. Pass cua-driver "
      + "CLI args as an array, e.g. [\"list-tools\"], [\"get_screen_size\"], [\"list_windows\"], "
      + "[\"click\",\"{\\\"pid\\\":1234,\\\"window_id\\\":5,\\\"x\\\":100,\\\"y\\\":200}\"], or "
      + "[\"install\"] to install it. Set image:true for screen/window-capture calls to get the "
      + "PNG back. Needs a logged-in interactive desktop on the target. " + sel,
    inputSchema: {
      host: z.string().describe("Host name (or selector — first matched host is used)."),
      args: z.array(z.string()).describe("cua-driver CLI args, verbatim (tool name + JSON arg)."),
      image: z.boolean().optional().describe("True if the call captures a screenshot/window image."),
    },
    annotations: { openWorldHint: true },
  }, async ({ host, args, image }) => {
    if (args[0] === "install") {
      const { cuInstall } = await import("./core.ts");
      const r = await cuInstall(cfg, host);
      return text(renderExec([r]), !r.ok);
    }
    const local = image ? join(tmpdir(), `cua_${Date.now()}.png`) : undefined;
    const r = await cuRun(cfg, host, args, local);
    const content: any[] = [{ type: "text" as const, text: renderExec([r.result]) }];
    if (r.localImage) {
      const data = await consumeImage(r.localImage);
      content.push({ type: "image" as const, data, mimeType: "image/png" });
    }
    return { content, isError: !r.result.ok };
  });

  server.registerTool("fleet_run", {
    title: "Run a saved recipe (playbook)",
    description: "Run a saved recipe — an ordered playbook of fleet steps that stops on the first "
      + "failure." + (recipeNames.length ? ` Available recipes: ${recipeNames.join(", ")}.` : " (No recipes configured.)"),
    inputSchema: {
      recipe: z.string().describe(recipeNames.length ? `One of: ${recipeNames.join(", ")}.` : "Recipe name."),
    },
    annotations: { openWorldHint: true },
  }, async ({ recipe }) => {
    const run = await runRecipe(cfg, recipe);
    const blocks = run.steps.map((s, i) =>
      `[${i + 1}/${run.steps.length}] fleet ${s.step}\n${renderExec(s.results)}`);
    const footer = run.ok ? `\n✓ ${run.name} complete` : `\n✗ ${run.name} failed — stopped early`;
    return text(`▶ recipe ${run.name}\n\n${blocks.join("\n\n")}${footer}`, !run.ok);
  });

  return server;
}
