/**
 * core — the structured action layer shared by the CLI (`cli.ts`) and the MCP
 * server (`mcp.ts`). Everything here RETURNS data and THROWS on failure (never
 * `process.exit` / `console.log`), so it is safe to call from a long-lived
 * stdio MCP process. Presentation (ANSI tables, plain text) lives in the
 * frontends; the quoting-proof shell construction lives once, here + `ssh.ts`.
 */
import { resolveHosts, REPO_ROOT } from "./config.ts";
import type { FleetConfig, Host, Service, ServiceType, Machine } from "./config.ts";
import { exec, probe, scp, scpPull, sshDiagnose, bashEsc, bashPathAssignment, psEsc } from "./ssh.ts";
import type { ExecResult, Shell } from "./ssh.ts";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createConnection } from "node:net";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
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
): Promise<ExecResult[]> {
  const hosts = resolveHosts(cfg, sel);
  // scp needs the destination directory to exist. A trailing slash states the
  // intent unambiguously, so create it instead of failing with "No such file".
  const wantsDir = /[\\/]$/.test(remote) && remote.length > 1;
  return Promise.all(hosts.map(async (h) => {
    if (wantsDir && h.transport !== "daytona") {
      const mk = h.os === "windows"
        ? `New-Item -ItemType Directory -Force -LiteralPath '${psEsc(remote)}' | Out-Null`
        : `${bashPathAssignment("d", remote)}
mkdir -p -- "$d"`;
      const r = await exec(h, mk, "auto");
      if (!r.ok) return { ...r, stderr: `could not create destination directory ${remote}: ${r.stderr.trim() || "exit " + r.code}` };
    }
    return scp(h, local, remote, recursive);
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
      ["tar", "czf", tar, "-C", sourceRoot, "--exclude", "node_modules", "--exclude", ".git", "--exclude", "dist", "--exclude", ".scratch", "."],
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

/** The official one-line cua-driver installer for one host, plus an autostart kick. */
function cuInstallCmd(os: Host["os"]): { cmd: string; shell: Shell } {
  if (os === "windows") return {
    shell: "powershell",
    cmd: `irm https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1 | iex; `
      + `& "$env:LOCALAPPDATA\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe" autostart kick`,
  };
  return {
    shell: "bash",
    cmd: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)"; `
      + `"$(command -v cua-driver || echo "$HOME/.local/bin/cua-driver")" autostart kick`,
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

const IMG_SENTINEL = "__FLEET_IMG__";

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

  // Image call: run cua with --screenshot-out-file, echo its own output, then a
  // sentinel line with the path IFF the file was actually written.
  const cmd = win
    ? [prelude,
       `$out = Join-Path $env:TEMP ('cua_' + [guid]::NewGuid().ToString('N') + '.png')`,
       `$driverOutput = @(${cuInvocation(args, host.os, invoke, "out")} 2>&1); $driverSucceeded = $?; $driverCode = $LASTEXITCODE`,
       `$driverOutput | Write-Output`,
       `if ((Test-Path -LiteralPath $out) -and (Get-Item -LiteralPath $out).Length -gt 0) { Write-Output ('${IMG_SENTINEL}' + $out) }`,
       `if (-not $driverSucceeded) { if ($null -ne $driverCode -and $driverCode -ne 0) { exit $driverCode }; exit 1 }`,
       `if ($null -ne $driverCode -and $driverCode -ne 0) { exit $driverCode }`].join("\n")
    : [prelude,
       `out="${"${TMPDIR:-/tmp}"}/cua_shot_$$_$RANDOM.png"; rm -f "$out"`,
       `${cuInvocation(args, host.os, invoke, "out")} 2>&1`,
       `driver_code=$?`,
       `if [ -s "$out" ]; then echo "${IMG_SENTINEL}$out"; fi`,
       `exit "$driver_code"`].join("\n");
  const raw = await runExec(host, cmd, shell);

  // split the sentinel out of the displayed output
  const lines = raw.stdout.split("\n");
  const imgLine = lines.find((l) => l.trim().startsWith(IMG_SENTINEL));
  const result: ExecResult = {
    ...raw,
    stdout: lines.filter((l) => !l.trim().startsWith(IMG_SENTINEL)).join("\n").trimEnd(),
  };
  if (!imgLine) return { host: host.name, result: {
    ...result, ok: false, code: result.code || 1,
    stderr: [result.stderr, "cua-driver produced no requested image"].filter(Boolean).join("\n"),
  } };

  const remote = imgLine.trim().slice(IMG_SENTINEL.length);
  try {
    if (!result.ok) return { host: host.name, result };
    const { result: pull, path } = await deliverImage(host, remote, imageOut);
    if (!pull.ok) return { host: host.name,
      result: { ...result, ok: false, code: pull.code || 1, stderr: `${result.stderr}\nimage pull failed: ${pull.stderr}`.trim() } };
    return { host: host.name, result, localImage: path };
  } catch (error) {
    return { host: host.name, result: { ...result, ok: false, code: 1,
      stderr: error instanceof Error ? error.message : String(error) } };
  } finally {
    const cleanup = rmCmd(host.os, remote);
    await runExec(host, cleanup.cmd, cleanup.shell).catch(() => {});
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
  deps: { exec?: typeof exec; deliver?: typeof deliverImage } = {},
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
    `$ErrorActionPreference='Stop'`,
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
    `$payload = @{ pid=$tpid; window_id=$w.window_id; capture_mode='vision'; screenshot_out_file=$out } | ConvertTo-Json -Compress`,
    `$err = ($payload | ${invoke} get_window_state 2>&1)`,
    `$driverSucceeded=$?; $driverCode=$LASTEXITCODE`,
    `if(-not $driverSucceeded -or ($null -ne $driverCode -and $driverCode -ne 0)){Write-Output $err; if($driverCode){exit $driverCode}; exit 1}`,
    `if ((Test-Path -LiteralPath $out) -and (Get-Item -LiteralPath $out).Length -gt 0) { Write-Output ('${IMG_SENTINEL}' + $out + '|' + $tpid + '|' + $w.window_id + '|' + $tname + '|' + $w.title) }`,
    `else { Write-Output $err; exit 4 }`,
  ].join("\n");

  const run = deps.exec ?? exec;
  const raw = await run(host, cmd, "powershell");
  const imgLine = raw.stdout.split("\n").find((l) => l.trim().startsWith(IMG_SENTINEL));
  if (!imgLine) return { host: host.name, result: {
    ...raw, ok: false, code: raw.code || 1,
    stderr: [raw.stderr, "cua-driver produced no requested window image"].filter(Boolean).join("\n"),
  }, app: { name: query, pid: 0 }, window: { window_id: 0, title: "", pid: 0 } };

  const [rpath, rpid, rwid, rname, ...rtitle] = imgLine.trim().slice(IMG_SENTINEL.length).split("|");
  const app: CuApp = { name: rname!, pid: Number(rpid) };
  const window: CuWindow = { window_id: Number(rwid), title: rtitle.join("|"), pid: Number(rpid) };
  try {
    if (!raw.ok) return { host: host.name, result: raw, app, window };
    const { result: pull, path } = await (deps.deliver ?? deliverImage)(host, rpath!, imageOut);
    if (!pull.ok) return { host: host.name, result: { ...raw, ok: false, code: pull.code || 1, stderr: `image pull failed: ${pull.stderr}` }, app, window };
    await validateImageArtifact(path);
    return { host: host.name, result: { ...raw, stdout: "" }, localImage: path, app, window };
  } catch (error) {
    return { host: host.name, result: { ...raw, ok: false, code: 1,
      stderr: error instanceof Error ? error.message : String(error) }, app, window };
  } finally {
    await run(host, `Remove-Item -LiteralPath '${psEsc(rpath!)}' -EA SilentlyContinue`, "powershell").catch(() => {});
  }
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
