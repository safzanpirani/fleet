/**
 * jobs — detached background jobs that outlive the SSH session.
 *
 * The controller stays STATELESS (just like the rest of fleet): the only state
 * lives ON the remote host, under a per-host spool dir, and every `jobs` command
 * is a thin read/write over the existing quoting-proof `exec` primitive.
 *
 *   spool layout:  <home>/.fleet/jobs/<id>/
 *     cmd      — the command, verbatim (base64-decoded on the way in)
 *     cwd      — resolved working directory
 *     started  — epoch seconds at launch
 *     pid      — pid of the detached session/process leader
 *     out      — combined stdout+stderr
 *     exit     — exit code (written only on completion → its presence = "done")
 *     run      — the generated runner script (cd → run → record exit)
 *
 * Linux launches via `setsid`; macOS uses `nohup` because `setsid` is not a
 * system utility there. Windows jobs need an *interactive* token so they can see
 * the GPU/OpenCL (session-0 non-interactive tasks cannot). We get one by
 * registering a Scheduled Task with an Interactive logon principal, starting it
 * on demand, then unregistering the definition once the runner records its pid.
 * Requires a user to be logged on at the console.
 */
import { resolveHosts } from "./config.ts";
import type { FleetConfig, Host } from "./config.ts";
import { exec, execStream, execStreamWin } from "./ssh.ts";
import type { ExecResult, Shell } from "./ssh.ts";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const shellFor = (h: Host): Shell => (h.os === "windows" ? "powershell" : "bash");

/** Job ids are time-sortable + collision-resistant, and intentionally limited to
 *  [a-z0-9-] so they're safe to interpolate into remote paths without quoting. */
const ID_RE = /^[a-z0-9-]+$/;
export function newId(label?: string): string {
  const rand = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  if (!label) return rand;
  // sanitise the label to the id charset so it stays path/quote-safe, then prefix
  const slug = label.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return slug ? `${slug}-${rand}` : rand;
}
function assertId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`bad job id: ${id}`);
}
/** Clamp a caller-supplied line count to a sane positive integer before it is
 *  interpolated into a remote command (`tail -n NaN` must never happen). */
