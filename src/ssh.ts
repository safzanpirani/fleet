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
import { proxyControlKey, proxyOpts, proxyReachableCached } from "./proxy.ts";
import { resolveProxy } from "./config.ts";
import { dtExec, dtProbe, dtPush, dtPull } from "./daytona.ts";
import { trySessionExec, winSessionEnabled } from "./winsession.ts";
import { homedir, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── SSH connection multiplexing + proxying ───────────────────────────────────
// Reuse one master connection per host instead of re-handshaking on every exec/
// probe/scp/poll. The control socket lives under ~/.fleet/ssh/ (created once);
// `%C` is a short fixed-length hash of (localhost, remotehost, port, user) — note
// that it does NOT cover the ProxyCommand, so we append our own route key. Without
// it a direct master and a proxied master to the same HostName collide and the
// second connection silently rides the first one's route. Disable multiplexing
// with FLEET_NO_SSH_MUX=1 (useful when debugging a wedged socket).
//
// FLEET_SSH_MUX=config defers entirely to ~/.ssh/config instead: we pass no
// Control* options at all, so a long-lived master defined there is reused. This
// matters when a host's direct network path is down but a config master (e.g.
// ControlPersist 30m) is still alive — our own short-lived socket would force a
// fresh connection and fail with "No route to host" where raw ssh succeeds.
// Proxy options are still emitted in that mode: deferring the CONTROL socket is
// not the same as deferring the ROUTE.
// FLEET_SSH_PERSIST overrides just the persist duration (e.g. "30m").
const muxEnabled = () => process.env.FLEET_NO_SSH_MUX !== "1";
const muxFromConfig = () => process.env.FLEET_SSH_MUX === "config";
const muxPersist = () => process.env.FLEET_SSH_PERSIST || "60s";
let _muxDir: string | null = null;

/** Multiplexing options for a host. Empty when mux is off, deferred to ssh
 *  config, or on Windows (Win32 OpenSSH has no unix-socket multiplexing — handing
 *  it ControlMaster/ControlPath makes every ssh fail with
 *  "mux_client_request_session: read from master failed", which `fleet ls` then
 *  reports as a dead host). */
export function muxOpts(host: Host): string[] {
  if (!muxEnabled()) return [];
  if (process.platform === "win32") return [];
  if (muxFromConfig()) return [];   // honour ControlMaster/ControlPath from ~/.ssh/config
  if (_muxDir === null) {
    _muxDir = join(homedir(), ".fleet", "ssh");
    try { mkdirSync(_muxDir, { recursive: true }); } catch { /* best-effort; ssh falls back to no-mux if the socket can't be made */ }
  }
  return ["-o", "ControlMaster=auto", "-o", `ControlPath=${join(_muxDir, `cm-%C-${proxyControlKey(host)}`)}`,
    "-o", `ControlPersist=${muxPersist()}`];
}

/** Every connection option fleet adds to an ssh/scp argv, in one place: the
 *  route first, then the control socket that belongs to that route. */
export function connOpts(host: Host): string[] {
  return [...proxyOpts(host), ...muxOpts(host)];
}

/** A one-shot connection that reuses no master and creates none — for `doctor`,
 *  and as the bounded fallback when a wedged master refuses a session. */
export function freshConnOpts(host: Host): string[] {
  return [...proxyOpts(host), "-o", "ControlMaster=no", "-o", "ControlPath=none"];
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

// ── completion marker ────────────────────────────────────────────────────────
// Two failures share one fix. A remote command that itself runs ssh or scp can
// leave a background process (a ControlPersist master, a detached child)
// holding the session's stdout, so the local ssh never sees end-of-output and
// `exec` hangs although the command finished. And Windows PowerShell reading a
// program from stdin keeps going after a terminating error and exits 0.
//
// Every script now reports its own completion: one line on stderr carrying a
// per-call nonce and the exit status. Seeing it, exec waits a short grace for
// output to drain, then stops waiting. The line is removed from stderr.

/** After fleet stops a call, how long to let already-sent output drain. */
const STOP_DRAIN_MS = 500;

/** Read a stream to a string incrementally; `cancel` abandons it early. */
function drain(stream: ReadableStream<Uint8Array>, onText?: (text: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        onText?.(text);
      }
      text += decoder.decode();
    } catch { /* cancelled */ }
  })();
  return { done, text: () => text, cancel: () => { reader.cancel().catch(() => {}); } };
}

