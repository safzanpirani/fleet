/**
 * fleet's own proxy transport.
 *
 * Every ssh/scp fleet launches for a proxied host gets
 *   -o ProxyCommand=<fleet> __proxy-connect <name> %h %p
 * and this file is both ends of that: the SOCKS5/HTTP CONNECT client, and the
 * stdio-splicing entry point ssh runs.
 *
 * Why not `nc -X 5` / `ncat` / `socat`?
 *  - none of them is present on every controller (`ncat` is not on macOS, and
 *    `nc -X 5` means different things to BSD nc and netcat-openbsd);
 *  - remote DNS has to be a deliberate choice, not a per-implementation accident;
 *  - the ProxyCommand string is visible in the local process table, so a
 *    `user:pass` inside it is a credential leak. Here the argv carries only the
 *    proxy NAME and the secret is read from passwordEnv/passwordFile in-process;
 *  - a failure can be attributed: proxy down, auth rejected, DNS, target refused.
 */
import net from "node:net";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Host, ProxySpec, ResolvedProxy } from "./config.ts";
import { lookupProxy, normalizeProxy, proxyIdentity, redactProxy, resolveProxy } from "./config.ts";

/** Distinct exit codes so a failed connection names the leg that broke. */
export const PROXY_EXIT = {
  usage: 64,
  unreachable: 10,   // the proxy endpoint itself did not accept a TCP connection
  auth: 11,          // the proxy rejected our credentials (or demanded ones we lack)
  dns: 12,           // the target hostname could not be resolved
  refused: 13,       // the proxy reached the target and the target said no
  protocol: 14,      // the endpoint is listening but is not the proxy we think it is
} as const;

export class ProxyError extends Error {
  constructor(message: string, readonly code: number) { super(message); }
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** The password for a spec, or undefined. A world/group-readable password file
 *  is a warning, not a failure — refusing to connect over a permission bit would
 *  be a worse outcome than saying so. */
export async function proxyPassword(
  spec: ProxySpec, env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  if (spec.password) return spec.password;
  if (spec.passwordEnv) {
    const v = env[spec.passwordEnv];
    if (!v) throw new ProxyError(`proxy password env ${spec.passwordEnv} is unset or empty`, PROXY_EXIT.auth);
    return v;
  }
  if (spec.passwordFile) {
    const path = expandHome(spec.passwordFile);
    if (!isAbsolute(path)) throw new ProxyError(`proxy passwordFile must be an absolute or ~ path (got '${spec.passwordFile}')`, PROXY_EXIT.usage);
    try {
      if ((statSync(path).mode & 0o077) !== 0)
        console.error(`fleet: warning: ${path} is readable by other users (chmod 600 it)`);
    } catch { /* the read below produces the real error */ }
    const file = Bun.file(path);
    if (!await file.exists()) throw new ProxyError(`proxy passwordFile not found: ${path}`, PROXY_EXIT.auth);
    const text = (await file.text()).split("\n")[0]!.trim();
    if (!text) throw new ProxyError(`proxy passwordFile is empty: ${path}`, PROXY_EXIT.auth);
    return text;
  }
  return undefined;
}

// ── TCP + SOCKS5 ──────────────────────────────────────────────────────────────

function connectTcp(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const fail = (e: Error) => { socket.destroy(); reject(e); };
    const timer = setTimeout(() => fail(new ProxyError(
      `proxy ${host}:${port} did not answer within ${timeoutMs}ms`, PROXY_EXIT.unreachable)), timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); socket.setNoDelay(true); resolve(socket); });
    socket.once("error", (e) => {
      clearTimeout(timer);
      fail(new ProxyError(`proxy ${host}:${port} unreachable: ${(e as Error).message}`, PROXY_EXIT.unreachable));
    });
  });
}

/**
 * Buffered reader for the handshake only.
 *
 * A socket in flowing mode cannot be `unshift`ed mid-`data`, so we hold our own
 * buffer for the whole handshake and give back whatever is left over exactly
 * once, when the tunnel is handed to the caller. Without this, a proxy that
 * packs its reply and the first tunnel bytes into one TCP segment loses data.
 */
class HandshakeReader {
  private buf: Buffer = Buffer.alloc(0);
  private waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private failure: Error | null = null;
  private released = false;
  private readonly onData = (chunk: Buffer) => { this.buf = Buffer.concat([this.buf, chunk]); this.serve(); };
  private readonly onError = (e: Error) => this.fail(new ProxyError(`proxy connection failed: ${e.message}`, PROXY_EXIT.unreachable));
  private readonly onClose = () => this.fail(new ProxyError("proxy closed the connection mid-handshake", PROXY_EXIT.protocol));

