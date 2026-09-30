/**
 * android — `fleet cu` on an Android phone.
 *
 * The host is Termux on the phone, reached over SSH. Termux's own adb client
 * drives the phone's adbd on 127.0.0.1 (legacy `adb tcpip` mode, which keeps
 * listening off Wi-Fi). Termux's uid cannot inject input or capture other apps;
 * adb's shell uid can. Running adb on the phone keeps the heavy bytes there:
 * screenshots are encoded to WebP before they leave it, and the before/after
 * comparison hashes frames on the phone, so an action ships no image at all.
 *
 * One fleet exec per call. Its Termux script pipes a device script into
 * `adb shell -T sh`. That script checks that the screen is awake, unlocked, and
 * showing the target package BEFORE it sends input, so a refusal never
 * delivers anything.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { gunzipSync } from "node:zlib";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import type { FleetConfig, Host } from "./config.ts";
import { resolveHosts } from "./config.ts";
import { exec, probe, type ExecResult } from "./ssh.ts";
import { emitImage, takeInlineImages, validateImageArtifact } from "./core.ts";
import { UI_JAR_B64, UI_JAR_MD5 } from "./android-ui-jar.ts";

export const ANDROID_DEFAULT_SERIAL = "127.0.0.1:5555";
const P = "__FA__";
/** Exit code of a refusal: the device script stopped before any input. */
const REFUSED = 3;

// ── the phone's UI tree ──────────────────────────────────────────────────────

export interface AndroidBounds { x1: number; y1: number; x2: number; y2: number }
export interface AndroidNode {
  index: number;
  parent: number;          // -1 at the root
  depth: number;
  text: string;
  desc: string;            // content-desc
  hint: string;            // an empty field's placeholder
  resourceId: string;
  className: string;
  pkg: string;
  checkable: boolean; checked: boolean; clickable: boolean; longClickable: boolean;
  enabled: boolean; focusable: boolean; focused: boolean; scrollable: boolean;
  password: boolean; selected: boolean;
  bounds: AndroidBounds;
}

const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
  const k = e.toLowerCase();
  if (k === "amp") return "&";
  if (k === "lt") return "<";
  if (k === "gt") return ">";
  if (k === "quot") return "\"";
  if (k === "apos") return "'";
  return String.fromCodePoint(k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
});

/** Every `<node>` in a `uiautomator dump`, in document order, with its parent.
 *  Attribute values may hold a raw `>`, so the tag pattern skips quoted runs. */
export function parseUiDump(xml: string): AndroidNode[] {
  const nodes: AndroidNode[] = [];
  const stack: number[] = [];
  const tag = /<node\b((?:[^>"]|"[^"]*")*?)(\/?)>|<\/node>/g;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    if (m[0] === "</node>") { stack.pop(); continue; }
    const attrs: Record<string, string> = {};
    for (const a of m[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]!] = decodeEntities(a[2]!);
    const b = (attrs.bounds ?? "").match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    const flag = (k: string) => attrs[k] === "true";
    const index = nodes.length;
    nodes.push({
      index, parent: stack.at(-1) ?? -1, depth: stack.length,
      text: attrs.text ?? "", desc: attrs["content-desc"] ?? "", hint: attrs.hint ?? "", resourceId: attrs["resource-id"] ?? "",
      className: attrs.class ?? "", pkg: attrs.package ?? "",
      checkable: flag("checkable"), checked: flag("checked"), clickable: flag("clickable"),
      longClickable: flag("long-clickable"), enabled: attrs.enabled !== "false", focusable: flag("focusable"),
      focused: flag("focused"), scrollable: flag("scrollable"), password: flag("password"), selected: flag("selected"),
      bounds: b ? { x1: +b[1]!, y1: +b[2]!, x2: +b[3]!, y2: +b[4]! } : { x1: 0, y1: 0, x2: 0, y2: 0 },
    });
    if (!m[2]) stack.push(index);
  }
  return nodes;
}

export interface AndroidElement {
  index: number;           // node index in the dump
  ancestors: number[];     // node indices from the root down
  depth: number;
  role: string;            // class short name: Button, EditText, TextView, View, …
  label: string;           // text, else content-desc, else an empty field's hint, else its children's text
  derived: boolean;        // the label came from descendants
  text: string;
  desc: string;
  hint: string;
  id: string;              // resource-id without the package prefix
  pkg: string;
  actions: string[];       // tap, long_press, scroll, check, type
  enabled: boolean;
  checked?: boolean;
  selected: boolean;
  focused: boolean;
  password: boolean;
  bounds: AndroidBounds;
  center: { x: number; y: number };
  /** For an element that takes no input itself: the nearest ancestor that
   *  does, which is what a tap on it actually reaches. */
  within?: string;
}

const shortId = (id: string) => id.includes(":id/") ? id.slice(id.indexOf(":id/") + 4) : id;
const shortClass = (c: string) => c.slice(c.lastIndexOf(".") + 1) || c;

/** The addressable and readable part of a dump: every node that takes an
 *  action or carries text. A clickable container with no label of its own
 *  takes its children's text, which is how list rows and icons usually look. */
export function androidElements(nodes: AndroidNode[], opts: { all?: boolean; width?: number; height?: number } = {}): AndroidElement[] {
  const children = new Map<number, number[]>();
  for (const n of nodes) if (n.parent >= 0) children.set(n.parent, [...(children.get(n.parent) ?? []), n.index]);
  const descendantText = (i: number): string[] => {
    const seen: string[] = [];
    const walk = (j: number) => {
      for (const c of children.get(j) ?? []) {
        const t = (nodes[c]!.text || nodes[c]!.desc).trim();
        if (t && !seen.includes(t)) seen.push(t);
        if (seen.length < 3) walk(c);
      }
    };
    walk(i);
    return seen.slice(0, 3);
  };
  const out: AndroidElement[] = [];
  for (const n of nodes) {
    const { x1, y1, x2, y2 } = n.bounds;
    if (x2 <= x1 || y2 <= y1) continue;
    if (opts.width && opts.height && (x2 <= 0 || y2 <= 0 || x1 >= opts.width || y1 >= opts.height)) continue;
    const role = shortClass(n.className);
    const actions = [
      ...(n.clickable ? ["tap"] : []),
      ...(n.longClickable ? ["long_press"] : []),
      ...(n.scrollable ? ["scroll"] : []),
      ...(n.checkable ? ["check"] : []),
      ...(/EditText$/.test(n.className) || (role === "AutoCompleteTextView") ? ["type"] : []),
    ];
    const own = (n.text || n.desc || n.hint).trim();
    // Only a container you tap or toggle is named by its children: a list that
    // merely scrolls would otherwise take its first row's text.
    const derived = !own && actions.some((a) => a !== "scroll") ? descendantText(n.index).join(" · ") : "";
    if (!opts.all && !actions.length && !own) continue;
    const ancestors: number[] = [];
    for (let p = n.parent; p >= 0; p = nodes[p]!.parent) ancestors.unshift(p);
    const taker = actions.some((a) => a !== "scroll") ? undefined
      : [...ancestors].reverse().map((i) => nodes[i]!).find((a) => a.clickable || a.longClickable || a.checkable);
    const takerLabel = taker && ((taker.text || taker.desc || taker.hint).trim() || descendantText(taker.index).join(" · "));
    out.push({
      index: n.index, ancestors, depth: n.depth, role, label: own || derived, derived: !own && !!derived,
      text: n.text, desc: n.desc, hint: n.hint, id: shortId(n.resourceId), pkg: n.pkg, actions,
      enabled: n.enabled, ...(n.checkable ? { checked: n.checked } : {}), selected: n.selected,
      focused: n.focused, password: n.password, bounds: n.bounds,
      center: { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) },
      ...(taker ? { within: `${shortClass(taker.className)} ${JSON.stringify(takerLabel ?? "")}` } : {}),
    });
  }
  return out;
}

export interface AndroidLocator { label?: string; role?: string; nth?: number }

/** Resolve a label to one element or refuse. Exact matches over text,
 *  content-desc, resource-id, and a derived label win over substrings. A match
 *  inside another match that takes input collapses into it, and when some
 *  matches take input the rest are dropped: tapping a row's caption and tapping
 *  the row are the same act. */
export function androidPick(elements: AndroidElement[], loc: AndroidLocator): AndroidElement {
  const label = loc.label?.trim().toLowerCase();
  const role = loc.role?.trim().toLowerCase();
  if (!label && !role) throw new Error("an element needs a label or a role");
  const byRole = role ? elements.filter((e) => e.role.toLowerCase() === role) : elements;
  const fields = (e: AndroidElement) => [e.text, e.desc, e.hint, e.id, e.label].map((f) => f.trim().toLowerCase()).filter(Boolean);
  const exact = label === undefined ? byRole : byRole.filter((e) => fields(e).includes(label));
  let pool = exact.length ? exact
    : label === undefined ? [] : byRole.filter((e) => fields(e).some((f) => f.includes(label)));
  const inPool = new Map(pool.map((e) => [e.index, e]));
  pool = pool.filter((e) => !e.ancestors.some((a) => inPool.get(a)?.actions.length));
  if (pool.some((e) => e.actions.length)) pool = pool.filter((e) => e.actions.length);
  const describe = (e: AndroidElement) => `${e.role} ${JSON.stringify(e.label)}`
    + (e.id ? ` #${e.id}` : "") + ` @${e.center.x},${e.center.y}` + (e.enabled ? "" : " (disabled)");
  const what = [role && `role ${loc.role}`, label !== undefined && `label "${loc.label}"`].filter(Boolean).join(" and ");
  if (!pool.length) {
    const near = elements.filter((e) => e.actions.length).slice(0, 12).map(describe).join("\n  ");
    throw new Error(`no element with ${what}` + (near ? `; some that take input:\n  ${near}` : ""));
  }
  if (loc.nth !== undefined) {
    if (!Number.isInteger(loc.nth) || loc.nth < 1 || loc.nth > pool.length)
      throw new Error(`--nth must be from 1 to ${pool.length} for ${what}`);
    return pool[loc.nth - 1]!;
  }
  if (pool.length === 1) return pool[0]!;
  throw new Error(`${pool.length} elements match ${what}; pass --role or --nth N:\n  `
    + pool.slice(0, 12).map(describe).join("\n  "));
}

// ── device scripts ───────────────────────────────────────────────────────────

/** POSIX single-quoting for the phone's sh. */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const seconds = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);

/** Read focus, size, status bar, lock and wake state, and print them. Sets
 *  $pkg, $W, $H, $SB, $KG, $AWAKE for the rest of the script. */
const DEVICE_STATE = [
  `w=$(dumpsys window 2>/dev/null)`,
  `focus=$(printf '%s\\n' "$w" | grep -m1 'mCurrentFocus=')`,
  `focus=\${focus#*mCurrentFocus=}`,
  `echo "${P}FOCUS $focus"`,
  `tok=\${focus##* }; tok=\${tok%\\}}; pkg=\${tok%%/*}`,
  `case "$focus" in null|"") pkg="" ;; esac`,
  `echo "${P}PKG $pkg"`,
  `cur=$(printf '%s\\n' "$w" | grep -m1 -o 'cur=[0-9]*x[0-9]*'); cur=\${cur#cur=}; W=\${cur%x*}; H=\${cur#*x}`,
  `echo "${P}SIZE $W $H"`,
  `sb=$(printf '%s\\n' "$w" | grep -m1 -o 'type=statusBars frame=\\[[0-9]*,[0-9]*\\]\\[[0-9]*,[0-9]*\\]')`,
  `SB=\${sb##*,}; SB=\${SB%]}; case "$SB" in ''|*[!0-9]*) SB=0 ;; esac`,
  `echo "${P}SB $SB"`,
  `KG=$(printf '%s\\n' "$w" | grep -m1 -o 'isKeyguardShowing=[a-z]*'); KG=\${KG#*=}`,
  `echo "${P}KEYGUARD $KG"`,
  `AWAKE=$(dumpsys power 2>/dev/null | grep -m1 -o 'mWakefulness=[A-Za-z]*'); AWAKE=\${AWAKE#*=}`,
  `echo "${P}AWAKE $AWAKE"`,
  `refuse() { echo "${P}REFUSE $1"; exit ${REFUSED}; }`,
  // A frame hash that skips the status bar, whose clock and live network meter
  // change on their own. Raw frames are a 12- or 16-byte header, then W*4
  // bytes per row; a 4-byte misalignment does not matter to a hash.
  `SKIP=$((16 + W * 4 * SB + 1))`,
  `fh() { screencap 2>/dev/null | tail -c +$SKIP | md5sum | cut -d' ' -f1; }`,
  `inb() { [ "$1" -ge 0 ] && [ "$1" -lt "$W" ] && [ "$2" -ge 0 ] && [ "$2" -lt "$H" ] || refuse "point $1,$2 is outside the \${W}x\${H} display"; }`,
].join("\n");

/** Where the UI helper (android/uiserver) lives on the phone. Files are
 *  created under umask 077, so only adb's shell user can read the token. */
const UI = {
  jar: "/data/local/tmp/fleet-ui.jar",
  token: "/data/local/tmp/fleet-ui.token",
  port: "/data/local/tmp/fleet-ui.port",
  log: "/data/local/tmp/fleet-ui.log",
};
/** How long the helper holds its accessibility connection with no request.
 *  Short on purpose: some apps react to an accessibility client being present. */
const UI_IDLE_MS = 120_000;

/** Read the UI tree into a file. The helper answers in ~0.1 s from a held
 *  UiAutomation connection; it is started when missing, and `uiautomator dump`
 *  (~2.5 s, and "could not get idle state" while the screen animates, so one
 *  retry) covers a phone without the helper jar. `dumpto FILE` leaves
 *  $UIVIA set to how the tree was read. */
