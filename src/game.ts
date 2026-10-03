/**
 * game — computer use for video games on a Windows host.
 *
 * cua-driver delivers keys with PostMessage to a background window, which games
 * that read Raw Input or DirectInput never see, and it has no key holds,
 * relative mouse movement or gamepad. Game mode instead talks to a resident
 * helper (`game-helper.py`) that runs in the logged-in console session: it sends
 * scan-code keys and relative mouse through SendInput, holds a ViGEmBus virtual
 * Xbox 360 pad, and copies window frames. ssh lands in session 0, where neither
 * SendInput nor a frame copy reaches the desktop, so the helper is started by an
 * Interactive scheduled task and reached over 127.0.0.1 with a token.
 *
 * One step language serves agents (short sequences, a frame back) and macros
 * (files run on the host with exact timing, detached, repeated). Keyboard and
 * mouse steps require the target foreground: the helper re-reads the
 * foreground before each event and aborts, releasing everything held, when the
 * target loses it.
 */
import { createHash } from "node:crypto";
import HELPER from "./game-helper.py" with { type: "text" };
import { resolveHosts } from "./config.ts";
import type { FleetConfig, Host } from "./config.ts";
import { exec } from "./ssh.ts";
import type { ExecResult } from "./ssh.ts";

/** The helper's own version: the first 12 hex of its source's sha256, the same
 *  value the helper computes from the file it runs. */
export const GAME_HELPER_VERSION = createHash("sha256").update(HELPER, "utf8").digest("hex").slice(0, 12);
/** Pinned helper dependencies; a change reinstalls the host's environment. */
export const GAME_HELPER_DEPS = "pillow==12.3.0 vgamepad==0.1.0";
const MARK = "FLEETGAME ";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

export type GameStep = Record<string, unknown>;

export interface GameWindow {
  hwnd: number; pid: number; exe: string; title: string;
  x: number; y: number; width: number; height: number; minimized: boolean; foreground?: boolean;
}
export interface GameFrame {
  /** Base64 JPEG. */
  jpeg: string;
  width: number; height: number;
  /** The window's client size in physical pixels. */
  client: [number, number];
  /** Client pixels per image pixel. Step coordinates are image pixels at the same `max`. */
  scale: number;
  ms: number;
  /** Every pixel is near black: likely exclusive fullscreen or a protected surface. */
  black: boolean;
}
export interface GameRun {
  id: string;
  state: "running" | "done" | "failed" | "aborted" | "halted";
  loop: number; repeat: number; steps: number; seconds: number; detached: boolean;
  target?: Pick<GameWindow, "hwnd" | "pid" | "exe" | "title">;
  error?: string;
}
export interface GameStatus {
  host: string; running: boolean; version?: string; current: boolean; pid?: number;
  foreground?: GameWindow | null; held: string[]; pad: boolean; leaseS: number; run?: GameRun | null;
  note?: string;
}
export interface GameDoResult {
  host: string; ok: boolean; run: GameRun; frames: GameFrame[];
  held: string[]; leaseS: number; foreground?: GameWindow | null; error?: string;
}
export interface GameStartResult {
  host: string; started: boolean; pid: number; port: number; version: string; installed: boolean; log: string[];
}

type Deps = { exec?: typeof exec };

// ── steps ─────────────────────────────────────────────────────────────────────
const KEYS = ["tap", "hold", "down", "up"];
const MOUSE_BUTTONS = ["left", "right", "middle", "x1", "x2", "lmb", "rmb", "mmb", "mb4", "mb5"];
/** Each action key and the other fields its step may carry. */
const STEP_FIELDS: Record<string, string[]> = {
  tap: ["ms"], hold: ["ms"], down: [], up: [], type: ["gap"], look: ["ms"], move: [],
  click: ["at", "count", "ms"], wheel: [], stick: ["xy", "ms"], trigger: ["value", "ms"], wait: [],
  wait_pixel: ["rgb", "tol", "timeout", "gone", "every"], shot: [], focus: [], repeat: ["steps"],
};
export const GAME_STEP_ACTIONS = Object.keys(STEP_FIELDS);

