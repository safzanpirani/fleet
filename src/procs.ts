/**
 * procs — one process list and one kill across Linux, macOS, and Windows.
 *
 * Hand-rolled kills go wrong in the same few ways: `pkill -f` matches its own
 * command line and takes the ssh session with it, PowerShell eats the quoting,
 * and a name that matches three processes kills all three. `processKill`
 * resolves a spec to exact pids first, refuses anything ambiguous, never
 * touches the session fleet is running in or the host's core processes, asks
 * politely before forcing, re-checks each pid's name before signalling it (a
 * pid can be reused), and reports what actually exited.
 *
 * Like core.ts, nothing here prints; functions return data and throw.
 */
import { resolveHosts } from "./config.ts";
import type { FleetConfig, Host } from "./config.ts";
import { exec } from "./ssh.ts";
import type { ExecResult } from "./ssh.ts";

export interface ProcRow {
  host: string;
  pid: number;
  ppid: number;
  name: string;
  /** null where the OS will not say without elevation (Windows owners). */
  user: string | null;
  /** Percent of one core. POSIX: ps's figure; Windows: sampled over 0.5 s. */
  cpu: number | null;
  mem_mb: number;
  /** Seconds since the process started. */
  age_s: number | null;
  cmd: string;
  /** Windows session id: 0 is the service session, where no window shows. */
  session?: number;
  /** The fleet job whose runner started this process (or one of its parents). */
  job?: string;
  /** Why kill refuses this process, when it does. */
  protected?: string;
}

export interface ProcList { host: string; ok: boolean; error?: string; rows: ProcRow[] }

const SENT = "__FLEET_PS__";

// Names kill refuses unless the caller passes `system`. The session chain
// (the shell fleet runs in and its sshd) and pid 0/1/4 are refused regardless.
const SYSTEM_NAMES: Record<Host["os"], string[]> = {
  linux: ["systemd", "init", "sshd", "kthreadd", "dbus-daemon", "systemd-journald", "systemd-logind", "tailscaled"],
  mac: ["launchd", "kernel_task", "WindowServer", "loginwindow", "sshd", "tailscaled"],
  windows: ["system", "idle", "registry", "smss", "csrss", "wininit", "winlogon", "services", "lsass", "svchost",
    "sshd", "dwm", "fontdrvhost", "memory compression", "explorer", "tailscaled", "tailscale-ipn"],
};

// The shell running this script and every ancestor up to sshd. \$\$ inside
// fleet's ( … ) wrapper is the parent shell, so start from BASHPID where bash has it.
const POSIX_CHAIN = `p="\${BASHPID:-$$}"; chain=""; `
  + `while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do chain="$chain $p"; p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"; done`;
const WIN_CHAIN = `$cp = $PID; $chain = @(); while ($cp -and ($chain -notcontains [int]$cp)) { $chain += [int]$cp; $cp = (Get-CimInstance Win32_Process -Filter "ProcessId=$cp" -EA SilentlyContinue).ParentProcessId }`;

function posixListScript(): string {
  return [
    POSIX_CHAIN,
    `echo "${SENT}chain|$chain"`,
    // Only running jobs: a finished job's pid may belong to someone else by now.
    `for f in "$HOME"/.fleet/jobs/*/pid; do d="$(dirname "$f")"; [ -f "$f" ] && [ ! -e "$d/exit" ] && echo "${SENT}job|$(basename "$d")|$(cat "$f")"; done`,
    `echo "${SENT}ps"`,
    `ps -axww -o pid=,ppid=,pcpu=,rss=,etime=,user=,comm=`,
    `echo "${SENT}args"`,
    `ps -axww -o pid=,args=`,
    `echo "${SENT}end"`,
  ].join("\n");
}