const DEVICE_DUMP = [
  `ui_ask() { [ -s ${UI.port} ] && [ -s ${UI.token} ] && printf '%s %s\\n' "$(cat ${UI.token})" "$1" | timeout -s KILL 6 nc -w 2 127.0.0.1 "$(cat ${UI.port})" 2>/dev/null; }`,
  `ui_start() {`,
  `  [ "$(md5sum ${UI.jar} 2>/dev/null | cut -c1-32)" = ${UI_JAR_MD5} ] || { echo "${P}UIJAR missing"; return 1; }`,
  `  head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n' > ${UI.token}`,
  `  port=$(( 40000 + $(od -An -tu2 -N2 /dev/urandom | tr -d ' ') % 20000 ))`,
  `  rm -f ${UI.log} ${UI.port}`,
  // Only the log and /dev/null reach the helper: an inherited descriptor from
  // this adb session would keep the session open for the helper's lifetime.
  `  ( exec 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&-; CLASSPATH=${UI.jar} exec setsid app_process / fleet.UiServer $port ${UI.token} ${UI_IDLE_MS} ) > ${UI.log} 2>&1 < /dev/null &`,
  `  n=0; while [ $n -lt 40 ] && ! grep -q READY ${UI.log} 2>/dev/null; do sleep 0.1; n=$((n + 1)); done`,
  `  grep -q READY ${UI.log} 2>/dev/null && echo $port > ${UI.port}`,
  `}`,
  `dumpto() {`,
  `  rm -f "$1"`,
  `  if { ui_ask dump > "$1" && grep -q '</hierarchy>' "$1"; } || { ui_start && ui_ask dump > "$1" && grep -q '</hierarchy>' "$1"; }; then UIVIA=helper; return 0; fi`,
  `  UIVIA=uiautomator; rm -f ${UI.port}`,
  `  x=$(uiautomator dump "$1" 2>&1)`,
  `  [ -s "$1" ] || { sleep 0.4; x=$(uiautomator dump "$1" 2>&1); }`,
  `  [ -s "$1" ]`,
  `}`,
  // A helper started from an older jar would not know the gesture request;
  // installing the current jar stops it.
  `ui_ready() {`,
  `  [ "$(md5sum ${UI.jar} 2>/dev/null | cut -c1-32)" = ${UI_JAR_MD5} ] || { echo "${P}UIJAR missing"; refuse "the UI helper that sends multi-finger gestures is missing or out of date"; }`,
  `  [ "$(ui_ask ping)" = pong ] && return 0`,
  `  ui_start || refuse "the UI helper that sends multi-finger gestures is not on the phone yet"`,
  `  [ "$(ui_ask ping)" = pong ] || refuse "the UI helper did not start; see ${UI.log} on the phone"`,
  `}`,
  // Sent once. A lost reply is a failure, never a resend: the fingers may
  // already have moved.
  `ui_gesture() {`,
  `  r=$(printf '%s gesture %s\\n' "$(cat ${UI.token})" "$1" | timeout -s KILL 12 nc -w 2 127.0.0.1 "$(cat ${UI.port})" 2>/dev/null)`,
  `  [ "$r" = ok ] || { echo "gesture failed: \${r:-the UI helper did not answer}"; return 1; }`,
  `}`,
  `dump() {`,
  `  f=/data/local/tmp/fleet-ui-$$.xml`,
  `  if dumpto "$f"; then echo "${P}UIVIA $UIVIA"; echo "${P}XML"; cat "$f"; echo; echo "${P}XMLEND"`,
  `  else echo "${P}DUMPERR $(printf '%s' "$x" | tr '\\n' ' ')"; fi`,
  `  rm -f "$f"`,
  `}`,
].join("\n");

/** The gates every input passes before it is sent. */
function deviceGates(target: string | undefined, opts: { needAwake?: boolean; needUnlocked?: boolean } = {}): string {
  const lines: string[] = [];
  if (opts.needAwake !== false)
    lines.push(`[ "$AWAKE" = Awake ] || refuse "the screen is off (mWakefulness=$AWAKE); wake it with: key any wakeup"`);
  if (opts.needUnlocked !== false)
    lines.push(`[ "$KG" = true ] && refuse "the phone is locked; unlock it by hand (fleet never enters a PIN or pattern)"`);
  if (target !== undefined && target !== "any")
    lines.push(`case "$pkg" in ${androidTargetPattern(target)}) ;; *) refuse "focus is on \${pkg:-nothing} ($focus), not ${target}" ;; esac`);
  return lines.join("\n");
}

/** The `case` pattern a target matches the focused package with: a dotted
 *  name is an exact package, a bare word is a substring (chrome → com.android.chrome). */
export function androidTargetPattern(target: string): string {
  if (target === "any") return "*";
  if (!/^[A-Za-z0-9._-]+$/.test(target))
    throw new Error(`target must be a package name, a word in one, or "any" (got '${target}')`);
  return target.includes(".") ? target : `*${target}*`;
}

const KEYS: Record<string, string> = {
  back: "KEYCODE_BACK", home: "KEYCODE_HOME", recents: "KEYCODE_APP_SWITCH", app_switch: "KEYCODE_APP_SWITCH",
  enter: "KEYCODE_ENTER", return: "KEYCODE_ENTER", tab: "KEYCODE_TAB", space: "KEYCODE_SPACE",
  backspace: "KEYCODE_DEL", del: "KEYCODE_DEL", delete: "KEYCODE_FORWARD_DEL", escape: "KEYCODE_ESCAPE", esc: "KEYCODE_ESCAPE",
  up: "KEYCODE_DPAD_UP", down: "KEYCODE_DPAD_DOWN", left: "KEYCODE_DPAD_LEFT", right: "KEYCODE_DPAD_RIGHT",
  search: "KEYCODE_SEARCH", menu: "KEYCODE_MENU", volume_up: "KEYCODE_VOLUME_UP", volume_down: "KEYCODE_VOLUME_DOWN",
  wakeup: "KEYCODE_WAKEUP", move_home: "KEYCODE_MOVE_HOME", move_end: "KEYCODE_MOVE_END",
};
const FORBIDDEN_KEYS = new Set(["KEYCODE_POWER", "KEYCODE_SLEEP", "KEYCODE_SOFT_SLEEP", "KEYCODE_LOCK"]);

/** A key name or KEYCODE_* constant as the keycode `input keyevent` takes.
 *  Keys that put the phone to sleep are refused: fleet cannot unlock it again. */
export function androidKeycode(key: string): string {
  const code = KEYS[key.toLowerCase()] ?? (/^KEYCODE_[A-Z0-9_]+$/.test(key) ? key : undefined);
  if (!code) throw new Error(`unknown key '${key}'; use ${Object.keys(KEYS).join(", ")}, or a KEYCODE_* name`);
  if (FORBIDDEN_KEYS.has(code)) throw new Error(`${code} would turn the screen off or lock the phone, and fleet cannot unlock it`);
  return code;
}

/** Text as `input text` takes it. That command types ASCII only (anything else
 *  needs an IME on the phone) and reads %s as a space. */
export function androidInputText(text: string): string {
  if (!text) throw new Error("type needs some text");
  if (!/^[\x20-\x7e]+$/.test(text))
    throw new Error("adb's `input text` types printable ASCII only; other characters need an IME on the phone, which fleet does not install");
  if (text.includes("%s")) throw new Error("`input text` reads %s as a space, so the literal text %s cannot be typed");
  return text.replace(/ /g, "%s");
}

// ── running on the phone ─────────────────────────────────────────────────────

export interface AndroidState {
  focus?: string;          // the raw mCurrentFocus window
  pkg?: string;            // its package, empty when nothing holds focus
  width?: number;
  height?: number;
  statusBar?: number;      // status-bar height in pixels
  locked?: boolean;
  awake?: string;          // mWakefulness: Awake, Asleep, Dozing, Dreaming
}

interface PhoneRun {
  result: ExecResult;
  images: Map<string, Uint8Array>;
  lines: Map<string, string[]>;
  state: AndroidState;
  refusal?: string;
  error?: string;
  xml?: string;
  image?: { bytes: Uint8Array; format: "webp" | "png"; width: number; height: number; deviceWidth: number; deviceHeight: number };
}

type Run = typeof exec;

/** The host a selector names, and its adb serial. Throws for a host that is not an Android phone. */
export function androidHost(cfg: FleetConfig, sel: string): { host: Host; serial: string } {
  const host = resolveHosts(cfg, sel)[0];
  if (!host) throw new Error(`no host matches '${sel}'`);
  if (!host.android) throw new Error(`${host.name} is not an Android host (give it an "android" block in fleet.config.json)`);
  return { host, serial: host.android.serial ?? ANDROID_DEFAULT_SERIAL };
}
export const isAndroidHost = (cfg: FleetConfig, sel: string): boolean => {
  try { return !!resolveHosts(cfg, sel)[0]?.android; } catch { return false; }
};

/** Termux lines that capture the screen, encode it, and print it inline.
 *  Raw frames avoid screencap's slow on-phone PNG encoder; cwebp reads them
 *  as PAM. Without cwebp, or for a frame format other than RGBA_8888, the
 *  capture falls back to screencap's PNG. */
function termuxCapture(width: number | undefined): string {
  return [
    `T=$(mktemp -d "\${TMPDIR:-/tmp}/fleet-a.XXXXXX")`,
    `adb -s "$S" exec-out screencap > "$T/s.raw"`,
    `read -r RW RH RF _ < <(od -An -tu4 -N16 "$T/s.raw")`,
    `HDR=$(( $(wc -c < "$T/s.raw") - RW * RH * 4 ))`,
    `OUTW=${width ? `$(( ${width} < RW ? ${width} : RW ))` : "$(( RW / 2 ))"}`,
    `if command -v cwebp >/dev/null 2>&1 && [ "$RF" = 1 ] && { [ "$HDR" = 16 ] || [ "$HDR" = 12 ]; }; then`,
    `  { printf 'P7\\nWIDTH %d\\nHEIGHT %d\\nDEPTH 4\\nMAXVAL 255\\nTUPLTYPE RGB_ALPHA\\nENDHDR\\n' "$RW" "$RH"; tail -c +$((HDR + 1)) "$T/s.raw"; } > "$T/s.pam"`,
    `  img="$T/s.webp"; cwebp -quiet -q 75 -resize "$OUTW" 0 -noalpha "$T/s.pam" -o "$img" && echo "${P}IMG webp $OUTW $(( RH * OUTW / RW )) $RW $RH"`,
    `else`,
    `  img="$T/s.png"; adb -s "$S" exec-out screencap -p > "$img" && echo "${P}IMG png $RW $RH $RW $RH"`,
    `fi`,
    emitImage("linux", "img", "screen"),
    `rm -rf "$T"`,
  ].join("\n");
}

/** Run a device script through Termux's adb, optionally followed by a capture
 *  that is skipped when the device script refused. */
async function runPhone(
  cfg: FleetConfig, sel: string, device: string,
  opts: { capture?: { width?: number }; extraTermux?: string; extraAfter?: string; deviceTimeoutS?: number } = {},
  run: Run = exec,
): Promise<PhoneRun> {
  const deviceTimeoutS = opts.deviceTimeoutS ?? 60;
  const { host, serial } = androidHost(cfg, sel);
  // Wrapped in a subshell so a command that reads stdin cannot swallow the rest
  // of the script, the same way fleet runs POSIX programs.
  // `true` ends a finished script cleanly: its last line may be a test like
  // `[ … ] && dump`, whose false branch would otherwise become the exit code.
  // umask 077: adb's shell creates world-readable files by default, and a saved
  // screen frame or UI dump in /data/local/tmp must not be readable by apps.
  const body = `(\numask 077\n${device}\ntrue\n) </dev/null`;
  const b64 = Buffer.from(body, "utf8").toString("base64");
  const script = [
    `S=${sq(serial)}`,
    opts.extraTermux ?? "",
    `command -v adb >/dev/null 2>&1 || { echo "${P}ERR adb is not installed in Termux; run: pkg install android-tools"; exit ${REFUSED}; }`,
    `st=$(adb -s "$S" get-state 2>/dev/null)`,
    `if [ "$st" != device ]; then adb connect "$S" >/dev/null 2>&1; sleep 0.5; st=$(adb -s "$S" get-state 2>&1); fi`,
    `[ "$st" = device ] || { echo "${P}ERR adb cannot reach $S ($st). adbd stops listening after a reboot: turn on Wireless debugging, then run: fleet cu ${host.name} bootstrap"; exit ${REFUSED}; }`,
    // Bounded below fleet's own exec timeout, so a phone that stops answering
    // fails with a reason instead of holding the call open.
    // The script travels as an argument with stdin closed (-n). Fed through
    // stdin instead, about one call in ten never saw the session end after the
    // script had finished, and hung until the timeout.
    `out=$(timeout -k 3 ${deviceTimeoutS} adb -s "$S" shell -n -T "echo ${b64} | base64 -d | sh" 2>&1); code=$?`,
    // Over mobile data the link carries ~10–15 KB/s, and a UI tree is ~25 KB of
    // XML that gzips ~12x, so a large reply travels compressed.
    `if [ \${#out} -gt 2048 ] && command -v gzip >/dev/null 2>&1; then echo "${P}GZ"; printf '%s\\n' "$out" | gzip -c -6 | base64; echo "${P}GZEND"; else printf '%s\\n' "$out"; fi`,
    `[ $code = 124 ] || [ $code = 137 ] && { echo "${P}ERR the phone did not finish within ${deviceTimeoutS} s"; exit 1; }`,
    `case "$out" in *${P}REFUSE*) exit ${REFUSED} ;; *${P}STALE*) exit ${STALE} ;; esac`,
    ...(opts.extraAfter ? [opts.extraAfter] : []),
    ...(opts.capture ? [termuxCapture(opts.capture.width)] : []),
    `exit $code`,
  ].join("\n");
  const raw = await run(host, script, "bash", { timeoutMs: (deviceTimeoutS + 30) * 1000 });
  const { images, rest: packed } = takeInlineImages(raw.stdout);
  const rest = unpackReply(packed);
  const lines = new Map<string, string[]>();
  let xml: string | undefined;
  const xmlLines: string[] = [];
  const kept: string[] = [];
  let inXml = false;
  for (const line of rest.split("\n")) {
    if (line === `${P}XML`) { inXml = true; continue; }
    if (line === `${P}XMLEND`) { inXml = false; xml = xmlLines.join("\n"); continue; }
    if (inXml) { xmlLines.push(line); continue; }
    const m = line.match(new RegExp(`^${P}([A-Z_]+)(?: (.*))?$`));
    if (m) lines.set(m[1]!, [...(lines.get(m[1]!) ?? []), m[2] ?? ""]);
    else if (line.trim()) kept.push(line);
  }
  const one = (k: string) => lines.get(k)?.at(-1);
  const [w, h] = (one("SIZE") ?? "").split(" ").map(Number);
  const state: AndroidState = {
    ...(one("FOCUS") !== undefined ? { focus: one("FOCUS") } : {}),
    ...(one("PKG") !== undefined ? { pkg: one("PKG") } : {}),
    ...(w && h ? { width: w, height: h } : {}),
    ...(one("SB") !== undefined ? { statusBar: Number(one("SB")) } : {}),
    ...(one("KEYGUARD") ? { locked: one("KEYGUARD") === "true" } : {}),
    ...(one("AWAKE") ? { awake: one("AWAKE") } : {}),
  };
  const refusal = one("REFUSE");
  const error = one("ERR") ?? (one("DUMPERR") !== undefined ? `uiautomator dump failed: ${one("DUMPERR")}` : undefined);
  const result: ExecResult = { ...raw, stdout: kept.join("\n") };
  const out: PhoneRun = { result, images, lines, state, ...(refusal ? { refusal } : {}), ...(error ? { error } : {}), ...(xml ? { xml } : {}) };
  const bytes = images.get("screen");
  const info = one("IMG")?.split(" ");
  if (bytes && info) out.image = {
    bytes, format: info[0] === "png" ? "png" : "webp",
    width: Number(info[1]), height: Number(info[2]), deviceWidth: Number(info[3]), deviceHeight: Number(info[4]),
  };
  return out;
}

/** Expand the gzip block a large reply travels in, in place. */
export function unpackReply(stdout: string): string {
  const start = stdout.indexOf(`${P}GZ\n`);
  const end = stdout.indexOf(`\n${P}GZEND`, start);
  if (start < 0 || end < 0) return stdout;
  const b64 = stdout.slice(start + P.length + 3, end).replace(/\s+/g, "");
  const text = gunzipSync(Buffer.from(b64, "base64")).toString("utf8");
  return stdout.slice(0, start) + text + stdout.slice(end + P.length + 6 + 1);
}

