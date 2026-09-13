/**
 * The robust exec primitive. Every path is quoting-proof:
 *  - linux/mac : the command is piped to `bash -ls` over stdin — nothing is
 *                interpolated into the remote command line at all.
 *  - windows   : the PowerShell program is piped over stdin to `-Command -`.
 *  - wsl       : the bash program is piped over stdin through a fixed, encoded
 *                PowerShell wrapper that launches `wsl ... bash -s`.
 *
 * No matter what characters the command contains, the SSH command line never
 * carries user command text. It carries only fixed wrappers. This is the whole
 * point of `fleet`: you never think about quoting again.
 */
import type { Host } from "./config.ts";
import { dtExec, dtProbe, dtPush, dtPull } from "./daytona.ts";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// ── SSH connection multiplexing ──────────────────────────────────────────────
// Reuse one master connection per host instead of re-handshaking on every exec/
// probe/scp/poll. The control socket lives under ~/.fleet/ssh/ (created once);
// `%C` is a short fixed-length hash of (localhost, remotehost, port, user), so the
// path stays well under the macOS unix-socket length limit. Disable with
// FLEET_NO_SSH_MUX=1 (useful when debugging a wedged socket).
//
// FLEET_SSH_MUX=config defers entirely to ~/.ssh/config instead: we pass no
// Control* options at all, so a long-lived master defined there is reused. This
// matters when a host's direct network path is down but a config master (e.g.
// ControlPersist 30m) is still alive — our own short-lived socket would force a
// fresh connection and fail with "No route to host" where raw ssh succeeds.
// FLEET_SSH_PERSIST overrides just the persist duration (e.g. "30m").
const SSH_MUX = process.env.FLEET_NO_SSH_MUX !== "1";
const SSH_MUX_FROM_CONFIG = process.env.FLEET_SSH_MUX === "config";
const SSH_PERSIST = process.env.FLEET_SSH_PERSIST || "60s";
let _muxDir: string | null = null;
function controlOpts(): string[] {
  if (!SSH_MUX) return [];
  // Windows OpenSSH has no unix-socket connection multiplexing. Handing it
  // ControlMaster/ControlPath makes every ssh fail with "mux_client_request_session:
  // read from master failed", which `fleet ls` reports as a dead host.
  if (process.platform === "win32") return [];
  if (SSH_MUX_FROM_CONFIG) return [];   // honour ControlMaster/ControlPath from ~/.ssh/config
  if (_muxDir === null) {
    _muxDir = join(homedir(), ".fleet", "ssh");
    try { mkdirSync(_muxDir, { recursive: true }); } catch { /* best-effort; ssh falls back to no-mux if the socket can't be made */ }
  }
  return ["-o", "ControlMaster=auto", "-o", `ControlPath=${join(_muxDir, "cm-%C")}`, "-o", `ControlPersist=${SSH_PERSIST}`];
}

export interface ExecResult {
  host: string;
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

export type Shell = "auto" | "powershell" | "wsl" | "bash";

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
export function bashPathAssignment(variable: string, value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(variable)) throw new Error(`invalid shell variable: ${variable}`);
  const q = bashEsc(value);
  return [
    `${variable}='${q}'`,
    `case "$${variable}" in`,
    `  '~') ${variable}="$HOME" ;;`,
    "  '~/'*) " + variable + '="$HOME/${' + variable + '#\\~/}" ;;',
    `esac`,
  ].join("\n");
}
function withCwdBash(cmd: string, cwd: string): string {
  return `${bashPathAssignment("fleet_cwd", cwd)}
cd -- "$fleet_cwd" || { echo "fleet: cwd not found: $fleet_cwd" 1>&2; exit 127; }
unset fleet_cwd
${cmd}`;
}
function withCwdPwsh(cmd: string, cwd: string): string {
  return `Set-Location -LiteralPath '${psEsc(cwd)}' -ErrorAction Stop\n${cmd}`;
}