function lineCount(n: number, fallback = 40): number {
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

// A pid is not proof of ownership: operating systems reuse them. Every
// destructive or "running" check also verifies that the process command line
// names this exact job's generated runner.
const UNIX_OWNED_FN = `
is_owned() {
  owned_pid="$1"
  owned_runner="$2"
  [ -n "$owned_pid" ] || return 1
  if [ "$(uname -s)" = "Darwin" ]; then
    ps -p "$owned_pid" -o command= 2>/dev/null | grep -F -- "$owned_runner" >/dev/null
  else
    [ -r "/proc/$owned_pid/cmdline" ] &&
      tr '\\0' '\\n' < "/proc/$owned_pid/cmdline" 2>/dev/null | grep -Fqx -- "$owned_runner"
  fi
}
`;

const WIN_OWNED_FN = `
function Test-FleetJobProcess([int]$ProcessId, [string]$Runner) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -EA SilentlyContinue
  return ($null -ne $proc -and $proc.CommandLine -and $proc.CommandLine.Contains($Runner))
}
`;

export interface JobRow {
  host: string;
  id: string;
  status: "running" | "exited" | "dead";
  code: number | null;        // exit code when status === "exited"
  pid: number | null;
  started: number | null;     // epoch seconds
  cmd: string;                // truncated for display
}
export interface SpawnResult {
  host: string;
  ok: boolean;
  id: string | null;
  pid: number | null;
  error?: string;
}

// ── address parsing ───────────────────────────────────────────────────────────
/** Accept either `host id`, or a collapsed `host:id` in the host slot. Returns a
 *  single resolved Host + the id. Single-host only — addressed verbs (log/tail/
 *  kill/wait) act on exactly one job. */
export function resolveJobRef(cfg: FleetConfig, a: string, b?: string): { host: Host; id: string } {
  let hostSel = a, id = b;
  if (!id && a.includes(":")) { const i = a.lastIndexOf(":"); hostSel = a.slice(0, i); id = a.slice(i + 1); }
  if (!id) throw new Error("usage: <host> <id>  (or  <host:id>)");
  assertId(id);
  const hosts = resolveHosts(cfg, hostSel);
  if (hosts.length !== 1) throw new Error(`'${hostSel}' must resolve to exactly one host (got ${hosts.length})`);
  return { host: hosts[0]!, id };
}

// ── spawn ─────────────────────────────────────────────────────────────────────
export function unixSpawnScript(host: Host, id: string, cmd: string, cwd?: string): string {
  // The runner is materialised on the host via a QUOTED heredoc (zero expansion,
  // so a cwd containing quotes/$ can't break it) and derives its own spool dir
  // from its path — the detached process needs no controller state.
  const cwdSrc = cwd ? `cwd="$(printf '%s' '${b64(cwd)}' | base64 -d)"` : `cwd=""`;
  const launch = host.os === "mac"
    ? `nohup "$dir/run" < /dev/null > /dev/null 2>&1 &`
    : `setsid "$dir/run" < /dev/null > /dev/null 2>&1 &`;
  return [
    `set -e`,
    `id='${id}'`,
    `base="$HOME/.fleet/jobs"`,
    `dir="$base/$id"`,
    `mkdir -p "$base"`,
    `mkdir "$dir"`,
    `printf '%s' '${b64(cmd)}' | base64 -d > "$dir/cmd"`,
    cwdSrc,
    `cwd="\${cwd:-$HOME}"`,
    `printf '%s' "$cwd" > "$dir/cwd"`,
    `date +%s > "$dir/started"`,
    `cat > "$dir/run" <<'RUNEOF'`,
    `#!/bin/bash`,
    `dir="$(cd "$(dirname "$0")" && pwd)"`,
    `echo $$ > "$dir/pid"`,
    `cwd="$(cat "$dir/cwd")"`,
    `cd -- "$cwd" || { echo "fleet: cwd not found: $cwd" 1>&2; echo 127 > "$dir/exit"; exit 127; }`,
    `bash "$dir/cmd" > "$dir/out" 2>&1`,
    `echo $? > "$dir/exit"`,
    `RUNEOF`,
    `chmod +x "$dir/run"`,
    launch,
    `i=0; while [ "$i" -lt 100 ] && [ ! -s "$dir/pid" ]; do sleep 0.05; i=$((i+1)); done`,
    `pid="$(cat "$dir/pid" 2>/dev/null)"`,
    `[ -n "$pid" ] || { echo "ERR runner did not record a pid" 1>&2; exit 1; }`,
    `printf 'OK %s %s\\n' "$id" "$pid"`,
  ].join("\n");
}

// Static runner for Windows jobs: derives its own spool dir from its own path, so
// nothing needs interpolation. Records its pid, cd's to the saved cwd, runs the
// user command capturing combined output, then writes its exit code (presence of
// the `exit` file == "done"). Base64'd into the spawn script below.
const WIN_RUNNER = [
  `$ErrorActionPreference='Continue'`,
  `$dir = Split-Path -Parent $MyInvocation.MyCommand.Path`,
  `$PID | Set-Content -Encoding ascii "$dir\\pid"`,
  `$cwd = (Get-Content "$dir\\cwd" -Raw).Trim()`,
  `try { Set-Location -LiteralPath $cwd -ErrorAction Stop } catch { "fleet: cwd not found: $cwd" | Set-Content "$dir\\out"; '127' | Set-Content -Encoding ascii "$dir\\exit"; exit }`,
  `$global:LASTEXITCODE = 0`,
  `try { & "$dir\\cmd.ps1" *> "$dir\\out" 2>&1; $code = $LASTEXITCODE } catch { $_ | Out-File -Append "$dir\\out"; $code = 1 }`,
  `if ($null -eq $code) { $code = 0 }`,
  `$code | Set-Content -Encoding ascii "$dir\\exit"`,
].join("\n");

function windowsSpawnScript(id: string, cmd: string, cwd?: string): string {
  // Register an Interactive-logon task → start it → wait for the runner to record
  // its pid → unregister the task definition (the running instance is unaffected).
  return [
    `$ErrorActionPreference='Stop'`,
    `$id='${id}'`,
    `$base="$env:USERPROFILE\\.fleet\\jobs"`,
    `$dir="$base\\$id"`,
    `New-Item -ItemType Directory -Force -Path $base | Out-Null`,
    `if (Test-Path $dir) { throw "fleet: job id collision: $id" }`,
    `New-Item -ItemType Directory -Path $dir | Out-Null`,
    `[IO.File]::WriteAllText("$dir\\cmd.ps1", [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(cmd)}')))`,
    `$cwd = '${cwd ? b64(cwd) : ""}'`,
    `$cwd = if ($cwd) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($cwd)) } else { $env:USERPROFILE }`,
    `[IO.File]::WriteAllText("$dir\\cwd", $cwd)`,
    `[IO.File]::WriteAllText("$dir\\started", [string][long]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()))`,
    `[IO.File]::WriteAllText("$dir\\run.ps1", [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(WIN_RUNNER)}')))`,
    `$task="fleet_$id"`,
    `$psexe = (Get-Process -Id $PID).Path`,
    `$arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + "$dir\\run.ps1" + '"'`,
    `$action = New-ScheduledTaskAction -Execute $psexe -Argument $arg`,
    `$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited`,
    `Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Force | Out-Null`,
    `Start-ScheduledTask -TaskName $task`,
    `for ($i=0; $i -lt 100; $i++) { if (Test-Path "$dir\\pid") { break }; Start-Sleep -Milliseconds 50 }`,
    `Start-Sleep -Milliseconds 100`,
    `$jpid = (Get-Content "$dir\\pid" -EA SilentlyContinue | Select-Object -First 1)`,
    `Unregister-ScheduledTask -TaskName $task -Confirm:$false -EA SilentlyContinue`,
    `if ($jpid) { "OK $id $jpid" } else { "ERR no pid (task did not launch — is a user logged on at the console?)" }`,
  ].join("\n");
}

/** Launch a detached job on each host the selector resolves to. */
export async function spawnJob(
  cfg: FleetConfig, sel: string, cmd: string, opts: { cwd?: string; label?: string } = {},
): Promise<SpawnResult[]> {
  const hosts = resolveHosts(cfg, sel);
  return Promise.all(hosts.map(async (h): Promise<SpawnResult> => {
    const id = newId(opts.label);
    const script = h.os === "windows"
      ? windowsSpawnScript(id, cmd, opts.cwd)
      : unixSpawnScript(h, id, cmd, opts.cwd);
    const r = await exec(h, script, shellFor(h));
    const m = r.stdout.match(/OK\s+(\S+)\s+(\d+)/);
    if (!r.ok || !m) return { host: h.name, ok: false, id: null, pid: null, error: r.stderr || r.stdout || "spawn failed" };
    return { host: h.name, ok: true, id: m[1]!, pid: Number(m[2]) };
  }));
}

// ── list ──────────────────────────────────────────────────────────────────────
const LINUX_LIST = `
${UNIX_OWNED_FN}
base="$HOME/.fleet/jobs"
[ -d "$base" ] || exit 0
for d in "$base"/*/; do
  [ -d "$d" ] || continue
  id="$(basename "$d")"
  pid="$(cat "$d/pid" 2>/dev/null)"
  started="$(cat "$d/started" 2>/dev/null)"
  if [ -f "$d/exit" ]; then st="exited"; code="$(cat "$d/exit" 2>/dev/null)"
  elif is_owned "$pid" "$d/run"; then st="running"; code="-"
  else st="dead"; code="-"; fi
  cmd="$(tr '\\n\\t' '  ' < "$d/cmd" 2>/dev/null | cut -c1-160)"
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$id" "$st" "\${code:--}" "\${pid:--}" "\${started:--}" "$cmd"
done
`;

const WIN_LIST = `
${WIN_OWNED_FN}
$base="$env:USERPROFILE\\.fleet\\jobs"
if (!(Test-Path $base)) { return }
foreach ($d in (Get-ChildItem -Directory $base -EA SilentlyContinue)) {
  $p=$d.FullName; $id=$d.Name
  $jpid=(Get-Content "$p\\pid" -EA SilentlyContinue | Select-Object -First 1)
  $started=(Get-Content "$p\\started" -EA SilentlyContinue | Select-Object -First 1)
  if (Test-Path "$p\\exit") { $st="exited"; $code=(Get-Content "$p\\exit" -EA SilentlyContinue | Select-Object -First 1) }
  elseif ($jpid -and (Test-FleetJobProcess ([int]$jpid) "$p\\run.ps1")) { $st="running"; $code="-" }
  else { $st="dead"; $code="-" }
  $cmd=(Get-Content "$p\\cmd.ps1" -Raw -EA SilentlyContinue)
  if ($null -eq $cmd) { $cmd="" }
  $cmd=($cmd -replace '[\\r\\n\\t]',' ')
  if ($cmd.Length -gt 160) { $cmd=$cmd.Substring(0,160) }
  $c = if ($code) { $code } else { '-' }
  $pp = if ($jpid) { $jpid } else { '-' }
  $ss = if ($started) { $started } else { '-' }
  ("{0}\`t{1}\`t{2}\`t{3}\`t{4}\`t{5}" -f $id,$st,$c,$pp,$ss,$cmd)
}
`;

const STATUSES = new Set<JobRow["status"]>(["running", "exited", "dead"]);
export function parseRows(host: string, stdout: string): JobRow[] {
  return stdout.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean).map((line) => {
    const [id, st, code, pid, started, ...rest] = line.split("\t");
    const num = (v: string | undefined) => {
      if (!v || v === "-") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      host, id: id ?? "?",
      status: STATUSES.has(st as JobRow["status"]) ? (st as JobRow["status"]) : "dead",
      code: num(code),
      pid: num(pid),
      started: num(started),
      cmd: rest.join("\t"),
    };
  });
}

