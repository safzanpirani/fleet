import type { OS } from "./config.ts";
import { bashEsc, type Shell } from "./ssh.ts";
import type { ReadableStreamDefaultReader } from "node:stream/web";

export interface Camera { device: string; name: string }

export function parseCameras(os: OS, output: string): Camera[] {
  const cameras: Camera[] = [];
  let video = false;
  for (const line of output.split(/\r?\n/)) {
    if (os === "mac") {
      if (line.includes("AVFoundation video devices:")) video = true;
      if (line.includes("AVFoundation audio devices:")) video = false;
      const m = video && line.match(/\[(\d+)\] (.+)$/);
      if (m && !m[2]!.startsWith("Capture screen")) cameras.push({ device: m[1]!, name: m[2]! });
    } else if (os === "windows") {
      const m = line.match(/"(.+)" \(video\)/);
      if (m) cameras.push({ device: m[1]!, name: m[1]! });
    } else {
      const m = line.match(/^(\/dev\/video\d+)$/);
      if (m) cameras.push({ device: m[1]!, name: m[1]! });
    }
  }
  return cameras;
}

export function validateWebcamDevice(os: OS, device: string | undefined): asserts device is string {
  if (!device?.trim() || device.includes("\0") || (os === "mac" && !/^\d+$/.test(device))
    || (os === "linux" && !/^\/dev\/video\d+$/.test(device))) {
    throw new Error("No usable camera selected; run webcam --list and pass --device");
  }
}

export function validateWebcamStreamOptions(opts: { fps?: number; width?: number; durationS?: number }): void {
  for (const [flag, value, min, max] of [
    ["--fps", opts.fps, 1, 60], ["--width", opts.width, 16, 1280],
    ["--for", opts.durationS, 1, Math.floor(0x7fffffff / 1000) - 1],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max))
      throw new Error(`${flag} requires an integer from ${min} to ${max}`);
  }
}

/** Decode the complete program before running it; keep binary stdout free of PowerShell formatting. */
function powershellProgram(source: string): string {
  const encoded = Buffer.from(source).toString("base64");
  return `$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; try { . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }\n`;
}

// Closing the owning PowerShell process also closes this job and kills FFmpeg.
// TODO(review): Suspended Windows process creation is needed to eliminate the shell-death race between Start and job assignment.
const WINDOWS_WEBCAM_JOB = `
if(-not ('FleetWebcamJob' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class FleetWebcamJob {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(SafeFileHandle job, int info, IntPtr data, uint length);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
  public static SafeFileHandle Create() {
    var job = CreateJobObject(IntPtr.Zero, null);
    if (job.IsInvalid) throw new Win32Exception();
    int size = IntPtr.Size == 8 ? 144 : 112;
    var data = Marshal.AllocHGlobal(size);
    try {
      for (int i = 0; i < size; i++) Marshal.WriteByte(data, i, 0);
      Marshal.WriteInt32(data, 16, 0x2000); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, data, (uint)size)) throw new Win32Exception();
      return job;
    } catch { job.Dispose(); throw; }
    finally { Marshal.FreeHGlobal(data); }
  }
  public static void Assign(SafeFileHandle job, Process process) {
    if (!AssignProcessToJobObject(job, process.Handle)) throw new Win32Exception();
  }
}
'@
}
$job=[FleetWebcamJob]::Create()
`;

/** A Mac camera runs one format for every app using it. Without a size,
 *  avfoundation takes the last 30 fps format the device lists, which on the
 *  Center Stage camera is 1080x1920 portrait, and flips every live call to
 *  portrait. 1280x720 is landscape and is what the capture scales to anyway. */
const MAC_CAMERA_INPUT = ["-framerate", "30", "-video_size", "1280x720", "-pixel_format", "nv12"] as const;