// Prefer PowerShell 7 (`pwsh`) on Windows hosts: much faster startup than the
// built-in Windows PowerShell 5.1, no "Preparing modules" CLIXML noise, and it
// doesn't strip quotes around JSON on native-command args. Detected once per
// host and cached. Force with FLEET_WIN_SHELL=powershell|pwsh.
type WinBin = "pwsh" | "powershell";
const winBinCache = new Map<string, WinBin>();

async function resolveWinBin(host: Host, timeoutMs = 0): Promise<WinBin> {
  const forced = process.env.FLEET_WIN_SHELL as WinBin | undefined;
  if (forced === "pwsh" || forced === "powershell") return forced;
  if (host.winShell) return host.winShell;
  const cached = winBinCache.get(host.ssh);
  if (cached) return cached;
  const detected = await (async (): Promise<WinBin> => {
    // probe via the always-present Windows PowerShell
    const inner = `if (Get-Command pwsh -EA SilentlyContinue) { 'pwsh' } else { 'powershell' }`;
    const proc = Bun.spawn(["ssh", ...controlOpts(), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host.ssh,
      "powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", b64utf16le(inner)],
      { stdout: "pipe", stderr: "ignore" });
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, timeoutMs)
      : null;
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (timer) clearTimeout(timer);
    if (timedOut) throw new Error("Windows shell discovery timed out");
    return out.includes("pwsh") ? "pwsh" : "powershell";
  })().catch((): WinBin => "powershell");
  winBinCache.set(host.ssh, detected);
  return detected;
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
      const inner = `& wsl -d '${psEsc(distro)}' -- bash -s`;
      return { args: [...ssh, winBin, "-NoProfile", "-NonInteractive",
        "-EncodedCommand", b64utf16le(inner)],
        stdin: new TextEncoder().encode(script + "\n") };
    }
    // Native PowerShell reads the entire program from stdin. This keeps command
    // text and secrets out of both the local ssh argv and the remote process argv,
    // and removes Windows' EncodedCommand length ceiling.
    const script = cwd ? withCwdPwsh(command, cwd) : command;
    return { args: [...ssh, winBin, "-NoProfile", "-NonInteractive", "-Command", "-"],
      // -Command - needs an empty line to submit a final multiline statement.
      stdin: new TextEncoder().encode(script + "\n\n") };
  }

  // linux / mac: feed the script to `bash -ls` via stdin — zero interpolation
  const script = cwd ? withCwdBash(command, cwd) : command;
  return { args: [...ssh, "bash", "-ls"],
    stdin: new TextEncoder().encode(script + "\n") };
}

/** Windows PowerShell 5.1 serializes its error/progress streams over ssh as a
 *  CLIXML blob ("#< CLIXML" + XML) — progress records ("Preparing modules…")
 *  are pure noise, and real error text is buried in <S S="Error"> elements.
 *  Decode: keep Error-stream strings (XML-unescaped, _x****_ codepoints
 *  restored), drop everything else. Non-CLIXML stderr passes through as-is. */
export function stripClixml(stderr: string): string {
  if (!stderr.includes("#< CLIXML")) return stderr;
  const before = stderr.slice(0, stderr.indexOf("#< CLIXML"));
  const xml = stderr.slice(stderr.indexOf("#< CLIXML"));
  const errs: string[] = [];
  const re = /<S S="Error">([\s\S]*?)<\/S>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const text = m[1]!
      .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    errs.push(text);
  }
  return (before + errs.join("")).trimEnd();
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
  opts: ExecOptions = {},
): Promise<ExecResult> {
  if (host.transport === "daytona") {
    if (shell !== "auto" && shell !== "bash")
      return { host: host.name, ok: false, code: 1, stdout: "",
        stderr: `${host.name} is a daytona sandbox — only bash is available` };
    return dtExec(host, command, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? (EXEC_TIMEOUT_MS || undefined) });
  }
  const resolved: Shell = shell === "auto"
    ? (host.os === "windows" ? "powershell" : "bash")
    : shell;
  const timeoutMs = opts.timeoutMs ?? EXEC_TIMEOUT_MS;
  const startedAt = Date.now();
  const winBin = host.os === "windows" && resolved !== "bash"
    ? await resolveWinBin(host, timeoutMs) : "powershell";
  const remainingMs = timeoutMs > 0 ? timeoutMs - (Date.now() - startedAt) : 0;
  if (timeoutMs > 0 && remainingMs <= 0)
    return { host: host.name, ok: false, code: 124, stdout: "",
      stderr: `fleet: command timed out after ${Math.round(timeoutMs / 1000)}s` };
  const { args, stdin } = buildArgs(host, command, resolved, winBin, opts.cwd);

  const proc = Bun.spawn(args, {
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = timeoutMs > 0
    ? setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, remainingMs)
    : null;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  const err = host.os === "windows" ? stripClixml(stderr.trimEnd()) : stderr.trimEnd();
  if (timedOut) return { host: host.name, ok: false, code: 124,
    stdout,
    stderr: (err + `\nfleet: command timed out after ${Math.round(timeoutMs / 1000)}s`).trim() };
  return { host: host.name, ok: code === 0, code, stdout,
    stderr: err };
}