/** List jobs across every host the selector resolves to (default: all). A host
 *  whose list script fails is reported via `onError` — never silently rendered
 *  as "no jobs". */
export async function listJobs(
  cfg: FleetConfig, sel = "all", onError?: (host: string, error: string) => void,
): Promise<JobRow[]> {
  const hosts = resolveHosts(cfg, sel);
  const out = await Promise.all(hosts.map(async (h) => {
    const r = await exec(h, h.os === "windows" ? WIN_LIST : LINUX_LIST, shellFor(h));
    if (!r.ok) { onError?.(h.name, r.stderr || `exit ${r.code}`); return []; }
    return parseRows(h.name, r.stdout);
  }));
  return out.flat();
}

// ── log / tail ────────────────────────────────────────────────────────────────
export async function jobLog(cfg: FleetConfig, a: string, b?: string): Promise<{ host: string; output: string }> {
  const { host, id } = resolveJobRef(cfg, a, b);
  const script = host.os === "windows"
    ? `$d="$env:USERPROFILE\\.fleet\\jobs\\${id}"
if (!(Test-Path -LiteralPath $d -PathType Container)) { Write-Error "fleet: no such job: ${id}"; exit 1 }
$o=Join-Path $d 'out'
if (Test-Path -LiteralPath $o -PathType Leaf) { Get-Content -LiteralPath $o -Raw }`
    : `d="$HOME/.fleet/jobs/${id}"
[ -d "$d" ] || { echo "fleet: no such job: ${id}" 1>&2; exit 1; }
if [ -f "$d/out" ]; then cat "$d/out"; fi`;
  const r = await exec(host, script, shellFor(host));
  if (!r.ok) throw new Error(r.stderr || r.stdout || `failed to read job ${id} output (exit ${r.code})`);
  return { host: host.name, output: r.stdout };
}

