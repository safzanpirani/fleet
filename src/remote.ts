/**
 * `fleet remote`: live control of a host's desktop from a browser.
 *
 * A session starts a VNC server on the host that only the host itself can
 * reach, carries it back over one fresh ssh connection as a `-L` forward to a
 * private unix socket on this machine, and serves noVNC plus a WebSocket
 * bridge to that socket from a local web server. Nothing listens on the
 * host's network. Closing the ssh connection's stdin ends the session: the
 * host-side script stops the server it started.
 *
 * - Windows: the TightVNC service (it follows the console session onto the
 *   lock screen and UAC prompts), loopback only, with a VNC password that is
 *   new for each session and scrambled when it ends.
 * - Linux X11: x11vnc; Linux Wayland: wayvnc. Each listens on a unix socket in
 *   a fresh 0700 directory, so only the ssh user can connect and no password
 *   is needed.
 * - macOS: the built-in Screen Sharing service; the browser asks for a macOS
 *   account (Apple's ARD login). It listens on 5900 on every interface once
 *   on, which fleet cannot change.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket, Socket } from "bun";
import { z } from "zod";
import { assertFeature, resolveHosts, type FleetConfig, type Host } from "./config.ts";
import { asRoot, GRAPHICAL_ENV_SH, PS_DPI_AWARE, sudoPassword } from "./core.ts";
import { parseMonitors } from "./monitors.ts";
import { fleetStateDir } from "./perms.ts";
import { REMOTE_CLIENT_JS } from "./remote-client.gen.ts";
import { exec, freshConnOpts, psEsc, psHiddenLaunch, resolveWinBin, sshEnv, stripClixml, type Shell } from "./ssh.ts";
import { webcamPowerShellSubmission, WINDOWS_SSHD_WATCH } from "./webcam.ts";

export type RemoteKind = "tightvnc" | "x11vnc" | "wayvnc" | "screensharing";

/** TightVNC's port on a Windows host; loopback only. */
export const REMOTE_WINDOWS_PORT = 5900;
/** macOS Screen Sharing always serves 5900. */
const MAC_PORT = 5900;
const READY = "FLEET-REMOTE-READY";
const READY_TIMEOUT_MS = 60_000;
/** Lines before the ready line that describe the host's monitors. */
const MONITORS = "FLEET-REMOTE-MONITORS";
const XRANDR = "FLEET-REMOTE-XRANDR";

/** One monitor in the desktop a VNC server shares, in that desktop's units
 *  with the origin at its top-left corner. */
export interface RemoteMonitor { name: string; x: number; y: number; width: number; height: number; primary: boolean }
/** The shared desktop's size and its monitors. The page scales these to the
 *  framebuffer it receives, so a server that scales the desktop still lines up. */
export interface RemoteScreens { width: number; height: number; monitors: RemoteMonitor[] }

const size = z.number().finite();
const extent = z.number().finite().positive();
/** What the Windows session script prints: the virtual screen and every
 *  screen in it, in physical pixels. A one-screen list may arrive unwrapped. */
const WindowsLayout = z.object({
  x: size, y: size, width: extent, height: extent,
  screens: z.preprocess((v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]), z.array(z.object({
    name: z.string().catch(""), x: size, y: size, width: extent, height: extent, primary: z.boolean().catch(false),
  }))),
});

/** The monitor layout from the lines a session script printed before it was
 *  ready: one Windows JSON line, or `xrandr --listmonitors` lines from X11.
 *  Undefined when the host printed none or nothing usable. */
export function parseRemoteScreens(lines: string[]): RemoteScreens | undefined {
  const win = lines.find((l) => l.startsWith(`${MONITORS} `));
  if (win) {
    let json: unknown;
    try { json = JSON.parse(win.slice(MONITORS.length + 1)); } catch { return undefined; }
    const parsed = WindowsLayout.safeParse(json);
    if (!parsed.success) return undefined;
    const vs = parsed.data;
    const monitors = vs.screens.map((s) => ({ ...s, x: s.x - vs.x, y: s.y - vs.y }));
    return monitors.length ? { width: vs.width, height: vs.height, monitors } : undefined;
  }
  const xrandr = lines.filter((l) => l.startsWith(`${XRANDR} `)).map((l) => l.slice(XRANDR.length + 1));
  if (!xrandr.length) return undefined;
  const monitors = parseMonitors(`@x11\n${xrandr.join("\n")}`).monitors
    .map((m) => ({ name: m.name, x: m.x, y: m.y, width: m.width, height: m.height, primary: m.primary === true }));
  if (!monitors.length) return undefined;
  // x11vnc shares the whole X screen, whose origin is 0,0.
  return { width: Math.max(...monitors.map((m) => m.x + m.width)), height: Math.max(...monitors.map((m) => m.y + m.height)), monitors };
}