function int(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw new Error(`${what} must be an integer from ${min} to ${max} (got ${JSON.stringify(v)})`);
  return v;
}
function num(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw new Error(`${what} must be a number from ${min} to ${max} (got ${JSON.stringify(v)})`);
  return v;
}
function pair(v: unknown, what: string, check: (n: unknown, w: string) => number): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) throw new Error(`${what} must be a [x, y] pair`);
  return [check(v[0], `${what}[0]`), check(v[1], `${what}[1]`)];
}
function keyNames(v: unknown, what: string): string[] {
  const names = Array.isArray(v) ? v : [v];
  if (!names.length || names.length > 8) throw new Error(`${what} takes one key name or a list of 1-8`);
  for (const n of names)
    if (typeof n !== "string" || !n.trim() || n.length > 32) throw new Error(`${what}: ${JSON.stringify(n)} is not a key name`);
  return names as string[];
}

/** Check a step list before anything reaches the host. Throws on the first
 *  problem with its path (`step 2.1: …`). Key names are checked by the helper,
 *  which owns the key tables, before it sends any input. */
export function validateGameSteps(steps: unknown, path = "", depth = 0): GameStep[] {
  if (!Array.isArray(steps) || !steps.length) throw new Error(`${path ? `step ${path}: ` : ""}steps must be a non-empty array`);
  if (steps.length > 1000) throw new Error("at most 1000 steps per list");
  steps.forEach((step, i) => {
    const at = path ? `${path}.${i + 1}` : String(i + 1);
    try { validateStep(step, at, depth); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.startsWith("step ") ? message : `step ${at}: ${message}`);
    }
  });
  return steps as GameStep[];
}

function validateStep(step: unknown, at: string, depth: number): void {
  if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error("each step must be an object");
  const st = step as GameStep;
  const actions = Object.keys(st).filter((k) => Object.hasOwn(STEP_FIELDS, k));
  if (actions.length !== 1)
    throw new Error(actions.length ? `one action per step (found ${actions.join(", ")})`
      : `no action; use one of ${GAME_STEP_ACTIONS.join(", ")}`);
  const action = actions[0]!;
  const extra = Object.keys(st).filter((k) => k !== action && !STEP_FIELDS[action]!.includes(k));
  if (extra.length) throw new Error(`${action} does not take ${extra.join(", ")}`);
  const v = st[action];
  if (st.ms !== undefined) int(st.ms, action === "hold" ? 1 : 0, 600_000, "ms");
  switch (action) {
    case "tap": case "down": case "up": keyNames(v, action); break;
    case "hold":
      keyNames(v, action);
      if (st.ms === undefined) throw new Error("hold needs ms");
      break;
    case "type":
      if (typeof v !== "string" || !v || v.length > 2000) throw new Error("type takes 1-2000 characters of text");
      if (st.gap !== undefined) int(st.gap, 0, 1000, "gap");
      break;
    case "look": pair(v, "look", (n, w) => int(n, -100_000, 100_000, w)); break;
    case "move": pair(v, "move", (n, w) => int(n, 0, 100_000, w)); break;
    case "click":
      if (v !== null && v !== true && (typeof v !== "string" || !MOUSE_BUTTONS.includes(v.toLowerCase())))
        throw new Error(`click takes a button: ${MOUSE_BUTTONS.join(", ")}`);
      if (st.at !== undefined) pair(st.at, "at", (n, w) => int(n, 0, 100_000, w));
      if (st.count !== undefined) int(st.count, 1, 3, "count");
      break;
    case "wheel":
      if (int(v, -100, 100, "wheel") === 0) throw new Error("wheel must not be 0");
      break;
    case "stick":
      if (v !== "left" && v !== "right") throw new Error("stick is left or right");
      pair(st.xy, "xy", (n, w) => num(n, -1, 1, w));
      break;
    case "trigger":
      if (typeof v !== "string" || !["lt", "rt", "l2", "r2"].includes(v.toLowerCase())) throw new Error("trigger is lt or rt");
      if (st.value !== undefined) num(st.value, 0, 1, "value");
      break;
    case "wait": int(v, 0, 3_600_000, "wait"); break;
    case "wait_pixel":
      pair(v, "wait_pixel", (n, w) => int(n, 0, 100_000, w));
      if (!Array.isArray(st.rgb) || st.rgb.length !== 3) throw new Error("wait_pixel needs rgb: [r, g, b]");
      st.rgb.forEach((c, i) => int(c, 0, 255, `rgb[${i}]`));
      int(st.timeout, 1, 600_000, "timeout");
      if (st.tol !== undefined) int(st.tol, 0, 255, "tol");
      if (st.every !== undefined) int(st.every, 10, 5000, "every");
      if (st.gone !== undefined && typeof st.gone !== "boolean") throw new Error("gone must be true or false");
      break;
    case "shot": case "focus":
      if (v !== true) throw new Error(`${action} takes true`);
      break;
    case "repeat":
      int(v, 1, 100_000, "repeat");
      if (depth >= 4) throw new Error("repeat nests at most 4 deep");
      validateGameSteps(st.steps, at, depth + 1);
      break;
  }
}

