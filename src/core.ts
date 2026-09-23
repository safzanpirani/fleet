/**
 * core — the structured action layer shared by the CLI (`cli.ts`) and the MCP
 * server (`mcp.ts`). Everything here RETURNS data and THROWS on failure (never
 * `process.exit` / `console.log`), so it is safe to call from a long-lived
 * stdio MCP process. Presentation (ANSI tables, plain text) lives in the
 * frontends; the quoting-proof shell construction lives once, here + `ssh.ts`.
 */
import { resolveHosts, REPO_ROOT, lookupProxy, normalizeProxy, resolveProxy } from "./config.ts";
import type { FleetConfig, Host, Service, ServiceType, Machine } from "./config.ts";
import { connOpts, exec, probe, probeDetail, scp, scpPull, sshDiagnose, bashEsc, bashPathAssignment, psEsc } from "./ssh.ts";
import { checkProxy, proxyCommandFor } from "./proxy.ts";
import type { ProxyCheck } from "./proxy.ts";
import type { ExecResult, Shell } from "./ssh.ts";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createConnection } from "node:net";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { installLockScript } from "./install-lock.ts";

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
  if (v === undefined || v === "" || v.startsWith("--")) throw new Error(`${flag} requires a value`);
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
  return parseFlags(argv, boolFlags, valFlags, true);
}