/** The host-side directory of a Linux session; the nonce makes it unguessable. */
export function remoteLinuxDir(nonce: string): string {
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error("remote session nonce must be 32 hex digits");
  return `/tmp/fleet-remote-${nonce}`;
}

/** A VNC password: VNC authentication uses 8 bytes. */
export function remotePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return [...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join("");
}

// TightVNC stores the VNC password DES-encrypted under VNC's fixed key. These
// bytes are that key {23,82,107,6,35,78,88,7} bit-reversed for standard DES.
const WINDOWS_TIGHTVNC = `
$fleetSvc='tvnserver'
$fleetKey='HKLM:\\SOFTWARE\\TightVNC\\Server'
function Set-FleetVncConfig {
  if(-not (Test-Path $fleetKey)){ New-Item -Path $fleetKey -Force | Out-Null }
  # RemoveWallpaper 0: the person at the host keeps their wallpaper while a viewer is connected.
  foreach($kv in @(@('LoopbackOnly',1),@('AllowLoopback',1),@('AcceptRfbConnections',1),@('AcceptHttpConnections',0),
                   @('UseVncAuthentication',1),@('QueryAcceptOnConnection',0),@('RemoveWallpaper',0),@('RfbPort',${REMOTE_WINDOWS_PORT}))){
    New-ItemProperty -Path $fleetKey -Name $kv[0] -Value $kv[1] -PropertyType DWord -Force | Out-Null
  }
}
function Set-FleetVncPassword([byte[]]$plain){
  $des=[Security.Cryptography.DES]::Create()
  try {
    $des.Mode='ECB'; $des.Padding='None'
    $des.Key=[byte[]](0xe8,0x4a,0xd6,0x60,0xc4,0x72,0x1a,0xe0)
    $buf=New-Object byte[] 8; [Array]::Copy($plain,$buf,[Math]::Min(8,$plain.Length))
    $enc=$des.CreateEncryptor().TransformFinalBlock($buf,0,8)
  } finally { $des.Dispose() }
  New-ItemProperty -Path $fleetKey -Name Password -Value $enc -PropertyType Binary -Force | Out-Null
}
function Clear-FleetVncPassword {
  $b=New-Object byte[] 8; $rng=[Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($b); $rng.Dispose()
  Set-FleetVncPassword $b
}
`;

const monHidden = psHiddenLaunch("$psexe", "$psarg");
/** The monitor layout of a Windows host. sshd's session 0 sees one 1024x768
 *  screen, so a one-shot scheduled task reads it in the user's session, DPI
 *  aware so the bounds are the physical pixels TightVNC shares. Start runs the
 *  task, Read waits up to 8 s for its file, Remove deletes the task and files.
 *  Each step fails quietly: a session without a layout still works. */
const WINDOWS_MONITORS = `
$fleetMonScript=@'
$ErrorActionPreference='Stop'
$out=[IO.Path]::ChangeExtension($MyInvocation.MyCommand.Path,'json')
try {
${PS_DPI_AWARE.map((line) => `  ${line}`).join("\n")}
  Add-Type -AssemblyName System.Windows.Forms
  $vs=[System.Windows.Forms.SystemInformation]::VirtualScreen
  $screens=@([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [ordered]@{ name=$_.DeviceName.TrimStart('\\.'); x=$_.Bounds.X; y=$_.Bounds.Y; width=$_.Bounds.Width; height=$_.Bounds.Height; primary=$_.Primary } })
  $json=ConvertTo-Json -Compress -Depth 4 ([ordered]@{ x=$vs.X; y=$vs.Y; width=$vs.Width; height=$vs.Height; screens=$screens })
  [IO.File]::WriteAllText("$out.part",$json)
  Move-Item -LiteralPath "$out.part" -Destination $out -Force
} catch { [IO.File]::WriteAllText("$out.error",[string]$_) }
'@
function Remove-FleetMonitors($m){
  if(-not $m){ return }
  if($m.task -and -not (Test-Path -LiteralPath $m.out)){ try { $m.task.Stop(0) } catch {} }
  if($m.root -and $m.name){ try { $m.root.DeleteTask($m.name,0) } catch {} }
  foreach($p in @($m.ps1,$m.out,"$($m.out).part","$($m.out).error")){ Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
}
function Start-FleetMonitors {
  $m=@{ ps1=(Join-Path $env:TEMP ('fleet_remote_' + [guid]::NewGuid().ToString('N') + '.ps1')); since=(Get-Date) }
  $m.out=[IO.Path]::ChangeExtension($m.ps1,'json')
  try {
    Set-Content -LiteralPath $m.ps1 -Value $fleetMonScript -Encoding UTF8
    $psexe=(Get-Process -Id $PID).Path
    $psarg='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $m.ps1 + '"'
    $svc=New-Object -ComObject Schedule.Service; $svc.Connect(); $m.root=$svc.GetFolder('\\')
    $def=$svc.NewTask(0)
    $def.Settings.DisallowStartIfOnBatteries=$false; $def.Settings.StopIfGoingOnBatteries=$false
    $act=$def.Actions.Create(0); $act.Path=${monHidden.exe}; $act.Arguments=${monHidden.args}
    $m.name='fleet_remote_' + [guid]::NewGuid().ToString('N')
    # 6 = create or update; 3 = run in the user's interactive session.
    $m.task=$m.root.RegisterTaskDefinition($m.name,$def,6,$env:USERNAME,$null,3)
    [void]$m.task.Run($null)
    return $m
  } catch { Remove-FleetMonitors $m; return $null }
}
function Read-FleetMonitors($m){
  if(-not $m){ return '' }
  while(-not (Test-Path -LiteralPath $m.out) -and -not (Test-Path -LiteralPath "$($m.out).error")){
    $age=((Get-Date) - $m.since).TotalSeconds
    if($age -gt 8){ break }
    # Ready (3) after the task had time to start: it ended without a layout.
    if($age -gt 2){ try { if($m.task.State -eq 3){ break } } catch { break } }
    Start-Sleep -Milliseconds 50
  }
  if(Test-Path -LiteralPath $m.out){ try { return [IO.File]::ReadAllText($m.out).Trim() } catch {} }
  return ''
}
`;