  constructor(private readonly socket: net.Socket) {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }
  private serve(): void {
    const w = this.waiter;
    if (!w || this.buf.length < w.n) return;
    this.waiter = null;
    clearTimeout(w.timer);
    const out = this.buf.subarray(0, w.n);
    this.buf = this.buf.subarray(w.n);
    w.resolve(out);
  }
  private fail(e: Error): void {
    this.failure ??= e;
    const w = this.waiter;
    if (!w) return;
    this.waiter = null;
    clearTimeout(w.timer);
    w.reject(e);
  }
  read(n: number, timeoutMs: number): Promise<Buffer> {
    if (this.failure && this.buf.length < n) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      if (this.waiter) { reject(new Error("concurrent handshake read")); return; }
      const timer = setTimeout(() => this.fail(
        new ProxyError("proxy stopped responding mid-handshake", PROXY_EXIT.protocol)), timeoutMs);
      this.waiter = { n, resolve, reject, timer };
      this.serve();
    });
  }
  /** Detach, and give any bytes the proxy sent past the handshake back to the
   *  stream. `unshift` requires a paused stream, so a socket that arrived with
   *  early tunnel bytes comes back paused — `pipe()` (what spliceStdio does)
   *  resumes it. With nothing left over the socket is untouched. */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    if (this.buf.length) {
      this.socket.pause();
      this.socket.unshift(this.buf);
      this.buf = Buffer.alloc(0);
    }
  }
}

/** RFC 1928 reply codes, in the words someone debugging needs. */
const SOCKS_REPLY: Record<number, [string, number]> = {
  1: ["the proxy failed (general SOCKS server failure)", PROXY_EXIT.refused],
  2: ["the proxy's ruleset forbids this destination", PROXY_EXIT.refused],
  3: ["the proxy has no network route to the destination", PROXY_EXIT.refused],
  4: ["the destination host is unreachable", PROXY_EXIT.refused],
  5: ["the destination refused the connection", PROXY_EXIT.refused],
  6: ["the connection to the destination timed out (TTL expired)", PROXY_EXIT.refused],
  7: ["the proxy does not support CONNECT", PROXY_EXIT.protocol],
  8: ["the proxy does not support this address type", PROXY_EXIT.protocol],
};

async function socks5Handshake(
  socket: net.Socket, reader: HandshakeReader, spec: ProxySpec, target: string, port: number, timeoutMs: number,
): Promise<void> {
  const n = normalizeProxy(spec);
  const password = await proxyPassword(spec);
  const canAuth = !!n.user;
  socket.write(canAuth ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
  const greeting = await reader.read(2, timeoutMs);
  if (greeting[0] !== 5) throw new ProxyError(
    `${n.host}:${n.port} is not a SOCKS5 proxy (it replied with version ${greeting[0]})`, PROXY_EXIT.protocol);
  const method = greeting[1]!;
  if (method === 0xff) throw new ProxyError(
    canAuth ? "the proxy rejected every authentication method we offered"
            : "the proxy requires authentication but no user/password is configured", PROXY_EXIT.auth);
  if (method === 2) {
    if (!n.user) throw new ProxyError("the proxy asked for username/password auth but none is configured", PROXY_EXIT.auth);
    const user = Buffer.from(n.user, "utf8");
    const pass = Buffer.from(password ?? "", "utf8");
    if (user.length > 255 || pass.length > 255) throw new ProxyError("proxy username/password must be ≤255 bytes", PROXY_EXIT.usage);
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
    const reply = await reader.read(2, timeoutMs);
    if (reply[1] !== 0) throw new ProxyError("the proxy rejected the username/password", PROXY_EXIT.auth);
  } else if (method !== 0) {
    throw new ProxyError(`the proxy chose an unsupported auth method (0x${method.toString(16)})`, PROXY_EXIT.protocol);
  }

  // CONNECT. dns:"remote" hands the proxy the hostname, so the controller never
  // emits a DNS query for a host it is trying not to be associated with.
  let addr: Buffer;
  if (n.dns === "local" && !net.isIP(target)) {
    let ip: string;
    try { ip = (await lookup(target)).address; }
    catch (e) { throw new ProxyError(`cannot resolve ${target} locally: ${(e as Error).message}`, PROXY_EXIT.dns); }
    addr = ipAddrBuffer(ip);
  } else {
    addr = net.isIP(target) ? ipAddrBuffer(target) : (() => {
      const name = Buffer.from(target, "utf8");
      if (name.length > 255) throw new ProxyError(`hostname too long for SOCKS5: ${target}`, PROXY_EXIT.usage);
      return Buffer.concat([Buffer.from([3, name.length]), name]);
    })();
  }
  const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, portBuf]));

  const head = await reader.read(4, timeoutMs);
  if (head[1] !== 0) {
    const [why, code] = SOCKS_REPLY[head[1]!] ?? [`the proxy refused with code ${head[1]}`, PROXY_EXIT.refused];
    throw new ProxyError(`${target}:${port} — ${why}`, code);
  }
  const atyp = head[3];
  const bndLen = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? (await reader.read(1, timeoutMs))[0]! : -1;
  if (bndLen < 0) throw new ProxyError(`the proxy replied with an unknown address type (${atyp})`, PROXY_EXIT.protocol);
  await reader.read(bndLen + 2, timeoutMs);   // bound address + port, discarded
}