/** Each invocation bounds FFmpeg itself and cleans its own temporary files. */
export function webcamScript(os: OS, device?: string): { cmd: string; shell: Shell } {
  const list = device === undefined;
  const args = list
    ? os === "mac" ? ["-list_devices", "true", "-f", "avfoundation", "-i", ""]
      : ["-list_devices", "true", "-f", "dshow", "-i", "dummy"]
    : ["-f", os === "mac" ? "avfoundation" : os === "windows" ? "dshow" : "video4linux2",
      ...(os === "mac" ? MAC_CAMERA_INPUT : []), "-i",
      os === "windows" ? `video=${device}` : os === "mac" ? `${device}:none` : device!,
      "-frames:v", "1", "-vf", "scale=1280:720:force_original_aspect_ratio=decrease", "-c:v", "png", "-threads", "1"];
  if (os === "windows") {
    const argv = ["-hide_banner", "-nostdin", ...args];
    // Base64 carries literal argument boundaries through Windows PowerShell 5.1.
    const encoded = Buffer.from(JSON.stringify(argv)).toString("base64");
    return { shell: "powershell", cmd: powershellProgram(`
$ErrorActionPreference='Stop'
$ff=(Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if(-not $ff){throw 'Webcam capture requires ffmpeg on this host; no software was installed'}
$p=Join-Path ([IO.Path]::GetTempPath()) ('fleet-webcam-'+[guid]::NewGuid()+'.png')
$a=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))
if(${list ? "$false" : "$true"}){$a+=@('-y',$p)}
# Quote argv using Windows CommandLineToArgvW escaping.
$quoted=@($a | ForEach-Object { '"'+([regex]::Replace([regex]::Replace($_,'(\\\\*)"','$1$1\\"'),'(\\\\+)$','$1$1'))+'"' })
$si=New-Object Diagnostics.ProcessStartInfo
$si.FileName=$ff; $si.Arguments=$quoted -join ' '; $si.UseShellExecute=$false; $si.CreateNoWindow=$true
$si.RedirectStandardError=$true; $si.RedirectStandardOutput=$true
$proc=$null
${WINDOWS_WEBCAM_JOB}
try {
  $proc=[Diagnostics.Process]::Start($si)
  [FleetWebcamJob]::Assign($job,$proc)
  $err=$proc.StandardError.ReadToEndAsync(); $out=$proc.StandardOutput.ReadToEndAsync()
  if(-not $proc.WaitForExit(20000)){$proc.Kill(); throw 'Webcam timed out; the camera may be busy or permission may be denied'}
  if(${list ? "$true" : "$false"}){[Console]::Write($err.Result); exit 0}
  if($proc.ExitCode -ne 0){throw ('Camera unavailable, busy, or permission denied: '+$err.Result)}
  [Console]::Write([Convert]::ToBase64String([IO.File]::ReadAllBytes($p)))
} finally {if($proc){if(-not $proc.HasExited){$proc.Kill(); $proc.WaitForExit()}; $proc.Dispose()}; $job.Dispose(); Remove-Item -LiteralPath $p -ErrorAction SilentlyContinue}
`) };
  }
  if (list && os === "linux") return { shell: "bash", cmd: `command -v ffmpeg >/dev/null || { echo 'Webcam capture requires ffmpeg on this host' >&2; exit 1; }; for p in /dev/video*; do [ -c "$p" ] && printf '%s\\n' "$p"; done; true` };
  const quoted = args.map(a => `'${bashEsc(a)}'`).join(" ");
  return { shell: "bash", cmd: `
command -v ffmpeg >/dev/null || { echo 'Webcam capture requires ffmpeg on this host; no software was installed' >&2; exit 1; }
d=$(mktemp -d) || exit 1
pid=; timer=
cleanup() { test -z "$pid" || { kill -KILL "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; }; test -z "$timer" || { kill "$timer" 2>/dev/null; wait "$timer" 2>/dev/null; }; rm -rf "$d"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
ffmpeg -hide_banner -nostdin ${quoted} ${list ? "" : '-y "$d/photo.png"'} >"$d/out" 2>"$d/err" &
pid=$!
(trap 'kill "$s" 2>/dev/null; wait "$s" 2>/dev/null' EXIT; trap 'exit' TERM HUP INT; sleep 20 & s=$!; wait "$s"; kill -KILL "$pid" 2>/dev/null) </dev/null >/dev/null 2>&1 &
timer=$!
wait "$pid"; rc=$?; pid=
kill "$timer" 2>/dev/null; wait "$timer" 2>/dev/null; timer=
${list ? 'if [ "$rc" -eq 137 ]; then echo "Camera discovery timed out" >&2; exit 1; fi; cat "$d/err"' : 'if [ "$rc" -ne 0 ] || [ ! -s "$d/photo.png" ]; then echo "Camera unavailable, busy, or permission denied" >&2; cat "$d/err" >&2; exit 1; fi; base64 <"$d/photo.png"'}
` };
}

