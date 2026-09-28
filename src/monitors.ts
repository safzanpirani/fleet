/**
 * Monitor layouts and screen regions for `fleet shot --output/--region` and the
 * cu desktop fallback. A multi-monitor capture includes every screen and the
 * blank space between them, so "the top right of my screen" meant working out
 * a monitor's offset and scale by hand. These pure functions do that once.
 *
 * Coordinates are the compositor's layout space: logical points on Wayland and
 * macOS, pixels on X11. `scale` turns a logical size into captured pixels.
 */

export interface Monitor {
  name: string;
  x: number; y: number;              // layout position
  width: number; height: number;     // logical size (after scale and rotation)
  scale: number;
  primary?: boolean;                 // X11 primary / macOS main display
  focused?: boolean;
  on?: boolean;                      // display powered (DPMS); undefined when unknown
  description?: string;
}
export type MonitorSource = "hyprland" | "sway" | "x11" | "mac" | "none";
export interface Rect { x: number; y: number; width: number; height: number }

/** Shell (bash) that prints `@<source>` and the compositor's monitor list. Run
 *  it after the graphical-session environment is imported. */
export const LINUX_MONITORS_SH = [
  `if [ -n "\${HYPRLAND_INSTANCE_SIGNATURE:-}" ] && command -v hyprctl >/dev/null 2>&1; then echo "@hyprland"; hyprctl monitors -j`,
  `elif [ -n "\${SWAYSOCK:-}" ] && command -v swaymsg >/dev/null 2>&1; then echo "@sway"; swaymsg -r -t get_outputs`,
  `elif [ -n "\${DISPLAY:-}" ] && command -v xrandr >/dev/null 2>&1; then echo "@x11"; xrandr --listmonitors`,
  `else echo "@none"; fi`,
].join("\n");

/** JXA that prints the macOS screens as JSON in top-left global points, the
 *  space `screencapture -R` takes. NSScreen frames have a bottom-left origin
 *  relative to the main screen. */
export const MAC_MONITORS_SH = `echo "@mac"; osascript -l JavaScript -e '
ObjC.import("AppKit");
const screens = $.NSScreen.screens; const out = [];
const mainH = screens.objectAtIndex(0).frame.size.height;
for (let i = 0; i < screens.count; i++) {
  const s = screens.objectAtIndex(i); const f = s.frame;
  out.push({ name: ObjC.unwrap(s.localizedName) || ("display " + (i + 1)), index: i + 1,
    x: f.origin.x, y: mainH - (f.origin.y + f.size.height), width: f.size.width, height: f.size.height,
    scale: s.backingScaleFactor, primary: i === 0 });
}
JSON.stringify(out);'`;

/** Parse the output of LINUX_MONITORS_SH or MAC_MONITORS_SH. */
export function parseMonitors(text: string): { source: MonitorSource; monitors: Monitor[]; locked?: boolean } {
  const at = text.indexOf("@");
  const nl = text.indexOf("\n", at);
  const source = (at < 0 ? "none" : text.slice(at + 1, nl < 0 ? undefined : nl).trim()) as MonitorSource;
  const body = nl < 0 ? "" : text.slice(nl + 1);
  const round = (n: number) => Math.round(n);
  if (source === "hyprland") {
    const raw = (JSON.parse(body) as any[]).filter((m) => !m.disabled);
    // Hyprland reports no lock state directly. An active ext-session-lock is
    // one reason a monitor cannot go solitary (LOCK in solitaryBlockedBy); a
    // monitor with no workspace stops at WORKSPACE first and says nothing.
    const blockers = (m: any): string[] => Array.isArray(m.solitaryBlockedBy) ? m.solitaryBlockedBy : [];
    const locked = raw.some((m) => blockers(m).includes("LOCK")) ? true
      : raw.some((m) => Array.isArray(m.solitaryBlockedBy) && !blockers(m).includes("WORKSPACE")) ? false : undefined;
    return { source, locked, monitors: raw.map((m) => {
      const scale = Number(m.scale) || 1;
      const rotated = Number(m.transform) % 2 === 1;
      const w = round(m.width / scale), h = round(m.height / scale);
      return { name: m.name, x: m.x, y: m.y, width: rotated ? h : w, height: rotated ? w : h, scale,
        focused: !!m.focused, on: m.dpmsStatus === undefined ? undefined : !!m.dpmsStatus, description: m.description };
    }) };
  }
  if (source === "sway") {
    return { source, monitors: (JSON.parse(body) as any[]).filter((o) => o.active !== false && o.rect).map((o) => ({
      name: o.name, x: o.rect.x, y: o.rect.y, width: o.rect.width, height: o.rect.height, scale: Number(o.scale) || 1,
      focused: !!o.focused, on: o.power === undefined ? (o.dpms === undefined ? undefined : !!o.dpms) : !!o.power,
      description: [o.make, o.model].filter(Boolean).join(" ") || undefined,
    })) };
  }
  if (source === "x11") {
    // " 0: +*DP-1 2560/597x1440/336+0+0  DP-1"
    const monitors: Monitor[] = [];
    for (const line of body.split("\n")) {
      const m = /^\s*\d+:\s+\+?(\*?)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/.exec(line);
      if (m) monitors.push({ name: m[2]!, primary: m[1] === "*", width: +m[3]!, height: +m[4]!, x: +m[5]!, y: +m[6]!, scale: 1 });
    }
    return { source, monitors };
  }
  if (source === "mac") {
    return { source, monitors: (JSON.parse(body.trim()) as any[]).map((s) => ({
      name: String(s.index), description: s.name, x: round(s.x), y: round(s.y), width: round(s.width),
      height: round(s.height), scale: Number(s.scale) || 1, primary: !!s.primary })) };
  }
  return { source: "none", monitors: [] };
}

