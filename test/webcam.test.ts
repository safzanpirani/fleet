import { expect, spyOn, test } from "bun:test";
import {
  MAX_WEBCAM_FRAME_BYTES, WEBCAM_IMAGE_IDS, PngFrameReader, currentViewport, deleteKittyVideo, detectWebcamVo,
  encodeHalfBlockFrame, encodeKittyPngFrame, kittyGraphics, parseCameras, placement,
  renderSize, runWebcamStream, validateWebcamDevice, webcamKeyInput, webcamPowerShellSubmission, webcamScript, webcamStreamScript,
} from "../src/webcam.ts";
import { captureWebcam, prepareWebcamStream } from "../src/core.ts";
import type { FleetConfig } from "../src/config.ts";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cfg = { hosts: { win: { name: "win", ssh: "fake", os: "windows" } } } as FleetConfig;

function powerShellSource(cmd: string): string {
  return Buffer.from(cmd.match(/FromBase64String\('([^']+)'\)/)![1]!, "base64").toString("utf8");
}

test("camera discovery excludes audio and screen capture devices", () => {
  expect(parseCameras("mac", "[avfoundation] AVFoundation video devices:\n[avfoundation] [0] Camera\n[avfoundation] [1] Capture screen 0\n[avfoundation] AVFoundation audio devices:\n[avfoundation] [0] Microphone"))
    .toEqual([{ device: "0", name: "Camera" }]);
  expect(parseCameras("windows", '[dshow] "Integrated Camera" (video)\n[dshow] "Mic" (audio)'))
    .toEqual([{ device: "Integrated Camera", name: "Integrated Camera" }]);
});

test("busy capture fails once without a replay", async () => {
  let calls = 0;
  await expect(captureWebcam(cfg, "win", "photo.png", { device: "Camera" }, {
    exec: async () => { calls++; return { host: "win", ok: false, code: 1, stdout: "", stderr: "Camera busy" }; },
  })).rejects.toThrow("Camera busy");
  expect(calls).toBe(1);
});

test("capture saves a complete PNG and preserves existing output on invalid data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-webcam-test-"));
  const path = join(dir, "photo.png");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const deps = (stdout: string) => ({ exec: async () => ({ host: "win", ok: true, code: 0, stdout, stderr: "" }) });
  try {
    const r = await captureWebcam(cfg, "win", path, { device: "Camera" }, deps(png.toString("base64")));
    expect(r.localPath).toBe(path);
    expect(await readFile(path)).toEqual(png);
    await writeFile(path, "prior photo");
    await expect(captureWebcam(cfg, "win", path, { device: "Camera" }, deps("dHJ1bmNhdGVk"))).rejects.toThrow("truncated");
    expect(await readFile(path, "utf8")).toBe("prior photo");
    expect(await readdir(dir)).toEqual(["photo.png"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid destination and multi-host selectors fail before execution", async () => {
  await expect(captureWebcam(cfg, "win", "photo.jpg", { device: "Camera" })).rejects.toThrow("PNG");
  const multi = { hosts: { ...cfg.hosts, second: { name: "second", ssh: "fake2", os: "mac" } } } as FleetConfig;
  await expect(captureWebcam(multi, "all", "photo.png")).rejects.toThrow("exactly one host");
});

test("capture scripts bound owned processes and clean temporary images", () => {
  const windows = powerShellSource(webcamScript("windows", "Camera").cmd);
  expect(windows).toContain("WaitForExit(20000)");
  expect(windows).toContain("finally");
  expect(windows).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
  expect(windows).toContain("$job.Dispose()");
  expect(webcamScript("mac", "0").cmd).toContain("kill -KILL");
  expect(webcamScript("mac", "0").cmd).toContain("trap");
});

test("Mac capture asks for a landscape 1280x720 format in photos and streams", async () => {
  // Without a size, avfoundation opened the Center Stage camera at 1080x1920 and
  // turned every other app's live camera to portrait.
  const argvOf = async (cmd: string) => {
    const proc = Bun.spawn(["bash", "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(`exec 3>&1 >/dev/null\nffmpeg() { printf '%s\\n' "$@" >&3; return 1; }\n${cmd}\n`);
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim().split("\n");
  };
  for (const cmd of [webcamScript("mac", "0").cmd, webcamStreamScript("mac", "0", { vo: "kitty" }).cmd]) {
    const argv = await argvOf(cmd);
    const size = argv.indexOf("-video_size");
    const input = argv.indexOf("-i");
    expect(size).toBeGreaterThan(-1);
    expect(argv[size + 1]).toBe("1280x720");
    expect(size).toBeLessThan(input);
    expect(argv[input + 1]).toBe("0:none");
  }
});

const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

test("kitty graphics detection respects kitty, ghostty, wezterm, and multiplexers", () => {
  const envOf = (map: Record<string, string>) => (k: string) => map[k];
  expect(kittyGraphics(envOf({ TERM: "xterm-kitty" }))).toBe(true);
  expect(kittyGraphics(envOf({ TERM_PROGRAM: "ghostty" }))).toBe(true);
  expect(kittyGraphics(envOf({ TERM_PROGRAM: "WezTerm" }))).toBe(true);
  expect(kittyGraphics(envOf({ TERM: "xterm-kitty", TMUX: "1" }))).toBe(false);
  expect(kittyGraphics(envOf({ TERM: "xterm-256color" }))).toBe(false);
  expect(detectWebcamVo({}, envOf({ TERM: "xterm-kitty" }))).toBe("kitty");
  expect(detectWebcamVo({}, envOf({ TERM: "xterm-256color" }))).toBe("text");
  expect(detectWebcamVo({ window: true }, envOf({ TERM: "xterm-kitty" }))).toBe("window");
  expect(detectWebcamVo({ vo: "text" }, envOf({ TERM: "xterm-kitty" }))).toBe("text");
  expect(() => detectWebcamVo({ vo: "invalid" }, envOf({}))).toThrow("kitty, text, or window");
});

test("viewport sizing caps surface at 1280x720 and centers cell placement", () => {
  const view = { columns: 200, rows: 60, pixelWidth: 3000, pixelHeight: 1800 };
  expect(renderSize(view)).toEqual({ width: 1200, height: 720 });
  const place = placement(view, 1280, 720);
  expect(place.cols).toBeGreaterThan(0);
  expect(place.cols).toBeLessThanOrEqual(200);
  expect(place.rows).toBeGreaterThan(0);
  expect(place.rows).toBeLessThanOrEqual(59);
  expect(place.x).toBeGreaterThanOrEqual(1);
  expect(place.y).toBeGreaterThanOrEqual(1);
});

test("double-buffered kitty PNG frame alternates slots and deletes the previous buffer", () => {
  const view = currentViewport(100, 30);
  const frame0 = encodeKittyPngFrame(ONE_PX_PNG, 640, 360, view, 0);
  const frame1 = encodeKittyPngFrame(ONE_PX_PNG, 640, 360, view, 1);
  expect(frame0).toContain(`a=T,f=100,t=d,i=${WEBCAM_IMAGE_IDS[0]},p=1,`);
  expect(frame0).toContain(`a=d,d=I,i=${WEBCAM_IMAGE_IDS[1]},q=2;`);
  expect(frame1).toContain(`a=T,f=100,t=d,i=${WEBCAM_IMAGE_IDS[1]},p=1,`);
  expect(frame1).toContain(`a=d,d=I,i=${WEBCAM_IMAGE_IDS[0]},q=2;`);
  expect(deleteKittyVideo()).toContain(`i=${WEBCAM_IMAGE_IDS[0]}`);
  expect(deleteKittyVideo()).toContain(`i=${WEBCAM_IMAGE_IDS[1]}`);
});

test("PngFrameReader reassembles split PNG streams and extracts dimensions", () => {
  const reader = new PngFrameReader();
  const twoFrames = Buffer.concat([Buffer.from("junk"), ONE_PX_PNG, ONE_PX_PNG]);
  const out = [
    ...reader.push(twoFrames.subarray(0, 11)),
    ...reader.push(twoFrames.subarray(11, 45)),
    ...reader.push(twoFrames.subarray(45)),
  ];
  expect(out).toHaveLength(2);
  expect(out[0]?.width).toBe(1);
  expect(out[0]?.height).toBe(1);
  expect(Buffer.from(out[0]!.png)).toEqual(ONE_PX_PNG);
  expect(Buffer.from(out[1]!.png)).toEqual(ONE_PX_PNG);
});

test("half-block renderer and key controls map exit and pause keys", () => {
  const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
  const rendered = encodeHalfBlockFrame(rgb, 2, 2, currentViewport(20, 10));
  expect(rendered).toContain("38;2;255;0;0;48;2;0;0;255m▀");
  expect(rendered).toContain("38;2;0;255;0;48;2;255;255;0m▀");
  expect(webcamKeyInput(new Uint8Array([0x71]))).toBe("stop"); // q
  expect(webcamKeyInput(new Uint8Array([0x1b]))).toBe("stop"); // Esc
  expect(webcamKeyInput(new Uint8Array([0x7f]))).toBe("stop"); // Backspace
  expect(webcamKeyInput(new Uint8Array([0x03]))).toBe("stop"); // Ctrl-C
  expect(webcamKeyInput(new Uint8Array([0x20]))).toBe("pause"); // Space
  expect(webcamKeyInput(new Uint8Array([0x1b, 0x5b, 0x41]))).toBe("other"); // Up arrow
});

test("prepared webcam playback discovers the camera, double-buffers, pauses, and cleans up on quit", async () => {
  const writes: string[] = [];
  let inputHandler: ((chunk: Uint8Array) => void) | undefined;
  let killed = false;
  const prepared = await prepareWebcamStream(
    cfg,
    "win",
    { vo: "kitty", fps: 15, viewport: currentViewport(80, 24) },
    {
      exec: async () => ({
        host: "win",
        ok: true,
        code: 0,
        stdout: '[dshow] "Integrated Camera" (video)\n',
        stderr: "",
      }),
      startProducer: (_host, script) => {
        expect(powerShellSource(script.cmd)).toContain("Webcam stream requires ffmpeg");
        let step = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            step++;
            if (step === 1) {
              // Emit two frames in one chunk (tests bounded 1-frame backpressure).
              controller.enqueue(Buffer.concat([ONE_PX_PNG, ONE_PX_PNG]));
            } else {
              inputHandler?.(new Uint8Array([0x20])); // pause
              controller.enqueue(ONE_PX_PNG);
              queueMicrotask(() => {
                inputHandler?.(new Uint8Array([0x20])); // resume -> flushes pending frame
                inputHandler?.(new Uint8Array([0x71])); // quit
                try { controller.close(); } catch {}
              });
            }
          },
        });
        return {
          stdout: stream,
          stderr: new ReadableStream({ start(c) { c.close(); } }),
          exited: Promise.resolve(0),
          kill: () => { killed = true; },
        };
      },
    },
  );
  const res = await runWebcamStream(prepared.meta, prepared.startProducer, {
    write: (text) => { writes.push(text); },
    viewport: () => currentViewport(80, 24),
    onInput: (handler) => { inputHandler = handler; return () => {}; },
    onResize: () => () => {},
  });
  expect(res.device).toBe("Integrated Camera");
  expect(res.vo).toBe("kitty");
  expect(res.frames).toBe(3);
  expect(killed).toBe(true);
  const allOut = writes.join("");
  expect(allOut).toContain("\x1b[?1049h\x1b[?25l");
  expect(allOut).toContain(`i=${WEBCAM_IMAGE_IDS[0]}`);
  expect(allOut).toContain(`i=${WEBCAM_IMAGE_IDS[1]}`);
  expect(allOut).toContain("PAUSED");
  expect(allOut).toContain("\x1b[?25h\x1b[?1049l");
});