// Two image IDs double-buffer frames in Kitty, Ghostty, and WezTerm.
// Retransmitting to a visible ID makes kitty hide it until the final chunk lands.
export const WEBCAM_IMAGE_IDS = [0x464c4554, 0x464c4555] as const;
export const MAX_WEBCAM_FRAME_BYTES = 8 * 1024 * 1024;
const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type WebcamVo = "kitty" | "text" | "window";

export interface WebcamViewport {
  columns: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
}

/** Terminals supporting the Kitty graphics protocol, detected from the environment. */
export function kittyGraphics(env: (key: string) => string | undefined = (k) => process.env[k]): boolean {
  if (env("TMUX") || env("ZELLIJ")) return false;
  const term = env("TERM") ?? "";
  const prog = env("TERM_PROGRAM") ?? "";
  return Boolean(
    env("KITTY_WINDOW_ID")
    || term.includes("kitty")
    || term.includes("ghostty")
    || prog === "ghostty"
    || prog === "WezTerm"
    || env("GHOSTTY_RESOURCES_DIR"),
  );
}

export function detectWebcamVo(
  opts: { vo?: string; window?: boolean } = {},
  env: (key: string) => string | undefined = (k) => process.env[k],
): WebcamVo {
  if (opts.window) return "window";
  const raw = (opts.vo ?? env("FLEET_WEBCAM_VO"))?.trim().toLowerCase();
  if (raw) {
    if (raw === "kitty") return "kitty";
    if (raw === "text" || raw === "tct" || raw === "halfblocks") return "text";
    if (raw === "window") return "window";
    throw new Error(`webcam --vo option must be kitty, text, or window (got '${opts.vo ?? raw}')`);
  }
  return kittyGraphics(env) ? "kitty" : "text";
}

export function currentViewport(cols = process.stdout.columns || 80, rows = process.stdout.rows || 24): WebcamViewport {
  const columns = Math.max(1, cols);
  const r = Math.max(1, rows);
  return { columns, rows: r, pixelWidth: columns * 10, pixelHeight: r * 20 };
}

/** Keep the viewport aspect within a maximum decode surface (1280×720 by default). */
export function renderSize(view: WebcamViewport, maxWidth = 1280, maxHeight = 720): { width: number; height: number } {
  const w = Math.max(1, view.pixelWidth);
  const h = Math.max(1, view.pixelHeight);
  const scale = Math.min(maxWidth / w, maxHeight / h, 1);
  const even = (n: number) => Math.max(2, Math.round(n) & ~1);
  return { width: even(w * scale), height: even(h * scale) };
}

/** Centered cell rectangle preserving the frame's aspect ratio, reserving 1 status row. */
export function placement(
  view: WebcamViewport, frameWidth: number, frameHeight: number,
): { cols: number; rows: number; x: number; y: number } {
  const availRows = Math.max(1, view.rows > 2 ? view.rows - 1 : view.rows);
  const availPxH = Math.max(1, (view.pixelHeight * availRows) / Math.max(1, view.rows));
  const fw = Math.max(1, frameWidth);
  const fh = Math.max(1, frameHeight);
  const pw = Math.max(1, view.pixelWidth);
  const scale = Math.min(pw / fw, availPxH / fh);
  const cols = Math.min(Math.max(1, view.columns), Math.max(1, Math.round((fw * scale * view.columns) / pw)));
  const rows = Math.min(availRows, Math.max(1, Math.round((fh * scale * availRows) / availPxH)));
  const x = Math.floor((Math.max(1, view.columns) - cols) / 2) + 1;
  const y = Math.floor((availRows - rows) / 2) + 1;
  return { cols, rows, x, y };
}

export function deleteKittyVideo(): string {
  return `\x1b_Ga=d,d=I,i=${WEBCAM_IMAGE_IDS[0]},q=2;\x1b\\\x1b_Ga=d,d=I,i=${WEBCAM_IMAGE_IDS[1]},q=2;\x1b\\`;
}