const failed = (r: PhoneRun, message: string): ExecResult => ({
  ...r.result, ok: false, code: r.result.code || 1,
  stderr: [r.result.stderr, message].filter(Boolean).join("\n"),
});

// ── the saved UI tree ────────────────────────────────────────────────────────

/** Injected I/O. `cacheDir` holds each phone's last UI tree (default ~/.fleet). */
export interface AndroidDeps { exec?: Run; cacheDir?: string }
/** Exit code of an input the phone withheld because the screen no longer
 *  matched the tree its element came from. */
const STALE = 4;
/** The raw frame the last UI-tree read saw, kept on the phone. */
const FRAME_FILE = "/data/local/tmp/fleet-ui-frame.raw";

interface TreeCache { hash: string; xml: string; width?: number; height?: number }
const cacheFile = (deps: AndroidDeps, host: string) =>
  join(deps.cacheDir ?? join(homedir(), ".fleet"), `android-${host.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
async function readTreeCache(deps: AndroidDeps, host: string): Promise<TreeCache | undefined> {
  try {
    const c = JSON.parse(await readFile(cacheFile(deps, host), "utf8")) as TreeCache;
    return typeof c.hash === "string" && typeof c.xml === "string" ? c : undefined;
  } catch { return undefined; }
}
async function writeTreeCache(deps: AndroidDeps, host: string, c: TreeCache): Promise<void> {
  const path = cacheFile(deps, host);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(c));
}
async function dropTreeCache(deps: AndroidDeps, host: string): Promise<void> {
  await rm(cacheFile(deps, host), { force: true });
}

// ── actions ──────────────────────────────────────────────────────────────────

export interface AndroidStateResult { host: string; result: ExecResult; state: AndroidState; refusal?: string }

/** Focus, size, lock and wake state. No input, no capture. */
export async function androidState(cfg: FleetConfig, sel: string, deps: { exec?: Run } = {}): Promise<AndroidStateResult> {
  const { host } = androidHost(cfg, sel);
  const r = await runPhone(cfg, sel, DEVICE_STATE, {}, deps.exec);
  const result = r.error ? failed(r, r.error) : r.result;
  return { host: host.name, result, state: r.state };
}

export interface AndroidDoctorCheck { check: string; ok: boolean; detail: string }
export interface AndroidDoctorResult { host: string; ok: boolean; checks: AndroidDoctorCheck[]; state: AndroidState }

/** Every link from SSH to the phone's input system, each reported on its own. */
export async function androidDoctor(cfg: FleetConfig, sel: string, deps: { exec?: Run } = {}): Promise<AndroidDoctorResult> {
  const { host, serial } = androidHost(cfg, sel);
  const device = [
    DEVICE_STATE,
    `echo "${P}ANDROID $(getprop ro.build.version.release) $(getprop ro.product.model)"`,
    `echo "${P}TCPPORT $(getprop service.adb.tcp.port)"`,
    `command -v uiautomator >/dev/null && echo "${P}UIAUTOMATOR yes" || echo "${P}UIAUTOMATOR no"`,
    DEVICE_DUMP,
    `[ "$(md5sum ${UI.jar} 2>/dev/null | cut -c1-32)" = ${UI_JAR_MD5} ] && echo "${P}UIJARSTATE current" || echo "${P}UIJARSTATE missing"`,
    `[ -n "$(ui_ask ping)" ] && echo "${P}UIHELPER running" || echo "${P}UIHELPER stopped"`,
  ].join("\n");
  const termux = [
    `echo "${P}TERMUX $(uname -m)"`,
    `command -v adb >/dev/null 2>&1 && echo "${P}ADB $(adb version 2>/dev/null | sed -n 2p)"`,
    `command -v cwebp >/dev/null 2>&1 && echo "${P}CWEBP yes" || echo "${P}CWEBP no"`,
  ].join("\n");
  const r = await runPhone(cfg, sel, device, { extraTermux: termux }, deps.exec);
  const one = (k: string) => r.lines.get(k)?.at(-1);
  const checks: AndroidDoctorCheck[] = [];
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });
  add("ssh to Termux", one("TERMUX") !== undefined, one("TERMUX") !== undefined ? `${host.ssh} (${one("TERMUX")})`
    : (r.result.stderr || r.result.stdout || `exit ${r.result.code}`).split("\n")[0]!);
  if (one("TERMUX") !== undefined) {
    add("adb in Termux", one("ADB") !== undefined, one("ADB") ?? "missing: pkg install android-tools");
    add("cwebp in Termux", one("CWEBP") === "yes", one("CWEBP") === "yes" ? "screenshots encode to WebP on the phone"
      : "missing: pkg install libwebp (screenshots fall back to slow full-size PNG)");
    add(`adbd at ${serial}`, !r.error && r.state.pkg !== undefined,
      r.error ?? `Android ${one("ANDROID") ?? "?"}; adb tcp port ${one("TCPPORT") || "unset"}`);
  }
  if (r.state.pkg !== undefined) {
    add("screen awake", r.state.awake === "Awake", `mWakefulness=${r.state.awake ?? "?"}`);
    add("unlocked", r.state.locked === false, r.state.locked ? "locked: input is refused until it is unlocked by hand" : "keyguard not showing");
    add("uiautomator", one("UIAUTOMATOR") === "yes", one("UIAUTOMATOR") === "yes" ? "UI tree readable" : "missing");
    // Informational: a phone without the helper still works through uiautomator.
    checks.push({ check: "UI helper", ok: true, detail: one("UIJARSTATE") === "current"
      ? `installed, ${one("UIHELPER") === "running" ? "running (release stops it)" : "starts on the next read"}`
      : "not installed yet: the next elements read installs it (reads take ~2.5 s until then)" });
  }
  return { host: host.name, ok: checks.every((c) => c.ok), checks, state: r.state };
}

export interface AndroidElementsResult {
  host: string; result: ExecResult; state: AndroidState;
  elements: AndroidElement[]; total: number;
  frame?: string;          // hash of the screen right after the dump
  via?: "helper" | "uiautomator";
}

/** The current screen's UI tree, from uiautomator, with no screenshot taken. */
export async function androidElementsOf(
  cfg: FleetConfig, sel: string, opts: { all?: boolean; filter?: string; role?: string } = {}, deps: AndroidDeps = {},
): Promise<AndroidElementsResult> {
  const { host } = androidHost(cfg, sel);
  // uiautomator waits for the screen to go idle before it dumps, so a hash
  // taken right after describes the same screen the tree does.
  // The raw frame stays on the phone, so a later label action can compare just
  // its element's rows when something elsewhere on the screen keeps moving.
  const r = await runPhone(cfg, sel, [DEVICE_STATE, DEVICE_DUMP, "dump",
    `screencap > ${FRAME_FILE} 2>/dev/null && echo "${P}FRAME $(tail -c +$SKIP ${FRAME_FILE} | md5sum | cut -d' ' -f1)"`,
  ].join("\n"), {}, deps.exec);
  // A phone without the helper got uiautomator this time; installing it now
  // makes the next read fast.
  if (r.lines.has("UIJAR")) await installUiHelper(cfg, sel, deps);
  if (r.error || !r.xml) return { host: host.name, result: failed(r, r.error ?? "the UI dump returned nothing"),
    state: r.state, elements: [], total: 0 };
  const frame = r.lines.get("FRAME")?.at(-1);
  if (frame && /^[0-9a-f]{32}$/.test(frame))
    await writeTreeCache(deps, host.name, { hash: frame, xml: r.xml, width: r.state.width, height: r.state.height });
  else await dropTreeCache(deps, host.name);
  const nodes = parseUiDump(r.xml);
  let elements = androidElements(nodes, { all: opts.all, width: r.state.width, height: r.state.height });
  const total = elements.length;
  if (opts.role) elements = elements.filter((e) => e.role.toLowerCase() === opts.role!.toLowerCase());
  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    elements = elements.filter((e) => [e.label, e.text, e.desc, e.hint, e.id].some((v) => v.toLowerCase().includes(f)));
  }
  const via = r.lines.get("UIVIA")?.at(-1);
  return { host: host.name, result: r.result, state: r.state, elements, total, ...(frame ? { frame } : {}),
    ...(via === "helper" || via === "uiautomator" ? { via } : {}) };
}

export interface AndroidShotResult {
  host: string; result: ExecResult; state: AndroidState; localImage?: string;
  image?: { format: "webp" | "png"; width: number; height: number; deviceWidth: number; deviceHeight: number };
}

/** Capture the screen, encoded on the phone, written to `out` with the
 *  extension of the format that came back. */
export async function androidShot(
  cfg: FleetConfig, sel: string, out: string, opts: { width?: number } = {}, deps: { exec?: Run } = {},
): Promise<AndroidShotResult> {
  const { host } = androidHost(cfg, sel);
  const r = await runPhone(cfg, sel, DEVICE_STATE, { capture: { width: opts.width ?? host.android?.shotWidth } }, deps.exec);
  if (r.error) return { host: host.name, result: failed(r, r.error), state: r.state };
  if (!r.image) return { host: host.name, result: failed(r, "the capture produced no image"), state: r.state };
  const { bytes, ...image } = r.image;
  const local = out.replace(/\.(png|webp)$/i, "") + `.${image.format}`;
  await writeFile(local, bytes);
  await validateImageArtifact(local);
  return { host: host.name, result: r.result, state: r.state, localImage: local, image };
}

export type AndroidAction =
  | { kind: "tap"; x?: number; y?: number }
  | { kind: "long_press"; x?: number; y?: number; ms?: number }
  | { kind: "swipe"; x1: number; y1: number; x2: number; y2: number; ms?: number }
  | { kind: "scroll"; direction: "up" | "down" | "left" | "right"; amount?: number }
  /** Two fingers, each from its own start, both moved by dx,dy. */
  | { kind: "swipe2"; x1: number; y1: number; x2: number; y2: number; dx: number; dy: number; ms?: number }
  /** Fingers that land together and move in straight lines, one stroke each. */
  | { kind: "gesture"; strokes: AndroidStroke[]; ms?: number; summary?: string }
  /** Two fingers apart (in) or together (out). With no point and no element,
   *  the target and the spread are guessed from the UI tree. */
  | { kind: "zoom"; direction: "in" | "out"; x?: number; y?: number; scale?: number; ms?: number }
  | { kind: "key"; key: string }
  | { kind: "type"; text: string };

export type AndroidEffect = "changed" | "no_change" | "indeterminate";
/** One finger's path in device pixels: [x1, y1, x2, y2]. */
export type AndroidStroke = [number, number, number, number];

const GESTURE_LIMITS = { fingers: 5, minMs: 50, maxMs: 5000 };

/** Classes and ids of views that usually take a pinch: images, maps, web
 *  pages, documents, camera previews, drawing surfaces. */
const ZOOMABLE = /image|photo|picture|map|web|pdf|document|zoom|scale|canvas|preview|viewer|surface|texture|gl|terminal/i;

export interface AndroidZoomPlan { strokes: AndroidStroke[]; element?: AndroidElement; center: { x: number; y: number }; scale: number; guess: string }

/** Where a zoom goes and how far its fingers travel. An element (from a label)
 *  or a point fixes the centre; otherwise the largest view that looks zoomable
 *  is the target, then the largest scrollable one, then the largest of all.
 *  The fingers sit on a diagonal through the centre and stay 8% inside the
 *  target and the display, clear of the status bar and the gesture bar. */
export function androidZoomPlan(
  elements: AndroidElement[],
  o: { direction: "in" | "out"; x?: number; y?: number; scale?: number; element?: AndroidElement; width?: number; height?: number },
): AndroidZoomPlan {
  const scale = o.scale ?? 2.5;
  if (!Number.isFinite(scale) || scale < 1.2 || scale > 10) throw new Error("zoom scale must be from 1.2 to 10");
  if ((o.x === undefined) !== (o.y === undefined) || [o.x, o.y].some((n) => n !== undefined && !Number.isFinite(n)))
    throw new Error("zoom takes both x and y, or neither");
  const W = o.width ?? Math.max(0, ...elements.map((e) => e.bounds.x2));
  const H = o.height ?? Math.max(0, ...elements.map((e) => e.bounds.y2));
  const area = (e: AndroidElement) => (e.bounds.x2 - e.bounds.x1) * (e.bounds.y2 - e.bounds.y1);
  const holds = (e: AndroidElement, x: number, y: number) =>
    x >= e.bounds.x1 && x < e.bounds.x2 && y >= e.bounds.y1 && y < e.bounds.y2;
  const zoomable = (e: AndroidElement) => ZOOMABLE.test(e.role) || ZOOMABLE.test(e.id) || /\b(map|photo|image|picture)\b/i.test(e.desc);
  const largest = (es: AndroidElement[]) => es.reduce<AndroidElement | undefined>((a, e) => !a || area(e) > area(a) ? e : a, undefined);
  const describe = (e: AndroidElement) => `${e.role}${e.id ? ` #${e.id}` : ""}${e.label ? ` ${JSON.stringify(e.label)}` : ""}`;

  let el = o.element;
  let guess: string;
  if (el) guess = `on ${describe(el)}`;
  else if (o.x !== undefined && o.y !== undefined) {
    const under = elements.filter((e) => area(e) > 0 && holds(e, o.x!, o.y!));
    // The smallest zoomable view under the point, else the largest view there.
    el = under.filter(zoomable).reduce<AndroidElement | undefined>((a, e) => !a || area(e) < area(a) ? e : a, undefined)
      ?? largest(under);
    guess = el ? `inside ${describe(el)} (guessed)` : "on the display";
  } else {
    const big = elements.filter((e) => area(e) >= 0.05 * W * H);
    el = largest(big.filter(zoomable)) ?? largest(big.filter((e) => e.actions.includes("scroll"))) ?? largest(elements);
    guess = el ? `on ${describe(el)} (guessed)` : "on the display (guessed)";
  }
  const b = el?.bounds ?? { x1: 0, y1: 0, x2: W, y2: H };
  const box = { x1: Math.max(b.x1, 0), y1: Math.max(b.y1, 0), x2: Math.min(b.x2, W || b.x2), y2: Math.min(b.y2, H || b.y2) };
  const insetX = 0.08 * (box.x2 - box.x1), insetY = 0.08 * (box.y2 - box.y1);
  const safe = { x1: Math.max(box.x1 + insetX, 0.08 * W), y1: Math.max(box.y1 + insetY, 0.08 * H),
    x2: Math.min(box.x2 - insetX, 0.92 * W), y2: Math.min(box.y2 - insetY, 0.92 * H) };
  const cx = Math.round(o.x ?? (safe.x1 + safe.x2) / 2), cy = Math.round(o.y ?? (safe.y1 + safe.y2) / 2);
  if (!(W > 0 && H > 0)) throw new Error("zoom needs the display size; read the screen with elements first");
  if (cx < 0 || cx >= W || cy < 0 || cy >= H) throw new Error(`point ${cx},${cy} is outside the ${W}x${H} display`);
  // Per-axis offset of each finger from the centre, on a 45° diagonal.
  const far = Math.floor(Math.min(cx - safe.x1, safe.x2 - cx, cy - safe.y1, safe.y2 - cy));
  const MIN_NEAR = 40;   // keeps the fingers ~110 px apart, so they read as two
  if (far < MIN_NEAR * 1.2) throw new Error(`there is no room to zoom around ${cx},${cy}: the target is too small or the point too near its edge`);
  const near = Math.max(MIN_NEAR, Math.round(far / scale));
  const [from, to] = o.direction === "in" ? [near, far] : [far, near];
  const strokes: AndroidStroke[] = [
    [cx - from, cy - from, cx - to, cy - to],
    [cx + from, cy + from, cx + to, cy + to],
  ];
  return { strokes, ...(el ? { element: el } : {}), center: { x: cx, y: cy }, scale: Math.round(far / near * 10) / 10, guess };
}

/** Frames hashed after the first changed one, looking for two in a row that agree. */
const STABLE_TRIES = 6;

/** What the pixels did. Equal before and after frames are no_change. A screen
 *  that moved and settled is changed, unless it settled back where it started
 *  (a ripple, a flash). A screen that never settled proves nothing. */
export function androidEffect(hA: string, hB: string, hC: string, unstable: boolean): { effect: AndroidEffect; reason?: string } {
  if (!hA || !hB) return { effect: "indeterminate", reason: "a frame capture failed, so the before/after comparison could not run" };
  if (hA === hB) return { effect: "no_change" };
  if (hC === hA) return { effect: "no_change", reason: "the screen moved and settled back where it started" };
  if (hC) return { effect: "changed" };
  if (unstable) return { effect: "indeterminate", reason: "the screen kept changing for ~3 s (animation, video, a blinking cursor)"
    + " — the pixels moved, but not provably because of this action" };
  return { effect: "indeterminate", reason: "the settling capture failed, so the pixel change could not be verified" };
}

export interface AndroidActResult {
  host: string; result: ExecResult; state: AndroidState;
  effect: AndroidEffect; reason?: string; refusal?: string;
  element?: AndroidElement;
  summary: string;
  hashes: string[];
  localImage?: string;
}

const int = (n: number) => String(Math.round(n));

/** The input commands for one action, in the phone's sh. Explicit points are
 *  checked against the display on the phone, where its size is known. */
function inputCommands(a: AndroidAction, el: AndroidElement | undefined): { checks: string[]; cmds: string[]; summary: string } {
  const at = (x?: number, y?: number): [string, string] => {
    if (el) return [int(el.center.x), int(el.center.y)];
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y))
      throw new Error(`${a.kind} needs x y or --label`);
    return [int(x), int(y)];
  };
  switch (a.kind) {
    case "tap": {
      const [x, y] = at(a.x, a.y);
      return { checks: [`inb ${x} ${y}`], cmds: [`input tap ${x} ${y}`], summary: `tap ${x},${y}` };
    }
    case "long_press": {
      const [x, y] = at(a.x, a.y);
      const ms = int(a.ms ?? 800);
      return { checks: [`inb ${x} ${y}`], cmds: [`input swipe ${x} ${y} ${x} ${y} ${ms}`], summary: `long_press ${x},${y} ${ms}ms` };
    }
    case "swipe": {
      const p = [a.x1, a.y1, a.x2, a.y2];
      if (p.some((n) => !Number.isFinite(n))) throw new Error("swipe needs four finite coordinates");
      const [x1, y1, x2, y2] = p.map(int);
      const ms = int(a.ms ?? 300);
      return { checks: [`inb ${x1} ${y1}`, `inb ${x2} ${y2}`], cmds: [`input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`],
        summary: `swipe ${x1},${y1} → ${x2},${y2} ${ms}ms` };
    }
    case "scroll": {
      const amount = a.amount ?? 1;
      if (!Number.isInteger(amount) || amount < 1 || amount > 10) throw new Error("scroll amount must be an integer from 1 to 10");
      // Content scrolls the opposite way to the finger: "down" reveals what is
      // below, so the finger moves up.
      const box = el ? { x1: int(el.bounds.x1), y1: int(el.bounds.y1), x2: int(el.bounds.x2), y2: int(el.bounds.y2) }
        : { x1: "0", y1: "$SB", x2: "$W", y2: "$H" };
      const cx = `$(( (${box.x1} + ${box.x2}) / 2 ))`, cy = `$(( (${box.y1} + ${box.y2}) / 2 ))`;
      const dy = `$(( (${box.y2} - ${box.y1}) * 3 / 10 ))`, dx = `$(( (${box.x2} - ${box.x1}) * 3 / 10 ))`;
      const [fx, fy, tx, ty] = {
        down: [cx, `$((${cy} + ${dy}))`, cx, `$((${cy} - ${dy}))`],
        up: [cx, `$((${cy} - ${dy}))`, cx, `$((${cy} + ${dy}))`],
        right: [`$((${cx} + ${dx}))`, cy, `$((${cx} - ${dx}))`, cy],
        left: [`$((${cx} - ${dx}))`, cy, `$((${cx} + ${dx}))`, cy],
      }[a.direction];
      const one = `input swipe ${fx} ${fy} ${tx} ${ty} 300`;
      return { checks: [], cmds: Array.from({ length: amount }, (_, i) => i ? `sleep 0.15; ${one}` : one),
        summary: `scroll ${a.direction} ${amount}` };
    }
    case "swipe2": {
      const p = [a.x1, a.y1, a.x2, a.y2, a.dx, a.dy];
      if (p.some((n) => !Number.isFinite(n))) throw new Error("swipe2 needs six finite numbers: x1 y1 x2 y2 dx dy");
      const [x1, y1, x2, y2, dx, dy] = p.map((n) => Math.round(n)) as [number, number, number, number, number, number];
      const g = gestureCommands([[x1, y1, x1 + dx, y1 + dy], [x2, y2, x2 + dx, y2 + dy]], a.ms ?? 200);
      return { ...g, summary: `swipe2 ${x1},${y1} + ${x2},${y2} by ${dx},${dy} ${g.ms}ms` };
    }
    case "gesture": {
      const g = gestureCommands(a.strokes, a.ms ?? 300);
      return { ...g, summary: a.summary ?? `gesture ${a.strokes.length} finger${a.strokes.length === 1 ? "" : "s"} ${g.ms}ms` };
    }
    case "zoom": throw new Error("zoom resolves to a gesture before it is sent");
    case "key": {
      const code = androidKeycode(a.key);
      return { checks: [], cmds: [`input keyevent ${code}`], summary: `key ${code}` };
    }
    case "type": {
      const text = androidInputText(a.text);
      const cmds = el ? [`input tap ${int(el.center.x)} ${int(el.center.y)}`, "sleep 0.3"] : [];
      return { checks: [], cmds: [...cmds, `input text ${sq(text)}`], summary: `type ${JSON.stringify(a.text.slice(0, 40))}` };
    }
  }
}

/** The helper call for fingers that land together and move in straight lines.
 *  Every end point is checked against the display first. */
function gestureCommands(strokes: AndroidStroke[], ms: number): { checks: string[]; cmds: string[]; ms: number } {
  if (!Array.isArray(strokes) || !strokes.length || strokes.length > GESTURE_LIMITS.fingers)
    throw new Error(`a gesture takes 1 to ${GESTURE_LIMITS.fingers} strokes`);
  if (!Number.isInteger(ms) || ms < GESTURE_LIMITS.minMs || ms > GESTURE_LIMITS.maxMs)
    throw new Error(`gesture duration must be ${GESTURE_LIMITS.minMs}–${GESTURE_LIMITS.maxMs} ms`);
  const pts = strokes.map((s, i) => {
    if (!Array.isArray(s) || s.length !== 4 || s.some((n) => !Number.isFinite(n)))
      throw new Error(`stroke ${i + 1} must be four numbers: x1, y1, x2, y2`);
    return s.map(int);
  });
  return {
    checks: [...pts.flatMap(([x1, y1, x2, y2]) => [`inb ${x1} ${y1}`, `inb ${x2} ${y2}`]), "ui_ready"],
    cmds: [`ui_gesture ${sq(`${ms} ${pts.map((p) => p.join(",")).join(" ")}`)}`],
    ms,
  };
}

const MULTI_TOUCH = new Set(["swipe2", "gesture", "zoom"]);

/** Send one input to the phone and report what its pixels did, the same way
 *  desktop computer use does: two status-bar-free frame hashes decide
 *  no_change, and a third separates a real change from a screen that keeps
 *  moving. Refused before any input when the screen is off, the phone is
 *  locked, or another package holds focus. */
export async function androidAct(
  cfg: FleetConfig, sel: string, target: string, action: AndroidAction,
  opts: { settleMs?: number; imageOut?: string; imageWidth?: number; element?: AndroidLocator } = {},
  deps: AndroidDeps = {},
): Promise<AndroidActResult> {
  const { host } = androidHost(cfg, sel);
  androidTargetPattern(target);
  if (action.kind === "zoom") return androidZoom(cfg, sel, target, action, opts, deps);
  if (!opts.element) {
    const r = await sendInput(cfg, sel, target, action, undefined, undefined, opts, deps);
    if (r === "stale") throw new Error("the phone withheld an input that carried no screen expectation");
    return r;
  }
  if (["key", "swipe", "swipe2", "gesture"].includes(action.kind)) throw new Error(`--label does not apply to ${action.kind}`);
  const usable = (el: AndroidElement) => {
    if (!el.enabled) throw new Error(`${el.role} ${JSON.stringify(el.label)} is disabled`);
    return el;
  };

  // The tree the last `elements` read, if the screen still looks the way it
  // did then: the phone compares the frame hash before any input and sends
  // nothing when it differs. A label the old tree cannot resolve falls through
  // to a fresh read, which decides.
  const cached = await readTreeCache(deps, host.name);
  if (cached) {
    let el: AndroidElement | undefined;
    try {
      el = androidPick(androidElements(parseUiDump(cached.xml), { width: cached.width, height: cached.height }), opts.element);
    } catch { el = undefined; }
    if (el) {
      const r = await sendInput(cfg, sel, target, action, usable(el), cached.hash, opts, deps);
      if (r !== "stale") return r;
    }
  }
  const listed = await androidElementsOf(cfg, sel, {}, deps);
  if (!listed.result.ok) return { host: host.name, result: listed.result, state: listed.state,
    effect: "indeterminate", summary: action.kind, hashes: [] };
  const el = usable(androidPick(listed.elements, opts.element));
  const r = await sendInput(cfg, sel, target, action, el, listed.frame, opts, deps);
  if (r !== "stale") return r;
  const reason = "the screen changed between reading it and acting on it; nothing was sent";
  return { host: host.name, state: listed.state, summary: action.kind, element: el, effect: "indeterminate",
    reason, refusal: reason, hashes: [],
    result: { ...listed.result, ok: false, code: 1, stderr: `refused: ${reason}` } };
}

/** A zoom planned against the UI tree: the saved one when the screen still
 *  hashes the same (the phone checks), else a fresh read. */
async function androidZoom(
  cfg: FleetConfig, sel: string, target: string, action: Extract<AndroidAction, { kind: "zoom" }>,
  opts: { settleMs?: number; imageOut?: string; imageWidth?: number; element?: AndroidLocator },
  deps: AndroidDeps,
): Promise<AndroidActResult> {
  const { host } = androidHost(cfg, sel);
  if (opts.element && action.x !== undefined) throw new Error("give x y or --label, not both");
  const plan = (elements: AndroidElement[], width?: number, height?: number) => {
    const el = opts.element ? androidPick(elements, opts.element) : undefined;
    const p = androidZoomPlan(elements, { ...action, element: el, width, height });
    const gesture: AndroidAction = { kind: "gesture", strokes: p.strokes, ms: action.ms ?? 400,
      summary: `zoom ${action.direction} ×${p.scale} at ${p.center.x},${p.center.y} ${p.guess}` };
    return { gesture, el: p.element };
  };
  const cached = await readTreeCache(deps, host.name);
  if (cached) {
    let p: ReturnType<typeof plan> | undefined;
    try {
      p = plan(androidElements(parseUiDump(cached.xml), { all: true, width: cached.width, height: cached.height }), cached.width, cached.height);
    } catch { p = undefined; }
    if (p) {
      const r = await sendInput(cfg, sel, target, p.gesture, p.el, cached.hash, opts, deps);
      if (r !== "stale") return r;
    }
  }
  const listed = await androidElementsOf(cfg, sel, { all: true }, deps);
  if (!listed.result.ok) return { host: host.name, result: listed.result, state: listed.state,
    effect: "indeterminate", summary: "zoom", hashes: [] };
  const p = plan(listed.elements, listed.state.width, listed.state.height);
  const r = await sendInput(cfg, sel, target, p.gesture, p.el, listed.frame, opts, deps);
  if (r !== "stale") return r;
  const reason = "the screen changed between reading it and acting on it; nothing was sent";
  return { host: host.name, state: listed.state, summary: "zoom", ...(p.el ? { element: p.el } : {}), effect: "indeterminate",
    reason, refusal: reason, hashes: [], result: { ...listed.result, ok: false, code: 1, stderr: `refused: ${reason}` } };
}

/** The check that the screen is still the one the element was read from.
 *  An identical frame passes at once. Otherwise the element's rows are compared
 *  between the frame saved with the tree and a fresh one, so an animation
 *  elsewhere on the screen does not block the input. Anything else is stale,
 *  and nothing is sent. */
function staleGuard(expect: string, el: AndroidElement | undefined): string {
  const y1 = Math.max(0, Math.floor(el?.bounds.y1 ?? 0)), y2 = Math.max(y1 + 1, Math.ceil(el?.bounds.y2 ?? 0));
  return [
    `if [ "$HA" != ${expect} ]; then`,
    `  same=""`,
    ...(el ? [
      `  if [ -s ${FRAME_FILE} ] && [ "$(tail -c +$SKIP ${FRAME_FILE} | md5sum | cut -d' ' -f1)" = ${expect} ]; then`,
      `    Y2=${y2}; [ "$Y2" -gt "$H" ] && Y2=$H`,
      `    OFF=$((16 + ${y1} * W * 4 + 1)); LEN=$(( (Y2 - ${y1}) * W * 4 ))`,
      `    a=$(tail -c +$OFF ${FRAME_FILE} | head -c $LEN | md5sum | cut -d' ' -f1)`,
      `    b=$(screencap 2>/dev/null | tail -c +$OFF | head -c $LEN | md5sum | cut -d' ' -f1)`,
      `    [ "$LEN" -gt 0 ] && [ "$a" = "$b" ] && same=1 && echo "${P}REGION same"`,
      `  fi`,
    ] : []),
    `  [ -n "$same" ] || { echo "${P}STALE $HA"; exit ${STALE}; }`,
    `fi`,
  ].join("\n");
}

/** One input through the gates, with the pixel-effect report. With `expect`,
 *  the phone first checks the screen still hashes the way it did when the
 *  element was read, and answers "stale" without sending anything if not. */
async function sendInput(
  cfg: FleetConfig, sel: string, target: string, action: AndroidAction, el: AndroidElement | undefined,
  expect: string | undefined,
  opts: { settleMs?: number; imageOut?: string; imageWidth?: number },
  deps: AndroidDeps,
  installed = false,
): Promise<AndroidActResult | "stale"> {
  const { host } = androidHost(cfg, sel);
  const settle = opts.settleMs ?? 400;
  const { checks, cmds, summary } = inputCommands(action, el);
  const wake = action.kind === "key" && androidKeycode(action.key) === "KEYCODE_WAKEUP";
  const readBack = action.kind === "type";
  const multi = MULTI_TOUCH.has(action.kind);
  // Pin each delivery to the package observed before this action, even for any.
  // A label type must check again after its tap focuses the field.
  const deliveryGate = [
    `f=$(dumpsys window 2>/dev/null | grep -m1 'mCurrentFocus='); tok=\${f##* }; tok=\${tok%\\}}; fp=\${tok%%/*}`,
    `[ -n "$input_pkg" ] && [ "$fp" = "$input_pkg" ] || refuse "focus moved before input delivery"`,
  ].join("\n");
  const deliveryCommands = [...cmds];
  if (readBack && el) deliveryCommands.splice(2, 0, deliveryGate);
  if (expect !== undefined && !/^[0-9a-f]{32}$/.test(expect)) expect = undefined;
  const device = [
    DEVICE_STATE,
    ...(readBack || multi ? [DEVICE_DUMP] : []),
    deviceGates(wake ? undefined : target, { needAwake: !wake, needUnlocked: !wake }),
    `input_pkg=$pkg`,
    ...checks,
    `HA=$(fh); echo "${P}HA $HA"`,
    ...(expect ? [staleGuard(expect, el)] : []),
    ...(!wake ? [deliveryGate] : []),
    `iout=$( { ${deliveryCommands.join("\n")} ; } 2>&1 ); echo "${P}INPUT $?"`,
    `[ -n "$iout" ] && echo "${P}INPUTOUT $(printf '%s' "$iout" | tr '\\n' ' ' | cut -c1-300)"`,
    `sleep ${seconds(settle)}; HB=$(fh); echo "${P}HB $HB"`,
    // Android animates nearly every action (flings, page transitions), so one
    // more frame is not enough: hash until two frames in a row agree.
    `if [ -n "$HA" ] && [ -n "$HB" ] && [ "$HA" != "$HB" ]; then`,
    `  prev=$HB; HC=""; n=0`,
    `  while [ $n -lt ${STABLE_TRIES} ]; do sleep 0.1; h=$(fh); [ -z "$h" ] && break`,
    `    if [ "$h" = "$prev" ]; then HC=$h; break; fi; prev=$h; n=$((n + 1)); done`,
    `  [ -n "$HC" ] && echo "${P}HC $HC" || echo "${P}UNSTABLE $prev"`,
    `fi`,
    ...(readBack ? [`[ -n "$HA" ] && [ "$HA" != "$HB" ] && [ -z "$HC" ] && dump`] : []),
  ].join("\n");
  const r = await runPhone(cfg, sel, device, opts.imageOut ? { capture: { width: opts.imageWidth ?? host.android?.shotWidth } } : {}, deps.exec);
  if (r.lines.has("STALE")) return "stale";
  // The helper was missing, so the refusal came before any input: install it
  // and send once more.
  if (r.refusal && r.lines.has("UIJAR") && !installed) {
    const ok = await installUiHelper(cfg, sel, deps);
    if (ok.ok) return sendInput(cfg, sel, target, action, el, expect, opts, deps, true);
  }
  const state = r.state;
  const base = { host: host.name, state, summary, ...(el ? { element: el } : {}) };
  if (r.refusal) return { ...base, result: failed(r, `refused: ${r.refusal}`), refusal: r.refusal,
    effect: "indeterminate", reason: r.refusal, hashes: [] };
  if (r.error && !r.lines.has("INPUT")) return { ...base, result: failed(r, r.error), effect: "indeterminate", hashes: [] };

  const one = (k: string) => r.lines.get(k)?.at(-1) ?? "";
  const inputOut = one("INPUTOUT");
  // `input` reports a bad argument as a Java exception and may still exit 0.
  const inputFailed = one("INPUT") !== "0" || /Exception|Error:|usage:/i.test(inputOut);
  const [hA, hB, hC] = [one("HA"), one("HB"), one("HC")];
  const { effect: decided, reason: why } = androidEffect(hA, hB, hC, r.lines.has("UNSTABLE"));
  let effect = decided;
  let reason = why;
  // A typed field keeps a blinking cursor, so the settle check alone cannot
  // separate typing from blinking. The focused field reading back the text can.
  if (readBack && effect === "indeterminate" && r.xml && action.kind === "type") {
    const focused = parseUiDump(r.xml).find((n) => n.focused && /EditText|AutoCompleteTextView/.test(n.className));
    if (focused && !focused.password && focused.text.includes(action.text)) {
      effect = "changed";
      reason = "the focused field reads back the typed text";
    }
  }
  // A screen that moved no longer matches the saved tree. The hash check would
  // catch that anyway; dropping it saves the next label action a wasted trip.
  if (effect !== "no_change") await dropTreeCache(deps, host.name);
  let result = inputFailed ? failed(r, `input failed: ${inputOut || `exit ${one("INPUT")}`}`) : r.result;
  let localImage: string | undefined;
  if (opts.imageOut && r.image) {
    localImage = opts.imageOut.replace(/\.(png|webp)$/i, "") + `.${r.image.format}`;
    await writeFile(localImage, r.image.bytes);
    await validateImageArtifact(localImage);
  } else if (opts.imageOut && result.ok) {
    result = failed(r, "the after-capture produced no image");
  }
  return { ...base, result, effect, ...(reason ? { reason } : {}), hashes: [hA, hB, hC].filter(Boolean),
    ...(localImage ? { localImage } : {}) };
}

