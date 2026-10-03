/**
 * Raw socket I/O for `fleet __proxy-connect --fdpass`, through libc via bun:ffi.
 *
 * With `ProxyUseFdpass=yes`, ssh gives its ProxyCommand one end of a unix
 * socketpair as stdin and stdout and waits for a connected socket to arrive on
 * it. fleet connects to the proxy, runs the handshake, hands the tunnel to ssh
 * with SCM_RIGHTS, and exits. No fleet process stays resident for the life of
 * the connection, where the splicing ProxyCommand costs ~30 MB per tunnel.
 *
 * The handshake runs on a dup of the socket Bun connected, never on Bun's own
 * socket. Bun reads a socket as soon as data arrives, so bytes the proxy sends
 * after its reply (the server's SSH banner) would be consumed here and never
 * reach ssh. These reads take exactly the bytes each step needs.
 *
 * macOS and glibc Linux only. Win32 OpenSSH has no ProxyUseFdpass.
 */
import { dlopen, FFIType, ptr, read as peek, type Pointer } from "bun:ffi";
import { constants } from "node:os";
import type net from "node:net";

/** Can this controller hand a socket to ssh? */
export function fdpassSupported(platform: string = process.platform): boolean {
  return platform === "darwin" || platform === "linux";
}

const darwin = process.platform === "darwin";
const POLLIN = 1;
const POLLOUT = 4;
const SCM_RIGHTS = 1;
const SOL_SOCKET = darwin ? 0xffff : 1;
const { EINTR, EAGAIN } = constants.errno;

type Libc = {
  dup(fd: number): number;
  close(fd: number): number;
  read(fd: number, buf: number, n: number): number | bigint;
  write(fd: number, buf: number, n: number): number | bigint;
  poll(fds: number, nfds: number, timeoutMs: number): number;
  sendmsg(fd: number, msg: number, flags: number): number | bigint;
  errno(): number;
};