function windowsListScript(): string {
  return [
    `$all = @(Get-CimInstance Win32_Process)`,
    `$by = @{}; foreach ($x in $all) { $by[[int]$x.ProcessId] = $x }`,
    `$chain = @(); $p = $PID`,
    `while ($p -and $by.ContainsKey([int]$p) -and ($chain -notcontains [int]$p)) { $chain += [int]$p; $p = $by[[int]$p].ParentProcessId }`,
    `$t1 = @{}; foreach ($g in Get-Process) { try { $t1[$g.Id] = $g.TotalProcessorTime.TotalMilliseconds } catch {} }`,
    `Start-Sleep -Milliseconds 500`,
    `$t2 = @{}; foreach ($g in Get-Process) { try { $t2[$g.Id] = $g.TotalProcessorTime.TotalMilliseconds } catch {} }`,
    `$now = Get-Date`,
    `$jobs = @(Get-ChildItem -Path (Join-Path $env:USERPROFILE '.fleet\\jobs\\*\\pid') -EA SilentlyContinue | Where-Object { -not (Test-Path (Join-Path $_.DirectoryName 'exit')) } | ForEach-Object {`,
    `  @{ id = $_.Directory.Name; pid = [int]((Get-Content $_.FullName -Raw).Trim()) } })`,
    `$rows = foreach ($x in $all) {`,
    `  $id = [int]$x.ProcessId; $cpu = $null`,
    `  if ($t1.ContainsKey($id) -and $t2.ContainsKey($id)) { $cpu = [math]::Round(($t2[$id] - $t1[$id]) / 5, 1) }`,
    `  $age = $null; if ($x.CreationDate) { $age = [int]($now - $x.CreationDate).TotalSeconds }`,
    `  @{ pid = $id; ppid = [int]$x.ParentProcessId; name = [string]$x.Name; cmd = [string]$x.CommandLine;`,
    `     session = [int]$x.SessionId; mem = [math]::Round($x.WorkingSetSize / 1MB, 1); cpu = $cpu; age = $age }`,
    `}`,
    `'${SENT}json|' + (@{ chain = $chain; jobs = $jobs; rows = @($rows) } | ConvertTo-Json -Compress -Depth 4)`,
  ].join("\n");
}