export async function jobTail(cfg: FleetConfig, a: string, b: string | undefined, n: number): Promise<{ host: string; output: string }> {
  const { host, id } = resolveJobRef(cfg, a, b);
  const lines = lineCount(n);
  const script = host.os === "windows"
    ? `$d="$env:USERPROFILE\\.fleet\\jobs\\${id}"
if (!(Test-Path -LiteralPath $d -PathType Container)) { Write-Error "fleet: no such job: ${id}"; exit 1 }
$o=Join-Path $d 'out'
if (Test-Path -LiteralPath $o -PathType Leaf) { Get-Content -LiteralPath $o -Tail ${lines} }`
    : `d="$HOME/.fleet/jobs/${id}"
[ -d "$d" ] || { echo "fleet: no such job: ${id}" 1>&2; exit 1; }
if [ -f "$d/out" ]; then tail -n ${lines} "$d/out"; fi`;
  const r = await exec(host, script, shellFor(host));
  if (!r.ok) throw new Error(r.stderr || r.stdout || `failed to tail job ${id} output (exit ${r.code})`);
  return { host: host.name, output: r.stdout };
}

/** Live follow (`tail -f`) — streams to the local terminal until ctrl-c or the
 *  job's spool is removed. Returns the ssh exit code. */
export function jobFollow(cfg: FleetConfig, a: string, b: string | undefined, n: number): Promise<number> {
  const { host, id } = resolveJobRef(cfg, a, b);
  const lines = lineCount(n);
  return host.os === "windows"
    ? execStreamWin(host, `Get-Content "$env:USERPROFILE\\.fleet\\jobs\\${id}\\out" -Tail ${lines} -Wait`)
    : execStream(host, `tail -n ${lines} -f "$HOME/.fleet/jobs/${id}/out"`);
}

