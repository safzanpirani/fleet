/**
 * `fleet session <host>`: is the desktop logged in, locked, or at the login
 * screen, how long has it been idle, and are the displays on. Computer use and
 * screenshots fail in confusing ways against a locked session or a powered-off
 * monitor, so this answers first, in one read-only round trip.
 */
import type { FleetConfig, Host } from "./config.ts";
import { resolveHosts } from "./config.ts";
import { exec, type ExecResult } from "./ssh.ts";
import { LINUX_MONITORS_SH, parseMonitors } from "./monitors.ts";
import { GRAPHICAL_ENV_SH } from "./core.ts";

export type SessionKind = "logged-in" | "locked" | "login-screen" | "no-graphical-session" | "disconnected" | "unknown";
export interface SessionState {
  host: string; os: Host["os"];
  state: SessionKind;
  user?: string;
  idleSeconds?: number;          // undefined when the desktop does not report idle time
  displays?: { name: string; on?: boolean }[];
  lock?: string;                 // what showed the lock
  notes: string[];
  error?: string;
}

const LOCKERS = "hyprlock|swaylock|gtklock|i3lock|xsecurelock|waylock|slock|xscreensaver|light-locker|physlock";

/** Linux: logind sessions, the display manager, locker processes, X11 idle,
 *  then the monitor layout (which also carries Hyprland's session lock). The
 *  caller prepends the graphical-session environment. */
export const LINUX_SESSION_SH = [
  `echo "@now $(date +%s)"`,
  `for id in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do`,
  `  echo "@session $(loginctl show-session "$id" -p Id -p Name -p Type -p Class -p State -p Active -p LockedHint -p IdleHint -p IdleSinceHint -p Remote -p Seat 2>/dev/null | tr '\\n' ' ')"`,
  `done`,
  `echo "@dm $(for d in sddm gdm gdm3 lightdm greetd ly lxdm; do pgrep -x "$d" >/dev/null 2>&1 && { echo "$d"; break; }; done)"`,
  `echo "@lockers $(pgrep -x -l '${LOCKERS}' 2>/dev/null | awk '{print $2}' | sort -u | tr '\\n' ' ')"`,
  `if [ -n "\${DISPLAY:-}" ] && command -v xprintidle >/dev/null 2>&1; then echo "@xidle_ms $(xprintidle 2>/dev/null)"; fi`,
  `if [ -n "\${DISPLAY:-}" ] && [ -z "\${WAYLAND_DISPLAY:-}" ] && command -v xset >/dev/null 2>&1; then echo "@xmonitor $(xset q 2>/dev/null | sed -n 's/^ *Monitor is //p')"; fi`,
  LINUX_MONITORS_SH,
].join("\n");

/** Windows: `query user` for sessions and idle time; LogonUI in a session means
 *  its lock or sign-in screen is up. */
export const WINDOWS_SESSION_PS = [
  `$lines = @(query user 2>$null)`,
  `foreach ($l in ($lines | Select-Object -Skip 1)) { "@user " + $l.TrimStart('>', ' ') }`,
  `$ui = @(Get-Process LogonUI -ErrorAction SilentlyContinue | ForEach-Object SessionId)`,
  `"@logonui " + ($ui -join ' ')`,
  `try { Add-Type -Namespace FleetSess -Name W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();' -ErrorAction Stop } catch {}`,
  `try { "@console " + [FleetSess.W]::WTSGetActiveConsoleSessionId() } catch { "@console ?" }`,
].join("\n");

/** macOS: the console user and its lock flag from IOConsoleUsers, and HID idle time. */
export const MAC_SESSION_SH = [
  `echo "@console $(ioreg -n Root -d1 -a 2>/dev/null | plutil -extract IOConsoleUsers json -o - - 2>/dev/null)"`,
  `echo "@hid_idle_ns $(ioreg -c IOHIDSystem -d 4 2>/dev/null | awk '/HIDIdleTime/ {print $NF; exit}')"`,
].join("\n");