/** The host-side program of one session. It prints `FLEET-REMOTE-READY <kind>`
 *  once the server accepts connections, then holds until stdin closes (or, on
 *  Windows, the login's sshd process exits) and stops what it started. */
export function remoteSessionScript(os: Host["os"], opts: { nonce: string; password?: string; hostName: string }): { cmd: string; shell: Shell } {
  const hint = `run: fleet remote ${opts.hostName} install`;
  if (os === "windows") {
    if (!opts.password || !/^[A-Za-z0-9]{8}$/.test(opts.password)) throw new Error("a Windows session needs an 8-character alphanumeric password");
    return {
      shell: "powershell",
      cmd: `$ErrorActionPreference='Stop'
${WINDOWS_TIGHTVNC}
${WINDOWS_MONITORS}
if(-not (Get-Service $fleetSvc -ErrorAction SilentlyContinue)){ throw 'TightVNC is not installed on this host; ${psEsc(hint)}' }
try { Stop-Service $fleetSvc -Force -ErrorAction SilentlyContinue } catch {}
Set-FleetVncConfig
Set-FleetVncPassword ([Text.Encoding]::ASCII.GetBytes('${psEsc(opts.password)}'))
$fleetMon=$null
try {
  Start-Service $fleetSvc
  $fleetMon=Start-FleetMonitors
  $ready=$false
  $deadline=(Get-Date).AddSeconds(20)
  while(-not $ready -and (Get-Date) -lt $deadline){
    $c=New-Object Net.Sockets.TcpClient
    try { $ready=$c.ConnectAsync('127.0.0.1',${REMOTE_WINDOWS_PORT}).Wait(300) -and $c.Connected } catch {} finally { $c.Dispose() }
    if(-not $ready){ Start-Sleep -Milliseconds 200 }
  }
  if(-not $ready){ throw 'TightVNC did not start listening on 127.0.0.1:${REMOTE_WINDOWS_PORT}' }
  $fleetLayout=Read-FleetMonitors $fleetMon
  Remove-FleetMonitors $fleetMon; $fleetMon=$null
  if($fleetLayout){ [Console]::Out.WriteLine('${MONITORS} ' + $fleetLayout) }
  [Console]::Out.WriteLine('${READY} tightvnc'); [Console]::Out.Flush()
  # The session ends when stdin closes or when this login's sshd process exits.
  $fleetEof=$fleetControl.CopyToAsync([IO.Stream]::Null)
${WINDOWS_SSHD_WATCH}
  while(-not $fleetEof.Wait(1000)){ if(Test-FleetSshdGone){ break } }
} finally {
  Remove-FleetMonitors $fleetMon
  try { Stop-Service $fleetSvc -Force -ErrorAction SilentlyContinue } catch {}
  Clear-FleetVncPassword
}`,
    };
  }
  if (os === "mac") {
    return {
      shell: "bash",
      cmd: `{
  nc -z -G 2 127.0.0.1 ${MAC_PORT} >/dev/null 2>&1 || { echo 'Screen Sharing is off on this Mac; ${hint}' >&2; exit 3; }
  echo '${READY} screensharing'
  cat >/dev/null
}`,
    };
  }
  const dir = remoteLinuxDir(opts.nonce);
  return {
    shell: "bash",
    cmd: `{
  dir='${dir}'; sock="$dir/vnc.sock"; pid=; guard=
  umask 077
  mkdir -m 700 "$dir" || { echo "fleet: cannot create $dir" >&2; exit 1; }
  cleanup() {
    test -z "$guard" || { kill "$guard" 2>/dev/null; wait "$guard" 2>/dev/null; }
    test -z "$pid" || { kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; }
    rm -rf "$dir"
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
${GRAPHICAL_ENV_SH /* unindented: its heredoc terminator must start the line */}
  if [ -n "\${WAYLAND_DISPLAY:-}" ]; then
    kind=wayvnc
    command -v wayvnc >/dev/null || { echo 'wayvnc is not installed on this host; ${hint}' >&2; exit 3; }
    : > "$dir/config"
    # wayvnc 0.9 takes -u and a path; 0.10 dropped -u for a unix: address.
    if wayvnc --help 2>&1 | grep -q -- --unix-socket; then listen="-u $sock"; else listen="unix:$sock"; fi
    wayvnc -C "$dir/config" -S "$dir/ctl.sock" $listen </dev/null >"$dir/log" 2>&1 &
  else
    kind=x11vnc
    if [ -z "\${DISPLAY:-}" ]; then
      for s in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do
        [ "$(loginctl show-session "$s" -p Name --value 2>/dev/null)" = "$(id -un)" ] || continue
        d=$(loginctl show-session "$s" -p Display --value 2>/dev/null)
        [ -n "$d" ] && { DISPLAY=$d; break; }
      done
    fi
    [ -n "\${DISPLAY:-}" ] || { echo 'no graphical session for this user (no Wayland socket, no X display); log in on the desktop first' >&2; exit 3; }
    command -v x11vnc >/dev/null || { echo 'x11vnc is not installed on this host; ${hint}' >&2; exit 3; }
    # The monitor layout, for the page's screen picker; a failure only hides the picker.
    if command -v xrandr >/dev/null; then timeout 5 xrandr -display "$DISPLAY" --listmonitors 2>/dev/null | sed 's/^/${XRANDR} /'; fi
    x11vnc -display "$DISPLAY" -auth guess -unixsock "$sock" -rfbport 0 -forever -shared -nopw -quiet </dev/null >"$dir/log" 2>&1 &
  fi
  pid=$!
  i=0
  while [ ! -S "$sock" ]; do
    kill -0 "$pid" 2>/dev/null || { wait "$pid" 2>/dev/null; pid=; echo "$kind exited before it listened:" >&2; tail -n 20 "$dir/log" >&2; exit 1; }
    i=$((i + 1))
    [ "$i" -lt 150 ] || { echo "$kind did not open its socket in 15 s:" >&2; tail -n 20 "$dir/log" >&2; exit 1; }
    sleep 0.1
  done
  echo "${READY} $kind"
  # The controller keeps stdin open; EOF stops the server.
  (trap 'kill "$c" 2>/dev/null; wait "$c" 2>/dev/null' EXIT; trap 'exit' TERM HUP INT; cat <&0 >/dev/null & c=$!; wait "$c"; kill "$pid" 2>/dev/null) <&0 >/dev/null 2>&1 &
  guard=$!
  wait "$pid"; rc=$?; pid=
  [ "$rc" = 0 ] || [ "$rc" = 143 ] || { echo "$kind exited with $rc:" >&2; tail -n 20 "$dir/log" >&2; }
  exit "$rc"
}`,
  };
}