// ── kill ──────────────────────────────────────────────────────────────────────
export function killScript(host: Host, id: string): string {
  assertId(id);
  if (host.os === "windows") {
    return WIN_OWNED_FN +
      `$d="$env:USERPROFILE\\.fleet\\jobs\\${id}"\n` +
      `if (Test-Path "$d\\exit") { Write-Error "fleet: job ${id} already exited"; exit 1 }\n` +
      `$jpid=(Get-Content "$d\\pid" -EA SilentlyContinue | Select-Object -First 1)\n` +
      `if (-not $jpid) { Write-Error "fleet: no such job: ${id}"; exit 1 }\n` +
      `if (-not (Test-FleetJobProcess ([int]$jpid) "$d\\run.ps1")) { Write-Error "fleet: refusing to kill pid $($jpid): it is not job ${id}"; exit 1 }\n` +
      `taskkill /PID $jpid /T /F 2>&1 | Out-Null\n` +
      `for ($i=0; $i -lt 40; $i++) { if (-not (Test-FleetJobProcess ([int]$jpid) "$d\\run.ps1")) { break }; Start-Sleep -Milliseconds 250 }\n` +
      `if (Test-FleetJobProcess ([int]$jpid) "$d\\run.ps1") { Write-Error "fleet: pid $jpid survived taskkill /F — not marking exited"; exit 1 }\n` +
      `if (!(Test-Path "$d\\exit")) { '137' | Set-Content -Encoding ascii "$d\\exit" }\n` +
      `"killed $jpid"`;
  }

  const signal = host.os === "mac"
    ? `kill_tree() {\n` +
      `  tree_signal="$1"; tree_pid="$2"\n` +
      `  for child in $(pgrep -P "$tree_pid" 2>/dev/null); do kill_tree "$tree_signal" "$child"; done\n` +
      `  kill "-$tree_signal" "$tree_pid" 2>/dev/null || true\n` +
      `}\n` +
      `kill_tree TERM "$pid"`
    : `kill -TERM -"$pid" 2>/dev/null || true\nkill -TERM "$pid" 2>/dev/null || true`;
  const force = host.os === "mac"
    ? `kill_tree KILL "$pid"`
    : `kill -KILL -"$pid" 2>/dev/null || true\n  kill -KILL "$pid" 2>/dev/null || true`;

  return UNIX_OWNED_FN +
    `d="$HOME/.fleet/jobs/${id}"\n` +
    `[ ! -f "$d/exit" ] || { echo "fleet: job ${id} already exited" 1>&2; exit 1; }\n` +
    `pid="$(cat "$d/pid" 2>/dev/null)"\n` +
    `[ -n "$pid" ] || { echo "fleet: no such job: ${id}" 1>&2; exit 1; }\n` +
    `is_owned "$pid" "$d/run" || { echo "fleet: refusing to kill pid $pid: it is not job ${id}" 1>&2; exit 1; }\n` +
    `${signal}\n` +
    `code=143\n` +
    `i=0; while [ "$i" -lt 20 ] && is_owned "$pid" "$d/run"; do sleep 0.25; i=$((i+1)); done\n` +
    `if is_owned "$pid" "$d/run"; then\n` +
    `  ${force}\n` +
    `  code=137\n` +
    `  i=0; while [ "$i" -lt 8 ] && is_owned "$pid" "$d/run"; do sleep 0.25; i=$((i+1)); done\n` +
    `fi\n` +
    `if is_owned "$pid" "$d/run"; then echo "fleet: pid $pid survived SIGKILL — not marking exited" 1>&2; exit 1; fi\n` +
    `[ -f "$d/exit" ] || echo "$code" > "$d/exit"\n` +
    `echo "killed $pid"`;
}