/** `[[dd-]hh:]mm:ss` → seconds. */
export function etimeSeconds(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

const base = (s: string) => s.replace(/^.*\//, "");

interface Parsed { rows: ProcRow[]; chain: Set<number>; jobs: { id: string; pid: number }[] }

export function parsePosixList(host: Host, out: string): Parsed {
  const lines = out.split("\n");
  const chain = new Set<number>();
  const jobs: { id: string; pid: number }[] = [];
  const rows = new Map<number, ProcRow>();
  let section = "";
  for (const line of lines) {
    if (line.startsWith(SENT)) {
      const [kind, ...rest] = line.slice(SENT.length).split("|");
      if (kind === "chain") for (const p of (rest[0] ?? "").trim().split(/\s+/)) { if (p) chain.add(Number(p)); }
      else if (kind === "job" && rest[1] && /^\d+$/.test(rest[1].trim())) jobs.push({ id: rest[0]!, pid: Number(rest[1].trim()) });
      else section = kind!;
      continue;
    }
    if (section === "ps") {
      const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const comm = m[7]!.trim();
      rows.set(Number(m[1]), {
        host: host.name, pid: Number(m[1]), ppid: Number(m[2]), name: host.os === "mac" ? base(comm) : comm,
        user: m[6]!, cpu: Number(m[3]), mem_mb: Math.round(Number(m[4]) / 102.4) / 10,
        age_s: etimeSeconds(m[5]!), cmd: comm,
      });
    } else if (section === "args") {
      const m = /^\s*(\d+)\s(.*)$/.exec(line);
      const row = m && rows.get(Number(m[1]));
      if (row) row.cmd = m![2]!.trim();
    }
  }
  return { rows: [...rows.values()], chain, jobs };
}

export function parseWindowsList(host: Host, out: string): Parsed {
  const line = out.split("\n").find((l) => l.startsWith(`${SENT}json|`));
  if (!line) throw new Error("the process listing did not report");
  const data = JSON.parse(line.slice(SENT.length + 5));
  const list = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const rows: ProcRow[] = list<any>(data.rows).map((r) => ({
    host: host.name, pid: r.pid, ppid: r.ppid, name: String(r.name ?? "").replace(/\.exe$/i, ""),
    user: null, cpu: r.cpu ?? null, mem_mb: r.mem ?? 0, age_s: r.age ?? null, cmd: r.cmd || String(r.name ?? ""),
    session: r.session,
  }));
  return { rows, chain: new Set(list<number>(data.chain)), jobs: list<any>(data.jobs).filter((j) => Number.isInteger(j?.pid)) };
}

/** Mark job ownership and protection on parsed rows. */
function annotate(host: Host, p: Parsed): ProcRow[] {
  const byPid = new Map(p.rows.map((r) => [r.pid, r]));
  // A spool's pid counts only while that pid is still the job's runner, whose
  // command line names its spool (…/.fleet/jobs/<id>/run). Pids get reused.
  const jobOf = new Map(p.jobs.filter((j) => byPid.get(j.pid)?.cmd.includes(j.id)).map((j) => [j.pid, j.id]));
  const system = new Set(SYSTEM_NAMES[host.os].map((n) => n.toLowerCase()));
  for (const r of p.rows) {
    for (let cur: ProcRow | undefined = r, hops = 0; cur && hops < 64; cur = byPid.get(cur.ppid), hops++) {
      const id = jobOf.get(cur.pid);
      if (id) { r.job = id; break; }
      if (cur.ppid === cur.pid) break;
    }
    if (p.chain.has(r.pid)) r.protected = "fleet's own session";
    else if ((host.os === "windows" ? [0, 4] : [0, 1]).includes(r.pid)) r.protected = "a core system process";
    else if (system.has(r.name.toLowerCase())) r.protected = "a system process (pass system to override)";
  }
  return p.rows;
}

async function listOne(host: Host, run: typeof exec): Promise<ProcList & { chain: Set<number> }> {
  const win = host.os === "windows";
  const r = await run(host, win ? windowsListScript() : posixListScript(), win ? "powershell" : "bash");
  if (!r.ok) return { host: host.name, ok: false, error: r.stderr.trim() || `exit ${r.code}`, rows: [], chain: new Set() };
  try {
    const parsed = win ? parseWindowsList(host, r.stdout) : parsePosixList(host, r.stdout);
    return { host: host.name, ok: true, rows: annotate(host, parsed), chain: parsed.chain };
  } catch (e) {
    return { host: host.name, ok: false, error: (e as Error).message, rows: [], chain: new Set() };
  }
}

export interface PsOptions { filter?: string; sort?: "cpu" | "mem"; limit?: number }

/** A process matches a filter by name, or by pid when the filter is a number.
 *  The command line is deliberately not searched: that is how `pkill -f`
 *  ends up matching the shell that runs it. */
export function matchesFilter(r: ProcRow, filter: string): boolean {
  if (/^\d+$/.test(filter)) return r.pid === Number(filter);
  return r.name.toLowerCase().includes(filter.toLowerCase().replace(/\.exe$/, ""));
}

export async function processList(
  cfg: FleetConfig, sel: string, opts: PsOptions = {}, deps: { exec?: typeof exec } = {},
): Promise<ProcList[]> {
  if (opts.sort && opts.sort !== "cpu" && opts.sort !== "mem") throw new Error("sort must be cpu or mem");
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) throw new Error("limit must be a positive integer");
  const hosts = resolveHosts(cfg, sel);
  return Promise.all(hosts.map(async (h) => {
    const l = await listOne(h, deps.exec ?? exec);
    let rows = opts.filter ? l.rows.filter((r) => matchesFilter(r, opts.filter!)) : l.rows;
    const key = opts.sort === "mem" ? (r: ProcRow) => r.mem_mb : (r: ProcRow) => r.cpu ?? -1;
    rows = [...rows].sort((a, b) => key(b) - key(a) || a.pid - b.pid);
    if (opts.limit) rows = rows.slice(0, opts.limit);
    return { host: l.host, ok: l.ok, ...(l.error ? { error: l.error } : {}), rows };
  }));
}

// ── kill ──────────────────────────────────────────────────────────────────────

export interface KillOptions {
  /** Also stop every descendant, children first. */
  tree?: boolean;
  /** SIGKILL / Stop-Process -Force whatever survives the polite request. */
  force?: boolean;
  /** Kill every process a name matches instead of refusing when there are several. */
  all?: boolean;
  /** Lift the system-name guard. Never lifts the session or pid 0/1/4 guard. */
  system?: boolean;
  /** Seconds to wait for a polite exit (default 5). */
  graceS?: number;
  /** Resolve and report the plan; signal nothing. */
  dryRun?: boolean;
}

export type KillOutcome = "exited" | "killed" | "running" | "denied" | "gone" | "changed" | "planned";
export interface KillRow { pid: number; name: string; outcome: KillOutcome; detail?: string; job?: string; cmd?: string }
export interface KillResult { host: string; ok: boolean; error?: string; targets: KillRow[] }

/** Resolve a spec against one host's list: a pid, an exact name, or a unique
 *  name substring. Throws with the candidates when the answer is not one
 *  process (unless `all`) or when a target is protected. */
export function resolveKill(rows: ProcRow[], spec: string, opts: KillOptions = {}): ProcRow[] {
  const s = spec.trim();
  if (!s) throw new Error("name the process: a pid or a process name");
  let hits: ProcRow[];
  if (/^\d+(,\d+)*$/.test(s)) {
    // One pid, or the exact pid list a confirmed plan named.
    hits = [];
    for (const pid of s.split(",").map(Number)) {
      const row = rows.find((r) => r.pid === pid);
      if (!row) throw new Error(`no process with pid ${pid}`);
      if (!hits.includes(row)) hits.push(row);
    }
  } else {
    const want = s.toLowerCase().replace(/\.exe$/, "");
    hits = rows.filter((r) => r.name.toLowerCase() === want);
    if (!hits.length) hits = rows.filter((r) => r.name.toLowerCase().includes(want));
    if (!hits.length) throw new Error(`no process named "${s}"`);
    const names = new Set(hits.map((r) => r.name.toLowerCase()));
    if (hits.length > 1 && !opts.all) {
      const list = hits.slice(0, 15).map((r) => `  ${r.pid}  ${r.name}  ${r.cmd.slice(0, 100)}`).join("\n");
      throw new Error(`"${s}" matches ${hits.length} processes${names.size > 1 ? ` across ${names.size} names` : ""}; `
        + `name one pid, or pass all to kill every one:\n${list}${hits.length > 15 ? `\n  … ${hits.length - 15} more` : ""}`);
    }
  }
  if (opts.tree) {
    const kids = new Map<number, ProcRow[]>();
    for (const r of rows) if (r.ppid !== r.pid) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
    const out: ProcRow[] = [];
    const seen = new Set<number>();
    const walk = (r: ProcRow) => {
      if (seen.has(r.pid)) return;
      seen.add(r.pid);
      for (const k of kids.get(r.pid) ?? []) walk(k);
      out.push(r); // children before their parent
    };
    for (const h of hits) walk(h);
    hits = out;
  }
  const blocked = hits.filter((r) => r.protected && !(opts.system && r.protected.startsWith("a system process")));
  if (blocked.length)
    throw new Error(`refusing: ${blocked.map((r) => `${r.pid} ${r.name} is ${r.protected}`).join("; ")}`);
  return hits;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

function posixKillScript(targets: ProcRow[], opts: KillOptions): string {
  const grace = Math.max(0, Math.round((opts.graceS ?? 5) * 10));
  // pid<TAB>expected comm, one per line; the name is compared before any signal.
  const plan = targets.map((t) => `${t.pid}\t${t.name}`).join("\n");
  return [
    `plan="$(printf '%s' '${b64(plan)}' | base64 -d)"`,
    `alive() { st="$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')"; [ -n "$st" ] && [ "\${st#Z}" = "$st" ]; }`,
    `name_of() { n="$(ps -o comm= -p "$1" 2>/dev/null)"; printf '%s' "\${n##*/}"; }`,
    POSIX_CHAIN,
    `sent=""`,
    `while IFS="$(printf '\\t')" read -r pid want; do`,
    `  [ -n "$pid" ] || continue`,
    `  case " $chain " in *" $pid "*) echo "${SENT}k|$pid|denied|fleet's own session"; continue;; esac`,
    `  if ! alive "$pid"; then echo "${SENT}k|$pid|gone"; continue; fi`,
    `  have="$(name_of "$pid")"`,
    `  if [ "$have" != "$want" ]; then echo "${SENT}k|$pid|changed|now $have"; continue; fi`,
    `  if err="$(kill -TERM "$pid" 2>&1)"; then sent="$sent $pid"; else echo "${SENT}k|$pid|denied|$err"; fi`,
    `done <<EOF_PLAN`,
    `$plan`,
    `EOF_PLAN`,
    `i=0; while [ "$i" -lt ${grace} ]; do left=""; for p in $sent; do alive "$p" && left="$left $p"; done; [ -z "$left" ] && break; sleep 0.1; i=$((i+1)); done`,
    `for p in $sent; do`,
    `  if ! alive "$p"; then echo "${SENT}k|$p|exited"; continue; fi`,
    opts.force
      ? `  if err="$(kill -KILL "$p" 2>&1)"; then j=0; while alive "$p" && [ "$j" -lt 20 ]; do sleep 0.1; j=$((j+1)); done; if alive "$p"; then echo "${SENT}k|$p|running|survived SIGKILL"; else echo "${SENT}k|$p|killed"; fi; else echo "${SENT}k|$p|denied|$err"; fi`
      : `  echo "${SENT}k|$p|running|still running after SIGTERM; pass force to SIGKILL it"`,
    `done`,
  ].join("\n");
}

function windowsKillScript(targets: ProcRow[], opts: KillOptions): string {
  const grace = Math.max(0, Math.round((opts.graceS ?? 5) * 10));
  const plan = b64(JSON.stringify(targets.map((t) => ({ pid: t.pid, name: t.name }))));
  return [
    `$plan = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${plan}')) | ConvertFrom-Json`,
    `function Out-K($p, $o, $d) { '${SENT}k|' + $p + '|' + $o + '|' + (($d -replace '[\\r\\n|]+', ' ').Trim()) }`,
    WIN_CHAIN,
    `$sent = @()`,
    `foreach ($t in @($plan)) {`,
    `  if ($chain -contains [int]$t.pid) { Out-K $t.pid 'denied' "fleet's own session"; continue }`,
    `  $pr = Get-Process -Id $t.pid -EA SilentlyContinue`,
    `  if (-not $pr) { Out-K $t.pid 'gone' ''; continue }`,
    `  if ($pr.ProcessName -ne $t.name) { Out-K $t.pid 'changed' ('now ' + $pr.ProcessName); continue }`,
    // taskkill without /F asks the app to close (WM_CLOSE). A process with no
    // window cannot be asked; that is reported, and force handles it.
    `  $msg = & taskkill.exe /PID $t.pid 2>&1 | Out-String`,
    `  $sent += [int]$t.pid`,
    `}`,
    `for ($i = 0; $i -lt ${grace}; $i++) { if (-not @($sent | Where-Object { Get-Process -Id $_ -EA SilentlyContinue })) { break }; Start-Sleep -Milliseconds 100 }`,
    `foreach ($p in $sent) {`,
    `  if (-not (Get-Process -Id $p -EA SilentlyContinue)) { Out-K $p 'exited' ''; continue }`,
    opts.force
      ? `  try { Stop-Process -Id $p -Force -EA Stop; Start-Sleep -Milliseconds 300; if (Get-Process -Id $p -EA SilentlyContinue) { Out-K $p 'running' 'survived Stop-Process -Force' } else { Out-K $p 'killed' '' } } catch { if ($_.Exception.Message -match 'denied') { Out-K $p 'denied' $_.Exception.Message } else { Out-K $p 'running' $_.Exception.Message } }`
      : `  Out-K $p 'running' 'still running after a close request (a windowless process can only be forced); pass force'`,
    `}`,
  ].join("\n");
}

export function parseKillOutput(out: string, targets: ProcRow[]): KillRow[] {
  const names = new Map(targets.map((t) => [t.pid, t.name]));
  const seen = new Map<number, KillRow>();
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t.startsWith(`${SENT}k|`)) continue;
    const [pid, outcome, ...detail] = t.slice(SENT.length + 2).split("|");
    const n = Number(pid);
    const d = detail.join("|").trim();
    seen.set(n, { pid: n, name: names.get(n) ?? "", outcome: outcome as KillOutcome, ...(d ? { detail: d } : {}) });
  }
  // A target the script never reported on: say so rather than imply success.
  return targets.map((t) => seen.get(t.pid) ?? { pid: t.pid, name: t.name, outcome: "running", detail: "no report from the host" });
}

