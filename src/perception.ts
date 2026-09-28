/**
 * Cua Perception for `fleet cu … regions` and `click --region`. The optional
 * `cua-perception` extension parses one driver capture into text and icon
 * regions. A `capture_id` resolves only inside the MCP session that captured
 * it, so capture, parse, pick and click run in one `cua-driver mcp --socket`
 * process per remote script: Python on Linux and macOS, the kept-open
 * `cuWinSession` on Windows. A per-call CLI process gets `capture_not_found`.
 *
 * The click carries the capture's `capture_id` and x,y in that capture's
 * pixels; the driver maps them and consumes the capture, so one parse
 * authorizes at most one action. A refused capture-bound click is never
 * retried without the binding.
 */

/** Line prefix for every event the remote program prints. */
export const PV_SENTINEL = "__FLEET_PV__";

export type CuRegionKind = "text" | "icon";

export interface CuRegion {
  id: string;
  kind: CuRegionKind;
  text?: string;
  label?: string;
  confidence: number;
  interactive: boolean;
  /** Half-open rectangle in the capture's pixels, top-left origin. */
  bounds: { x: number; y: number; width: number; height: number };
  /** The point a region click sends, in the same pixels. */
  center: { x: number; y: number };
}

export interface CuRegionParse {
  captureId: string;
  width: number;
  height: number;
  regions: CuRegion[];
  parser?: string;
  durationMs?: number;
  warnings: string[];
}

export interface CuRegionError { code: string; message: string; retryable?: boolean; detail?: string }

export interface CuRegionParseOptions {
  kinds?: CuRegionKind[];
  minConfidence?: number;
  maxRegions?: number;
}

/** How a caller names one region: its OCR text, or a point inside it in the
 *  capture's pixels, plus kind and nth to break a tie. Region ids and OCR
 *  output change between parses of the same window, so a region read from an
 *  earlier listing is named by where it was, not by its id. */
export interface CuRegionLocator { text?: string; at?: { x: number; y: number }; kind?: CuRegionKind; nth?: number }

export function validateRegionOptions(opts: CuRegionParseOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (opts.kinds !== undefined) {
    if (!opts.kinds.length || opts.kinds.length > 2 || new Set(opts.kinds).size !== opts.kinds.length
      || opts.kinds.some((k) => k !== "text" && k !== "icon"))
      throw new Error("kinds must be text, icon, or both, each once");
    out.kinds = opts.kinds;
  }
  if (opts.minConfidence !== undefined) {
    if (!Number.isFinite(opts.minConfidence) || opts.minConfidence < 0 || opts.minConfidence > 1)
      throw new Error("min confidence must be a number from 0 to 1");
    out.min_confidence = opts.minConfidence;
  }
  if (opts.maxRegions !== undefined) {
    if (!Number.isInteger(opts.maxRegions) || opts.maxRegions < 1 || opts.maxRegions > 1000)
      throw new Error("max regions must be an integer from 1 to 1000");
    out.max_regions = opts.maxRegions;
  }
  return out;
}

export function validateRegionLocator(loc: CuRegionLocator): void {
  if (!loc.text?.trim() && !loc.at) throw new Error("a region needs its text or a point inside it");
  if (loc.text !== undefined && loc.at !== undefined) throw new Error("name a region by text or by point, not both");
  if (loc.at && ![loc.at.x, loc.at.y].every((v) => Number.isInteger(v) && v >= 0))
    throw new Error("a region point needs non-negative integer x,y in the capture's pixels");
  if (loc.kind !== undefined && loc.kind !== "text" && loc.kind !== "icon") throw new Error("region kind must be text or icon");
  if (loc.nth !== undefined && (!Number.isInteger(loc.nth) || loc.nth < 1)) throw new Error("--nth must be a positive integer");
}

/** A JSON-RPC envelope or a bare payload → the tool's structured payload. */
function payloadOf(value: any): any {
  if (value?.jsonrpc) {
    if (value.error) return { code: "rpc_error", message: String(value.error.message ?? JSON.stringify(value.error)) };
    const result = value.result ?? {};
    if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
    const text = (Array.isArray(result.content) ? result.content : [])
      .filter((p: any) => p?.type === "text").map((p: any) => String(p.text)).join("\n");
    try { return JSON.parse(text); } catch { return { code: result.isError ? "tool_error" : "unexpected_reply", message: text } }
  }
  return value;
}

