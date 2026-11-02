import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRemoteScreens, serveRemoteWeb, type RemoteWeb } from "../src/remote.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

/** A unix socket standing in for the ssh forward: it greets like an RFB
 *  server, then echoes what it receives with a prefix. */
async function fakeTunnel(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fleet-remote-"));
  const path = join(dir, "vnc.sock");
  const listener = Bun.listen({
    unix: path,
    socket: {
      open(s) { s.write("RFB 003.008\n"); },
      data(s, d) { s.write(Buffer.concat([Buffer.from("echo:"), d])); },
    },
  });
  cleanups.push(async () => { listener.stop(true); await rm(dir, { recursive: true, force: true }); });
  return path;
}

function serve(socketPath: string): RemoteWeb {
  const web = serveRemoteWeb({ socketPath, host: "box", kind: "x11vnc", token: "t0ken" });
  cleanups.push(() => web.stop());
  return web;
}

function connect(url: string, headers: Record<string, string> = {}): Promise<{ ws: WebSocket; opened: boolean }> {
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  const done = Promise.withResolvers<{ ws: WebSocket; opened: boolean }>();
  ws.onopen = () => done.resolve({ ws, opened: true });
  ws.onerror = () => done.resolve({ ws, opened: false });
  ws.onclose = () => done.resolve({ ws, opened: false });
  return done.promise;
}

function nextMessage(ws: WebSocket): Promise<string> {
  const got = Promise.withResolvers<string>();
  ws.onmessage = (e) => got.resolve(Buffer.from(e.data as ArrayBuffer).toString());
  return got.promise;
}

test("every path outside the session token is a 404, and the page never leaks into another path", async () => {
  const web = serve(await fakeTunnel());
  const origin = new URL(web.url).origin;
  expect((await fetch(`${origin}/`)).status).toBe(404);
  expect((await fetch(`${origin}/t0kem/`)).status).toBe(404);
  expect((await fetch(`${origin}/t0ken/../t0ken/x`)).status).toBe(404);
  const page = await fetch(web.url);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect((await fetch(`${origin}/t0ken/client.js`)).status).toBe(200);
});

test("a WebSocket from another origin is refused before anything reaches the tunnel", async () => {
  const web = serve(await fakeTunnel());
  const wsUrl = web.url.replace(/^http/, "ws") + "ws";
  const foreign = await connect(wsUrl, { Origin: "http://evil.example" });
  expect(foreign.opened).toBe(false);
  const own = await connect(wsUrl, { Origin: new URL(web.url).origin });
  expect(own.opened).toBe(true);
  own.ws.close();
});

test("the bridge carries bytes both ways between the browser and the tunnel socket", async () => {
  const web = serve(await fakeTunnel());
  const { ws, opened } = await connect(web.url.replace(/^http/, "ws") + "ws");
  expect(opened).toBe(true);
  expect(await nextMessage(ws)).toBe("RFB 003.008\n");
  const reply = nextMessage(ws);
  ws.send(new TextEncoder().encode("RFB 003.008\n"));
  expect(await reply).toBe("echo:RFB 003.008\n");
  ws.close();
});

test("a tunnel that refuses the connection closes the browser's WebSocket", async () => {
  const web = serve(join(tmpdir(), `fleet-remote-missing-${process.pid}.sock`));
  const { ws, opened } = await connect(web.url.replace(/^http/, "ws") + "ws");
  expect(opened).toBe(true);
  const closed = Promise.withResolvers<number>();
  ws.onclose = (e) => closed.resolve(e.code);
  expect(await closed.promise).toBe(1011);
});

test("a Windows layout is moved to the framebuffer's origin, including a screen left of the main one", () => {
  const line = `FLEET-REMOTE-MONITORS ${JSON.stringify({ x: -1920, y: -200, width: 4480, height: 1640, screens: [
    { name: "DISPLAY1", x: 0, y: 0, width: 2560, height: 1440, primary: true },
    { name: "DISPLAY2", x: -1920, y: -200, width: 1920, height: 1080, primary: false },
  ] })}`;
  expect(parseRemoteScreens(["noise", line])).toEqual({ width: 4480, height: 1640, monitors: [
    { name: "DISPLAY1", x: 1920, y: 200, width: 2560, height: 1440, primary: true },
    { name: "DISPLAY2", x: 0, y: 0, width: 1920, height: 1080, primary: false },
  ] });
  // Windows PowerShell unwraps a one-element list.
  const one = `FLEET-REMOTE-MONITORS {"x":0,"y":0,"width":1920,"height":1080,"screens":{"name":"DISPLAY1","x":0,"y":0,"width":1920,"height":1080,"primary":true}}`;
  expect(parseRemoteScreens([one])?.monitors).toHaveLength(1);
  expect(parseRemoteScreens(["FLEET-REMOTE-MONITORS {\"x\":0}"])).toBeUndefined();
  expect(parseRemoteScreens([
    "FLEET-REMOTE-XRANDR Monitors: 2",
    "FLEET-REMOTE-XRANDR  0: +*DP-1 2560/597x1440/336+0+0  DP-1",
    "FLEET-REMOTE-XRANDR  1: +HDMI-1 1920/510x1080/287+2560+360  HDMI-1",
  ])).toEqual({ width: 4480, height: 1440, monitors: [
    { name: "DP-1", x: 0, y: 0, width: 2560, height: 1440, primary: true },
    { name: "HDMI-1", x: 2560, y: 360, width: 1920, height: 1080, primary: false },
  ] });
});

test("listening on every interface lists the page at each network address, never loopback", async () => {
  const web = serveRemoteWeb({ socketPath: await fakeTunnel(), host: "box", kind: "x11vnc", token: "t0ken", listen: "0.0.0.0" });
  cleanups.push(() => web.stop());
  expect(new URL(web.url).hostname).toBe("127.0.0.1");
  for (const u of web.lanUrls) {
    expect(new URL(u).hostname).not.toMatch(/^127\./);
    expect(new URL(u).pathname).toBe("/t0ken/");
  }
  expect(serve(await fakeTunnel()).lanUrls).toEqual([]);
});