export async function processKill(
  cfg: FleetConfig, sel: string, spec: string, opts: KillOptions = {},
  deps: { exec?: typeof exec; wrap?: (h: Host, cmd: string) => Promise<{ cmd: string } | { error: ExecResult }> } = {},
): Promise<KillResult[]> {
  if (opts.graceS !== undefined && !(Number.isFinite(opts.graceS) && opts.graceS >= 0 && opts.graceS <= 120))
    throw new Error("grace must be 0-120 seconds");
  const run = deps.exec ?? exec;
  const hosts = resolveHosts(cfg, sel);
  return Promise.all(hosts.map(async (h): Promise<KillResult> => {
    const l = await listOne(h, run);
    if (!l.ok) return { host: h.name, ok: false, error: l.error, targets: [] };
    let targets: ProcRow[];
    try { targets = resolveKill(l.rows, spec, opts); }
    catch (e) { return { host: h.name, ok: false, error: (e as Error).message, targets: [] }; }
    if (opts.dryRun) return { host: h.name, ok: true, targets: targets.map((t) => ({ pid: t.pid, name: t.name, outcome: "planned" as const,
      ...(t.job ? { job: t.job } : {}), cmd: t.cmd })) };
    const win = h.os === "windows";
    let script = win ? windowsKillScript(targets, opts) : posixKillScript(targets, opts);
    if (deps.wrap) {
      const w = await deps.wrap(h, script);
      if ("error" in w) return { host: h.name, ok: false, error: w.error.stderr, targets: [] };
      script = w.cmd;
    }
    const r = await run(h, script, win ? "powershell" : "bash");
    const rows = parseKillOutput(r.stdout, targets);
    const ok = rows.every((k) => k.outcome === "exited" || k.outcome === "killed" || k.outcome === "gone");
    return { host: h.name, ok, ...(!r.ok && r.stderr.trim() ? { error: r.stderr.trim() } : {}), targets: rows };
  }));
}