/** Where the `-L` forward points on the host. */
export function remoteTarget(os: Host["os"], nonce: string): string {
  if (os === "windows") return `127.0.0.1:${REMOTE_WINDOWS_PORT}`;
  if (os === "mac") return `127.0.0.1:${MAC_PORT}`;
  return `${remoteLinuxDir(nonce)}/vnc.sock`;
}

/** The ssh argv of a session: a fresh connection (a multiplexed master would
 *  keep the forward after the session), the forward, and the remote shell. */
export function remoteSshArgs(host: Host, localSocket: string, target: string, remote: string[]): string[] {
  return ["ssh", ...freshConnOpts(host), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
    "-o", "ExitOnForwardFailure=yes", "-o", "StreamLocalBindUnlink=yes",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-L", `${localSocket}:${target}`, host.ssh, ...remote];
}

// ── web side ─────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page. The password (Windows sessions) and the monitor layout ride in a
 *  JSON block the page reads; the page is only served under the session token. */
export function remotePage(meta: { host: string; kind: RemoteKind; password?: string; viewOnly?: boolean; screens?: RemoteScreens }): string {
  const cfg = JSON.stringify({ host: meta.host, kind: meta.kind, password: meta.password ?? null, viewOnly: meta.viewOnly === true, screens: meta.screens ?? null })
    .replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.host)} · fleet remote</title>