export interface AndroidOpenResult { host: string; result: ExecResult; state: AndroidState; what: string; refusal?: string }

const isAndroidPackage = (v: string) => /^[A-Za-z][\w]*(\.[\w]+)+$/.test(v);
function validateAndroidOpen(what: string, inPackage?: string): boolean {
  const url = /^[a-z][a-z0-9+.-]*:\S+$/i.test(what) && !isAndroidPackage(what);
  if (!url && !isAndroidPackage(what))
    throw new Error(`open takes a package name (com.android.chrome) or a URL (got '${what}'); list packages with: apps`);
  if (inPackage !== undefined && (!url || !isAndroidPackage(inPackage)))
    throw new Error(url ? `--in takes a package name (got '${inPackage}')` : "--in names the app for a URL; a package opens itself");
  return url;
}

/** Launch a package, or open a URL with a VIEW intent, then wait for focus to move. */
export async function androidOpen(
  cfg: FleetConfig, sel: string, what: string, opts: { waitMs?: number; inPackage?: string } = {},
  deps: AndroidDeps = {},
): Promise<AndroidOpenResult> {
  const { host } = androidHost(cfg, sel);
  const url = validateAndroidOpen(what, opts.inPackage);
  const waitMs = opts.waitMs ?? 5000;
  // Naming the package skips Android's "open with" chooser when several apps
  // handle the link.
  const launch = url
    ? `lout=$(am start -a android.intent.action.VIEW -d ${sq(what)}${opts.inPackage ? ` -p ${sq(opts.inPackage)}` : ""} 2>&1)`
    : `lout=$(monkey -p ${sq(what)} -c android.intent.category.LAUNCHER 1 2>&1)`;
  const device = [
    DEVICE_STATE,
    deviceGates(undefined),
    `before=$focus`,
    launch,
    `case "$lout" in *"No activities found"*|*Error*|*Exception*) echo "${P}ERR could not open ${what.replace(/["`$\\]/g, "")}: $(printf '%s' "$lout" | tr '\\n' ' ' | cut -c1-200)"; exit 1 ;; esac`,
    `n=0; while [ $n -lt ${Math.ceil(waitMs / 250)} ]; do`,
    `  f=$(dumpsys window 2>/dev/null | grep -m1 'mCurrentFocus='); f=\${f#*mCurrentFocus=}`,
    `  [ "$f" != "$before" ] && [ "$f" != null ] && break`,
    ...(url ? [] : [`  case "$f" in *" ${what}/"*) break ;; esac`]),
    `  sleep 0.25; n=$((n + 1)); done`,
    `echo "${P}FOCUS $f"; tok=\${f##* }; tok=\${tok%\\}}; echo "${P}PKG \${tok%%/*}"`,
  ].join("\n");
  const r = await runPhone(cfg, sel, device, {}, deps.exec);
  if (r.refusal) return { host: host.name, result: failed(r, `refused: ${r.refusal}`), state: r.state, what, refusal: r.refusal };
  return { host: host.name, result: r.error ? failed(r, r.error) : r.result, state: r.state, what };
}