/** Milliseconds to wait for the pipes to close after the completion marker. */
const DONE_GRACE_MS = Math.max(0, Number(process.env.FLEET_DONE_GRACE_MS ?? 1500) || 0);

export function doneMarker(): string {
  return `__FLEET_DONE_${crypto.randomUUID().replaceAll("-", "")}__`;
}

/** Wrap a script so it reports completion on stderr.
 *
 *  bash: an EXIT trap, which also covers `exit N` and `set -e`. A script that
 *  installs its own EXIT trap or `exec`s away simply never reports, and exec
 *  falls back to waiting for end-of-output as before.
 *
 *  PowerShell: output is UTF-8 and uncoloured, and the program runs dot-sourced (same scope as before) inside
 *  try/catch, so a terminating error stops it and exits 1 instead of letting
 *  later statements run. `-Command -` collapses its own exit code to 0/1, so
 *  the marker carries the real one: the last native exit code when the last
 *  statement failed. `exit N` bypasses the catch and cannot be observed; the
 *  marker then says `?` and exec keeps the process's own code. */
export function withDoneMarker(script: string, shell: Shell, marker: string): string {
  // bash -s reads the program from stdin, so a command in it that reads stdin
  // (cua-driver, ssh, ffmpeg) swallowed every line after itself. bash parses
  // the subshell whole before running it, so the body gets an empty stdin and
  // the program stays intact. The subshell also keeps the body's `set -e` out
  // of the login shell: with errexit still on, Ubuntu's ~/.bash_logout fails at
  // `clear_console` and replaced the script's exit code with 1.
  if (shell !== "powershell")
    return `trap 'fleet_rc=$?; printf "\n%s%s\n" "${marker}" "$fleet_rc" 1>&2' EXIT\n(\n${script}\n) </dev/null`;
  // The program travels base64-encoded: pwsh decodes a stdin program in the
  // console's legacy codepage, so any non-ASCII character in it arrived
  // garbled. Run from a scriptblock, its line numbers are also the caller's.
  const source = `${script}\n$__fleetOk = $?; $__fleetLast = $global:LASTEXITCODE`;
  const b64 = Buffer.from(source, "utf8").toString("base64");
  return `try { $PSStyle.OutputRendering = 'PlainText'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$global:LASTEXITCODE = 0
$__fleetCode = $null
try {
  . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))))
  $__fleetCode = if ($__fleetOk) { 0 } elseif ($__fleetLast) { $__fleetLast } else { 1 }
} catch {
  $__fleetCode = 1
  [Console]::Error.WriteLine(($_ | Out-String).TrimEnd())
} finally {
  $__fleetReport = if ($null -eq $__fleetCode) { '?' } else { [string]$__fleetCode }
  [Console]::Error.WriteLine([Environment]::NewLine + '${marker}' + $__fleetReport)
}
exit $__fleetCode`;
}

/** Find and remove the completion marker from stderr. `code` is undefined when
 *  no marker arrived, null when it arrived without an observable status. */