/** The main monitor: the X11 primary or macOS main display, else the one at
 *  the layout origin, else the focused one, else the first. */
export function mainMonitor(monitors: Monitor[]): Monitor | undefined {
  return monitors.find((m) => m.primary) ?? monitors.find((m) => m.x === 0 && m.y === 0)
    ?? monitors.find((m) => m.focused) ?? monitors[0];
}

/** Resolve `--output`: a connector name (DP-3), `main`, `focused`, or a
 *  1-based index in the compositor's order. Refuses with the list otherwise. */
export function pickMonitor(monitors: Monitor[], sel: string): Monitor {
  if (!monitors.length) throw new Error("no monitors found (is a graphical session running?)");
  const s = sel.trim();
  const hit = s === "main" || s === "primary" ? mainMonitor(monitors)
    : s === "focused" ? monitors.find((m) => m.focused)
    : /^\d+$/.test(s) ? monitors[Number(s) - 1]
    : monitors.find((m) => m.name.toLowerCase() === s.toLowerCase());
  if (!hit) throw new Error(`no monitor '${sel}' (have: ${describeMonitors(monitors)})`);
  return hit;
}

export function describeMonitors(monitors: Monitor[]): string {
  const main = mainMonitor(monitors);
  return monitors.map((m, i) => `${i + 1}:${m.name}${m === main ? " (main)" : ""}${m.focused ? " (focused)" : ""}`).join(", ");
}

const NAMED: Record<string, [number, number, number, number]> = {
  left: [0, 0, 0.5, 1], right: [0.5, 0, 0.5, 1], top: [0, 0, 1, 0.5], bottom: [0, 0.5, 1, 0.5],
  "top-left": [0, 0, 0.5, 0.5], "top-right": [0.5, 0, 0.5, 0.5],
  "bottom-left": [0, 0.5, 0.5, 0.5], "bottom-right": [0.5, 0.5, 0.5, 0.5],
  center: [0.25, 0.25, 0.5, 0.5], full: [0, 0, 1, 1],
};
export const REGION_NAMES = Object.keys(NAMED);

/** A region as fractions of a monitor: a name (top-right, left, center, …) or
 *  `X,Y,W,H` fractions from 0 to 1. */
export function parseRegion(spec: string): [number, number, number, number] {
  const named = NAMED[spec.trim().toLowerCase()];
  if (named) return named;
  const parts = spec.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 1))
    throw new Error(`--region takes ${REGION_NAMES.join("|")} or X,Y,W,H fractions from 0 to 1 (got '${spec}')`);
  const [x, y, w, h] = parts as [number, number, number, number];
  if (w <= 0 || h <= 0 || x + w > 1.000001 || y + h > 1.000001)
    throw new Error(`--region ${spec} falls outside the screen (X+W and Y+H must be at most 1)`);
  return [x, y, w, h];
}

/** The layout rectangle for a region of a monitor, rounded to whole units. */
export function regionRect(m: Monitor, region?: string): Rect {
  const [fx, fy, fw, fh] = region ? parseRegion(region) : [0, 0, 1, 1];
  const x = Math.round(m.x + fx * m.width), y = Math.round(m.y + fy * m.height);
  return { x, y, width: Math.round(m.x + (fx + fw) * m.width) - x, height: Math.round(m.y + (fy + fh) * m.height) - y };
}