<style>
:root{color-scheme:dark}
html,body{margin:0;height:100%;background:#101010;color:#ddd;font:13px system-ui,sans-serif}
body{display:flex;flex-direction:column}
#bar{display:flex;gap:8px;align-items:center;padding:6px 10px;background:#1a1a1a;border-bottom:1px solid #2a2a2a}
#bar b{font-weight:600}
#status{color:#999}#status[data-tone=ok]{color:#6c6}#status[data-tone=bad]{color:#e77}
.sp{flex:1}
button{background:#262626;color:#ddd;border:1px solid #393939;border-radius:4px;padding:3px 9px;font:inherit;cursor:pointer}
button:hover{background:#303030}
label{display:flex;gap:4px;align-items:center;color:#aaa}
select{background:#262626;color:#ddd;border:1px solid #393939;border-radius:4px;padding:2px 4px;font:inherit}
select[hidden]{display:none}
#screen{flex:1;min-height:0;position:relative;overflow:hidden}
#crop{position:relative;overflow:hidden;width:100%;height:100%}
#stage{position:absolute;left:0;top:0;width:100%;height:100%}
#login{position:fixed;top:64px;left:50%;transform:translateX(-50%);background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:16px;display:grid;gap:8px;min-width:240px}
#login[hidden],#user-row[hidden]{display:none}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;background:#101010;color:#ddd;border:1px solid #393939;border-radius:4px;padding:5px}
</style></head><body>
<div id="bar"><b>${esc(meta.host)}</b><span id="status">loading…</span><span class="sp"></span>
<select id="monitor" hidden title="Show one screen of the host, or all of them"></select><button id="cad" title="Send Ctrl+Alt+Del">Ctrl+Alt+Del</button><button id="paste" title="Copy this computer's clipboard to the host's clipboard; paste there as usual">Send clipboard</button><button id="scale" title="Switch between fit to window and 1:1">1:1</button>
<label><input type="checkbox" id="viewonly">View only</label><button id="full">Fullscreen</button><button id="reconnect">Reconnect</button></div>
<div id="screen"><div id="crop"><div id="stage"></div></div></div>
<form id="login" hidden><div id="user-row"><input type="text" id="user" placeholder="Username" autocomplete="username"></div><input type="password" id="pass" placeholder="Password" autocomplete="current-password"><button type="submit">Sign in</button></form>
<script type="application/json" id="fleet-cfg">${cfg}</script>
<script type="module" src="client.js"></script>
</body></html>`;
}

interface Bridge { sock?: Socket<undefined>; out: Uint8Array[]; closed: boolean }

function flush(b: Bridge): void {
  while (b.sock && b.out.length) {
    const chunk = b.out[0]!;
    const n = b.sock.write(chunk);
    if (n <= 0) return;
    if (n < chunk.byteLength) { b.out[0] = chunk.subarray(n); return; }
    b.out.shift();
  }
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface RemoteWeb {
  url: string;
  /** The page at each of this machine's IPv4 network addresses, when it
   *  listens on every interface; empty otherwise. */
  lanUrls: string[];
  server: Server<Bridge>;
  stop(): void;
}

/** How the browser side of a session listens and starts. */
export interface RemoteWebOptions {
  listen?: string;   // bind address; 127.0.0.1 unless given
  port?: number;     // 0 or absent: any free port
  viewOnly?: boolean; // the page starts with View only ticked
}

/** Serve the page, the client and the WebSocket bridge to `socketPath`. Every
 *  path sits under a random token, and a WebSocket must come from the page's
 *  own origin. */
export function serveRemoteWeb(opts: RemoteWebOptions & {
  socketPath: string; host: string; kind: RemoteKind; password?: string; token?: string; screens?: RemoteScreens;
}): RemoteWeb {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const page = remotePage({ host: opts.host, kind: opts.kind, password: opts.password, viewOnly: opts.viewOnly, screens: opts.screens });
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
  const server = Bun.serve<Bridge>({
    hostname: opts.listen ?? "127.0.0.1",
    port: opts.port ?? 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      const [, tok, ...rest] = url.pathname.split("/");
      if (!tok || !sameToken(tok, token)) return new Response("not found", { status: 404 });
      const leaf = rest.join("/");
      if (leaf === "" && rest.length === 1) {
        const host = req.headers.get("host") ?? "";
        return new Response(page, { headers: { ...headers, "content-type": "text/html; charset=utf-8",
          "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data: blob:; connect-src ws://${host} wss://${host}; form-action 'none'; base-uri 'none'; frame-ancestors 'none'` } });
      }
      if (leaf === "client.js")
        return new Response(REMOTE_CLIENT_JS, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } });
      if (leaf === "ws") {
        const origin = req.headers.get("origin");
        if (origin) {
          let originHost = "";
          try { originHost = new URL(origin).host; } catch {}
          if (originHost !== req.headers.get("host")) return new Response("forbidden", { status: 403 });
        }
        if (srv.upgrade(req, { data: { out: [], closed: false } })) return undefined;
        return new Response("expected a WebSocket", { status: 426 });
      }
      if (leaf === "" && rest.length === 0) return Response.redirect(`/${token}/`, 302);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      async open(ws: ServerWebSocket<Bridge>) {
        try {
          const sock = await Bun.connect({
            unix: opts.socketPath,
            socket: {
              data(_s, data) { if (!ws.data.closed) ws.sendBinary(data); },
              drain() { flush(ws.data); },
              close() { if (!ws.data.closed) ws.close(); },
              error() { if (!ws.data.closed) ws.close(1011, "tunnel error"); },
            },
          });
          if (ws.data.closed) { sock.end(); return; }
          ws.data.sock = sock;
          flush(ws.data);
        } catch {
          ws.close(1011, "the ssh tunnel refused the connection");
        }
      },
      message(ws, msg) {
        ws.data.out.push(typeof msg === "string" ? Buffer.from(msg) : msg);
        flush(ws.data);
      },
      close(ws) {
        ws.data.closed = true;
        ws.data.sock?.end();
      },
    },
  });
  const wildcard = server.hostname === "0.0.0.0" || server.hostname === "::";
  const shownHost = wildcard ? "127.0.0.1" : server.hostname;
  const at = (h: string) => `http://${h.includes(":") ? `[${h}]` : h}:${server.port}/${token}/`;
  const lanUrls = wildcard
    ? Object.values(networkInterfaces()).flat()
      .flatMap((a) => a && a.family === "IPv4" && !a.internal ? [at(a.address)] : [])
    : [];
  return { url: at(shownHost ?? "127.0.0.1"), lanUrls, server, stop: () => server.stop(true) };
}