const lineVal = (text: string, key: string) => new RegExp(`^@${key} ?(.*)$`, "m").exec(text)?.[1]?.trim();

export function parseLinuxSession(text: string): Omit<SessionState, "host" | "os"> {
  const notes: string[] = [];
  const now = Number(lineVal(text, "now")) || Math.floor(Date.now() / 1000);
  const sessions = [...text.matchAll(/^@session (.*)$/gm)].map((m) => {
    const kv: Record<string, string> = {};
    for (const part of m[1]!.trim().split(/\s+(?=[A-Za-z]+=)/)) {
      const eq = part.indexOf("=");
      if (eq > 0) kv[part.slice(0, eq)] = part.slice(eq + 1).trim();
    }
    return kv;
  });
  const graphical = sessions.filter((s) => s.Seat && /^(wayland|x11|mir)$/.test(s.Type ?? "") && s.Class === "user");
  const greeter = sessions.some((s) => /greeter/.test(s.Class ?? ""));
  const dm = lineVal(text, "dm") || undefined;
  const lockers = (lineVal(text, "lockers") ?? "").split(/\s+/).filter(Boolean);
  let layout: ReturnType<typeof parseMonitors> | undefined;
  const monStart = text.search(/^@(hyprland|sway|x11|none)\s*$/m);
  try { if (monStart >= 0) layout = parseMonitors(text.slice(monStart)); } catch { notes.push("could not read the monitor layout"); }
  let displays = layout?.monitors.map((m) => ({ name: m.name, on: m.on }));
  const xmon = lineVal(text, "xmonitor");
  if (xmon && displays?.length) displays = displays.map((d) => ({ ...d, on: /^on$/i.test(xmon) }));

  const g = graphical.find((s) => s.Active === "yes") ?? graphical[0];
  let state: SessionKind;
  let lock: string | undefined;
  if (g) {
    if (layout?.locked) lock = "compositor session lock";
    else if (lockers.length) lock = `locker running: ${lockers.join(", ")}`;
    else if (g.LockedHint === "yes") lock = "logind LockedHint";
    state = lock ? "locked" : "logged-in";
    if (layout?.source === "hyprland" && layout.locked === undefined) notes.push("Hyprland could not say whether the session is locked");
    if (g.Active !== "yes") notes.push("the graphical session is not the active one on its seat");
  } else if (greeter || dm) {
    state = "login-screen";
    if (dm && !greeter) notes.push(`${dm} is running with no graphical user session`);
  } else {
    state = "no-graphical-session";
  }

  let idleSeconds: number | undefined;
  const xidle = Number(lineVal(text, "xidle_ms"));
  if (Number.isFinite(xidle) && lineVal(text, "xidle_ms")) idleSeconds = Math.floor(xidle / 1000);
  else if (g?.IdleHint === "yes" && Number(g.IdleSinceHint) > 0) idleSeconds = Math.max(0, now - Math.floor(Number(g.IdleSinceHint) / 1e6));
  else if (g) notes.push("this desktop does not report idle time to logind");
  return { state, user: g?.Name, idleSeconds, displays, lock, notes };
}

/** `query user` IDLE TIME: none, ".", minutes, H:MM, or D+H:MM. */
export function parseQueryIdle(s: string): number | undefined {
  if (!s || s === "none" || s === ".") return 0;
  const m = /^(?:(\d+)\+)?(?:(\d+):)?(\d+)$/.exec(s);
  if (!m) return undefined;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60;
}