/** The longest a step list can run, in ms, for one pass. */
export function gameStepsMs(steps: GameStep[]): number {
  let total = 0;
  for (const st of steps) {
    const ms = typeof st.ms === "number" ? st.ms : 0;
    if ("tap" in st) total += st.ms === undefined ? 40 : ms;
    else if ("type" in st) total += String(st.type).length * ((st.gap as number | undefined) ?? 12);
    else if ("click" in st) total += ((st.count as number | undefined) ?? 1) * (((st.ms as number | undefined) ?? 30) + 60) + 16;
    else if ("wait" in st) total += st.wait as number;
    else if ("wait_pixel" in st) total += st.timeout as number;
    else if ("repeat" in st) total += (st.repeat as number) * gameStepsMs(st.steps as GameStep[]);
    else if ("focus" in st) total += 400;
    else total += ms;
  }
  return total;
}

/** True when a step list sends keyboard or mouse input, which needs a target. */
export function gameStepsUseDesktop(steps: GameStep[]): boolean {
  return steps.some((st) => {
    if ("repeat" in st) return gameStepsUseDesktop(st.steps as GameStep[]);
    for (const k of KEYS)
      if (k in st) return (Array.isArray(st[k]) ? st[k] as string[] : [st[k] as string]).some((n) => !n.toLowerCase().startsWith("pad."));
    return ["type", "look", "move", "click", "wheel", "wait_pixel", "focus"].some((k) => k in st);
  });
}