export function takeDoneMarker(stderr: string, marker: string): { stderr: string; code?: number | null } {
  const at = stderr.lastIndexOf(marker);
  if (at < 0) return { stderr };
  const end = stderr.indexOf("\n", at);
  const raw = stderr.slice(at + marker.length, end < 0 ? undefined : end).trim();
  const before = stderr.slice(0, at).replace(/\r?\n$/, "");
  const after = end < 0 ? "" : stderr.slice(end + 1);
  return { stderr: before + after, code: /^-?\d+$/.test(raw) ? Number(raw) : null };
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
    const proc = Bun.spawn(["ssh", ...connOpts(host), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host.ssh,
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
  const ssh = ["ssh", ...connOpts(host), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host.ssh];

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
  const marker = doneMarker();
  const reportShell: Shell = resolved === "powershell" ? "powershell" : "bash";
  // The cwd change goes INSIDE the wrapper, so a missing directory is a
  // reported failure rather than a statement PowerShell steps past.
  const located = opts.cwd ? (reportShell === "powershell" ? withCwdPwsh : withCwdBash)(command, opts.cwd) : command;
  if (resolved === "powershell" && winBin === "pwsh" && winSessionEnabled(host)) {
    const s = await trySessionExec(host, located, remainingMs);
    if (s) {
      const err = stripClixml(s.stderr.trimEnd());
      if (s.timedOut) return { host: host.name, ok: false, code: 124, stdout: s.stdout,
        stderr: (err + `\nfleet: command timed out after ${Math.round(timeoutMs / 1000)}s`).trim() };
      return { host: host.name, ok: s.code === 0, code: s.code, stdout: s.stdout, stderr: err.trim() };
    }
  }
  const { args, stdin } = buildArgs(host, withDoneMarker(located, reportShell, marker), resolved, winBin);

  const proc = Bun.spawn(args, {
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Both streams are read incrementally. An ssh multiplexing client hands its
  // stdio to the control master, so killing the client does not close these
  // pipes: they stay open until the REMOTE command ends. Once fleet stops a
  // call (timeout, or the completion marker's grace), it returns what it has
  // after a short drain instead of waiting for that end-of-output.
  const out = drain(proc.stdout);
  const errStream = drain(proc.stderr, (text) => {
    if (!graceTimer && text.includes(marker))
      graceTimer = setTimeout(() => stop("released"), DONE_GRACE_MS);
  });
  let timedOut = false;
  let released = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let onStop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => { onStop = resolve; });
  function stop(why: "timeout" | "released") {
    if (why === "timeout") timedOut = true; else released = true;
    proc.kill(why === "timeout" ? "SIGKILL" : "SIGTERM");
    setTimeout(onStop, STOP_DRAIN_MS);
  }
  const timer = timeoutMs > 0 ? setTimeout(() => stop("timeout"), remainingMs) : null;
  const finished = await Promise.race([
    Promise.all([out.done, errStream.done, proc.exited]).then(() => true),
    stopped.then(() => false),
  ]);
  if (!finished) { out.cancel(); errStream.cancel(); }
  const exited = finished ? await proc.exited : (proc.exitCode ?? 1);
  const stdout = out.text();
  const rawErr = errStream.text();
  if (timer) clearTimeout(timer);
  if (graceTimer) clearTimeout(graceTimer);
  const done = takeDoneMarker(rawErr, marker);
  const stderr = done.stderr;
  const err = host.os === "windows" ? stripClixml(stderr.trimEnd()) : stderr.trimEnd();
  if (timedOut) return { host: host.name, ok: false, code: 124,
    stdout,
    stderr: (err + `\nfleet: command timed out after ${Math.round(timeoutMs / 1000)}s`).trim() };
  // The marker's status wins when it has one: it survives a session fleet had
  // to stop waiting for, and it carries Windows exit codes above 1.
  const code = typeof done.code === "number" ? done.code
    : released ? 1 : exited;
  const note = released && done.code === null
    ? "\nfleet: stopped waiting after the command finished; its exit status was not observable" : "";
  return { host: host.name, ok: code === 0, code, stdout,
    stderr: (err + note).trim() };
}

/** Fast reachability probe — a single `ssh … echo ok` that works on every OS
 *  (bare `echo ok` runs in cmd/sh without any shell-detection round-trip, so a
 *  dead Windows host costs ONE timeout, not the two that the full exec path pays
 *  via resolveWinBin). Capped by a wall-clock kill so a hung `.local` mDNS
 *  lookup (which ssh's ConnectTimeout does NOT bound) can't dominate a fan-out.
 *  Override the cap with FLEET_PROBE_TIMEOUT_MS. */
const probeCap = () => Number(process.env.FLEET_PROBE_TIMEOUT_MS ?? 4000);
/** Two hops cost more than one: a proxied host gets extra headroom unless the
 *  caller (or FLEET_PROBE_TIMEOUT_MS) pinned the cap explicitly. */
export const PROXY_PROBE_BONUS_MS = 2000;

/** Why a probe said "down". `proxy` means fleet never got as far as the host —
 *  reporting that as a dead box is the lie this exists to prevent. */
export interface ProbeResult { up: boolean; via?: string; down?: "proxy" | "host" }

export async function probeDetail(host: Host, capMs?: number): Promise<ProbeResult> {
  if (host.transport === "daytona") return { up: await dtProbe(host, capMs ?? probeCap()) };
  const proxy = resolveProxy(host);
  let cap = capMs ?? probeCap();
  if (proxy) {
    // Cheap pre-flight, memoized ~30s so a fan-out across a proxied group does
    // not stampede the endpoint with N TCP connects.
    if (!await proxyReachableCached(proxy.spec)) return { up: false, via: proxy.name, down: "proxy" };
    if (capMs === undefined && process.env.FLEET_PROBE_TIMEOUT_MS === undefined) cap += PROXY_PROBE_BONUS_MS;
  }
  const connectTimeout = Math.max(1, Math.ceil(cap / 1000));
  const proc = Bun.spawn(["ssh", ...connOpts(host), "-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeout}`,
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
    timer = setTimeout(() => { proc.kill(); resolve(false); }, Math.max(0, cap));
  });
  try {
    const up = await Promise.race([ran, capped]);
    return { up, via: proxy?.name, down: up ? undefined : "host" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probe(host: Host, capMs?: number): Promise<boolean> {
  return (await probeDetail(host, capMs)).up;
}

/** Stream a bash command's output live to the local terminal (inherited stdout/
 *  stderr) — for `fleet jobs tail -f`, where we want a long-lived follow rather
 *  than a buffered round-trip. Linux/mac only; the command is fixed + safe
 *  (our own `tail -n N -f <spool>`), so stdin-piping isn't needed. Ctrl-C kills
 *  the local ssh, which ends the remote tail. */
export function execStream(host: Host, command: string): Promise<number> {
  const proc = Bun.spawn(["ssh", "-tt", ...connOpts(host), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
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
  const proc = Bun.spawn(["ssh", "-vv", ...freshConnOpts(host),
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
  const proc = Bun.spawn(["ssh", "-tt", ...connOpts(host), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
    host.ssh, "powershell", "-NoProfile", "-NonInteractive", "-Command", psCommand],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

/** Interactive ssh with inherited stdio (for `fleet ssh <host>`). */
export function sshInteractive(host: Host): Promise<number> {
  const proc = Bun.spawn(["ssh", ...connOpts(host), host.ssh], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  return proc.exited;
}

export interface TransferOptions {
  /** Copy with rsync --partial so a rerun continues an interrupted file and skips finished ones. */
  resume?: boolean;
  /** Let the copier draw its progress meter on this terminal. */
  progress?: boolean;
}

async function runCopier(host: Host, argv: string[], progress?: boolean): Promise<ExecResult> {
  // scp and rsync draw their meters on stdout, and only when it is a terminal.
  const proc = Bun.spawn(argv, { stdout: progress ? "inherit" : "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : "",
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { host: host.name, ok: code === 0, code, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
}

function runScp(host: Host, argv: string[], progress?: boolean): Promise<ExecResult> {
  return runCopier(host,
    ["scp", ...connOpts(host), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ...argv], progress);
}

let rsyncFlavor: "gnu" | "openrsync" | undefined;
/** GNU rsync takes `-s` and ships paths inside its protocol; macOS openrsync has
 *  no `-s`, so the remote login shell parses them and they need quoting. */
function localRsyncFlavor(): "gnu" | "openrsync" {
  if (!rsyncFlavor) {
    const r = Bun.spawnSync(["rsync", "--version"], { stdout: "pipe", stderr: "pipe" });
    rsyncFlavor = /openrsync/i.test(r.stdout.toString() + r.stderr.toString()) ? "openrsync" : "gnu";
  }
  return rsyncFlavor;
}

/** A remote rsync path. The server starts in the home directory, so a leading
 *  `~/` becomes a relative path instead of relying on tilde expansion. */
export function rsyncRemotePath(path: string, flavor: "gnu" | "openrsync"): string {
  const rel = path === "~" ? "." : path.startsWith("~/") ? path.slice(2) || "." : path;
  return flavor === "gnu" ? rel : `'${rel.replaceAll("'", `'\\''`)}'`;
}

/** rsync over fleet's ssh options. `--partial` keeps an interrupted file, and the
 *  next run uses it as the delta basis; `-t` lets a rerun skip finished files.
 *  The ssh options go through a throwaway wrapper script, because rsync's `-e`
 *  splitting cannot carry a quoted ProxyCommand. */
async function runRsync(host: Host, argv: string[], recursive: boolean, progress?: boolean): Promise<ExecResult> {
  if (host.transport === "daytona" || host.os === "windows")
    return { host: host.name, ok: false, code: 2, stdout: "",
      stderr: `--resume needs rsync on both ends; ${host.name} is ${host.transport === "daytona" ? "a sandbox" : "Windows"}. Copy without --resume.` };
  const dir = mkdtempSync(join(tmpdir(), "fleet-rsync-"));
  const wrapper = join(dir, "ssh");
  const quote = (a: string) => `'${a.replaceAll("'", `'\\''`)}'`;
  writeFileSync(wrapper, `#!/bin/sh\nexec ssh ${[...connOpts(host), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"].map(quote).join(" ")} "$@"\n`, { mode: 0o700 });
  try {
    return await runCopier(host, ["rsync", "-t", "--partial", ...(recursive ? ["-r"] : []),
      ...(localRsyncFlavor() === "gnu" ? ["-s"] : []),
      ...(progress ? ["--progress"] : []), "-e", wrapper, ...argv], progress);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  host: Host, local: string | string[], remote: string, recursive = false, opts: TransferOptions = {},
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
  if (opts.resume) return runRsync(host, [...locals, `${host.ssh}:${rsyncRemotePath(remote, localRsyncFlavor())}`], recursive, opts.progress);
  return runScp(host, [...(recursive ? ["-r"] : []), ...locals, `${host.ssh}:${scpRemotePath(host, remote)}`], opts.progress);
}

/** scp host:remote → local (pull). Mirror of `scp`, for retrieving file(s)/dir(s)
 *  the remote produced (e.g. a screenshot). Remote path passed through verbatim.
 *  With more than one source, `local` must be an existing directory. */
export async function scpPull(
  host: Host, remote: string | string[], local: string, recursive = false, opts: TransferOptions = {},
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
  if (opts.resume) return runRsync(host, [...remotes.map((r) => `${host.ssh}:${rsyncRemotePath(r, localRsyncFlavor())}`), local], recursive, opts.progress);
  return runScp(host, [...(recursive ? ["-r"] : []), ...remotes.map((r) => `${host.ssh}:${scpRemotePath(host, r)}`), local], opts.progress);
}

/** `dir` + the basename of `src` — how scp names each file when the destination
 *  is a directory. Handles both separators so Windows sources land correctly. */
function joinRemote(dir: string, src: string): string {
  const base = src.split(/[\\/]/).filter(Boolean).pop() ?? src;
  return dir.endsWith("/") || dir.endsWith("\\") ? dir + base : `${dir}/${base}`;
}