let libc: Libc | undefined;
function load(): Libc {
  if (libc) return libc;
  const errnoSymbol = darwin ? "__error" : "__errno_location";
  const { symbols } = dlopen(darwin ? "libSystem.B.dylib" : "libc.so.6", {
    dup: { args: [FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    // nfds_t is unsigned int on macOS and unsigned long on Linux.
    poll: { args: [FFIType.ptr, darwin ? FFIType.u32 : FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    sendmsg: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
    [errnoSymbol]: { args: [], returns: FFIType.ptr },
  });
  const s = symbols as unknown as Record<string, (...a: unknown[]) => unknown>;
  libc = {
    dup: (fd) => s.dup!(fd) as number,
    close: (fd) => s.close!(fd) as number,
    read: (fd, buf, n) => s.read!(fd, buf, n) as number,
    write: (fd, buf, n) => s.write!(fd, buf, n) as number,
    poll: (fds, nfds, ms) => s.poll!(fds, nfds, ms) as number,
    sendmsg: (fd, msg, flags) => s.sendmsg!(fd, msg, flags) as number,
    errno: () => peek.i32(s[errnoSymbol]!() as Pointer, 0),
  };
  return libc;
}

const errName = (e: number) =>
  Object.entries(constants.errno).find(([, v]) => v === e)?.[0] ?? `errno ${e}`;

/** Thrown with the message and the PROXY_EXIT key the caller reports. */
export class FdError extends Error {
  constructor(message: string, readonly kind: "unreachable" | "protocol") { super(message); }
}

/** Take over a socket Bun connected: return a dup of its descriptor and close
 *  Bun's copy. close() is not shutdown(), so the connection itself survives.
 *  Call this before anything is sent, so nothing has been read yet. */
export function adoptSocket(socket: net.Socket): number {
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  if (typeof fd !== "number" || fd < 0)
    throw new FdError("this runtime does not expose the proxy socket's descriptor", "protocol");
  const own = load().dup(fd);
  if (own < 0) throw new FdError(`cannot take over the proxy socket: ${errName(load().errno())}`, "unreachable");
  socket.destroy();
  return own;
}

function waitFor(fd: number, events: number, deadline: number): void {
  const pfd = Buffer.alloc(8);
  pfd.writeInt32LE(fd, 0);
  pfd.writeInt16LE(events, 4);
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new FdError("proxy stopped responding mid-handshake", "protocol");
    const r = load().poll(ptr(pfd), 1, Math.min(left, 2 ** 31 - 1));
    if (r > 0) return;
    if (r < 0 && load().errno() !== EINTR)
      throw new FdError(`proxy connection failed: ${errName(load().errno())}`, "unreachable");
  }
}

/** Blocking handshake I/O on a raw descriptor, with the reader interface the
 *  SOCKS5 and HTTP handshakes in proxy.ts use. */
export function fdIO(fd: number): { read(n: number, timeoutMs: number): Promise<Buffer>; write(data: Buffer | string): void } {
  return {
    async read(n, timeoutMs) {
      const out = Buffer.alloc(n);
      const deadline = Date.now() + timeoutMs;
      let got = 0;
      while (got < n) {
        waitFor(fd, POLLIN, deadline);
        const r = Number(load().read(fd, ptr(out, got), n - got));
        if (r === 0) throw new FdError("proxy closed the connection mid-handshake", "protocol");
        if (r < 0) {
          const e = load().errno();
          if (e === EINTR || e === EAGAIN) continue;
          throw new FdError(`proxy connection failed: ${errName(e)}`, "unreachable");
        }
        got += r;
      }
      return out;
    },
    write(data) {
      const buf = typeof data === "string" ? Buffer.from(data, "latin1") : data;
      const deadline = Date.now() + 15_000;
      let sent = 0;
      while (sent < buf.length) {
        const r = Number(load().write(fd, ptr(buf, sent), buf.length - sent));
        if (r < 0) {
          const e = load().errno();
          if (e === EINTR) continue;
          if (e === EAGAIN) { waitFor(fd, POLLOUT, deadline); continue; }
          throw new FdError(`proxy connection failed: ${errName(e)}`, "unreachable");
        }
        sent += r;
      }
    },
  };
}

/** Send `fd` over the unix socket `channel` (ssh's end of the socketpair) the
 *  way OpenSSH's mm_receive_fd expects: one data byte plus SCM_RIGHTS. */
export function sendFd(channel: number, fd: number): void {
  const data = Buffer.alloc(1);
  const iov = Buffer.alloc(16);
  iov.writeBigUInt64LE(BigInt(ptr(data)), 0);
  iov.writeBigUInt64LE(1n, 8);
  // cmsghdr: socklen_t len + int level + int type on macOS (12 bytes), size_t
  // len + int level + int type on Linux (16 bytes); the descriptor follows.
  const head = darwin ? 12 : 16;
  const control = Buffer.alloc(darwin ? 16 : 24);
  if (darwin) control.writeUInt32LE(head + 4, 0);
  else control.writeBigUInt64LE(BigInt(head + 4), 0);
  control.writeInt32LE(SOL_SOCKET, darwin ? 4 : 8);
  control.writeInt32LE(SCM_RIGHTS, darwin ? 8 : 12);
  control.writeInt32LE(fd, head);
  // msghdr: iovlen and controllen are int/socklen_t on macOS, size_t on Linux.
  const msg = Buffer.alloc(darwin ? 48 : 56);
  msg.writeBigUInt64LE(BigInt(ptr(iov)), 16);
  msg.writeBigUInt64LE(BigInt(ptr(control)), 32);
  if (darwin) { msg.writeInt32LE(1, 24); msg.writeUInt32LE(control.length, 40); }
  else { msg.writeBigUInt64LE(1n, 24); msg.writeBigUInt64LE(BigInt(control.length), 40); }
  for (;;) {
    const r = Number(load().sendmsg(channel, ptr(msg), 0));
    if (r === 1) return;
    const e = load().errno();
    if (r < 0 && e === EINTR) continue;
    throw new FdError(e === constants.errno.ENOTSOCK
      ? "stdout is not a socket; this ProxyCommand needs ssh -o ProxyUseFdpass=yes"
      : `cannot hand the connection to ssh: ${errName(e)}`, "protocol");
  }
}

export function closeFd(fd: number): void { load().close(fd); }