/** Place one PNG frame into `slot` and delete `1 - slot` after the final chunk. */
export function encodeKittyPngFrame(
  png: Uint8Array, width: number, height: number, view: WebcamViewport, slot: 0 | 1,
): string {
  const { cols, rows, x, y } = placement(view, width, height);
  const b64 = Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString("base64");
  let out = `\x1b7\x1b[${y};${x}H`;
  const total = Math.max(1, Math.ceil(b64.length / 4096));
  for (let i = 0; i < total; i++) {
    const chunk = b64.slice(i * 4096, (i + 1) * 4096);
    const more = i + 1 < total ? 1 : 0;
    if (i === 0) {
      out += `\x1b_Gq=2,a=T,f=100,t=d,i=${WEBCAM_IMAGE_IDS[slot]},p=1,c=${cols},r=${rows},C=1,m=${more};${chunk}\x1b\\`;
    } else {
      out += `\x1b_Gq=2,m=${more};${chunk}\x1b\\`;
    }
  }
  out += `\x1b_Ga=d,d=I,i=${WEBCAM_IMAGE_IDS[1 - slot]},q=2;\x1b\\\x1b8`;
  return out;
}

export function parsePngDimensions(png: Uint8Array): { width: number; height: number } | undefined {
  if (png.byteLength < 33) return undefined;
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (png[i] !== PNG_SIG[i]) return undefined;
  }
  if (png[12] !== 0x49 || png[13] !== 0x48 || png[14] !== 0x44 || png[15] !== 0x52) return undefined;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (dv.getUint32(8, false) !== 13) return undefined;
  const width = dv.getUint32(16, false);
  const height = dv.getUint32(20, false);
  if (width < 1 || height < 1 || width > 10000 || height > 10000) return undefined;
  return { width, height };
}

export interface PngFrame {
  width: number;
  height: number;
  png: Uint8Array;
}

/** Extract complete PNG frames while bounding the incomplete frame, not a transport read. */
export class PngFrameReader {
  private buf: Uint8Array = new Uint8Array(0);
  private start = 0;
  private length = 0;
  private scanOffset = 8;

  push(chunk: Uint8Array): PngFrame[] {
    const frames: PngFrame[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      const count = Math.min(chunk.byteLength - offset, MAX_WEBCAM_FRAME_BYTES - this.length);
      if (!count) throw new Error("Webcam frame exceeded the 8 MiB safety bound");
      const needed = this.length + count;
      if (this.start + needed > this.buf.byteLength) {
        if (needed <= this.buf.byteLength) this.buf.copyWithin(0, this.start, this.start + this.length);
        else {
          const grown = new Uint8Array(Math.min(MAX_WEBCAM_FRAME_BYTES, Math.max(needed, this.buf.byteLength * 2, 4096)));
          grown.set(this.buf.subarray(this.start, this.start + this.length));
          this.buf = grown;
        }
        this.start = 0;
      }
      this.buf.set(chunk.subarray(offset, offset + count), this.start + this.length);
      this.length += count;
      offset += count;
      while (this.length >= 8) {
        const start = this.findSignature();
        if (start < 0) {
          this.discard(this.length - 7);
          this.scanOffset = 8;
          break;
        }
        if (start > 0) { this.discard(start); this.scanOffset = 8; }
        const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.start, this.length);
        let completedEnd = -1;
        while (this.scanOffset + 8 <= this.length) {
          const len = dv.getUint32(this.scanOffset, false);
          const next = this.scanOffset + 12 + len;
          if (next > MAX_WEBCAM_FRAME_BYTES) throw new Error("Webcam stream contained a corrupt PNG chunk length");
          if (next > this.length) break;
          const isIend = dv.getUint32(this.scanOffset + 4, false) === 0x49454e44;
          if (isIend && len !== 0) throw new Error("Webcam stream contained a corrupt PNG end chunk");
          this.scanOffset = next;
          if (isIend) { completedEnd = next; break; }
        }
        if (completedEnd < 0) break;
        const png = this.buf.slice(this.start, this.start + completedEnd);
        this.discard(completedEnd);
        this.scanOffset = 8;
        const dims = parsePngDimensions(png);
        if (dims) frames.push({ ...dims, png });
      }
    }
    return frames;
  }

  finish(): void {
    if (this.length >= 8 && this.findSignature() === 0) throw new Error("Camera produced an incomplete PNG frame");
  }

  private discard(count: number): void {
    this.start += count;
    this.length -= count;
    if (!this.length) this.start = 0;
  }

  private findSignature(): number {
    outer: for (let i = 0; i + PNG_SIG.length <= this.length; i++) {
      for (let j = 0; j < PNG_SIG.length; j++) {
        if (this.buf[this.start + i + j] !== PNG_SIG[j]) continue outer;
      }
      return i;
    }
    return -1;
  }
}