/** Fast reachability probe — a single `ssh … echo ok` that works on every OS
 *  (bare `echo ok` runs in cmd/sh without any shell-detection round-trip, so a
 *  dead Windows host costs ONE timeout, not the two that the full exec path pays
 *  via resolveWinBin). Capped by a wall-clock kill so a hung `.local` mDNS
 *  lookup (which ssh's ConnectTimeout does NOT bound) can't dominate a fan-out.
 *  Override the cap with FLEET_PROBE_TIMEOUT_MS. */
const PROBE_CAP_MS = Number(process.env.FLEET_PROBE_TIMEOUT_MS ?? 4000);
export async function probe(host: Host, capMs = PROBE_CAP_MS): Promise<boolean> {
  if (host.transport === "daytona") return dtProbe(host, capMs);
  const connectTimeout = Math.max(1, Math.ceil(capMs / 1000));
  const proc = Bun.spawn(["ssh", ...controlOpts(), "-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeout}`,
    host.ssh, "echo ok"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const ran = (async () => {
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return code === 0 && out.trim() === "ok";
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => { proc.kill(); resolve(false); }, Math.max(0, capMs));
  });
  try {
    return await Promise.race([ran, capped]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Stream a bash command's output live to the local terminal (inherited stdout/
 *  stderr) — for `fleet jobs tail -f`, where we want a long-lived follow rather
 *  than a buffered round-trip. Linux/mac only; the command is fixed + safe
 *  (our own `tail -n N -f <spool>`), so stdin-piping isn't needed. Ctrl-C kills
 *  the local ssh, which ends the remote tail. */
export function execStream(host: Host, command: string): Promise<number> {
  const proc = Bun.spawn(["ssh", "-tt", ...controlOpts(), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
    host.ssh, "bash", "-lc", `'${bashEsc(command)}'`],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

/** Diagnostic ssh attempt: `ssh -vv … echo` capturing the verbose stderr, for
 *  `fleet doctor`. Returns whether it connected, the timing, and the raw verbose
 *  log to mine for the failure reason. */
export async function sshDiagnose(host: Host, timeoutS = 8): Promise<{ ok: boolean; stderr: string; ms: number }> {
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error("diagnostic timeout must be finite and positive");
  const start = Date.now();
  // Override config-defined masters too: doctor must test a fresh connection.
  const proc = Bun.spawn(["ssh", "-vv", "-o", "ControlMaster=no", "-o", "ControlPath=none",
    "-o", "BatchMode=yes", "-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutS))}`,
    host.ssh, "echo fleet-ok"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
  const read = async (reader: (typeof readers)[number]) => {
    const decoder = new TextDecoder();
    let output = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return output + decoder.decode();
        output += decoder.decode(chunk.value, { stream: true });
      }
    } finally { reader.releaseLock(); }
  };
  let timedOut = false;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
    // Give buffered diagnostics one event-loop turn to drain after the kill,
    // then close pipes that another process may have inherited from SSH.
    cancelTimer = setTimeout(() => {
      for (const reader of readers) void reader.cancel().catch(() => {});
    }, 10);
  }, timeoutS * 1000);
  try {
    const [stdout, stderr, code] = await Promise.all([read(readers[0]!), read(readers[1]!), proc.exited]);
    return {
      ok: !timedOut && code === 0 && stdout.includes("fleet-ok"),
      stderr: timedOut ? `${stderr}\nfleet: SSH diagnosis timed out after ${timeoutS}s`.trim() : stderr,
      ms: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
    if (cancelTimer) clearTimeout(cancelTimer);
  }
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

/** Win32 OpenSSH/SFTP accepts forward-slash remote paths. Native backslashes
 * are consumed or misinterpreted before the server opens the file. */
export function scpRemotePath(host: Host, remote: string): string {
  return host.os === "windows" ? remote.replaceAll("\\", "/") : remote;
}

/** Join N per-source results into one. Used for the daytona fallback, which has
 *  no multi-source primitive and so copies one file per API call. */
function mergeScpResults(host: Host, rs: ExecResult[]): ExecResult {
  const bad = rs.find((r) => !r.ok);
  return {
    host: host.name, ok: !bad, code: bad?.code ?? 0,
    stdout: rs.map((r) => r.stdout).filter(Boolean).join("\n"),
    stderr: rs.map((r) => r.stderr).filter(Boolean).join("\n"),
  };
}

/** scp local file(s)/dir(s) to host:remote. Remote path passed through verbatim
 *  (forward slashes work on Windows OpenSSH; `C:\…` absolute paths work too).
 *  `recursive` (scp -r) copies a directory tree. With more than one source,
 *  `remote` must be an existing directory — scp itself enforces that. */
export async function scp(
  host: Host, local: string | string[], remote: string, recursive = false,
): Promise<ExecResult> {
  const locals = Array.isArray(local) ? local : [local];
  if (!locals.length) throw new Error("scp needs at least one source path");
  if (host.transport === "daytona") {
    if (recursive) return { host: host.name, ok: false, code: 1, stdout: "",
      stderr: "cp -r to a dt: sandbox is not supported yet — tar locally and push the archive" };
    // No multi-source upload in the SDK: push each file into the destination dir.
    if (locals.length === 1) return dtPush(host, locals[0]!, remote);
    return mergeScpResults(host, await Promise.all(
      locals.map((l) => dtPush(host, l, joinRemote(remote, l)))));
  }
  return runScp(host, [...(recursive ? ["-r"] : []), ...locals, `${host.ssh}:${scpRemotePath(host, remote)}`]);
}

/** scp host:remote → local (pull). Mirror of `scp`, for retrieving file(s)/dir(s)
 *  the remote produced (e.g. a screenshot). Remote path passed through verbatim.
 *  With more than one source, `local` must be an existing directory. */
export async function scpPull(
  host: Host, remote: string | string[], local: string, recursive = false,
): Promise<ExecResult> {
  const remotes = Array.isArray(remote) ? remote : [remote];
  if (!remotes.length) throw new Error("scp needs at least one source path");
  if (host.transport === "daytona") {
    if (recursive) return { host: host.name, ok: false, code: 1, stdout: "",
      stderr: "cp -r from a dt: sandbox is not supported yet — tar in the sandbox and pull the archive" };
    if (remotes.length === 1) return dtPull(host, remotes[0]!, local);
    return mergeScpResults(host, await Promise.all(
      remotes.map((r) => dtPull(host, r, joinRemote(local, r)))));
  }
  return runScp(host, [...(recursive ? ["-r"] : []), ...remotes.map((r) => `${host.ssh}:${scpRemotePath(host, r)}`), local]);
}

/** `dir` + the basename of `src` — how scp names each file when the destination
 *  is a directory. Handles both separators so Windows sources land correctly. */
function joinRemote(dir: string, src: string): string {
  const base = src.split(/[\\/]/).filter(Boolean).pop() ?? src;
  return dir.endsWith("/") || dir.endsWith("\\") ? dir + base : `${dir}/${base}`;
}
