// Browser side of `fleet remote`. scripts/build-remote-client.ts bundles this
// file with noVNC into src/remote-client.gen.ts; edit here, then rebuild.
import RFB from "@novnc/novnc";

const cfg = JSON.parse(document.getElementById("fleet-cfg").textContent);
const $ = (id) => document.getElementById(id);
const screen = $("screen");
const crop = $("crop");
const stage = $("stage");
const status = $("status");
const login = $("login");
const pick = $("monitor");
let rfb = null;
let scaled = true;
let canvasWatch = null;
$("viewonly").checked = cfg.viewOnly === true;

// A host with several monitors gets a picker. One monitor shows as the crop
// of the framebuffer under it: #crop is the monitor-sized window, #stage holds
// the whole framebuffer at an offset. noVNC scales to #stage and maps the
// pointer through the canvas's own bounds, so input lands where it shows.
const screens = cfg.screens && cfg.screens.monitors.length > 1 ? cfg.screens : null;
let monitor = null;
if (screens) {
  pick.append(new Option("All screens", ""));
  screens.monitors.forEach((m, i) => {
    pick.append(new Option(`Screen ${i + 1}${m.primary ? " (main)" : ""} · ${m.width}×${m.height}`, String(i)));
  });
  pick.hidden = false;
}

function place(el, s) { for (const [k, v] of Object.entries(s)) el.style[k] = typeof v === "number" ? `${v}px` : v; }

// The framebuffer size: the canvas is the whole framebuffer whenever noVNC
// is not clipping, which a one-monitor view never asks for.
function fbSize() {
  const c = stage.querySelector("canvas");
  return c && c.width > 0 && c.height > 0 ? { w: c.width, h: c.height } : null;
}

function layout() {
  const m = screens && monitor !== null ? screens.monitors[monitor] : null;
  if (rfb) {
    if (rfb.scaleViewport !== scaled) rfb.scaleViewport = scaled;
    const clip = !scaled && !m;
    if (rfb.clipViewport !== clip) rfb.clipViewport = clip;
  }
  const fb = m && rfb ? fbSize() : null;
  if (!fb) {
    screen.style.overflow = "hidden";
    place(crop, { width: "100%", height: "100%", left: 0, top: 0 });
    place(stage, { width: "100%", height: "100%", left: 0, top: 0 });
    return;
  }
  // Host units to framebuffer pixels, for a server that scales the desktop.
  const sx = fb.w / screens.width, sy = fb.h / screens.height;
  const r = { x: m.x * sx, y: m.y * sy, w: m.width * sx, h: m.height * sy };
  if (scaled) {
    const view = screen.getBoundingClientRect();
    const s = Math.min(view.width / r.w, view.height / r.h);
    screen.style.overflow = "hidden";
    place(crop, { width: r.w * s, height: r.h * s, left: (view.width - r.w * s) / 2, top: (view.height - r.h * s) / 2 });
    place(stage, { width: fb.w * s, height: fb.h * s, left: -r.x * s, top: -r.y * s });
  } else {
    screen.style.overflow = "auto";
    place(crop, { width: r.w, height: r.h, left: 0, top: 0 });
    place(stage, { width: fb.w, height: fb.h, left: -r.x, top: -r.y });
  }
}

new ResizeObserver(() => layout()).observe(screen);
pick.addEventListener("change", () => {
  monitor = pick.value === "" ? null : Number(pick.value);
  layout();
  rfb?.focus();
});

function setStatus(text, tone) {
  status.textContent = text;
  status.dataset.tone = tone || "";
}

function wsUrl() {
  const u = new URL("ws", location.href);
  u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}

function connect() {
  if (rfb) return;
  stage.textContent = "";
  login.hidden = true;
  setStatus("connecting…");
  const conn = new RFB(stage, wsUrl(), { credentials: cfg.password ? { password: cfg.password } : undefined, shared: true });
  rfb = conn;
  conn.dragViewport = false;
  layout();
  // The framebuffer size arrives (and can change) after the connection opens.
  canvasWatch?.disconnect();
  canvasWatch = new MutationObserver(() => { if (rfb === conn) layout(); });
  const canvas = stage.querySelector("canvas");
  if (canvas) canvasWatch.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
  conn.viewOnly = $("viewonly").checked;
  conn.qualityLevel = 6;
  conn.compressionLevel = 2;
  // Reconnect replaces rfb before the old connection's disconnect event
  // arrives; events from a replaced connection are ignored.
  const on = (name, fn) => conn.addEventListener(name, (e) => { if (rfb === conn) fn(e); });
  on("connect", () => { setStatus("connected", "ok"); conn.focus(); });
  on("desktopname", (e) => { document.title = `${e.detail.name} · fleet remote`; });
  on("disconnect", (e) => {
    rfb = null;
    setStatus(e.detail.clean ? "disconnected" : "connection lost", e.detail.clean ? "" : "bad");
  });
  on("securityfailure", (e) => {
    setStatus(`login refused${e.detail.reason ? `: ${e.detail.reason}` : ""}`, "bad");
  });
  on("credentialsrequired", (e) => {
    const types = e.detail.types || ["password"];
    $("user-row").hidden = !types.includes("username");
    login.hidden = false;
    setStatus(types.includes("username") ? "sign in with an account on the host" : "password required");
    (types.includes("username") ? $("user") : $("pass")).focus();
  });
  on("clipboard", (e) => {
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(e.detail.text).catch(() => {});
  });
}

login.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!rfb) return;
  const creds = { password: $("pass").value };
  if (!$("user-row").hidden) creds.username = $("user").value;
  $("pass").value = "";
  login.hidden = true;
  setStatus("signing in…");
  rfb.sendCredentials(creds);
});

$("cad").addEventListener("click", () => { rfb?.sendCtrlAltDel(); rfb?.focus(); });
$("scale").addEventListener("click", () => {
  scaled = !scaled;
  $("scale").textContent = scaled ? "1:1" : "Fit";
  layout();
  rfb?.focus();
});
$("viewonly").addEventListener("change", () => { if (rfb) rfb.viewOnly = $("viewonly").checked; });
$("paste").addEventListener("click", async () => {
  if (!rfb) return;
  if (!navigator.clipboard || !window.isSecureContext) { setStatus("paste needs https or localhost", "bad"); return; }
  try { rfb.clipboardPasteFrom(await navigator.clipboard.readText()); rfb.focus(); }
  catch { setStatus("clipboard read was refused", "bad"); }
});
$("full").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
$("reconnect").addEventListener("click", () => { const old = rfb; rfb = null; old?.disconnect(); connect(); });

connect();