test("webcamStreamScript configures low-latency pipes for kitty, text, and window modes", () => {
  expect(webcamStreamScript("mac", "0", { vo: "kitty", fps: 20, durationS: 5 }).cmd).toContain("image2pipe");
  expect(webcamStreamScript("linux", "/dev/video0", { vo: "text", fps: 12 }).cmd).toContain("rawvideo");
  const windows = powerShellSource(webcamStreamScript("windows", "Camera", { vo: "window", fps: 24 }).cmd);
  expect(windows).toContain("OpenStandardOutput");
  expect(windows).toContain("$fleetControl.CopyToAsync");
  expect(windows).toContain("CopyToAsync");
  expect(windows).toContain("[FleetWebcamJob]::Assign");
  const args = JSON.parse(Buffer.from(windows.match(/FromBase64String\('([^']+)'\)/)![1]!, "base64").toString()) as string[];
  expect(args).toContain("nut");
  expect(args).not.toContain("mpegts");
});

function producer(chunks: Uint8Array[], code = 0, stderr = "") {
  return {
    stdout: new ReadableStream<Uint8Array>({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { if (stderr) c.enqueue(Buffer.from(stderr)); c.close(); } }),
    exited: Promise.resolve(code),
    kill: () => {},
  };
}

const terminalIo = { write: () => {}, onInput: () => () => {}, onResize: () => () => {} };
const meta = { host: "fake", device: "camera", vo: "kitty" as const, width: 2, height: 2, fps: 15 };

test("PNG parsing accepts every header split and ignores surrounding non-PNG bytes", () => {
  const parser = new PngFrameReader();
  const bytes = Buffer.concat([Buffer.from("prefix"), ONE_PX_PNG, ONE_PX_PNG, Buffer.from("suffix")]);
  const frames = [...bytes].flatMap(byte => parser.push(new Uint8Array([byte])));
  expect(frames).toHaveLength(2);
  expect(frames[0]!.png).toEqual(new Uint8Array(ONE_PX_PNG));
  expect(() => parser.finish()).not.toThrow();
});

test("PNG safety bound applies to individual frames, not an aggregate stream read", () => {
  const extra = Buffer.alloc(5 * 1024 * 1024);
  extra.writeUInt32BE(extra.length - 12, 0);
  extra.write("tEXt", 4);
  const png = Buffer.concat([ONE_PX_PNG.subarray(0, -12), extra, ONE_PX_PNG.subarray(-12)]);
  const frames = new PngFrameReader().push(Buffer.concat([png, png]));
  expect(frames).toHaveLength(2);
  expect(frames[1]!.png.length).toBe(png.length);
  for (const length of [0xffffffff, MAX_WEBCAM_FRAME_BYTES - 12]) {
    const corrupt = Buffer.from(ONE_PX_PNG.subarray(0, 16));
    corrupt.writeUInt32BE(length, 8);
    expect(() => new PngFrameReader().push(corrupt)).toThrow("corrupt PNG chunk length");
  }
  const partial = new PngFrameReader();
  partial.push(ONE_PX_PNG.subarray(0, -1));
  expect(() => partial.finish()).toThrow("incomplete PNG");
});

test("Kitty chunks obey the payload limit, continuation markers, and cursor preservation", () => {
  const png = new Uint8Array(10000).fill(42);
  const encoded = encodeKittyPngFrame(png, 640, 360, currentViewport(), 0);
  const transmissions = [...encoded.matchAll(/\x1b_G([^;]+);([^\x1b]+)\x1b\\/g)];
  expect(transmissions).toHaveLength(4);
  for (let i = 0; i < transmissions.length; i++) {
    expect(transmissions[i]![2]!.length).toBeLessThanOrEqual(4096);
    expect(transmissions[i]![1]).toContain(`m=${i === transmissions.length - 1 ? 0 : 1}`);
  }
  expect(Buffer.from(transmissions.map(m => m[2]).join(""), "base64")).toEqual(Buffer.from(png));
  expect(encoded.startsWith("\x1b7")).toBe(true);
  expect(encoded.endsWith("\x1b8")).toBe(true);
});

test("text rendering fits a shrunken viewport and retains an odd final pixel row", () => {
  const rendered = encodeHalfBlockFrame(new Uint8Array(20 * 20 * 3).fill(7), 20, 20, currentViewport(3, 3));
  expect([...rendered.matchAll(/▀/g)]).toHaveLength(6);
  expect(rendered).not.toContain("\x1b[3;");
  expect(encodeHalfBlockFrame(new Uint8Array([1, 2, 3]), 1, 1, currentViewport()))
    .toContain("38;2;1;2;3;48;2;0;0;0m▀");
});

test("stream errors propagate before and after frames and on truncated RGB input", async () => {
  for (const chunks of [[], [ONE_PX_PNG]]) {
    await expect(runWebcamStream(meta, () => producer(chunks, 7, "camera disconnected"), terminalIo))
      .rejects.toThrow("camera disconnected");
  }
  await expect(runWebcamStream(meta, () => producer([]), terminalIo)).rejects.toThrow("no complete frames");
  await expect(runWebcamStream({ ...meta, vo: "text" }, () => producer([new Uint8Array(5)]), terminalIo))
    .rejects.toThrow("incomplete RGB");
  const rgb = new Uint8Array(24).fill(128);
  const result = await runWebcamStream({ ...meta, vo: "text" }, () => producer([rgb.subarray(0, 5), rgb.subarray(5, 20), rgb.subarray(20)]), terminalIo);
  expect(result.frames).toBe(2);
});

test("renderer setup failures clean the producer and signal handlers", async () => {
  const counts = ["SIGINT", "SIGTERM", "SIGHUP", "exit"].map(signal => process.listenerCount(signal));
  let killed = false;
  await expect(runWebcamStream(meta, () => ({ ...producer([]), kill() { killed = true; } }), {
    ...terminalIo, onInput() { throw new Error("raw mode unavailable"); },
  })).rejects.toThrow("raw mode unavailable");
  expect(killed).toBe(true);
  expect(["SIGINT", "SIGTERM", "SIGHUP", "exit"].map(signal => process.listenerCount(signal))).toEqual(counts);
});

test("all quit keys and process signals stop a stalled producer without sleeps", async () => {
  for (const action of [0x71, 0x1b, 0x7f, 0x08, 0x03, "SIGINT", "SIGTERM", "SIGHUP"] as const) {
    let finish!: (code: number) => void;
    let killed = false;
    const exited = new Promise<number>(resolve => { finish = resolve; });
    const result = await runWebcamStream(meta, () => ({
      ...producer([]), stdout: new ReadableStream<Uint8Array>(), exited,
      kill() { killed = true; finish(137); },
    }), {
      ...terminalIo,
      onInput(handler) {
        queueMicrotask(() => { if (typeof action === "string") process.emit(action); else handler(new Uint8Array([action])); });
        return () => {};
      },
    });
    expect(result.frames).toBe(0);
    expect(killed).toBe(true);
  }
});

test("window failures use player stderr and deadlines abort stalled playback", async () => {
  await expect(runWebcamStream({ ...meta, vo: "window" }, () => producer([]), {
    spawnWindowPlayer: async () => ({ code: 2, stderr: "display unavailable" }),
  })).rejects.toThrow("display unavailable");
  let deadline!: () => void;
  let finish!: (code: number) => void;
  let killed = false;
  let deadlineRemoved = false;
  const exited = new Promise<number>(resolve => { finish = resolve; });
  await runWebcamStream({ ...meta, vo: "window", durationS: 1 }, () => ({
    ...producer([]), exited, kill() { killed = true; finish(137); },
  }), {
    setDeadline(handler, ms) { expect(ms).toBe(1000); deadline = handler; return () => { deadlineRemoved = true; }; },
    spawnWindowPlayer: async (_title, _stream, signal) => {
      const done = new Promise<{ code: number; stderr: string }>(resolve => {
        signal.addEventListener("abort", () => resolve({ code: 137, stderr: "" }), { once: true });
      });
      deadline();
      return done;
    },
  });
  expect(killed).toBe(true);
  expect(deadlineRemoved).toBe(true);
});

test("paused Kitty resize redraws the displayed image, not the pending camera frame", async () => {
  let input!: (chunk: Uint8Array) => void;
  let resize!: () => void;
  const writes: string[] = [];
  const nextPng = Buffer.from(ONE_PX_PNG);
  nextPng[32] = nextPng[32]! ^ 1;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  await runWebcamStream(meta, () => ({
    ...producer([]),
    stdout: new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(ONE_PX_PNG); } }),
  }), {
    onInput(handler) { input = handler; return () => {}; },
    onResize(handler) { resize = handler; return () => {}; },
    write(text) {
      writes.push(text);
      const images = writes.filter(s => s.includes("a=T"));
      if (images.length === 1 && text.includes("a=T")) {
        input(new Uint8Array([0x20]));
        controller.enqueue(nextPng);
        queueMicrotask(() => queueMicrotask(() => { resize(); input(new Uint8Array([0x71])); }));
      }
    },
  });
  const images = writes.filter(s => s.includes("a=T"));
  expect(images).toHaveLength(2);
  expect(images[1]).toContain(ONE_PX_PNG.toString("base64"));
  expect(images[1]).not.toContain(nextPng.toString("base64"));
});