export async function killJob(cfg: FleetConfig, a: string, b?: string): Promise<ExecResult> {
  const { host, id } = resolveJobRef(cfg, a, b);
  return exec(host, killScript(host, id), shellFor(host));
}

// ── wait --until ──────────────────────────────────────────────────────────────
export interface WaitOpts {
  until?: string;        // regex; resolve as soon as `out` matches
  timeoutMs?: number;
  intervalMs?: number;
  onTick?: (state: string, elapsedMs: number) => void;
}
export interface JobWaitResult {
  host: string; id: string;
  outcome: "exited" | "matched" | "timeout";
  code: number | null;
  elapsedMs: number;
}

export function waitPoll(host: Host, id: string, until?: string): string {
  if (host.os === "windows") {
    const untilSrc = until
      ? `$rx=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(until)}')); try { if (Test-Path "$dir\\out") { if (Select-String -Path "$dir\\out" -Pattern $rx -EA Stop) { 'MATCH' } } } catch { Write-Error "fleet: invalid --until regex: $($_.Exception.Message)"; exit 2 }`
      : "";
    return [
      `$dir="$env:USERPROFILE\\.fleet\\jobs\\${id}"`,
      `if (!(Test-Path $dir)) { 'MISSING'; exit 0 }`,
      `if (Test-Path "$dir\\exit") { 'EXIT:' + (Get-Content "$dir\\exit" -Raw).Trim() }`,
      untilSrc,
    ].join("\n");
  }
  const untilSrc = until
    ? `rx="$(printf '%s' '${b64(until)}' | base64 -d)"; if [ -f "$dir/out" ]; then grep -qE "$rx" "$dir/out"; grep_code=$?; [ "$grep_code" -eq 0 ] && echo MATCH; [ "$grep_code" -le 1 ] || { echo "fleet: invalid --until regex" 1>&2; exit 2; }; fi`
    : "";
  return `dir="$HOME/.fleet/jobs/${id}"\n` +
    `[ -d "$dir" ] || { echo MISSING; exit 0; }\n` +
    `[ -f "$dir/exit" ] && echo "EXIT:$(cat "$dir/exit")"\n` +
    untilSrc;
}

/** Block until the job exits, or (with --until) its output matches a regex, or
 *  the timeout elapses. Polls the spool via repeated exec — same model as
 *  `fleet wait`. */