function ipAddrBuffer(ip: string): Buffer {
  if (net.isIPv4(ip)) return Buffer.concat([Buffer.from([1]), Buffer.from(ip.split(".").map(Number))]);
  const parts = expandIPv6(ip);
  return Buffer.concat([Buffer.from([4]), parts]);
}
function expandIPv6(ip: string): Buffer {
  const [head, tail] = ip.split("::") as [string, string | undefined];
  const toWords = (s: string) => s ? s.split(":").filter(Boolean).map((h) => parseInt(h, 16)) : [];
  const a = toWords(head), b = toWords(tail ?? "");
  const words = tail === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill(0), ...b];
  const out = Buffer.alloc(16);
  words.forEach((w, i) => out.writeUInt16BE(w, i * 2));
  return out;
}

async function httpConnect(
  socket: net.Socket, reader: HandshakeReader, spec: ProxySpec, target: string, port: number, timeoutMs: number,
): Promise<void> {
  const password = await proxyPassword(spec);
  const authority = net.isIPv6(target) ? `[${target}]:${port}` : `${target}:${port}`;
  const headers = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  if (spec.user) headers.push(`Proxy-Authorization: Basic ${Buffer.from(`${spec.user}:${password ?? ""}`).toString("base64")}`);
  socket.write(headers.join("\r\n") + "\r\n\r\n");
  // Read byte-wise to the end of the header block so the tunnel body stays intact.
  let head = "";
  for (;;) {
    head += (await reader.read(1, timeoutMs)).toString("latin1");
    if (head.endsWith("\r\n\r\n")) break;
    if (head.length > 16384) throw new ProxyError("the HTTP proxy sent an oversized response header", PROXY_EXIT.protocol);
  }
  const status = Number(head.split(" ")[1]);
  if (status === 407) throw new ProxyError("the HTTP proxy rejected the credentials (407)", PROXY_EXIT.auth);
  if (!(status >= 200 && status < 300))
    throw new ProxyError(`the HTTP proxy refused CONNECT ${authority} (${head.split("\r\n")[0]})`, PROXY_EXIT.refused);
}

/** Open a TCP tunnel to target:port through `spec`. The returned socket is the
 *  tunnel — write to it and you are writing to the target. */
export async function proxyConnect(
  spec: ProxySpec, target: string, port: number, timeoutMs = 15000,
): Promise<net.Socket> {
  const n = normalizeProxy(spec);
  const socket = await connectTcp(n.host, n.port, timeoutMs);
  const reader = new HandshakeReader(socket);
  try {
    if (n.type === "http") await httpConnect(socket, reader, spec, target, port, timeoutMs);
    else await socks5Handshake(socket, reader, spec, target, port, timeoutMs);
  } catch (e) { reader.release(); socket.destroy(); throw e; }
  reader.release();
  return socket;
}

/** Is the proxy endpoint itself alive? Used to attribute a failed connection to
 *  the right leg before blaming the host. */
export async function proxyReachable(spec: ProxySpec, timeoutMs = 3000): Promise<boolean> {
  try { (await connectTcp(normalizeProxy(spec).host, normalizeProxy(spec).port, timeoutMs)).destroy(); return true; }
  catch { return false; }
}

/** ~30s memo so a fan-out across a proxied group costs ONE pre-flight, not N. */
const reachCache = new Map<string, { at: number; ok: boolean }>();
export async function proxyReachableCached(spec: ProxySpec, ttlMs = 30000): Promise<boolean> {
  const key = proxyIdentity(spec);
  const hit = reachCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.ok;
  const ok = await proxyReachable(spec);
  reachCache.set(key, { at: Date.now(), ok });
  return ok;
}
export function clearProxyCache(): void { reachCache.clear(); }