test("camera selectors and stream numbers fail before producer creation", async () => {
  expect(() => validateWebcamDevice("linux", "/etc/passwd")).toThrow("No usable camera");
  expect(() => validateWebcamDevice("mac", "1:none")).toThrow("No usable camera");
  expect(() => validateWebcamDevice("windows", "  ")).toThrow("No usable camera");
  for (const opts of [{ fps: 61 }, { fps: NaN }, { width: 2 ** 32 }, { durationS: 2147484 }]) {
    await expect(prepareWebcamStream(cfg, "nonexistent", { ...opts, viewport: currentViewport() }))
      .rejects.toThrow("requires an integer");
  }
});

test("ffmpeg filters honor non-divisor frame rates and elapsed duration", () => {
  const script = webcamStreamScript("mac", "0", { vo: "kitty", fps: 24, durationS: 5 }).cmd;
  expect(script).toContain("fps=24,");
  expect(script).toContain("'-t' '5'");
  expect(script).not.toContain("-frames:v");
});

test("POSIX producer stdin EOF kills a silent owned FFmpeg process", async () => {
  const script = webcamStreamScript("linux", "/dev/video0", { vo: "kitty" }).cmd;
  const proc = Bun.spawn(["bash", "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = proc.stderr.getReader();
  let pid: number | undefined;
  try {
    proc.stdin.write(`ffmpeg() { exec bash -c 'printf "%s\\n" "$$" >&2; while :; do :; done'; }\n${script}\n\n`);
    let diagnostic = "";
    while (!diagnostic.includes("\n")) {
      const { value, done } = await stderr.read();
      if (done) throw new Error("producer ended before the readiness handshake");
      diagnostic += new TextDecoder().decode(value);
    }
    pid = Number(diagnostic.trim());
    expect(pid).toBeGreaterThan(1);
    proc.stdin.end();
    await proc.exited;
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    proc.kill();
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await stderr.cancel();
  }
});

test("POSIX photo capture signals reap a silent FFmpeg before returning", async () => {
  const proc = Bun.spawn(["bash", "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = proc.stderr.getReader();
  let pid: number | undefined;
  try {
    proc.stdin.write(`exec 3>&2\nffmpeg() { exec bash -c 'printf "%s\\n" "$$" >&3; while :; do :; done'; }\n${webcamScript("mac", "0").cmd}\n`);
    proc.stdin.end();
    let diagnostic = "";
    while (!diagnostic.includes("\n")) {
      const { value, done } = await stderr.read();
      if (done) throw new Error("capture ended before the readiness handshake");
      diagnostic += new TextDecoder().decode(value);
    }
    pid = Number(diagnostic.trim());
    expect(pid).toBeGreaterThan(1);
    proc.kill("SIGTERM");
    await proc.exited;
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    proc.kill();
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await stderr.cancel();
  }
});

test("quit restores the terminal before teardown even when exit and pipe cancellation never settle", async () => {
  let input!: (chunk: Uint8Array) => void;
  let inputRemoved = false;
  let resizeRemoved = false;
  let stdoutCancelled = false;
  let stderrCancelled = false;
  let restored = false;
  const never = new Promise<never>(() => {});
  await runWebcamStream(meta, () => ({
    stdout: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(ONE_PX_PNG); }, cancel() { stdoutCancelled = true; return never; } }),
    stderr: new ReadableStream<Uint8Array>({ cancel() { stderrCancelled = true; return never; } }),
    exited: never,
    kill() { expect(inputRemoved).toBe(true); expect(resizeRemoved).toBe(true); expect(restored).toBe(true); },
  }), {
    onInput(handler) { input = handler; return () => { inputRemoved = true; }; },
    onResize() { return () => { resizeRemoved = true; }; },
    write(text) {
      if (text.includes("?1049l")) restored = true;
      if (text.includes("a=T")) queueMicrotask(() => input(new Uint8Array([0x71])));
    },
  });
  expect(stdoutCancelled).toBe(true);
  expect(stderrCancelled).toBe(true);
});

test("closing a window does not wait for retained producer pipes or an unresolved SSH exit", async () => {
  let stderrCancelled = false;
  let killed = false;
  const never = new Promise<never>(() => {});
  const result = await runWebcamStream({ ...meta, vo: "window" }, () => ({
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>({ cancel() { stderrCancelled = true; return never; } }),
    exited: never,
    kill() { killed = true; },
  }), { spawnWindowPlayer: async () => ({ code: 0, stderr: "" }) });
  expect(result.vo).toBe("window");
  expect(killed).toBe(true);
  expect(stderrCancelled).toBe(true);
});

test("Windows webcam bootstrap reads only a framed source line before giving stdin to control", () => {
  const command = "Write-Output 'camera ç'";
  const submission = webcamPowerShellSubmission(command);
  expect(submission.args[0]).toBe("-EncodedCommand");
  const bootstrap = Buffer.from(submission.args[1]!, "base64").toString("utf16le");
  expect(bootstrap).toContain("$fleetControl.ReadByte()");
  expect(bootstrap).not.toContain("ReadLine");
  expect(bootstrap).not.toContain(command);
  expect(Buffer.from(new TextDecoder().decode(submission.stdin).trim(), "base64").toString()).toBe(command);
  const windows = powerShellSource(webcamStreamScript("windows", "Camera", { vo: "kitty" }).cmd);
  expect(windows).not.toContain("OpenStandardInput");
  expect(windows).toContain("$fleetControl.CopyToAsync");
  expect(windows.indexOf("$job.Dispose()", windows.indexOf("} finally {"))).toBeLessThan(windows.indexOf("$proc.Dispose()"));
  expect(windows).toContain("/T /F");
  expect(webcamStreamScript("mac", "0", { vo: "kitty" }).cmd).not.toContain("-vsync");
});

test("webcam producer uses a fresh SSH session and a separate Windows control bootstrap", async () => {
  const winCfg = { hosts: { win: { name: "win", ssh: "fake-webcam-win", os: "windows", winShell: "powershell" } } } as FleetConfig;
  const prepared = await prepareWebcamStream(winCfg, "win", { device: "Camera", vo: "kitty", viewport: currentViewport() });
  const completed = Bun.spawn(["true"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  await completed.exited;
  let sent: string | Uint8Array | undefined;
  const spawn = spyOn(Bun, "spawn").mockReturnValue({
    stdout: completed.stdout, stderr: completed.stderr, exited: completed.exited, kill() {},
    stdin: { write(data: string | Uint8Array) { sent = data; return data.length; }, end() { return 0; } },
  } as typeof completed);
  try {
    prepared.startProducer();
    const argv = spawn.mock.calls[0]![0] as string[];
    expect(argv).toContain("ControlMaster=no");
    expect(argv).toContain("ControlPath=none");
    expect(argv).toContain("-EncodedCommand");
    expect(argv).not.toContain("-Command");
    expect(sent).toBeInstanceOf(Uint8Array);
  } finally { spawn.mockRestore(); }
});