// ── session ──────────────────────────────────────────────────────────────────

export interface RemoteSession {
  host: string;
  kind: RemoteKind;
  url: string;
  /** See RemoteWeb.lanUrls. */
  lanUrls: string[];
  /** The host's monitor layout, when it reported one. */
  screens?: RemoteScreens;
  /** Resolves when the ssh connection ends, with its exit code and stderr. */
  done: Promise<{ code: number; stderr: string }>;
  stop(): void;
}

function sessionHost(cfg: FleetConfig, sel: string): Host {
  const hosts = resolveHosts(cfg, sel);
  if (hosts.length !== 1) throw new Error(`fleet remote takes one host (${sel} names ${hosts.length})`);
  const host = hosts[0]!;
  assertFeature([host], "remote", cfg);
  if (host.transport === "daytona") throw new Error(`${host.name} is a daytona sandbox; it has no desktop`);
  if (host.android) throw new Error(`${host.name} is an Android host; fleet remote opens it with scrcpy`);
  return host;
}

/** Start a session: the host's VNC server, the ssh forward, the web server. */
export async function startRemote(cfg: FleetConfig, sel: string, opts: RemoteWebOptions = {}): Promise<RemoteSession> {
  if (process.platform === "win32") throw new Error("fleet remote forwards to a unix socket; run it from a macOS or Linux machine");
  const host = sessionHost(cfg, sel);
  const nonce = randomBytes(16).toString("hex");
  const password = host.os === "windows" ? remotePassword() : undefined;
  const script = remoteSessionScript(host.os, { nonce, password, hostName: host.name });
  const localSocket = join(fleetStateDir("remote"), `${nonce.slice(0, 16)}.sock`);
  let remote: string[];
  let stdin: Uint8Array;
  if (host.os === "windows") {
    const winBin = await resolveWinBin(host, 30000);
    const sub = webcamPowerShellSubmission(script.cmd);
    remote = [winBin, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...sub.args];
    stdin = sub.stdin;
  } else {
    remote = ["bash", "-ls"];
    stdin = new TextEncoder().encode(script.cmd + "\n");
  }
  const proc = Bun.spawn(remoteSshArgs(host, localSocket, remoteTarget(host.os, nonce), remote),
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: sshEnv() });
  proc.stdin.write(stdin);
  proc.stdin.flush();
  let stderr = "";
  const errDone = (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr) stderr = (stderr + dec.decode(chunk, { stream: true })).slice(-65536);
  })().catch(() => {});
  const cleanSocket = () => { try { rmSync(localSocket, { force: true }); } catch {} };
  let closing = false;
  let killTimer: NodeJS.Timeout | undefined;
  const stopSsh = () => {
    if (closing) return;
    closing = true;
    try { proc.stdin.end(); } catch {}
    killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
  };
  const exited = proc.exited.then(async (code) => {
    clearTimeout(killTimer);
    cleanSocket();
    await errDone;
    return { code, stderr: (host.os === "windows" ? stripClixml(stderr) : stderr).trim() };
  });

  // Read stdout until the ready line, then keep draining it.
  const ready = Promise.withResolvers<RemoteKind>();
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    stopSsh();
    ready.reject(new Error(`${host.name}: the VNC server was not ready after ${READY_TIMEOUT_MS / 1000} s`));
  }, READY_TIMEOUT_MS);
  const readyLine = new RegExp(`^${READY} (tightvnc|x11vnc|wayvnc|screensharing)$`);
  const layout: string[] = [];
  let screens: RemoteScreens | undefined;
  void (async () => {
    const dec = new TextDecoder();
    let partial = "";
    for await (const chunk of proc.stdout) {
      if (settled) continue;
      const lines = (partial + dec.decode(chunk, { stream: true })).split("\n");
      partial = lines.pop()!.slice(-65536);
      for (const raw of lines) {
        const line = raw.replace(/\r$/, "");
        const m = readyLine.exec(line);
        if (m) {
          settled = true; clearTimeout(timer);
          screens = parseRemoteScreens(layout);
          ready.resolve(m[1] as RemoteKind);
          break;
        }
        if ((line.startsWith(`${MONITORS} `) || line.startsWith(`${XRANDR} `)) && layout.length < 64) layout.push(line);
      }
    }
  })().catch(() => {});
  void exited.then(({ code, stderr: err }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ready.reject(new Error(`${host.name}: ${err || `ssh exited ${code} before the VNC server was ready`}`));
  });
  const kind = await ready.promise;

  let web: RemoteWeb;
  try {
    web = serveRemoteWeb({ ...opts, socketPath: localSocket, host: host.name, kind, password, screens });
  } catch (error) {
    stopSsh();
    await exited;
    throw error;
  }
  const done = exited.then((r) => { web.stop(); return r; });
  return { host: host.name, kind, url: web.url, lanUrls: web.lanUrls, screens, done, stop: stopSsh };
}