export interface AndroidAppsResult { host: string; result: ExecResult; packages: string[] }

/** Installed packages: user-installed ones, or every one with `all`. */
export async function androidApps(
  cfg: FleetConfig, sel: string, opts: { filter?: string; all?: boolean } = {}, deps: { exec?: Run } = {},
): Promise<AndroidAppsResult> {
  const { host } = androidHost(cfg, sel);
  const r = await runPhone(cfg, sel, `pm list packages${opts.all ? "" : " -3"} | while read -r l; do echo "${P}PKGNAME \${l#package:}"; done`,
    {}, deps.exec);
  if (r.error) return { host: host.name, result: failed(r, r.error), packages: [] };
  const f = opts.filter?.toLowerCase();
  const packages = (r.lines.get("PKGNAME") ?? []).filter((p) => !f || p.toLowerCase().includes(f)).sort();
  return { host: host.name, result: r.result, packages };
}

export interface AndroidBootstrapResult {
  host: string; result: ExecResult;
  outcome: "already" | "restored" | "failed";
  detail: string;
}

/** Bring adbd back to the configured port after a reboot, from the phone
 *  itself. Wireless debugging (which needs Wi-Fi and a person to switch it on)
 *  listens on a random port that Termux cannot read from a property, so nmap
 *  finds it on localhost; Termux's adb connects there and runs `adb tcpip`,
 *  after which adbd also listens on the fixed port and keeps doing so off
 *  Wi-Fi. `pair` runs a one-time `adb pair` first, for a phone whose wireless
 *  debugging does not yet trust Termux's key. */
export async function androidBootstrap(
  cfg: FleetConfig, sel: string, opts: { pair?: { port: number; code: string } } = {}, deps: AndroidDeps = {},
): Promise<AndroidBootstrapResult> {
  const { host, serial } = androidHost(cfg, sel);
  const m = serial.match(/^(127\.0\.0\.1|localhost):(\d+)$/);
  if (!m) throw new Error(`bootstrap works on the phone's own adbd; ${host.name}'s serial ${serial} is not 127.0.0.1:PORT`);
  const port = Number(m[2]);
  if (opts.pair && (!Number.isInteger(opts.pair.port) || opts.pair.port < 1 || opts.pair.port > 65535 || !/^\d{6}$/.test(opts.pair.code)))
    throw new Error("pairing needs the port and the 6-digit code from Wireless debugging → Pair device with pairing code");
  const script = [
    `S=${sq(serial)}`,
    `command -v adb >/dev/null 2>&1 || { echo "${P}ERR adb is not installed in Termux; run: pkg install android-tools"; exit 1; }`,
    `ok() { [ "$(adb -s "$1" get-state 2>/dev/null)" = device ]; }`,
    `if ok "$S"; then echo "${P}ALREADY"; exit 0; fi`,
    `adb connect "$S" >/dev/null 2>&1; sleep 0.5`,
    `if ok "$S"; then echo "${P}ALREADY"; exit 0; fi`,
    ...(opts.pair ? [
      `pout=$(printf '%s\\n' ${opts.pair.code} | timeout 30 adb pair 127.0.0.1:${opts.pair.port} 2>&1)`,
      `echo "${P}PAIR $(printf '%s' "$pout" | tr '\\n' ' ' | cut -c1-200)"`,
    ] : []),
    `command -v nmap >/dev/null 2>&1 || { echo "${P}ERR nmap is not installed in Termux; run: pkg install nmap"; exit 1; }`,
    `ports=$(nmap -p 30000-49999 --open -T5 127.0.0.1 2>/dev/null | awk -F/ '/\\/tcp/ {print $1}')`,
    `echo "${P}PORTS $(echo $ports)"`,
    `for p in $ports; do`,
    `  c="127.0.0.1:$p"`,
    `  timeout 6 adb connect "$c" >/dev/null 2>&1; sleep 0.3`,
    `  if ok "$c"; then`,
    `    echo "${P}FOUND $p"`,
    `    adb -s "$c" tcpip ${port} >/dev/null 2>&1`,
    `    adb disconnect "$c" >/dev/null 2>&1`,
    `    n=0; while [ $n -lt 10 ]; do sleep 1; adb connect "$S" >/dev/null 2>&1`,
    `      ok "$S" && { echo "${P}RESTORED $p"; exit 0; }; n=$((n + 1)); done`,
    `    echo "${P}ERR adb tcpip ${port} ran through port $p, but nothing answers on $S"; exit 1`,
    `  fi`,
    // Anything else listening there is not ours to keep a connection to.
    `  adb disconnect "$c" >/dev/null 2>&1`,
    `done`,
    `echo "${P}ERR no port on the phone accepted Termux's adb key (open: \${ports:-none}). Turn on Developer options → Wireless debugging (it needs Wi-Fi). If it is on, pair Termux once: Wireless debugging → Pair device with pairing code, then run: fleet cu ${host.name} bootstrap PORT CODE"`,
    `exit 1`,
  ].join("\n");
  const raw = await (deps.exec ?? exec)(host, script, "bash", { timeoutMs: 120_000 });
  const line = (k: string) => raw.stdout.split("\n").find((l) => l.startsWith(`${P}${k}`))?.slice(P.length + k.length).trim();
  const pair = line("PAIR");
  const note = pair !== undefined ? ` (pairing: ${pair || "no reply"})` : "";
  if (line("ALREADY") !== undefined)
    return { host: host.name, result: raw, outcome: "already", detail: `adbd already answers on ${serial}` };
  const restored = line("RESTORED");
  if (restored !== undefined) return { host: host.name, result: { ...raw, ok: true, code: 0 }, outcome: "restored",
    detail: `found Wireless debugging on port ${restored} and switched adbd to ${serial}${note}` };
  const error = line("ERR") ?? (raw.stderr.split("\n")[0] || `exit ${raw.code}`);
  return { host: host.name, result: { ...raw, ok: false, code: raw.code || 1, stderr: [raw.stderr, error].filter(Boolean).join("\n") },
    outcome: "failed", detail: error + note };
}

// ── batch and wait ───────────────────────────────────────────────────────────

export interface AndroidBatchStep {
  action: "tap" | "long_press" | "swipe" | "swipe2" | "gesture" | "scroll" | "key" | "type" | "sleep";
  x?: number; y?: number; x2?: number; y2?: number; dx?: number; dy?: number;
  strokes?: AndroidStroke[];
  label?: string; role?: string; nth?: number;
  key?: string; text?: string;
  direction?: "up" | "down" | "left" | "right"; amount?: number;
  ms?: number;
}
export interface AndroidBatchStepResult { index: number; summary: string; status: "done" | "failed" | "not_run"; detail?: string }
export interface AndroidBatchResult {
  host: string; result: ExecResult; state: AndroidState;
  steps: AndroidBatchStepResult[];
  effect: AndroidEffect; reason?: string; refusal?: string;
  localImage?: string;
}

