/**
 * core — the structured action layer shared by the CLI (`cli.ts`) and the MCP
 * server (`mcp.ts`). Everything here RETURNS data and THROWS on failure (never
 * `process.exit` / `console.log`), so it is safe to call from a long-lived
 * stdio MCP process. Presentation (ANSI tables, plain text) lives in the
 * frontends; the quoting-proof shell construction lives once, here + `ssh.ts`.
 */
import { resolveHosts, REPO_ROOT } from "./config.ts";
import type { FleetConfig, Host, Service, ServiceType, Machine } from "./config.ts";
import { exec, probe, scp, scpPull, sshDiagnose, bashEsc, psEsc } from "./ssh.ts";
import type { ExecResult, Shell } from "./ssh.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── tiny arg helpers (shared by cli flag parsing + recipe step parsing) ──────
export function pullFlag(rest: string[], flag: string): boolean {
  const i = rest.indexOf(flag);
  if (i < 0) return false;
  rest.splice(i, 1);
  return true;
}
export function pullVal(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  rest.splice(i, 2);
  return v;
}
/** Parse fleet's own flags from the LEADING run of tokens, stopping at the first
 *  non-flag token (the selector). Everything from the selector onward is returned
 *  verbatim as `rest` — so flags that appear *inside* a remote command are never
 *  consumed. Boolean flags set `true`; value flags consume the next token.
 *  Usage: `fleet exec [--flags] <selector> <command…>`. */
