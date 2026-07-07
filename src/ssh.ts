/**
 * The robust exec primitive. Every path is quoting-proof:
 *  - linux/mac : the command is piped to `bash -ls` over stdin — nothing is
 *                interpolated into the remote command line at all.
 *  - windows   : PowerShell `-EncodedCommand` (base64 of UTF-16LE) — the shell
 *                never parses our quotes.
 *  - wsl       : a base64'd bash command, decoded inside WSL, launched via the
 *                same PowerShell EncodedCommand wrapper.
 *
 * No matter what characters the command contains, the SSH command line only
 * ever carries a base64 blob or a fixed wrapper. This is the whole point of
 * `fleet`: you never think about quoting again.
 */
import type { Host } from "./config.ts";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// ── SSH connection multiplexing ──────────────────────────────────────────────
// Reuse one master connection per host instead of re-handshaking on every exec/
// probe/scp/poll. The control socket lives under ~/.fleet/ssh/ (created once);
// `%C` is a short fixed-length hash of (localhost, remotehost, port, user), so the
// path stays well under the macOS unix-socket length limit. Disable with
// FLEET_NO_SSH_MUX=1 (useful when debugging a wedged socket).
const SSH_MUX = process.env.FLEET_NO_SSH_MUX !== "1";
let _muxDir: string | null = null;
function controlOpts(): string[] {
  if (!SSH_MUX) return [];
  if (_muxDir === null) {
    _muxDir = join(homedir(), ".fleet", "ssh");
    try { mkdirSync(_muxDir, { recursive: true }); } catch { /* best-effort; ssh falls back to no-mux if the socket can't be made */ }
  }
  return ["-o", "ControlMaster=auto", "-o", `ControlPath=${join(_muxDir, "cm-%C")}`, "-o", "ControlPersist=60s"];
}