/** A macro file: a bare step array, or {target?, repeat?, steps}. */
export function parseGameMacro(text: string, source = "macro"): { steps: GameStep[]; target?: string; repeat?: number } {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) {
    throw new Error(`${source} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Array.isArray(value)) return { steps: validateGameSteps(value) };
  if (!value || typeof value !== "object") throw new Error(`${source} must be a step array or {target, repeat, steps}`);
  const m = value as Record<string, unknown>;
  const extra = Object.keys(m).filter((k) => !["target", "repeat", "steps", "name", "notes"].includes(k));
  if (extra.length) throw new Error(`${source} has unknown field(s) ${extra.join(", ")}`);
  if (m.target !== undefined && (typeof m.target !== "string" || !m.target.trim())) throw new Error(`${source}: target must be a window name`);
  if (m.repeat !== undefined) int(m.repeat, 0, 1_000_000, `${source}: repeat`);
  return { steps: validateGameSteps(m.steps), target: m.target as string | undefined, repeat: m.repeat as number | undefined };
}

// ── remote scripts ────────────────────────────────────────────────────────────
/** Shared PowerShell: where the helper lives, how to read its state, and one
 *  request/reply over its loopback socket. The token never leaves the host. */
const PRELUDE = [
  `$ErrorActionPreference='Stop'`,
  `$fgDir = Join-Path $env:LOCALAPPDATA 'fleet\\game'`,
  `$fgState = Join-Path $fgDir 'state.json'`,
  `$fgWant = '${GAME_HELPER_VERSION}'`,
  `function Read-FleetGameState {`,
  `  if (-not (Test-Path -LiteralPath $fgState)) { return $null }`,
  `  try { $s = Get-Content -LiteralPath $fgState -Raw | ConvertFrom-Json } catch { return $null }`,
  `  if ($s.pid -and (Get-Process -Id $s.pid -ErrorAction SilentlyContinue)) { return $s }`,
  `  return $null`,
  `}`,
  `function Invoke-FleetGame($st, [string]$json, [int]$timeout = 0) {`,
  `  $c = New-Object System.Net.Sockets.TcpClient`,
  `  try {`,
  `    $connect = $c.ConnectAsync('127.0.0.1', [int]$st.port)`,
  `    if (-not $connect.Wait(3000)) { throw 'game helper connection timed out before sending' }`,
  `    $s = $c.GetStream()`,
  `    if ($timeout -gt 0) { $s.ReadTimeout = $timeout; $s.WriteTimeout = $timeout }`,
  `    $b = [Text.Encoding]::UTF8.GetBytes('{"token":"' + $st.token + '",' + $json.Substring(1) + [char]10)`,
  `    $s.Write($b, 0, $b.Length); $s.Flush()`,
  `    return (New-Object System.IO.StreamReader($s, (New-Object System.Text.UTF8Encoding($false)))).ReadLine()`,
  `  } finally { $c.Close() }`,
  `}`,
  `function Write-FleetGame($o) { '${MARK}' + ($o | ConvertTo-Json -Compress -Depth 6) }`,
].join("\n");

/** Install (when allowed) and start the helper; replace an older one. */
export function gameStartScript(opts: { install: boolean; force?: boolean }): string {
  return [
    PRELUDE,
    `$install = $${opts.install ? "true" : "false"}; $force = $${opts.force ? "true" : "false"}`,
    `New-Item -ItemType Directory -Force -Path $fgDir | Out-Null`,
    `$py = Join-Path $fgDir 'helper.py'`,
    `$venv = Join-Path $fgDir 'venv'; $pyx = Join-Path $venv 'Scripts\\python.exe'; $pyw = Join-Path $venv 'Scripts\\pythonw.exe'`,
    `$deps = '${GAME_HELPER_DEPS}'; $mark = Join-Path $fgDir 'deps.txt'`,
    `$have = if (Test-Path -LiteralPath $mark) { (Get-Content -LiteralPath $mark -Raw).Trim() } else { '' }`,
    `if ((-not (Test-Path -LiteralPath $pyw) -or $have -ne $deps) -and -not $install) { Write-FleetGame @{ ok = $false; notInstalled = $true; error = 'the game helper is not installed' }; return }`,
    `$st = Read-FleetGameState`,
    `if ($st -and $st.version -eq $fgWant -and (Test-Path -LiteralPath $pyw) -and $have -eq $deps) { Write-FleetGame @{ ok = $true; started = $false; installed = $false; pid = $st.pid; port = $st.port; version = $st.version }; return }`,
    `if ($st) {`,
    `  $now = $null; try { $now = (Invoke-FleetGame $st '{"op":"status"}' 3000) | ConvertFrom-Json } catch {}`,
    `  if ((-not $now -or -not $now.ok) -and -not $force) { throw 'cannot verify the older helper is idle; inspect status or use start --force' }`,
    `  if ($now -and $now.run -and $now.run.state -eq 'running' -and -not $force) {`,
    `    Write-FleetGame @{ ok = $false; busy = $true; error = ('helper ' + $st.version + ' is running macro ' + $now.run.id + '; halt it with release, or pass --force') }; return`,
    `  }`,
    `  'replacing helper ' + $st.version + ' (pid ' + $st.pid + ')'`,
    `  $stopped = $null; try { $stopped = (Invoke-FleetGame $st '{"op":"stop"}' 3000) | ConvertFrom-Json } catch {}`,
    `  if ((-not $stopped -or -not $stopped.ok) -and -not $force) { throw 'helper cleanup was not confirmed; refusing replacement without --force' }`,
    `  for ($i = 0; $i -lt 30 -and (Get-Process -Id $st.pid -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }`,
    `  if ((Get-Process -Id $st.pid -ErrorAction SilentlyContinue) -and -not $force) { throw 'the helper has not exited; refusing replacement without --force' }`,
    // TODO(review): Verify process identity and held-input cleanup before force-killing an unresponsive helper.
    `  Stop-Process -Id $st.pid -Force -ErrorAction SilentlyContinue`,
    `}`,
    `$installed = $false`,
    `if (-not (Test-Path -LiteralPath $pyw) -or $have -ne $deps) {`,
    `  if (-not $install) { Write-FleetGame @{ ok = $false; notInstalled = $true; error = 'the game helper is not installed' }; return }`,
    `  $uv = (Get-Command uv -ErrorAction SilentlyContinue).Source`,
    `  if (-not $uv) { throw 'uv is not on PATH; install uv (https://docs.astral.sh/uv/) and run start again' }`,
    `  'installing the helper environment: ' + $deps`,
    `  $ErrorActionPreference = 'Continue'`,
    `  if (-not (Test-Path -LiteralPath $pyx)) { & $uv venv $venv --python '>=3.9' 2>&1 | ForEach-Object { '  ' + $_ }; if ($LASTEXITCODE) { throw "uv venv failed (exit $LASTEXITCODE)" } }`,
    `  & $uv pip install --python $pyx $deps.Split(' ') 2>&1 | ForEach-Object { '  ' + $_ }`,
    `  if ($LASTEXITCODE) { throw "uv pip install failed (exit $LASTEXITCODE)" }`,
    `  $ErrorActionPreference = 'Stop'`,
    `  Set-Content -LiteralPath $mark -Value $deps -Encoding ASCII`,
    `  $installed = $true`,
    `}`,
    `[IO.File]::WriteAllBytes($py, [Convert]::FromBase64String('${b64(HELPER)}'))`,
    `Remove-Item -LiteralPath $fgState -Force -ErrorAction SilentlyContinue`,
    `$tn = 'fleet_game_helper'`,
    `$action = New-ScheduledTaskAction -Execute $pyw -Argument ('"' + $py + '"') -WorkingDirectory $fgDir`,
    // Highest: SendInput cannot reach a window of higher integrity (UIPI), and
    // some games run elevated.
    `$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest`,
    `$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`,
    `Register-ScheduledTask -TaskName $tn -Action $action -Principal $principal -Settings $settings -Force | Out-Null`,
    `try {`,
    `  Start-ScheduledTask -TaskName $tn`,
    `  for ($i = 0; $i -lt 150; $i++) { $st = Read-FleetGameState; if ($st -and $st.version -eq $fgWant) { break }; $st = $null; Start-Sleep -Milliseconds 100 }`,
    `} finally { Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue }`,
    `if (-not $st) {`,
    `  $tail = (Get-Content -LiteralPath (Join-Path $fgDir 'helper.log') -Tail 5 -ErrorAction SilentlyContinue) -join ' | '`,
    `  throw ('the helper did not start within 15 s; is a user logged in at the console? ' + $tail)`,
    `}`,
    `Write-FleetGame @{ ok = $true; started = $true; installed = $installed; pid = $st.pid; port = $st.port; version = $st.version }`,
  ].join("\n");
}

/** Send one request to a running helper. Prints `down` or `stale` without
 *  sending anything when the helper is missing or older than this fleet, so
 *  the caller can start it and send the request once. */
export function gameCallScript(req: Record<string, unknown>, anyVersion = false): string {
  return [
    PRELUDE,
    `$st = Read-FleetGameState`,
    `if (-not $st) { Write-FleetGame @{ ok = $false; down = $true; error = 'the game helper is not running' }; return }`,
    anyVersion ? "" : `if ($st.version -ne $fgWant) { Write-FleetGame @{ ok = $false; stale = $true; version = $st.version; error = ('the helper runs ' + $st.version + '; this fleet expects ' + $fgWant) }; return }`,
    `$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(JSON.stringify(req))}'))`,
    `$reply = Invoke-FleetGame $st $req`,
    `if (-not $reply) { Write-FleetGame @{ ok = $false; lost = $true; error = 'the helper closed the connection without a reply; its outcome is unknown' }; return }`,
    `'${MARK}' + $reply`,
  ].filter(Boolean).join("\n");
}