export function parseLeadingFlags(
  argv: string[], boolFlags: readonly string[], valFlags: readonly string[],
): { flags: Record<string, string | true>; rest: string[] } {
  const flags: Record<string, string | true> = {};
  let i = 0;
  for (; i < argv.length; i++) {
    const t = argv[i]!;
    if (boolFlags.includes(t)) { flags[t] = true; continue; }
    if (valFlags.includes(t)) { flags[t] = argv[i + 1] ?? ""; i++; continue; }
    break; // first non-flag token = the selector
  }
  return { flags, rest: argv.slice(i) };
}
/** Split a string into tokens, honouring "double quotes" (quotes are dropped). */
export function splitArgs(s: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (const ch of s) {
    if (ch === '"') { q = !q; continue; }
    if (ch === " " && !q) { if (cur) { out.push(cur); cur = ""; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// ── service command builders (the only place that knows systemd/nssm/schtask) ─
// Service names come from config (trusted), but they're still quoted/escaped so
// a name with a quote or $ breaks loudly in review, not silently on the host.
export function restartCmd(svc: Service): { cmd: string; shell: Shell } {
  switch (svc.type) {
    case "systemd": return { cmd: `sudo systemctl restart '${bashEsc(svc.name)}'`, shell: "bash" };
    case "nssm": case "winservice":
      return { cmd: `Restart-Service -Name '${psEsc(svc.name)}'`, shell: "powershell" };
    case "schtask": return {
      cmd: `schtasks /End /TN '${psEsc(svc.name)}'; Start-Sleep 1; schtasks /Run /TN '${psEsc(svc.name)}'`,
      shell: "powershell" };
  }
}
/** Clamp a line count before interpolating it into a remote command. */
const lineCount = (n: number, fallback = 30) =>
  Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
export function logsCmd(svc: Service, n: number): { cmd: string; shell: Shell } {
  switch (svc.type) {
    case "systemd": return { cmd: `journalctl -u '${bashEsc(svc.name)}' -n ${lineCount(n)} --no-pager`, shell: "bash" };
    case "schtask": return { cmd: `schtasks /Query /TN '${psEsc(svc.name)}' /V /FO LIST`, shell: "powershell" };
    default: return { cmd: `Get-Service -Name '${psEsc(svc.name)}' | Format-List Name,Status,StartType`, shell: "powershell" };
  }
}
/** A command that prints a single status token to stdout, for at-a-glance health. */
export function statusCmd(svc: Service): { cmd: string; shell: Shell } {
  switch (svc.type) {
    case "systemd": return { cmd: `systemctl is-active '${bashEsc(svc.name)}' 2>/dev/null || true`, shell: "bash" };
    case "schtask": return {
      cmd: `$x=schtasks /query /tn '${psEsc(svc.name)}' /fo list 2>$null | Select-String '^Status:'; if($x){($x -split ':',2)[1].Trim()}else{'missing'}`,
      shell: "powershell" };
    default: return {
      cmd: `$s=Get-Service -Name '${psEsc(svc.name)}' -EA SilentlyContinue; if($s){[string]$s.Status}else{'missing'}`,
      shell: "powershell" };
  }
}
/** Interpret a statusCmd's output into up/down + a human detail token. */
function interpretStatus(type: ServiceType, out: string): { up: boolean; detail: string } {
  const detail = out.trim().split("\n").pop()?.trim() || "unknown";
  if (type === "systemd") return { up: detail === "active", detail };
  if (type === "schtask") return { up: /^(running|ready)$/i.test(detail), detail };
  return { up: /running/i.test(detail), detail };   // winservice / nssm
}
export interface SvcStatus { host: string; service: string; type: ServiceType; up: boolean; detail: string; }
/** Status of one named service across every host that defines it (default: all). */
export async function svcStatus(cfg: FleetConfig, sel: string, name: string): Promise<SvcStatus[]> {
  return Promise.all(serviceHosts(cfg, sel, name).map(async ({ host, svc }) => {
    const { cmd, shell } = statusCmd(svc);
    const r = await exec(host, cmd, shell);
    const { up, detail } = interpretStatus(svc.type, r.ok ? r.stdout : (r.stderr || "error"));
    return { host: host.name, service: name, type: svc.type, up, detail };
  }));
}

// ── ls ───────────────────────────────────────────────────────────────────────
export interface HostReport {
  name: string; os: string; ssh: string; gpu: boolean; up: boolean; services: string[];
  httpUp?: boolean;   // when ssh is down but a configured health URL answers: alive, just unreachable
}
/** Probe an HTTP endpoint as a coarse liveness check. Any response (even 401/404)
 *  means something is listening → the box is alive; only a transport failure or a
 *  5xx counts as down. */
export async function probeHttp(url: string, timeoutMs = 4000): Promise<boolean> {
  try { return (await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" })).status < 500; }
  catch { return false; }
}
/** Probe reachability of every host, concurrently. `onResult` fires as each host
 *  resolves (fastest first) so a frontend can stream rows instead of blocking on
 *  the slowest/dead host. The returned array preserves config order. When ssh is
 *  down but the host has a `health` URL that answers, `httpUp` is set — so a dead
 *  ssh *route* to a live box reads differently from a box that's actually off. */
export async function lsHosts(
  cfg: FleetConfig, onResult?: (r: HostReport) => void,
): Promise<HostReport[]> {
  return Promise.all(Object.values(cfg.hosts).map(async (h) => {
    const up = await probe(h);
    const httpUp = !up && h.health ? await probeHttp(h.health) : undefined;
    const rep: HostReport = {
      name: h.name, os: h.os, ssh: h.ssh, gpu: !!h.gpu, up, httpUp,
      services: Object.keys(h.services ?? {}),
    };
    onResult?.(rep);
    return rep;
  }));
}

// ── exec ──────────────────────────────────────────────────────────────────────
export async function runExec(
  cfg: FleetConfig, sel: string, cmd: string,
  opts: { wsl?: boolean; cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult[]> {
  const hosts = resolveHosts(cfg, sel);
  const shell: Shell = opts.wsl ? "wsl" : "auto";
  return Promise.all(hosts.map((h) => exec(h, cmd, shell, { cwd: opts.cwd, timeoutMs: opts.timeoutMs })));
}

// ── cp ────────────────────────────────────────────────────────────────────────
export async function pushFile(
  cfg: FleetConfig, local: string, sel: string, remote: string, recursive = false,
): Promise<ExecResult[]> {
  const hosts = resolveHosts(cfg, sel);
  return Promise.all(hosts.map((h) => scp(h, local, remote, recursive)));
}

/** Pull host:remote → local. Single-host only (one local destination). */
export async function pullFile(
  cfg: FleetConfig, sel: string, remote: string, local: string, recursive = false,
): Promise<ExecResult> {
  const hosts = resolveHosts(cfg, sel);
  if (hosts.length !== 1) throw new Error(`pull needs exactly one source host (got ${hosts.length} from '${sel}')`);
  return scpPull(hosts[0]!, remote, local, recursive);
}

/** Split a `sel:path` token into its selector and remote path, but only if the
 *  prefix is a real selector (so a unix local path or `C:\…` isn't mistaken for
 *  one). Returns null when the token is a plain local path. */
export function parseRemoteSpec(cfg: FleetConfig, token: string): { sel: string; path: string } | null {
  const i = token.indexOf(":");
  if (i <= 0) return null;
  const sel = token.slice(0, i);
  const known = sel === "all" || sel === "*" || sel.startsWith("@") || sel.includes(",")
    || !!cfg.hosts[sel] || !!cfg.machines?.[sel];
  return known ? { sel, path: token.slice(i + 1) } : null;
}

// ── deploy (ship the fleet source to a host + reinstall deps + restart) ───────
export interface DeployResult {
  host: string; ok: boolean; dir: string; result: ExecResult; restarted?: ServiceAction[];
}
/** The remote install dir (literal shell expression, expanded on the host). */
function deployDir(h: Host): string {
  return h.deploy?.dir ?? (h.os === "windows" ? "$env:USERPROFILE\\fleet" : "$HOME/fleet");
}
function deployScript(h: Host): { cmd: string; shell: Shell } {
  const dir = deployDir(h);
  if (h.os === "windows") return { shell: "powershell", cmd: [
    `$ErrorActionPreference='Stop'`,
    h.deploy?.bun ? `$bun='${h.deploy.bun}'`
      : `$bun=(Get-Command bun -EA SilentlyContinue).Source; if(-not $bun){$bun="$env:USERPROFILE\\.bun\\bin\\bun.exe"}`,
    `$dir="${dir}"`,
    `New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
    `tar -xzf "$env:USERPROFILE\\fleet-deploy.tgz" -C $dir`,
    `Set-Location $dir`,
    `& $bun install 2>&1 | Out-Null`,
    `Remove-Item "$env:USERPROFILE\\fleet-deploy.tgz" -Force -EA SilentlyContinue`,
    `"deployed to $dir (bun: $bun)"`,
  ].join("\n") };
  return { shell: "bash", cmd: [
    `set -e`,
    h.deploy?.bun ? `bun='${h.deploy.bun}'` : `bun="$(command -v bun || echo "$HOME/.bun/bin/bun")"`,
    `dir="${dir}"`,
    `mkdir -p "$dir"`,
    `tar -xzf "$HOME/fleet-deploy.tgz" -C "$dir"`,
    `cd "$dir"`,
    `"$bun" install >/dev/null 2>&1`,
    `rm -f "$HOME/fleet-deploy.tgz"`,
    `echo "deployed to $dir (bun: $bun)"`,
  ].join("\n") };
}
/** Which service (if any) to restart after a deploy: explicit > host.deploy.service
 *  > the host's own `fleet-mcp` service if it has one > none. */
function deployRestartName(h: Host, restart: boolean | string): string | undefined {
  if (restart === false) return undefined;
  if (typeof restart === "string") return restart;
  return h.deploy?.service ?? (h.services?.["fleet-mcp"] ? "fleet-mcp" : undefined);
}
async function deployOne(cfg: FleetConfig, h: Host, tarLocal: string, restart: boolean | string): Promise<DeployResult> {
  const pushed = await scp(h, tarLocal, "fleet-deploy.tgz");
  if (!pushed.ok) return { host: h.name, ok: false, dir: deployDir(h), result: pushed };
  const { cmd, shell } = deployScript(h);
  const result = await exec(h, cmd, shell);
  if (!result.ok) return { host: h.name, ok: false, dir: deployDir(h), result };
  const svc = deployRestartName(h, restart);
  const restarted = svc && h.services?.[svc] ? await restartService(cfg, h.name, svc) : undefined;
  return { host: h.name, ok: restarted ? restarted.every((a) => a.result.ok) : true, dir: deployDir(h), result, restarted };
}
/** Build a tarball of the fleet source on the controller, ship it to each host
 *  the selector resolves to, extract + `bun install`, then optionally restart the
 *  host's fleet service. The manual DEPLOY.md dance, as one command. */
export async function deployHosts(
  cfg: FleetConfig, sel: string, opts: { restart?: boolean | string } = {},
): Promise<DeployResult[]> {
  const hosts = resolveHosts(cfg, sel);
  const tar = join(tmpdir(), `fleet-deploy-${Date.now()}.tgz`);
  const build = Bun.spawn(
    ["tar", "czf", tar, "-C", REPO_ROOT, "--exclude", "node_modules", "--exclude", ".git", "--exclude", "dist", "."],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdout: "ignore", stderr: "pipe" });
  if (await build.exited !== 0)
    throw new Error("tarball build failed: " + (await new Response(build.stderr).text()).trim());
  try {
    return await Promise.all(hosts.map((h) => deployOne(cfg, h, tar, opts.restart ?? true)));
  } finally {
    await Bun.spawn(["rm", "-f", tar]).exited;
  }
}

// ── doctor (diagnose why a host is unreachable) ───────────────────────────────
export interface Diagnosis {
  host: string; os: string; ssh: string; services: string[];
  sshUp: boolean; ms: number;
  health?: string; httpUp?: boolean;
  reason?: string;       // the extracted failure signature when ssh is down
  hints: string[];       // actionable next steps
}
/** Map a verbose-ssh failure log to a human reason + actionable hints. */
function classifySsh(stderr: string): { reason: string; hints: string[] } {
  const has = (re: RegExp) => re.test(stderr);
  if (has(/Could not resolve hostname|Name or service not known|nodename nor servname/i))
    return { reason: "hostname does not resolve", hints: [
      "check the alias in ~/.ssh/config", "if it's a Tailscale name, is Tailscale up locally and is the node online?"] };
  if (has(/Connection refused/i))
    return { reason: "reachable, but nothing is listening on the ssh port", hints: [
      "sshd may be stopped or on a non-default port", "on Windows: is the OpenSSH Server service running?"] };
  if (has(/Operation timed out|Connection timed out|timed out/i))
    return { reason: "no route to host (timeout)", hints: [
      "the box may be powered off, or its network/Tailscale route is down"] };
  if (has(/Permission denied|No more authentication methods|Too many authentication failures/i))
    return { reason: "connected, but authentication failed", hints: [
      "your key isn't authorized on the host (authorized_keys / administrators_authorized_keys)",
      "confirm the right IdentityFile for this host in ~/.ssh/config"] };
  if (has(/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i))
    return { reason: "host-key mismatch", hints: ["the host key changed — clear the stale ~/.ssh/known_hosts entry"] };
  return { reason: "ssh failed for an unrecognised reason", hints: ["see the raw ssh -vv output with --verbose"] };
}
/** Diagnose one host (or dual-boot machine): is ssh up, and if not, why — plus a
 *  health-URL cross-check so an alive-but-unreachable box is obvious. */
export async function diagnose(cfg: FleetConfig, sel: string): Promise<Diagnosis> {
  const host = resolveHosts(cfg, await routeSelector(cfg, sel))[0]!;
  const probe = await sshDiagnose(host);
  const httpUp = host.health ? await probeHttp(host.health) : undefined;
  const base: Diagnosis = {
    host: host.name, os: host.os, ssh: host.ssh, services: Object.keys(host.services ?? {}),
    sshUp: probe.ok, ms: probe.ms, health: host.health, httpUp, hints: [],
  };
  if (probe.ok) return base;
  const { reason, hints } = classifySsh(probe.stderr);
  if (httpUp) hints.unshift("health URL answers → the box is ALIVE; this is an ssh/route problem, not a dead host");
  return { ...base, reason, hints };
}

// ── boot-state awareness (dual-boot machines) ─────────────────────────────────
export interface BootState {
  machine: string;
  live: string | null;            // OS label of the reachable boot, or null if off
  liveHost: string | null;        // host-entry name that answered (TS or LAN)
  transport: "ts" | "lan" | null;
  boots: { os: string; host: string; reachable: boolean; via: "ts" | "lan" | null }[];
}

function getMachine(cfg: FleetConfig, name: string): Machine {
  const m = cfg.machines?.[name];
  if (!m) throw new Error(`unknown machine: ${name} (have: ${Object.keys(cfg.machines ?? {}).join(", ") || "none"})`);
  return m;
}

/** Probe every boot of a machine — all boots and both transports CONCURRENTLY.
 *  Boots are mutually exclusive, so at most one is live; first by config order wins. */
export async function bootState(cfg: FleetConfig, machine: string): Promise<BootState> {
  const m = getMachine(cfg, machine);
  const probed = await Promise.all(Object.entries(m.boots).map(async ([os, b]) => {
    const transports = ([["ts", b.host], ["lan", b.lan]] as const).filter(([, n]) => !!n);
    const hits = await Promise.all(transports.map(async ([t, name]) => {
      const h = cfg.hosts[name!];
      if (!h) throw new Error(`machine ${machine} boot ${os} references unknown host '${name}'`);
      return { t, ok: await probe(h) };
    }));
    const hit = hits.find((r) => r.ok) ?? null;     // prefer TS (listed first)
    const via = hit?.t ?? null;
    return {
      os, host: b.host, reachable: !!hit, via,
      liveHost: hit ? (via === "lan" ? (b.lan ?? b.host) : b.host) : null,
    };
  }));
  const first = probed.find((p) => p.reachable) ?? null;
  return {
    machine,
    live: first?.os ?? null,
    liveHost: first?.liveHost ?? null,
    transport: first?.via ?? null,
    boots: probed.map(({ os, host, reachable, via }) => ({ os, host, reachable, via })),
  };
}

/** Resolve a machine name to its currently-live boot's host entry. Plain host
 *  names pass through unchanged. Used to auto-route exec at a logical name. */
export async function resolveLiveHost(cfg: FleetConfig, name: string): Promise<string> {
  if (cfg.hosts[name]) return name;
  const st = await bootState(cfg, name);
  if (!st.liveHost) throw new Error(`machine ${name} is not reachable in any boot (it may be powered off)`);
  return st.liveHost;
}

async function resolveLiveHostOrSelf(cfg: FleetConfig, name: string): Promise<string> {
  if (cfg.hosts[name]) return name;
  try { return await resolveLiveHost(cfg, name); } catch { return name; }
}

/** Resolve a *single bare machine name* to its live boot's host; pass hosts,
 *  groups, comma-lists, and unknown names through unchanged. Lets any command
 *  that takes a selector accept a dual-boot machine name and auto-route to the
 *  currently-live OS — the same convenience `exec` already had, now shared. */
export async function routeSelector(cfg: FleetConfig, sel: string): Promise<string> {
  if (sel.includes(",") || sel.startsWith("@") || cfg.hosts[sel] || !cfg.machines?.[sel]) return sel;
  return resolveLiveHost(cfg, sel);
}

export interface SwitchResult {
  machine: string; from: string | null; to: string;
  triggered: ExecResult; arrived: boolean; waitedMs: number;
}

/** Boot a machine into target OS: detect the live boot, run switch[target] on it,
 *  then poll until the target boot answers (unless wait:false). */
export async function switchMachine(
  cfg: FleetConfig, machine: string, target: string,
  opts: { timeoutMs?: number; intervalMs?: number; wait?: boolean } = {},
): Promise<SwitchResult> {
  const m = getMachine(cfg, machine);
  if (!m.boots[target]) throw new Error(`machine ${machine} has no boot '${target}' (have: ${Object.keys(m.boots).join(", ")})`);
  const cmd = m.switch?.[target];
  if (!cmd) throw new Error(`no switch command for ${machine} -> ${target} (add machines.${machine}.switch.${target})`);
  const st = await bootState(cfg, machine);
  if (st.live === target) throw new Error(`${machine} is already in ${target}`);
  if (!st.live || !st.liveHost) throw new Error(`${machine} is not reachable — can't issue a switch (power it on first)`);
  const liveHost = cfg.hosts[st.liveHost]!;
  const triggered = await exec(liveHost, cmd);     // reboot drops the link; non-zero is expected & ignored for arrival
  let arrived = false, waitedMs = 0;
  if (opts.wait !== false) {
    const r = await waitFor(cfg, machine, {
      boot: target, timeoutMs: opts.timeoutMs ?? 180_000, intervalMs: opts.intervalMs ?? 5_000,
    });
    arrived = r.ok; waitedMs = r.elapsedMs;
  }
  return { machine, from: st.live, to: target, triggered, arrived, waitedMs };
}

// ── wait (poll until a condition holds; macOS has no `timeout`) ────────────────
export interface WaitResult { ok: boolean; elapsedMs: number; attempts: number; lastDetail: string; }
export interface WaitCond {
  ssh?: boolean; port?: number; http?: string; status?: number; boot?: string;
  timeoutMs?: number; intervalMs?: number; onTick?: (detail: string, ms: number) => void;
}

async function probeOnce(cfg: FleetConfig, target: string, c: WaitCond): Promise<{ ok: boolean; detail: string }> {
  if (c.boot) {
    const st = await bootState(cfg, target);
    return { ok: st.live === c.boot, detail: `live=${st.live ?? "off"}` };
  }
  if (c.http) {
    try {
      const res = await fetch(c.http, { redirect: "manual", signal: AbortSignal.timeout(8000) });
      return { ok: res.status === (c.status ?? 200), detail: `http ${res.status}` };
    } catch { return { ok: false, detail: "http err" }; }
  }
  if (c.port != null) {
    const name = await resolveLiveHostOrSelf(cfg, target);
    const addr = cfg.hosts[name]?.ssh ?? target;
    try {
      const sock = await Bun.connect({ hostname: addr, port: c.port,
        socket: { open: (s) => { s.end(); }, data() {}, close() {}, error() {} } });
      void sock;
      return { ok: true, detail: `:${c.port} open` };
    } catch { return { ok: false, detail: `:${c.port} closed` }; }
  }
  const name = await resolveLiveHostOrSelf(cfg, target);
  const h = cfg.hosts[name];
  if (!h) return { ok: false, detail: "no host" };
  const r = await exec(h, "echo ok");
  return { ok: r.ok && r.stdout.includes("ok"), detail: r.ok ? "ssh up" : "ssh down" };
}

export async function waitFor(cfg: FleetConfig, target: string, c: WaitCond): Promise<WaitResult> {
  const timeoutMs = c.timeoutMs ?? 120_000, intervalMs = c.intervalMs ?? 3_000;
  const start = Date.now(); let attempts = 0, lastDetail = "";
  while (Date.now() - start < timeoutMs) {
    attempts++;
    const { ok, detail } = await probeOnce(cfg, target, c);
    lastDetail = detail;
    const elapsed = Date.now() - start;
    c.onTick?.(detail, elapsed);
    if (ok) return { ok: true, elapsedMs: elapsed, attempts, lastDetail };
    await Bun.sleep(Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - start))));
  }
  return { ok: false, elapsedMs: Date.now() - start, attempts, lastDetail };
}

// ── image delivery (pull + optional local webp transcode) ─────────────────────
let _cwebp: string | null | undefined;
/** Locate cwebp on the local machine (cached). null if not installed. */
async function findCwebp(): Promise<string | null> {
  if (_cwebp !== undefined) return _cwebp;
  const proc = Bun.spawn(["bash", "-lc", "command -v cwebp"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return (_cwebp = out || null);
}
/** What extension new screenshots default to: webp when cwebp is available. */
export async function preferredImageExt(): Promise<"webp" | "png"> {
  return (await findCwebp()) ? "webp" : "png";
}
/** Pull a remote image to `finalOut`. If finalOut is .webp and cwebp exists,
 *  transcode locally (lossless — crisp UI text, smaller than PNG); otherwise
 *  fall back to .png. Returns the ExecResult of the pull and the actual path. */
async function deliverImage(
  host: Host, remotePath: string, finalOut: string,
): Promise<{ result: ExecResult; path: string }> {
  const remote = host.os === "windows" ? remotePath.replace(/\\/g, "/") : remotePath;
  const wantWebp = /\.webp$/i.test(finalOut);
  const cwebp = wantWebp ? await findCwebp() : null;

  if (wantWebp && !cwebp) {                       // no transcoder → honest .png
    const png = finalOut.replace(/\.webp$/i, ".png");
    return { result: await scpPull(host, remote, png), path: png };
  }
  if (wantWebp && cwebp) {
    // unique per call so concurrent captures to the same finalOut can't clobber
    const tmp = `${finalOut}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp.png`;
    const pull = await scpPull(host, remote, tmp);
    if (!pull.ok) return { result: pull, path: finalOut };
    const proc = Bun.spawn([cwebp, "-lossless", "-quiet", tmp, "-o", finalOut], { stdout: "ignore", stderr: "pipe" });
    const code = await proc.exited;
    await Bun.spawn(["rm", "-f", tmp]).exited;
    if (code !== 0) return { result: { ...pull, ok: false, stderr: `cwebp failed: ${await new Response(proc.stderr).text()}` }, path: finalOut };
    return { result: pull, path: finalOut };
  }
  return { result: await scpPull(host, remote, finalOut), path: finalOut };
}

/** Overlay a labeled pixel-coordinate grid on a local image (in place) so an
 *  agent can read off x,y before a cua click (coords are window-local pixels).
 *
 *  Labels are RAW IMAGE PIXELS on purpose — do NOT add a HiDPI/logical scale.
 *  For the path that actually clicks (`fleet cu --grid`) the grid is drawn on
 *  cua-driver's own --screenshot-out-file output, and cua clicks in that same
 *  screenshot's pixel space, so pixel labels == click coords. A scale transform
 *  here would re-introduce a 2× miss on Retina, not fix one. (`shot --grid` is
 *  view-only.) Font path list covers macOS/Linux/Windows; label boxes are sized
 *  from real glyph metrics so the fallback bitmap font still fits.
 *  Best-effort: needs python3 + Pillow locally; returns false if unavailable. */
export async function overlayGrid(imagePath: string, step = 100): Promise<boolean> {
  if (!Number.isFinite(step) || step <= 0) step = 100;   // guard: range(…, 0) throws
  const py = `
import sys
from PIL import Image, ImageDraw, ImageFont
path, step = sys.argv[1], int(sys.argv[2])
im = Image.open(path).convert("RGBA")
w, h = im.size
ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
d = ImageDraw.Draw(ov)
# first available monospace across macOS / Linux / Windows (falls back to PIL's
# tiny bitmap font only if none exist — then label boxes still fit, see measure())
font = None
for cand in ("/System/Library/Fonts/Menlo.ttc",
             "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
             "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
             "/Library/Fonts/Arial.ttf",
             "C:\\\\Windows\\\\Fonts\\\\consola.ttf"):
    try: font = ImageFont.truetype(cand, 12); break
    except Exception: pass
if font is None: font = ImageFont.load_default()
def measure(s):
    l, t, r, b = font.getbbox(s)
    return r - l, b - t
def line(p0, p1, major):
    d.line([p0, p1], fill=(0, 0, 0, 90), width=3 if major else 2)   # dark underlay
    d.line([p0, p1], fill=(80, 200, 255, 180) if major else (255, 60, 60, 90), width=1)
def tag(x, y, s):
    tw, th = measure(s)
    x = max(0, min(x, w - tw - 3)); y = max(0, min(y, h - th - 3))
    d.rectangle([x - 1, y - 1, x + tw + 2, y + th + 2], fill=(0, 0, 0, 175))
    d.text((x, y), s, fill=(120, 255, 120, 255), font=font)
major = step * 5
for x in range(0, w, step): line((x, 0), (x, h), x % major == 0)
for y in range(0, h, step): line((0, y), (w, y), y % major == 0)
# label every gridline near both edges so a coordinate is always close to a click
for x in range(0, w, step):
    tag(x + 2, 1, str(x)); tag(x + 2, h - 16, str(x))
for y in range(step, h, step):
    s = str(y); tw, _ = measure(s)
    tag(1, y + 1, s); tag(w - tw - 3, y + 1, s)
Image.alpha_composite(im, ov).convert("RGB").save(path)
`;
  const proc = Bun.spawn(["python3", "-c", py, imagePath, String(step)], { stdout: "ignore", stderr: "pipe" });
  if (await proc.exited === 0) return true;
  return false;
}

// ── screenshot (capture the remote desktop, pull the PNG back) ────────────────
/** Per-OS command that captures the screen to a temp file and prints the path
 *  as its last stdout line. Best-effort on Linux (needs grim/scrot/imagemagick
 *  + a reachable display). Windows/mac capture the active interactive session. */
function captureCmd(os: Host["os"]): { cmd: string; shell: Shell } {
  if (os === "windows") return { shell: "powershell", cmd: [
    // sshd runs in session 0 (no desktop), so a direct CopyFromScreen captures a
    // blank virtual screen. Run the grab inside the logged-in user's interactive
    // session via a one-shot scheduled task (/IT), then collect the file.
    `$ErrorActionPreference='Stop'`,
    `$out = Join-Path $env:TEMP ('fleet_shot_' + [guid]::NewGuid().ToString('N') + '.png')`,
    `$ps1 = [System.IO.Path]::ChangeExtension($out,'ps1')`,
    `$script = @"`,
    `Add-Type -AssemblyName System.Windows.Forms,System.Drawing`,
    "`$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen",
    "`$bmp=New-Object System.Drawing.Bitmap(`$vs.Width,`$vs.Height)",
    "`$g=[System.Drawing.Graphics]::FromImage(`$bmp)",
    "`$g.CopyFromScreen(`$vs.Location,[System.Drawing.Point]::Empty,`$vs.Size)",
    "`$bmp.Save('$out',[System.Drawing.Imaging.ImageFormat]::Png)",
    "`$g.Dispose(); `$bmp.Dispose()",
    `"@`,
    `Set-Content -LiteralPath $ps1 -Value $script -Encoding UTF8`,
    `$tn = 'fleet_shot_' + [guid]::NewGuid().ToString('N')`,
    `schtasks /Create /TN $tn /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$ps1\`"" /SC ONCE /ST 00:00 /IT /F | Out-Null`,
    `schtasks /Run /TN $tn | Out-Null`,
    `$deadline=(Get-Date).AddSeconds(12)`,
    `while(-not (Test-Path $out) -and (Get-Date) -lt $deadline){ Start-Sleep -Milliseconds 200 }`,
    `schtasks /Delete /TN $tn /F | Out-Null`,
    `Remove-Item -LiteralPath $ps1 -ErrorAction SilentlyContinue`,
    `if(-not (Test-Path $out)){ Write-Error 'capture produced no file — is a user logged in interactively?'; exit 4 }`,
    `Write-Output $out`,
  ].join("\n") };
  if (os === "mac") return { shell: "bash", cmd:
    `t="$(mktemp -t fleet_shot)"; p="$t.png"; rm -f "$t"; screencapture -x "$p"; echo "$p"` };
  // linux: try wayland (grim) then X11 (scrot / imagemagick import)
  return { shell: "bash", cmd: [
    `p="/tmp/fleet_shot_$$.png"`,
    `if command -v grim >/dev/null 2>&1; then grim "$p"`,
    `elif command -v scrot >/dev/null 2>&1; then scrot "$p"`,
    `elif command -v import >/dev/null 2>&1; then DISPLAY="\${DISPLAY:-:0}" import -window root "$p"`,
    `else echo "no screenshot tool (install grim, scrot, or imagemagick)" >&2; exit 3; fi`,
    `echo "$p"`,
  ].join("\n") };
}
function rmCmd(os: Host["os"], remote: string): { cmd: string; shell: Shell } {
  return os === "windows"
    ? { shell: "powershell", cmd: `Remove-Item -LiteralPath '${psEsc(remote)}' -ErrorAction SilentlyContinue` }
    : { shell: "bash", cmd: `rm -f -- '${bashEsc(remote)}'` };
}

export interface ScreenshotResult {
  host: string; localPath: string; remotePath: string;
  capture: ExecResult; pull: ExecResult;
}
/** Capture a screenshot on the first selected host and pull it to `localPath`. */
export async function captureScreenshot(
  cfg: FleetConfig, sel: string, localPath: string,
): Promise<ScreenshotResult> {
  const host = resolveHosts(cfg, sel)[0]!;
  const { cmd, shell } = captureCmd(host.os);
  const capture = await exec(host, cmd, shell);
  if (!capture.ok) throw new Error(
    `screenshot capture failed on ${host.name}: ${capture.stderr || capture.stdout || "exit " + capture.code}`);

  const remotePath = capture.stdout.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  if (!remotePath) throw new Error(`screenshot produced no output path on ${host.name}`);

  // deliverImage normalizes the Windows path for scp and optionally transcodes
  // to webp locally; `path` is the actual file written (.webp or .png fallback).
  const { result: pull, path } = await deliverImage(host, remotePath, localPath);
  const cleanup = rmCmd(host.os, remotePath);
  await exec(host, cleanup.cmd, cleanup.shell).catch(() => {});   // best-effort
  if (!pull.ok) throw new Error(`could not pull screenshot from ${host.name}: ${pull.stderr || "scp exit " + pull.code}`);
  return { host: host.name, localPath: path, remotePath, capture, pull };
}

// ── computer-use (cua-driver passthrough) ────────────────────────────────────
// fleet drives the trycua/cua "Cua Driver" — a self-contained binary that runs a
// background `serve` daemon in the interactive session and exposes computer-use
// tools (list_apps, get_window_state, click, type_text, press_key, scroll, …).
// We shell out to its CLI over the quoting-proof channel: `cua-driver <args>`.
// Needs a logged-in interactive desktop on the target (same as `fleet shot`).

/** Quote one arg for the target's remote shell (the SSH layer is quoting-proof,
 *  but the remote PowerShell/bash still parses the command string we build). */
function shellQuote(arg: string, os: Host["os"]): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(arg)) return arg;     // safe bareword
  if (os === "windows") return "'" + arg.replace(/'/g, "''") + "'";
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/** Remote prelude + invocation token that resolves the cua-driver binary,
 *  falling back to the known install path when it isn't on PATH (the installer
 *  only updates User-scope PATH, which a fresh non-interactive shell may miss). */
function cuaBin(os: Host["os"]): { prelude: string; invoke: string } {
  if (os === "windows") return {
    prelude: `$fcd=(Get-Command cua-driver -EA SilentlyContinue).Source; `
      + `if(-not $fcd){ $fcd=Join-Path $env:LOCALAPPDATA 'Programs\\Cua\\cua-driver\\bin\\cua-driver.exe' }`,
    invoke: `& $fcd`,
  };
  return {
    prelude: `fcd="$(command -v cua-driver 2>/dev/null || echo "$HOME/.local/bin/cua-driver")"`,
    invoke: `"$fcd"`,
  };
}

/** Install cua-driver on the first selected host (official one-line installer). */
export async function cuInstall(cfg: FleetConfig, sel: string): Promise<ExecResult> {
  const host = resolveHosts(cfg, sel)[0]!;
  if (host.os === "windows") {
    return exec(host,
      `irm https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1 | iex; `
      + `& "$env:LOCALAPPDATA\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe" autostart kick`,
      "powershell");
  }
  return exec(host,
    `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)"; `
    + `"$(command -v cua-driver || echo "$HOME/.local/bin/cua-driver")" autostart kick`,
    "bash");
}

export interface CuResult { host: string; result: ExecResult; localImage?: string; }

const IMG_SENTINEL = "__FLEET_IMG__";

/** Build the piped/quoted `<bin> <args>` invocation for one cua-driver call.
 *  A JSON positional arg is piped via stdin (Windows PowerShell 5.1 strips the
 *  quotes around field names on native-command args; piping preserves them). */
function cuInvocation(args: string[], os: Host["os"], invoke: string, extra = ""): string {
  const jsonArg = args.find((a) => /^\s*[[{]/.test(a));
  const flags = args.filter((a) => a !== jsonArg).map((a) => shellQuote(a, os)).join(" ");
  const pipe = jsonArg
    ? (os === "windows"
      ? `'${jsonArg.replace(/'/g, "''")}' | `
      : `printf '%s' '${jsonArg.replace(/'/g, "'\\''")}' | `)
    : "";
  return `${pipe}${invoke} ${flags}${extra}`;
}

/** Run `cua-driver <args>` on a host. If `imageOut` is set, the call is given
 *  `--screenshot-out-file` to a remote temp PNG which is pulled to `imageOut`.
 *  If no image is produced (e.g. the call errored), cua-driver's own message is
 *  surfaced via the returned ExecResult — never masked by a pull/scp error. */
export async function cuRun(
  cfg: FleetConfig, sel: string, args: string[], imageOut?: string,
): Promise<CuResult> {
  const host = resolveHosts(cfg, sel)[0]!;
  const win = host.os === "windows";
  const { prelude, invoke } = cuaBin(host.os);
  const shell: Shell = win ? "powershell" : "bash";

  if (!imageOut) {
    const result = await exec(host, `${prelude}\n${cuInvocation(args, host.os, invoke)}`, shell);
    return { host: host.name, result };
  }

  // Image call: run cua with --screenshot-out-file, echo its own output, then a
  // sentinel line with the path IFF the file was actually written.
  const cmd = win
    ? [prelude,
       `$out = Join-Path $env:TEMP ('cua_' + [guid]::NewGuid().ToString('N') + '.png')`,
       `${cuInvocation(args, host.os, invoke, ` --screenshot-out-file $out`)} 2>&1 | Write-Output`,
       `if (Test-Path $out) { Write-Output ('${IMG_SENTINEL}' + $out) }`].join("\n")
    : [prelude,
       `t="$(mktemp -t cua_shot)"; out="$t.png"; rm -f "$t" "$out"`,
       `${cuInvocation(args, host.os, invoke, ` --screenshot-out-file "$out"`)} 2>&1`,
       `if [ -f "$out" ]; then echo "${IMG_SENTINEL}$out"; fi`].join("\n");
  const raw = await exec(host, cmd, shell);

  // split the sentinel out of the displayed output
  const lines = raw.stdout.split("\n");
  const imgLine = lines.find((l) => l.trim().startsWith(IMG_SENTINEL));
  const result: ExecResult = {
    ...raw,
    stdout: lines.filter((l) => !l.trim().startsWith(IMG_SENTINEL)).join("\n").trimEnd(),
  };
  if (!imgLine) return { host: host.name, result };   // no image → surface cua's message as-is

  const remote = imgLine.trim().slice(IMG_SENTINEL.length);
  const { result: pull, path } = await deliverImage(host, remote, imageOut);
  const rm = rmCmd(host.os, remote);
  await exec(host, rm.cmd, rm.shell).catch(() => {});
  if (!pull.ok) return { host: host.name,
    result: { ...result, ok: false, stderr: `${result.stderr}\nimage pull failed: ${pull.stderr}`.trim() } };
  return { host: host.name, result, localImage: path };
}

// ── computer-use conveniences (item 3: cut the list→list→build-JSON loop) ─────
/** Slice the first JSON value out of mixed output (defensive against stray lines). */
function extractJson(s: string): any {
  const start = s.search(/[[{]/);
  if (start < 0) throw new Error("no JSON in cua-driver output");
  const open = s[start], close = open === "{" ? "}" : "]";
  const end = s.lastIndexOf(close);
  return JSON.parse(s.slice(start, end + 1));
}

export interface CuApp { name: string; pid: number; active?: boolean; kind?: string; }
export interface CuWindow { window_id: number; title: string; pid: number; width?: number; height?: number; }

/** `list_apps` → typed app list (optionally name-filtered, case-insensitive). */
export async function cuApps(
  cfg: FleetConfig, sel: string, filter?: string,
): Promise<{ apps: CuApp[]; result: ExecResult }> {
  const { result } = await cuRun(cfg, sel, ["list_apps"]);
  if (!result.ok) return { apps: [], result };
  const data = extractJson(result.stdout);
  let apps: CuApp[] = Array.isArray(data) ? data : data.apps ?? [];
  if (filter) apps = apps.filter((a) => a.name?.toLowerCase().includes(filter.toLowerCase()));
  return { apps, result };
}

/** `list_windows {pid}` → typed window list. */
export async function cuWindows(
  cfg: FleetConfig, sel: string, pid: number,
): Promise<{ windows: CuWindow[]; result: ExecResult }> {
  const { result } = await cuRun(cfg, sel, ["list_windows", JSON.stringify({ pid })]);
  if (!result.ok) return { windows: [], result };
  const data = extractJson(result.stdout);
  const windows: CuWindow[] = Array.isArray(data) ? data : data.windows ?? [];
  return { windows, result };
}

/** Resolve a pid from a numeric string or an app-name substring. */
export async function cuResolvePid(cfg: FleetConfig, sel: string, query: string): Promise<CuApp> {
  if (/^\d+$/.test(query)) return { name: query, pid: Number(query) };
  const { apps } = await cuApps(cfg, sel, query);
  const m = apps.find((a) => a.active) ?? apps[0];
  if (!m) throw new Error(`no app matching "${query}" on the host (try: fleet cu ${sel} apps)`);
  return m;
}

/** Capture a window by app-name-or-pid. Resolve (pid → window) + capture happen
 *  in a SINGLE remote script (one SSH round-trip) + one scp pull — not five.
 *  cua-driver is invoked 3× but locally on the host, where it's cheap. */
export async function cuShotWindow(
  cfg: FleetConfig, sel: string, query: string, imageOut: string,
): Promise<CuResult & { app: CuApp; window: CuWindow }> {
  const host = resolveHosts(cfg, sel)[0]!;
  if (host.os !== "windows") {
    // mac/linux: keep the simple composed path (no host-side JSON parser assumed)
    const app = await cuResolvePid(cfg, sel, query);
    const { windows } = await cuWindows(cfg, sel, app.pid);
    const window = windows[0];
    if (!window) throw new Error(`pid ${app.pid} (${app.name}) has no capturable windows`);
    const r = await cuRun(cfg, sel,
      ["get_window_state", JSON.stringify({ pid: app.pid, window_id: window.window_id, capture_mode: "vision" })],
      imageOut);
    return { ...r, app, window };
  }

  const { prelude, invoke } = cuaBin(host.os);
  const q = query.replace(/'/g, "''");
  const cmd = [
    prelude,
    `$q = '${q}'`,
    // resolve pid: numeric → that pid; else first (active-preferred) name match
    `if ($q -match '^[0-9]+$') { $tpid = [int]$q; $tname = $q } else {`,
    `  $apps = (${invoke} list_apps | ConvertFrom-Json).apps`,
    `  $m = @($apps | Where-Object { $_.name -match [regex]::Escape($q) } | Sort-Object { -[int][bool]$_.active }) | Select-Object -First 1`,
    `  if (-not $m) { Write-Error "no app matching '$q' (try: fleet cu ${sel} apps)"; exit 2 }`,
    `  $tpid = $m.pid; $tname = $m.name }`,
    // first window for that pid (list_windows returns an object, not a bare array)
    `$wp = ('{"pid":' + $tpid + '}') | ${invoke} list_windows | ConvertFrom-Json`,
    `$wins = if ($wp.windows) { $wp.windows } elseif ($wp._legacy_windows) { $wp._legacy_windows } else { $wp }`,
    `$w = @($wins) | Select-Object -First 1`,
    `if (-not $w) { Write-Error "pid $tpid ($tname) has no capturable windows"; exit 3 }`,
    // capture to temp; keep stdout clean, surface cua errors only on failure
    `$out = Join-Path $env:TEMP ('cua_' + [guid]::NewGuid().ToString('N') + '.png')`,
    `$payload = '{"pid":' + $tpid + ',"window_id":' + $w.window_id + ',"capture_mode":"vision"}'`,
    `$err = ($payload | ${invoke} get_window_state --screenshot-out-file $out 2>&1)`,
    `if (Test-Path $out) { Write-Output ('${IMG_SENTINEL}' + $out + '|' + $tpid + '|' + $w.window_id + '|' + $tname + '|' + $w.title) }`,
    `else { Write-Output $err; exit 4 }`,
  ].join("\n");

  const raw = await exec(host, cmd, "powershell");
  const imgLine = raw.stdout.split("\n").find((l) => l.trim().startsWith(IMG_SENTINEL));
  if (!imgLine) return { host: host.name, result: raw, app: { name: query, pid: 0 }, window: { window_id: 0, title: "", pid: 0 } };

  const [rpath, rpid, rwid, rname, ...rtitle] = imgLine.trim().slice(IMG_SENTINEL.length).split("|");
  const { result: pull, path } = await deliverImage(host, rpath!, imageOut);
  await exec(host, `Remove-Item -LiteralPath '${psEsc(rpath!)}' -EA SilentlyContinue`, "powershell").catch(() => {});
  const app: CuApp = { name: rname!, pid: Number(rpid) };
  const window: CuWindow = { window_id: Number(rwid), title: rtitle.join("|"), pid: Number(rpid) };
  if (!pull.ok) return { host: host.name, result: { ...raw, ok: false, stderr: `image pull failed: ${pull.stderr}` }, app, window };
  return { host: host.name, result: { ...raw, stdout: "" }, localImage: path, app, window };
}

// ── restart / logs (resolve a configured service on the first selected host) ──
export interface ServiceAction {
  host: string; service: string; type: string; cmd: string; result: ExecResult;
}
/** Every host the selector resolves to that actually defines the named service.
 *  Fans out (consistent with exec/cp) rather than silently using the first host;
 *  throws only if NO matched host has the service. */
function serviceHosts(cfg: FleetConfig, sel: string, svcName: string): { host: Host; svc: Service }[] {
  const hosts = resolveHosts(cfg, sel);
  const matched = hosts.flatMap((host) => {
    const svc = host.services?.[svcName];
    return svc ? [{ host, svc }] : [];
  });
  if (!matched.length) {
    const opts = hosts.flatMap((h) => Object.keys(h.services ?? {}));
    throw new Error(`no host in '${sel}' has service '${svcName}' (available: ${[...new Set(opts)].join(", ") || "none"})`);
  }
  return matched;
}
export async function restartService(
  cfg: FleetConfig, sel: string, svcName: string,
): Promise<ServiceAction[]> {
  return Promise.all(serviceHosts(cfg, sel, svcName).map(async ({ host, svc }) => {
    const { cmd, shell } = restartCmd(svc);
    return { host: host.name, service: svcName, type: svc.type, cmd, result: await exec(host, cmd, shell) };
  }));
}
export async function serviceLogs(
  cfg: FleetConfig, sel: string, svcName: string, n: number,
): Promise<ServiceAction[]> {
  return Promise.all(serviceHosts(cfg, sel, svcName).map(async ({ host, svc }) => {
    const { cmd, shell } = logsCmd(svc, n);
    return { host: host.name, service: svcName, type: svc.type, cmd, result: await exec(host, cmd, shell) };
  }));
}

// ── reboot the whole machine ──────────────────────────────────────────────────
/** Per-OS reboot. Scheduled with a small delay / detached so the ssh call
 *  returns cleanly *before* the box drops — otherwise the severed connection
 *  reads as a spurious failure. Assumes passwordless sudo on linux/mac (same
 *  assumption `sudo systemctl restart` already relies on). */
export function rebootCmd(host: Host): { cmd: string; shell: Shell } {
  if (host.os === "windows")
    return { cmd: `shutdown /r /t 3 /c "fleet reboot"`, shell: "powershell" };
  return {
    cmd: `nohup bash -c 'sleep 2; sudo shutdown -r now' >/dev/null 2>&1 & echo reboot-scheduled`,
    shell: "bash",
  };
}
export interface RebootAction { host: string; os: string; cmd: string; result: ExecResult; }
/** Reboot every host the selector resolves to. */
export async function rebootHosts(cfg: FleetConfig, sel: string): Promise<RebootAction[]> {
  const hosts = resolveHosts(cfg, sel);
  return Promise.all(hosts.map(async (h) => {
    const { cmd, shell } = rebootCmd(h);
    return { host: h.name, os: h.os, cmd, result: await exec(h, cmd, shell) };
  }));
}

// ── dashboard (gpu / status) ──────────────────────────────────────────────────
export async function fetchDashboard(cfg: FleetConfig): Promise<any> {
  const base = cfg.dashboard;
  if (!base) throw new Error("no dashboard configured in fleet.config.json");
  const url = base.replace(/\/$/, "") + "/api/state";
  try { return await (await fetch(url, { signal: AbortSignal.timeout(10000) })).json(); }
  catch (e) { throw new Error("could not reach dashboard: " + (e as Error).message); }
}
function modelOf(node: any): string {
  for (const s of node.services ?? []) if (s.detail && s.up) return s.detail;
  return "";
}
export interface GpuRow {
  host: string; gpu: string; util: number | null; free_gb: number | null;
  temp: number | null; power: number | null; model: string;
}
export async function gpuRows(cfg: FleetConfig): Promise<GpuRow[]> {
  const data = await fetchDashboard(cfg);
  const rows: GpuRow[] = [];
  for (const [name, n] of Object.entries<any>(data.nodes ?? {})) {
    for (const g of n.gpu ?? []) {
      const freeG = g.mem_total_mb ? (g.mem_total_mb - g.mem_used_mb) / 1024 : null;
      rows.push({ host: name, gpu: g.name, util: g.util, free_gb: freeG,
        temp: g.temp, power: g.power, model: modelOf(n) });
    }
  }
  return rows;
}
export interface FleetStatus { nodes: Record<string, any>; uptime: any[]; }
/** Live host stats; `filter` restricts to a single host name. */
export async function hostStatus(cfg: FleetConfig, filter?: string): Promise<FleetStatus> {
  const data = await fetchDashboard(cfg);
  const nodes: Record<string, any> = {};
  for (const [k, n] of Object.entries<any>(data.nodes ?? {})) {
    if (filter && k !== filter) continue;
    nodes[k] = n;
  }
  return { nodes, uptime: data.uptime ?? [] };
}

// ── recipes (saved playbooks of fleet subcommand strings) ─────────────────────
export interface StepResult { step: string; results: ExecResult[]; ok: boolean; }
export interface RecipeRun { name: string; steps: StepResult[]; ok: boolean; }
export interface RecipeHooks {
  onStepStart?: (i: number, total: number, step: string) => void;
  onStepDone?: (sr: StepResult) => void;
}

/** Execute one recipe step. Recipes support the mutating subcommands only. */
async function runStep(cfg: FleetConfig, step: string): Promise<StepResult> {
  const toks = splitArgs(step);
  const sub = toks[0];
  const rest = toks.slice(1);
  let results: ExecResult[];
  switch (sub) {
    case "exec": {
      const wsl = pullFlag(rest, "--wsl");
      pullFlag(rest, "--json"); pullFlag(rest, "--raw");   // irrelevant inside a recipe
      const sel = rest.shift();
      const cmd = rest.join(" ");
      if (!sel || !cmd) throw new Error(`recipe step needs 'exec <sel> <cmd>': ${step}`);
      results = await runExec(cfg, sel, cmd, { wsl });
      break;
    }
    case "restart": {
      const [sel, svc] = rest;
      if (!sel || !svc) throw new Error(`recipe step needs 'restart <host> <svc>': ${step}`);
      results = (await restartService(cfg, sel, svc)).map((a) => a.result);
      break;
    }
    case "cp": {
      const [local, target] = rest;
      if (!local || !target || !target.includes(":")) throw new Error(`recipe step needs 'cp <local> <sel>:<remote>': ${step}`);
      const ci = target.indexOf(":");
      results = await pushFile(cfg, local, target.slice(0, ci), target.slice(ci + 1));
      break;
    }
    case "logs": {
      const n = parseInt(pullVal(rest, "-n") ?? "30", 10);
      const [sel, svc] = rest;
      if (!sel || !svc) throw new Error(`recipe step needs 'logs <host> <svc>': ${step}`);
      results = (await serviceLogs(cfg, sel, svc, n)).map((a) => a.result);
      break;
    }
    default:
      throw new Error(`recipe step uses unsupported subcommand '${sub ?? ""}': ${step} (recipes support exec/restart/cp/logs)`);
  }
  return { step, results, ok: results.every((r) => r.ok) };
}

/** Run a saved recipe, stopping on the first failing step (like the CLI). */
export async function runRecipe(
  cfg: FleetConfig, name: string, hooks: RecipeHooks = {},
): Promise<RecipeRun> {
  const steps = cfg.recipes?.[name];
  if (!steps) throw new Error(
    `unknown recipe '${name}' (have: ${Object.keys(cfg.recipes ?? {}).join(", ") || "none"})`);
  const out: StepResult[] = [];
  let ok = true;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    hooks.onStepStart?.(i, steps.length, step);
    const sr = await runStep(cfg, step);
    out.push(sr);
    hooks.onStepDone?.(sr);
    if (!sr.ok) { ok = false; break; }
  }
  return { name, steps: out, ok };
}
