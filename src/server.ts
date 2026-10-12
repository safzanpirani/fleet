/**
 * server — builds the fleet MCP server (tool registration), shared by both
 * frontends: `mcp.ts` (stdio) and `http.ts` (remote). One place defines the
 * tools; the transports differ. All tools delegate to the `core.ts` actions.
 *
 * The MCP is deliberately small: eight tools for clients without a shell. Agents
 * with a shell use the `fleet` CLI, which covers everything else. The read tools
 * are always registered; `fleet_screenshot` and `fleet_exec` are registered only
 * when `readOnly` is false — the kill-switch (`FLEET_MCP_READONLY=1`) makes them
 * vanish from `tools/list`.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveHosts, type FleetConfig } from "./config.ts";
import type { ExecResult } from "./ssh.ts";
import { lsHosts, runExec, rebootRefusal, nestedShellNote, serviceLogs, serviceTarget, hostStatus, captureScreenshot, overlayGrid, routeSelector } from "./core.ts";
import { listJobs, jobLog, jobTail } from "./jobs.ts";
import { processList } from "./procs.ts";
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

export interface BuildOpts { readOnly?: boolean }

export function buildServer(cfg: FleetConfig, opts: BuildOpts = {}): McpServer {
  // The tool list is fixed per process but names hosts and groups, so
  // only the requesting client may cache it.
  const server = new McpServer(
    { name: "fleet", version: "0.5.0" },
    { cacheHints: { "tools/list": { ttlMs: 3_600_000, cacheScope: "private" } } },
  );
  const sel = selectorHelp(cfg);

  // ── read-only tools (always registered) ─────────────────────────────────────
  server.registerTool("fleet_ls", {
    title: "List fleet hosts",
    description: "Probe reachability of every configured host and list each host's OS, "
      + "ssh alias, GPU flag, and configured service names.",
    inputSchema: z.object({}),
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
      + "Get-Service / schtasks query on Windows). Supply service for a configured alias, or unit and type for a literal native service.",
    inputSchema: z.object({
          host: z.string().describe("Host name or selector. Reads every matched host defining this service; skips hosts without it."),
          service: z.string().optional().describe("Configured service alias; mutually exclusive with unit/type."),
          unit: z.string().optional().describe("Literal native service name; requires type."),
          type: z.enum(["systemd", "systemd-user", "winservice", "nssm", "schtask"]).optional().describe("Native service backend; requires unit."),
          lines: z.number().int().positive().optional().describe("How many log lines (default 30)."),
        }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ host, service, unit, type, lines }) => {
    const target = serviceTarget(service, unit, type);
    const actions = await serviceLogs(cfg, await routeSelector(cfg, host), target, lines ?? 30);
    return text(renderExec(actions.map((a) => a.result)), actions.some((a) => !a.result.ok));
  });

  server.registerTool("fleet_jobs", {
    title: "List detached jobs",
    description: "List the detached background jobs (fleet spawn) across the fleet — each shows "
      + "host:id, status (starting/running/exited/dead), exit code, pid, and the command. " + sel,
    inputSchema: z.object({
          selector: z.string().optional().describe("Optional host selector to scope the list (default: all)."),
        }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ selector }) => {
    const errors: string[] = [];
    const rows = await listJobs(cfg, await routeSelector(cfg, selector ?? "all"),
      (h, e) => errors.push(`✗ ${h}: list failed — ${e}`));
    if (!rows.length && !errors.length) return text("no jobs");
    const out = rows.map((r) =>
      `${r.status === "running" ? "●" : r.status === "exited" || r.status === "starting" ? "○" : "✗"} `
      + `${(r.host + ":" + r.id).padEnd(24)} ${r.status.padEnd(8)} `
      + `${(r.status === "exited" ? "exit " + r.code : "pid " + (r.pid ?? "—")).padEnd(10)} ${r.cmd}`,
    ).join("\n");
    return text([out, ...errors].filter(Boolean).join("\n"), errors.length > 0);
  });

  server.registerTool("fleet_job_log", {
    title: "Read a detached job's output",
    description: "Fetch the captured output of one detached job, addressed as host:id (from "
      + "fleet_jobs). Pass tail to get only the last N lines instead of the full log.",
    inputSchema: z.object({
          ref: z.string().describe("Job reference: \"host:id\" (e.g. \"web:mr0gnez7-iqd8\")."),
          tail: z.number().int().positive().optional().describe("Return only the last N lines (default: full log)."),
          include: z.string().optional().describe("Case-sensitive target regex; include matches before tailing (default 40 lines with filters)."),
          exclude: z.string().optional().describe("Case-sensitive target regex; exclude matches after inclusion."),
        }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ ref, tail, include, exclude }) => {
    const result = tail || include !== undefined || exclude !== undefined
      ? await jobTail(cfg, ref, undefined, tail ?? 40, { include, exclude }) : await jobLog(cfg, ref);
    return text((result.output || "(no output yet)") + ("truncated" in result && result.truncated ? "\n[fleet: output truncated at 65536 bytes]" : ""));
  });

  server.registerTool("fleet_ps", {
    title: "List processes",
    description: "Processes on host(s), the same columns on Linux, macOS and Windows: pid, parent, cpu "
      + "(% of one core), memory, age, owner, command line, the fleet job that started it, and whether "
      + "`fleet kill` would refuse it. filter matches a process name (or a pid); the command line is never "
      + "searched. Without a filter the top 20 by cpu come back.",
    inputSchema: z.object({
          selector: z.string().describe(selectorHelp(cfg)),
          filter: z.string().optional().describe("Process name substring, or a pid."),
          sort: z.enum(["cpu", "mem"]).optional(),
          limit: z.number().int().positive().optional().describe("Rows per host (default 20 without a filter, all with one)."),
        }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ selector, filter, sort, limit }) => {
    const lists = await processList(cfg, await routeSelector(cfg, selector), { filter, sort, limit: limit ?? (filter ? undefined : 20) });
    return text(JSON.stringify(lists, null, 2), lists.some((r) => !r.ok));
  });

  server.registerTool("fleet_status", {
    title: "Live host stats",
    description: "Live CPU / memory / disk / GPU stats pulled from the dashboard, plus uptime "
      + "checks. Omit `host` for the whole fleet, or pass one host name to scope it.",
    inputSchema: z.object({
          host: z.string().optional().describe("Optional single host name to scope the report."),
        }),
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
    inputSchema: z.object({
          host: z.string().describe("Host name (or selector — first matched host is used)."),
          grid: z.boolean().optional().describe("Overlay a labeled coordinate grid on the returned image."),
          gridStep: z.number().int().positive().max(1000).optional().describe("Grid spacing in pixels (default 100)."),
          output: z.string().optional().describe("One monitor: a connector name (DP-3), main, focused (Linux), or a 1-based index. Windows: main, an index, or DISPLAYn."),
          region: z.string().optional().describe("Part of that monitor (main when output is omitted): top-left, top-right, bottom-left, bottom-right, top, bottom, left, right, center, or X,Y,W,H fractions."),
          wake: z.boolean().optional().describe("Linux Wayland: switch powered-off monitors on for the capture and back off. Without it, a capture of an off monitor is refused."),
        }),
    annotations: { openWorldHint: true },
  }, async ({ host, grid, gridStep, output, region, wake }) => withTempImage("fleet-shot-", async (local) => {
    try {
      const r = await captureScreenshot(cfg, await routeSelector(cfg, host), local, {}, { output, region, wake });
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
    inputSchema: z.object({
          selector: z.string().describe("Host selector, e.g. \"winbox\", \"@linux\", \"all\", \"vps,@gpu\"."),
          command: z.string().optional().describe("Shell command, verbatim. Supply exactly one of command or argv."),
          argv: z.array(z.string()).min(1).optional().describe("Literal program and arguments. Supply exactly one of command or argv."),
          wsl: z.boolean().optional().describe("Run the command inside WSL bash on a Windows host."),
          cwd: z.string().optional().describe("Working directory on the target (fails fast if missing)."),
          timeout: z.number().int().positive().optional()
            .describe("Wall-clock cap in seconds — a hung command returns exit 124 instead of blocking forever."),
          sudo: z.boolean().optional().describe("Run as root (POSIX only). Passwordless sudo is used when it works; otherwise the password comes from the host's sudo.passwordFile/passwordEnv, sent over ssh stdin."),
          confirmReboot: z.boolean().optional().describe("Required when the command looks like a reboot or power-off. Prefer the CLI's `fleet switch` or `fleet reboot`."),
          fresh: z.boolean().optional().describe("Open a new ssh login instead of reusing a shared connection (and skip the kept-open Windows session), e.g. after a group change such as usermod -aG docker."),
        }),
    annotations: { openWorldHint: true },
  }, async ({ selector, command, argv, wsl, cwd, timeout, sudo, confirmReboot, fresh }) => {
    if ((command === undefined) === (argv === undefined)) return text("supply exactly one of command or argv", true);
    const program = command ?? argv!.join(" ");
    const refusal = confirmReboot ? null : rebootRefusal(program, "confirmReboot: true");
    if (refusal) return text(refusal, true);
    const target = await routeSelector(cfg, selector);
    const nested = nestedShellNote(program, resolveHosts(cfg, target), wsl);
    const results = await runExec(cfg, target, argv ?? command!,
      { wsl, cwd, sudo, fresh, timeoutMs: timeout ? timeout * 1000 : undefined });
    return text((nested ? nested + "\n" : "") + renderExec(results), results.some((r) => !r.ok));
  });

  return server;
}