export async function waitJob(cfg: FleetConfig, a: string, b: string | undefined, opts: WaitOpts = {}): Promise<JobWaitResult> {
  const { host, id } = resolveJobRef(cfg, a, b);
  const timeoutMs = opts.timeoutMs ?? 0;       // 0 = wait forever
  const intervalMs = opts.intervalMs ?? 3000;
  const poll = waitPoll(host, id, opts.until);
  const start = Date.now();
  for (;;) {
    const beforePoll = Date.now() - start;
    if (timeoutMs && beforePoll >= timeoutMs)
      return { host: host.name, id, outcome: "timeout", code: null, elapsedMs: beforePoll };
    const remaining = timeoutMs ? Math.max(1, timeoutMs - beforePoll) : undefined;
    const r = await exec(host, poll, shellFor(host), { timeoutMs: remaining });
    const elapsed = Date.now() - start;
    if (!r.ok) {
      if (r.code === 124 && timeoutMs)
        return { host: host.name, id, outcome: "timeout", code: null, elapsedMs: elapsed };
      throw new Error(r.stderr || `failed to inspect job ${id} (exit ${r.code})`);
    }
    if (/^MISSING$/m.test(r.stdout)) throw new Error(`no such job: ${id}`);
    const exit = r.stdout.match(/EXIT:(-?\d+)/);
    if (opts.until && /^MATCH$/m.test(r.stdout))
      return { host: host.name, id, outcome: "matched", code: exit ? Number(exit[1]) : null, elapsedMs: elapsed };
    if (exit)
      return { host: host.name, id, outcome: "exited", code: Number(exit[1]), elapsedMs: elapsed };
    if (timeoutMs && elapsed >= timeoutMs)
      return { host: host.name, id, outcome: "timeout", code: null, elapsedMs: elapsed };
    opts.onTick?.(opts.until ? "waiting for match/exit" : "running", elapsed);
    const sleepMs = timeoutMs ? Math.min(intervalMs, Math.max(0, timeoutMs - elapsed)) : intervalMs;
    if (sleepMs > 0) await Bun.sleep(sleepMs);
  }
}

// ── prune ─────────────────────────────────────────────────────────────────────
function pruneScript(host: Host, all: boolean): string {
  if (host.os === "windows") {
    return `
${WIN_OWNED_FN}
$base="$env:USERPROFILE\\.fleet\\jobs"
if (!(Test-Path $base)) { '0'; exit 0 }
$n=0
foreach ($d in (Get-ChildItem -Directory $base -EA SilentlyContinue)) {
  $p=$d.FullName
  $jpid=(Get-Content "$p\\pid" -EA SilentlyContinue | Select-Object -First 1)
  if (Test-Path "$p\\exit") { }
  elseif ($jpid -and (Test-FleetJobProcess ([int]$jpid) "$p\\run.ps1")) { continue }
  elseif ('${all ? "1" : "0"}' -ne '1') { continue }
  Remove-Item -Recurse -Force $p -EA SilentlyContinue; $n++
}
"$n"`;
  }
  return `
${UNIX_OWNED_FN}
base="$HOME/.fleet/jobs"
[ -d "$base" ] || { echo 0; exit 0; }
n=0
for d in "$base"/*/; do
  [ -d "$d" ] || continue
  pid="$(cat "$d/pid" 2>/dev/null)"
  if [ -f "$d/exit" ]; then :
  elif is_owned "$pid" "$d/run"; then continue                       # running — never prune
  elif [ "${all ? "1" : "0"}" != "1" ]; then continue               # dead, but not --all
  fi
  rm -rf "$d" && n=$((n+1))
done
echo "$n"`;
}

/** Remove finished job spools. By default only `exited` jobs; `--all` also drops
 *  `dead` ones. Never touches a still-running job. Returns count removed, plus
 *  the error when a host's prune failed (instead of a silent 0). */
export async function pruneJobs(
  cfg: FleetConfig, sel = "all", all = false,
): Promise<{ host: string; removed: number; error?: string }[]> {
  const hosts = resolveHosts(cfg, sel);
  return Promise.all(hosts.map(async (h) => {
    const r = await exec(h, pruneScript(h, all), shellFor(h));
    if (!r.ok) return { host: h.name, removed: 0, error: r.stderr || `exit ${r.code}` };
    return { host: h.name, removed: Number(r.stdout.trim()) || 0 };
  }));
}