// ── install and stop ─────────────────────────────────────────────────────────

export interface RemoteActionResult { host: string; ok: boolean; kind?: RemoteKind; detail: string }

const WINDOWS_INSTALL = `$ErrorActionPreference='Stop'
${WINDOWS_TIGHTVNC}
$note='TightVNC was already installed'
if(-not (Get-Service $fleetSvc -ErrorAction SilentlyContinue)){
  $wg=(Get-Command winget -ErrorAction SilentlyContinue).Source
  # An ssh login often lacks WindowsApps on PATH; winget.exe still sits in the App Installer package.
  if(-not $wg){
    $wg=Get-ChildItem "$env:ProgramFiles\\WindowsApps\\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe\\winget.exe" -ErrorAction SilentlyContinue |
      Sort-Object { [version]($_.Directory.Name -split '_')[1] } -Descending | Select-Object -First 1 -ExpandProperty FullName
  }
  if(-not $wg){ throw 'winget is not available on this host; install the TightVNC server by hand, then rerun install' }
  # The MSI properties keep the service loopback only from its first start.
  & $wg install --id GlavSoft.TightVNC -e --silent --disable-interactivity --accept-package-agreements --accept-source-agreements --override '/quiet /norestart ADDLOCAL=Server SET_LOOPBACKONLY=1 VALUE_OF_LOOPBACKONLY=1 SET_ALLOWLOOPBACK=1 VALUE_OF_ALLOWLOOPBACK=1 SET_ACCEPTHTTPCONNECTIONS=1 VALUE_OF_ACCEPTHTTPCONNECTIONS=0 SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=1 SET_RFBPORT=1 VALUE_OF_RFBPORT=${REMOTE_WINDOWS_PORT}' | Out-Null
  $wgCode=$LASTEXITCODE
  if(-not (Get-Service $fleetSvc -ErrorAction SilentlyContinue)){ throw "winget exited $wgCode and the tvnserver service is missing" }
  $note='installed TightVNC'
}
try { Stop-Service $fleetSvc -Force -ErrorAction SilentlyContinue } catch {}
Set-FleetVncConfig
Clear-FleetVncPassword
Set-Service $fleetSvc -StartupType Manual
"$note; the tvnserver service is Manual and stopped, loopback only on port ${REMOTE_WINDOWS_PORT}"`;