/** Parse owned options. Use leadingOnly when the remaining tokens are a remote command. */
export function parseFlags(
  argv: string[], boolFlags: readonly string[], valFlags: readonly string[], leadingOnly = false,
  allowEmptyValues: readonly string[] = [],
): { flags: Record<string, string | true>; rest: string[] } {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") { rest.push(...argv.slice(i + 1)); break; }
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const t = equals > 0 ? token.slice(0, equals) : token;
    if (Object.hasOwn(flags, t)) throw new Error(`duplicate option: ${t}`);
    if (boolFlags.includes(t)) {
      if (equals > 0) throw new Error(`${t} does not take a value`);
      flags[t] = true; continue;
    }
    if (valFlags.includes(t)) {
      const value = equals > 0 ? token.slice(equals + 1) : argv[++i];
      if (value === undefined || (value === "" && !allowEmptyValues.includes(t)) ||
          (equals < 0 && (value.startsWith("--") || boolFlags.includes(value) || valFlags.includes(value))))
        throw new Error(`${t} requires a value`);
      flags[t] = value;
      continue;
    }
    if (t.startsWith("-")) throw new Error(`unknown option: ${t} (try fleet help)`);
    if (leadingOnly) { rest.push(...argv.slice(i)); break; }
    rest.push(token);
  }
  return { flags, rest };
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
    case "systemd-user": return { cmd: `systemctl --user restart '${bashEsc(svc.name)}'`, shell: "bash" };
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
    case "systemd-user": return { cmd: `journalctl --user -u '${bashEsc(svc.name)}' -n ${lineCount(n)} --no-pager`, shell: "bash" };
    case "schtask": return { cmd: `schtasks /Query /TN '${psEsc(svc.name)}' /V /FO LIST`, shell: "powershell" };
    default: return { cmd: `Get-Service -Name '${psEsc(svc.name)}' | Format-List Name,Status,StartType`, shell: "powershell" };
  }
}
/** A command that prints a single status token to stdout, for at-a-glance health. */
export function statusCmd(svc: Service): { cmd: string; shell: Shell } {
  switch (svc.type) {
    case "systemd": return { cmd: `systemctl is-active '${bashEsc(svc.name)}' 2>/dev/null || true`, shell: "bash" };
    case "systemd-user": return { cmd: `systemctl --user is-active '${bashEsc(svc.name)}' 2>/dev/null || true`, shell: "bash" };
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
  if (type === "systemd" || type === "systemd-user") return { up: detail === "active", detail };
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
  proxy: string | null;   // resolved proxy name (redacted for inline URLs), or null
  proxyDown?: boolean;    // the PROXY is unreachable — the host was never contacted
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
    const result = await probeDetail(h);
    const up = result.up;
    const httpUp = !up && h.health ? await probeHttp(h.health) : undefined;
    const rep: HostReport = {
      name: h.name, os: h.os, ssh: h.ssh, gpu: !!h.gpu, up, httpUp,
      proxy: result.via ?? null,
      proxyDown: result.down === "proxy" ? true : undefined,
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

// ── exec --script ─────────────────────────────────────────────────────────────
// Run a LOCAL script file (or stdin) on remote hosts without ever creating a
// remote file. The old shape of this was: write the script locally, `fleet cp`
// it to /tmp on the box, `fleet exec` the interpreter on it, forget to clean up.
// Here the source is base64'd into the same stdin/EncodedCommand blob `exec`
// already uses, so quoting stays a non-issue and nothing is left behind.

/** Interpreter to feed a script to, picked from its file extension. `null`
 *  means "this IS the shell's own language" — pass the source through as the
 *  command itself rather than piping it to anything. */
export function interpreterFor(ext: string, os: string): string | null {
  switch (ext.toLowerCase()) {
    case ".sh": case ".bash": case "": return os === "windows" ? "bash" : null;
    case ".ps1": return os === "windows" ? null : "pwsh";
    case ".py": return os === "windows" ? "python" : "python3";
    case ".js": case ".cjs": case ".mjs": return "node";
    case ".ts": return "bun";
    case ".rb": return "ruby";
    case ".pl": return "perl";
    default: return null;
  }
}

/** Wrap script source into a single command string for `exec`. When an
 *  interpreter is needed the source is base64'd and decoded remotely, so the
 *  script's own quotes/newlines/heredocs never meet a shell parser. */
export function buildScriptCommand(source: string, interp: string | null, os: string, shell: Shell): string {
  if (!interp) return source;                       // native to the target shell
  const b64 = Buffer.from(source, "utf8").toString("base64");
  // PowerShell target: decode in-process, pipe the text to the interpreter's stdin
  if (os === "windows" && shell !== "wsl" && shell !== "bash")
    return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | & ${interp} -`;
  // bash target (linux/mac/wsl): decode with base64(1), pipe to stdin
  return `printf %s '${b64}' | base64 -d | ${interp} -`;
}

export interface ScriptSource { source: string; ext: string; label: string }

/** Infer a script type from a conventional shebang. This keeps stdin scripts
 * safe without guessing their language from their contents. */
export function extensionFromShebang(source: string): string {
  const first = source.split(/\r?\n/, 1)[0] ?? "";
  const match = first.match(/^#!\s*(?:\/usr\/bin\/env(?:\s+-S)?\s+)?(?:\S*\/)?([^\s]+)(?:\s|$)/);
  const bin = match?.[1]?.toLowerCase();
  if (!bin) return "";
  if (["sh", "bash", "zsh"].includes(bin)) return ".sh";
  if (["python", "python3"].includes(bin)) return ".py";
  if (["pwsh", "powershell"].includes(bin)) return ".ps1";
  if (bin === "node") return ".js";
  if (bin === "bun") return ".ts";
  if (bin === "ruby") return ".rb";
  if (bin === "perl") return ".pl";
  return "";
}

/** Read a script from a local path, or from stdin when `path` is "-". */
export async function readScriptSource(path: string): Promise<ScriptSource> {
  if (path === "-") {
    const source = await new Response(Bun.stdin.stream()).text();
    if (!source.trim()) throw new Error("fleet: --script - got empty stdin");
    return { source, ext: extensionFromShebang(source), label: "<stdin>" };
  }
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`fleet: script not found: ${path}`);
  const source = await file.text();
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return { source, ext: dot > slash ? path.slice(dot) : "", label: path };
}

/** Run a local script on every selected host. `interp` overrides the
 *  extension-derived interpreter; "-" as `path` reads stdin. */
export async function runScript(
  cfg: FleetConfig, sel: string, script: ScriptSource,
  opts: { wsl?: boolean; cwd?: string; timeoutMs?: number; interp?: string } = {},
): Promise<ExecResult[]> {
  if (script.label === "<stdin>" && !script.ext && !opts.interp)
    throw new Error("fleet: --script - needs --interp <command> unless stdin starts with a supported shebang");
  const hosts = resolveHosts(cfg, sel);
  const shell: Shell = opts.wsl ? "wsl" : "auto";
  return Promise.all(hosts.map((h) => {
    // a WSL target is a linux box wearing a Windows host entry — pick its interpreter as such
    const os = opts.wsl ? "linux" : h.os;
    const interp = opts.interp ?? interpreterFor(script.ext, os);
    const cmd = buildScriptCommand(script.source, interp, os, shell);
    return exec(h, cmd, shell, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
  }));
}

// ── cp ────────────────────────────────────────────────────────────────────────
export async function pushFile(
  cfg: FleetConfig, local: string | string[], sel: string, remote: string, recursive = false,
  deps: { exec?: typeof exec; scp?: typeof scp } = {},
): Promise<ExecResult[]> {
  const hosts = resolveHosts(cfg, sel);
  const run = deps.exec ?? exec;
  const copy = deps.scp ?? scp;
  // scp needs the destination directory to exist. A trailing slash states the
  // intent unambiguously, so create it instead of failing with "No such file".
  const wantsDir = /[\\/]$/.test(remote) && remote.length > 1;
  return Promise.all(hosts.map(async (h) => {
    if (wantsDir && h.transport !== "daytona") {
      // `New-Item` has no -LiteralPath in ANY PowerShell version, so this step
      // used to fail on every Windows trailing-slash destination — tilde or
      // absolute alike. Its -Path form exists but globs, so `[1]` in a path
      // would miss. GetUnresolvedProviderPathFromPSPath resolves `~` and
      // relative paths the way the rest of the session does, without globbing;
      // CreateDirectory is literal, recursive, and idempotent.
      const mk = h.os === "windows"
        ? `[void][System.IO.Directory]::CreateDirectory(`
          + `$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath('${psEsc(remote)}'))`
        : `${bashPathAssignment("d", remote)}
mkdir -p -- "$d"`;
      const r = await run(h, mk, "auto");
      if (!r.ok) return { ...r, stderr: `could not create destination directory ${remote}: ${r.stderr.trim() || "exit " + r.code}` };
    }
    return copy(h, local, remote, recursive);
  }));
}

/** Pull host:remote → local. Single-host only (one local destination). */
export async function pullFile(
  cfg: FleetConfig, sel: string, remote: string | string[], local: string, recursive = false,
): Promise<ExecResult> {
  const hosts = resolveHosts(cfg, sel);
  if (hosts.length !== 1) throw new Error(`pull needs exactly one source host (got ${hosts.length} from '${sel}')`);
  return scpPull(hosts[0]!, remote, local, recursive);
}

// ── edit ──────────────────────────────────────────────────────────────────────
// Surgical in-place edit of a remote file. The alternative people reach for is
// `exec … sed -i`, which differs between GNU and BSD sed, silently succeeds when
// the pattern doesn't match, and mangles anything with a slash in it. Or it's
// pull → edit locally → cp back, which re-ships the whole file and clobbers any
// concurrent remote change. This does neither: read bytes, replace exactly,
// write back only if the file is still byte-identical to what we read.

/** Read a remote file and return its bytes as UTF-8 text. */
export async function readRemoteFile(host: Host, path: string, shell: Shell = "auto"): Promise<{ text: string; b64: string }> {
  const win = host.os === "windows" && shell !== "wsl" && shell !== "bash";
  const cmd = win
    ? `[Convert]::ToBase64String([IO.File]::ReadAllBytes('${psEsc(path)}'))`
    : `${bashPathAssignment("p", path)}
[ -e "$p" ] || { echo "no such file" 1>&2; exit 2; }
[ -f "$p" ] || { echo "not a regular file" 1>&2; exit 2; }
[ -r "$p" ] || { echo "permission denied (owned by $(ls -ld -- "$p" 2>/dev/null | awk '{print $3}'); use exec --script with sudo)" 1>&2; exit 2; }
set -o pipefail
base64 < "$p" | tr -d '\\n'`;
  const r = await exec(host, cmd, shell);
  if (!r.ok) throw new Error(`${host.name}: cannot read ${path}: ${r.stderr.trim() || "exit " + r.code}`);
  const b64 = r.stdout.replace(/\s/g, "");
  const bytes = Buffer.from(b64, "base64");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${host.name}: cannot edit ${path}: file is not valid UTF-8`);
  }
  return { text, b64 };
}

/** Write text to a remote file, but only if it still matches `expectB64` — so a
 *  change made on the host between our read and our write aborts instead of
 *  being silently overwritten. */
export async function writeRemoteFile(
  host: Host, path: string, text: string, expectB64: string | null, shell: Shell = "auto",
  deps: { exec?: typeof exec } = {},
): Promise<ExecResult> {
  const win = host.os === "windows" && shell !== "wsl" && shell !== "bash";
  const next = Buffer.from(text, "utf8").toString("base64");
  const expectHash = expectB64 === null ? null
    : createHash("sha256").update(Buffer.from(expectB64, "base64")).digest("hex");
  const cmd = win
    ? [
        `$p = '${psEsc(path)}'`,
        ...(expectHash === null ? [] : [
          `$cur = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()`,
          `if ($cur -ne '${expectHash}') { Write-Error 'fleet: ${psEsc(path)} changed on the host since it was read — aborting'; exit 3 }`,
        ]),
        `[IO.File]::WriteAllBytes($p, [Convert]::FromBase64String('${next}'))`,
      ].join("\n")
    : [
        `set -e`,
        bashPathAssignment("p", path),
        `[ ! -L "$p" ] || { echo 'fleet: refusing to replace symlink '"$p" 1>&2; exit 4; }`,
        ...(expectB64 === null ? [] : [
          `cur=$(base64 < "$p" | tr -d '\\n')`,
          `[ "$cur" = '${expectB64}' ] || { echo 'fleet: '"$p"' changed on the host since it was read — aborting' 1>&2; exit 3; }`,
        ]),
        // Copy metadata to a sibling temp before replacing the contents. The
        // final rename stays atomic without dropping executable bits/ownership.
        `tmp="$p.fleet-tmp.$$"`,
        `trap 'rm -f -- "$tmp"' EXIT HUP INT TERM`,
        `cp -p -- "$p" "$tmp"`,
        `printf %s '${next}' | base64 -d > "$tmp"`,
        `mv -- "$tmp" "$p"`,
        `trap - EXIT HUP INT TERM`,
      ].join("\n");
  return (deps.exec ?? exec)(host, cmd, shell);
}

export interface EditResult {
  host: string; ok: boolean; path: string;
  replacements: number;
  diff: string;
  error?: string;
}

/** Unified-ish diff of just the changed regions, with `ctx` lines of context. */
export function diffLines(before: string, after: string, ctx = 2): string {
  if (before === after) return "";
  const a = before.split("\n"), b = after.split("\n");
  const context = Number.isFinite(ctx) ? Math.max(0, Math.floor(ctx)) : 0;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const height = endA - start, width = endB - start, stride = width + 1;
  // LCS preserves repeated lines without greedy anchors pulling unchanged lines
  // into the diff. Cap both work and allocation; a summary is safer than a
  // fallback that dumps the entire region, which may contain credentials.
  const cells = (height + 1) * stride;
  if (cells > 1_000_000)
    return `Diff omitted: changed region exceeds the alignment limit (${height} old lines, ${width} new lines).`;
  const lcs = new Uint32Array(cells);
  for (let i = height - 1; i >= 0; i--)
    for (let j = width - 1; j >= 0; j--)
      lcs[i * stride + j] = a[start + i] === b[start + j]
        ? 1 + lcs[(i + 1) * stride + j + 1]!
        : Math.max(lcs[(i + 1) * stride + j]!, lcs[i * stride + j + 1]!);

  const rows: { changed: boolean; text: string }[] = [];
  for (let i = Math.max(0, start - context); i < start; i++)
    rows.push({ changed: false, text: `  ${i + 1} ${a[i]}` });
  let i = start, j = start;
  while (i < endA || j < endB) {
    if (i < endA && j < endB && a[i] === b[j]) {
      rows.push({ changed: false, text: `  ${i + 1} ${a[i]}` });
      i++; j++;
    } else if (i < endA && (j === endB ||
        lcs[(i - start + 1) * stride + j - start]! >= lcs[(i - start) * stride + j - start + 1]!)) {
      rows.push({ changed: true, text: `- ${i + 1} ${a[i]}` });
      i++;
    } else {
      rows.push({ changed: true, text: `+ ${j + 1} ${b[j]}` });
      j++;
    }
  }
  for (let k = endA; k < Math.min(a.length, endA + context); k++)
    rows.push({ changed: false, text: `  ${k + 1} ${a[k]}` });

  // Merge context windows in linear time even when ctx covers the whole file.
  const ranges: { from: number; to: number }[] = [];
  rows.forEach((row, index) => {
    if (!row.changed) return;
    const from = Math.max(0, index - context), to = Math.min(rows.length, index + context + 1);
    const previous = ranges.at(-1);
    if (previous && from <= previous.to) previous.to = to;
    else ranges.push({ from, to });
  });
  const output: string[] = [];
  for (const { from, to } of ranges)
    for (let k = from; k < to; k++) output.push(rows[k]!.text);
  return output.join("\n");
}

/** Replace `oldStr` with `newStr` in a remote file on every selected host.
 *  Fails loudly on zero matches, and on multiple matches unless `all` is set —
 *  a silent no-op is the exact failure mode this command exists to prevent. */
export async function editRemoteFile(
  cfg: FleetConfig, sel: string, path: string, oldStr: string, newStr: string,
  opts: { wsl?: boolean; all?: boolean; dryRun?: boolean } = {},
): Promise<EditResult[]> {
  if (!oldStr) throw new Error("fleet edit: --old cannot be empty");
  const hosts = resolveHosts(cfg, sel);
  const shell: Shell = opts.wsl ? "wsl" : "auto";
  return Promise.all(hosts.map(async (h): Promise<EditResult> => {
    const base = { host: h.name, path, replacements: 0, diff: "" };
    try {
      const { text, b64 } = await readRemoteFile(h, path, shell);
      const n = text.split(oldStr).length - 1;
      if (n === 0) return { ...base, ok: false, error: `--old not found in ${path}` };
      if (n > 1 && !opts.all)
        return { ...base, ok: false, error: `--old matches ${n} times in ${path} — pass --all to replace every one, or extend --old until it is unique` };
      const next = opts.all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr);
      // Remote edits commonly target env/config files. Unchanged neighbors can
      // contain credentials, so show only the lines that will change.
      const diff = diffLines(text, next, 0);
      if (opts.dryRun) return { ...base, ok: true, replacements: n, diff };
      const w = await writeRemoteFile(h, path, next, b64, shell);
      if (!w.ok) return { ...base, ok: false, error: w.stderr.trim() || `write failed (exit ${w.code})` };
      return { ...base, ok: true, replacements: n, diff };
    } catch (e) {
      return { ...base, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }));
}

/** Split a `sel:path` token into its selector and remote path, but only if the
 *  prefix is a real selector (so a unix local path or `C:\…` isn't mistaken for
 *  one). Returns null when the token is a plain local path. */
export function parseRemoteSpec(cfg: FleetConfig, token: string): { sel: string; path: string } | null {
  // dt:<sandbox>:<path> — the selector itself contains a colon
  if (token.startsWith("dt:")) {
    const j = token.indexOf(":", 3);
    if (j <= 3) return null;
    return { sel: token.slice(0, j), path: token.slice(j + 1) };
  }
  const i = token.indexOf(":");
  if (i <= 0) return null;
  const sel = token.slice(0, i);
  const known = sel === "all" || sel === "*" || sel.startsWith("@") || sel.includes(",")
    || !!cfg.hosts[sel] || !!cfg.routes?.[sel] || !!cfg.machines?.[sel];
  return known ? { sel, path: token.slice(i + 1) } : null;
}

// ── deploy (ship the fleet source to a host + reinstall deps + restart) ───────
export interface DeployResult {
  host: string; ok: boolean; dir: string; result: ExecResult; restarted?: ServiceAction[];
}
export interface DeploySourceOptions {
  explicit?: string;
  embeddedRoot?: string;
  cwd?: string;
}
async function isFleetSourceRoot(root: string): Promise<boolean> {
  if (root.includes("$bunfs")) return false;
  return await Bun.file(join(root, "package.json")).exists()
    && await Bun.file(join(root, "src", "cli.ts")).exists();
}
/** Resolve a real source checkout for deploy. Compiled binaries execute from
 *  Bun's virtual /$bunfs tree, which cannot be passed to the system tar binary. */
export async function resolveDeploySourceRoot(opts: DeploySourceOptions = {}): Promise<string> {
  const explicit = opts.explicit ?? process.env.FLEET_SOURCE_ROOT;
  if (explicit) {
    if (await isFleetSourceRoot(explicit)) return explicit;
    throw new Error(`FLEET_SOURCE_ROOT is not a fleet source checkout: ${explicit}`);
  }
  const candidates = [...new Set([opts.embeddedRoot ?? REPO_ROOT, opts.cwd ?? process.cwd()])];
  for (const candidate of candidates)
    if (await isFleetSourceRoot(candidate)) return candidate;
  throw new Error(
    "fleet deploy needs a source checkout; set FLEET_SOURCE_ROOT when running a compiled binary",
  );
}
/** The remote install dir (literal shell expression, expanded on the host). */
function deployDir(h: Host): string {
  return h.deploy?.dir ?? (h.os === "windows" ? "$env:USERPROFILE\\fleet" : "$HOME/fleet");
}
export function deployScript(h: Host, archive = "fleet-deploy.tgz"): { cmd: string; shell: Shell } {
  if (!/^[a-z0-9.-]+$/.test(archive)) throw new Error("invalid deployment archive");
  const dir = deployDir(h);
  if (h.os === "windows") return { shell: "powershell", cmd: [
    `$ErrorActionPreference='Stop'`,
    h.deploy?.bun ? `$bun='${h.deploy.bun}'`
      : `$bun=(Get-Command bun -EA SilentlyContinue).Source; if(-not $bun){$bun="$env:USERPROFILE\\.bun\\bin\\bun.exe"}`,
    `$dir="${dir}"`,
    `try {`,
    `New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
    `tar -xzf "$env:USERPROFILE\\${archive}" -C $dir`,
    `if($LASTEXITCODE -ne 0){throw "tar extraction failed with exit $LASTEXITCODE"}`,
    `Set-Location $dir`,
    `& $bun install 2>&1 | Out-Null`,
    `if($LASTEXITCODE -ne 0){throw "bun install failed with exit $LASTEXITCODE"}`,
    `$shim="$env:USERPROFILE\\.local\\bin"`,
    `New-Item -ItemType Directory -Force -Path $shim | Out-Null`,
    `$shimText = '@echo off' + [Environment]::NewLine + '"' + $bun + '" "' + $dir + '\\src\\cli.ts" %*'`,
    `Set-Content -Path "$shim\\fleet.cmd" -Value $shimText -Encoding ascii`,
    `$resolved=(Get-Command fleet -EA SilentlyContinue).Source`,
    `if(-not $resolved -or [IO.Path]::GetFullPath($resolved) -ne [IO.Path]::GetFullPath("$shim\\fleet.cmd")){throw "deployed Fleet is shadowed by '$resolved'; put $shim first on PATH"}`,
    `"deployed to $dir (bun: $bun)"`,
    `} finally {`,
    `Remove-Item "$env:USERPROFILE\\${archive}" -Force -EA SilentlyContinue`,
    `}`,
  ].join("\n") };
  return { shell: "bash", cmd: [
    `set -e`,
    `trap 'rm -f "$HOME/${archive}"' EXIT`,
    h.deploy?.bun ? `bun='${h.deploy.bun}'` : `bun="$(command -v bun || echo "$HOME/.bun/bin/bun")"`,
    `dir="${dir}"`,
    `mkdir -p "$dir"`,
    `tar -xzf "$HOME/${archive}" -C "$dir"`,
    `cd "$dir"`,
    `"$bun" install >/dev/null 2>&1`,
    `mkdir -p "$HOME/.local/bin"`,
    `cat > "$HOME/.local/bin/fleet" <<LAUNCHER\n#!/bin/sh\nexec "$bun" "$dir/src/cli.ts" "\\$@"\nLAUNCHER`,
    `chmod 755 "$HOME/.local/bin/fleet"`,
    `resolved="$(command -v fleet || true)"`,
    `if [ "$resolved" != "$HOME/.local/bin/fleet" ]; then echo "deployed Fleet is shadowed by '$resolved'; put $HOME/.local/bin first on PATH" >&2; exit 1; fi`,
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
export async function deployOne(
  cfg: FleetConfig, h: Host, tarLocal: string, restart: boolean | string,
  deps: { exec?: typeof exec; scp?: typeof scp; restart?: typeof restartService } = {},
): Promise<DeployResult> {
  const token = crypto.randomUUID();
  const archive = `fleet-deploy-${token}.tgz`;
  const dir = deployDir(h);
  const run = deps.exec ?? exec;
  const lock = installLockScript(h, dir, token);
  const acquired = await run(h, lock.cmd, lock.shell);
  if (!acquired.ok) return { host: h.name, ok: false, dir, result: acquired };
  let unconfirmed = false;
  let installing = false;
  let outcome: DeployResult;
  try {
    const pushed = await (deps.scp ?? scp)(h, tarLocal, archive);
    if (!pushed.ok) {
      unconfirmed = pushed.code === 124 || pushed.code === 255;
      outcome = { host: h.name, ok: false, dir, result: pushed };
    } else {
      const { cmd, shell } = deployScript(h, archive);
      installing = true;
      const result = await run(h, cmd, shell);
      unconfirmed = result.code === 124 || result.code === 255;
      installing = unconfirmed;
      const svc = result.ok ? deployRestartName(h, restart) : undefined;
      if (svc) installing = true;
      const restarted = svc ? await (deps.restart ?? restartService)(cfg, h.name, svc) : undefined;
      unconfirmed ||= restarted?.some((a) => a.result.code === 124 || a.result.code === 255) ?? false;
      installing = unconfirmed;
      outcome = { host: h.name, ok: result.ok && (restarted?.every((a) => a.result.ok) ?? true), dir, result, restarted };
    }
  } catch (error) {
    unconfirmed = installing;
    outcome = { host: h.name, ok: false, dir, result: { host: h.name, ok: false, code: unconfirmed ? 255 : 1,
      stdout: "", stderr: error instanceof Error ? error.message : String(error) } };
  }
  if (unconfirmed) {
    outcome.ok = false;
    outcome.result = { ...outcome.result, ok: false, code: outcome.result.code || 255,
      stderr: `${outcome.result.stderr}\ndeployment outcome is unconfirmed; inspect ${archive} and the installation lock before another deployment`.trim() };
    return outcome;
  }
  const release = installLockScript(h, dir, token, true, archive);
  try {
    const cleaned = await run(h, release.cmd, release.shell);
    if (!cleaned.ok) outcome = { ...outcome, ok: false, result: { ...cleaned,
      stderr: [outcome.result.stderr, `deployment cleanup: ${cleaned.stderr || `exit ${cleaned.code}`}`].filter(Boolean).join("\n") } };
  } catch (error) {
    outcome = { ...outcome, ok: false, result: { ...outcome.result, ok: false, code: 1,
      stderr: `deployment cleanup failed: ${error instanceof Error ? error.message : String(error)}` } };
  }
  return outcome;
}
/** Build a tarball of the fleet source on the controller, ship it to each host
 *  the selector resolves to, extract + `bun install`, then optionally restart the
 *  host's fleet service. The manual DEPLOY.md dance, as one command. */
export async function deployHosts(
  cfg: FleetConfig, sel: string, opts: { restart?: boolean | string } = {},
): Promise<DeployResult[]> {
  const hosts = resolveHosts(cfg, sel);
  for (const host of hosts) {
    const service = deployRestartName(host, opts.restart ?? true);
    if (service && !host.services?.[service])
      throw new Error(`cannot deploy ${host.name}: restart service '${service}' is not configured (available: ${Object.keys(host.services ?? {}).join(", ") || "none"})`);
  }
  const sourceRoot = await resolveDeploySourceRoot();
  const staging = await mkdtemp(join(tmpdir(), "fleet-deploy-"));
  const tar = join(staging, "source.tgz");
  try {
    const build = Bun.spawn(
      ["tar", "czf", tar, ...(process.platform === "darwin" ? ["--no-xattrs"] : []), "-C", sourceRoot,
        "--exclude", "node_modules", "--exclude", ".git", "--exclude", "dist", "--exclude", ".scratch", "."],
      { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdout: "ignore", stderr: "pipe" });
    const [buildCode, buildError] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ]);
    if (buildCode !== 0) throw new Error("tarball build failed: " + buildError.trim());
    return await Promise.all(hosts.map((h) => deployOne(cfg, h, tar, opts.restart ?? true)));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// ── doctor (diagnose why a host is unreachable) ───────────────────────────────
export interface Diagnosis {
  host: string; os: string; ssh: string; services: string[];
  sshUp: boolean; ms: number;
  health?: string; httpUp?: boolean;
  reason?: string;       // the extracted failure signature when ssh is down
  hints: string[];       // actionable next steps
  proxy?: string;        // resolved proxy name (redacted); absent when direct
  proxyCommand?: string; // the exact ProxyCommand fleet hands ssh
  proxyCheck?: ProxyCheck;   // endpoint reachability + the `verify` result
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
  const resolvedProxy = resolveProxy(host);
  const [probe, httpUp, proxyCheck] = await Promise.all([
    sshDiagnose(host),
    host.health ? probeHttp(host.health) : Promise.resolve(undefined),
    resolvedProxy ? checkProxy(resolvedProxy) : Promise.resolve(undefined),
  ]);
  const base: Diagnosis = {
    host: host.name, os: host.os, ssh: host.ssh, services: Object.keys(host.services ?? {}),
    sshUp: probe.ok, ms: probe.ms, health: host.health, httpUp, hints: [],
    proxy: resolvedProxy?.name, proxyCommand: proxyCommandFor(host), proxyCheck,
  };
  if (probe.ok) return base;
  const { reason, hints } = classifySsh(probe.stderr);
  // Attribution first: a dead proxy is not a dead host, and saying otherwise
  // sends you power-cycling a machine that was never contacted.
  if (proxyCheck && !proxyCheck.reachable)
    return { ...base, reason: `proxy ${proxyCheck.name} (${proxyCheck.endpoint}) is unreachable — the host was never contacted`,
      hints: [`check the proxy endpoint itself, then retry`,
        `FLEET_NO_PROXY=1 fleet doctor ${host.name}   # test the direct route`] };
  if (httpUp) hints.unshift("health URL answers → the box is ALIVE; this is an ssh/route problem, not a dead host");
  if (resolvedProxy) hints.push(`the route goes through proxy ${resolvedProxy.name} — compare with FLEET_NO_PROXY=1`);
  return { ...base, reason, hints };
}

// ── proxies ──────────────────────────────────────────────────────────────────
export interface ProxyRow {
  name: string; type: string; endpoint: string; dns: string;
  auth: boolean;              // credentials configured (never the credentials themselves)
  isDefault: boolean;
  hosts: string[];            // hosts routed through it, defaultProxy included
}
/** Every configured proxy and what rides on it. No secret ever appears here. */
export function proxyRows(cfg: FleetConfig): ProxyRow[] {
  return Object.entries(cfg.proxies ?? {}).map(([name, spec]) => {
    const n = normalizeProxy(spec);
    return {
      name, type: n.type, endpoint: `${n.host}:${n.port}`, dns: n.dns,
      auth: !!(spec.user || spec.passwordEnv || spec.passwordFile),
      isDefault: cfg.defaultProxy === name,
      hosts: Object.values(cfg.hosts)
        .filter((h) => h.transport !== "daytona" && (h.proxy ?? cfg.defaultProxy) === name)
        .map((h) => h.name),
    };
  });
}
/** Probe (and, where `verify` is set, prove) proxies — all of them, or the named ones. */
export async function proxyChecks(cfg: FleetConfig, names?: string[]): Promise<ProxyCheck[]> {
  const wanted = names?.length ? names : Object.keys(cfg.proxies ?? {});
  return Promise.all(wanted.map((n) => checkProxy(lookupProxy(n, cfg))));
}

/** Close the ssh control master for each selected host.
 *
 *  Changing a host's proxy does NOT re-route a live master: the old socket keeps
 *  serving the old path until ControlPersist expires. This is the escape hatch —
 *  and the first thing to run when `fleet ls` disagrees with `ssh -o ControlPath=none`. */
export async function dropMasters(cfg: FleetConfig, sel: string): Promise<{ host: string; dropped: boolean; detail: string }[]> {
  const hosts = resolveHosts(cfg, sel).filter((h) => h.transport !== "daytona");
  return Promise.all(hosts.map(async (h) => {
    const proc = Bun.spawn(["ssh", ...connOpts(h), "-O", "exit", h.ssh], { stdout: "pipe", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    const detail = err.trim();
    // "No such file or directory"/"not found" just means there was no master.
    return { host: h.name, dropped: code === 0, detail: code === 0 ? "master closed" : (detail || "no live master") };
  }));
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
export async function bootState(
  cfg: FleetConfig,
  machine: string,
  deps: { probe?: (host: Host) => Promise<boolean> } = {},
): Promise<BootState> {
  const m = getMachine(cfg, machine);
  const probeHost = deps.probe ?? probe;
  const probed = await Promise.all(Object.entries(m.boots).map(async ([os, b]) => {
    // LAN first: when a box answers on both, the local path is the one we want —
    // Tailscale can hairpin out of the house and back for no benefit.
    const transports = ([["lan", b.lan], ["ts", b.host]] as const).filter(([, n]) => !!n);
    const hits = await Promise.all(transports.map(async ([t, name]) => {
      const h = cfg.hosts[name!];
      if (!h) throw new Error(`machine ${machine} boot ${os} references unknown host '${name}'`);
      return { t, ok: await probeHost(h) };
    }));
    const hit = hits.find((r) => r.ok) ?? null;     // prefer LAN (listed first)
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
export async function resolveLiveHost(
  cfg: FleetConfig,
  name: string,
  deps: { probe?: (host: Host) => Promise<boolean> } = {},
): Promise<string> {
  if (cfg.hosts[name]) return name;
  const st = await bootState(cfg, name, deps);
  if (!st.liveHost) throw new Error(`machine ${name} is not reachable in any boot (it may be powered off)`);
  return st.liveHost;
}

async function resolveLiveHostOrSelf(
  cfg: FleetConfig,
  name: string,
  probeHost?: (host: Host) => Promise<boolean>,
): Promise<string> {
  if (cfg.hosts[name]) return name;
  if (cfg.routes?.[name]) {
    const route = cfg.routes[name];
    for (const candidate of route.prefer) {
      const host = cfg.hosts[candidate];
      if (!host) throw new Error(`route ${name} references unknown host '${candidate}'`);
      if (await (probeHost ?? probe)(host)) return candidate;
    }
    return name;
  }
  if (cfg.machines?.[name]) return (await bootState(cfg, name, { probe: probeHost })).liveHost ?? name;
  return name;
}

/** Resolve logical routes or dual-boot machine names anywhere in a selector.
 *  Independent comma tokens resolve concurrently; each route still probes its
 *  transports sequentially and chooses one BEFORE dispatch. Commands are never
 *  retried on another route after dispatch. */
export async function routeSelector(
  cfg: FleetConfig,
  sel: string,
  deps: { probe?: (host: Host) => Promise<boolean> } = {},
): Promise<string> {
  const probeHost = deps.probe ?? probe;
  const cache = new Map<string, Promise<string>>();
  const resolveToken = (token: string): Promise<string> => {
    const cached = cache.get(token);
    if (cached) return cached;
    const pending = (async () => {
      if (token.startsWith("@") || token === "all" || token === "*" || token.startsWith("dt:") || cfg.hosts[token])
        return token;
      const route = cfg.routes?.[token];
      if (route) {
        for (const name of route.prefer) {
          const host = cfg.hosts[name];
          if (host && await probeHost(host)) return name;
        }
        throw new Error(`route ${token} is not reachable (tried: ${route.prefer.join(", ")})`);
      }
      if (!cfg.machines?.[token]) return token;
      return resolveLiveHost(cfg, token, { probe: probeHost });
    })();
    cache.set(token, pending);
    return pending;
  };
  const tokens = sel.split(",").map((token) => token.trim()).filter(Boolean);
  return (await Promise.all(tokens.map(resolveToken))).join(",");
}

async function probePort(hostname: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: hostname, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
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

async function probeOnce(
  cfg: FleetConfig,
  target: string,
  c: WaitCond,
  remainingMs: number,
  probeHost: typeof probe = probe,
): Promise<{ ok: boolean; detail: string }> {
  const deadlineAt = Date.now() + remainingMs;
  const timeLeft = () => Math.max(1, deadlineAt - Date.now());
  const boundedProbe = (host: Host) => probeHost(host, timeLeft());
  if (c.boot) {
    const st = await bootState(cfg, target, { probe: boundedProbe });
    return { ok: st.live === c.boot, detail: `live=${st.live ?? "off"}` };
  }
  if (c.http) {
    try {
      const res = await fetch(c.http, {
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(8000, timeLeft())),
      });
      return { ok: res.status === (c.status ?? 200), detail: `http ${res.status}` };
    } catch { return { ok: false, detail: "http err" }; }
  }
  if (c.port != null) {
    const name = await resolveLiveHostOrSelf(cfg, target, boundedProbe);
    if (!cfg.hosts[name] && (cfg.routes?.[target] || cfg.machines?.[target]))
      return { ok: false, detail: "no reachable transport" };
    const addr = cfg.hosts[name]?.ssh ?? target;
    const open = await probePort(addr, c.port, timeLeft());
    return { ok: open, detail: `:${c.port} ${open ? "open" : "closed"}` };
  }
  const name = await resolveLiveHostOrSelf(cfg, target, boundedProbe);
  const h = cfg.hosts[name];
  if (!h) return { ok: false, detail: "no host" };
  const up = await boundedProbe(h);
  return { ok: up, detail: up ? "ssh up" : "ssh down" };
}

export async function waitFor(
  cfg: FleetConfig, target: string, c: WaitCond, deps: { probe?: typeof probe } = {},
): Promise<WaitResult> {
  const timeoutMs = c.timeoutMs ?? 120_000, intervalMs = c.intervalMs ?? 3_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0)
    throw new Error("wait timeout and interval must be finite positive numbers");
  if (c.boot && !getMachine(cfg, target).boots[c.boot]) throw new Error(`machine ${target} has no boot '${c.boot}'`);
  if (!c.http && c.port == null && !cfg.hosts[target] && !cfg.routes?.[target] && !cfg.machines?.[target])
    throw new Error(`unknown host, route, or machine: ${target}`);
  const start = Date.now(); let attempts = 0, lastDetail = "";
  while (Date.now() - start < timeoutMs) {
    attempts++;
    const remaining = Math.max(1, timeoutMs - (Date.now() - start));
    const { ok, detail } = await probeOnce(cfg, target, c, remaining, deps.probe);
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
export async function validateImageArtifact(path: string): Promise<void> {
  const file = Bun.file(path);
  if (!await file.exists()) throw new Error(`capture produced no local image: ${path}`);
  const header = Buffer.from(await file.slice(0, 32).arrayBuffer());
  if (header.length < 24) throw new Error(`capture produced an empty or truncated image: ${path}`);
  const png = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (png) {
    const tail = Buffer.from(await file.slice(-12).arrayBuffer());
    if (header.toString("ascii", 12, 16) === "IHDR" && header.readUInt32BE(16) > 0 && header.readUInt32BE(20) > 0 &&
        tail.equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) return;
  } else if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP" &&
             header.readUInt32LE(4) + 8 === file.size) return;
  throw new Error(`capture produced an invalid or incomplete PNG/WebP image: ${path}`);
}

export async function deliverImage(
  host: Host, remotePath: string, finalOut: string,
  deps: { pull?: typeof scpPull } = {},
): Promise<{ result: ExecResult; path: string }> {
  const remote = host.os === "windows" ? remotePath.replace(/\\/g, "/") : remotePath;
  const wantWebp = /\.webp$/i.test(finalOut);
  const cwebp = wantWebp ? await findCwebp() : null;

  const path = wantWebp && !cwebp ? finalOut.replace(/\.webp$/i, ".png") : finalOut;
  const parent = dirname(resolve(path));
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, ".fleet-image-"));
  try {
    const png = join(staging, "capture.png");
    const pull = await (deps.pull ?? scpPull)(host, remote, png);
    if (!pull.ok) return { result: pull, path };
    await validateImageArtifact(png);
    let candidate = png;
    if (wantWebp && cwebp) {
      candidate = join(staging, "capture.webp");
      const proc = Bun.spawn([cwebp, "-lossless", "-quiet", png, "-o", candidate], { stdout: "ignore", stderr: "pipe" });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (code !== 0) return { result: { ...pull, ok: false, code, stderr: `cwebp failed: ${stderr}` }, path };
      await validateImageArtifact(candidate);
    }
    await rename(candidate, resolve(path));
    return { result: pull, path };
  } catch (error) {
    return { result: { host: host.name, ok: false, code: 1, stdout: "",
      stderr: error instanceof Error ? error.message : String(error) }, path };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export interface GridOptions {
  /** Labeled major gridline spacing, in image pixels (default 100). */
  step?: number;
  /** Unlabeled tick spacing along the edges and major lines (default step/4). */
  minorStep?: number;
  /** Bottom status strip stating the coordinate frame the labels are in. */
  caption?: string;
  /** Top warning strip — used when something can eat input (a modal, a popup). */
  banner?: string;
  /** Crosshair at the point a click with these coordinates would land on. */
  probe?: { x: number; y: number; label?: string };
  /** Draw "x,y" labels at interior major crossings, not just at the edges. */
  crossLabels?: boolean;
}

/** Overlay a labeled pixel-coordinate grid on a local image (in place) so an
 *  agent can read off x,y before a cua click.
 *
 *  Labels are RAW IMAGE PIXELS on purpose — do NOT add a HiDPI/logical scale.
 *  cua-driver records a per-pid resize ratio whenever a window capture is
 *  downscaled to `max_image_dimension` (`set_ratio(pid, original_w / output_w)`)
 *  and multiplies every incoming pixel `x,y` by it, so coordinates read off the
 *  returned PNG are exactly what `click` wants. A scale transform here would
 *  double-apply that correction. (`shot --grid` is view-only.)
 *
 *  The ratio is keyed by PID ALONE and is replaced by the next capture of ANY
 *  window of that pid — so whatever capture the coordinates were read off must
 *  be the last one taken before the click. `cuAct` guarantees that ordering;
 *  a hand-rolled sequence of raw `fleet cu` calls does not.
 *
 *  Font path list covers macOS/Linux/Windows; label boxes are sized from real
 *  glyph metrics so the fallback bitmap font still fits. Line and label colours
 *  are chosen per segment from the underlying luminance, because a fixed palette
 *  disappears against saturated artwork.
 *  Best-effort: needs python3 + Pillow locally; returns false if unavailable. */
export async function overlayGrid(imagePath: string, opts: number | GridOptions = {}): Promise<boolean> {
  const o: GridOptions = typeof opts === "number" ? { step: opts } : (opts ?? {});
  let step = o.step ?? 100;
  if (!Number.isFinite(step) || step <= 0) step = 100;   // guard: range(…, 0) throws
  let minor = o.minorStep ?? Math.round(step / 4);
  if (!Number.isFinite(minor) || minor <= 0 || minor >= step) minor = Math.max(1, Math.round(step / 4));
  const spec = JSON.stringify({
    step, minor,
    caption: o.caption ?? "",
    banner: o.banner ?? "",
    probe: o.probe && Number.isFinite(o.probe.x) && Number.isFinite(o.probe.y)
      ? { x: Math.round(o.probe.x), y: Math.round(o.probe.y), label: o.probe.label ?? "" }
      : null,
    cross: o.crossLabels !== false,
  });
  const py = `
import json, sys
from PIL import Image, ImageDraw, ImageFont
path = sys.argv[1]
o = json.loads(sys.argv[2])
step, minor = int(o["step"]), int(o["minor"])
im = Image.open(path).convert("RGB")
w, h = im.size
src = im.load()
ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
d = ImageDraw.Draw(ov)
# first available monospace across macOS / Linux / Windows (falls back to PIL's
# tiny bitmap font only if none exist — then label boxes still fit, see measure())
font = None
tiny = None
for cand in ("/System/Library/Fonts/Menlo.ttc",
             "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
             "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
             "/Library/Fonts/Arial.ttf",
             "C:\\\\Windows\\\\Fonts\\\\consola.ttf"):
    try:
        font = ImageFont.truetype(cand, 12)
        tiny = ImageFont.truetype(cand, 10)
        break
    except Exception:
        pass
if font is None:
    font = ImageFont.load_default()
if tiny is None:
    tiny = font

def measure(s, f):
    l, t, r, b = f.getbbox(s)
    return r - l, b - t

def lum(x, y):
    x = 0 if x < 0 else (w - 1 if x >= w else x)
    y = 0 if y < 0 else (h - 1 if y >= h else y)
    p = src[x, y]
    return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]

def lum_line(x0, y0, x1, y1, n=9):
    t = 0.0
    for i in range(n):
        f = i / (n - 1) if n > 1 else 0.0
        t += lum(int(x0 + (x1 - x0) * f), int(y0 + (y1 - y0) * f))
    return t / n

def lum_box(x0, y0, x1, y1):
    t, n = 0.0, 0
    sx = max(1, (x1 - x0) // 4)
    sy = max(1, (y1 - y0) // 3)
    for x in range(int(x0), int(x1) + 1, sx):
        for y in range(int(y0), int(y1) + 1, sy):
            t += lum(x, y); n += 1
    return t / n if n else 0.0

# ── gridlines, coloured per segment against what is underneath ───────────────
def seg(x0, y0, x1, y1):
    bright = lum_line(x0, y0, x1, y1) > 140
    under = (255, 255, 255, 130) if bright else (0, 0, 0, 150)
    over = (0, 0, 0, 205) if bright else (95, 210, 255, 215)
    d.line([(x0, y0), (x1, y1)], fill=under, width=3)
    d.line([(x0, y0), (x1, y1)], fill=over, width=1)

for x in range(0, w, step):
    for y0 in range(0, h, step):
        seg(x, y0, x, min(y0 + step, h - 1))
for y in range(0, h, step):
    for x0 in range(0, w, step):
        seg(x0, y, min(x0 + step, w - 1), y)

# ── minor ticks: unlabeled, for sub-cell aim on ~30px toolbar icons ──────────
def tick(x0, y0, x1, y1):
    bright = lum_line(x0, y0, x1, y1, 3) > 140
    d.line([(x0, y0), (x1, y1)], fill=(0, 0, 0, 165) if bright else (255, 255, 255, 165), width=1)

for x in range(0, w, minor):
    if x % step == 0:
        continue
    tick(x, 0, x, 6); tick(x, h - 7, x, h - 1)
    for gy in range(0, h, step):
        tick(x, gy - 3, x, gy + 3)
for y in range(0, h, minor):
    if y % step == 0:
        continue
    tick(0, y, 6, y); tick(w - 7, y, w - 1, y)
    for gx in range(0, w, step):
        tick(gx - 3, y, gx + 3, y)

# ── labels: opaque plate + luminance-picked ink, so saturated art stays legible
def tag(x, y, s, f=font, alpha=235):
    tw, th = measure(s, f)
    x = max(1, min(int(x), w - tw - 4))
    y = max(1, min(int(y), h - th - 4))
    bright = lum_box(x - 1, y - 1, x + tw + 2, y + th + 2) > 140
    ink = (255, 255, 255, 255) if bright else (150, 255, 150, 255)
    edge = (255, 255, 255, 190) if bright else (0, 0, 0, 230)
    d.rectangle([x - 2, y - 2, x + tw + 3, y + th + 3], fill=(0, 0, 0, alpha), outline=edge)
    d.text((x, y), s, fill=ink, font=f)
    return tw, th

banner = o.get("banner") or ""
caption = o.get("caption") or ""
top_pad = 24 if banner else 0
bot_pad = 22 if caption else 0

# label every gridline near both edges so a coordinate is always close to a click
for x in range(0, w, step):
    tag(x + 3, top_pad + 2, str(x))
    tag(x + 3, h - bot_pad - 17, str(x))
for y in range(step, h, step):
    s = str(y)
    tw, _ = measure(s, font)
    tag(3, y + 2, s)
    tag(w - tw - 5, y + 2, s)

# interior crossings: "x,y" at every other major, so the centre of a big capture
# does not require tracing a line back to an edge
if o.get("cross"):
    cx_step, cy_step = step * 2, step * 2
    for x in range(cx_step, w, cx_step):
        for y in range(cy_step, h, cy_step):
            if y < top_pad + 20 or y > h - bot_pad - 20:
                continue
            tag(x + 4, y + 4, "%d,%d" % (x, y), tiny, 205)

probe = o.get("probe")
if probe:
    cx, cy = int(probe["x"]), int(probe["y"])
    for r, col, wd in ((0, (0, 0, 0, 220), 4), (0, (255, 60, 220, 255), 2)):
        d.line([(cx - 20, cy), (cx - 5, cy)], fill=col, width=wd)
        d.line([(cx + 5, cy), (cx + 20, cy)], fill=col, width=wd)
        d.line([(cx, cy - 20), (cx, cy - 5)], fill=col, width=wd)
        d.line([(cx, cy + 5), (cx, cy + 20)], fill=col, width=wd)
    d.ellipse([cx - 11, cy - 11, cx + 11, cy + 11], outline=(0, 0, 0, 220), width=4)
    d.ellipse([cx - 11, cy - 11, cx + 11, cy + 11], outline=(255, 60, 220, 255), width=2)
    tag(cx + 16, cy + 16, probe.get("label") or ("click -> %d,%d" % (cx, cy)))

# ── strips last, so nothing is drawn over the warning ────────────────────────
if banner:
    d.rectangle([0, 0, w, top_pad - 1], fill=(150, 20, 20, 240))
    d.text((6, 5), banner[:220], fill=(255, 255, 255, 255), font=font)
if caption:
    d.rectangle([0, h - bot_pad, w, h], fill=(16, 16, 20, 240))
    d.text((6, h - bot_pad + 4), caption[:260], fill=(190, 230, 255, 255), font=font)

Image.alpha_composite(im.convert("RGBA"), ov).convert("RGB").save(path)
`;
  const proc = Bun.spawn(["python3", "-c", py, imagePath, spec], { stdout: "ignore", stderr: "pipe" });
  if (await proc.exited === 0) return true;
  return false;
}

// ── screenshot (capture the remote desktop, pull the PNG back) ────────────────
/** Per-OS command that captures the screen to a temp file and prints the path
 *  as its last stdout line. Best-effort on Linux (needs grim/scrot/imagemagick
 *  + a reachable display). Windows/mac capture the active interactive session. */
export function captureCmd(os: Host["os"]): { cmd: string; shell: Shell } {
  if (os === "windows") return { shell: "powershell", cmd: [
    // sshd runs in session 0 (no desktop), so a direct CopyFromScreen captures a
    // blank virtual screen. Run the grab inside the logged-in user's interactive
    // session via a one-shot scheduled task (/IT), then collect the file.
    `$ErrorActionPreference='Stop'`,
    `$out = Join-Path $env:TEMP ('fleet_shot_' + [guid]::NewGuid().ToString('N') + '.png')`,
    `$ps1 = [System.IO.Path]::ChangeExtension($out,'ps1')`,
    `$script = @'`,
    `$ErrorActionPreference='Stop'`,
    `$out=[IO.Path]::ChangeExtension($MyInvocation.MyCommand.Path,'png')`,
    `$code=0; $bmp=$null; $g=$null`,
    `try {`,
    `  Add-Type -AssemblyName System.Windows.Forms,System.Drawing`,
    `  $vs=[System.Windows.Forms.SystemInformation]::VirtualScreen`,
    `  $bmp=New-Object System.Drawing.Bitmap($vs.Width,$vs.Height)`,
    `  $g=[System.Drawing.Graphics]::FromImage($bmp)`,
    `  $g.CopyFromScreen($vs.Location,[System.Drawing.Point]::Empty,$vs.Size)`,
    `  $bmp.Save($out,[System.Drawing.Imaging.ImageFormat]::Png)`,
    `} catch { $code=1; [IO.File]::WriteAllText("$out.error",[string]$_) }`,
    `finally { if($g){$g.Dispose()}; if($bmp){$bmp.Dispose()} }`,
    `[IO.File]::WriteAllText("$out.done",[string]$code)`,
    `exit $code`,
    `'@`,
    `Set-Content -LiteralPath $ps1 -Value $script -Encoding UTF8`,
    `$tn = 'fleet_shot_' + [guid]::NewGuid().ToString('N')`,
    `$created=$false; $captured=$false`,
    `try {`,
    `$psexe=(Get-Process -Id $PID).Path`,
    `$action=New-ScheduledTaskAction -Execute $psexe -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ps1 + '"')`,
    `$principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited`,
    `Register-ScheduledTask -TaskName $tn -Action $action -Principal $principal -Force | Out-Null; $created=$true`,
    `Start-ScheduledTask -TaskName $tn`,
    `$deadline=(Get-Date).AddSeconds(12)`,
    `while(-not (Test-Path -LiteralPath "$out.done") -and (Get-Date) -lt $deadline){ Start-Sleep -Milliseconds 200 }`,
    `$taskResult=(Get-ScheduledTaskInfo -TaskName $tn -ErrorAction SilentlyContinue).LastTaskResult`,
    `if(-not (Test-Path -LiteralPath "$out.done")){throw "capture task did not finish (task result $taskResult); is a user logged in interactively?"}`,
    `$captureCode=[IO.File]::ReadAllText("$out.done").Trim()`,
    `if($captureCode -ne '0'){ $detail=Get-Content -LiteralPath "$out.error" -Raw -ErrorAction SilentlyContinue; throw "capture task failed (exit $captureCode; task result $taskResult): $detail" }`,
    `if(-not (Test-Path -LiteralPath $out) -or (Get-Item -LiteralPath $out).Length -le 0){throw "capture task completed without a nonempty image (task result $taskResult)"}`,
    `$captured=$true`,
    `Write-Output $out`,
    `exit 0`,
    `} catch { Write-Error $_ -ErrorAction Continue; exit 4 } finally {`,
    `  if($created){ Stop-ScheduledTask -TaskName $tn -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue }`,
    `  Remove-Item -LiteralPath $ps1,"$out.done","$out.error" -Force -ErrorAction SilentlyContinue`,
    `  if(-not $captured){Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue}`,
    `}`,
  ].join("\n") };
  if (os === "mac") return { shell: "bash", cmd:
    `set -e; t="$(mktemp -t fleet_shot)"; p="$t.png"; rm -f "$t"; screencapture -x "$p"; [ -s "$p" ]; echo "$p"` };
  // linux: try wayland (grim) then X11 (scrot / imagemagick import)
  return { shell: "bash", cmd: [
    `set -e`,
    `p="/tmp/fleet_shot_$$.png"`,
    `if command -v grim >/dev/null 2>&1; then grim "$p"`,
    `elif command -v scrot >/dev/null 2>&1; then scrot "$p"`,
    `elif command -v import >/dev/null 2>&1; then DISPLAY="\${DISPLAY:-:0}" import -window root "$p"`,
    `else echo "no screenshot tool (install grim, scrot, or imagemagick)" >&2; exit 3; fi`,
    `[ -s "$p" ] || { echo "capture produced no image" >&2; exit 4; }`,
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
  deps: { exec?: typeof exec; deliver?: typeof deliverImage } = {},
): Promise<ScreenshotResult> {
  const host = resolveHosts(cfg, sel)[0]!;
  const run = deps.exec ?? exec;
  const { cmd, shell } = captureCmd(host.os);
  const capture = await run(host, cmd, shell);
  if (!capture.ok) throw new Error(
    `screenshot capture failed on ${host.name}: ${capture.stderr || capture.stdout || "exit " + capture.code}`);

  const remotePath = capture.stdout.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  if (!remotePath) throw new Error(`screenshot produced no output path on ${host.name}`);

  // deliverImage normalizes the Windows path for scp and optionally transcodes
  // to webp locally; `path` is the actual file written (.webp or .png fallback).
  try {
    const { result: pull, path } = await (deps.deliver ?? deliverImage)(host, remotePath, localPath);
    if (!pull.ok) throw new Error(`could not pull screenshot from ${host.name}: ${pull.stderr || "scp exit " + pull.code}`);
    await validateImageArtifact(path);
    return { host: host.name, localPath: path, remotePath, capture, pull };
  } finally {
    const cleanup = rmCmd(host.os, remotePath);
    await run(host, cleanup.cmd, cleanup.shell).catch(() => {});
  }
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

/** Windows prelude that multiplexes every driver call in one remote script over
 *  a single `cua-driver mcp` process.
 *
 *  Each `cua-driver <tool>` process on Windows pays ~600-900 ms to reach the
 *  daemon from the ssh session, even for `get_config`. One `mcp` process pays
 *  that once and answers every later call in milliseconds, so a verified click
 *  (capture, act, capture, capture) costs one connection instead of four.
 *  `--socket` names the daemon's pipe explicitly: without it, `mcp` refuses to
 *  run from ssh's Session 0.
 *
 *  `Invoke-FleetCua <tool> <json>` writes the raw JSON-RPC reply and sets
 *  $LASTEXITCODE (1 on isError). When the session cannot start (a driver older
 *  than 0.28), it runs the per-call CLI instead. A session that dies mid-script
 *  is NOT retried through the CLI: the lost call may already have delivered
 *  input, and replaying it would deliver it twice. */
export function cuWinSession(): string {
  return [
    `$script:fcuP = $null; $script:fcuId = 0; $script:fcuUtf8 = New-Object System.Text.UTF8Encoding($false)`,
    `function Write-FleetCuaLine([string]$line) { $b = $script:fcuUtf8.GetBytes($line + [char]10); $script:fcuP.StandardInput.BaseStream.Write($b, 0, $b.Length); $script:fcuP.StandardInput.BaseStream.Flush() }`,
    `function Send-FleetCua([string]$method, [string]$params) {`,
    `  $script:fcuId++; $id = $script:fcuId`,
    `  try { Write-FleetCuaLine ('{"jsonrpc":"2.0","id":' + $id + ',"method":"' + $method + '","params":' + $params + '}') } catch { return $null }`,
    `  while ($true) {`,
    `    $line = $script:fcuP.StandardOutput.ReadLine()`,
    `    if ($null -eq $line) { return $null }`,
    `    if ($line -match ('^\\s*\\{"jsonrpc":"2\\.0","id":' + $id + '[,}]')) { return $line }`,
    `  }`,
    `}`,
    `function Start-FleetCua {`,
    `  try {`,
    `    $psi = New-Object System.Diagnostics.ProcessStartInfo`,
    `    $psi.FileName = $fcd; $psi.Arguments = 'mcp --socket \\\\.\\pipe\\cua-driver'`,
    `    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true`,
    `    $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true`,
    `    $psi.StandardOutputEncoding = $script:fcuUtf8`,
    `    $script:fcuP = [System.Diagnostics.Process]::Start($psi)`,
    `    $null = $script:fcuP.StandardError.ReadToEndAsync()`,
    `    $init = Send-FleetCua 'initialize' '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"fleet","version":"1"}}'`,
    `    if (-not $init -or $init -notmatch '"result"') { throw 'cua-driver mcp did not initialize' }`,
    `    Write-FleetCuaLine '{"jsonrpc":"2.0","method":"notifications/initialized"}'`,
    `  } catch {`,
    `    if ($script:fcuP) { try { $script:fcuP.Kill() } catch {} }`,
    `    $script:fcuP = $null`,
    `  }`,
    `  $script:fcuCli = -not $script:fcuP`,
    `}`,
    `function Stop-FleetCua { if ($script:fcuP) { try { $script:fcuP.StandardInput.Close(); $null = $script:fcuP.WaitForExit(2000) } catch {}; try { if (-not $script:fcuP.HasExited) { $script:fcuP.Kill() } } catch {}; $script:fcuP = $null } }`,
    `function Invoke-FleetCua([string]$tool, [string]$json) {`,
    `  if ($script:fcuCli) {`,
    `    $global:LASTEXITCODE = 0`,
    `    $out = @($json | & $fcd $tool 2>&1); $ok = $?; $code = $LASTEXITCODE`,
    `    $out | Write-Output`,
    `    if ($null -eq $code) { $code = 0 }; if (-not $ok -and $code -eq 0) { $code = 1 }`,
    `    $global:LASTEXITCODE = $code; return`,
    `  }`,
    `  if (-not $script:fcuP) { Write-Output 'cua-driver session closed before this call; it was not sent'; $global:LASTEXITCODE = 1; return }`,
    `  $reply = Send-FleetCua 'tools/call' ('{"name":"' + $tool + '","arguments":' + $json + '}')`,
    `  if ($null -eq $reply) { $script:fcuP = $null; Write-Output 'cua-driver session closed during this call; its outcome is unknown'; $global:LASTEXITCODE = 1; return }`,
    `  Write-Output $reply`,
    `  $global:LASTEXITCODE = if ($reply -match '^\\s*\\{"jsonrpc":"2\\.0","id":\\d+,"error"' -or $reply -match '(?<!\\\\)"isError":\\s*true') { 1 } else { 0 }`,
    `}`,
    `Start-FleetCua`,
  ].join("\n");
}

/** A PowerShell expression that evaluates to one JSON argument string. With
 *  `outVar`, the capture path lands in `screenshot_out_file` at run time, so
 *  $env:TEMP-style paths expand remotely and never have to be guessed here. */
function psJsonExpr(json: string, outVar = ""): string {
  if (!outVar) return `'${json.replace(/'/g, "''")}'`;
  const prefix = json.trim().replace(/\}\s*$/, "");
  const comma = prefix.trimEnd().endsWith("{") ? "" : ",";
  const pre = `'${(prefix + comma).replace(/'/g, "''")}"screenshot_out_file":"'`;
  return `(${pre} + ($${outVar} -replace '\\\\','\\\\') + '"}')`;
}

/** One driver call inside a `cuWinSession` script. */
function cuWinCall(tool: string, json: string, outVar = ""): string {
  return `Invoke-FleetCua '${tool.replace(/'/g, "''")}' ${psJsonExpr(json, outVar)}`;
}

/** Normalize one driver reply to what the per-call CLI prints: a JSON-RPC
 *  envelope from a `cuWinSession` becomes its structured payload (pretty JSON)
 *  or its text, and anything else passes through unchanged. Every parser below
 *  reads this form, so a session and the CLI fallback look identical to it. */
export function cuReplyText(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{"jsonrpc"')) return body;
  let envelope: any;
  try { envelope = JSON.parse(trimmed); } catch { return body; }
  if (envelope?.error) return String(envelope.error.message ?? JSON.stringify(envelope.error));
  const result = envelope?.result ?? {};
  if (result.structuredContent && typeof result.structuredContent === "object")
    return JSON.stringify(result.structuredContent, null, 2);
  const text = (Array.isArray(result.content) ? result.content : [])
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text as string)
    .join("\n");
  return text.replace(/^✅\s*/, "");
}

// Inline image transfer: a capture's bytes ride back base64-encoded in the same
// ssh stdout, instead of costing an scp pull plus a cleanup exec per image.
const B64_SENTINEL = "__FLEET_B64__";
const B64_END = "__FLEET_B64END__";

/** Remote lines that print one capture file base64-encoded under `tag`, then
 *  delete it. Nothing is printed when the file is missing or empty, so a failed
 *  capture reads as "no image", never as an empty one. */
function emitImage(os: Host["os"], pathVar: string, tag: string): string {
  if (os === "windows") return [
    `if ($${pathVar} -and (Test-Path -LiteralPath $${pathVar}) -and (Get-Item -LiteralPath $${pathVar}).Length -gt 0) {`,
    `  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($${pathVar}))`,
    `  Write-Output '${B64_SENTINEL}${tag}'`,
    `  for ($i = 0; $i -lt $b64.Length; $i += 65536) { Write-Output $b64.Substring($i, [Math]::Min(65536, $b64.Length - $i)) }`,
    `  Write-Output '${B64_END}'`,
    `}`,
    `if ($${pathVar}) { Remove-Item -LiteralPath $${pathVar} -Force -EA SilentlyContinue }`,
  ].join("\n");
  return [
    `if [ -s "$${pathVar}" ]; then echo '${B64_SENTINEL}${tag}'; base64 < "$${pathVar}"; echo '${B64_END}'; fi`,
    `rm -f "$${pathVar}"`,
  ].join("\n");
}

/** Every inline image in an exec's stdout, by tag, plus the stdout without them. */
export function takeInlineImages(stdout: string): { images: Map<string, Uint8Array>; rest: string } {
  const images = new Map<string, Uint8Array>();
  const kept: string[] = [];
  let tag: string | undefined;
  let chunks: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (tag === undefined && trimmed.startsWith(B64_SENTINEL)) {
      tag = trimmed.slice(B64_SENTINEL.length);
      chunks = [];
    } else if (tag !== undefined && trimmed === B64_END) {
      images.set(tag, Uint8Array.from(Buffer.from(chunks.join(""), "base64")));
      tag = undefined;
    } else if (tag !== undefined) {
      chunks.push(trimmed);
    } else {
      kept.push(line);
    }
  }
  return { images, rest: kept.join("\n") };
}

/** A `deliverImage` pull that writes bytes already in hand. */
function inlinePull(host: Host, bytes: Uint8Array): typeof scpPull {
  return async (_host, _remote, local) => {
    await writeFile(local, bytes);
    return { host: host.name, ok: true, code: 0, stdout: "", stderr: "" };
  };
}

/** The systemd user unit that runs the daemon on Linux.
 *
 *  cua-driver does not write this itself: its `autostart enable` is Windows-only
 *  as of 0.26, and the Linux recipe lives in install-local.sh, which builds from
 *  a repo checkout and is marked not-for-end-users. So a fresh Linux host has
 *  the binary and no service, and `systemctl --user restart` on it fails with
 *  "Unit cua-driver.service not found" — which is what this install used to do.
 *
 *  DISPLAY matters: the daemon drives the desktop, so it needs the graphical
 *  session rather than the environment an SSH login happens to carry. */
const CUA_LINUX_UNIT = [
  "[Unit]",
  "Description=cua-driver computer-use daemon",
  "After=graphical-session.target",
  "PartOf=graphical-session.target",
  "",
  "[Service]",
  "Type=simple",
  "Environment=DISPLAY=:0",
  "ExecStart=%h/.local/bin/cua-driver serve --socket %h/.cache/cua-driver/cua-driver.sock",
  "Restart=on-failure",
  "RestartSec=2",
  "",
  "[Install]",
  "WantedBy=graphical-session.target default.target",
].join("\n");

/** Install the current release, then restart the host's desktop daemon. */
function cuInstallCmd(os: Host["os"]): { cmd: string; shell: Shell } {
  if (os === "windows") return {
    shell: "powershell",
    cmd: `$ErrorActionPreference='Stop'; irm https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1 | iex; `
      + `& "$env:LOCALAPPDATA\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe" autostart kick`,
  };
  // `bash -c "$installer" <flag>` would pass the flag as $0, not $1, so any
  // argument has to come after an explicit $0 placeholder. Nothing needs one
  // today; the placeholder is here so adding one later does not silently do
  // nothing.
  const runInstaller = `/bin/bash -c "$installer" cua-driver-install || exit $?`;
  if (os !== "linux") return {
    shell: "bash",
    cmd: `installer=$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh) || exit $?\n`
      + `${runInstaller}\n`
      + `"$(command -v cua-driver || echo "$HOME/.local/bin/cua-driver")" autostart kick`,
  };
  return {
    shell: "bash",
    cmd: `installer=$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh) || exit $?\n`
      + `${runInstaller}\n`
      + `unit="$HOME/.config/systemd/user/cua-driver.service"\n`
      + `if [ ! -f "$unit" ]; then\n`
      + `  mkdir -p "$(dirname "$unit")"\n`
      + `  cat > "$unit" <<'CUA_UNIT'\n${CUA_LINUX_UNIT}\nCUA_UNIT\n`
      + `  systemctl --user daemon-reload\n`
      + `  systemctl --user enable cua-driver.service\n`
      + `fi\n`
      + `systemctl --user restart cua-driver.service`,
  };
}

/** Install cua-driver across every host a selector resolves to, in parallel.
 *  Fans out like `restart`/`reboot`: `fleet cu @windows install` provisions the
 *  whole group from one call instead of silently doing only the first host. */
export async function cuInstall(
  cfg: FleetConfig,
  sel: string,
  deps: { exec?: typeof exec } = {},
): Promise<CuInstallAction[]> {
  const run = deps.exec ?? exec;
  return Promise.all(resolveHosts(cfg, sel).map(async (h) => {
    const { cmd, shell } = cuInstallCmd(h.os);
    return { host: h.name, os: h.os, result: await run(h, cmd, shell) };
  }));
}

export interface CuInstallAction { host: string; os: Host["os"]; result: ExecResult; }
export interface CuResult { host: string; result: ExecResult; localImage?: string; }

/** Build the piped/quoted `<bin> <args>` invocation for one cua-driver call.
 *  A JSON positional arg is piped via stdin (Windows PowerShell 5.1 strips the
 *  quotes around field names on native-command args; piping preserves them). */
function cuInvocation(args: string[], os: Host["os"], invoke: string, outVar = ""): string {
  let jsonArg = args.find((a) => /^\s*[[{]/.test(a));
  const flags = args.filter((a) => a !== jsonArg).map((a) => shellQuote(a, os)).join(" ");
  if (outVar) {
    // cua-driver ≥0.22 takes the capture path as the `screenshot_out_file` JSON
    // input (the old --screenshot-out-file flag is gone). Splice the shell
    // variable into the JSON at run time so $TMPDIR-style paths expand.
    const base = (jsonArg ?? "{}").trim();
    const prefix = base.replace(/\}\s*$/, "");
    const comma = prefix.trimEnd().endsWith("{") ? "" : ",";
    if (os === "windows") {
      const pre = `'${(prefix + comma).replace(/'/g, "''")}"screenshot_out_file":"'`;
      return `((${pre} + ($${outVar} -replace '\\\\','\\\\') + '"}')) | ${invoke} ${flags}`;
    }
    const pre = `'${(prefix + comma).replace(/'/g, "'\\''")}"screenshot_out_file":"'`;
    return `printf '%s' ${pre}"$${outVar}"'"}' | ${invoke} ${flags}`;
  }
  const pipe = jsonArg
    ? (os === "windows"
      ? `'${jsonArg.replace(/'/g, "''")}' | `
      : `printf '%s' '${jsonArg.replace(/'/g, "'\\''")}' | `)
    : "";
  return `${pipe}${invoke} ${flags}`;
}

/** Run `cua-driver <args>` on a host. If `imageOut` is set, the call is given
 *  `--screenshot-out-file` to a remote temp PNG which is pulled to `imageOut`.
 *  If no image is produced (e.g. the call errored), cua-driver's own message is
 *  surfaced via the returned ExecResult — never masked by a pull/scp error. */
export async function cuRun(
  cfg: FleetConfig, sel: string, args: string[], imageOut?: string,
  deps: { exec?: typeof exec } = {},
): Promise<CuResult> {
  const host = resolveHosts(cfg, sel)[0]!;
  const win = host.os === "windows";
  const { prelude, invoke } = cuaBin(host.os);
  const shell: Shell = win ? "powershell" : "bash";
  const runExec = deps.exec ?? exec;

  if (!imageOut) {
    const result = await runExec(host, `${prelude}\n${cuInvocation(args, host.os, invoke)}`, shell);
    return { host: host.name, result };
  }

  // Image call: run cua with screenshot_out_file, echo its own output, then the
  // image itself inline IFF the file was actually written. One round trip: no
  // scp pull and no cleanup exec afterwards.
  const cmd = win
    ? [prelude,
       `$out = Join-Path $env:TEMP ('cua_' + [guid]::NewGuid().ToString('N') + '.png')`,
       // Uncaptured on purpose: capturing a cua-driver call's output on
       // Windows adds ~600 ms. It prints straight to ssh's stdout instead.
       `$global:LASTEXITCODE = 0`,
       `${cuInvocation(args, host.os, invoke, "out")}; $driverSucceeded = $?; $driverCode = $LASTEXITCODE`,
       emitImage(host.os, "out", "image"),
       `if (-not $driverSucceeded) { if ($null -ne $driverCode -and $driverCode -ne 0) { exit $driverCode }; exit 1 }`,
       `if ($null -ne $driverCode -and $driverCode -ne 0) { exit $driverCode }`].join("\n")
    : [prelude,
       `out="${"${TMPDIR:-/tmp}"}/cua_shot_$$_$RANDOM.png"; rm -f "$out"`,
       `${cuInvocation(args, host.os, invoke, "out")} 2>&1`,
       `driver_code=$?`,
       emitImage(host.os, "out", "image"),
       `exit "$driver_code"`].join("\n");
  const raw = await runExec(host, cmd, shell);
  const { images, rest } = takeInlineImages(raw.stdout);
  const result: ExecResult = { ...raw, stdout: rest.trimEnd() };
  const bytes = images.get("image");
  if (!bytes) return { host: host.name, result: {
    ...result, ok: false, code: result.code || 1,
    stderr: [result.stderr, "cua-driver produced no requested image"].filter(Boolean).join("\n"),
  } };

  try {
    if (!result.ok) return { host: host.name, result };
    const { result: pull, path } = await deliverImage(host, "inline", imageOut, { pull: inlinePull(host, bytes) });
    if (!pull.ok) return { host: host.name,
      result: { ...result, ok: false, code: pull.code || 1, stderr: `${result.stderr}\nimage pull failed: ${pull.stderr}`.trim() } };
    return { host: host.name, result, localImage: path };
  } catch (error) {
    return { host: host.name, result: { ...result, ok: false, code: 1,
      stderr: error instanceof Error ? error.message : String(error) } };
  }
}

/** Self-documenting cua-driver tool list, with an optional case-insensitive
 * substring filter over its line-oriented output. */
export async function cuTools(
  cfg: FleetConfig, sel: string, filter?: string,
  deps: { run?: typeof cuRun } = {},
): Promise<CuResult> {
  const run = deps.run ?? cuRun;
  const response = await run(cfg, sel, ["list-tools"]);
  if (!filter || !response.result.ok) return response;
  const needle = filter.toLowerCase();
  return {
    ...response,
    result: {
      ...response.result,
      stdout: response.result.stdout.split("\n")
        .filter((line) => line.toLowerCase().includes(needle))
        .join("\n"),
    },
  };
}

/** Describe one cua-driver tool using the same binary-resolution and quoting
 * path as raw `fleet cu` calls. */
export async function cuDescribe(
  cfg: FleetConfig, sel: string, tool: string,
  deps: { run?: typeof cuRun } = {},
): Promise<CuResult> {
  return (deps.run ?? cuRun)(cfg, sel, ["describe", tool]);
}

export interface CdpTarget {
  id?: string;
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}
export interface BrowseResult {
  host: string;
  endpoint: string;
  version: Record<string, unknown>;
  targets: CdpTarget[];
}

/** Resolve and verify a host's configured CDP endpoint. If `url` is present,
 * ask Chromium to open it before returning the current target list. */
export async function browseHost(
  cfg: FleetConfig,
  sel: string,
  url?: string,
  deps: { fetch?: (input: string, init?: RequestInit) => Promise<Response>; timeoutMs?: number } = {},
): Promise<BrowseResult> {
  const host = resolveHosts(cfg, sel)[0]!;
  if (!host.cdp) throw new Error(
    `host ${host.name} has no CDP endpoint; add \"cdp\": \"http://host:port\" to hosts.${host.name} in fleet.config.json`,
  );
  const endpoint = host.cdp.replace(/\/+$/, "");
  const request = deps.fetch ?? fetch;
  const readJson = async (path: string, init?: RequestInit): Promise<unknown> => {
    let response: Response;
    const signal = init?.signal ?? AbortSignal.timeout(deps.timeoutMs ?? 10_000);
    try { response = await request(`${endpoint}${path}`, { ...init, signal }); }
    catch (error) {
      throw new Error(`CDP endpoint ${endpoint} did not answer ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`CDP endpoint ${endpoint} returned HTTP ${response.status} for ${path}`);
    try { return await response.json(); }
    catch { throw new Error(`CDP endpoint ${endpoint} returned invalid JSON for ${path}`); }
  };

  const version = await readJson("/json/version") as Record<string, unknown>;
  if (url) await readJson(`/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const targets = await readJson("/json/list");
  if (!Array.isArray(targets)) throw new Error(`CDP endpoint ${endpoint} returned a non-array target list`);
  return { host: host.name, endpoint, version, targets: targets as CdpTarget[] };
}

export interface CuRecordingState {
  enabled: boolean;
  output_dir: string | null;
  next_turn?: number;
  last_error?: string | null;
  last_video_path?: string | null;
  recording?: boolean;
  video_active?: boolean;
  [key: string]: unknown;
}
export interface CuRecordingStatus extends CuResult { state?: CuRecordingState; }
export interface CuRecordingStart extends CuRecordingStatus { remoteDir: string; }
export interface CuRecordingStop extends CuRecordingStatus {
  stateBefore?: CuRecordingState;
  pull?: ExecResult;
  localPaths: string[];
}

function parseRecordingState(result: ExecResult): CuRecordingState | undefined {
  if (!result.ok) return undefined;
  const value = extractJson(result.stdout);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("cua-driver returned an invalid recording state");
  return value as CuRecordingState;
}

function defaultRecordingDir(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `~/.fleet/recordings/${stamp}`;
}

export async function cuRecordStatus(
  cfg: FleetConfig, sel: string,
  deps: { run?: typeof cuRun } = {},
): Promise<CuRecordingStatus> {
  const response = await (deps.run ?? cuRun)(cfg, sel, ["get_recording_state"]);
  return { ...response, state: parseRecordingState(response.result) };
}

/** Start a persistent trajectory recording. The one-shot `start_recording`
 * tool belongs to its CLI transport and auto-stops when that process exits.
 * cua-driver's `recording start` sub-API creates the same recorder without a
 * transport owner, so a later Fleet invocation can inspect and stop it. */
export async function cuRecordStart(
  cfg: FleetConfig, sel: string, remoteDir = defaultRecordingDir(),
  deps: { run?: typeof cuRun } = {},
): Promise<CuRecordingStart> {
  const run = deps.run ?? cuRun;
  const started = await run(cfg, sel, ["recording", "start", remoteDir]);
  if (!started.result.ok) return { ...started, remoteDir };
  const response = await run(cfg, sel, ["get_recording_state"]);
  return { ...response, remoteDir, state: parseRecordingState(response.result) };
}

async function localFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(path);
    }
  };
  await walk(root);
  return files.sort();
}

/** Stop the active recorder. When `localOut` is present, capture the remote
 * output directory before stop resets state, then pull the directory contents
 * with Fleet's normal scp path. */
export async function cuRecordStop(
  cfg: FleetConfig,
  sel: string,
  localOut?: string,
  deps: {
    run?: typeof cuRun;
    pull?: typeof pullFile;
    makeDir?: (path: string) => Promise<unknown>;
    listLocalFiles?: typeof localFiles;
  } = {},
): Promise<CuRecordingStop> {
  const run = deps.run ?? cuRun;
  const beforeResponse = await run(cfg, sel, ["get_recording_state"]);
  const stateBefore = parseRecordingState(beforeResponse.result);
  const response = await run(cfg, sel, ["stop_recording", "{}"]);
  const state = parseRecordingState(response.result);
  if (!response.result.ok || !localOut) return { ...response, state, stateBefore, localPaths: [] };
  if (!stateBefore?.output_dir) throw new Error("cua-driver has no recording output directory to pull");

  await (deps.makeDir ?? (async (path) => { await mkdir(path, { recursive: true }); }))(localOut);
  const pull = await (deps.pull ?? pullFile)(cfg, sel, `${stateBefore.output_dir}/.`, localOut, true);
  if (!pull.ok) throw new Error(`could not pull recording from ${response.host}: ${pull.stderr || `scp exit ${pull.code}`}`);
  const localPaths = await (deps.listLocalFiles ?? localFiles)(localOut);
  return { ...response, state, stateBefore, pull, localPaths: localPaths.length ? localPaths : [localOut] };
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

// ── computer-use: window model, targeting, coordinate space, verified acts ───
// Everything below resolves a caller's fuzzy target ("Playnite", "Playnite.
// DesktopApp", a pid, a window title) to ONE exact (pid, window_id) and keeps
// that pair attached to every call it makes. Two facts from cua-driver drive the
// design and are worth stating once:
//
//  1. `click`/`press_key`/`hotkey`/`scroll` take `window_id` as OPTIONAL and
//     "pick the frontmost window of pid" when it is omitted. With a modal open,
//     the frontmost window IS the modal, so window-local coordinates get
//     anchored to the dialog's frame and land somewhere unrelated — the class of
//     bug that reads as "the coordinate space is inconsistent". Fleet always
//     sends an explicit window_id.
//  2. `get_window_state` downscales its screenshot to `max_image_dimension` and
//     records the resize ratio PER PID (not per window). Incoming pixel x,y are
//     multiplied by that ratio, so coordinates are in the returned PNG's space —
//     but only until the next capture of any window of the same pid. Captures
//     are therefore ordered so the targeted window is always captured LAST.

const SEP_SENTINEL = "__FLEET_SEP__";
const CAP_SENTINEL = "__FLEET_CAP__";
const END_SENTINEL = "__FLEET_END__";
const HASH_SENTINEL = "__FLEET_HASH__";

/** One top-level window, normalized across cua-driver's two reported shapes:
 *  `windows[]` (nested `bounds`) and `_legacy_windows[]` (flat x/y/width/height).
 *  `z_index` counts UP toward the front — the desktop's Program Manager is 0. */
export interface CuWindowInfo {
  window_id: number; pid: number; title: string; app_name?: string;
  x: number; y: number; width: number; height: number;
  on_screen: boolean; minimized: boolean; z_index: number;
}

/** Everything one `list_apps` + `list_windows` + `get_config` round-trip yields.
 *  Target resolution is a pure function of this, so every subcommand matches
 *  names identically and the matching is unit-testable without a host. */
export interface CuSnapshot {
  apps: CuApp[]; windows: CuWindowInfo[]; maxImageDimension: number; result: ExecResult;
}

export interface CuCaptureSize { width: number; height: number; scale: number }

/** A resolved, unambiguous target: one pid, one window, and what else that pid
 *  has on screen that could be eating the input. */
export interface CuTarget {
  pid: number;
  name: string;
  /** Which identity matched the caller's query — reported so a surprising
   *  resolution is visible instead of silent. */
  matched: "pid" | "process" | "app" | "title";
  window: CuWindowInfo;
  /** Other on-screen, non-minimized windows owned by the same pid. */
  siblings: CuWindowInfo[];
  /** Siblings sitting ABOVE the target window. On Windows these are owned
   *  popups and modal dialogs; a modal one swallows input to the parent while
   *  a capture of the parent alone still looks completely normal. */
  blockers: CuWindowInfo[];
  /** Predicted `get_window_state` screenshot size — the space `x,y` live in. */
  capture: CuCaptureSize;
}

function normalizeWindow(raw: any): CuWindowInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw.bounds && typeof raw.bounds === "object" ? raw.bounds : raw;
  const id = Number(raw.window_id);
  const pid = Number(raw.pid);
  if (!Number.isFinite(id) || !Number.isFinite(pid)) return undefined;
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    window_id: id, pid,
    title: String(raw.title ?? ""),
    app_name: raw.app_name ? String(raw.app_name) : undefined,
    x: num(b.x), y: num(b.y), width: num(b.width), height: num(b.height),
    on_screen: raw.is_on_screen !== false,
    minimized: raw.minimized === true,
    z_index: num(raw.z_index),
  };
}

/** `list_windows` output → typed windows, tolerant of all three shapes it has
 *  shipped (bare array, `{windows}`, `{_legacy_windows}`). */
export function parseCuWindows(data: any): CuWindowInfo[] {
  const rows = Array.isArray(data) ? data : data?.windows ?? data?._legacy_windows ?? [];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => { const w = normalizeWindow(r); return w ? [w] : []; });
}

/** Predict the screenshot `get_window_state` will return for a window. The
 *  driver fits the long edge to `max_image_dimension` and floors, so this is the
 *  exact pixel space `click` coordinates live in — known before any capture. */
export function cuCaptureSize(win: { width: number; height: number }, maxDim: number): CuCaptureSize {
  const long = Math.max(win.width, win.height);
  const scale = maxDim > 0 && long > maxDim ? maxDim / long : 1;
  return {
    width: Math.max(1, Math.floor(win.width * scale)),
    height: Math.max(1, Math.floor(win.height * scale)),
    scale,
  };
}

/** One round trip for everything targeting needs: the app list (display names),
 *  the full window list (process names, titles, bounds, z-order) and the driver
 *  config (the downscale ceiling). */
export async function cuSnapshot(
  cfg: FleetConfig, sel: string, deps: { exec?: typeof exec } = {},
): Promise<CuSnapshot> {
  const host = resolveHosts(cfg, sel)[0]!;
  const win = host.os === "windows";
  const { prelude, invoke } = cuaBin(host.os);
  const mark = win ? `Write-Output '${SEP_SENTINEL}'` : `echo '${SEP_SENTINEL}'`;
  // Direct calls, deliberately: their output goes straight to ssh's stdout. On
  // Windows, capturing or redirecting a cua-driver call's output costs ~600 ms
  // more per call; left uncaptured, each of these costs tens of milliseconds.
  const cmd = [prelude, `${invoke} list_apps`, mark, `${invoke} list_windows`, mark, `${invoke} get_config`]
    .join("\n");
  const result = await (deps.exec ?? exec)(host, cmd, win ? "powershell" : "bash");
  if (!result.ok) return { apps: [], windows: [], maxImageDimension: 0, result };

  const [appsRaw = "", windowsRaw = "", configRaw = ""] = result.stdout.split(SEP_SENTINEL);
  const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };
  const appData = safe(() => extractJson(appsRaw), null);
  const apps: CuApp[] = Array.isArray(appData) ? appData : appData?.apps ?? [];
  const windows = safe(() => parseCuWindows(extractJson(windowsRaw)), []);
  const maxImageDimension = safe(() => Number(extractJson(configRaw)?.max_image_dimension) || 0, 0);
  return { apps, windows, maxImageDimension, result };
}

/** Match key for a process/app name: case- and extension-insensitive, so
 *  "Playnite.DesktopApp.exe", "Playnite.DesktopApp" and "playnite" all meet. */
const stripExe = (s: string) => s.toLowerCase().replace(/\.(exe|app)$/i, "").trim();
/** The same trim WITHOUT lowercasing — display names keep the process's own
 *  capitalization, which is what the caller typed and will recognize. */
const displayName = (s: string) => s.replace(/\.(exe|app)$/i, "").trim();

/** Every name a pid answers to, gathered from BOTH sources. `list_apps` reports
 *  the display name ("Playnite") and `list_windows` the process image name
 *  ("Playnite.DesktopApp.exe") plus window titles — so a query that matches any
 *  of them resolves, instead of only whichever list a given subcommand happened
 *  to call. */
function identitiesByPid(snap: CuSnapshot): Map<number, { names: string[]; display: string; active: boolean }> {
  const byPid = new Map<number, { names: string[]; display: string; active: boolean }>();
  const add = (pid: number, name: string | undefined, display?: string, active?: boolean) => {
    if (!Number.isFinite(pid)) return;
    const entry = byPid.get(pid) ?? { names: [], display: display ?? name ?? String(pid), active: false };
    if (name) {
      for (const variant of [name, stripExe(name)]) {
        const v = variant.toLowerCase().trim();
        if (v && !entry.names.includes(v)) entry.names.push(v);
      }
    }
    if (display) entry.display = display;
    if (active) entry.active = true;
    byPid.set(pid, entry);
  };
  for (const a of snap.apps) add(a.pid, a.name, a.name, a.active === true);
  // Titles are matched separately below. Folding them in here would make a
  // title hit report itself as a process-name hit, hiding WHY a query resolved.
  for (const w of snap.windows)
    add(w.pid, w.app_name, byPid.get(w.pid)?.display ?? (displayName(w.app_name ?? "") || undefined));
  return byPid;
}

/** Pick the window Fleet will address for a pid: the biggest on-screen,
 *  non-minimized one. Deliberately NOT the frontmost — a modal dialog is
 *  frontmost and small, and anchoring window-local coordinates to it is exactly
 *  the failure this module exists to prevent. Area already separates a dialog
 *  from its parent, so equal-area windows tie-break toward the front: two
 *  document windows of the same size means the visible one is the one meant. */
function mainWindowFor(windows: CuWindowInfo[]): CuWindowInfo | undefined {
  const usable = windows.filter((w) => w.on_screen && !w.minimized && w.width > 0 && w.height > 0);
  const pool = usable.length ? usable : windows;
  return [...pool].sort((a, b) =>
    (b.width * b.height) - (a.width * a.height) || b.z_index - a.z_index)[0];
}

const overlaps = (a: CuWindowInfo, b: CuWindowInfo) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** True when `w` looks like a modal dialog over `main` rather than a second
 *  document window: above it, smaller than it, and drawn over it. */
export function cuLooksModal(main: CuWindowInfo, w: CuWindowInfo): boolean {
  return w.z_index > main.z_index
    && w.width * w.height < main.width * main.height
    && overlaps(main, w);
}

/** Resolve a fuzzy query against a snapshot. Pure — no host access.
 *  Accepts a pid, a process image name (with or without `.exe`), an app display
 *  name, or a window title, exact-first then prefix then substring. */
export function cuResolveTargetFrom(snap: CuSnapshot, query: string): CuTarget {
  const q = query.trim();
  if (!q) throw new Error("an app, process, PID, or window title is required");
  const byPid = identitiesByPid(snap);
  const windowsFor = (pid: number) => snap.windows.filter((w) => w.pid === pid);

  let pid: number | undefined;
  let matched: CuTarget["matched"] = "pid";

  if (/^\d+$/.test(q)) {
    pid = Number(q);
  } else {
    const needle = q.toLowerCase();
    const bare = stripExe(q);
    const score = (pidKey: number) => {
      const entry = byPid.get(pidKey)!;
      const titles = windowsFor(pidKey).map((w) => w.title.toLowerCase());
      const procs = entry.names;
      if (procs.some((n) => n === needle || n === bare)) return { rank: 0, how: "process" as const };
      if (titles.some((t) => t === needle)) return { rank: 1, how: "title" as const };
      if (procs.some((n) => n.startsWith(bare))) return { rank: 2, how: "process" as const };
      if (procs.some((n) => n.includes(bare))) return { rank: 3, how: "app" as const };
      if (titles.some((t) => t.includes(needle))) return { rank: 4, how: "title" as const };
      return undefined;
    };
    const ranked = [...byPid.keys()]
      .flatMap((p) => { const s = score(p); return s ? [{ pid: p, ...s }] : []; })
      .sort((a, b) => a.rank - b.rank
        || Number(windowsFor(b.pid).some((w) => w.on_screen)) - Number(windowsFor(a.pid).some((w) => w.on_screen))
        || Number(byPid.get(b.pid)!.active) - Number(byPid.get(a.pid)!.active)
        || windowsFor(b.pid).length - windowsFor(a.pid).length);
    if (ranked[0]) { pid = ranked[0].pid; matched = ranked[0].how; }
  }

  if (pid === undefined) {
    const known = [...new Set([...byPid.values()].map((e) => e.display))].sort().slice(0, 12);
    throw new Error(
      `no app, process, or window title matching "${query}"`
      + (known.length ? ` (on screen: ${known.join(", ")}…)` : "")
      + ` — try: fleet cu <host> apps  |  fleet cu <host> windows`);
  }

  const mine = windowsFor(pid);
  const titleMatches = matched === "title"
    ? mine.filter((w) => w.title.toLowerCase() === q.toLowerCase())
    : [];
  const window = mainWindowFor(matched === "title"
    ? (titleMatches.length ? titleMatches : mine.filter((w) => w.title.toLowerCase().includes(q.toLowerCase())))
    : mine);
  const name = byPid.get(pid)?.display ?? String(pid);
  if (!window) throw new Error(
    `${name} (pid ${pid}) has no top-level windows cua-driver can address`
    + ` — it may be running without a desktop window, or in another session`);

  const siblings = mine.filter((w) =>
    w.window_id !== window.window_id && w.on_screen && !w.minimized && w.width > 1 && w.height > 1);
  const blockers = siblings.filter((w) => w.z_index > window.z_index);
  return {
    pid, name, matched, window, siblings, blockers,
    capture: cuCaptureSize(window, snap.maxImageDimension),
  };
}

/** Snapshot + resolve in one call. */
export async function cuResolveTarget(
  cfg: FleetConfig, sel: string, query: string,
  deps: { snapshot?: typeof cuSnapshot; exec?: typeof exec } = {},
): Promise<{ target: CuTarget; snapshot: CuSnapshot }> {
  const snapshot = await (deps.snapshot ?? cuSnapshot)(cfg, sel, { exec: deps.exec });
  if (!snapshot.result.ok) throw new Error(
    `cua-driver could not list the desktop on ${snapshot.result.host}: `
    + (snapshot.result.stderr || snapshot.result.stdout || `exit ${snapshot.result.code}`));
  return { target: cuResolveTargetFrom(snapshot, query), snapshot };
}

/** One line naming what could be eating input, for a warning banner. */
export function cuBlockerNote(target: CuTarget): string | undefined {
  if (!target.blockers.length) return undefined;
  const describe = (w: CuWindowInfo) =>
    `${w.title || "(untitled)"} [w${w.window_id} ${w.width}x${w.height}]`
    + (cuLooksModal(target.window, w) ? " modal" : "");
  return `BLOCKED? ${target.name} owns ${target.blockers.length} window(s) above the captured one: `
    + target.blockers.map(describe).join(" · ");
}

/** Translate a caller's point into the window-local screenshot pixels `click`
 *  expects, and REFUSE anything that resolves outside the target window rather
 *  than letting it land in whatever app happens to be there. */
export function cuResolvePoint(
  target: CuTarget, x: number, y: number, space: "window" | "screen" = "window",
): { x: number; y: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y must be finite numbers");
  if (space !== "window" && space !== "screen") throw new Error("space must be window or screen");
  const { capture, window: win } = target;
  const local = space === "screen"
    ? { x: (x - win.x) * (capture.width / Math.max(1, win.width)),
        y: (y - win.y) * (capture.height / Math.max(1, win.height)) }
    : { x, y };
  const px = Math.round(local.x);
  const py = Math.round(local.y);
  if (px < 0 || py < 0 || px >= capture.width || py >= capture.height) {
    const frame = `${win.width}x${win.height} at (${win.x},${win.y})`;
    throw new Error(
      `(${x}, ${y}) in ${space} space resolves to (${px}, ${py}), outside ${target.name} `
      + `w${win.window_id} — its click space is 0..${capture.width - 1} x 0..${capture.height - 1} `
      + `(window bounds ${frame}).\n`
      + `Read coordinates off \`shot-window ${target.name} --grid\`, or pass `
      + `--space ${space === "window" ? "screen" : "window"} if they were in the other frame.`);
  }
  return { x: px, y: py };
}

/** The caption burned into every window capture, so the frame the numbers are in
 *  is never something the reader has to remember or infer. */
export function cuGridCaption(target: CuTarget): string {
  const { window: w, capture } = target;
  return `window-local px · ${target.name} · pid ${target.pid} · window_id ${w.window_id}`
    + ` · origin = this window's top-left · ${capture.width}x${capture.height}`
    + (capture.scale < 1 ? ` (window ${w.width}x${w.height} downscaled ${capture.scale.toFixed(3)}x)` : "");
}

// ── window capture (with owned popups composited in) ─────────────────────────

export interface CuCapture {
  window: CuWindowInfo;
  remotePath: string;
  localPath?: string;
  width: number; height: number;
  bounds: { x: number; y: number; width: number; height: number };
}

/** Per-capture remote block. `cuInvocation(..., outVar)` splices the shell's own
 *  temp path into the JSON, so no path has to be guessed locally.
 *  `include_accessibility_tree:false` skips the UIA walk entirely — the capture
 *  is ~2x faster and the reply is a few hundred bytes instead of a tree. */
function cuCaptureBlock(os: Host["os"], invoke: string, pid: number, windowId: number, idx: number): string {
  const json = JSON.stringify({ pid, window_id: windowId, include_accessibility_tree: false });
  if (os === "windows") return [
    `$out = Join-Path $env:TEMP ('fleet_cu_' + [guid]::NewGuid().ToString('N') + '.png')`,
    `Write-Output ('${CAP_SENTINEL}${windowId}|' + $out)`,
    `${cuWinCall("get_window_state", json, "out")} 2>&1 | Write-Output`,
    `Write-Output '${END_SENTINEL}'`,
    emitImage(os, "out", String(windowId)),
  ].join("\n");
  return [
    `out="\${TMPDIR:-/tmp}/fleet_cu_$$_${idx}.png"; rm -f "$out"`,
    `echo '${CAP_SENTINEL}${windowId}|'"$out"`,
    `${cuInvocation(["get_window_state", json], os, invoke, "out")} 2>&1`,
    `echo '${END_SENTINEL}'`,
    emitImage(os, "out", String(windowId)),
  ].join("\n");
}

function parseCaptureBlocks(stdout: string): { windowId: number; remotePath: string; body: string }[] {
  const out: { windowId: number; remotePath: string; body: string }[] = [];
  let cursor = 0;
  for (;;) {
    const start = stdout.indexOf(CAP_SENTINEL, cursor);
    if (start < 0) break;
    const headEnd = stdout.indexOf("\n", start);
    if (headEnd < 0) break;
    const head = stdout.slice(start + CAP_SENTINEL.length, headEnd).trim();
    const bar = head.indexOf("|");
    const end = stdout.indexOf(END_SENTINEL, headEnd);
    const body = stdout.slice(headEnd + 1, end < 0 ? undefined : end);
    if (bar > 0) out.push({
      windowId: Number(head.slice(0, bar)),
      remotePath: head.slice(bar + 1).trim(),
      body,
    });
    if (end < 0) break;
    cursor = end + END_SENTINEL.length;
  }
  return out;
}

function captureFromBlock(
  win: CuWindowInfo, remotePath: string, body: string, fallback: CuCaptureSize,
): CuCapture {
  let width = fallback.width, height = fallback.height;
  let bounds = { x: win.x, y: win.y, width: win.width, height: win.height };
  try {
    const json = extractJson(cuReplyText(body));
    if (Number(json?.screenshot_width) > 0) width = Number(json.screenshot_width);
    if (Number(json?.screenshot_height) > 0) height = Number(json.screenshot_height);
    const b = json?.window_bounds;
    if (b && Number.isFinite(Number(b.width))) bounds = {
      x: Number(b.x) || 0, y: Number(b.y) || 0,
      width: Number(b.width), height: Number(b.height),
    };
  } catch { /* driver printed a message instead of JSON; sizes stay predicted */ }
  return { window: win, remotePath, width, height, bounds };
}

export interface CuShotWindowResult extends CuResult {
  target: CuTarget;
  /** Back-compat with the pre-targeting shape. */
  app: CuApp;
  window: CuWindow;
  main?: CuCapture;
  composited: CuWindowInfo[];
  warning?: string;
}

/** Capture a window by pid / process name / app name / window title.
 *
 *  Owned popups and modal dialogs are captured too and composited onto the
 *  result, because a lone capture of a blocked window looks completely normal —
 *  the single most expensive failure mode this tool had. The target window is
 *  captured LAST on purpose: cua-driver's resize ratio is keyed by pid alone, so
 *  the final capture is the one that defines the click coordinate space. */
export async function cuShotWindow(
  cfg: FleetConfig, sel: string, query: string, imageOut: string,
  deps: {
    exec?: typeof exec; deliver?: typeof deliverImage; snapshot?: typeof cuSnapshot;
    composite?: typeof compositeWindows;
  } = {},
  opts: { composite?: boolean } = {},
): Promise<CuShotWindowResult> {
  const host = resolveHosts(cfg, sel)[0]!;
  const run = deps.exec ?? exec;
  const { target } = await cuResolveTarget(cfg, sel, query, { snapshot: deps.snapshot, exec: deps.exec });
  const { prelude, invoke } = cuaBin(host.os);

  const wantComposite = opts.composite !== false && target.blockers.length > 0;
  const order = [...(wantComposite ? target.blockers.slice(0, 4) : []), target.window];
  const win = host.os === "windows";
  const script = [
    win ? `$ErrorActionPreference='Continue'` : `set +e`,
    prelude,
    ...(win ? [cuWinSession()] : []),
    ...order.map((w, i) => cuCaptureBlock(host.os, invoke, target.pid, w.window_id, i)),
    ...(win ? [`Stop-FleetCua`] : []),
  ].join("\n");

  const executed = await run(host, script, win ? "powershell" : "bash");
  const { images, rest } = takeInlineImages(executed.stdout);
  const raw = { ...executed, stdout: rest };
  const blocks = parseCaptureBlocks(raw.stdout);
  const byId = new Map(blocks.map((b) => [b.windowId, b]));
  const mainBlock = byId.get(target.window.window_id);

  const app: CuApp = { name: target.name, pid: target.pid };
  const window: CuWindow = {
    window_id: target.window.window_id, title: target.window.title, pid: target.pid,
    width: target.window.width, height: target.window.height,
  };
  const fail = (stderr: string): CuShotWindowResult => ({
    host: host.name, target, app, window, composited: [],
    result: { ...raw, ok: false, code: raw.code || 1, stderr: [raw.stderr, stderr].filter(Boolean).join("\n") },
  });
  const mainBytes = images.get(String(target.window.window_id));
  if (!mainBlock || !mainBytes) return fail(
    `cua-driver produced no requested window image for ${target.name} w${target.window.window_id}`
    + (raw.stdout.trim() ? `\n${raw.stdout.trim()}` : ""));

  const main = captureFromBlock(target.window, mainBlock.remotePath, mainBlock.body, target.capture);
  // The predicted size comes from get_config; the capture just reported the real
  // one. Prefer it, so a probe and any later bounds check are exact even if the
  // config read was the part that failed.
  target.capture = { ...target.capture, width: main.width, height: main.height };
  const extras = order.slice(0, -1).flatMap((w) => {
    const b = byId.get(w.window_id);
    return b && images.has(String(w.window_id)) ? [captureFromBlock(w, b.remotePath, b.body, cuCaptureSize(w, 0))] : [];
  });

  // The script already deleted every remote capture after printing it, so
  // delivery below is local-only: no scp pull and no cleanup round trip.
  const deliver = deps.deliver ?? deliverImage;
  const warning = cuBlockerNote(target);
  try {
    const { result: pull, path } = await deliver(host, main.remotePath, imageOut, { pull: inlinePull(host, mainBytes) });
    if (!pull.ok) return fail(`image pull failed: ${pull.stderr || `scp exit ${pull.code}`}`);
    await validateImageArtifact(path);
    main.localPath = path;

    const composited: CuWindowInfo[] = [];
    for (const extra of extras) {
      const staged = `${path}.blocker-${extra.window.window_id}.png`;
      const got = await deliver(host, extra.remotePath, staged,
        { pull: inlinePull(host, images.get(String(extra.window.window_id))!) });
      if (!got.result.ok) continue;
      extra.localPath = got.path;
      if (await (deps.composite ?? compositeWindows)(path, main, extra)) composited.push(extra.window);
      await rm(got.path, { force: true }).catch(() => {});
    }

    return {
      host: host.name, target, app, window, main, composited, warning,
      result: { ...raw, stdout: "" }, localImage: path,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Paste one owned popup onto the target window's capture at its true relative
 *  position, rescaled into the target's pixel space (each capture is downscaled
 *  by its own long edge, so the two are not in the same scale). Outlined and
 *  labeled so a composited dialog is never mistaken for part of the app.
 *  Best-effort: needs python3 + Pillow, same as the grid. */
export async function compositeWindows(
  basePath: string, base: CuCapture, overlay: CuCapture,
): Promise<boolean> {
  if (!overlay.localPath) return false;
  const sx = base.width / Math.max(1, base.bounds.width);
  const sy = base.height / Math.max(1, base.bounds.height);
  const spec = JSON.stringify({
    src: overlay.localPath,
    x: Math.round((overlay.bounds.x - base.bounds.x) * sx),
    y: Math.round((overlay.bounds.y - base.bounds.y) * sy),
    w: Math.max(1, Math.round(overlay.bounds.width * sx)),
    h: Math.max(1, Math.round(overlay.bounds.height * sy)),
    label: (overlay.window.title || "dialog").slice(0, 60),
  });
  const py = `
import json, sys
from PIL import Image, ImageDraw, ImageFont
base_path, spec = sys.argv[1], json.loads(sys.argv[2])
base = Image.open(base_path).convert("RGB")
over = Image.open(spec["src"]).convert("RGB").resize((spec["w"], spec["h"]), Image.LANCZOS)
x, y = spec["x"], spec["y"]
base.paste(over, (x, y))
d = ImageDraw.Draw(base)
d.rectangle([x, y, x + spec["w"] - 1, y + spec["h"] - 1], outline=(255, 60, 60), width=3)
font = None
for cand in ("/System/Library/Fonts/Menlo.ttc",
             "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
             "/usr/share/fonts/TTF/DejaVuSansMono.ttf"):
    try: font = ImageFont.truetype(cand, 12); break
    except Exception: pass
if font is None: font = ImageFont.load_default()
tag = "composited: " + spec["label"]
l, t, r, b = font.getbbox(tag)
th = b - t
# above the popup when there is room, otherwise inside its top edge — a dialog
# that covers the whole capture would push the label off-canvas entirely.
ty = y - th - 6 if y - th - 6 >= 0 else y + 2
d.rectangle([x, ty, x + (r - l) + 8, ty + th + 6], fill=(190, 30, 30))
d.text((x + 4, ty + 3), tag, fill=(255, 255, 255), font=font)
base.save(base_path)
`;
  const proc = Bun.spawn(["python3", "-c", py, basePath, spec], { stdout: "ignore", stderr: "pipe" });
  return await proc.exited === 0;
}

// ── verified actions (before/after bitmap hash instead of "unverifiable") ────

export type CuEffect = "changed" | "no_change" | "indeterminate";

export interface CuActResult extends CuResult {
  target: CuTarget;
  /** What the window's pixels actually did — the thing cua-driver's own
   *  `effect: "unverifiable"` never tells you. */
  effect: CuEffect;
  reason?: string;
  /** cua-driver's own reply to the action call, verbatim. */
  driverOutput: string;
  /** The control the action addressed, when it was addressed by label. */
  element?: CuElement;
  /** Why the driver says the input was refused or not delivered. */
  refusal?: string;
  hashes: string[];
  payload: Record<string, unknown>;
}

function cuHashBlock(os: Host["os"], invoke: string, pid: number, windowId: number, tag: string): string {
  const json = JSON.stringify({ pid, window_id: windowId, include_accessibility_tree: false });
  const args = ["get_window_state", json];
  if (os === "windows") return [
    `$out${tag} = Join-Path $env:TEMP ('fleet_cu_' + [guid]::NewGuid().ToString('N') + '.png')`,
    `$null = (${cuWinCall("get_window_state", json, `out${tag}`)} 2>&1)`,
    `$h${tag} = if (Test-Path -LiteralPath $out${tag}) { (Get-FileHash -LiteralPath $out${tag} -Algorithm SHA256).Hash } else { '' }`,
    `Write-Output ('${HASH_SENTINEL}${tag}|' + $h${tag})`,
  ].join("\n");
  return [
    `out${tag}="\${TMPDIR:-/tmp}/fleet_cu_$$_${tag}.png"; rm -f "$out${tag}"`,
    `${cuInvocation(args, os, invoke, `out${tag}`)} >/dev/null 2>&1`,
    `h${tag}="$(_fleet_hash "$out${tag}")"`,
    `echo "${HASH_SENTINEL}${tag}|$h${tag}"`,
  ].join("\n");
}

export interface CuInputOptions {
  settleMs?: number;
  imageOut?: string;
  space?: "window" | "screen";
  point?: { x: number; y: number; space?: "window" | "screen" };
  /** Address a control by accessibility instead of by pixel. */
  element?: CuElementLocator;
}

function cuInputPayload(target: CuTarget, payload: Record<string, unknown>, opts: CuInputOptions): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("action arguments must be a JSON object");
  for (const key of ["pid", "window_id", "target"])
    if (Object.hasOwn(payload, key)) throw new Error(`${key} is supplied by Fleet; select the target by app, PID, or window title`);
  if (payload.scope !== undefined && payload.scope !== "window")
    throw new Error("verified actions require window scope");
  if (payload.from_zoom !== undefined && payload.from_zoom !== false)
    throw new Error("verified actions use full-window coordinates; use raw cu for from_zoom");
  if (opts.space !== undefined && opts.space !== "window" && opts.space !== "screen")
    throw new Error("space must be window or screen");
  const full = { ...payload };
  for (const [xKey, yKey] of [["x", "y"], ["from_x", "from_y"], ["to_x", "to_y"]] as const) {
    if (!Object.hasOwn(payload, xKey) && !Object.hasOwn(payload, yKey)) continue;
    const x = payload[xKey], y = payload[yKey];
    if (typeof x !== "number" || typeof y !== "number")
      throw new Error(`${xKey} and ${yKey} must be given together as finite numbers`);
    const point = cuResolvePoint(target, x, y, opts.space ?? "window");
    full[xKey] = point.x;
    full[yKey] = point.y;
  }
  if (opts.point) Object.assign(full, cuResolvePoint(target, opts.point.x, opts.point.y, opts.point.space ?? opts.space ?? "window"));
  return { ...full, pid: target.pid, window_id: target.window.window_id };
}

/** Run one input action against an exact (pid, window_id) and report what the
 *  window's pixels did.
 *
 *  Capture A, act, capture B. A == B is a definitive no-op in two captures. When
 *  they differ, a third capture separates "the action changed something" from
 *  "this window repaints on its own" (a clock, a spinner, playing video), which
 *  a single before/after hash would report as a false positive.
 *
 *  All of it is ONE ssh round trip; the captures are local to the host and cost
 *  ~1s each. That replaces the screenshot-after-every-action loop that
 *  `effect: "unverifiable"` forced. */
export async function cuAct(
  cfg: FleetConfig, sel: string, query: string, tool: string, payload: Record<string, unknown>,
  opts: CuInputOptions = {},
  deps: { exec?: typeof exec; deliver?: typeof deliverImage; snapshot?: typeof cuSnapshot; elements?: typeof cuElements } = {},
): Promise<CuActResult> {
  const host = resolveHosts(cfg, sel)[0]!;
  const { target } = await cuResolveTarget(cfg, sel, query, { snapshot: deps.snapshot, exec: deps.exec });
  let element: CuElement | undefined;
  if (opts.element) {
    if (opts.point || ["x", "y", "element_index", "element_token"].some((key) => Object.hasOwn(payload ?? {}, key)))
      throw new Error("address the control by element or by x,y — not both");
    // A token needs no lookup; a label costs one tree read, projected host-side.
    element = opts.element.token && !opts.element.label && !opts.element.role
      ? { index: -1, token: opts.element.token, role: "", label: "", actions: [] }
      : cuPickElement((await (deps.elements ?? cuElements)(cfg, sel, query,
        { filter: opts.element.label }, { target })).elements, opts.element);
    if (!element.token) throw new Error(`element #${element.index} has no element_token; update cua-driver`);
    payload = { ...payload, element_token: element.token };
  }
  const full = cuInputPayload(target, payload, opts);
  const result = await cuActOnTarget(host, target, tool, full, opts, deps);
  return element && element.index >= 0 ? { ...result, element } : result;
}

export const CU_BATCH_TOOLS = [
  "click", "right_click", "double_click", "drag", "scroll", "press_key", "hotkey", "type_text", "set_value", "invoke_menu",
] as const;

export interface CuBatchAction {
  tool: typeof CU_BATCH_TOOLS[number];
  args?: Record<string, unknown>;
  space?: "window" | "screen";
  delayMs?: number;
}

export interface CuBatchStep {
  index: number;
  tool: string;
  payload: Record<string, unknown>;
  status: "completed" | "failed" | "not_run" | "unconfirmed";
  code: number | null;
  driverOutput: string;
}

export interface CuBatchResult extends CuResult {
  target: CuTarget;
  effect: CuEffect;
  reason?: string;
  hashes: string[];
  actions: CuBatchStep[];
}

function cuBatchReplyCheck(os: Host["os"]): string {
  if (os === "windows") return [
    "function Test-FleetInputRefusal($body) {",
    "  try { $reply = $body | ConvertFrom-Json -ErrorAction Stop } catch { return $false }",
    "  if ($reply.jsonrpc -and $reply.error) { return $true }",
    "  if ($reply.jsonrpc -and $reply.result) { $reply = $reply.result }",
    "  if ($reply.isError -eq $true -or $reply.status -in @('refused', 'error', 'failed') -or $reply.refusal -or $reply.error) { return $true }",
    "  if ($reply.escalation.reason -in @('delivery_failed', 'background_unavailable')) { return $true }",
    "  if ($reply.structuredContent -and (Test-FleetInputRefusal ($reply.structuredContent | ConvertTo-Json -Depth 100 -Compress))) { return $true }",
    "  foreach ($part in $reply.content) { if ($part.type -eq 'text' -and (Test-FleetInputRefusal $part.text)) { return $true } }",
    "  return $false",
    "}",
  ].join("\n");
  const parser = [
    "import json, sys",
    "def refused(body):",
    "    try: value = json.loads(body)",
    "    except (ValueError, TypeError): return False",
    "    if not isinstance(value, dict): return False",
    "    if value.get('isError') is True or value.get('status') in ('refused', 'error', 'failed') or value.get('refusal') or value.get('error'): return True",
    "    escalation = value.get('escalation')",
    "    if isinstance(escalation, dict) and escalation.get('reason') in ('delivery_failed', 'background_unavailable'): return True",
    "    if refused(json.dumps(value.get('structuredContent'))): return True",
    "    return any(isinstance(part, dict) and part.get('type') == 'text' and refused(part.get('text')) for part in (value.get('content') or []))",
    "with open(sys.argv[1]) as source: sys.exit(1 if refused(source.read()) else 0)",
  ].join("\n");
  return [
    "command -v python3 >/dev/null 2>&1 || { echo 'batch input not started: python3 is required to inspect driver refusals' >&2; exit 1; }",
    `_fleet_check_reply() { python3 -c ${shellQuote(parser, os)} "$1"; }`,
  ].join("\n");
}

/** Execute an ordered input sequence on one resolved window, then observe it.
 *  Every coordinate is checked before any input. No intermediate capture can
 *  reset the driver's per-PID scale. A driver failure stops the sequence; lost
 *  confirmation is reported without retrying any potentially delivered input. */
export async function cuBatch(
  cfg: FleetConfig, sel: string, query: string, actions: CuBatchAction[],
  opts: Omit<CuInputOptions, "point"> = {},
  deps: { exec?: typeof exec; deliver?: typeof deliverImage; snapshot?: typeof cuSnapshot } = {},
): Promise<CuBatchResult> {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 100)
    throw new Error("batch requires 1 to 100 actions");
  if (opts.settleMs !== undefined && (!Number.isInteger(opts.settleMs) || opts.settleMs < 0 || opts.settleMs > 10000))
    throw new Error("settleMs must be an integer from 0 to 10000");
  let totalDelay = 0;
  for (const [index, step] of actions.entries()) {
    if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`action ${index}: expected an object`);
    for (const key of Object.keys(step))
      if (!["tool", "args", "space", "delayMs"].includes(key)) throw new Error(`action ${index}: unknown field ${key}`);
    if (!(CU_BATCH_TOOLS as readonly string[]).includes(step.tool))
      throw new Error(`action ${index}: batch supports ${CU_BATCH_TOOLS.join(", ")}; use raw cu for other tools`);
    if (step.space !== undefined && step.space !== "window" && step.space !== "screen")
      throw new Error(`action ${index}: space must be window or screen`);
    const delay = step.delayMs === undefined ? 0 : step.delayMs;
    if (!Number.isInteger(delay) || delay < 0 || delay > 10000) throw new Error(`action ${index}: delayMs must be an integer from 0 to 10000`);
    totalDelay += delay;
  }
  if (totalDelay > 60000) throw new Error("batch delays must total at most 60000 ms");
  if (new TextEncoder().encode(JSON.stringify(actions)).length > 256 * 1024)
    throw new Error("batch input exceeds 256 KiB");
  const host = resolveHosts(cfg, sel)[0]!;
  const { target } = await cuResolveTarget(cfg, sel, query, { snapshot: deps.snapshot, exec: deps.exec });
  const prepared = actions.map((step, index) => {
    try {
      const args = cuInputPayload(target, step.args === undefined ? {} : step.args, { ...opts, space: step.space ?? opts.space });
      if (step.tool === "drag" && ["from_x", "from_y", "to_x", "to_y"].some((key) => typeof args[key] !== "number"))
        throw new Error("drag requires from_x, from_y, to_x, and to_y");
      if (["click", "right_click", "double_click"].includes(step.tool)
        && args.element_index === undefined && args.element_token === undefined && args.x === undefined)
        throw new Error("click requires x/y or an accessibility element handle");
      if (step.tool === "type_text" && typeof args.text !== "string") throw new Error("type_text requires text");
      if (step.tool === "press_key" && (typeof args.key !== "string" || !args.key)) throw new Error("press_key requires key");
      if (step.tool === "hotkey" && (!Array.isArray(args.keys) || args.keys.length < 2 || args.keys.some((key) => typeof key !== "string" || !key)))
        throw new Error("hotkey requires at least two key names");
      if (step.tool === "scroll" && !["up", "down", "left", "right"].includes(String(args.direction)))
        throw new Error("scroll requires direction up, down, left, or right");
      return args;
    } catch (error) { throw new Error(`action ${index}: ${error instanceof Error ? error.message : String(error)}`); }
  });
  const { invoke } = cuaBin(host.os);
  const win = host.os === "windows";
  const marker = `__FLEET_STEP_${crypto.randomUUID().replaceAll("-", "")}__`;
  const statements = actions.flatMap((step, index) => {
    const json = JSON.stringify(prepared[index]);
    const invocation = win ? cuWinCall(step.tool, json) : cuInvocation([step.tool, json], host.os, invoke);
    const delay = step.delayMs ?? 0;
    return win ? [
      `Write-Output '${marker}${index}|start'`,
      `$global:LASTEXITCODE = 0`,
      `${invocation} 2>&1 | Tee-Object -Variable batchOutput`,
      `$batchSucceeded = $?; $batchCode = $LASTEXITCODE`,
      `if ($null -eq $batchCode) { $batchCode = 0 }; if (-not $batchSucceeded -and $batchCode -eq 0) { $batchCode = 1 }`,
      `if ($batchCode -eq 0 -and (Test-FleetInputRefusal ($batchOutput -join "\n"))) { $batchCode = 1 }`,
      `Write-Output ("\n${marker}${index}|exit|" + $batchCode)`,
      `if ($batchCode -ne 0) { $global:LASTEXITCODE = $batchCode; return }`,
      ...(delay ? [`Start-Sleep -Milliseconds ${delay}`] : []),
    ] : [
      `printf '%s\\n' '${marker}${index}|start'`,
      `batch_reply=$(mktemp) || return 1`,
      `trap 'rm -f "$batch_reply"' EXIT`,
      `{ ${invocation}; } 2>&1 | tee "$batch_reply"`,
      'batch_code=${PIPESTATUS[0]}',
      `if [ "$batch_code" -eq 0 ]; then _fleet_check_reply "$batch_reply"; batch_code=$?; fi`,
      `rm -f "$batch_reply"; trap - EXIT`,
      `printf '\\n%s%s\\n' '${marker}${index}|exit|' "$batch_code"`,
      `[ "$batch_code" -eq 0 ] || return "$batch_code"`,
      ...(delay ? [`sleep ${(delay / 1000).toFixed(3)}`] : []),
    ];
  });
  const input = win
    ? { prelude: [cuBatchReplyCheck(host.os), "function Invoke-FleetInputBatch {", ...statements, "$global:LASTEXITCODE = 0", "}"].join("\n"), invoke: "Invoke-FleetInputBatch" }
    : { prelude: [cuBatchReplyCheck(host.os), "_fleet_input_batch() {", ...statements, "return 0", "}"].join("\n"), invoke: "_fleet_input_batch" };
  let observed: CuActResult;
  try { observed = await cuActOnTarget(host, target, "batch", {}, opts, deps, input); }
  catch (error) {
    observed = { host: host.name, target, effect: "indeterminate", hashes: [], payload: {}, driverOutput: "",
      result: { host: host.name, ok: false, code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) } };
  }
  const steps: CuBatchStep[] = actions.map((step, index) => ({
    index, tool: step.tool, payload: prepared[index]!, status: "unconfirmed", code: null, driverOutput: "",
  }));
  let current: CuBatchStep | undefined;
  let stopped = /could not capture target before input|batch input not started:/.test(observed.result.stderr);
  for (const line of observed.driverOutput.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(marker)) {
      const [index, event, code] = trimmed.slice(marker.length).split("|");
      const step = steps[Number(index)];
      if (!step) continue;
      if (event === "start") current = step;
      if (event === "exit" && /^-?\d+$/.test(code ?? "")) {
        step.code = Number(code);
        step.status = step.code === 0 ? "completed" : "failed";
        if (step.code !== 0) stopped = true;
        current = undefined;
      }
    } else if (current) current.driverOutput += line + "\n";
  }
  for (const step of steps) {
    step.driverOutput = cuReplyText(step.driverOutput.trim()).trim();
    if (stopped && step.status === "unconfirmed" && step !== current) step.status = "not_run";
  }
  const confirmed = steps.every((step) => step.status === "completed");
  const result = { ...observed.result, stdout: steps.map((step) => `${step.index}: ${step.tool} ${step.status}`).join("\n"), ok: observed.result.ok && confirmed,
    code: observed.result.code || (confirmed ? 0 : 1) };
  if (steps.some((step) => step.status === "unconfirmed"))
    result.stderr = [result.stderr, "batch outcome is unconfirmed; inspect the window before issuing more input"].filter(Boolean).join("\n");
  return { host: host.name, target, effect: observed.effect, reason: observed.reason,
    hashes: observed.hashes, actions: steps, result, ...(observed.localImage ? { localImage: observed.localImage } : {}) };
}

async function cuActOnTarget(
  host: Host, target: CuTarget, tool: string, full: Record<string, unknown>,
  opts: CuInputOptions,
  deps: { exec?: typeof exec; deliver?: typeof deliverImage },
  input?: { prelude: string; invoke: string },
): Promise<CuActResult> {
  const run = deps.exec ?? exec;
  const { prelude, invoke } = cuaBin(host.os);
  const win = host.os === "windows";
  const settle = Math.max(0, Math.round(opts.settleMs ?? 400));
  if (!Number.isFinite(settle)) throw new Error("settleMs must be finite");
  const actJson = JSON.stringify(full);
  const action = input?.invoke ?? (win ? cuWinCall(tool, actJson) : cuInvocation([tool, actJson], host.os, invoke));
  const sleep = win ? `Start-Sleep -Milliseconds ${settle}` : `sleep ${(settle / 1000).toFixed(3)}`;
  const hashOf = (tag: string) => cuHashBlock(host.os, invoke, target.pid, target.window.window_id, tag);
  const wantImage = Boolean(opts.imageOut);

  const script = win ? [
    `$ErrorActionPreference='Continue'`,
    prelude,
    cuWinSession(),
    ...(input ? [input.prelude] : []),
    hashOf("A"),
    `if (-not $hA) { Write-Error 'could not capture target before input'; exit 1 }`,
    `Write-Output '${CAP_SENTINEL}act|'`,
    `$global:LASTEXITCODE = 0`,
    `${action} 2>&1`,
    `$actSucceeded = $?; $actCode = $LASTEXITCODE`,
    `if ($null -eq $actCode) { $actCode = 0 }; if (-not $actSucceeded -and $actCode -eq 0) { $actCode = 1 }`,
    `Write-Output '${END_SENTINEL}'`,
    sleep,
    hashOf("B"),
    `if ($hA -ne $hB) { ${sleep}`,
    hashOf("C"),
    `}`,
    `Stop-FleetCua`,
    `$keep = if ($outC) { $outC } else { $outB }`,
    // Hand the after-image back inline only when it was asked for; either way
    // the file is deleted here, so no call pays a round trip to clean up.
    wantImage
      ? emitImage(host.os, "keep", "after")
      : `Remove-Item -LiteralPath $keep -Force -EA SilentlyContinue`,
    `Remove-Item -LiteralPath $outA -Force -EA SilentlyContinue`,
    `if ($outC) { Remove-Item -LiteralPath $outB -Force -EA SilentlyContinue }`,
    `exit $actCode`,
  ].join("\n") : [
    `_fleet_hash() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" 2>/dev/null | cut -d' ' -f1; else shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; fi; }`,
    prelude,
    ...(input ? [input.prelude] : []),
    hashOf("A"),
    `[ -n "$hA" ] || { echo 'could not capture target before input' >&2; exit 1; }`,
    `echo '${CAP_SENTINEL}act|'`,
    `${action} 2>&1`,
    `act_code=$?`,
    `echo '${END_SENTINEL}'`,
    sleep,
    hashOf("B"),
    `keep="$outB"`,
    `if [ "$hA" != "$hB" ]; then ${sleep}`,
    hashOf("C"),
    `keep="$outC"; rm -f "$outB"`,
    `fi`,
    `rm -f "$outA"`,
    wantImage
      ? emitImage(host.os, "keep", "after")
      : `rm -f "$keep"`,
    `exit "$act_code"`,
  ].join("\n");

  const executed = await run(host, script, win ? "powershell" : "bash");
  const { images, rest } = takeInlineImages(executed.stdout);
  const raw = { ...executed, stdout: rest };
  const hash = (tag: string) => {
    const line = raw.stdout.split("\n").find((l) => l.trim().startsWith(`${HASH_SENTINEL}${tag}|`));
    return line ? line.trim().slice(HASH_SENTINEL.length + tag.length + 1) : "";
  };
  const [hA, hB, hC] = [hash("A"), hash("B"), hash("C")];
  // The action's own reply is framed by the same sentinels as a capture block,
  // with an empty path where a capture would name its PNG.
  const blocks = parseCaptureBlocks(raw.stdout);
  const body = (blocks.find((b) => !b.remotePath) ?? blocks[0])?.body.trim() ?? "";
  // A batch frames each step's reply itself and unwraps them per step.
  const driverOutput = input ? body : cuReplyText(body).trim();

  let effect: CuEffect = "indeterminate";
  let reason: string | undefined;
  if (!hA || !hB) {
    reason = "a window capture failed, so the before/after comparison could not run";
  } else if (hA === hB) {
    effect = "no_change";
  } else if (!hC) {
    reason = "the settling capture failed, so the pixel change could not be verified";
  } else if (hB !== hC) {
    reason = "the window is still repainting on its own (animation, video, a live clock)"
      + " — the pixels moved, but not provably because of this action";
  } else {
    effect = "changed";
  }

  // An exit code of 0 is not delivery: the driver reports a background input
  // the app dropped as `escalation: delivery_failed` in an otherwise normal
  // reply. Batch already stops on that; a single action fails on it too.
  const refusal = input ? undefined : cuReplyRefusal(driverOutput);
  const base: CuActResult = {
    host: host.name, target, effect, reason, driverOutput,
    ...(refusal ? { refusal } : {}),
    hashes: [hA, hB, hC].filter(Boolean),
    payload: full,
    result: refusal && raw.ok
      ? { ...raw, stdout: driverOutput, ok: false, code: 1, stderr: [raw.stderr, refusal].filter(Boolean).join("\n") }
      : { ...raw, stdout: driverOutput },
  };

  if (!opts.imageOut) return base;
  const bytes = images.get("after");
  if (!bytes) return { ...base, result: { ...base.result, ok: false, code: base.result.code || 1,
    stderr: [base.result.stderr, "cua-driver produced no requested after-image"].filter(Boolean).join("\n") } };
  try {
    const { result: pull, path } = await (deps.deliver ?? deliverImage)(host, "inline", opts.imageOut,
      { pull: inlinePull(host, bytes) });
    if (!pull.ok) return { ...base, result: { ...base.result, ok: false, code: base.result.code || pull.code || 1, stderr:
      [base.result.stderr, `image pull failed: ${pull.stderr}`].filter(Boolean).join("\n") } };
    await validateImageArtifact(path);
    return { ...base, localImage: path };
  } catch (error) {
    return { ...base, result: { ...base.result, ok: false, code: base.result.code || 1,
      stderr: [base.result.stderr, `image delivery failed: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join("\n") } };
  }
}

// ── output shaping: don't ship kilobytes that say nothing ───────────────────

/** `get_window_state` returns its full envelope even when the UIA walk found
 *  nothing — 391 KB of empty tree with `degraded: true`, `element_count: 0`. The
 *  diagnostic is the only part that carries information, and the one thing the
 *  caller most needs to know (element addressing is unavailable here, use
 *  pixels) was never stated at all. Collapse it and say so. */
export function compactCuOutput(
  args: string[], result: ExecResult,
): { result: ExecResult; suppressedBytes: number } {
  if (!result.ok || args[0] !== "get_window_state") return { result, suppressedBytes: 0 };
  let json: any;
  try { json = extractJson(result.stdout); } catch { return { result, suppressedBytes: 0 }; }
  if (!json || typeof json !== "object") return { result, suppressedBytes: 0 };

  const count = Number(json.element_count ?? json.total_element_count ?? json.returned_element_count ?? NaN);
  const degraded = json.degraded === true;
  if (!degraded && !(Number.isFinite(count) && count === 0)) return { result, suppressedBytes: 0 };

  const b = json.window_bounds ?? {};
  const lines = [
    `get_window_state: degraded — ${Number.isFinite(count) ? count : 0} accessibility elements`
    + (json.degraded_reason ? ` (${json.degraded_reason})` : ""),
    `  window: ${json.app_name ?? "?"} · pid ${json.pid ?? "?"} · window_id ${json.window_id ?? "?"}`
    + (json.window_title ? ` · ${json.window_title}` : ""),
    `  bounds: ${b.width ?? "?"}x${b.height ?? "?"} at (${b.x ?? "?"},${b.y ?? "?"})`
    + (json.screenshot_width ? ` · screenshot ${json.screenshot_width}x${json.screenshot_height}` : ""),
    json.screenshot_file_path ? `  screenshot: ${json.screenshot_file_path}` : "",
    `  element_index / element_token are UNAVAILABLE for this window. Address it with`,
    `  pixel x,y read off the screenshot (fleet cu <host> shot-window <app> --grid).`,
  ].filter(Boolean);
  const suppressedBytes = Math.max(0, result.stdout.length - lines.join("\n").length);
  return {
    result: { ...result, stdout: `${lines.join("\n")}\n  (${suppressedBytes} bytes of empty tree suppressed; --full to see it)` },
    suppressedBytes,
  };
}

/** `describe <tool>` output trimmed to what a caller needs to build one call:
 *  the name, the first sentences of the description, and the schema's field
 *  names with one-line summaries. The full text is ~2 KB of prose per tool and
 *  its advice is written for the general case, not the window in front of you. */
export function briefDescribe(
  stdout: string, opts: { elementsAvailable?: boolean } = {},
): string {
  const nameLine = stdout.split("\n").find((l) => l.trim().startsWith("name:"))?.trim() ?? "";
  const descStart = stdout.indexOf("description:");
  const schemaStart = stdout.indexOf("input_schema:");
  const prose = descStart >= 0
    ? stdout.slice(descStart + "description:".length, schemaStart < 0 ? undefined : schemaStart).trim()
    : "";
  let sentences = prose.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  // The stock prose pushes element_index hard. On a window whose UIA tree is
  // empty that advice cannot be followed at all, so when the caller has told us
  // which window they mean (and it has no tree), drop it rather than print it
  // directly under a line saying the opposite.
  const dropped = opts.elementsAvailable === false;
  if (dropped) sentences = sentences.filter((line) => !/element_index|element_token/i.test(line));
  const summary = sentences.slice(0, 3).join(" ");

  const out = [nameLine, "", summary,
    ...(dropped ? ["", "(element-addressing guidance removed: the probed window exposes no UIA tree;"
      + " use pixel x,y)"] : [])];
  if (schemaStart >= 0) {
    try {
      const schema = extractJson(stdout.slice(schemaStart));
      const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
      const props = schema?.properties ?? {};
      out.push("", `fields${required.length ? ` (required: ${required.join(", ")})` : ""}:`);
      for (const [key, value] of Object.entries<any>(props)) {
        if (dropped && /^(element_index|element_token|snapshot_id)$/.test(key)) continue;
        const type = Array.isArray(value?.enum) ? value.enum.join("|") : value?.type ?? "?";
        const one = String(value?.description ?? "").replace(/\s+/g, " ").split(/(?<=[.!?])\s/)[0] ?? "";
        out.push(`  ${key} <${type}>${one ? ` — ${one.slice(0, 110)}` : ""}`);
      }
    } catch { out.push("", stdout.slice(schemaStart).trim()); }
  }
  return out.join("\n").trim();
}

/** Whether element addressing is actually available on one window, so the
 *  advice a caller reads matches the target in front of them instead of the
 *  general case. Costs one cheap tree-only call (no screenshot). */
export async function cuElementSupport(
  cfg: FleetConfig, sel: string, query: string,
  deps: { run?: typeof cuRun; snapshot?: typeof cuSnapshot } = {},
): Promise<{ target: CuTarget; elements: number; available: boolean; note: string }> {
  const { target } = await cuResolveTarget(cfg, sel, query, { snapshot: deps.snapshot });
  const { result } = await (deps.run ?? cuRun)(cfg, sel, ["get_window_state", JSON.stringify({
    pid: target.pid, window_id: target.window.window_id, include_screenshot: false, max_elements: 40,
  })]);
  let elements = 0;
  let degraded = false;
  try {
    const json = extractJson(result.stdout);
    elements = Number(json?.total_element_count ?? json?.element_count
      ?? (Array.isArray(json?.elements) ? json.elements.length : 0)) || 0;
    degraded = json?.degraded === true;
  } catch { /* leave it at zero — treated as unavailable below */ }
  const available = elements > 0 && !degraded;
  const where = `${target.name} w${target.window.window_id}`;
  return {
    target, elements, available,
    note: available
      ? `element_index: available for ${where} (${elements}+ elements) — prefer it over pixels.`
      : `element_index: UNAVAILABLE for ${where} (UIA tree empty). Use pixel x,y; `
        + `element_index and element_token cannot resolve on this window.`,
  };
}

// ── element-first control: address controls by name, verify by state ───────
// Pixels are the fallback, not the interface. `get_window_state` without a
// screenshot returns the window's accessibility tree with one opaque
// `element_token` per actionable control, and every input tool accepts that
// token in place of x,y. The daemon keeps its element cache across separate
// CLI processes, so a token read in one Fleet call still resolves in the next
// (and survives the screenshot-only captures a verified action takes).

export interface CuElement {
  index: number;
  /** Opaque per-snapshot handle; pass it back as `element_token`. */
  token?: string;
  role: string;
  label: string;
  value?: string | null;
  enabled?: boolean;
  selected?: boolean;
  /** Accessibility patterns the control exposes: invoke, set_value, expand, … */
  actions: string[];
  /** Desktop-space bounds, as the driver reports them. */
  frame?: { x: number; y: number; w: number; h: number };
  /** Frame center in window-local screenshot pixels: the pixel fallback for a
   *  control whose accessibility action the app ignores. */
  center?: { x: number; y: number };
  depth?: number;
}

export interface CuElements extends CuResult {
  target: CuTarget;
  snapshotId?: string;
  /** Elements in the whole snapshot, before any filter projection. */
  total: number;
  elements: CuElement[];
  /** False when the accessibility walk found nothing to address. */
  available: boolean;
}

/** `get_window_state` structured output → typed elements. Pure. */
export function parseCuElements(stdout: string, target: CuTarget): Omit<CuElements, "host" | "result"> {
  let json: any;
  try { json = extractJson(stdout); } catch { return { target, total: 0, elements: [], available: false }; }
  const rows: any[] = Array.isArray(json?.elements) ? json.elements : [];
  const win = target.window;
  const elements = rows.flatMap((row): CuElement[] => {
    const index = Number(row?.element_index);
    if (!Number.isInteger(index)) return [];
    const f = row.frame && typeof row.frame === "object" ? row.frame : undefined;
    const frame = f && [f.x, f.y, f.w, f.h].every((v) => Number.isFinite(Number(v)))
      ? { x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h) } : undefined;
    let center: CuElement["center"];
    if (frame && frame.w > 0 && frame.h > 0) {
      const cx = frame.x + frame.w / 2, cy = frame.y + frame.h / 2;
      // Only a frame that sits inside the window is trusted as desktop space.
      if (cx >= win.x && cy >= win.y && cx < win.x + win.width && cy < win.y + win.height) {
        try { center = cuResolvePoint(target, cx, cy, "screen"); } catch { center = undefined; }
      }
    }
    return [{
      index,
      token: typeof row.element_token === "string" ? row.element_token : undefined,
      role: String(row.role ?? ""),
      label: String(row.label ?? ""),
      value: row.value === undefined ? undefined : row.value === null ? null : String(row.value),
      enabled: typeof row.enabled === "boolean" ? row.enabled : undefined,
      selected: typeof row.selected === "boolean" ? row.selected : undefined,
      actions: Array.isArray(row.actions) ? row.actions.map(String) : [],
      frame, center,
      depth: Number.isFinite(Number(row.depth)) ? Number(row.depth) : undefined,
    }];
  });
  const total = Number(json?.total_element_count ?? json?.element_count ?? elements.length) || 0;
  return {
    target, elements, total,
    snapshotId: typeof json?.snapshot_id === "string" ? json.snapshot_id : undefined,
    available: total > 0 && json?.degraded !== true,
  };
}

/** Read a window's addressable controls without taking a screenshot.
 *  `filter` is the driver's own case-insensitive projection, so a large tree
 *  is narrowed host-side instead of shipped whole. */
export async function cuElements(
  cfg: FleetConfig, sel: string, query: string,
  opts: { filter?: string; maxElements?: number; maxDepth?: number } = {},
  deps: { run?: typeof cuRun; snapshot?: typeof cuSnapshot; target?: CuTarget } = {},
): Promise<CuElements> {
  const target = deps.target ?? (await cuResolveTarget(cfg, sel, query, { snapshot: deps.snapshot })).target;
  const args: Record<string, unknown> = {
    pid: target.pid, window_id: target.window.window_id, include_screenshot: false,
  };
  if (opts.filter) args.query = opts.filter;
  if (opts.maxElements !== undefined) args.max_elements = opts.maxElements;
  if (opts.maxDepth !== undefined) args.max_depth = opts.maxDepth;
  const response = await (deps.run ?? cuRun)(cfg, sel, ["get_window_state", JSON.stringify(args)]);
  if (!response.result.ok) return { ...response, target, total: 0, elements: [], available: false };
  return { ...response, ...parseCuElements(response.result.stdout, target) };
}

/** How a caller names one control: its token, or its label (plus role / nth
 *  to break a tie). */
export interface CuElementLocator { token?: string; label?: string; role?: string; nth?: number }

/** Pick exactly one element, or explain why not. Exact label beats substring;
 *  an ambiguous match lists the candidates with their tokens instead of
 *  guessing, because the wrong "OK" button is worse than none. Pure. */
export function cuPickElement(elements: CuElement[], loc: CuElementLocator): CuElement {
  if (loc.token) {
    const hit = elements.find((e) => e.token === loc.token);
    if (hit) return hit;
    throw new Error(`no element with token ${loc.token} in this snapshot; list them with: fleet cu <host> elements <target>`);
  }
  const label = loc.label?.trim().toLowerCase();
  const role = loc.role?.trim().toLowerCase();
  if (!label && !role) throw new Error("an element needs a token, a label, or a role");
  const byRole = role ? elements.filter((e) => e.role.toLowerCase() === role) : elements;
  const exact = label === undefined ? byRole : byRole.filter((e) => e.label.trim().toLowerCase() === label);
  const pool = exact.length ? exact
    : label === undefined ? [] : byRole.filter((e) => e.label.toLowerCase().includes(label));
  const describe = (e: CuElement) => `${e.token ?? `#${e.index}`} ${e.role} "${e.label}"`
    + (e.enabled === false ? " (disabled)" : "");
  const what = [role && `role ${loc.role}`, label !== undefined && `label "${loc.label}"`].filter(Boolean).join(" and ");
  if (!pool.length) {
    const near = elements.slice(0, 12).map(describe).join("\n  ");
    throw new Error(`no element with ${what}` + (near ? `; some that exist:\n  ${near}` : ""));
  }
  if (loc.nth !== undefined) {
    if (!Number.isInteger(loc.nth) || loc.nth < 1 || loc.nth > pool.length)
      throw new Error(`--nth must be from 1 to ${pool.length} for ${what}`);
    return pool[loc.nth - 1]!;
  }
  if (pool.length === 1) return pool[0]!;
  throw new Error(`${pool.length} elements match ${what}; pass --role, --nth N, or --element TOKEN:\n  `
    + pool.slice(0, 12).map(describe).join("\n  "));
}

/** A driver reply that says the input was refused or never delivered, even
 *  though the process exited 0 — `escalation.reason: delivery_failed` is how a
 *  background key press that the app ignored reports itself. */
export function cuReplyRefusal(text: string): string | undefined {
  let reply: any;
  try { reply = extractJson(text); } catch { return undefined; }
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) return undefined;
  if (reply.isError === true) return "the driver returned an error";
  if (["refused", "error", "failed"].includes(reply.status)) return `the driver reported status ${reply.status}`;
  if (reply.refusal) return `the driver refused the input: ${typeof reply.refusal === "string" ? reply.refusal : JSON.stringify(reply.refusal)}`;
  const reason = reply.escalation?.reason;
  if (reason === "delivery_failed" || reason === "background_unavailable")
    return `the driver could not deliver this input in the background (${reason}); retry with --foreground`;
  return undefined;
}

export type CuVerifyStatus = "satisfied" | "unsatisfied" | "unknown";
export interface CuVerifyResult extends CuResult {
  target: CuTarget;
  status: CuVerifyStatus;
  predicates: { index: number; status: CuVerifyStatus; reason?: string; observed?: unknown }[];
  elapsedMs?: number;
}

/** Check a window's state with `verify_state` — deterministic predicates over
 *  its accessibility tree and bounds, with no screenshot to interpret. Only
 *  `satisfied` is success; `unknown` never implies it. */
export async function cuVerify(
  cfg: FleetConfig, sel: string, query: string, expect: unknown[],
  opts: { timeoutMs?: number; stableSamples?: number } = {},
  deps: { run?: typeof cuRun; snapshot?: typeof cuSnapshot } = {},
): Promise<CuVerifyResult> {
  if (!Array.isArray(expect) || expect.length < 1 || expect.length > 8)
    throw new Error("verify takes 1 to 8 predicates");
  if (opts.timeoutMs !== undefined && (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 0 || opts.timeoutMs > 10000))
    throw new Error("timeout must be an integer from 0 to 10000 ms");
  if (opts.stableSamples !== undefined && (!Number.isInteger(opts.stableSamples) || opts.stableSamples < 1 || opts.stableSamples > 5))
    throw new Error("stable samples must be an integer from 1 to 5");
  const { target } = await cuResolveTarget(cfg, sel, query, { snapshot: deps.snapshot });
  const args: Record<string, unknown> = { pid: target.pid, window_id: target.window.window_id, expect };
  if (opts.timeoutMs !== undefined) args.timeout_ms = opts.timeoutMs;
  if (opts.stableSamples !== undefined) args.stable_samples = opts.stableSamples;
  const response = await (deps.run ?? cuRun)(cfg, sel, ["verify_state", JSON.stringify(args)]);
  const fail = (why: string): CuVerifyResult => ({ ...response, target, status: "unknown", predicates: [],
    result: { ...response.result, ok: false, code: response.result.code || 1,
      stderr: [response.result.stderr, why].filter(Boolean).join("\n") } });
  if (!response.result.ok) return fail("verify_state failed");
  let json: any;
  try { json = extractJson(response.result.stdout); } catch { return fail(response.result.stdout.trim() || "verify_state returned no JSON"); }
  const known = (s: unknown): CuVerifyStatus => s === "satisfied" || s === "unsatisfied" ? s : "unknown";
  if (json?.status === undefined) return fail(response.result.stdout.trim());
  const status = known(json.status);
  const predicates = (Array.isArray(json.predicates) ? json.predicates : []).map((p: any, i: number) => {
    let observed: unknown = p?.observed_json;
    if (typeof observed === "string") { try { observed = JSON.parse(observed); } catch { /* keep the raw text */ } }
    return {
      index: Number.isInteger(p?.index) ? p.index : i,
      status: known(p?.status),
      ...(p?.unknown_reason ? { reason: String(p.unknown_reason) } : {}),
      ...(observed !== undefined && observed !== null ? { observed } : {}),
    };
  });
  return {
    ...response, target, status, predicates,
    elapsedMs: Number.isFinite(Number(json.elapsed_ms)) ? Number(json.elapsed_ms) : undefined,
    result: { ...response.result, ok: status === "satisfied", code: status === "satisfied" ? 0 : 1 },
  };
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

/** Reboot into the machine's UEFI/BIOS setup on the next boot. */
export function firmwareRebootCmd(host: Host): { cmd: string; shell: Shell } {
  if (host.os === "windows")
    return { cmd: `shutdown /r /fw /t 3 /c "fleet bios"`, shell: "powershell" };
  if (host.os === "linux")
    return {
      cmd: `nohup bash -c 'sleep 2; sudo systemctl reboot --firmware-setup' >/dev/null 2>&1 & echo firmware-reboot-scheduled`,
      shell: "bash",
    };
  throw new Error("fleet bios: macOS has no firmware setup to reboot into");
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

/** Reboot every selected UEFI host into firmware setup. Unsupported macOS
 *  entries become per-host failures so they do not block a mixed fan-out. */
export async function firmwareRebootHosts(
  cfg: FleetConfig,
  sel: string,
  deps: { exec?: typeof exec } = {},
): Promise<RebootAction[]> {
  const run = deps.exec ?? exec;
  return Promise.all(resolveHosts(cfg, sel).map(async (h) => {
    if (h.os === "mac") {
      return {
        host: h.name,
        os: h.os,
        cmd: "",
        result: {
          host: h.name,
          ok: false,
          code: 1,
          stdout: "",
          stderr: "fleet bios: macOS has no firmware setup to reboot into",
        },
      };
    }
    const { cmd, shell } = firmwareRebootCmd(h);
    return { host: h.name, os: h.os, cmd, result: await run(h, cmd, shell) };
  }));
}

// ── disk (live, every volume) ─────────────────────────────────────────────────
/** Free space per volume, queried live over ssh.
 *
 *  The dashboard collector only ever reports the *boot* volume (`C:\` / `/`), so
 *  `status` is blind to extra drives (D:, E:, spinning rust, external NVMe).
 *  This asks the host itself and returns every real, fixed volume.
 *
 *  Windows: `Get-Volume` — note `wmic` is REMOVED on current Windows, don't use it.
 *  Unix: `df -kP`, POSIX mode so the columns never wrap. */
export function diskCmd(host: Host): { cmd: string; shell: Shell } {
  if (host.os === "windows")
    return {
      shell: "powershell",
      // -Compress keeps it on one line; @(…) forces an array even for a single volume.
      cmd: `@(Get-Volume | Where-Object { $_.DriveLetter -and $_.Size -gt 0 -and $_.DriveType -eq 'Fixed' } | ForEach-Object { [pscustomobject]@{ mount = "$($_.DriveLetter):"; label = [string]$_.FileSystemLabel; total = [double]$_.Size; free = [double]$_.SizeRemaining } }) | ConvertTo-Json -Compress`,
    };
  // Only real block devices — skips tmpfs/devfs/overlay noise without an OS-specific -x list.
  return { cmd: `df -kP | awk 'NR>1 && $1 ~ /^\\/dev\\//'`, shell: "bash" };
}

export interface DiskRow {
  host: string; os: string; mount: string; label: string;
  total_gb: number; free_gb: number; pct: number;   // pct = percent USED
}

const GB = 1024 ** 3;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Parse a diskCmd's stdout. Shape differs per-OS, so the parser pairs with the command. */
export function parseDisk(host: Host, out: string): DiskRow[] {
  const base = { host: host.name, os: host.os };
  const rows: DiskRow[] = [];
  if (host.os === "windows") {
    const text = out.trim();
    if (!text) return rows;
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { return rows; }
    for (const v of [parsed].flat()) {
      const total = Number(v?.total), free = Number(v?.free);
      if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) continue;
      rows.push({ ...base, mount: String(v.mount ?? ""), label: String(v.label ?? "").trim(),
        total_gb: round1(total / GB), free_gb: round1(free / GB),
        pct: round1((total - free) / total * 100) });
    }
    return rows;
  }
  // One row per pool of shared free space, not per mountpoint — otherwise a single
  // filesystem is listed N times with N identical numbers:
  //   btrfs  — /, /home, /var/log … are all the same device (/dev/sda5)
  //   APFS   — volumes in one container get distinct devices (/dev/disk3s1, s5, s6 …)
  //            but share the container's capacity, so key on the container (/dev/disk3).
  // Linux partitions (sda5 vs sda6) are genuinely independent, so only APFS folds
  // the partition suffix away. Shortest mountpoint represents the group.
  const key = (dev: string) =>
    host.os === "mac" ? dev.replace(/^(\/dev\/disk\d+).*$/, "$1") : dev;
  const groups = new Map<string, DiskRow>();
  for (const line of out.trim().split("\n")) {
    // Filesystem 1024-blocks Used Available Capacity Mounted-on
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const totalK = Number(f[1]), freeK = Number(f[3]);
    if (!Number.isFinite(totalK) || !Number.isFinite(freeK) || totalK <= 0) continue;
    const dev = f[0]!, mount = f.slice(5).join(" ");
    const k = key(dev);
    const prev = groups.get(k);
    if (prev && prev.mount.length <= mount.length) continue;
    groups.set(k, { ...base, mount, label: dev,
      total_gb: round1(totalK / 1024 / 1024), free_gb: round1(freeK / 1024 / 1024),
      pct: round1((totalK - freeK) / totalK * 100) });
  }
  return [...groups.values()];
}

/** Every volume on every host the selector resolves to. Unreachable hosts are skipped
 *  rather than failing the batch — one dead box shouldn't hide the other seven. */
export async function diskRows(cfg: FleetConfig, sel: string): Promise<DiskRow[]> {
  const hosts = resolveHosts(cfg, sel);
  const per = await Promise.all(hosts.map(async (h) => {
    const { cmd, shell } = diskCmd(h);
    const r = await exec(h, cmd, shell);
    return r.ok ? parseDisk(h, r.stdout) : [];
  }));
  return per.flat();
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

export type ParsedRecipeStep =
  | { kind: "exec"; selector: string; command: string; wsl: boolean; cwd?: string; timeoutMs?: number }
  | { kind: "restart"; selector: string; service: string }
  | { kind: "cp"; local: string; selector: string; remote: string; recursive: boolean }
  | { kind: "logs"; selector: string; service: string; lines: number };

function recipeNumber(value: string | true | undefined, flag: string, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (value === true || !Number.isSafeInteger(parsed) || parsed < min)
    throw new Error(`${flag} needs an integer ≥ ${min} (got '${value}')`);
  return parsed;
}

/** Parse Fleet-owned flags only before the selector. The rest of an exec step is
 *  command payload and flag-looking tokens remain payload, including
 *  --wsl/--json/--raw/--cwd. */
export function parseRecipeStep(cfg: FleetConfig, step: string): ParsedRecipeStep {
  const toks = splitArgs(step);
  const sub = toks[0];
  const args = toks.slice(1);
  switch (sub) {
    case "exec": {
      const { flags, rest } = parseLeadingFlags(
        args, ["--wsl", "--json", "--raw"], ["--cwd", "--timeout"],
      );
      const [selector, ...commandTokens] = rest;
      const command = commandTokens.join(" ");
      if (!selector || !command) throw new Error(`recipe step needs 'exec [flags] <sel> <cmd>': ${step}`);
      const cwdValue = flags["--cwd"];
      if (cwdValue === true || cwdValue === "")
        throw new Error(`recipe exec --cwd needs a directory: ${step}`);
      const timeoutS = recipeNumber(flags["--timeout"], "--timeout", 0, 0);
      return {
        kind: "exec",
        selector,
        command,
        wsl: flags["--wsl"] === true,
        ...(typeof cwdValue === "string" ? { cwd: cwdValue } : {}),
        ...(flags["--timeout"] !== undefined ? { timeoutMs: timeoutS * 1000 } : {}),
      };
    }
    case "restart": {
      const [selector, service, ...extra] = args;
      if (!selector || !service || extra.length)
        throw new Error(`recipe step needs 'restart <host> <svc>': ${step}`);
      return { kind: "restart", selector, service };
    }
    case "cp": {
      const { flags, rest } = parseLeadingFlags(args, ["-r", "--recursive"], []);
      const [local, target, ...extra] = rest;
      const remote = target ? parseRemoteSpec(cfg, target) : null;
      if (!local || !remote || extra.length)
        throw new Error(`recipe step needs 'cp [-r] <local> <sel>:<remote>': ${step}`);
      return {
        kind: "cp",
        local,
        selector: remote.sel,
        remote: remote.path,
        recursive: flags["-r"] === true || flags["--recursive"] === true,
      };
    }
    case "logs": {
      const { flags, rest } = parseLeadingFlags(args, [], ["-n"]);
      const [selector, service, ...extra] = rest;
      if (!selector || !service || extra.length)
        throw new Error(`recipe step needs 'logs [-n N] <host> <svc>': ${step}`);
      return { kind: "logs", selector, service, lines: recipeNumber(flags["-n"], "-n", 30, 1) };
    }
    default:
      throw new Error(`recipe step uses unsupported subcommand '${sub ?? ""}': ${step} (recipes support exec/restart/cp/logs)`);
  }
}

/** Execute one recipe step. Recipes support the mutating subcommands only. */
async function runStep(cfg: FleetConfig, step: string): Promise<StepResult> {
  const parsed = parseRecipeStep(cfg, step);
  let results: ExecResult[];
  switch (parsed.kind) {
    case "exec": {
      const selector = await routeSelector(cfg, parsed.selector);
      results = await runExec(cfg, selector, parsed.command, {
        wsl: parsed.wsl,
        cwd: parsed.cwd,
        timeoutMs: parsed.timeoutMs,
      });
      break;
    }
    case "restart": {
      const selector = await routeSelector(cfg, parsed.selector);
      results = (await restartService(cfg, selector, parsed.service)).map((a) => a.result);
      break;
    }
    case "cp": {
      const selector = await routeSelector(cfg, parsed.selector);
      results = await pushFile(cfg, parsed.local, selector, parsed.remote, parsed.recursive);
      break;
    }
    case "logs": {
      const selector = await routeSelector(cfg, parsed.selector);
      results = (await serviceLogs(cfg, selector, parsed.service, parsed.lines)).map((a) => a.result);
      break;
    }
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