function asError(p: any): CuRegionError | undefined {
  if (p && typeof p === "object" && !Array.isArray(p.regions) && typeof p.code === "string")
    return { code: p.code, message: String(p.message ?? p.code), retryable: p.retryable === true,
      ...(typeof p.detail === "string" ? { detail: p.detail } : {}) };
  return undefined;
}

/** `parse_visual_regions` reply → typed regions, or the driver's error. Pure. */
export function parseRegionReply(reply: unknown): CuRegionParse | CuRegionError {
  const p = payloadOf(reply);
  const error = asError(p);
  if (error) return error;
  if (!p || !Array.isArray(p.regions)) return { code: "unexpected_reply", message: "parse_visual_regions returned no regions array" };
  const regions: CuRegion[] = p.regions.flatMap((r: any): CuRegion[] => {
    const b = r?.bounds;
    if (typeof r?.id !== "string" || (r.kind !== "text" && r.kind !== "icon") || !b
      || ![b.x, b.y, b.width, b.height].every((v) => Number.isInteger(v) && v >= 0) || b.width < 1 || b.height < 1) return [];
    return [{
      id: r.id, kind: r.kind,
      ...(typeof r.text === "string" ? { text: r.text } : {}),
      ...(typeof r.label === "string" ? { label: r.label } : {}),
      confidence: Number(r.confidence) || 0,
      interactive: r.interactive === true,
      bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      center: regionCenter(b),
    }];
  });
  const shot = p.capture?.screenshot ?? {};
  return {
    captureId: String(p.capture?.capture_id ?? ""),
    width: Number(shot.width) || 0, height: Number(shot.height) || 0,
    regions,
    ...(p.parser ? { parser: `${p.parser.extension_id ?? "cua-perception"} ${p.parser.extension_version ?? "?"} · ${p.parser.model_id ?? "?"}` } : {}),
    ...(Number.isFinite(Number(p.timing?.duration_ms)) ? { durationMs: Number(p.timing.duration_ms) } : {}),
    warnings: Array.isArray(p.warnings) ? p.warnings.map((w: any) => String(w?.message ?? w?.code ?? w)) : [],
  };
}

/** The pixel inside a half-open rectangle nearest its middle. */
export function regionCenter(b: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return { x: b.x + Math.floor((b.width - 1) / 2), y: b.y + Math.floor((b.height - 1) / 2) };
}