const BATCH_LIMITS = { steps: 50, sleepMs: 10_000, totalSleepMs: 60_000 };

/** A step as the input it sends. Throws on a malformed step, before anything runs. */
function batchAction(step: AndroidBatchStep, i: number): AndroidAction | { kind: "sleep"; ms: number } {
  const at = `step ${i + 1} (${step.action})`;
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`${at} needs ${what}`);
    return v;
  };
  switch (step.action) {
    case "tap": return { kind: "tap", x: step.x, y: step.y };
    case "long_press": return { kind: "long_press", x: step.x, y: step.y, ms: step.ms };
    case "swipe": return { kind: "swipe", x1: need(step.x, "x"), y1: need(step.y, "y"), x2: need(step.x2, "x2"), y2: need(step.y2, "y2"), ms: step.ms };
    case "swipe2": return { kind: "swipe2", x1: need(step.x, "x"), y1: need(step.y, "y"), x2: need(step.x2, "x2"), y2: need(step.y2, "y2"),
      dx: need(step.dx, "dx"), dy: need(step.dy, "dy"), ms: step.ms };
    case "gesture": return { kind: "gesture", strokes: need(step.strokes, "strokes"), ms: step.ms };
    case "scroll": return { kind: "scroll", direction: need(step.direction, "direction"), amount: step.amount };
    case "key": return { kind: "key", key: need(step.key, "key") };
    case "type": return { kind: "type", text: need(step.text, "text") };
    case "sleep": {
      const ms = need(step.ms, "ms");
      if (!Number.isInteger(ms) || ms < 0 || ms > BATCH_LIMITS.sleepMs) throw new Error(`${at}: ms must be 0–${BATCH_LIMITS.sleepMs}`);
      return { kind: "sleep", ms };
    }
    default: throw new Error(`${at}: unknown action; use tap, long_press, swipe, swipe2, gesture, scroll, key, type, or sleep`);
  }
}

/** Run several inputs in one round trip, with one before/after pixel check for
 *  the whole sequence. Labels resolve against the screen as it is before the
 *  batch; before each label step after the first, the phone checks that the
 *  element's rows still look the way they did in that tree, and stops the
 *  batch if not. Before every input it checks that the target still holds
 *  focus. The first failure stops the batch; later steps are reported not run. */
export async function androidBatch(
  cfg: FleetConfig, sel: string, target: string, steps: AndroidBatchStep[],
  opts: { gapMs?: number; settleMs?: number; imageOut?: string; imageWidth?: number } = {},
  deps: AndroidDeps = {},
  installed = false,
): Promise<AndroidBatchResult> {
  const { host } = androidHost(cfg, sel);
  androidTargetPattern(target);
  if (!Array.isArray(steps) || !steps.length) throw new Error("batch needs a non-empty array of steps");
  if (steps.length > BATCH_LIMITS.steps) throw new Error(`batch takes at most ${BATCH_LIMITS.steps} steps`);
  const actions = steps.map(batchAction);
  const totalSleep = actions.reduce((n, a) => n + (a.kind === "sleep" ? a.ms : 0), 0);
  if (totalSleep > BATCH_LIMITS.totalSleepMs) throw new Error(`batch sleeps total at most ${BATCH_LIMITS.totalSleepMs} ms`);
  const gap = opts.gapMs ?? 250;

  // One tree for every label: the saved one if the screen still matches it
  // (the phone checks), else a fresh read.
  const labelled = steps.map((s, i) => (s.label !== undefined || s.role !== undefined) ? i : -1).filter((i) => i >= 0);
  for (const i of labelled)
    if (["key", "swipe", "swipe2", "gesture", "sleep"].includes(steps[i]!.action)) throw new Error(`step ${i + 1}: a label does not apply to ${steps[i]!.action}`);
  let tree: { hash?: string; elements: AndroidElement[] } | undefined;
  if (labelled.length) {
    const cached = await readTreeCache(deps, host.name);
    tree = cached ? { hash: cached.hash,
      elements: androidElements(parseUiDump(cached.xml), { width: cached.width, height: cached.height }) } : undefined;
    const resolveAll = (els: AndroidElement[]) =>
      labelled.map((i) => androidPick(els, { label: steps[i]!.label, role: steps[i]!.role, nth: steps[i]!.nth }));
    try { if (tree) resolveAll(tree.elements); } catch { tree = undefined; }
    if (!tree) {
      const listed = await androidElementsOf(cfg, sel, {}, deps);
      if (!listed.result.ok) return { host: host.name, result: listed.result, state: listed.state, effect: "indeterminate",
        steps: steps.map((s, i) => ({ index: i, summary: s.action, status: "not_run" as const })) };
      tree = { hash: listed.frame, elements: listed.elements };
    }
  }
  const picked = new Map<number, AndroidElement>();
  if (tree) labelled.forEach((i) => picked.set(i, androidPick(tree!.elements, { label: steps[i]!.label, role: steps[i]!.role, nth: steps[i]!.nth })));
  for (const [i, el] of picked) if (!el.enabled) throw new Error(`step ${i + 1}: ${el.role} ${JSON.stringify(el.label)} is disabled`);

  const summaries: string[] = [];
  const body: string[] = [];
  const pointChecks: string[] = [];
  const pattern = androidTargetPattern(target);
  actions.forEach((a, i) => {
    body.push(`echo "${P}STEP ${i} start"`);
    if (a.kind === "sleep") {
      summaries.push(`sleep ${a.ms}ms`);
      body.push(`sleep ${seconds(a.ms)}`, `echo "${P}STEP ${i} done"`);
      return;
    }
    const el = picked.get(i);
    const { checks, cmds, summary } = inputCommands(a, el);
    summaries.push(summary + (el ? ` → ${el.role} ${JSON.stringify(el.label)}` : ""));
    if (target !== "any") body.push(
      `f=$(dumpsys window 2>/dev/null | grep -m1 'mCurrentFocus='); tok=\${f##* }; tok=\${tok%\\}}; fp=\${tok%%/*}`,
      `case "$fp" in ${pattern}) ;; *) echo "${P}HALT ${i} focus moved to \${fp:-nothing}, not ${target}"; exit ${HALTED} ;; esac`);
    // The first label step is covered by the check before the batch starts.
    if (el && i !== labelled[0] && tree?.hash) body.push(regionCheck(el, i));
    // Every point is checked against the display before the first input, so a
    // bad coordinate refuses the batch instead of stopping it halfway.
    pointChecks.push(...checks);
    body.push(
      `iout=$( { ${cmds.join("\n")} ; } 2>&1 ); rc=$?`,
      `case "$iout" in *Exception*|*Error:*|*usage:*) rc=1 ;; esac`,
      `[ $rc = 0 ] || { echo "${P}HALT ${i} input failed: $(printf '%s' "$iout" | tr '\\n' ' ' | cut -c1-200)"; exit ${HALTED}; }`,
      `echo "${P}STEP ${i} done"`,
      ...(i < actions.length - 1 && gap ? [`sleep ${seconds(gap)}`] : []),
    );
  });
  const first = labelled.length ? picked.get(labelled[0]!) : undefined;
  const multi = actions.some((a) => MULTI_TOUCH.has(a.kind));
  const device = [
    DEVICE_STATE,
    ...(multi ? [DEVICE_DUMP] : []),
    `halt() { echo "${P}HALT $1 $2"; exit ${HALTED}; }`,
    deviceGates(target),
    ...new Set(pointChecks),
    `HA=$(fh); echo "${P}HA $HA"`,
    ...(tree?.hash ? [staleGuard(tree.hash, first)] : []),
    ...body,
    `sleep ${seconds(opts.settleMs ?? 400)}; HB=$(fh); echo "${P}HB $HB"`,
    `if [ -n "$HA" ] && [ -n "$HB" ] && [ "$HA" != "$HB" ]; then`,
    `  prev=$HB; HC=""; n=0`,
    `  while [ $n -lt ${STABLE_TRIES} ]; do sleep 0.1; h=$(fh); [ -z "$h" ] && break`,
    `    if [ "$h" = "$prev" ]; then HC=$h; break; fi; prev=$h; n=$((n + 1)); done`,
    `  [ -n "$HC" ] && echo "${P}HC $HC" || echo "${P}UNSTABLE $prev"`,
    `fi`,
  ].join("\n");
  const r = await runPhone(cfg, sel, device, opts.imageOut ? { capture: { width: opts.imageWidth } } : {}, deps.exec);
  const stepLines = r.lines.get("STEP") ?? [];
  const done = new Set(stepLines.filter((l) => l.endsWith(" done")).map((l) => Number(l.split(" ")[0])));
  const halt = r.lines.get("HALT")?.at(-1);
  const haltAt = halt === undefined ? -1 : Number(halt.split(" ")[0]);
  const haltWhy = halt?.slice(halt.indexOf(" ") + 1);
  const stepResults: AndroidBatchStepResult[] = summaries.map((summary, index) => ({
    index, summary,
    status: done.has(index) ? "done" : index === haltAt ? "failed" : "not_run",
    ...(index === haltAt && haltWhy ? { detail: haltWhy } : {}),
  }));
  const one = (k: string) => r.lines.get(k)?.at(-1) ?? "";
  const base = { host: host.name, state: r.state, steps: stepResults };
  if (r.lines.has("STALE")) {
    const why = "the screen changed since the elements were read; nothing was sent";
    return { ...base, effect: "indeterminate", reason: why, refusal: why, result: failed(r, `refused: ${why}`) };
  }
  // A missing helper refuses before the first input, so the batch can run again.
  if (r.refusal && r.lines.has("UIJAR") && !installed && (await installUiHelper(cfg, sel, deps)).ok)
    return androidBatch(cfg, sel, target, steps, opts, deps, true);
  if (r.refusal) return { ...base, effect: "indeterminate", reason: r.refusal, refusal: r.refusal, result: failed(r, `refused: ${r.refusal}`) };
  if (r.error && !r.lines.has("HA")) return { ...base, effect: "indeterminate", result: failed(r, r.error) };
  const { effect, reason } = androidEffect(one("HA"), one("HB"), one("HC"), r.lines.has("UNSTABLE"));
  if (effect !== "no_change") await dropTreeCache(deps, host.name);
  let result = halt !== undefined ? failed(r, `stopped at step ${haltAt + 1}: ${haltWhy}`) : r.result;
  let localImage: string | undefined;
  if (opts.imageOut && r.image) {
    localImage = opts.imageOut.replace(/\.(png|webp)$/i, "") + `.${r.image.format}`;
    await writeFile(localImage, r.image.bytes);
    await validateImageArtifact(localImage);
  } else if (opts.imageOut && result.ok) result = failed(r, "the after-capture produced no image");
  return { ...base, result, effect, ...(reason ? { reason } : {}), ...(localImage ? { localImage } : {}) };
}

/** Exit code of a batch that stopped partway: some steps may have run. */
const HALTED = 5;

/** Before a later label step: the element's rows must still match the frame
 *  saved with the tree, or the batch stops there. */
function regionCheck(el: AndroidElement, i: number): string {
  const y1 = Math.max(0, Math.floor(el.bounds.y1)), y2 = Math.max(y1 + 1, Math.ceil(el.bounds.y2));
  return [
    `Y2=${y2}; [ "$Y2" -gt "$H" ] && Y2=$H`,
    `OFF=$((16 + ${y1} * W * 4 + 1)); LEN=$(( (Y2 - ${y1}) * W * 4 ))`,
    `a=$(tail -c +$OFF ${FRAME_FILE} 2>/dev/null | head -c $LEN | md5sum | cut -d' ' -f1)`,
    `b=$(screencap 2>/dev/null | tail -c +$OFF | head -c $LEN | md5sum | cut -d' ' -f1)`,
    `[ "$a" = "$b" ] || { echo "${P}HALT ${i} the screen under ${JSON.stringify(el.label).replace(/["`$\\]/g, "")} changed since the elements were read"; exit ${HALTED}; }`,
  ].join("\n");
}

export interface AndroidWaitResult {
  host: string; result: ExecResult; state: AndroidState;
  satisfied: boolean; elapsedMs?: number; element?: AndroidElement; reason?: string;
}

/** Wait on the phone until a label appears (or, with `gone`, disappears), or
 *  until a package holds focus. Tree polls take a UI dump each (~2.5 s);
 *  focus polls take ~0.2 s. The result is confirmed with the same matching as
 *  a label action, not just the phone's text search. */
export async function androidWait(
  cfg: FleetConfig, sel: string,
  opts: { label?: string; role?: string; nth?: number; gone?: boolean; focus?: string; timeoutMs?: number },
  deps: AndroidDeps = {},
): Promise<AndroidWaitResult> {
  const { host } = androidHost(cfg, sel);
  const timeout = opts.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 120_000) throw new Error("--timeout must be 0–120000 ms");
  if ((opts.label === undefined && opts.role === undefined) === (opts.focus === undefined))
    throw new Error("wait needs either --label/--role or --focus");
  if (opts.nth !== undefined && (!Number.isInteger(opts.nth) || opts.nth < 1 || opts.focus !== undefined))
    throw new Error("wait nth must be a positive integer with label/role");
  const deadline = `$(( $(date +%s) + ${Math.ceil(timeout / 1000)} ))`;
  let loop: string[];
  if (opts.focus !== undefined) {
    const pattern = androidTargetPattern(opts.focus);
    loop = [
      `end=${deadline}`,
      `while :; do f=$(dumpsys window 2>/dev/null | grep -m1 'mCurrentFocus='); tok=\${f##* }; tok=\${tok%\\}}; fp=\${tok%%/*}`,
      `  case "$fp" in ${pattern}) hit=1 ;; *) hit="" ;; esac`,
      `  if [ ${opts.gone ? "-z" : "-n"} "$hit" ]; then echo "${P}MET $fp"; break; fi`,
      `  [ $(date +%s) -ge $end ] && { echo "${P}TIMEOUT $fp"; break; }; sleep 0.25; done`,
    ];
  } else {
    // A cheap text search on the phone decides when to stop; the result is
    // confirmed in fleet with the real matcher.
    const esc = (opts.label ?? "").replace(/[.[\]()*+?^$|{}\\/]/g, "\\$&");
    const grep = opts.label !== undefined
      ? `grep -qiE ${sq(`(text|content-desc|hint|resource-id)="[^"]*${esc}`)} "$f"`
      : "true";
    loop = [
      `end=${deadline}`,
      `while :; do f=/data/local/tmp/fleet-wait-$$.xml; dumpto "$f"`,
      `  if [ -s "$f" ] && ${opts.gone ? "!" : ""} ${grep}; then echo "${P}XML"; cat "$f"; echo; echo "${P}XMLEND"; rm -f "$f"; break; fi`,
      `  if [ $(date +%s) -ge $end ]; then [ -s "$f" ] && { echo "${P}XML"; cat "$f"; echo; echo "${P}XMLEND"; }; rm -f "$f"; echo "${P}TIMEOUT"; break; fi`,
      `  rm -f "$f"; done`,
    ];
  }
  const started = Date.now();
  const r = await runPhone(cfg, sel, [DEVICE_STATE, ...(opts.focus === undefined ? [DEVICE_DUMP] : []), ...loop].join("\n"),
    { deviceTimeoutS: Math.ceil(timeout / 1000) + 30 }, deps.exec);
  if (r.lines.has("UIJAR")) await installUiHelper(cfg, sel, deps);
  const elapsedMs = Date.now() - started;
  if (!r.result.ok || r.error || (opts.focus === undefined && !r.xml))
    return { host: host.name, result: failed(r, r.error ?? "the wait did not return a readable screen"),
      state: r.state, satisfied: false, elapsedMs };
  if (opts.focus !== undefined) {
    const met = r.lines.has("MET");
    const now = r.lines.get("MET")?.at(-1) ?? r.lines.get("TIMEOUT")?.at(-1) ?? "";
    return { host: host.name, state: { ...r.state, pkg: now }, satisfied: met, elapsedMs,
      ...(met ? {} : { reason: `after ${timeout} ms focus is on ${now || "nothing"}` }),
      result: met ? r.result : failed(r, `timed out: focus is on ${now || "nothing"}`) };
  }
  let element: AndroidElement | undefined;
  let found = false;
  let invalidSelection = false;
  if (r.xml) {
    try {
      element = androidPick(androidElements(parseUiDump(r.xml), { width: r.state.width, height: r.state.height }),
        { label: opts.label, role: opts.role, nth: opts.nth });
      found = true;
    } catch (error) {
      found = /elements match/.test(String(error));
      invalidSelection = !found && !String(error).includes("no element with ");
    }
  }
  // TODO(review): Poll role/nth with the full matcher on the phone; the grep prefilter can stop early.
  const satisfied = !r.lines.has("TIMEOUT") && !invalidSelection && (opts.gone ? !found : found);
  const what = [opts.role && `role ${opts.role}`, opts.label !== undefined && `label "${opts.label}"`].filter(Boolean).join(" and ");
  const reason = satisfied ? undefined
    : r.lines.has("TIMEOUT") ? `after ${timeout} ms ${what} is ${opts.gone ? "still there" : "not there"}`
    : `the phone's text search matched, but no element with ${what} ${opts.gone ? "is gone" : "exists"}`;
  return { host: host.name, state: r.state, satisfied, elapsedMs, ...(element && !opts.gone ? { element } : {}),
    ...(reason ? { reason } : {}), result: satisfied ? r.result : failed(r, reason!) };
}