// ── ProxyCommand plumbing ────────────────────────────────────────────────────

/** Bun's embedded-filesystem prefixes for a `--compile`d binary. `Bun.main`
 *  points inside one of these, at a path that exists only within the executable.
 *  Windows uses a fake `B:` drive rather than the POSIX `/$bunfs`. */
const EMBEDDED_PREFIXES = ["/$bunfs", "B:\\~BUN", "B:/~BUN"];
/** Is this process a compiled fleet binary rather than `bun src/cli.ts`? */
export function isCompiledBinary(execPath = process.execPath, main = Bun.main ?? ""): boolean {
  const runner = (execPath.split(/[\\/]/).pop() ?? "").toLowerCase();
  // The runner is the decisive signal: if we ARE bun, the entry script is real
  // and must be passed on. The prefix check covers a renamed/wrapped bun.
  if (runner === "bun" || runner === "bun.exe" || runner === "bun-debug" || runner === "bun-debug.exe") return false;
  if (!main) return true;
  return EMBEDDED_PREFIXES.some((p) => main.startsWith(p));
}
/** How to re-invoke this same fleet as a child process. A compiled binary is
 *  self-contained; from source we need `bun <entry>`. Getting this wrong emits a
 *  ProxyCommand with a phantom argument, and every proxied host then reads as a
 *  timeout — the failure looks like a dead box, not a bad argv. */
export function fleetReinvocation(): string[] {
  return isCompiledBinary() ? [process.execPath] : [process.execPath, Bun.main];
}
/** POSIX-sh single-quoting — ssh hands ProxyCommand to /bin/sh, and paths with
 *  spaces are ordinary on macOS. */
export function shQuote(s: string): string { return `'${s.replaceAll("'", `'\\''`)}'`; }
/** Win32 OpenSSH runs ProxyCommand through `cmd.exe /c`, which treats a single
 *  quote as a literal character — a POSIX-quoted path becomes part of the
 *  filename and the connection dies with "'C:\\Tools\\fleet.exe' is not
 *  recognized". cmd wants double quotes, and `%` must be doubled so a path
 *  component is not eaten as a variable reference. */
export function cmdQuote(s: string): string { return `"${s.replaceAll("%", "%%")}"`; }
/** The quoting the CONTROLLER's ssh will apply to ProxyCommand. */
export function argQuote(s: string, platform: string = process.platform): string {
  return platform === "win32" ? cmdQuote(s) : shQuote(s);
}

/** The `-o ProxyCommand=…` (plus a matching ProxyUseFdpass=no) for a host, or []
 *  when nothing is proxied. Only the proxy NAME crosses the process table. */
export function proxyOpts(host: Host): string[] {
  const resolved = resolveProxy(host);
  if (!resolved) return [];
  if (host.transport === "daytona") return [];
  // %h/%p are ssh's own tokens, expanded before the string reaches the shell —
  // they must NOT go through cmd.exe's %-doubling.
  const cmd = [...[...fleetReinvocation(), "__proxy-connect", argvRef(resolved.ref)].map((a) => argQuote(a)),
    "%h", "%p"].join(" ");
  return ["-o", `ProxyCommand=${cmd}`];
}

/** The proxy reference as it may appear in argv. A named proxy is its name. An
 *  inline URL (`--proxy socks5h://user:pass@host`, `FLEET_PROXY`) would put its
 *  password in the process table for the life of the session, so the password
 *  moves into an environment variable that ssh passes to its ProxyCommand, and
 *  the URL names that variable instead. */
export function argvRef(ref: string, env: Record<string, string | undefined> = process.env): string {
  if (!ref.includes("://")) return ref;
  let u: URL;
  try { u = new URL(ref); } catch { return ref; }
  if (!u.password) return ref;
  const key = `FLEET_PROXY_PW_${createHash("sha256").update(ref).digest("hex").slice(0, 12).toUpperCase()}`;
  env[key] = decodeURIComponent(u.password);
  u.password = "";
  u.hash = `passwordEnv=${key}`;
  return u.toString();
}
/** 8 hex chars identifying the route, mixed into ControlPath. OpenSSH's `%C`
 *  hashes only (localhost, remotehost, port, user) — NOT the ProxyCommand — so
 *  without this a direct master and a proxied master collide and the second
 *  connection silently rides the first one's route. */
export function proxyControlKey(host: Host): string {
  const resolved = resolveProxy(host);
  if (!resolved) return "none";
  return Bun.hash(proxyIdentity(resolved.spec)).toString(16).padStart(16, "0").slice(0, 8);
}

// ── the hidden subcommand ssh runs ───────────────────────────────────────────

/** `fleet __proxy-connect <proxy-name|url> <host> <port>` — splice stdio to a
 *  tunnel. Returns the process exit code; never throws. */
export async function proxyConnectMain(argv: string[]): Promise<number> {
  const [ref, target, portArg] = argv;
  if (!ref || !target || !portArg) {
    console.error("usage: fleet __proxy-connect <proxy-name|url> <host> <port>");
    return PROXY_EXIT.usage;
  }
  const port = Number(portArg);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`fleet: __proxy-connect: bad port '${portArg}'`);
    return PROXY_EXIT.usage;
  }
  let resolved: ResolvedProxy;
  try { resolved = lookupProxy(ref); }
  catch (e) { console.error(`fleet: ${redactProxy((e as Error).message)}`); return PROXY_EXIT.usage; }

  let socket: net.Socket;
  try {
    socket = await proxyConnect(resolved.spec, target, port);
  } catch (e) {
    const err = e as ProxyError;
    console.error(`fleet: proxy ${resolved.name}: ${redactProxy(err.message)}`);
    return err.code ?? 1;
  }
  return await spliceStdio(socket);
}