/** The helper's reply line from a script's stdout. Other lines are progress. */
export function parseGameReply(r: ExecResult): { reply: Record<string, any>; log: string[] } {
  const lines = r.stdout.split(/\r?\n/);
  const at = lines.findLastIndex((l) => l.startsWith(MARK));
  if (at < 0) {
    const detail = (r.stderr || r.stdout).trim().split("\n").slice(-6).join("\n");
    throw new Error(`game helper call on ${r.host} failed (exit ${r.code})${detail ? `: ${detail}` : ""}`);
  }
  let reply: Record<string, any>;
  try { reply = JSON.parse(lines[at]!.slice(MARK.length)); } catch {
    throw new Error(`game helper on ${r.host} sent an unreadable reply`);
  }
  return { reply, log: lines.slice(0, at).map((l) => l.trimEnd()).filter(Boolean) };
}

function gameHost(cfg: FleetConfig, sel: string): Host {
  const host = resolveHosts(cfg, sel)[0]!;
  if (host.os !== "windows") throw new Error(`fleet game runs on Windows hosts; ${host.name} is ${host.os}`);
  return host;
}

// ── actions ───────────────────────────────────────────────────────────────────
export async function gameStart(
  cfg: FleetConfig, sel: string, opts: { install?: boolean; force?: boolean } = {}, deps: Deps = {},
): Promise<GameStartResult> {
  const host = gameHost(cfg, sel);
  const run = deps.exec ?? exec;
  const r = await run(host, gameStartScript({ install: opts.install ?? true, force: opts.force }), "powershell",
    { timeoutMs: 600_000 });
  const { reply, log } = parseGameReply(r);
  if (!reply.ok) {
    if (reply.notInstalled) throw new Error(`the game helper is not installed on ${host.name}; run: fleet game ${host.name} start`);
    throw new Error(reply.error ?? `game helper start failed on ${host.name}`);
  }
  return { host: host.name, started: !!reply.started, pid: reply.pid, port: reply.port, version: reply.version,
    installed: !!reply.installed, log };
}