// ── flow ─────────────────────────────────────────────────────────────────────

export interface AndroidFlowStep {
  action: "open" | "wait" | "expect" | "tap" | "long_press" | "type" | "scroll" | "key" | "sleep";
  /** open: a package or URL. */
  what?: string; in?: string;
  label?: string; role?: string; nth?: number;
  /** wait: a package that must hold focus; gone flips wait and expect. */
  focus?: string; gone?: boolean; timeoutMs?: number;
  /** expect: the matched element must contain this text. */
  text?: string;
  key?: string; direction?: "up" | "down" | "left" | "right"; amount?: number; ms?: number;
}
export interface AndroidFlowStepResult { index: number; summary: string; status: "done" | "failed" | "not_run"; detail?: string }
export interface AndroidFlowResult {
  host: string; ok: boolean; state?: AndroidState;
  steps: AndroidFlowStepResult[];
  elements?: AndroidElement[]; total?: number;
  readError?: string;
}

const FLOW_LIMITS = { steps: 30, sleepMs: 10_000 };

/** Run steps one after another on the phone, each reading the screen as it is
 *  when its turn comes, so a label on a screen an earlier step opened resolves.
 *  `open` sets the target package for the steps after it. `wait` holds until a
 *  label or focus appears; `expect` reads the screen and fails unless a label
 *  (and optionally its text) is there, before any later input goes out. The
 *  first failure stops the flow. After the last step the screen is read once
 *  more and returned, so the caller needs no separate `elements` call. */
export async function androidFlow(
  cfg: FleetConfig, sel: string, steps: AndroidFlowStep[],
  opts: { target?: string; read?: string | false; settleMs?: number } = {},
  deps: AndroidDeps = {},
): Promise<AndroidFlowResult> {
  const { host } = androidHost(cfg, sel);
  if (!Array.isArray(steps) || !steps.length) throw new Error("flow needs a non-empty array of steps");
  if (steps.length > FLOW_LIMITS.steps) throw new Error(`flow takes at most ${FLOW_LIMITS.steps} steps`);
  const allowed: Record<AndroidFlowStep["action"], string[]> = {
    open: ["what", "in"], wait: ["label", "role", "nth", "focus", "gone", "timeoutMs"],
    expect: ["label", "role", "nth", "text", "gone"], tap: ["label", "role", "nth"],
    long_press: ["label", "role", "nth", "ms"], type: ["label", "role", "nth", "text"],
    scroll: ["label", "role", "nth", "direction", "amount"], key: ["key"], sleep: ["ms"],
  };
  const integer = (v: number | undefined, min: number, max: number, name: string) => {
    if (v !== undefined && (!Number.isInteger(v) || v < min || v > max))
      throw new Error(`${name} must be an integer from ${min} to ${max}`);
  };
  if (opts.target !== undefined && typeof opts.target !== "string") throw new Error("target must be a string");
  if (opts.read !== undefined && opts.read !== false && typeof opts.read !== "string") throw new Error("read must be a filter string or false");
  integer(opts.settleMs, 0, 10_000, "settleMs");
  const summaries = steps.map((s, i) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error(`step ${i + 1} must be an object`);
    const at = `step ${i + 1} (${s.action})`;
    if (!Object.hasOwn(allowed, s.action)) throw new Error(`${at}: unknown action; use open, wait, expect, tap, long_press, type, scroll, key, or sleep`);
    for (const field of Object.keys(s)) {
      if (field !== "action" && !allowed[s.action].includes(field)) throw new Error(`${at}: ${field} does not apply`);
    }
    for (const field of ["what", "in", "label", "role", "focus", "key", "direction"] as const) {
      if (s[field] !== undefined && (typeof s[field] !== "string" || !s[field]!.trim()))
        throw new Error(`${at}: ${field} must be a non-empty string`);
    }
    if (s.text !== undefined && typeof s.text !== "string") throw new Error(`${at}: text must be a string`);
    if (s.gone !== undefined && typeof s.gone !== "boolean") throw new Error(`${at}: gone must be boolean`);
    integer(s.nth, 1, Number.MAX_SAFE_INTEGER, `${at}: nth`);
    integer(s.amount, 1, 10, `${at}: amount`);
    integer(s.timeoutMs, 0, 120_000, `${at}: timeoutMs`);
    if (s.action === "long_press") integer(s.ms, 1, 10_000, `${at}: ms`);
    const locator = s.label !== undefined || s.role !== undefined;
    switch (s.action) {
      case "open":
        if (!s.what) throw new Error(`${at} needs what`);
        validateAndroidOpen(s.what, s.in);
        return `open ${s.what}${s.in ? ` in ${s.in}` : ""}`;
      case "wait":
        if (locator === (s.focus !== undefined)) throw new Error(`${at} needs label/role or focus`);
        if (s.focus !== undefined) {
          androidTargetPattern(s.focus);
          if (s.nth !== undefined) throw new Error(`${at}: nth needs label/role`);
        }
        return `wait ${s.focus !== undefined ? `focus ${s.focus}` : JSON.stringify(s.label ?? s.role)}${s.gone ? " gone" : ""}`;
      case "expect":
        if (!locator) throw new Error(`${at} needs label or role`);
        // TODO(review): Define whether gone+text negates the text predicate or requires the whole label to disappear.
        if (s.gone && s.text !== undefined) throw new Error(`${at}: gone with text is unsupported`);
        return `expect ${JSON.stringify(s.label ?? s.role)}${s.text ? ` contains ${JSON.stringify(s.text)}` : ""}${s.gone ? " absent" : ""}`;
      case "tap": case "long_press": case "type": case "scroll":
        if (!locator) throw new Error(`${at} needs label or role`);
        if (s.action === "type" && s.text === undefined) throw new Error(`${at} needs text`);
        if (s.action === "type") androidInputText(s.text!);
        if (s.action === "scroll" && !["up", "down", "left", "right"].includes(s.direction!)) throw new Error(`${at} needs direction: up, down, left, or right`);
        return `${s.action} ${JSON.stringify(s.label ?? s.role)}${s.action === "type" ? ` ${JSON.stringify(String(s.text).slice(0, 40))}` : ""}`;
      case "key":
        if (!s.key) throw new Error(`${at} needs key`);
        androidKeycode(s.key);
        return `key ${s.key}`;
      case "sleep":
        if (!Number.isInteger(s.ms) || s.ms! < 0 || s.ms! > FLOW_LIMITS.sleepMs) throw new Error(`${at}: ms must be 0–${FLOW_LIMITS.sleepMs}`);
        return `sleep ${s.ms}ms`;
      default: throw new Error(`${at}: unknown action; use open, wait, expect, tap, long_press, type, scroll, key, or sleep`);
    }
  });
  // TODO(review): Decide whether flows without open or --target should pin the initial package; any skips app confinement.
  const target0 = opts.target ?? "any";
  androidTargetPattern(target0);
  const results: AndroidFlowStepResult[] = summaries.map((summary, index) => ({ index, summary, status: "not_run" as const }));
  let target = target0;
  let state: AndroidState | undefined;
  let ok = true;
  const fail = (i: number, detail: string) => { results[i] = { ...results[i]!, status: "failed", detail }; ok = false; };
  for (let i = 0; i < steps.length && ok; i++) {
    const s = steps[i]!;
    const loc: AndroidLocator = { label: s.label, role: s.role, nth: s.nth };
    const done = (detail?: string) => { results[i] = { ...results[i]!, status: "done", ...(detail ? { detail } : {}) }; };
    try {
      if (s.action === "sleep") { await new Promise((r) => setTimeout(r, s.ms)); done(); continue; }
      if (s.action === "open") {
        const r = await androidOpen(cfg, sel, s.what!, { inPackage: s.in }, deps);
        state = r.state;
        if (r.refusal || !r.result.ok) { fail(i, r.refusal ?? (r.result.stderr || "open failed")); break; }
        const next = s.in ?? (isAndroidPackage(s.what!) ? s.what! : r.state.pkg);
        if (!next || !isAndroidPackage(next) || r.state.pkg !== next) {
          fail(i, `open did not focus ${next || "a package"}; focus is on ${r.state.pkg || "nothing"}`); break;
        }
        // TODO(review): A URL without in can focus Android's chooser; require in when the destination app matters.
        target = next;
        done(`${r.state.pkg || "nothing"} focused`);
        continue;
      }
      if (s.action === "wait") {
        const r = await androidWait(cfg, sel, { label: s.label, role: s.role, nth: s.nth, focus: s.focus, gone: s.gone, timeoutMs: s.timeoutMs }, deps);
        state = r.state;
        if (!r.satisfied || !r.result.ok) { fail(i, r.reason ?? (r.result.stderr || "timed out")); break; }
        done(`${r.elapsedMs} ms`);
        continue;
      }
      if (s.action === "expect") {
        const r = await androidElementsOf(cfg, sel, {}, deps);
        state = r.state;
        if (!r.result.ok) { fail(i, r.result.stderr || "the screen could not be read"); break; }
        let el: AndroidElement | undefined;
        let why = "";
        try { el = androidPick(r.elements, loc); } catch (error) { why = String(error instanceof Error ? error.message : error).split("\n")[0]!; }
        if (s.gone) {
          if (el) fail(i, `${el.role} ${JSON.stringify(el.label)} is still there`);
          else if (why.startsWith("no element with ")) done();
          else fail(i, why);
          continue;
        }
        if (!el) { fail(i, why); break; }
        if (s.text !== undefined && ![el.label, el.text, el.desc].some((f) => f.toLowerCase().includes(s.text!.toLowerCase())))
          { fail(i, `${el.role} reads ${JSON.stringify(el.label)}, not ${JSON.stringify(s.text)}`); break; }
        done(`${el.role} ${JSON.stringify(el.label)}`);
        continue;
      }
      const action: AndroidAction = s.action === "key" ? { kind: "key", key: s.key! }
        : s.action === "type" ? { kind: "type", text: s.text! }
        : s.action === "scroll" ? { kind: "scroll", direction: s.direction!, amount: s.amount }
        : s.action === "long_press" ? { kind: "long_press", ms: s.ms }
        : { kind: "tap" };
      const r = await androidAct(cfg, sel, target, action,
        { settleMs: opts.settleMs, ...(s.action === "key" ? {} : { element: loc }) }, deps);
      state = r.state;
      if (r.refusal || !r.result.ok) { fail(i, r.refusal ?? (r.result.stderr.split("\n")[0] || "input failed")); break; }
      done(`${r.effect}${r.element ? ` → ${r.element.role} ${JSON.stringify(r.element.label)}` : ""}`);
    } catch (error) { fail(i, error instanceof Error ? error.message : String(error)); }
  }
  const out: AndroidFlowResult = { host: host.name, ok, steps: results, ...(state ? { state } : {}) };
  if (opts.read === false) return out;
  const filter = opts.read && opts.read !== "*" ? opts.read : undefined;
  try {
    const last = await androidElementsOf(cfg, sel, { filter }, deps);
    if (last.result.ok) return { ...out, state: last.state, elements: last.elements, total: last.total };
    return { ...out, readError: last.result.stderr || "the final screen could not be read" };
  } catch (error) { return { ...out, readError: error instanceof Error ? error.message : String(error) }; }
}

// ── the UI helper ────────────────────────────────────────────────────────────

/** Push the helper jar fleet carries (android/uiserver) to the phone and stop
 *  any helper started from an older one. Its md5 is checked on the phone. */
export async function installUiHelper(cfg: FleetConfig, sel: string, deps: AndroidDeps = {}): Promise<ExecResult> {
  const { host, serial } = androidHost(cfg, sel);
  const script = [
    `S=${sq(serial)}`,
    `j=$(mktemp "\${TMPDIR:-/tmp}/fleet-ui.XXXXXX")`,
    `printf %s '${UI_JAR_B64}' | base64 -d > "$j"`,
    `adb -s "$S" shell ${sq(`printf '%s quit\\n' "$(cat ${UI.token} 2>/dev/null)" | timeout 3 nc -w 2 127.0.0.1 "$(cat ${UI.port} 2>/dev/null)" >/dev/null 2>&1; rm -f ${UI.port}`)}`,
    `adb -s "$S" push "$j" ${UI.jar} >/dev/null 2>&1; rm -f "$j"`,
    `got=$(adb -s "$S" shell md5sum ${UI.jar} 2>/dev/null | cut -c1-32)`,
    `[ "$got" = ${UI_JAR_MD5} ] || { echo "UI helper install failed: md5 $got on the phone" >&2; exit 1; }`,
  ].join("\n");
  return (deps.exec ?? exec)(host, script, "bash", { timeoutMs: 60_000 });
}

export interface AndroidHelperResult { host: string; result: ExecResult; running: boolean; detail: string }

/** Stop the helper now, releasing its accessibility connection, instead of
 *  waiting for its idle timeout. */
