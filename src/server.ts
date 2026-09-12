/**
 * server — builds the fleet MCP server (tool registration), shared by both
 * frontends: `mcp.ts` (stdio) and `http.ts` (remote). One place defines the
 * tools; the transports differ. All tools delegate to the `core.ts` actions.
 *
 * Read/probe tools are always registered. Tools that execute commands, copy
 * files, capture the desktop, or otherwise mutate external state are registered
 * only when `readOnly` is false — the kill-switch (`FLEET_MCP_READONLY=1`)
 * makes them vanish from `tools/list`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FleetConfig } from "./config.ts";
import type { ExecResult } from "./ssh.ts";
import {
  lsHosts, runExec, runScript, readScriptSource, editRemoteFile, pushFile, pullFile, restartService, serviceLogs,
  gpuRows, diskRows, hostStatus, runRecipe, captureScreenshot, overlayGrid, cuRun,
  cuInstall, cuTools, cuDescribe, cuRecordStart, cuRecordStop, cuRecordStatus,
  cuApps, cuShotWindow, browseHost, deployHosts, diagnose,
  cuSnapshot, cuResolveTargetFrom, cuResolvePoint, cuAct, cuBatch, CU_BATCH_TOOLS, cuBlockerNote,
  cuGridCaption, cuElementSupport, compactCuOutput, briefDescribe,
  rebootHosts, firmwareRebootHosts, bootState, switchMachine, waitFor, routeSelector, svcStatus,
} from "./core.ts";
import {
  spawnJob, listJobs, jobLog, jobTail, killJob, waitJob, pruneJobs,
} from "./jobs.ts";
import { listSandboxes } from "./daytona.ts";
import { toolsStatus } from "./tools.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

/** Each request owns its image directory, including partial capture output. */
async function withTempImage<T>(prefix: string, capture: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await capture(join(directory, "image.png"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** MCP responses embed the bytes; withTempImage removes the local artifacts. */
async function consumeImage(path: string): Promise<string> {
  return Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64");
}

// ── plain-text renderers (no ANSI — agents read text) ─────────────────────────
function indent(s: string, pad = "  "): string {
  return s.split("\n").map((l) => pad + l).join("\n");
}
function renderExec(results: ExecResult[]): string {
  return results.map((r) => {
    const head = `${r.ok ? "✓" : "✗"} ${r.host} · exit ${r.code}`;
    const stdout = r.stdout.trimEnd();
    const body = [
      stdout && indent(stdout),
      r.stderr && indent("stderr: " + r.stderr),
    ].filter(Boolean).join("\n");
    return body ? `${head}\n${body}` : head;
  }).join("\n\n");
}
const text = (t: string, isError = false) =>
  ({ content: [{ type: "text" as const, text: t || "(no output)" }], isError });

function selectorHelp(cfg: FleetConfig): string {
  const hosts = Object.keys(cfg.hosts).join(", ");
  const routes = Object.keys(cfg.routes ?? {}).join(", ");
  const groups = Object.keys(cfg.groups ?? {}).map((g) => "@" + g).join(" ");
  return `Selector: a host name, logical route, an @group, "all", or a comma-mix (e.g. "vps,@gpu"). `
    + `Hosts: ${hosts}. Routes: ${routes || "none"}. `
    + `Groups: @linux @windows @mac @gpu${groups ? " " + groups : ""}.`;
}

/**
 * Ceiling on how long a wait tool may hold its response open, in seconds.
 *
 * Much lower than the CLI's cap on purpose. An MCP wait occupies a response
 * stream for its whole duration, and MCP 2026-07-28 drops stream resumability
 * (no `Last-Event-ID`, no redelivery) — a dropped connection loses the in-flight
 * request outright, so an hour-long hold through the tunnel is an hour-long bet.
 * Past this ceiling the agent should poll `fleet_jobs` / `fleet_job_log` instead,
 * which is the shape the protocol is moving toward anyway.
 */
export const MCP_WAIT_CAP_S = 120;

export interface BuildOpts { readOnly?: boolean }

export function buildServer(cfg: FleetConfig, opts: BuildOpts = {}): McpServer {
  const server = new McpServer({ name: "fleet", version: "0.5.0" });
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
      host: z.string().describe("Host name or selector. Reads every matched host defining this service; skips hosts without it."),
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
    const rows = await svcStatus(cfg, await routeSelector(cfg, selector ?? "all"), service);
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
    const rows = await listJobs(cfg, await routeSelector(cfg, selector ?? "all"),
      (h, e) => errors.push(`✗ ${h}: list failed — ${e}`));
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
      ref: z.string().describe("Job reference: \"host:id\" (e.g. \"web:mr0gnez7-iqd8\")."),
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

  server.registerTool("fleet_disk", {
    title: "Free space on every volume",
    description: "Free space per volume, queried live over ssh. Unlike `fleet_status` — which only "
      + "reports the boot volume (C:\\ or /) from the dashboard — this sees EVERY drive, so use it "
      + "for questions about secondary drives (D:, E:, external disks). Defaults to the whole fleet.",
    inputSchema: {
      selector: z.string().optional().describe(selectorHelp(cfg) + " Defaults to \"all\"."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ selector }) => {
    const sel = selector ?? "all";
    const rows = await diskRows(cfg, await routeSelector(cfg, sel));
    if (!rows.length) return text(`no volumes reported by ${sel}`);
    const w = Math.max(...rows.map((r) => r.mount.length));
    const out = rows.map((r) =>
      `${r.host.padEnd(9)} ${r.mount.padEnd(w)} ${(r.pct.toFixed(0) + "%").padStart(4)} used  `
      + `${r.free_gb.toFixed(1)}g free of ${r.total_gb.toFixed(0)}g`
      + `${r.label ? "  " + r.label : ""}`,
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

  server.registerTool("fleet_dt", {
    title: "List Daytona sandboxes",
    description: "Discover live Daytona sandboxes that can be addressed by the other tools as "
      + "`dt:<id|name|unique-prefix>`. Requires DAYTONA_API_KEY in the server environment.",
    inputSchema: {
      timeout: z.number().int().min(1).max(300).optional()
        .describe("API deadline in seconds (default: DAYTONA_API_TIMEOUT_MS, capped here at 300s)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ timeout }) => {
    const boxes = await listSandboxes(timeout ? timeout * 1000 : undefined);
    if (!boxes.length) return text("no Daytona sandboxes");
    return text(boxes.map((box) =>
      `${box.state === "started" ? "●" : "○"} ${(box.name ?? "(unnamed)").padEnd(24)} `
      + `${box.state.padEnd(10)} ${box.id}`,
    ).join("\n"));
  });

  server.registerTool("fleet_doctor", {
    title: "Diagnose host reachability",
    description: "Diagnose why one host is unreachable using an SSH handshake plus its configured "
      + "health URL, and return actionable failure hints. " + sel,
    inputSchema: {
      host: z.string().describe("Host, logical route, or dual-boot machine to diagnose."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ host }) => {
    const d = await diagnose(cfg, host);
    const lines = [
      `${d.sshUp ? "●" : "○"} ${d.host} ${d.sshUp ? "reachable" : "unreachable"} · ${d.os} · ssh ${d.ssh} · ${d.ms}ms`,
      d.health && `  ${d.httpUp ? "●" : "○"} health ${d.httpUp ? "ok" : "down"} · ${d.health}`,
      d.services.length ? `  services: ${d.services.join(", ")}` : "",
      d.reason && `  reason: ${d.reason}`,
      ...d.hints.map((hint) => `  → ${hint}`),
    ].filter(Boolean);
    return text(lines.join("\n"), !d.sshUp);
  });

  server.registerTool("fleet_wait", {
    title: "Wait for a bounded host condition",
    description: "Poll until SSH, a TCP port, an HTTP status, or a dual-boot target becomes ready. "
      + `MCP waits are deliberately bounded; timeout is required and capped at ${MCP_WAIT_CAP_S}s. `
      + "For anything longer, call this repeatedly rather than asking for one long hold.",
    inputSchema: {
      target: z.string().describe("Host/machine for SSH, port, and boot waits; an informational label for HTTP waits."),
      port: z.number().int().min(1).max(65535).optional().describe("Wait for this TCP port."),
      http: z.string().url().optional().describe("Wait for this HTTP(S) URL."),
      status: z.number().int().min(100).max(599).optional().describe("Expected HTTP status (default 200; requires http)."),
      boot: z.string().optional().describe("Wait for a dual-boot machine to reach this OS label."),
      timeout: z.number().int().min(1).max(MCP_WAIT_CAP_S)
        .describe(`Required deadline in seconds (max ${MCP_WAIT_CAP_S}).`),
      interval: z.number().int().min(1).max(60).optional().describe("Polling interval in seconds (default 3)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ target, port, http, status, boot, timeout, interval }) => {
    const selected = [port != null, http != null, boot != null].filter(Boolean).length;
    if (selected > 1) return text("choose only one of port, http, or boot (omit all three for SSH)", true);
    if (status != null && !http) return text("status requires http", true);
    const r = await waitFor(cfg, target, {
      port, http, status, boot, ssh: selected === 0,
      timeoutMs: timeout * 1000,
      intervalMs: (interval ?? 3) * 1000,
    });
    return text(
      `${r.ok ? "● ready" : "○ timeout"} ${target} · ${r.lastDetail} · `
      + `${r.attempts} attempt(s) · ${Math.round(r.elapsedMs / 1000)}s`
      + (r.ok ? "" : " · not ready yet — call again to keep waiting"),
      !r.ok,
    );
  });

  server.registerTool("fleet_job_wait", {
    title: "Wait for a detached job",
    description: "Wait until a detached job exits or its output matches a regex. MCP waits are "
      + `deliberately bounded; timeout is required and capped at ${MCP_WAIT_CAP_S}s. A job that `
      + "outlives that is still running — call this again, or poll fleet_jobs / fleet_job_log.",
    inputSchema: {
      ref: z.string().describe("Job reference: \"host:id\"."),
      until: z.string().optional().describe("Resolve early when the job output matches this regex."),
      timeout: z.number().int().min(1).max(MCP_WAIT_CAP_S)
        .describe(`Required deadline in seconds (max ${MCP_WAIT_CAP_S}).`),
      interval: z.number().int().min(1).max(60).optional().describe("Polling interval in seconds (default 3)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ ref, until, timeout, interval }) => {
    const r = await waitJob(cfg, ref, undefined, {
      until,
      timeoutMs: timeout * 1000,
      intervalMs: (interval ?? 3) * 1000,
    });
    const ok = r.outcome === "matched" || (r.outcome === "exited" && r.code === 0);
    const state = r.outcome === "matched" ? "matched"
      : r.outcome === "timeout" ? "timeout" : r.outcome === "dead" ? "dead; inspect logs and artifacts before retrying" : `exit ${r.code}`;
    return text(
      `${ok ? "●" : "○"} ${r.host}:${r.id} · ${state} · ${Math.round(r.elapsedMs / 1000)}s`
      + (r.outcome === "timeout" ? " · observation deadline expired; call again or poll fleet_job_log" : ""),
      !ok,
    );
  });

  server.registerTool("fleet_tools_status", {
    title: "Which boxes have a stale CLI tool",
    description: "Report, per registered CLI tool, which hosts are running the current build "
      + "and which have drifted. Compares local source and skill fingerprints with the last "
      + "sync manifest. This does not verify the active launcher or detect edits after sync. "
      + "Missing, stale, and unreachable targets report an error.",
    inputSchema: {
      tool: z.string().optional().describe("Single registered tool name (default: all of them)."),
      selector: z.string().optional().describe("Host selector (default: each tool's configured hosts)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ tool, selector }) => {
    const known = Object.keys(cfg.tools ?? {});
    if (!known.length) return text("no `tools` block in this fleet config — nothing is tracked", true);
    if (tool && !known.includes(tool)) return text(`unknown tool '${tool}' (have: ${known.join(", ")})`, true);
    const rows = await toolsStatus(cfg, tool ? [tool] : known,
      selector ? await routeSelector(cfg, selector) : undefined);
    const mark = { current: "\u2713", stale: "\u2717", missing: "\u00b7", unreachable: "?" } as const;
    const out = rows.map((r) =>
      `${mark[r.state]} ${r.tool.padEnd(12)} ${r.host.padEnd(14)} ${r.state}`
      + (r.state === "stale" ? ` (has ${r.remote!.version}/${r.remote!.hash}, current is ${r.local.version}/${r.local.hash})` : "")
      + (r.state === "current" ? ` (${r.local.version}/${r.local.hash})` : "")
      + (r.error ? ` \u2014 ${r.error.split("\n")[0]}` : ""),
    ).join("\n");
    return text(out || "no rows", rows.some((r) => r.state !== "current"));
  });

  server.registerTool("fleet_cu_tools", {
    title: "List cua-driver tools",
    description: "Run cua-driver list-tools on a host and optionally filter its self-documented "
      + "tool list by a case-insensitive substring. " + sel,
    inputSchema: {
      host: z.string().describe("Host name or selector (first matched host is used)."),
      filter: z.string().optional().describe("Case-insensitive substring matched against each output line."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ host, filter }) => {
    const r = await cuTools(cfg, await routeSelector(cfg, host), filter);
    return text(renderExec([r.result]), !r.result.ok);
  });

  server.registerTool("fleet_cu_describe", {
    title: "Describe one cua-driver tool",
    description: "Return cua-driver's installed description and input schema for one tool. "
      + "Set brief:true for the name, the first sentences, and the field list instead of the "
      + "full prose. Set forApp to ground the advice in one real window: the stock text tells "
      + "you to prefer element_index, which cannot resolve at all on a window whose "
      + "accessibility tree is empty. " + sel,
    inputSchema: {
      host: z.string().describe("Host name or selector (first matched host is used)."),
      tool: z.string().min(1).describe("Exact cua-driver tool name."),
      brief: z.boolean().optional().describe("Trim to name, summary, and field list."),
      forApp: z.string().optional()
        .describe("PID, process name, app name, or window title to check element support against."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ host, tool, brief, forApp }) => {
    const target = await routeSelector(cfg, host);
    const prefix: string[] = [];
    let elementsAvailable: boolean | undefined;
    if (forApp) {
      try {
        const support = await cuElementSupport(cfg, target, forApp);
        elementsAvailable = support.available;
        prefix.push(support.note, "");
      } catch (error) { prefix.push(error instanceof Error ? error.message : String(error), ""); }
    }
    const r = await cuDescribe(cfg, target, tool);
    if (!r.result.ok) return text([...prefix, renderExec([r.result])].join("\n"), true);
    return text([...prefix,
      brief ? briefDescribe(r.result.stdout, { elementsAvailable }) : r.result.stdout].join("\n"));
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
      grid: z.boolean().optional().describe("Overlay a labeled coordinate grid on the returned image."),
      gridStep: z.number().int().positive().max(1000).optional().describe("Grid spacing in pixels (default 100)."),
    },
    annotations: { openWorldHint: true },
  }, async ({ host, grid, gridStep }) => withTempImage("fleet-shot-", async (local) => {
    try {
      const r = await captureScreenshot(cfg, await routeSelector(cfg, host), local);
      const gridApplied = grid ? await overlayGrid(r.localPath, gridStep ?? 100) : false;
      const data = await consumeImage(r.localPath);
      return { content: [
        { type: "text" as const, text: `screenshot of ${r.host}`
          + (grid ? gridApplied ? " · coordinate grid applied" : " · grid skipped (python3 + Pillow required)" : "") },
        { type: "image" as const, data, mimeType: "image/png" },
      ] };
    } catch (e) {
      return text((e as Error).message, true);
    }
  }));

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
      cwd: z.string().optional().describe("Working directory on the target (fails fast if missing)."),
      timeout: z.number().int().positive().optional()
        .describe("Wall-clock cap in seconds — a hung command returns exit 124 instead of blocking forever."),
    },
    annotations: { openWorldHint: true },
  }, async ({ selector, command, wsl, cwd, timeout }) => {
    const results = await runExec(cfg, await routeSelector(cfg, selector), command,
      { wsl, cwd, timeoutMs: timeout ? timeout * 1000 : undefined });
    return text(renderExec(results), results.some((r) => !r.ok));
  });

  server.registerTool("fleet_edit", {
    title: "Edit a remote file in place",
    description: "Surgical find-and-replace inside a file on host(s), returning a diff of what "
      + "landed. Prefer this over `fleet_exec` with sed/PowerShell -replace, and over "
      + "pull → edit → push: it refuses when `old` is not found, refuses an ambiguous match "
      + "unless `all` is set, and aborts if the file changed between read and write, so it "
      + "cannot silently clobber a concurrent change. Omit `new` to delete the matched text. "
      + "Set `dryRun` to see the diff without writing. " + sel,
    inputSchema: {
      selector: z.string().describe("Host selector."),
      path: z.string().describe("Absolute path of the remote file."),
      old: z.string().min(1).describe("Exact text to find. Must be unique unless `all` is true."),
      new: z.string().optional().describe("Replacement text. Omit to delete the matched text."),
      all: z.boolean().optional().describe("Replace every occurrence instead of failing on multiple."),
      dryRun: z.boolean().optional().describe("Show the diff without writing anything."),
      wsl: z.boolean().optional().describe("Edit inside WSL on a Windows host."),
    },
    annotations: { openWorldHint: true },
  }, async ({ selector, path, old, new: neu, all, dryRun, wsl }) => {
    const results = await editRemoteFile(
      cfg, await routeSelector(cfg, selector), path, old, neu ?? "", { all, dryRun, wsl });
    const out = results.map((r) => {
      if (!r.ok) return `✗ ${r.host} ${r.path} · ${r.error ?? "edit failed"}`;
      const what = `${r.replacements} replacement${r.replacements === 1 ? "" : "s"}`
        + (dryRun ? " (dry run — nothing written)" : "");
      return `✓ ${r.host} ${r.path} · ${what}${r.diff ? "\n" + indent(r.diff) : ""}`;
    }).join("\n\n");
    return text(out, results.some((r) => !r.ok));
  });

  server.registerTool("fleet_script", {
    title: "Run a local script on host(s)",
    description: "Run a script that exists locally (or that you pass inline) on remote host(s) "
      + "without copying it: no scp, no remote temp file, nothing left behind. Prefer this over "
      + "fleet_cp + fleet_exec for anything longer than a one-liner, and over cramming a "
      + "multi-line program into fleet_exec. Give EITHER `path` (a local file) OR `source` "
      + "(the script text). The interpreter follows the extension — .py→python3, .sh→native "
      + "shell, .ps1→PowerShell, .js→node, .ts→bun — or set `interp` explicitly, which is "
      + "required when passing `source` without an `ext`. " + sel,
    inputSchema: {
      selector: z.string().describe("Host selector."),
      path: z.string().optional().describe("Path to a LOCAL script file to run remotely."),
      source: z.string().optional().describe("Script text, as an alternative to `path`."),
      ext: z.string().optional().describe("Extension for `source` (e.g. '.py') to pick the interpreter."),
      interp: z.string().optional().describe("Interpreter command, overriding the extension guess."),
      cwd: z.string().optional().describe("Directory to run in (fails fast if missing)."),
      wsl: z.boolean().optional().describe("Run inside WSL on a Windows host."),
      timeoutSeconds: z.number().int().positive().optional().describe("Kill the script after N seconds."),
    },
    annotations: { openWorldHint: true },
  }, async ({ selector, path, source, ext, interp, cwd, wsl, timeoutSeconds }) => {
    if (!path && source === undefined) return text("give either `path` or `source`", true);
    if (path && source !== undefined) return text("give `path` or `source`, not both", true);
    try {
      const script = path
        ? await readScriptSource(path)
        : { source: source!, ext: ext ?? "", label: "<inline>" };
      if (!script.ext && !interp) {
        return text("inline `source` needs `ext` (e.g. '.py') or `interp` so an interpreter can be chosen", true);
      }
      const results = await runScript(cfg, await routeSelector(cfg, selector), script, {
        wsl, cwd, interp, timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
      });
      return text(renderExec(results), results.some((r) => !r.ok));
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true);
    }
  });

  server.registerTool("fleet_cp", {
    title: "Copy file(s) to host(s)",
    description: "scp one or more local files to one or more hosts (fan-out across a group). Remote "
      + "path is passed verbatim (forward slashes and C:\\… both work on Windows OpenSSH). Pass an "
      + "array of paths to copy several files in one call — `remote` must then be an existing "
      + "directory. " + sel,
    inputSchema: {
      local: z.union([z.string(), z.array(z.string()).min(1)])
        .describe("Path to the local file to push, or an array of paths (remote must be a directory)."),
      selector: z.string().describe("Destination host selector."),
      remote: z.string().describe("Remote destination path."),
      recursive: z.boolean().optional().describe("Recursively copy a directory."),
    },
    annotations: { openWorldHint: true },
  }, async ({ local, selector, remote, recursive }) => {
    const results = await pushFile(cfg, local, await routeSelector(cfg, selector), remote, recursive);
    const from = Array.isArray(local) ? local.join(" ") : local;
    const out = results.map((r) =>
      `${r.ok ? "✓" : "✗"} ${r.host} · ${from} → ${remote}${r.stderr ? "\n" + indent(r.stderr) : ""}`,
    ).join("\n");
    return text(out, results.some((r) => !r.ok));
  });

  server.registerTool("fleet_pull", {
    title: "Copy file(s) from a host",
    description: "Pull one or more remote files or directories to the MCP server's local filesystem. "
      + "Exactly one source host must match. Pass an array of remote paths to pull several in one "
      + "call — `local` must then be an existing directory. Daytona downloads are supported. " + sel,
    inputSchema: {
      selector: z.string().describe("Single source host selector."),
      remote: z.union([z.string(), z.array(z.string()).min(1)])
        .describe("Remote source path, or an array of paths (local must be a directory)."),
      local: z.string().describe("Destination path on the MCP server/controller."),
      recursive: z.boolean().optional().describe("Recursively copy a directory."),
    },
    annotations: { openWorldHint: true },
  }, async ({ selector, remote, local, recursive }) => {
    const r = await pullFile(cfg, await routeSelector(cfg, selector), remote, local, recursive);
    const from = Array.isArray(remote) ? remote.join(" ") : remote;
    return text(
      `${r.ok ? "✓" : "✗"} ${r.host} · ${from} → ${local}${r.stderr ? "\n" + indent(r.stderr) : ""}`,
      !r.ok,
    );
  });

  server.registerTool("fleet_restart", {
    title: "Restart a configured service",
    description: "Restart a service that is defined in the host's config (systemd / Windows "
      + "service / scheduled task — the right restart verb is chosen automatically). Use fleet_ls "
      + "to see each host's known service names.",
    inputSchema: {
      host: z.string().describe("Host name or selector. Restarts every matched host defining this service; skips hosts without it."),
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
      + "seconds. Works on Linux (setsid), macOS (nohup), and Windows (interactive Scheduled Task → sees the "
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
      : `✗ ${r.host}:${r.id} · ${r.error ?? "spawn failed"}; inspect fleet_job_log before retrying`).join("\n");
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

  server.registerTool("fleet_jobs_prune", {
    title: "Prune detached job spools",
    description: "Delete completed job spools. With includeDead:true, also delete dead/stale "
      + "spools. Running jobs are always preserved. " + sel,
    inputSchema: {
      selector: z.string().optional().describe("Host selector (default: all)."),
      includeDead: z.boolean().optional().describe("Also remove dead/stale spools (default false)."),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({ selector, includeDead }) => {
    const rows = await pruneJobs(
      cfg,
      await routeSelector(cfg, selector ?? "all"),
      includeDead ?? false,
    );
    const out = rows.map((r) => r.error
      ? `✗ ${r.host} · prune failed: ${r.error}`
      : `⌫ ${r.host} · pruned ${r.removed} job(s)`).join("\n");
    return text(out, rows.some((r) => !!r.error));
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

  server.registerTool("fleet_bios", {
    title: "Reboot machine(s) into firmware setup",
    description: "Reboot Windows UEFI or systemd Linux hosts directly into BIOS/UEFI firmware "
      + "setup. macOS hosts are reported as unsupported. This drops the connection. " + sel,
    inputSchema: {
      selector: z.string().describe("Host selector to reboot into firmware setup."),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({ selector }) => {
    const actions = await firmwareRebootHosts(cfg, await routeSelector(cfg, selector));
    const out = actions.map((a) =>
      `${a.result.ok ? "↻" : "✗"} ${a.host} · ${a.os}${a.result.ok ? " · entering firmware" : " · " + a.result.stderr}`,
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
      timeout: z.number().int().min(1).max(3600).optional()
        .describe("Arrival deadline in seconds (default 180, max 3600)."),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({ machine, to, wait, timeout }) => {
    const r = await switchMachine(cfg, machine, to, {
      wait: wait ?? true,
      timeoutMs: (timeout ?? 180) * 1000,
    });
    if (wait === false) return text(`↻ ${machine}: switch to ${to} issued (from ${r.from ?? "?"}); not waiting`);
    return text(r.arrived
      ? `● ${machine} now in ${to} (${Math.round(r.waitedMs / 1000)}s)`
      : `✗ ${machine} did not reach ${to} in time`, !r.arrived);
  });

  server.registerTool("fleet_browse", {
    title: "Attach to a host's configured browser",
    description: "Verify the host's configured Chrome DevTools Protocol endpoint, optionally open "
      + "one URL in a new tab, and return the endpoint plus current target list. This only resolves "
      + "and attaches to CDP. Use cua-driver browser_* tools for page interaction. " + sel,
    inputSchema: {
      host: z.string().describe("Host with a cdp field in fleet.config.json."),
      url: z.string().optional().describe("URL to open through PUT /json/new before listing targets."),
    },
    annotations: { openWorldHint: true },
  }, async ({ host, url }) => {
    try {
      const r = await browseHost(cfg, await routeSelector(cfg, host), url);
      return text(JSON.stringify({ endpoint: r.endpoint, targets: r.targets }, null, 2));
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), true);
    }
  });

  server.registerTool("fleet_cu_record", {
    title: "Control cua-driver trajectory recording",
    description: "Start, stop, or inspect cua-driver trajectory recording. Start uses out as the "
      + "remote recording directory. Stop uses out as a local controller directory "
      + "and pulls the finalized artifacts through Fleet's file-pull path. " + sel,
    inputSchema: {
      host: z.string().describe("Host name or selector (first matched host is used)."),
      action: z.enum(["start", "stop", "status"]),
      out: z.string().optional().describe("Remote directory for start; local controller directory for stop."),
    },
    annotations: { openWorldHint: true },
  }, async ({ host, action, out }) => {
    try {
      const target = await routeSelector(cfg, host);
      if (action === "start") {
        const r = await cuRecordStart(cfg, target, out);
        return text(renderExec([r.result]), !r.result.ok);
      }
      if (action === "status") {
        if (out) return text("out is only valid with start or stop", true);
        const r = await cuRecordStatus(cfg, target);
        return text(renderExec([r.result]), !r.result.ok);
      }
      const r = await cuRecordStop(cfg, target, out);
      const paths = r.localPaths.length ? `\n${r.localPaths.join("\n")}` : "";
      return text(`${renderExec([r.result])}${paths}`, !r.result.ok);
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), true);
    }
  });

  server.registerTool("fleet_cu", {
    title: "Computer-use on a host (cua-driver)",
    description: "Drive a host's desktop via the cua-driver computer-use tool. Pass cua-driver "
      + "CLI args as an array, e.g. [\"list-tools\"], [\"get_screen_size\"], [\"list_windows\"], "
      + "[\"click\",\"{\\\"pid\\\":1234,\\\"window_id\\\":5,\\\"x\\\":100,\\\"y\\\":200}\"], or "
      + "[\"install\"] to install it. Set image:true for screen/window-capture calls to get the "
      + "PNG back. Needs a logged-in interactive desktop on the target. " + sel,
    inputSchema: {
      host: z.string().describe("Host name (or selector — first matched host is used, except "
        + "for args:[\"install\"], which installs on every host the selector resolves to)."),
      args: z.array(z.string()).describe("cua-driver CLI args, verbatim (tool name + JSON arg)."),
      image: z.boolean().optional().describe("True if the call captures a screenshot/window image."),
      grid: z.boolean().optional().describe("Overlay a labeled coordinate grid on the returned image."),
      gridStep: z.number().int().positive().max(1000).optional().describe("Grid spacing in pixels (default 100)."),
    },
    annotations: { openWorldHint: true },
  }, async ({ host, args, image, grid, gridStep }) => {
    if (args[0] === "install") {
      const actions = await cuInstall(cfg, await routeSelector(cfg, host));
      return text(renderExec(actions.map((a) => a.result)), actions.some((a) => !a.result.ok));
    }
    const capture = async (local?: string) => {
      const r = await cuRun(cfg, await routeSelector(cfg, host), args, local);
      // get_window_state returns its whole envelope even when the UIA walk found
      // nothing — hundreds of KB whose only information is "degraded".
      const shaped = compactCuOutput(args, r.result).result;
      const content: any[] = [{ type: "text" as const, text: renderExec([shaped]) }];
      if (r.localImage) {
        const gridApplied = grid ? await overlayGrid(r.localImage, gridStep ?? 100) : false;
        if (grid) content[0].text += gridApplied
          ? "\ncoordinate grid applied"
          : "\ngrid skipped (python3 + Pillow required)";
        const data = await consumeImage(r.localImage);
        content.push({ type: "image" as const, data, mimeType: "image/png" });
      }
      return { content, isError: !r.result.ok };
    };
    return image ? withTempImage("fleet-cua-", capture) : capture();
  });

  server.registerTool("fleet_cu_apps", {
    title: "List desktop applications",
    description: "List applications visible to cua-driver on the target's active desktop, "
      + "optionally filtered by name. " + sel,
    inputSchema: {
      host: z.string().describe("Host name or selector (first matched host is used)."),
      filter: z.string().optional().describe("Case-insensitive app-name substring."),
    },
    annotations: { openWorldHint: true },
  }, async ({ host, filter }) => {
    const { apps, result } = await cuApps(cfg, await routeSelector(cfg, host), filter);
    if (!result.ok) return text(renderExec([result]), true);
    return text([
      ...apps.map((app) => `${String(app.pid).padStart(7)}  ${app.name}${app.active ? " · active" : ""}`),
      `${apps.length} app(s)`,
    ].join("\n"));
  });

  server.registerTool("fleet_cu_windows", {
    title: "List desktop windows",
    description: "List top-level windows. With app, resolve it by PID, process name, app name, "
      + "or window title and show only that process's windows — marking the one Fleet targets "
      + "and any window sitting ABOVE it. A window above the target is usually a modal dialog, "
      + "and it silently swallows every click and keystroke aimed at the window underneath. "
      + "Omit app to list every top-level window on the desktop. " + sel,
    inputSchema: {
      host: z.string().describe("Host name or selector (first matched host is used)."),
      app: z.string().optional()
        .describe("PID, process name (Playnite.DesktopApp[.exe]), app name, or window title."),
    },
    annotations: { openWorldHint: true },
  }, async ({ host, app }) => {
    const target = await routeSelector(cfg, host);
    const snapshot = await cuSnapshot(cfg, target);
    if (!snapshot.result.ok) return text(renderExec([snapshot.result]), true);
    if (!app) {
      const rows = [...snapshot.windows].sort((a, b) => b.z_index - a.z_index).map((w) =>
        `${String(w.window_id).padStart(9)} ${String(w.pid).padStart(7)}  ${(w.app_name ?? "?").padEnd(24)} `
        + `${w.title || "(untitled)"}  ${w.width}x${w.height}@${w.x},${w.y}`);
      return text([...rows, `${snapshot.windows.length} top-level window(s)`].join("\n"));
    }
    try {
      const t = cuResolveTargetFrom(snapshot, app);
      const mark = (id: number) => id === t.window.window_id ? "-> target"
        : t.blockers.some((b) => b.window_id === id) ? "!! above target" : "   sibling";
      const rows = snapshot.windows.filter((w) => w.pid === t.pid)
        .sort((a, b) => b.z_index - a.z_index)
        .map((w) => `${mark(w.window_id)} ${String(w.window_id).padStart(9)}  `
          + `${w.title || "(untitled)"}  ${w.width}x${w.height}@${w.x},${w.y} z${w.z_index}`);
      const note = cuBlockerNote(t);
      return text([
        ...rows,
        `${t.name} · pid ${t.pid} · matched on ${t.matched} · click space ${t.capture.width}x${t.capture.height}`,
        ...(note ? [note] : []),
      ].join("\n"));
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), true);
    }
  });

  server.registerTool("fleet_cu_screenshot_window", {
    title: "Screenshot an application window",
    description: "Resolve an application by PID, process name, app name, or window title, capture "
      + "the window, and return the image. Owned popups and modal dialogs the process has open "
      + "ARE COMPOSITED onto the capture and named in the reply — a capture of the window alone "
      + "looks completely normal while a modal underneath it eats every click. With grid, the "
      + "image carries a caption stating the exact coordinate frame (pid, window_id, origin) that "
      + "its numbers are in. Use probe to draw a crosshair where a click at those coordinates "
      + "would actually land, without clicking. " + sel,
    inputSchema: {
      host: z.string().describe("Host name or selector (first matched host is used)."),
      app: z.string().describe("PID, process name (Playnite.DesktopApp[.exe]), app name, or window title."),
      grid: z.boolean().optional().describe("Overlay a labeled coordinate grid on the returned image."),
      gridStep: z.number().int().positive().max(1000).optional().describe("Grid spacing in pixels (default 100)."),
      probe: z.object({ x: z.number(), y: z.number() }).optional()
        .describe("Draw a crosshair where a click at this point would land. Verifies aim without clicking."),
      space: z.enum(["window", "screen"]).optional()
        .describe("Coordinate frame of probe. window (default) = pixels in this capture; screen = desktop pixels."),
      composite: z.boolean().optional().describe("Set false to capture the target window alone (default true)."),
    },
    annotations: { openWorldHint: true },
  }, async ({ host, app, grid, gridStep, probe, space, composite }) =>
    withTempImage("fleet-cua-window-", async (local) => {
      const target = await routeSelector(cfg, host);
      const r = await cuShotWindow(cfg, target, app, local, {}, { composite: composite !== false });
      if (!r.result.ok || !r.localImage) return text(renderExec([r.result]), true);
      let mark: { x: number; y: number } | undefined;
      if (probe) {
        try { mark = cuResolvePoint(r.target, probe.x, probe.y, space ?? "window"); }
        catch (error) { return text(error instanceof Error ? error.message : String(error), true); }
      }
      const gridApplied = grid ? await overlayGrid(r.localImage, {
        step: gridStep ?? 100,
        caption: cuGridCaption(r.target),
        banner: r.warning,
        probe: mark ? { ...mark, label: `probe -> ${mark.x},${mark.y}` } : undefined,
      }) : false;
      const lines = [
        `${r.target.name} · pid ${r.target.pid} · window_id ${r.target.window.window_id}`
        + ` · click space ${r.target.capture.width}x${r.target.capture.height} (window-local pixels)`,
        ...(r.composited.length
          ? [`composited ${r.composited.length} owned window(s): `
             + r.composited.map((w) => w.title || `w${w.window_id}`).join(", ")] : []),
        ...(r.warning ? [r.warning] : []),
        ...(mark ? [`probe ${probe!.x},${probe!.y} (${space ?? "window"}) -> window-local ${mark.x},${mark.y}`] : []),
        ...(grid ? [gridApplied ? "coordinate grid applied" : "grid skipped (python3 + Pillow required)"] : []),
      ];
      const data = await consumeImage(r.localImage);
      return { content: [
        { type: "text" as const, text: lines.join("\n") },
        { type: "image" as const, data, mimeType: "image/png" },
      ] };
    }));

  server.registerTool("fleet_cu_act", {
    title: "Act on a window and verify the effect",
    description: "Send one input action to an exact (pid, window_id) and report WHAT THE WINDOW'S "
      + "PIXELS DID: changed, no_change, or indeterminate. cua-driver's own `effect` field returns "
      + "\"unverifiable\" for successful and no-op input alike, so this hashes the window bitmap "
      + "before and after instead, and takes a third capture to separate a real change from a "
      + "window that repaints on its own. window_id is always sent explicitly — omitted, cua-driver "
      + "targets the process's FRONTMOST window, which is the modal dialog when one is open, and "
      + "window-local coordinates then land somewhere unrelated. Pixel coordinates are validated "
      + "against the window and refused when they fall outside it. " + sel,
    inputSchema: {
      host: z.string().describe("Host name or selector (first matched host is used)."),
      app: z.string().describe("PID, process name, app name, or window title."),
      tool: z.string().describe("cua-driver input tool: click, press_key, type_text, scroll, hotkey, …"),
      args: z.record(z.string(), z.any()).optional()
        .describe("Tool arguments WITHOUT pid/window_id/target or from_zoom. Fleet supplies the target and checks x/y and drag endpoints."),
      x: z.number().optional().describe("Pixel X, validated and translated into window-local space."),
      y: z.number().optional().describe("Pixel Y, validated and translated into window-local space."),
      space: z.enum(["window", "screen"]).optional()
        .describe("Frame for all coordinates, including args.from_x/from_y/to_x/to_y. window (default) = shot-window pixels; screen = desktop."),
      settleMs: z.number().int().min(0).max(10000).optional()
        .describe("Wait before the after-capture (default 400)."),
      screenshot: z.boolean().optional().describe("Return the after image."),
      grid: z.boolean().optional().describe("Overlay the coordinate grid on the after image."),
    },
    annotations: { openWorldHint: true },
  }, async ({ host, app, tool, args, x, y, space, settleMs, screenshot, grid }) => {
    const target = await routeSelector(cfg, host);
    const run = async (local?: string) => {
      if ((x === undefined) !== (y === undefined))
        return text("x and y must be given together", true);
      const r = await cuAct(cfg, target, app, tool, { ...(args ?? {}) }, {
        settleMs, imageOut: local, space,
        point: x !== undefined && y !== undefined ? { x, y, space: space ?? "window" } : undefined,
      });
      const note = cuBlockerNote(r.target);
      const lines = [
        `effect: ${r.effect}${r.reason ? ` — ${r.reason}` : ""}`,
        `${r.target.name} · pid ${r.target.pid} · window_id ${r.target.window.window_id} · ${tool}`,
        ...(note ? [note] : []),
        ...(r.driverOutput ? ["", r.driverOutput] : []),
        ...(r.result.stderr ? ["", r.result.stderr] : []),
      ];
      const content: any[] = [{ type: "text" as const, text: lines.join("\n") }];
      if (r.localImage) {
        if (grid) await overlayGrid(r.localImage, { caption: cuGridCaption(r.target), banner: note });
        content.push({ type: "image" as const, data: await consumeImage(r.localImage), mimeType: "image/png" });
      }
      return { content, isError: !r.result.ok };
    };
    try {
      return screenshot || grid ? await withTempImage("fleet-cua-act-", run) : await run();
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), true);
    }
  });

  server.registerTool("fleet_cu_batch", {
    title: "Run ordered window input and capture the result",
    description: "Run 1–100 ordered input actions on one exact window in a single remote execution after target discovery. "
      + "All coordinates are checked before input. Stops at the first driver failure without retrying. "
      + "Returns each step's completed/failed/not_run/unconfirmed status and the whole sequence's pixel effect. "
      + "Take a fresh observation between batches that open dialogs, move windows, or change layout. "
      + "A completed step confirms driver exit, not its application effect. Screenshot is returned by default. " + sel,
    inputSchema: {
      host: z.string().describe("One host or route."),
      app: z.string().min(1).describe("PID, process name, app name, or exact window title shared by every action."),
      actions: z.array(z.object({
        tool: z.enum(CU_BATCH_TOOLS),
        args: z.record(z.string(), z.any()).optional().describe("Raw tool arguments without pid/window_id/target or from_zoom."),
        space: z.enum(["window", "screen"]).optional().describe("Override the batch coordinate space for this action."),
        delayMs: z.number().int().min(0).max(10000).optional().describe("Delay after successful input; at most 60000 ms total."),
      }).strict()).min(1).max(100),
      space: z.enum(["window", "screen"]).optional(),
      settleMs: z.number().int().min(0).max(10000).optional(),
      screenshot: z.boolean().optional().describe("Return the final image (default true)."),
      grid: z.boolean().optional().describe("Overlay the final image coordinate grid."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ host, app, actions, space, settleMs, screenshot, grid }) => {
    const run = async (local?: string) => {
      const r = await cuBatch(cfg, await routeSelector(cfg, host), app, actions, { space, settleMs, imageOut: local });
      const note = cuBlockerNote(r.target);
      const { localImage, ...summary } = r;
      const content: any[] = [{ type: "text", text: JSON.stringify({ ...summary, ...(note ? { warning: note } : {}) }) }];
      if (localImage) {
        if (grid) await overlayGrid(localImage, { caption: cuGridCaption(r.target), banner: note });
        content.push({ type: "image", data: await consumeImage(localImage), mimeType: "image/png" });
      }
      return { content, isError: !r.result.ok };
    };
    try { return screenshot !== false || grid ? await withTempImage("fleet-cua-batch-", run) : await run(); }
    catch (error) { return text(error instanceof Error ? error.message : String(error), true); }
  });

  server.registerTool("fleet_deploy", {
    title: "Deploy Fleet to host(s)",
    description: "Build a Fleet source tarball, copy it to matching hosts, install dependencies, "
      + "and optionally restart a configured service. " + sel,
    inputSchema: {
      selector: z.string().describe("Destination host selector."),
      restart: z.union([z.boolean(), z.string()]).optional()
        .describe("true: configured/default Fleet service; false: no restart; string: named configured service."),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({ selector, restart }) => {
    const rows = await deployHosts(cfg, await routeSelector(cfg, selector), {
      restart: restart ?? true,
    });
    const out = rows.map((r) => {
      const head = `${r.ok ? "✓" : "✗"} ${r.host} · ${r.dir}`;
      const body = renderExec([r.result]);
      const restarted = (r.restarted ?? []).map((a) =>
        `${a.result.ok ? "↻" : "✗"} ${a.host} · restarted ${a.service} (${a.type})`).join("\n");
      return [head, body, restarted].filter(Boolean).join("\n");
    }).join("\n\n");
    return text(out, rows.some((r) => !r.ok));
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