export interface ExecResult {
  host: string;
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export type Shell = "auto" | "powershell" | "wsl" | "bash";

function b64utf8(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}
function b64utf16le(s: string): string {
  return Buffer.from(s, "utf16le").toString("base64");
}

// ── --cwd support ────────────────────────────────────────────────────────────
// Prepend a directory change to the command, shell-appropriately. We never lose
// the quoting-proof guarantee: the cwd is embedded into the SAME base64/stdin
// blob as the rest of the command, so the SSH command line is unchanged. A
// missing dir fails fast (exit 127 / terminating error) instead of silently
// running in the wrong place — the footgun this exists to kill.
export const bashEsc = (s: string) => s.replace(/'/g, `'\\''`);     // close-quote, escaped-quote, reopen
export const psEsc = (s: string) => s.replace(/'/g, "''");          // doubled single-quote
function withCwdBash(cmd: string, cwd: string): string {
  const q = bashEsc(cwd);
  return `cd -- '${q}' || { echo 'fleet: cwd not found: ${q}' 1>&2; exit 127; }\n${cmd}`;
}
function withCwdPwsh(cmd: string, cwd: string): string {
  return `Set-Location -LiteralPath '${psEsc(cwd)}' -ErrorAction Stop\n${cmd}`;
}

// Prefer PowerShell 7 (`pwsh`) on Windows hosts: much faster startup than the
// built-in Windows PowerShell 5.1, no "Preparing modules" CLIXML noise, and it
// doesn't strip quotes around JSON on native-command args. Detected once per
// host and cached. Force with FLEET_WIN_SHELL=powershell|pwsh.
type WinBin = "pwsh" | "powershell";
const winBinCache = new Map<string, Promise<WinBin>>();

async function resolveWinBin(host: Host): Promise<WinBin> {
  const forced = process.env.FLEET_WIN_SHELL as WinBin | undefined;
  if (forced === "pwsh" || forced === "powershell") return forced;
  const cached = winBinCache.get(host.ssh);
  if (cached) return cached;
  const probe = (async (): Promise<WinBin> => {
    // probe via the always-present Windows PowerShell
    const inner = `if (Get-Command pwsh -EA SilentlyContinue) { 'pwsh' } else { 'powershell' }`;
    const proc = Bun.spawn(["ssh", ...controlOpts(), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host.ssh,
      "powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", b64utf16le(inner)],
      { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out.includes("pwsh") ? "pwsh" : "powershell";
  })().catch((): WinBin => "powershell");
  winBinCache.set(host.ssh, probe);
  return probe;
}

export function buildArgs(host: Host, command: string, shell: Shell, winBin: WinBin = "powershell", cwd?: string): {
  args: string[];
  stdin?: Uint8Array;
} {
  const ssh = ["ssh", ...controlOpts(), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host.ssh];

  if (host.os === "windows") {
    if (shell === "bash")
      throw new Error(`${host.name} is a Windows host — use shell "wsl" for bash (or "powershell")`);
    if (shell === "wsl") {
      const distro = host.wsl ?? "Ubuntu";
      const script = cwd ? withCwdBash(command, cwd) : command;
      // distro is quoted for PowerShell so a name with spaces/quotes can't
      // break out of the (otherwise fixed) wrapper line
      const inner =
        `wsl -d '${psEsc(distro)}' bash -lc "echo ${b64utf8(script)} | base64 -d | bash"`;
      return { args: [...ssh, winBin, "-NoProfile", "-NonInteractive",
        "-EncodedCommand", b64utf16le(inner)] };
    }
    // default: PowerShell EncodedCommand (pwsh when available)
    const script = cwd ? withCwdPwsh(command, cwd) : command;
    return { args: [...ssh, winBin, "-NoProfile", "-NonInteractive",
      "-EncodedCommand", b64utf16le(script)] };
  }

  // linux / mac: feed the script to `bash -ls` via stdin — zero interpolation
  const script = cwd ? withCwdBash(command, cwd) : command;
  return { args: [...ssh, "bash", "-ls"],
    stdin: new TextEncoder().encode(script + "\n") };
}

/** Wall-clock cap for a single exec, in ms. ssh's ConnectTimeout only bounds
 *  the CONNECTION — a remote command that hangs would otherwise block forever.
 *  Default: FLEET_EXEC_TIMEOUT env (seconds), else no cap (0). Per-call
 *  `opts.timeoutMs` wins. On expiry the local ssh is killed and the result is
 *  exit 124 (timeout(1) convention). */
const EXEC_TIMEOUT_MS = Math.max(0, Number(process.env.FLEET_EXEC_TIMEOUT ?? 0) * 1000 || 0);

export async function exec(
  host: Host,
  command: string,
  shell: Shell = "auto",
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const resolved: Shell = shell === "auto"
    ? (host.os === "windows" ? "powershell" : "bash")
    : shell;
  const winBin = host.os === "windows" && resolved !== "bash"
    ? await resolveWinBin(host) : "powershell";
  const { args, stdin } = buildArgs(host, command, resolved, winBin, opts.cwd);

  const proc = Bun.spawn(args, {
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeoutMs = opts.timeoutMs ?? EXEC_TIMEOUT_MS;
  let timedOut = false;
  const timer = timeoutMs > 0
    ? setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs)
    : null;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  if (timedOut) return { host: host.name, ok: false, code: 124,
    stdout: stdout.trimEnd(),
    stderr: (stderr.trimEnd() + `\nfleet: command timed out after ${Math.round(timeoutMs / 1000)}s`).trim() };
  return { host: host.name, ok: code === 0, code, stdout: stdout.trimEnd(),
    stderr: stderr.trimEnd() };
}

/** Fast reachability probe — a single `ssh … echo ok` that works on every OS
 *  (bare `echo ok` runs in cmd/sh without any shell-detection round-trip, so a
 *  dead Windows host costs ONE timeout, not the two that the full exec path pays
 *  via resolveWinBin). Capped by a wall-clock kill so a hung `.local` mDNS
 *  lookup (which ssh's ConnectTimeout does NOT bound) can't dominate a fan-out.
 *  Override the cap with FLEET_PROBE_TIMEOUT_MS. */
const PROBE_CAP_MS = Number(process.env.FLEET_PROBE_TIMEOUT_MS ?? 4000);
export async function probe(host: Host, capMs = PROBE_CAP_MS): Promise<boolean> {
  const connectTimeout = Math.max(1, Math.ceil(capMs / 1000));
  const proc = Bun.spawn(["ssh", ...controlOpts(), "-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeout}`,
    host.ssh, "echo ok"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const ran = (async () => {
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.includes("ok");
  })();
  const capped = Bun.sleep(capMs).then(() => { proc.kill(); return false; });
  return Promise.race([ran, capped]);
}

/** Stream a bash command's output live to the local terminal (inherited stdout/
 *  stderr) — for `fleet jobs tail -f`, where we want a long-lived follow rather
 *  than a buffered round-trip. Linux/mac only; the command is fixed + safe
 *  (our own `tail -n N -f <spool>`), so stdin-piping isn't needed. Ctrl-C kills
 *  the local ssh, which ends the remote tail. */
export function execStream(host: Host, command: string): Promise<number> {
  const proc = Bun.spawn(["ssh", "-tt", ...controlOpts(), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
    host.ssh, "bash", "-lc", command],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

/** Diagnostic ssh attempt: `ssh -vv … echo` capturing the verbose stderr, for
 *  `fleet doctor`. Returns whether it connected, the timing, and the raw verbose
 *  log to mine for the failure reason. */
export async function sshDiagnose(host: Host, timeoutS = 8): Promise<{ ok: boolean; stderr: string; ms: number }> {
  const start = Date.now();
  // Deliberately NO controlOpts(): doctor must diagnose a FRESH connection —
  // riding an existing master would mask the very failures it exists to find.
  const proc = Bun.spawn(["ssh", "-vv", "-o", "BatchMode=yes", "-o", `ConnectTimeout=${timeoutS}`,
    host.ssh, "echo fleet-ok"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0 && stdout.includes("fleet-ok"), stderr, ms: Date.now() - start };
}

/** Windows equivalent of `execStream`: live-follow a PowerShell command (e.g.
 *  `Get-Content … -Wait`) with inherited stdio. The command is fixed + safe (our
 *  own spool path), so no encoding is needed. Uses the always-present
 *  `powershell` (5.1) for portability. */
export function execStreamWin(host: Host, psCommand: string): Promise<number> {
  const proc = Bun.spawn(["ssh", "-tt", ...controlOpts(), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
    host.ssh, "powershell", "-NoProfile", "-NonInteractive", "-Command", psCommand],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

/** Interactive ssh with inherited stdio (for `fleet ssh <host>`). */
export function sshInteractive(host: Host): Promise<number> {
  const proc = Bun.spawn(["ssh", ...controlOpts(), host.ssh], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  return proc.exited;
}

async function runScp(host: Host, argv: string[]): Promise<ExecResult> {
  const proc = Bun.spawn(["scp", ...controlOpts(), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ...argv],
    { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { host: host.name, ok: code === 0, code, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
}

/** scp a local file/dir to host:remote. Remote path passed through verbatim
 *  (forward slashes work on Windows OpenSSH; `C:\…` absolute paths work too).
 *  `recursive` (scp -r) copies a directory tree. */
export function scp(host: Host, local: string, remote: string, recursive = false): Promise<ExecResult> {
  return runScp(host, [...(recursive ? ["-r"] : []), local, `${host.ssh}:${remote}`]);
}

/** scp host:remote → local (pull). Mirror of `scp`, for retrieving a file/dir
 *  the remote produced (e.g. a screenshot). Remote path passed through verbatim. */
export function scpPull(host: Host, remote: string, local: string, recursive = false): Promise<ExecResult> {
  return runScp(host, [...(recursive ? ["-r"] : []), `${host.ssh}:${remote}`, local]);
}