/** One request; starts (never installs) a missing or older helper first. The
 *  request is sent once: a `down`/`stale` answer means nothing was sent. */
export async function gameRequest(
  cfg: FleetConfig, sel: string, req: Record<string, unknown>,
  opts: { autoStart?: boolean; anyVersion?: boolean; timeoutMs?: number } = {}, deps: Deps = {},
): Promise<Record<string, any>> {
  const host = gameHost(cfg, sel);
  const run = deps.exec ?? exec;
  const call = async () => parseGameReply(await run(host, gameCallScript(req, opts.anyVersion), "powershell",
    { timeoutMs: opts.timeoutMs ?? 120_000 })).reply;
  let reply = await call();
  if ((reply.down || reply.stale) && opts.autoStart !== false) {
    await gameStart(cfg, sel, { install: false }, deps);
    reply = await call();
  }
  if (reply.down) throw new Error(`the game helper is not running on ${host.name}; run: fleet game ${host.name} start`);
  if (reply.stale) throw new Error(`${reply.error}; run: fleet game ${host.name} start`);
  if (reply.lost) throw new Error(reply.error ?? "the helper reply was lost; its outcome is unknown");
  return reply;
}

export async function gameStatus(cfg: FleetConfig, sel: string, deps: Deps = {}): Promise<GameStatus> {
  const host = gameHost(cfg, sel);
  const reply = await gameRequest(cfg, sel, { op: "status" }, { autoStart: false, anyVersion: true }, deps)
    .catch((error) => {
      if (error instanceof Error && error.message.includes("is not running")) return null;
      throw error;
    });
  if (!reply) return { host: host.name, running: false, current: false, held: [], pad: false, leaseS: 0,
    note: `not running; fleet game ${host.name} start launches it` };
  if (!reply.ok) throw new Error(reply.error ?? "status failed");
  const current = reply.version === GAME_HELPER_VERSION;
  return { host: host.name, running: true, version: reply.version, current, pid: reply.pid,
    foreground: reply.foreground, held: reply.held ?? [], pad: !!reply.pad, leaseS: reply.lease_s ?? 0, run: reply.run,
    note: current ? undefined : `helper ${reply.version} is older than this fleet (${GAME_HELPER_VERSION}); the next input call restarts it` };
}

export async function gameWindows(cfg: FleetConfig, sel: string, filter?: string, deps: Deps = {}): Promise<GameWindow[]> {
  const reply = await gameRequest(cfg, sel, { op: "windows", filter: filter ?? "" }, {}, deps);
  if (!reply.ok) throw new Error(reply.error ?? "windows failed");
  return reply.windows;
}

export async function gameFocus(cfg: FleetConfig, sel: string, target: string, deps: Deps = {}):
  Promise<{ target: GameWindow; foreground: GameWindow | null }> {
  const reply = await gameRequest(cfg, sel, { op: "focus", target }, {}, deps);
  if (!reply.ok) throw new Error(reply.error ?? "focus failed");
  return { target: reply.target, foreground: reply.foreground };
}

export async function gameFrame(
  cfg: FleetConfig, sel: string, target: string | undefined, opts: { max?: number; quality?: number } = {}, deps: Deps = {},
): Promise<{ target: GameWindow | null; frame: GameFrame }> {
  int(opts.max ?? 1280, 0, 8192, "max");
  int(opts.quality ?? 80, 10, 95, "quality");
  const reply = await gameRequest(cfg, sel, { op: "frame", target: target ?? "", max: opts.max ?? 1280,
    quality: opts.quality ?? 80 }, {}, deps);
  if (!reply.ok) throw new Error(reply.error ?? "frame failed");
  return { target: reply.target, frame: reply.frame };
}