function norm(s: string | undefined): string {
  return (s ?? "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/** Pick exactly one region, or explain why not. The same rule runs remotely
 *  (`REGION_PY`, `regionPs`) between the parse and the click; keep the three
 *  in step. Text matches OCR text only: an icon's label is a detector class
 *  such as `icon-class-0`, not a name. Exact text beats substring. A point
 *  picks the smallest region containing it; a tie for smallest is ambiguous.
 *  Pure. */
export function cuPickRegion(regions: CuRegion[], loc: CuRegionLocator): CuRegion {
  validateRegionLocator(loc);
  const pool = loc.kind ? regions.filter((r) => r.kind === loc.kind) : regions;
  let hits: CuRegion[];
  let what: string;
  let tie = false;
  if (loc.at) {
    const { x, y } = loc.at;
    const area = (r: CuRegion) => r.bounds.width * r.bounds.height;
    hits = pool.filter((r) => x >= r.bounds.x && x < r.bounds.x + r.bounds.width && y >= r.bounds.y && y < r.bounds.y + r.bounds.height)
      .sort((a, b) => area(a) - area(b));
    tie = hits.length > 1 && area(hits[0]!) === area(hits[1]!);
    what = `a region at ${x},${y}`;
  } else {
    const q = norm(loc.text);
    const exact = pool.filter((r) => norm(r.text) === q);
    hits = exact.length ? exact : pool.filter((r) => r.text !== undefined && norm(r.text).includes(q));
    what = `text ${JSON.stringify(loc.text)}`;
  }
  if (loc.kind) what += ` (${loc.kind})`;
  if (!hits.length) throw new Error(`no region ${loc.at ? "contains" : "with"} ${loc.at ? what.replace(/^a region at /, "") : what}` + (pool.length
    ? `; some that exist:\n  ${pool.slice(0, 12).map(describeRegion).join("\n  ")}` : ""));
  if (loc.nth !== undefined) {
    if (loc.nth > hits.length) throw new Error(`--nth must be from 1 to ${hits.length} for ${what}`);
    return hits[loc.nth - 1]!;
  }
  if (hits.length === 1 || (loc.at && !tie)) return hits[0]!;
  throw new Error(`${hits.length} regions match ${what}; pass --nth N${loc.at ? "" : " or --region-at X,Y"}:\n  `
    + hits.slice(0, 12).map(describeRegion).join("\n  "));
}

export function describeRegion(r: CuRegion): string {
  const name = r.kind === "text" ? JSON.stringify(r.text ?? "") : r.label ?? "icon";
  return `${r.id} ${r.kind} ${name} ${r.bounds.width}x${r.bounds.height}@${r.bounds.x},${r.bounds.y} conf ${r.confidence.toFixed(2)}`;
}

/** What to do next for each documented parse error code. */
export function regionErrorHint(code: string, host: string): string | undefined {
  switch (code) {
    case "not_installed": return `the cua-perception extension is not installed; install it with: fleet cu ${host} perception install`;
    case "unknown_tool": case "tool_not_found":
      return `this cua-driver has no parse_visual_regions; update it with: fleet cu ${host} install`;
    case "session_unavailable": return "fleet could not open a cua-driver mcp session to the daemon; capture IDs only resolve inside one session";
    case "capture_not_found": case "capture_expired": case "capture_stale": case "capture_generation_mismatch":
      return "the capture is gone; run the command again for a fresh capture";
    case "unsupported_target": case "unsupported_platform":
      return "perception cannot parse this target; use elements or shot-window --grid";
    case "incompatible_protocol": case "artifact_invalid":
      return `stop using the extension and check it: fleet cu ${host} perception status`;
    case "invalid_frame": case "resource_limit_exceeded": return "narrow the request with --kinds or --max";
    case "worker_launch_failed": case "worker_crashed": case "worker_cancelled": case "timeout": case "inference_failed":
      return "the parse failed; nothing was clicked. Run it again";
    default: return undefined;
  }
}

/** The remote program's event lines, in order. */
export interface RegionEvents {
  capture?: any;
  regions?: CuRegionParse | CuRegionError;
  pick?: { region?: CuRegion; error?: string };
  click?: string;
  error?: CuRegionError;
}

export function parseRegionEvents(stdout: string): RegionEvents {
  const out: RegionEvents = {};
  for (const line of stdout.split("\n")) {
    const at = line.indexOf(PV_SENTINEL);
    if (at < 0) continue;
    const rest = line.slice(at + PV_SENTINEL.length);
    const bar = rest.indexOf("|");
    const kind = rest.slice(0, bar), body = rest.slice(bar + 1).trim();
    let value: any;
    try { value = JSON.parse(body); } catch { value = body; }
    if (kind === "capture") out.capture = payloadOf(value);
    else if (kind === "regions") out.regions = parseRegionReply(value);
    else if (kind === "click") out.click = body;
    else if (kind === "error") out.error = asError(value) ?? { code: "error", message: String(body) };
    else if (kind === "pick") {
      const region = value?.region ? parseRegionReply({ regions: [value.region] }) : undefined;
      out.pick = region && "regions" in region && region.regions[0] ? { region: region.regions[0] } : { error: String(value?.error ?? body) };
    }
  }
  return out;
}

/** Config the remote program reads from its first argument (base64 JSON). */
export interface RegionProgramConfig {
  pid: number;
  window_id: number;
  options: Record<string, unknown>;
  /** Screenshot path for the listing's image. Remote scripts supply it: the
   *  third argv on POSIX, `$fleetRegionShot` on Windows. */
  shot?: string;
  pick?: CuRegionLocator;
  /** The prepared input call; the program adds x, y and capture_id. */
  click?: { tool: string; args: Record<string, unknown> };
}

/** Python 3 program: one `cua-driver mcp --socket` session that captures the
 *  window, parses it, and, when asked, picks one region and clicks it with the
 *  capture's id. argv: cua-driver path, base64 config, optional screenshot
 *  path. A lost session after
 *  the click was sent reports the outcome as unknown and never resends. */
export const REGION_PY = String.raw`
import base64, json, os, subprocess, sys, threading
S = "${PV_SENTINEL}"
def emit(kind, value):
    sys.stdout.write(S + kind + "|" + (value if isinstance(value, str) else json.dumps(value)) + "\n"); sys.stdout.flush()
def fail(code, message, rc=3):
    emit("error", {"code": code, "message": message}); sys.exit(rc)
fcd, cfg = sys.argv[1], json.loads(base64.b64decode(sys.argv[2]).decode())
if len(sys.argv) > 3: cfg["shot"] = sys.argv[3]
sock = None
try:
    for line in subprocess.run([fcd, "status"], capture_output=True, text=True, timeout=20).stdout.splitlines():
        if line.strip().startswith("socket:"): sock = line.split(":", 1)[1].strip(); break
except Exception: pass
if not sock: fail("session_unavailable", "cua-driver status names no daemon socket; is the daemon running?")
try:
    p = subprocess.Popen([fcd, "mcp", "--socket", sock], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
except OSError as e: fail("session_unavailable", str(e))
watchdog = threading.Timer(150, p.kill); watchdog.daemon = True; watchdog.start()
n = [0]
def call(method, params):
    n[0] += 1
    try:
        p.stdin.write((json.dumps({"jsonrpc": "2.0", "id": n[0], "method": method, "params": params}) + "\n").encode()); p.stdin.flush()
    except OSError: return None
    while True:
        line = p.stdout.readline()
        if not line: return None
        try: m = json.loads(line)
        except ValueError: continue
        if m.get("id") == n[0]: return m
def tool(name, args): return call("tools/call", {"name": name, "arguments": args})
def payload(reply):
    r = (reply or {}).get("result") or {}
    sc = r.get("structuredContent")
    if isinstance(sc, dict): return sc
    text = "\n".join(c.get("text", "") for c in r.get("content") or [] if c.get("type") == "text")
    try: return json.loads(text)
    except ValueError: return {"code": "tool_error" if r.get("isError") else "unexpected_reply", "message": text}
def done(rc):
    try: p.stdin.close(); p.wait(3)
    except Exception: pass
    os._exit(rc)
init = call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "fleet", "version": "1"}})
if not init or "result" not in init: p.kill(); fail("session_unavailable", "cua-driver mcp did not initialize")
p.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); p.stdin.flush()
cap_args = {"pid": cfg["pid"], "window_id": cfg["window_id"], "include_accessibility_tree": False}
if cfg.get("shot"): cap_args["screenshot_out_file"] = cfg["shot"]
cap = tool("get_window_state", cap_args)
if cap is None: emit("error", {"code": "session_unavailable", "message": "the session closed during the capture"}); done(3)
cp = payload(cap)
emit("capture", {k: cp.get(k) for k in ("capture_id", "screenshot_width", "screenshot_height", "window_bounds", "code", "message")})
if not cp.get("capture_id"):
    emit("error", {"code": cp.get("code") or "capture_failed", "message": cp.get("message") or "get_window_state returned no capture_id"}); done(3)
parsed = tool("parse_visual_regions", {"capture_id": cp["capture_id"], "options": cfg.get("options") or {}})
if parsed is None: emit("error", {"code": "session_unavailable", "message": "the session closed during the parse"}); done(3)
emit("regions", json.dumps(parsed, separators=(",", ":")))
pp = payload(parsed)
if not isinstance(pp.get("regions"), list): done(3)
pick = cfg.get("pick")
if not pick: done(0)
def norm(s): return " ".join((s or "").lower().split())
pool = [r for r in pp["regions"] if not pick.get("kind") or r.get("kind") == pick["kind"]]
tie = False
if pick.get("at"):
    x, y = pick["at"]["x"], pick["at"]["y"]
    area = lambda r: r["bounds"]["width"] * r["bounds"]["height"]
    hits = sorted([r for r in pool if r["bounds"]["x"] <= x < r["bounds"]["x"] + r["bounds"]["width"] and r["bounds"]["y"] <= y < r["bounds"]["y"] + r["bounds"]["height"]], key=area)
    tie = len(hits) > 1 and area(hits[0]) == area(hits[1])
else:
    q = norm(pick.get("text"))
    hits = [r for r in pool if norm(r.get("text")) == q] or [r for r in pool if isinstance(r.get("text"), str) and q in norm(r.get("text"))]
nth = pick.get("nth")
if nth is not None and not 1 <= nth <= len(hits): chosen = None
elif nth is not None: chosen = hits[nth - 1]
elif len(hits) == 1 or (pick.get("at") and hits and not tie): chosen = hits[0]
else: chosen = None
if chosen is None:
    emit("pick", {"error": "no region matched" if not hits else "%d regions matched" % len(hits)}); done(4)
emit("pick", {"region": chosen})
b = chosen["bounds"]
args = dict(cfg["click"]["args"])
args.update({"x": b["x"] + (b["width"] - 1) // 2, "y": b["y"] + (b["height"] - 1) // 2, "capture_id": cp["capture_id"]})
reply = tool(cfg["click"]["tool"], args)
if reply is None: emit("error", {"code": "session_lost", "message": "the session closed during the click; its outcome is unknown"}); done(1)
emit("click", json.dumps(reply, separators=(",", ":")))
r = reply.get("result") or {}
done(1 if reply.get("error") or r.get("isError") else 0)
`;

/** The same program for Windows, run inside a `cuWinSession` script. Defines
 *  `Invoke-FleetRegions <base64 config>`; `$LASTEXITCODE` follows the Python
 *  program's codes. The listing's image path is `$fleetRegionShot`. */
export function regionPs(): string {
  const S = PV_SENTINEL;
  return [
    `function Write-FleetPv([string]$kind, [string]$body) { Write-Output ('${S}' + $kind + '|' + $body) }`,
    `function Get-FleetPayload($line) {`,
    `  try { $m = $line | ConvertFrom-Json -ErrorAction Stop } catch { return $null }`,
    `  if ($m.result.structuredContent) { return $m.result.structuredContent }`,
    `  $t = (@($m.result.content) | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join [char]10`,
    `  try { return ($t | ConvertFrom-Json -ErrorAction Stop) } catch { return [pscustomobject]@{ code = 'unexpected_reply'; message = $t } }`,
    `}`,
    `function Get-FleetNorm($s) { if ($null -eq $s) { return '' }; return ((([string]$s).ToLowerInvariant() -split '\\s+') | Where-Object { $_ }) -join ' ' }`,
    `function Invoke-FleetRegions([string]$b64) {`,
    `  $cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) | ConvertFrom-Json`,
    `  if ($script:fcuCli -or -not $script:fcuP) { Write-FleetPv 'error' '{"code":"session_unavailable","message":"cua-driver mcp did not start; capture IDs only resolve inside one session"}'; $global:LASTEXITCODE = 3; return }`,
    `  $capArgs = '{"pid":' + $cfg.pid + ',"window_id":' + $cfg.window_id + ',"include_accessibility_tree":false'`,
    `  if ($fleetRegionShot) { $capArgs += ',"screenshot_out_file":"' + ($fleetRegionShot -replace '\\\\','\\\\') + '"' }`,
    `  $cap = Send-FleetCua 'tools/call' ('{"name":"get_window_state","arguments":' + $capArgs + '}}')`,
    `  if ($null -eq $cap) { $script:fcuP = $null; Write-FleetPv 'error' '{"code":"session_unavailable","message":"the session closed during the capture"}'; $global:LASTEXITCODE = 3; return }`,
    `  $cp = Get-FleetPayload $cap`,
    `  Write-FleetPv 'capture' (@{ capture_id = $cp.capture_id; screenshot_width = $cp.screenshot_width; screenshot_height = $cp.screenshot_height; code = $cp.code; message = $cp.message } | ConvertTo-Json -Compress)`,
    `  if (-not $cp.capture_id) { Write-FleetPv 'error' (@{ code = $(if ($cp.code) { $cp.code } else { 'capture_failed' }); message = $(if ($cp.message) { $cp.message } else { 'get_window_state returned no capture_id' }) } | ConvertTo-Json -Compress); $global:LASTEXITCODE = 3; return }`,
    `  $opts = if ($cfg.options) { $cfg.options | ConvertTo-Json -Compress -Depth 5 } else { '{}' }`,
    `  $parsed = Send-FleetCua 'tools/call' ('{"name":"parse_visual_regions","arguments":{"capture_id":"' + $cp.capture_id + '","options":' + $opts + '}}')`,
    `  if ($null -eq $parsed) { $script:fcuP = $null; Write-FleetPv 'error' '{"code":"session_unavailable","message":"the session closed during the parse"}'; $global:LASTEXITCODE = 3; return }`,
    `  Write-FleetPv 'regions' $parsed`,
    `  $pp = Get-FleetPayload $parsed`,
    `  if ($null -eq $pp -or $null -eq $pp.regions) { $global:LASTEXITCODE = 3; return }`,
    `  if (-not $cfg.pick) { $global:LASTEXITCODE = 0; return }`,
    `  $pool = @($pp.regions | Where-Object { -not $cfg.pick.kind -or $_.kind -eq $cfg.pick.kind })`,
    `  $tie = $false`,
    `  if ($cfg.pick.at) {`,
    `    $px = [int]$cfg.pick.at.x; $py = [int]$cfg.pick.at.y`,
    `    $hits = @($pool | Where-Object { $px -ge [int]$_.bounds.x -and $px -lt ([int]$_.bounds.x + [int]$_.bounds.width) -and $py -ge [int]$_.bounds.y -and $py -lt ([int]$_.bounds.y + [int]$_.bounds.height) } | Sort-Object { [int]$_.bounds.width * [int]$_.bounds.height })`,
    `    $tie = $hits.Count -gt 1 -and ([int]$hits[0].bounds.width * [int]$hits[0].bounds.height) -eq ([int]$hits[1].bounds.width * [int]$hits[1].bounds.height)`,
    `  } else {`,
    `    $q = Get-FleetNorm $cfg.pick.text`,
    `    $hits = @($pool | Where-Object { (Get-FleetNorm $_.text) -eq $q })`,
    `    if (-not $hits.Count) { $hits = @($pool | Where-Object { $null -ne $_.text -and (Get-FleetNorm $_.text).Contains($q) }) }`,
    `  }`,
    `  $nth = $cfg.pick.nth; $chosen = $null`,
    `  if ($null -ne $nth) { if ($nth -ge 1 -and $nth -le $hits.Count) { $chosen = $hits[$nth - 1] } } elseif ($hits.Count -eq 1 -or ($cfg.pick.at -and $hits.Count -and -not $tie)) { $chosen = $hits[0] }`,
    `  if ($null -eq $chosen) { Write-FleetPv 'pick' (@{ error = $(if ($hits.Count) { '' + $hits.Count + ' regions matched' } else { 'no region matched' }) } | ConvertTo-Json -Compress); $global:LASTEXITCODE = 4; return }`,
    `  Write-FleetPv 'pick' (@{ region = $chosen } | ConvertTo-Json -Compress -Depth 5)`,
    `  $b = $chosen.bounds`,
    `  $x = [int]$b.x + [Math]::Floor(([int]$b.width - 1) / 2); $y = [int]$b.y + [Math]::Floor(([int]$b.height - 1) / 2)`,
    `  $clickArgs = ($cfg.click.args | ConvertTo-Json -Compress -Depth 10).TrimEnd('}') + ',"x":' + $x + ',"y":' + $y + ',"capture_id":"' + $cp.capture_id + '"}'`,
    `  $reply = Send-FleetCua 'tools/call' ('{"name":"' + $cfg.click.tool + '","arguments":' + $clickArgs + '}')`,
    `  if ($null -eq $reply) { $script:fcuP = $null; Write-FleetPv 'error' '{"code":"session_lost","message":"the session closed during the click; its outcome is unknown"}'; $global:LASTEXITCODE = 1; return }`,
    `  Write-FleetPv 'click' $reply`,
    `  $global:LASTEXITCODE = if ($reply -match '^\\s*\\{"jsonrpc":"2\\.0","id":\\d+,"error"' -or $reply -match '(?<!\\\\)"isError":\\s*true') { 1 } else { 0 }`,
    `}`,
  ].join("\n");
}

export function encodeRegionConfig(cfg: RegionProgramConfig): string {
  return Buffer.from(JSON.stringify(cfg), "utf8").toString("base64");
}

/** Release target triple per OS/arch, as the cua-perception release names it. */
export const PERCEPTION_TARGETS = {
  mac: "aarch64-apple-darwin",
  linux: "x86_64-unknown-linux-gnu",
  windows: "x86_64-pc-windows-msvc",
} as const;

/** Remote script for `fleet cu <host> perception install|status|remove`.
 *  Install resolves the newest `cua-perception-v*` release (or `version`),
 *  downloads the catalog, archive and SHA256SUMS into a cache directory on the
 *  host, checks the hashes, refuses a catalog that `inspect` does not report
 *  as publisher-verified, installs, and runs the self-test. A partial download
 *  resumes. */
export function perceptionScript(
  os: "linux" | "mac" | "windows", action: "install" | "status" | "remove", version?: string,
): string {
  if (version !== undefined && !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/.test(version))
    throw new Error(`version must look like 0.2.1 (got '${version}')`);
  const api = "https://api.github.com/repos/trycua/cua/releases?per_page=100";
  const dl = "https://github.com/trycua/cua/releases/download";
  if (os === "windows") {
    const pre = [
      `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'`,
      `$fcd = (Get-Command cua-driver -EA SilentlyContinue).Source; if (-not $fcd) { $fcd = Join-Path $env:LOCALAPPDATA 'Programs\\Cua\\cua-driver\\bin\\cua-driver.exe' }`,
      `if (-not (Test-Path -LiteralPath $fcd)) { Write-Output 'cua-driver is not installed'; exit 1 }`,
      `& $fcd --version`,
    ];
    if (action === "status") return [...pre,
      `& $fcd extension status cua-perception; if ($LASTEXITCODE) { exit $LASTEXITCODE }`].join("\n");
    if (action === "remove") return [...pre,
      `& $fcd extension remove cua-perception; exit $LASTEXITCODE`].join("\n");
    return [...pre,
      `if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { Write-Output 'cua-perception ships Windows x64 only'; exit 1 }`,
      version ? `$ver = '${version}'`
        : `$ver = ((Invoke-RestMethod -UseBasicParsing '${api}') | Where-Object { $_.tag_name -like 'cua-perception-v*' } | Select-Object -First 1).tag_name -replace '^cua-perception-v', ''`,
      `if (-not $ver) { Write-Output 'no cua-perception release found'; exit 1 }`,
      `$t = 'cua-perception-' + $ver + '-${PERCEPTION_TARGETS.windows}'`,
      `$dir = Join-Path $env:LOCALAPPDATA ('cua-perception\\' + $ver); New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
      `$base = '${dl}/cua-perception-v' + $ver`,
      `foreach ($f in @('SHA256SUMS', "$t.catalog.json", "$t.tar.gz")) {`,
      `  $dest = Join-Path $dir $f`,
      `  if ((Test-Path -LiteralPath $dest) -and $f -eq "$t.tar.gz") { Write-Output "fleet: $f already downloaded; checking it" } else {`,
      `    Write-Output "fleet: downloading $f"; & curl.exe -fL --retry 3 -sS -o $dest "$base/$f"; if ($LASTEXITCODE) { Write-Output "download failed: $f"; exit 1 } }`,
      `}`,
      `$sums = Get-Content -LiteralPath (Join-Path $dir 'SHA256SUMS')`,
      `foreach ($f in @("$t.catalog.json", "$t.tar.gz")) {`,
      `  $want = ($sums | Where-Object { $_ -match ('\\s\\*?' + [regex]::Escape($f) + '$') } | Select-Object -First 1) -replace '\\s.*$', ''`,
      `  $have = (Get-FileHash -LiteralPath (Join-Path $dir $f) -Algorithm SHA256).Hash`,
      `  if (-not $want -or $have -ne $want) { Remove-Item -LiteralPath (Join-Path $dir $f) -Force; Write-Output "fleet: $f failed its SHA256SUMS check and was deleted"; exit 1 }`,
      `  Write-Output "fleet: $f matches SHA256SUMS"`,
      `}`,
      `$cat = Join-Path $dir "$t.catalog.json"`,
      `$inspect = @(& $fcd extension inspect cua-perception --catalog $cat 2>&1 | ForEach-Object { "$_" })`,
      `$inspect | Where-Object { $_ -match '^(Extension|Trust|Publisher signature|Destination|Installed size|License):' }`,
      `if (-not ($inspect -match '^Trust: publisher-verified')) { Write-Output 'fleet: the catalog is not publisher-verified; not installing'; exit 1 }`,
      `$active = @(& $fcd extension status cua-perception 2>$null) | Where-Object { $_ -match '^Active version:' } | Select-Object -First 1`,
      `$active = if ($active) { ($active -replace '^Active version:\s*', '').Trim() } else { '' }`,
      `if ($active -eq $ver) { Write-Output "fleet: cua-perception $ver is already installed" } else {`,
      `  $verb = if ($active) { 'update' } else { 'install' }`,
      `  $out = @(& $fcd extension $verb cua-perception --catalog $cat 2>&1 | ForEach-Object { "$_" }); $code = $LASTEXITCODE`,
      `  if ($code) { $out | Write-Output; exit $code }`,
      `  $out | Select-Object -Last 1`,
      `}`,
      `& $fcd extension status cua-perception --self-test; exit $LASTEXITCODE`,
    ].join("\n");
  }
  const target = os === "mac" ? PERCEPTION_TARGETS.mac : PERCEPTION_TARGETS.linux;
  const pre = [
    `fcd="$(command -v cua-driver 2>/dev/null || echo "$HOME/.local/bin/cua-driver")"`,
    `[ -x "$fcd" ] || { echo 'cua-driver is not installed' >&2; exit 1; }`,
    `"$fcd" --version`,
  ];
  if (action === "status") return [...pre, `"$fcd" extension status cua-perception`].join("\n");
  if (action === "remove") return [...pre, `"$fcd" extension remove cua-perception`].join("\n");
  const arch = os === "mac" ? "arm64" : "x86_64";
  return [...pre,
    `set -e`,
    `[ "$(uname -m)" = ${arch} ] || { echo "cua-perception ships ${os === "mac" ? "macOS arm64" : "Linux x64"} only (this host is $(uname -m))" >&2; exit 1; }`,
    version ? `ver=${version}`
      : `ver="$(curl -fsSL '${api}' | grep -o '"tag_name": *"cua-perception-v[^"]*"' | head -1 | sed 's/.*cua-perception-v//; s/"$//')"`,
    `[ -n "$ver" ] || { echo 'no cua-perception release found' >&2; exit 1; }`,
    `t="cua-perception-$ver-${target}"`,
    `dir="\${XDG_CACHE_HOME:-$HOME/.cache}/cua-perception/$ver"; mkdir -p "$dir"; cd "$dir"`,
    `base="${dl}/cua-perception-v$ver"`,
    `for f in SHA256SUMS "$t.catalog.json"; do curl -fsSL --retry 3 -o "$f" "$base/$f"; done`,
    `sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }`,
    `want_of() { grep -E "[ *]$1\\$" SHA256SUMS | head -1 | cut -d' ' -f1; }`,
    `if [ -f "$t.tar.gz" ] && [ "$(sum "$t.tar.gz")" = "$(want_of "$t.tar.gz")" ]; then echo "fleet: $t.tar.gz already downloaded"; else`,
    `  echo "fleet: downloading $t.tar.gz into $dir"`,
    `  curl -fL --retry 3 -C - -sS -o "$t.tar.gz" "$base/$t.tar.gz" || { rm -f "$t.tar.gz"; curl -fL --retry 3 -sS -o "$t.tar.gz" "$base/$t.tar.gz"; }`,
    `fi`,
    `for f in "$t.catalog.json" "$t.tar.gz"; do`,
    `  want="$(want_of "$f")"`,
    `  if [ -z "$want" ] || [ "$(sum "$f")" != "$want" ]; then rm -f "$f"; echo "fleet: $f failed its SHA256SUMS check and was deleted" >&2; exit 1; fi`,
    `  echo "fleet: $f matches SHA256SUMS"`,
    `done`,
    `inspect="$("$fcd" extension inspect cua-perception --catalog "$t.catalog.json" 2>&1)"`,
    `printf '%s\\n' "$inspect" | grep -E '^(Extension|Trust|Publisher signature|Destination|Installed size|License):' || true`,
    `printf '%s\\n' "$inspect" | grep -q '^Trust: publisher-verified' || { echo 'fleet: the catalog is not publisher-verified; not installing' >&2; exit 1; }`,
    `active="$("$fcd" extension status cua-perception 2>/dev/null | sed -n 's/^Active version: *//p' | head -1)"`,
    `if [ "$active" = "$ver" ]; then echo "fleet: cua-perception $ver is already installed"`,
    `else`,
    `  verb=install; [ -n "$active" ] && verb=update`,
    `  out="$("$fcd" extension "$verb" cua-perception --catalog "$t.catalog.json" 2>&1)" || { printf '%s\n' "$out" >&2; exit 1; }`,
    `  printf '%s\n' "$out" | tail -1`,
    `fi`,
    `"$fcd" extension status cua-perception --self-test`,
  ].join("\n");
}