export function parseWindowsSession(text: string): Omit<SessionState, "host" | "os"> {
  const notes: string[] = [];
  const users = [...text.matchAll(/^@user (.*)$/gm)].map((m) => {
    // USERNAME [SESSIONNAME] ID STATE IDLE-TIME LOGON-TIME (the session name is blank when disconnected)
    const f = /^(\S+)\s+(?:(\S+)\s+)?(\d+)\s+(Active|Disc\S*|\S+)\s+(\S+)\s+(.+)$/.exec(m[1]!.trim());
    return f ? { user: f[1]!, session: f[2], id: Number(f[3]), state: f[4]!, idle: f[5]! } : undefined;
  }).filter((u): u is NonNullable<typeof u> => !!u);
  const logonui = (lineVal(text, "logonui") ?? "").split(/\s+/).filter(Boolean).map(Number);
  const consoleId = Number(lineVal(text, "console"));
  const onConsole = users.find((u) => u.id === consoleId) ?? users.find((u) => u.session === "console");
  let state: SessionKind;
  let lock: string | undefined;
  if (onConsole) {
    if (logonui.includes(onConsole.id)) { state = "locked"; lock = "LogonUI is up in the console session"; }
    else state = /^Active$/i.test(onConsole.state) ? "logged-in" : "disconnected";
  } else if (users.some((u) => /^Disc/i.test(u.state))) {
    state = logonui.length ? "login-screen" : "disconnected";
    notes.push("a user session exists but is not on the console");
  } else {
    state = logonui.length || Number.isFinite(consoleId) ? "login-screen" : "unknown";
  }
  const idleSeconds = onConsole ? parseQueryIdle(onConsole.idle) : undefined;
  if (onConsole && idleSeconds !== undefined) notes.push("idle time has minute resolution");
  return { state, user: onConsole?.user ?? users[0]?.user, idleSeconds, lock, notes };
}

export function parseMacSession(text: string): Omit<SessionState, "host" | "os"> {
  const notes: string[] = [];
  let users: any[] = [];
  try { users = JSON.parse(lineVal(text, "console") || "[]"); } catch { notes.push("could not read IOConsoleUsers"); }
  const c = users.find((u) => u.kCGSSessionOnConsoleKey) ?? undefined;
  const ns = Number(lineVal(text, "hid_idle_ns"));
  const idleSeconds = Number.isFinite(ns) && lineVal(text, "hid_idle_ns") ? Math.floor(ns / 1e9) : undefined;
  if (!c) return { state: users.length ? "login-screen" : "unknown", idleSeconds, notes };
  const locked = !!c.CGSSessionScreenIsLocked;
  return { state: locked ? "locked" : "logged-in", user: c.kCGSSessionUserNameKey, idleSeconds,
    lock: locked ? "screen lock" : undefined, notes };
}

/** Read the session state of every selected host, in parallel. Read-only. */
export async function sessionStates(
  cfg: FleetConfig, sel: string, deps: { exec?: typeof exec } = {},
): Promise<SessionState[]> {
  const run = deps.exec ?? exec;
  return Promise.all(resolveHosts(cfg, sel).map(async (h): Promise<SessionState> => {
    const base = { host: h.name, os: h.os };
    if (h.android) return { ...base, state: "unknown", notes: ["use fleet cu <phone> state for phones"] };
    let r: ExecResult;
    try {
      r = h.os === "windows" ? await run(h, WINDOWS_SESSION_PS, "powershell", { timeoutMs: 30_000 })
        : h.os === "mac" ? await run(h, MAC_SESSION_SH, "bash", { timeoutMs: 30_000 })
        : await run(h, `${GRAPHICAL_ENV_SH}\n${LINUX_SESSION_SH}`, "bash", { timeoutMs: 30_000 });
    } catch (e) { return { ...base, state: "unknown", notes: [], error: (e as Error).message }; }
    if (!r.ok && !r.stdout.includes("@"))
      return { ...base, state: "unknown", notes: [], error: r.stderr.trim() || `exit ${r.code}` };
    const parsed = h.os === "windows" ? parseWindowsSession(r.stdout)
      : h.os === "mac" ? parseMacSession(r.stdout) : parseLinuxSession(r.stdout);
    return { ...base, ...parsed };
  }));
}

export function formatIdle(s?: number): string {
  if (s === undefined) return "unknown";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}