export async function androidRelease(cfg: FleetConfig, sel: string, deps: AndroidDeps = {}): Promise<AndroidHelperResult> {
  const { host } = androidHost(cfg, sel);
  const r = await runPhone(cfg, sel, [DEVICE_DUMP,
    `if [ -n "$(ui_ask ping)" ]; then ui_ask quit >/dev/null; rm -f ${UI.port}; echo "${P}RELEASED"; else rm -f ${UI.port}; echo "${P}IDLE"; fi`,
  ].join("\n"), {}, deps.exec);
  if (r.error) return { host: host.name, result: failed(r, r.error), running: false, detail: r.error };
  const released = r.lines.has("RELEASED");
  return { host: host.name, result: r.result, running: false,
    detail: released ? "stopped the UI helper; its accessibility connection is released" : "the UI helper was not running" };
}

// ── notifications ────────────────────────────────────────────────────────────

export interface AndroidNotification {
  pkg: string;
  key: string;
  importance?: number;
  when?: number;           // epoch ms
  title: string;
  text: string;
  subText?: string;
}

/** `String (hello)` → `hello`; other value types pass through. */
const unwrapValue = (v: string) => {
  const m = v.match(/^(?:String|SpannableString|SpannedString)\s*\((.*)\)\s*$/s);
  return (m ? m[1]! : v === "null" ? "" : v).trim();
};

/** The current notifications from the lines `androidNotifications` keeps of
 *  `dumpsys notification --noredact`: each record header, then its extras. */
export function parseNotifications(lines: string[]): AndroidNotification[] {
  const out: AndroidNotification[] = [];
  let cur: AndroidNotification | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    const rec = line.match(/NotificationRecord\([^:]*: pkg=(\S+).*?importance=(\d+) key=([^:\s]+)/);
    if (rec) {
      cur = { pkg: rec[1]!, importance: Number(rec[2]), key: rec[3]!, title: "", text: "" };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^(android\.title|android\.text|android\.subText|android\.bigText|when)=(.*)$/);
    if (!kv) continue;
    const value = unwrapValue(kv[2]!);
    if (kv[1] === "when") { const ms = Number(value.split("/")[0]); if (ms > 0 && cur.when === undefined) cur.when = ms; }
    else if (kv[1] === "android.title" && !cur.title) cur.title = value;
    else if (kv[1] === "android.text" && !cur.text) cur.text = value;
    else if (kv[1] === "android.bigText" && !cur.text) cur.text = value;
    else if (kv[1] === "android.subText" && value && !cur.subText) cur.subText = value;
  }
  return out.filter((n) => n.title || n.text).sort((a, b) => (b.when ?? 0) - (a.when ?? 0));
}

export interface AndroidNotificationsResult { host: string; result: ExecResult; notifications: AndroidNotification[] }

/** The notifications currently in the shade, newest first. They can hold
 *  message text and codes, so this runs only when a caller asks for it. */
export async function androidNotifications(
  cfg: FleetConfig, sel: string, opts: { pkg?: string; limit?: number } = {}, deps: AndroidDeps = {},
): Promise<AndroidNotificationsResult> {
  const { host } = androidHost(cfg, sel);
  // Only the live list (the archive after it holds dismissed ones), and only the
  // lines the parser reads, so the reply stays small.
  const device = `dumpsys notification --noredact 2>/dev/null | awk '/^  mArchive=/{exit} /NotificationRecord\\(|android\\.(title|text|subText|bigText)=|^ +when=/{print}' | head -4000 | sed 's/^ */${P}N /'`;
  const r = await runPhone(cfg, sel, device, {}, deps.exec);
  if (r.error) return { host: host.name, result: failed(r, r.error), notifications: [] };
  let notifications = parseNotifications(r.lines.get("N") ?? []);
  if (opts.pkg) notifications = notifications.filter((n) => n.pkg.toLowerCase().includes(opts.pkg!.toLowerCase()));
  if (opts.limit) notifications = notifications.slice(0, opts.limit);
  return { host: host.name, result: r.result, notifications };
}

// ── the controller's own adb: watch, record, revive ─────────────────────────

type LocalRun = (cmd: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const localRun: LocalRun = async (cmd, timeoutMs = 20_000) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
};

/** The phone's network adb serial as this machine reaches it: the host's SSH
 *  alias resolved by `ssh -G`, with the port adbd listens on. Connected and
 *  checked; undefined with a reason when adb here cannot reach it. */
async function networkSerial(h: Host, run: LocalRun): Promise<{ serial?: string; why?: string }> {
  const hostname = (await run(["ssh", "-G", h.ssh])).stdout.match(/^hostname (\S+)$/m)?.[1];
  if (!hostname) return { why: `${h.name}: no hostname from ssh -G ${h.ssh}` };
  const port = (h.android?.serial ?? ANDROID_DEFAULT_SERIAL).split(":")[1] ?? "5555";
  const serial = `${hostname}:${port}`;
  // adb connect waits a long time on an address that is not there (the home
  // LAN, away from home); a quick TCP check skips it.
  if (!await portOpen(hostname, Number(port), 1500)) return { why: `${h.name}: nothing answers on ${serial}` };
  await run(["adb", "connect", serial]);
  const state = (await run(["adb", "-s", serial, "get-state"])).stdout.trim();
  return state === "device" ? { serial } : { why: `${h.name}: adb at ${serial} is ${state || "unreachable"}` };
}

function portOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function firstNetworkSerial(hosts: Host[], run: LocalRun, need: string[]): Promise<{ host?: Host; serial?: string; why: string[] }> {
  const why: string[] = [];
  for (const tool of need) {
    const v = await run([tool, "--version"]).catch(() => ({ code: 127, stdout: "", stderr: "" }));
    if (v.code !== 0 && tool !== "adb") return { why: [`${tool} is not installed on this machine`] };
    if (tool === "adb" && (await run(["adb", "version"]).catch(() => ({ code: 127 }))).code !== 0)
      return { why: ["adb is not installed on this machine"] };
  }
  for (const h of hosts) {
    if (!h.android) continue;
    const r = await networkSerial(h, run);
    if (r.serial) return { host: h, serial: r.serial, why };
    why.push(r.why!);
  }
  return { why: why.length ? why : ["no Android host in that selector"] };
}

/** scrcpy settings for a host: a smaller, cheaper stream for one with a
 *  reduced default screenshot width (a slow route). */
function scrcpyQuality(h: Host): string[] {
  return h.android?.shotWidth ? ["--max-size", String(Math.max(480, h.android.shotWidth * 2)), "--video-bit-rate", "2M"]
    : ["--max-size", "1600", "--video-bit-rate", "8M"];
}

export interface AndroidWatchResult { ok: boolean; host?: string; serial?: string; pid?: number; detail: string }

/** Open a live scrcpy window of the phone on this machine, detached, so the
 *  person can watch an agent work (or record a demo). `viewOnly` ignores the
 *  window's mouse and keyboard. */
export async function androidWatch(
  hosts: Host[], opts: { viewOnly?: boolean } = {}, deps: { local?: LocalRun; spawn?: typeof Bun.spawn } = {},
): Promise<AndroidWatchResult> {
  const run = deps.local ?? localRun;
  const found = await firstNetworkSerial(hosts, run, ["adb", "scrcpy"]);
  if (!found.serial || !found.host) return { ok: false, detail: found.why.join("; ") };
  const proc = (deps.spawn ?? Bun.spawn)(["scrcpy", "-s", found.serial, "--no-audio", "--window-title", `fleet · ${found.host.name}`,
    ...scrcpyQuality(found.host), ...(opts.viewOnly ? ["--no-control"] : [])],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  proc.unref();
  return { ok: true, host: found.host.name, serial: found.serial, pid: proc.pid,
    detail: `watching ${found.host.name} (${found.serial})${opts.viewOnly ? ", view only" : ""}` };
}

export const RECORD_MAX_S = 3600;

export interface AndroidRecordResult {
  ok: boolean; host?: string; recording: boolean; elapsedS?: number; limitS?: number;
  localVideo?: string; bytes?: number; detail: string;
}

interface RecordState { pid: number; file: string; started: number; limitS: number; host: string }
const recordStateFile = (cacheDir: string | undefined, host: string) =>
  join(cacheDir ?? join(homedir(), ".fleet"), `android-rec-${host.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Record the phone's screen to an MP4 on this machine with scrcpy (no window).
 *  The phone's own screenrecord cannot be used: OxygenOS refuses its output
 *  file for adb's shell. */
export async function androidRecordStart(
  hosts: Host[], out: string, opts: { limitS?: number; bitRateMbps?: number } = {},
  deps: { local?: LocalRun; spawn?: typeof Bun.spawn; cacheDir?: string } = {},
): Promise<AndroidRecordResult> {
  const run = deps.local ?? localRun;
  const limit = opts.limitS ?? 600;
  if (!Number.isInteger(limit) || limit < 1 || limit > RECORD_MAX_S) throw new Error(`the time limit must be 1–${RECORD_MAX_S} s`);
  if (opts.bitRateMbps !== undefined && (!Number.isFinite(opts.bitRateMbps) || opts.bitRateMbps < 0.5 || opts.bitRateMbps > 40))
    throw new Error("the bit rate must be 0.5–40 Mbit/s");
  const found = await firstNetworkSerial(hosts, run, ["adb", "scrcpy"]);
  if (!found.serial || !found.host) return { ok: false, recording: false, detail: found.why.join("; ") };
  const stateFile = recordStateFile(deps.cacheDir, found.host.name);
  try {
    const prev = JSON.parse(await readFile(stateFile, "utf8")) as RecordState;
    if (pidAlive(prev.pid)) return { ok: true, host: found.host.name, recording: true, localVideo: prev.file,
      detail: `already recording to ${prev.file}` };
  } catch { /* none running */ }
  const file = /\.mp4$/i.test(out) ? out : `${out}.mp4`;
  const quality = scrcpyQuality(found.host);
  if (opts.bitRateMbps) quality.splice(quality.indexOf("--video-bit-rate"), 2, "--video-bit-rate", `${opts.bitRateMbps}M`);
  const proc = (deps.spawn ?? Bun.spawn)(["scrcpy", "-s", found.serial, "--no-playback", "--no-audio", "--no-control",
    "--record", file, "--time-limit", String(limit), ...quality], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  proc.unref();
  const state: RecordState = { pid: proc.pid, file, started: Date.now(), limitS: limit, host: found.host.name };
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state));
  return { ok: true, host: found.host.name, recording: true, limitS: limit, localVideo: file,
    detail: `recording to ${file}; stops by itself after ${limit} s` };
}

async function readRecordState(hosts: Host[], cacheDir?: string): Promise<{ state?: RecordState; stateFile?: string }> {
  for (const h of hosts) {
    const stateFile = recordStateFile(cacheDir, h.name);
    try { return { state: JSON.parse(await readFile(stateFile, "utf8")) as RecordState, stateFile }; } catch { /* next */ }
  }
  return {};
}

export async function androidRecordStatus(hosts: Host[], deps: { cacheDir?: string } = {}): Promise<AndroidRecordResult> {
  const { state } = await readRecordState(hosts, deps.cacheDir);
  if (!state) return { ok: true, recording: false, detail: "not recording" };
  const elapsed = Math.round((Date.now() - state.started) / 1000);
  if (pidAlive(state.pid)) return { ok: true, host: state.host, recording: true, elapsedS: elapsed, limitS: state.limitS,
    localVideo: state.file, detail: `recording for ${elapsed} s of ${state.limitS} s to ${state.file}` };
  return { ok: true, host: state.host, recording: false, localVideo: state.file,
    detail: `not recording; the last recording ended (${state.file})` };
}

/** Stop the recording: SIGINT lets scrcpy finish the MP4. */
export async function androidRecordStop(hosts: Host[], deps: { cacheDir?: string } = {}): Promise<AndroidRecordResult> {
  const { state, stateFile } = await readRecordState(hosts, deps.cacheDir);
  if (!state || !stateFile) return { ok: false, recording: false, detail: "no recording was started from this machine" };
  if (pidAlive(state.pid)) {
    process.kill(state.pid, "SIGINT");
    const deadline = Date.now() + 10_000;
    while (pidAlive(state.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  }
  await rm(stateFile, { force: true });
  const bytes = await Bun.file(state.file).exists() ? Bun.file(state.file).size : 0;
  if (!bytes) return { ok: false, host: state.host, recording: false, detail: `scrcpy wrote nothing to ${state.file}` };
  return { ok: true, host: state.host, recording: false, localVideo: state.file, bytes,
    detail: `saved ${(bytes / 1_000_000).toFixed(1)} MB to ${state.file}` };
}

// ── revive: Termux from the controller's own adb ─────────────────────────────

export interface AndroidReviveResult { host?: string; ok: boolean; steps: string[]; detail: string }

/** Bring Termux's SSH server back when SSH to the phone fails, using this
 *  machine's own adb against the phone's network adbd (reachable while USB
 *  debugging keeps adbd running). Opening Termux starts a session whose
 *  ~/.bashrc starts sshd; that works when Termux's process has died (an app
 *  update, the system killing it). If Termux is alive with sshd dead, opening
 *  it creates no session: `restart` force-stops Termux first, which also ends
 *  the user's own Termux sessions. The app the user was in is brought back. */
export async function androidRevive(
  hosts: Host[], opts: { restart?: boolean; waitMs?: number } = {},
  deps: { local?: LocalRun; probe?: (h: Host) => Promise<boolean> } = {},
): Promise<AndroidReviveResult> {
  const run = deps.local ?? localRun;
  const alive = deps.probe ?? probe;
  const steps: string[] = [];
  const adb = await run(["adb", "version"]).catch(() => ({ code: 127, stdout: "", stderr: "" }));
  if (adb.code !== 0) return { ok: false, steps, detail: "revive needs adb on this machine, with a key the phone trusts" };
  for (const h of hosts) {
    if (!h.android) continue;
    if (await alive(h)) return { host: h.name, ok: true, steps, detail: `SSH to ${h.name} already works` };
    const net = await networkSerial(h, run);
    if (!net.serial) { steps.push(net.why!); continue; }
    const serial = net.serial;
    const shell = (cmd: string) => run(["adb", "-s", serial, "shell", "-n", cmd]);
    const focus = (await shell("dumpsys window | grep -m1 mCurrentFocus=")).stdout;
    const before = focus.match(/ ([\w.]+)\/\S+\}/)?.[1];
    if (opts.restart) { await shell("am force-stop com.termux"); steps.push("force-stopped Termux"); }
    await shell("am start -n com.termux/.app.TermuxActivity");
    steps.push(`opened Termux through adb at ${serial}`);
    const deadline = Date.now() + (opts.waitMs ?? 15_000);
    let up = false;
    while (!up && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      up = await alive(h);
    }
    if (before && before !== "com.termux") {
      await shell(`monkey -p ${before} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`);
      steps.push(`returned to ${before}`);
    }
    if (up) return { host: h.name, ok: true, steps, detail: `SSH to ${h.name} is back` };
    return { host: h.name, ok: false, steps, detail: opts.restart
      ? "Termux opened but SSH did not come back; open Termux on the phone and run sshd"
      : "SSH did not come back: Termux is probably still running with sshd dead. Retry with --restart (this ends your own Termux sessions), or run sshd in Termux" };
  }
  return { ok: false, steps, detail: steps.length ? "no route to the phone's adb" : "no Android host in that selector" };
}