/** Fit RGB24 pixels to the current viewport, including an odd final scanline. */
export function encodeHalfBlockFrame(rgb: Uint8Array, width: number, height: number, view: WebcamViewport): string {
  const availRows = Math.max(1, view.rows > 2 ? view.rows - 1 : view.rows);
  const scale = Math.min(1, Math.max(1, view.columns) / width, (availRows * 2) / height);
  const cols = Math.max(1, Math.floor(width * scale));
  const pixelRows = Math.max(1, Math.floor(height * scale));
  const rows = Math.ceil(pixelRows / 2);
  const x = Math.max(1, Math.floor((view.columns - cols) / 2) + 1);
  const y = Math.max(1, Math.floor((availRows - rows) / 2) + 1);
  let out = "\x1b7";
  for (let row = 0; row < rows; row++) {
    out += `\x1b[${y + row};${x}H`;
    const topRow = Math.floor((row * 2 * height) / pixelRows) * width * 3;
    const botRow = row * 2 + 1 < pixelRows ? Math.floor(((row * 2 + 1) * height) / pixelRows) * width * 3 : rgb.length;
    for (let col = 0; col < cols; col++) {
      const sourceCol = Math.floor((col * width) / cols) * 3;
      const ti = topRow + sourceCol;
      const bi = botRow + sourceCol;
      const r1 = rgb[ti] ?? 0, g1 = rgb[ti + 1] ?? 0, b1 = rgb[ti + 2] ?? 0;
      const r2 = rgb[bi] ?? 0, g2 = rgb[bi + 1] ?? 0, b2 = rgb[bi + 2] ?? 0;
      out += `\x1b[38;2;${r1};${g1};${b1};48;2;${r2};${g2};${b2}m▀`;
    }
    out += "\x1b[0m";
  }
  out += "\x1b8";
  return out;
}

/** Map raw terminal keypress bytes to playback actions (ported from chan-tui video.rs). */
export function webcamKeyInput(data: Uint8Array): "stop" | "pause" | "other" {
  if (!data.byteLength) return "other";
  for (let i = 0; i < data.byteLength; i++) {
    if (data[i] === 0x03) return "stop"; // Ctrl-C
  }
  if (data.byteLength === 1) {
    const b = data[0]!;
    if (b === 0x1b || b === 0x7f || b === 0x08 || b === 0x71 || b === 0x51) return "stop"; // Esc, Backspace, q, Q
    if (b === 0x20) return "pause"; // Space
  }
  return "other";
}