/** Install the host's VNC server. Windows: TightVNC through winget, set to a
 *  Manual, stopped, loopback-only service. Linux: x11vnc or wayvnc for the
 *  running session type, through the package manager as root. macOS: turn on
 *  the Screen Sharing service as root. */
export async function installRemote(cfg: FleetConfig, sel: string): Promise<RemoteActionResult> {
  const host = sessionHost(cfg, sel);
  if (host.os === "windows") {
    const r = await exec(host, WINDOWS_INSTALL, "powershell", { timeoutMs: 600_000 });
    return { host: host.name, ok: r.ok, kind: "tightvnc", detail: (r.ok ? r.stdout : r.stderr || r.stdout).trim() || `exit ${r.code}` };
  }
  const password = await sudoPassword(host);
  if (host.os === "mac") {
    const r = await exec(host, asRoot(`launchctl enable system/com.apple.screensharing
launchctl bootstrap system /System/Library/LaunchDaemons/com.apple.screensharing.plist 2>/dev/null || true
i=0
until nc -z -G 1 127.0.0.1 ${MAC_PORT} >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 50 ] || { echo 'Screen Sharing did not start listening on port ${MAC_PORT}' >&2; exit 1; }
  sleep 0.2
done
echo 'Screen Sharing is on (port ${MAC_PORT}, every interface; sign in with a macOS account)'`, { password, host: host.name }), "bash", { timeoutMs: 60_000 });
    return { host: host.name, ok: r.ok, kind: "screensharing", detail: (r.ok ? r.stdout : r.stderr || r.stdout).trim() || `exit ${r.code}` };
  }
  const probe = await exec(host, `${GRAPHICAL_ENV_SH}
if [ -n "\${WAYLAND_DISPLAY:-}" ]; then echo wayvnc
elif [ -n "\${DISPLAY:-}" ] || loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}' | while read -r s; do loginctl show-session "$s" -p Type --value; done | grep -qx x11; then echo x11vnc
else echo none; fi`, "bash", { timeoutMs: 30_000 });
  const kind = probe.stdout.trim().split("\n").at(-1);
  if (!probe.ok || (kind !== "wayvnc" && kind !== "x11vnc"))
    return { host: host.name, ok: false, detail: probe.ok ? "no graphical session for this user; log in on the desktop first, then rerun install" : probe.stderr.trim() || `exit ${probe.code}` };
  const r = await exec(host, asRoot(`if command -v ${kind} >/dev/null 2>&1; then echo '${kind} was already installed'
elif command -v pacman >/dev/null 2>&1; then pacman -S --needed --noconfirm ${kind} >/dev/null && echo 'installed ${kind}'
elif command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y -q ${kind} >/dev/null && echo 'installed ${kind}'
elif command -v dnf >/dev/null 2>&1; then dnf install -y -q ${kind} >/dev/null && echo 'installed ${kind}'
else echo 'no pacman, apt-get or dnf here; install ${kind} by hand' >&2; exit 1; fi`, { password, host: host.name }), "bash", { timeoutMs: 600_000 });
  return { host: host.name, ok: r.ok, kind, detail: (r.ok ? r.stdout : r.stderr || r.stdout).trim() || `exit ${r.code}` };
}

/** Stop a VNC server a session left running (a controller that died without
 *  closing its ssh). macOS Screen Sharing is a system service and stays on. */
export async function stopRemote(cfg: FleetConfig, sel: string): Promise<RemoteActionResult> {
  const host = sessionHost(cfg, sel);
  if (host.os === "mac")
    return { host: host.name, ok: true, kind: "screensharing", detail: "Screen Sharing is a system service; turn it off in System Settings > General > Sharing" };
  if (host.os === "windows") {
    const r = await exec(host, `$ErrorActionPreference='Stop'
${WINDOWS_TIGHTVNC}
if(-not (Get-Service $fleetSvc -ErrorAction SilentlyContinue)){ 'TightVNC is not installed'; return }
Stop-Service $fleetSvc -Force
Clear-FleetVncPassword
'tvnserver stopped; its password is scrambled'`, "powershell", { timeoutMs: 60_000 });
    return { host: host.name, ok: r.ok, kind: "tightvnc", detail: (r.ok ? r.stdout : r.stderr || r.stdout).trim() || `exit ${r.code}` };
  }
  const r = await exec(host, `n=0
for d in /tmp/fleet-remote-*; do
  [ -d "$d" ] && [ -O "$d" ] || continue
  pkill -u "$(id -u)" -f -- "$d/" 2>/dev/null
  rm -rf -- "$d"; n=$((n + 1))
done
echo "stopped $n session(s)"`, "bash", { timeoutMs: 30_000 });
  return { host: host.name, ok: r.ok, detail: (r.ok ? r.stdout : r.stderr || r.stdout).trim() || `exit ${r.code}` };
}