/** Pump stdin→socket and socket→stdout until either side closes. */
export function spliceStdio(
  socket: net.Socket,
  io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream } = process,
): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number) => { if (!settled) { settled = true; socket.destroy(); resolve(code); } };
    socket.on("error", () => finish(1));
    socket.on("close", () => finish(0));
    io.stdin.on("error", () => finish(1));
    io.stdout.on("error", () => finish(0));   // ssh went away first — not our failure
    io.stdin.pipe(socket);
    socket.pipe(io.stdout);
  });
}

// ── verification (does the proxy actually change our egress IP?) ─────────────

export interface ProxyCheck {
  name: string;
  endpoint: string;        // host:port, never credentials
  reachable: boolean;
  verify?: { url: string; expect?: string; observed?: string; ok: boolean; error?: string };
}

/** Escape a value for a double-quoted curl config string: an unescaped `"` or
 *  `\` in a password would end the string early or eat the next character. */
export function curlQuote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

/** Fetch `verify.url` THROUGH the proxy and report the body (an IP-echo service
 *  in practice). Shells out to curl because the tunnel needs TLS on top and curl
 *  already speaks both; credentials go over a stdin config file, never argv. */
export async function proxyVerify(
  spec: ProxySpec, url: string, expect?: string, timeoutS = 10,
): Promise<NonNullable<ProxyCheck["verify"]>> {
  const n = normalizeProxy(spec);
  const scheme = n.type === "http" ? "http" : (n.dns === "remote" ? "socks5h" : "socks5");
  const config = [`proxy = "${curlQuote(`${scheme}://${n.host}:${n.port}`)}"`, "silent", "show-error",
    `max-time = ${timeoutS}`, `url = "${curlQuote(url)}"`];
  if (n.user) {
    const password = await proxyPassword(spec).catch(() => undefined);
    config.push(`proxy-user = "${curlQuote(`${n.user}:${password ?? ""}`)}"`);
  }
  const proc = Bun.spawn(["curl", "--config", "-"], {
    stdin: new TextEncoder().encode(config.join("\n") + "\n"),
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  const observed = out.trim().slice(0, 200);
  if (code !== 0) return { url, expect, ok: false, error: redactProxy(err.trim() || `curl exited ${code}`) };
  return { url, expect, observed, ok: expect ? observed.includes(expect) : true };
}

/** Everything `fleet proxy check` / `fleet doctor` want to say about one proxy. */
export async function checkProxy(resolved: ResolvedProxy): Promise<ProxyCheck> {
  const n = normalizeProxy(resolved.spec);
  const reachable = await proxyReachable(resolved.spec);
  const check: ProxyCheck = { name: resolved.name, endpoint: `${n.host}:${n.port}`, reachable };
  if (reachable && resolved.spec.verify)
    check.verify = await proxyVerify(resolved.spec, resolved.spec.verify.url, resolved.spec.verify.expect);
  return check;
}

/** The exact ProxyCommand fleet would hand ssh for this host — what `doctor`
 *  prints so a "works with raw ssh" comparison is one copy-paste away. */
export function proxyCommandFor(host: Host): string | undefined {
  const opts = proxyOpts(host);
  const i = opts.findIndex((o) => o.startsWith("ProxyCommand="));
  return i < 0 ? undefined : redactProxy(opts[i]!.slice("ProxyCommand=".length));
}