export function webcamStreamScript(
  os: OS,
  device: string,
  opts: { vo: WebcamVo; fps?: number; width?: number; height?: number; durationS?: number },
): { cmd: string; shell: Shell; width: number; height: number; fps: number } {
  const fps = Math.max(1, Math.min(60, Math.round(opts.fps ?? 15)));
  const even = (n: number, max: number, def: number) => Math.max(2, Math.min(max, Math.round(n || def) & ~1));
  const width = opts.vo === "text"
    ? Math.max(2, Math.min(240, Math.round(opts.width ?? 80)))
    : even(opts.width ?? (opts.vo === "window" ? 1280 : 640), 1280, 640);
  const height = opts.vo === "text"
    ? even(opts.height ?? 44, 240, 44)
    : even(opts.height ?? (opts.vo === "window" ? 720 : 360), 720, 360);
  const inputArgs = [
    "-f", os === "mac" ? "avfoundation" : os === "windows" ? "dshow" : "video4linux2",
    ...(os === "mac" ? MAC_CAMERA_INPUT : os === "windows" ? ["-rtbufsize", "100M"] : []),
    "-i", os === "windows" ? `video=${device}` : os === "mac" ? `${device}:none` : device,
  ];
  const selectFilter = `fps=${fps},`;
  const durationArgs = opts.durationS !== undefined && opts.durationS > 0
    ? ["-t", String(opts.durationS)]
    : [];
  const outputArgs = opts.vo === "text"
    ? [
        "-vf", `${selectFilter}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        ...durationArgs, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
      ]
    : opts.vo === "window"
      ? [
          "-vf", `${selectFilter}scale=${width}:${height}:force_original_aspect_ratio=decrease`,
          ...durationArgs, "-f", "nut", "-c:v", "mjpeg", "-q:v", "5", "pipe:1",
        ]
      : [
          "-vf", `${selectFilter}scale=${width}:${height}:force_original_aspect_ratio=decrease`,
          ...durationArgs, "-f", "image2pipe", "-c:v", "png", "-compression_level", "1", "pipe:1",
        ];
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", ...inputArgs, ...outputArgs];
  if (os === "windows") {
    const encoded = Buffer.from(JSON.stringify(args)).toString("base64");
    return {
      shell: "powershell", width, height, fps,
      cmd: powershellProgram(`
$ErrorActionPreference='Stop'
$ff=(Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if(-not $ff){throw 'Webcam stream requires ffmpeg on this host; no software was installed'}
$a=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))
$quoted=@($a | ForEach-Object { '"'+([regex]::Replace([regex]::Replace($_,'(\\\\*)"','$1$1\\"'),'(\\\\+)$','$1$1'))+'"' })
$si=New-Object Diagnostics.ProcessStartInfo
$si.FileName=$ff; $si.Arguments=$quoted -join ' '; $si.UseShellExecute=$false; $si.CreateNoWindow=$true
$si.RedirectStandardOutput=$true; $si.RedirectStandardError=$true
$proc=$null
${WINDOWS_WEBCAM_JOB}
try {
  $proc=[Diagnostics.Process]::Start($si)
  [FleetWebcamJob]::Assign($job,$proc)
  $err=$proc.StandardError.ReadToEndAsync()
  $out=[Console]::OpenStandardOutput()
  $copy=$proc.StandardOutput.BaseStream.CopyToAsync($out)
  $control=[Console]::OpenStandardInput().CopyToAsync([IO.Stream]::Null)
  $done=[Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]]@($copy,$control))
  if($done -eq 1){return}
  $copy.GetAwaiter().GetResult()
  $proc.WaitForExit()
  if($proc.ExitCode -ne 0){throw ('Camera unavailable, busy, or permission denied: '+$err.Result)}
} finally {
  if($proc){
    if(-not $proc.HasExited){try{$proc.Kill()}catch{}}
    $proc.Dispose()
  }
  $job.Dispose()
}
`),
    };
  }
  const quoted = args.map((a) => `'${bashEsc(a)}'`).join(" ");
  return {
    shell: "bash", width, height, fps,
    cmd: `{
  command -v ffmpeg >/dev/null || { echo 'Webcam stream requires ffmpeg on this host; no software was installed' >&2; exit 1; }
  pid=; guard=
  cleanup() { test -z "$pid" || { kill -KILL "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; }; test -z "$guard" || { kill "$guard" 2>/dev/null; wait "$guard" 2>/dev/null; }; }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  ffmpeg ${quoted} </dev/null &
  pid=$!
  # The controller keeps stdin open; EOF cancels even when the camera emits no frames.
  (trap 'kill "$c" 2>/dev/null; wait "$c" 2>/dev/null' EXIT; trap 'exit' TERM HUP INT; cat <&0 >/dev/null & c=$!; wait "$c"; kill -KILL "$pid" 2>/dev/null) <&0 >/dev/null 2>&1 &
  guard=$!
  wait "$pid"; rc=$?; pid=
  exit "$rc"
}`,
  };
}

export interface WebcamStreamProc {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
}

/** Drive playback in the frontend, owning cancellation and all process/terminal cleanup. */
export async function runWebcamStream(
  meta: { host: string; device: string; vo: WebcamVo; width: number; height: number; fps: number; durationS?: number },
  startProducer: () => WebcamStreamProc,
  io: {
    write?: (text: string) => void;
    viewport?: () => WebcamViewport;
    onInput?: (handler: (chunk: Uint8Array) => void) => () => void;
    onResize?: (handler: () => void) => () => void;
    setDeadline?: (handler: () => void, ms: number) => () => void;
    spawnWindowPlayer?: (title: string, stdout: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<{ code: number; stderr: string }>;
  } = {},
): Promise<{ host: string; device: string; vo: WebcamVo; frames: number }> {
  const proc = startProducer();
  const abort = new AbortController();
  const write = io.write ?? ((s: string) => { process.stdout.write(s); });
  const getView = io.viewport ?? (() => currentViewport());
  let stopped = false;
  let frames = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let errReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let offInput = () => {};
  let offResize = () => {};
  let offDeadline = () => {};
  let enteredScreen = false;
  let producerCode: number | undefined;
  const exited = proc.exited.then(code => { producerCode = code; return code; });
  const stopStream = () => {
    if (stopped) return;
    stopped = true;
    abort.abort();
    proc.kill();
    void reader?.cancel().catch(() => {});
  };
  const onExit = () => proc.kill();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, stopStream);
  process.on("exit", onExit);
  try {
    errReader = proc.stderr.getReader();
    const stderrPromise = (async () => {
      const dec = new TextDecoder();
      let out = "";
      for (;;) {
        const { value, done } = await errReader!.read();
        if (done) break;
        if (value) out = (out + dec.decode(value, { stream: true })).slice(-65536);
      }
      return out + dec.decode();
    })();
    // Always observe drain errors, including when renderer setup fails first.
    void stderrPromise.catch(() => {});
    if (meta.durationS !== undefined && meta.durationS > 0) {
      offDeadline = (io.setDeadline ?? ((handler, ms) => {
        const timer = setTimeout(handler, ms);
        return () => clearTimeout(timer);
      }))(stopStream, Math.round(meta.durationS * 1000));
    }
    if (meta.vo === "window") {
      const runPlayer = io.spawnWindowPlayer ?? (async (title, stream, signal) => {
        const mpv = Bun.which("mpv");
        const ffplay = mpv ? null : Bun.which("ffplay");
        if (!mpv && !ffplay) throw new Error("webcam --window requires mpv or ffplay on this machine");
        const argv = mpv
          ? [mpv, "--no-cache", "--profile=low-latency", "--untimed", "--force-window=immediate", "--terminal=no", `--title=${title}`, "-"]
          : [ffplay!, "-hide_banner", "-loglevel", "error", "-autoexit", "-fflags", "nobuffer", "-flags", "low_delay", "-window_title", title, "-i", "-"];
        const player = Bun.spawn(argv, { stdin: stream, stdout: "ignore", stderr: "pipe" });
        const killPlayer = () => { try { player.kill("SIGKILL"); } catch {} };
        signal.addEventListener("abort", killPlayer, { once: true });
        if (signal.aborted) killPlayer();
        try {
          const [code, stderr] = await Promise.all([player.exited, new Response(player.stderr).text()]);
          return { code, stderr };
        } finally {
          signal.removeEventListener("abort", killPlayer);
          killPlayer();
          await player.exited;
        }
      });
      const result = await runPlayer(`fleet webcam · ${meta.host} (${meta.device})`, proc.stdout, abort.signal);
      const completedCode = producerCode;
      proc.kill();
      const [, stderr] = await Promise.all([exited, stderrPromise]);
      if (!stopped) {
        if (completedCode !== undefined && completedCode !== 0)
          throw new Error(stderr.trim() || `Webcam producer exited with code ${completedCode}`);
        if (result.code !== 0) throw new Error(result.stderr.trim() || stderr.trim() || `Webcam player exited with code ${result.code}`);
      }
      return { host: meta.host, device: meta.device, vo: meta.vo, frames };
    }

    let paused = false;
    let slot: 0 | 1 = 0;
    let latestPng: PngFrame | undefined;
    let latestRgb: Uint8Array | undefined;
    let displayedPng: PngFrame | undefined;
    let displayedRgb: Uint8Array | undefined;
    let dirty = false;
    const statusLine = (view: WebcamViewport): string => {
      if (view.rows <= 2) return "";
      const text = ` fleet webcam · ${meta.host} (${meta.device}) · ${paused ? "PAUSED · " : ""}space: pause · q/esc: quit `;
      return `\x1b7\x1b[${view.rows};1H\x1b[2K\x1b[2m${text.slice(0, view.columns)}\x1b[0m\x1b8`;
    };
    const renderCurrent = (force = false) => {
      if (stopped || (!dirty && !force)) return;
      const view = getView();
      const png = paused ? displayedPng : latestPng;
      const rgb = paused ? displayedRgb : latestRgb;
      if (meta.vo === "kitty" && png) {
        write(encodeKittyPngFrame(png.png, png.width, png.height, view, slot) + statusLine(view));
        slot = (1 - slot) as 0 | 1;
        displayedPng = png;
      } else if (meta.vo === "text" && rgb) {
        write(encodeHalfBlockFrame(rgb, meta.width, meta.height, view) + statusLine(view));
        displayedRgb = rgb;
      }
      if (!paused) dirty = false;
    };
    const stdoutReader = proc.stdout.getReader();
    reader = stdoutReader;
    offInput = (io.onInput ?? ((handler) => {
      if (!process.stdin.isTTY) return () => {};
      const wasRaw = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      const onData = (buf: Buffer) => handler(buf);
      process.stdin.on("data", onData);
      return () => {
        process.stdin.off("data", onData);
        try { process.stdin.setRawMode(Boolean(wasRaw)); } catch {}
        process.stdin.pause();
      };
    }))((chunk) => {
      if (stopped) return;
      const act = webcamKeyInput(chunk);
      if (act === "stop") stopStream();
      else if (act === "pause") {
        paused = !paused;
        write(statusLine(getView()));
        if (!paused && dirty) renderCurrent(true);
      }
    });
    offResize = (io.onResize ?? ((handler) => {
      process.stdout.on("resize", handler);
      return () => { process.stdout.off("resize", handler); };
    }))(() => {
      if (!stopped) { write("\x1b[2J" + statusLine(getView())); renderCurrent(true); }
    });
    enteredScreen = true;
    write("\x1b[?1049h\x1b[?25l\x1b[2J" + statusLine(getView()));
    if (meta.vo === "kitty") {
      const parser = new PngFrameReader();
      while (!stopped) {
        const { value, done } = await stdoutReader.read();
        if (done || stopped) break;
        if (!value) continue;
        const parsed = parser.push(value);
        if (parsed.length) {
          latestPng = parsed[parsed.length - 1]!;
          frames += parsed.length;
          dirty = true;
          if (!paused) renderCurrent();
        }
      }
      if (!stopped) parser.finish();
    } else {
      const frameBytes = meta.width * meta.height * 3;
      const acc = new Uint8Array(frameBytes);
      let length = 0;
      while (!stopped) {
        const { value, done } = await stdoutReader.read();
        if (done || stopped) break;
        if (!value) continue;
        let offset = 0;
        while (offset < value.byteLength) {
          const count = Math.min(frameBytes - length, value.byteLength - offset);
          acc.set(value.subarray(offset, offset + count), length);
          length += count;
          offset += count;
          if (length === frameBytes) {
            latestRgb = acc.slice();
            length = 0;
            frames++;
            dirty = true;
          }
        }
        if (!paused) renderCurrent();
      }
      if (!stopped && length) throw new Error("Camera produced an incomplete RGB frame");
    }
    const [code, stderr] = await Promise.all([exited, stderrPromise]);
    if (!stopped && (code !== 0 || frames === 0))
      throw new Error(stderr.trim() || (code !== 0 ? `Webcam producer exited with code ${code}` : "Camera produced no complete frames"));
    return { host: meta.host, device: meta.device, vo: meta.vo, frames };
  } finally {
    offDeadline();
    abort.abort();
    proc.kill();
    await exited.catch(() => {});
    await reader?.cancel().catch(() => {});
    await errReader?.cancel().catch(() => {});
    for (const signal of signals) process.off(signal, stopStream);
    process.off("exit", onExit);
    try { offResize(); } finally {
      try { offInput(); } finally {
        if (enteredScreen) write((meta.vo === "kitty" ? deleteKittyVideo() : "") + "\x1b[?25h\x1b[?1049l\x1b[0m");
      }
    }
  }
}