export interface GameDoOptions {
  target?: string;
  /** Passes over the list; 0 repeats until released (detached only). */
  repeat?: number;
  /** Return at once and run on the host; `status` follows it, `release` halts it. */
  detach?: boolean;
  /** Append a frame after the last step. */
  shot?: boolean;
  /** Frame size cap, which also sets the coordinate space of `at`/`move`. */
  max?: number;
  quality?: number;
}

export async function gameDo(
  cfg: FleetConfig, sel: string, steps: unknown, opts: GameDoOptions = {}, deps: Deps = {},
): Promise<GameDoResult> {
  const { all, repeat, timeoutMs } = prepareGameDo(steps, opts);
  const host = gameHost(cfg, sel);
  const reply = await gameRequest(cfg, sel, { op: "do", steps: all, target: opts.target ?? "", repeat,
    detach: !!opts.detach, max: opts.max ?? 1280, quality: opts.quality ?? 80 }, { timeoutMs }, deps);
  if (!reply.run) throw new Error(reply.error ?? `game input failed on ${host.name}`);
  return { host: host.name, ok: !!reply.ok, run: reply.run, frames: reply.frames ?? [], held: reply.held ?? [],
    leaseS: reply.lease_s ?? 0, foreground: reply.foreground, error: reply.error };
}

/** Validate a run before frontend routing can contact any host. */
export function prepareGameDo(steps: unknown, opts: GameDoOptions = {}): { all: GameStep[]; repeat: number; timeoutMs: number } {
  const list = validateGameSteps(steps);
  const repeat = opts.repeat ?? 1;
  int(repeat, 0, 1_000_000, "repeat");
  if (repeat === 0 && !opts.detach) throw new Error("repeat 0 runs until released, so it needs --detach");
  if (!opts.target && gameStepsUseDesktop(list))
    throw new Error("keyboard, mouse and pixel steps need a target window; only pad, stick, trigger, wait and shot steps run without one");
  const all = opts.shot ? [...list, { shot: true }] : list;
  const passMs = gameStepsMs(all);
  const timeoutMs = opts.detach ? 60_000 : passMs * repeat + 60_000;
  if (timeoutMs > 2_147_483_647) throw new Error("synchronous run exceeds the timer limit; use --detach");
  int(opts.max ?? 1280, 0, 8192, "max");
  int(opts.quality ?? 80, 10, 95, "quality");
  return { all, repeat, timeoutMs };
}

/** Halt a running macro and release every key, button, stick and trigger.
 *  Works against any helper version, so an old helper can always be released. */
export async function gameRelease(cfg: FleetConfig, sel: string, opts: { unplug?: boolean } = {}, deps: Deps = {}):
  Promise<{ host: string; released: string[]; halted: string | null; running: boolean }> {
  const host = gameHost(cfg, sel);
  const reply = await gameRequest(cfg, sel, { op: "release", unplug: !!opts.unplug }, { autoStart: false, anyVersion: true }, deps)
    .catch((error) => {
      if (error instanceof Error && error.message.includes("is not running")) return null;
      throw error;
    });
  if (!reply) return { host: host.name, released: [], halted: null, running: false };
  if (!reply.ok) throw new Error(reply.error ?? "release failed");
  return { host: host.name, released: reply.released ?? [], halted: reply.halted ?? null, running: true };
}

export async function gameStop(cfg: FleetConfig, sel: string, deps: Deps = {}): Promise<{ host: string; stopped: number | null }> {
  const host = gameHost(cfg, sel);
  const reply = await gameRequest(cfg, sel, { op: "stop" }, { autoStart: false, anyVersion: true }, deps)
    .catch((error) => {
      if (error instanceof Error && error.message.includes("is not running")) return null;
      throw error;
    });
  if (reply && !reply.ok) throw new Error(reply.error ?? "stop failed");
  return { host: host.name, stopped: reply?.stopped ?? null };
}

// ── shorthands ────────────────────────────────────────────────────────────────
/** The step list behind each one-line verb. `rest` holds the operands after
 *  the target (pad verbs take no target). Throws a usage line on bad input. */
export function gameShorthand(verb: string, rest: string[], flags: { ms?: number; button?: string; count?: number } = {}): GameStep[] {
  const number = (s: string | undefined, what: string) => {
    const n = Number(s);
    if (s === undefined || s.trim() === "" || !Number.isFinite(n)) throw new Error(`${what} must be a number (got ${JSON.stringify(s)})`);
    return n;
  };
  const ms = flags.ms === undefined ? {} : { ms: flags.ms };
  const one = (names: string[]) => (names.length === 1 ? names[0]! : names);
  switch (verb) {
    case "tap":
      if (!rest.length) throw new Error("usage: tap <TARGET> <KEY…> [--ms N]");
      return [{ tap: one(rest), ...ms }];
    case "hold": {
      if (rest.length < 2) throw new Error("usage: hold <TARGET> <KEY…> <MS>");
      return [{ hold: one(rest.slice(0, -1)), ms: number(rest.at(-1), "hold time") }];
    }
    case "look":
      if (rest.length !== 2) throw new Error("usage: look <TARGET> <DX> <DY> [--ms N]");
      return [{ look: [number(rest[0], "dx"), number(rest[1], "dy")], ...ms }];
    case "click": {
      if (rest.length !== 0 && rest.length !== 2) throw new Error("usage: click <TARGET> [X Y] [--button B] [--count N]");
      return [{ click: flags.button ?? "left", ...(rest.length ? { at: [number(rest[0], "x"), number(rest[1], "y")] } : {}),
        ...(flags.count ? { count: flags.count } : {}), ...ms }];
    }
    case "type":
      if (rest.length !== 1) throw new Error("usage: type <TARGET> <TEXT>");
      return [{ type: rest[0]! }];
    case "pad":
      if (!rest.length) throw new Error("usage: pad <BUTTON…> [--ms N]   (a b x y lb rb lt rt ls rs start back guide up down left right)");
      return [{ tap: one(rest.map((b) => `pad.${b}`)), ms: flags.ms ?? 80 }];
    case "stick":
      if (rest.length !== 3) throw new Error("usage: stick <left|right> <X> <Y> [--ms N]   (X and Y from -1 to 1; +Y is up)");
      return [{ stick: rest[0]!, xy: [number(rest[1], "x"), number(rest[2], "y")], ...ms }];
    case "trigger":
      if (rest.length < 1 || rest.length > 2) throw new Error("usage: trigger <lt|rt> [VALUE] [--ms N]");
      return [{ trigger: rest[0]!, value: rest[1] === undefined ? 1 : number(rest[1], "value"), ...ms }];
  }
  throw new Error(`unknown game verb ${verb}`);
}

// ── CLI argv ──────────────────────────────────────────────────────────────────
const GAME_BOOL_FLAGS = ["--json", "--detach", "--shot", "--force", "--unplug", "--no-open", "--grid"];
const GAME_VAL_FLAGS = ["--file", "--repeat", "--max", "--quality", "--out", "--ms", "--button", "--count", "--grid-step"];

/** Split `fleet game` argv into flags and operands. Unlike parseFlags, a
 *  negative number (`look win-box -300 0`) and a bare `-` (stdin) are operands. */
export function parseGameArgv(argv: string[]): { flags: Record<string, string | true>; pos: string[] } {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (token === "-" || /^-\d/.test(token) || !token.startsWith("-")) { pos.push(token); continue; }
    const eq = token.indexOf("=");
    const name = eq > 0 ? token.slice(0, eq) : token;
    if (Object.hasOwn(flags, name)) throw new Error(`duplicate option: ${name}`);
    if (GAME_BOOL_FLAGS.includes(name)) {
      if (eq > 0) throw new Error(`${name} does not take a value`);
      flags[name] = true;
    } else if (GAME_VAL_FLAGS.includes(name)) {
      const value = eq > 0 ? token.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || (eq < 0 && /^--[a-z]/.test(value))) throw new Error(`${name} requires a value`);
      flags[name] = value;
    } else throw new Error(`unknown option: ${name} (try fleet help game)`);
  }
  return { flags, pos };
}

/** An integer flag value, or the default. */
export function gameIntFlag(flags: Record<string, string | true>, name: string, def: number | undefined, min: number, max: number): number | undefined {
  const v = flags[name];
  if (v === undefined) return def;
  const n = Number(v);
  if (typeof v !== "string" || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} needs an integer from ${min} to ${max} (got '${v}')`);
  return n;
}
