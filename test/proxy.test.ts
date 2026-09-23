import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import net from "node:net";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lookupProxy, normalizeProxy, parseProxyUrl, proxyIdentity, redactProxy,
  resolveProxy, setActiveConfig, validateConfig,
} from "../src/config.ts";
import type { FleetConfig, Host, ProxySpec } from "../src/config.ts";
import { buildArgs, connOpts, freshConnOpts, muxOpts } from "../src/ssh.ts";
import {
  PROXY_EXIT, ProxyError, clearProxyCache, proxyCommandFor, proxyConnect, proxyConnectMain,
  argQuote, isCompiledBinary, proxyControlKey, proxyOpts, proxyPassword, proxyReachable, shQuote,
} from "../src/proxy.ts";
import { applyProxyFlags } from "../src/cli.ts";

const socks: ProxySpec = { type: "socks5", host: "192.0.2.10", port: 1080 };
const cfg: FleetConfig = {
  proxies: { vpn: socks, other: { type: "socks5", host: "10.0.0.9", port: 1080 } },
  hosts: {
    direct: { name: "direct", ssh: "box", os: "linux" },
    viaVpn: { name: "viaVpn", ssh: "box", os: "linux", proxy: "vpn" },
    viaOther: { name: "viaOther", ssh: "box", os: "linux", proxy: "other" },
    sandbox: { name: "sandbox", ssh: "sb", os: "linux", transport: "daytona", proxy: "vpn" },
  },
};
const h = (name: keyof typeof cfg.hosts) => cfg.hosts[name as string]!;
/** Each test drives resolution through an explicit env, never the real one. */
const env = (overrides: Record<string, string> = {}) => ({ ...overrides });

let saved: Record<string, string | undefined>;
beforeEach(() => {
  setActiveConfig(cfg);
  saved = {
    FLEET_PROXY: process.env.FLEET_PROXY, FLEET_NO_PROXY: process.env.FLEET_NO_PROXY,
    FLEET_PROXY_OVERRIDE: process.env.FLEET_PROXY_OVERRIDE,
  };
  for (const k of Object.keys(saved)) delete process.env[k];
  clearProxyCache();
});
afterEach(() => {
  setActiveConfig(null);
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

describe("config — proxy validation", () => {
  const valid = (patch: Partial<FleetConfig>): FleetConfig =>
    ({ hosts: { a: { name: "a", ssh: "a", os: "linux" } }, ...patch });
  const check = (patch: Partial<FleetConfig>) => () => validateConfig(valid(patch), "/cfg.json");

  test("a well-formed proxies block parses", () => {
    expect(check({ proxies: { vpn: { ...socks, user: "u", passwordEnv: "PW", dns: "remote",
      verify: { url: "https://api.ipify.org", expect: "198.51.100.7" } } },
      defaultProxy: "vpn" })).not.toThrow();
  });

  test("an unknown proxy name on a host fails by name", () =>
    expect(check({ proxies: { vpn: socks },
      hosts: { a: { name: "a", ssh: "a", os: "linux", proxy: "bar" } } }))
      .toThrow("invalid config /cfg.json: hosts.a.proxy references unknown proxy 'bar' (have: vpn)"));

  test("an unknown defaultProxy fails", () =>
    expect(check({ defaultProxy: "ghost" })).toThrow(/defaultProxy references unknown proxy 'ghost'/));

  test("unknown fields are still rejected — no loosening of knownKeys", () => {
    expect(check({ proxies: { vpn: { ...socks, password: "hunter2" } as ProxySpec } }))
      .toThrow(/proxies.vpn: unknown field 'password'/);
    expect(check({ hosts: { a: { name: "a", ssh: "a", os: "linux", nope: 1 } as unknown as Host } }))
      .toThrow(/unknown field 'nope'/);
  });

  test("type, port and dns are constrained", () => {
    expect(check({ proxies: { vpn: { ...socks, type: "socks4" as ProxySpec["type"] } } })).toThrow(/type must be one of socks5\|socks5h\|http/);
    expect(check({ proxies: { vpn: { ...socks, port: 0 } } })).toThrow(/port must be an integer 1-65535/);
    expect(check({ proxies: { vpn: { ...socks, port: 1080.5 } } })).toThrow(/port must be an integer/);
    expect(check({ proxies: { vpn: { ...socks, dns: "maybe" as ProxySpec["dns"] } } })).toThrow(/dns must be one of local\|remote/);
  });

  test("only one password source may be set", () =>
    expect(check({ proxies: { vpn: { ...socks, passwordEnv: "PW", passwordFile: "~/x.pw" } } }))
      .toThrow(/set at most one of passwordEnv \/ passwordFile/));

  test("an inline URL is accepted in place of a name", () =>
    expect(check({ hosts: { a: { name: "a", ssh: "a", os: "linux", proxy: "socks5h://u:p@1.2.3.4:1080" } } })).not.toThrow());

  test("a malformed inline URL fails WITHOUT echoing the password", () => {
    let message = "";
    try { validateConfig(valid({ hosts: { a: { name: "a", ssh: "a", os: "linux", proxy: "ftp://u:hunter2@h:21" } } }), "/cfg.json"); }
    catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/scheme must be one of/);
    expect(message).not.toContain("hunter2");
  });
});

describe("parseProxyUrl / redaction", () => {
  test("parses scheme, credentials and port", () =>
    expect(parseProxyUrl("socks5h://u:p%40ss@1.2.3.4:1081"))
      .toEqual({ type: "socks5h", host: "1.2.3.4", port: 1081, user: "u", password: "p@ss" }));

  test("defaults the port per scheme", () => {
    expect(parseProxyUrl("socks5://h").port).toBe(1080);
    expect(parseProxyUrl("http://h").port).toBe(8080);
  });

  test("socks5h normalises to socks5 + remote DNS", () =>
    expect(normalizeProxy(parseProxyUrl("socks5h://h:1080")))
      .toMatchObject({ type: "socks5", dns: "remote" }));

  test("redaction hides the password and nothing else", () => {
    expect(redactProxy("socks5h://u:hunter2@h:1080")).toBe("socks5h://u:***@h:1080");
    expect(redactProxy("plain text with no url")).toBe("plain text with no url");
  });

  test("the identity used for socket naming never carries credentials", () =>
    expect(proxyIdentity(parseProxyUrl("socks5h://u:hunter2@h:1080"))).toBe("socks5://u@h:1080/remote"));
});

describe("resolveProxy — precedence", () => {
  test("no config, no proxy → today's behaviour", () =>
    expect(resolveProxy(h("direct"), cfg, env())).toBeNull());

  test("hosts.<h>.proxy applies", () =>
    expect(resolveProxy(h("viaVpn"), cfg, env())?.name).toBe("vpn"));

  test("defaultProxy covers hosts with none of their own", () =>
    expect(resolveProxy(h("direct"), { ...cfg, defaultProxy: "other" }, env())?.name).toBe("other"));

  test("hosts.<h>.proxy beats defaultProxy", () =>
    expect(resolveProxy(h("viaVpn"), { ...cfg, defaultProxy: "other" }, env())?.name).toBe("vpn"));

  test("FLEET_PROXY beats hosts.<h>.proxy", () =>
    expect(resolveProxy(h("viaVpn"), cfg, env({ FLEET_PROXY: "other" }))?.name).toBe("other"));

  test("FLEET_NO_PROXY=1 beats FLEET_PROXY", () =>
    expect(resolveProxy(h("viaVpn"), cfg, env({ FLEET_PROXY: "other", FLEET_NO_PROXY: "1" }))).toBeNull());

  test("--proxy (FLEET_PROXY_OVERRIDE) beats the kill switch", () =>
    expect(resolveProxy(h("direct"), cfg, env({ FLEET_NO_PROXY: "1", FLEET_PROXY_OVERRIDE: "vpn" }))?.name).toBe("vpn"));

  test("daytona hosts are never proxied — the transport is HTTP, not ssh", () =>
    expect(resolveProxy(h("sandbox"), cfg, env())).toBeNull());

  test("an unknown name fails loudly rather than connecting direct", () =>
    expect(() => lookupProxy("ghost", cfg)).toThrow(/unknown proxy 'ghost' \(have: vpn, other\)/));
});

describe("applyProxyFlags", () => {
  test("--proxy is consumed and published, other flags survive in order", () => {
    const e = env();
    expect(applyProxyFlags(["--json", "--proxy", "vpn", "host", "cmd"], e)).toEqual(["--json", "host", "cmd"]);
    expect(e.FLEET_PROXY_OVERRIDE).toBe("vpn");
  });

  test("--proxy=NAME form works", () => {
    const e = env();
    applyProxyFlags(["--proxy=vpn", "host"], e);
    expect(e.FLEET_PROXY_OVERRIDE).toBe("vpn");
  });

  test("--no-proxy sets the kill switch and clears any override", () => {
    const e = env({ FLEET_PROXY: "vpn", FLEET_PROXY_OVERRIDE: "vpn" });
    expect(applyProxyFlags(["--no-proxy", "host"], e)).toEqual(["host"]);
    expect(e).toEqual({ FLEET_NO_PROXY: "1" });
  });

  test("a --proxy inside the remote command is left alone", () => {
    const e = env();
    expect(applyProxyFlags(["host", "curl", "--proxy", "x"], e)).toEqual(["host", "curl", "--proxy", "x"]);
    expect(e.FLEET_PROXY_OVERRIDE).toBeUndefined();
  });

  test("tokens after -- are never parsed", () =>
    expect(applyProxyFlags(["--", "--no-proxy"], env())).toEqual(["--", "--no-proxy"]));
});

describe("proxyOpts — the ssh argv", () => {
  const optVal = (args: string[], prefix: string) =>
    args.find((a) => a.startsWith(prefix))?.slice(prefix.length);

  test("no proxy → no ProxyCommand, exactly today's argv", () =>
    expect(proxyOpts(h("direct"))).toEqual([]));

  test("a proxied host gets a ProxyCommand naming this same fleet", () => {
    const cmd = optVal(proxyOpts(h("viaVpn")), "ProxyCommand=")!;
    expect(cmd).toContain("__proxy-connect");
    expect(cmd).toContain(argQuote("vpn"));
    expect(cmd.endsWith(" %h %p")).toBe(true);
  });

  test("only the proxy NAME crosses the process table — never the password", () => {
    process.env.FLEET_PROXY_OVERRIDE = "socks5h://u:hunter2@h:1080";
    const cmd = optVal(proxyOpts(h("direct")), "ProxyCommand=")!;
    // Even an inline URL keeps its password out of argv: it rides an env var
    // that ssh passes to the ProxyCommand, and the URL names that variable.
    expect(cmd).not.toContain("hunter2");
    expect(cmd).toMatch(/#passwordEnv=FLEET_PROXY_PW_[0-9A-F]{12}/);
    expect(proxyCommandFor(h("direct"))).not.toContain("hunter2");
  });

  test("a compiled binary re-invokes itself; from source it needs `bun <entry>`", () => {
    // Bun marks a compiled binary's entry with an embedded-fs path — `/$bunfs`
    // on POSIX and a fake `B:` drive on Windows. Missing the Windows spelling
    // emits a ProxyCommand with a phantom argument, and every proxied host then
    // reads as a plain timeout rather than a broken command.
    expect(isCompiledBinary("/usr/local/bin/fleet", "/$bunfs/root/cli.ts")).toBe(true);
    expect(isCompiledBinary("C:\\Tools\\fleet\\fleet.exe", "B:\\~BUN\\root\\fleet.exe")).toBe(true);
    expect(isCompiledBinary("C:\\Tools\\fleet\\fleet.exe", "B:/~BUN/root/fleet.exe")).toBe(true);
    expect(isCompiledBinary("/Users/x/.bun/bin/bun", "/Users/x/fleet/src/cli.ts")).toBe(false);
    expect(isCompiledBinary("C:\\Users\\x\\.bun\\bin\\bun.exe", "C:\\fleet\\src\\cli.ts")).toBe(false);
  });

  test("daytona hosts get no ProxyCommand", () =>
    expect(proxyOpts(h("sandbox"))).toEqual([]));

  test("paths are shell-quoted for the /bin/sh ssh runs ProxyCommand in", () =>
    expect(shQuote("/Applications/My Tools/fleet")).toBe("'/Applications/My Tools/fleet'"));

  test("a Windows controller gets cmd.exe quoting, not POSIX quoting", () => {
    // Win32 OpenSSH runs ProxyCommand through `cmd.exe /c`, where a single quote
    // is a literal character — POSIX quoting makes the quote part of the filename.
    expect(argQuote("C:\\Program Files\\fleet.exe", "win32")).toBe('"C:\\Program Files\\fleet.exe"');
    expect(argQuote("C:\\Users\\%USER%\\fleet.exe", "win32")).toBe('"C:\\Users\\%%USER%%\\fleet.exe"');
    expect(argQuote("/usr/bin/fleet", "linux")).toBe("'/usr/bin/fleet'");
  });

  test("ssh's own %h/%p tokens are never quoted or %-escaped", () => {
    const cmd = optVal(proxyOpts(h("viaVpn")), "ProxyCommand=")!;
    expect(cmd.endsWith(" %h %p")).toBe(true);
  });

  test("every transport carries the same options", () => {
    const { args } = buildArgs(h("viaVpn"), "true", "bash");
    expect(args.some((a) => a.startsWith("ProxyCommand="))).toBe(true);
    expect(args.slice(-2)).toEqual(["bash", "-ls"]);   // the command is still the last thing
  });
});

describe("ControlPath must encode the proxy (regression)", () => {
  const controlPath = (host: Host) => connOpts(host).find((a) => a.startsWith("ControlPath="))!;
  // Win32 OpenSSH has no unix-socket multiplexing, so there is no socket to
  // collide — the route key still has to be right for every other controller.
  const muxed = process.platform !== "win32";

  test.if(!muxed)("a Windows controller emits no control options at all", () => {
    expect(muxOpts(h("viaVpn"))).toEqual([]);
    expect(connOpts(h("viaVpn")).some((a) => a.startsWith("ProxyCommand="))).toBe(true);
  });

  test.if(muxed)("same ssh/user/port, different proxies → different sockets", () => {
    // OpenSSH's %C hashes (localhost, remotehost, port, user) and NOT the
    // ProxyCommand. Sharing a socket here means the second connection silently
    // rides the first one's route — observed live as two hosts reporting the
    // same $SSH_CLIENT source port through different proxies.
    expect(h("viaVpn").ssh).toBe(h("viaOther").ssh);
    expect(controlPath(h("viaVpn"))).not.toBe(controlPath(h("viaOther")));
  });

  test.if(muxed)("a direct host and a proxied host do not share a socket", () =>
    expect(controlPath(h("direct"))).not.toBe(controlPath(h("viaVpn"))));

  test("the key is stable and credential-free", () => {
    expect(proxyControlKey(h("viaVpn"))).toBe(proxyControlKey(h("viaVpn")));
    expect(proxyControlKey(h("viaVpn"))).toMatch(/^[0-9a-f]{8}$/);
    expect(proxyControlKey(h("direct"))).toBe("none");
  });

  test.if(muxed)("FLEET_SSH_MUX=config still routes — deferring the socket is not deferring the route", () => {
    process.env.FLEET_SSH_MUX = "config";
    try {
      expect(muxOpts(h("viaVpn"))).toEqual([]);
      expect(connOpts(h("viaVpn")).some((a) => a.startsWith("ProxyCommand="))).toBe(true);
    } finally { delete process.env.FLEET_SSH_MUX; }
  });

  test("a fresh connection keeps the proxy but reuses no master (doctor's path)", () => {
    const opts = freshConnOpts(h("viaVpn"));
    expect(opts).toContain("ControlPath=none");
    expect(opts).toContain("ControlMaster=no");
    expect(opts.some((a) => a.startsWith("ProxyCommand="))).toBe(true);
  });
});

describe("proxyPassword", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet-pw-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("reads passwordEnv", async () =>
    expect(await proxyPassword({ ...socks, passwordEnv: "PW" }, { PW: "s3cret" })).toBe("s3cret"));

  test("an unset passwordEnv is an auth failure, not a silent anonymous connect", async () =>
    expect(proxyPassword({ ...socks, passwordEnv: "PW" }, {})).rejects.toThrow(/PW is unset/));

  test("reads the first line of passwordFile", async () => {
    const file = join(dir, "x.pw");
    writeFileSync(file, "s3cret\n# comment\n"); chmodSync(file, 0o600);
    expect(await proxyPassword({ ...socks, passwordFile: file })).toBe("s3cret");
  });

  test("a world-readable passwordFile warns but still connects", async () => {
    const file = join(dir, "loose.pw");
    writeFileSync(file, "s3cret\n"); chmodSync(file, 0o644);
    const warnings: string[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => { warnings.push(a.join(" ")); };
    try { expect(await proxyPassword({ ...socks, passwordFile: file })).toBe("s3cret"); }
    finally { console.error = real; }
    expect(warnings.join("\n")).toMatch(/readable by other users/);
  });

  test("a missing passwordFile fails by path", async () =>
    expect(proxyPassword({ ...socks, passwordFile: join(dir, "nope.pw") })).rejects.toThrow(/passwordFile not found/));
});

// ── a real SOCKS5 server, so the handshake is tested rather than described ───

interface FakeProxy { port: number; requests: { host: string; port: number }[]; close: () => void }
/** Minimal RFC 1928 server: optional user/pass auth, CONNECT to an echo target. */
function startSocks5(opts: { user?: string; pass?: string; replyCode?: number; echo?: boolean } = {}): Promise<FakeProxy> {
  const requests: { host: string; port: number }[] = [];
  const server = net.createServer((sock) => {
    let stage: "greet" | "auth" | "request" | "tunnel" = "greet";
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      if (stage === "tunnel") { sock.write(chunk); return; }   // echo back
      buf = Buffer.concat([buf, chunk as Buffer]);
      if (stage === "greet") {
        const n = buf[1]!;
        if (buf.length < 2 + n) return;
        const methods = [...buf.subarray(2, 2 + n)];
        buf = buf.subarray(2 + n);
        const wantAuth = !!opts.user;
        if (wantAuth && !methods.includes(2)) { sock.end(Buffer.from([5, 0xff])); return; }
        sock.write(Buffer.from([5, wantAuth ? 2 : 0]));
        stage = wantAuth ? "auth" : "request";
      }
      if (stage === "auth") {
        if (buf.length < 2) return;
        const ulen = buf[1]!;
        if (buf.length < 2 + ulen + 1) return;
        const plen = buf[2 + ulen]!;
        if (buf.length < 3 + ulen + plen) return;
        const user = buf.subarray(2, 2 + ulen).toString();
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        const ok = user === opts.user && pass === opts.pass;
        sock.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) { sock.end(); return; }
        stage = "request";
      }
      if (stage === "request") {
        if (buf.length < 5) return;
        const atyp = buf[3]!;
        const alen = atyp === 1 ? 4 : atyp === 4 ? 16 : buf[4]!;
        const start = atyp === 3 ? 5 : 4;
        if (buf.length < start + alen + 2) return;
        const addr = atyp === 3 ? buf.subarray(start, start + alen).toString()
          : [...buf.subarray(start, start + alen)].join(".");
        requests.push({ host: addr, port: buf.readUInt16BE(start + alen) });
        buf = buf.subarray(start + alen + 2);
        const code = opts.replyCode ?? 0;
        sock.write(Buffer.concat([Buffer.from([5, code, 0, 1, 0, 0, 0, 0]), Buffer.from([0, 0])]));
        if (code !== 0) { sock.end(); return; }
        stage = "tunnel";
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    port: (server.address() as net.AddressInfo).port, requests,
    close: () => server.close(),
  })));
}

const drain = (socket: net.Socket, n: number) => new Promise<string>((resolve) => {
  let out = "";
  socket.on("data", (c) => { out += c.toString(); if (out.length >= n) resolve(out); });
});

describe("SOCKS5 client", () => {
  test("anonymous CONNECT tunnels bytes both ways", async () => {
    const proxy = await startSocks5();
    try {
      const sock = await proxyConnect({ type: "socks5", host: "127.0.0.1", port: proxy.port }, "example.test", 22);
      sock.write("SSH-2.0-fleet\n");
      expect(await drain(sock, 14)).toBe("SSH-2.0-fleet\n");
      sock.destroy();
    } finally { proxy.close(); }
  });

  test("dns:remote sends the HOSTNAME — no local resolver leak", async () => {
    const proxy = await startSocks5();
    try {
      const sock = await proxyConnect({ type: "socks5h", host: "127.0.0.1", port: proxy.port }, "secret.internal", 22);
      sock.destroy();
      expect(proxy.requests[0]).toEqual({ host: "secret.internal", port: 22 });
    } finally { proxy.close(); }
  });

  test("dns:local resolves before connecting, so the proxy sees an IP", async () => {
    const proxy = await startSocks5();
    try {
      const sock = await proxyConnect({ type: "socks5", host: "127.0.0.1", port: proxy.port, dns: "local" }, "localhost", 22);
      sock.destroy();
      expect(proxy.requests[0]!.host).not.toBe("localhost");   // an address, not the name
    } finally { proxy.close(); }
  });

  test("username/password auth succeeds", async () => {
    const proxy = await startSocks5({ user: "u", pass: "s3cret" });
    try {
      const sock = await proxyConnect({ type: "socks5", host: "127.0.0.1", port: proxy.port, user: "u", password: "s3cret" }, "h", 22);
      sock.destroy();
      expect(proxy.requests.length).toBe(1);
    } finally { proxy.close(); }
  });

  test("a rejected password exits 'auth', not 'host unreachable'", async () => {
    const proxy = await startSocks5({ user: "u", pass: "s3cret" });
    try {
      const attempt = proxyConnect({ type: "socks5", host: "127.0.0.1", port: proxy.port, user: "u", password: "wrong" }, "h", 22);
      await expect(attempt).rejects.toThrow(/rejected the username\/password/);
      await attempt.catch((e) => expect((e as ProxyError).code).toBe(PROXY_EXIT.auth));
    } finally { proxy.close(); }
  });

  test("a refusing destination is attributed to the destination", async () => {
    const proxy = await startSocks5({ replyCode: 5 });
    try {
      const attempt = proxyConnect({ type: "socks5", host: "127.0.0.1", port: proxy.port }, "h", 22);
      await expect(attempt).rejects.toThrow(/the destination refused the connection/);
      await attempt.catch((e) => expect((e as ProxyError).code).toBe(PROXY_EXIT.refused));
    } finally { proxy.close(); }
  });

  test("a dead proxy is reported as a dead PROXY", async () => {
    const attempt = proxyConnect({ type: "socks5", host: "127.0.0.1", port: 1 }, "h", 22, 1500);
    await expect(attempt).rejects.toThrow(/unreachable/);
    await attempt.catch((e) => expect((e as ProxyError).code).toBe(PROXY_EXIT.unreachable));
    expect(await proxyReachable({ type: "socks5", host: "127.0.0.1", port: 1 }, 1500)).toBe(false);
  });
});

describe("__proxy-connect", () => {
  test("bad usage exits without touching the network", async () => {
    expect(await proxyConnectMain([])).toBe(PROXY_EXIT.usage);
    expect(await proxyConnectMain(["vpn", "h", "notaport"])).toBe(PROXY_EXIT.usage);
  });

  test("an unknown proxy name exits usage rather than connecting direct", async () =>
    expect(await proxyConnectMain(["ghost", "h", "22"])).toBe(PROXY_EXIT.usage));

  test("a dead proxy exits with the proxy code", async () => {
    setActiveConfig({ ...cfg, proxies: { dead: { type: "socks5", host: "127.0.0.1", port: 1 } } });
    expect(await proxyConnectMain(["dead", "h", "22"])).toBe(PROXY_EXIT.unreachable);
  });

  test("end to end: the subcommand splices ssh's stdio onto the tunnel", async () => {
    const proxy = await startSocks5();
    setActiveConfig({ ...cfg, proxies: { local: { type: "socks5", host: "127.0.0.1", port: proxy.port } } });
    const fleet = [process.execPath, ...(Bun.main.startsWith("/$bunfs") ? [] : [join(import.meta.dir, "..", "src", "cli.ts")])];
    const child = Bun.spawn([...fleet, "__proxy-connect", "local", "example.test", "22"], {
      env: { ...process.env, FLEET_CONFIG: writeConfig(proxy.port) },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write("SSH-2.0-fleet\n"); await child.stdin.flush();
    const reader = child.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe("SSH-2.0-fleet\n");
    await reader.cancel().catch(() => {});
    child.kill();
    await child.exited;
    expect(proxy.requests[0]).toEqual({ host: "example.test", port: 22 });
    proxy.close();
  });
});

let cfgDir: string | undefined;
function writeConfig(port: number): string {
  cfgDir ??= mkdtempSync(join(tmpdir(), "fleet-proxy-cfg-"));
  const path = join(cfgDir, "fleet.config.json");
  writeFileSync(path, JSON.stringify({
    proxies: { local: { type: "socks5", host: "127.0.0.1", port } },
    hosts: { box: { ssh: "box", os: "linux", proxy: "local" } },
  }));
  return path;
}

describe("inline proxy credentials stay out of argv", () => {
  test("an inline URL's password moves into the environment ssh hands its ProxyCommand", async () => {
    const { argvRef } = await import("../src/proxy.ts");
    const { parseProxyUrl } = await import("../src/config.ts");
    const env: Record<string, string | undefined> = {};
    const ref = argvRef("socks5h://alice:s3cr%40t@proxy.example:1080", env);
    expect(ref).not.toContain("s3cr");
    const [key, value] = Object.entries(env)[0]!;
    expect(value).toBe("s3cr@t");
    expect(ref).toContain(`#passwordEnv=${key}`);
    const spec = parseProxyUrl(ref);
    expect(spec).toMatchObject({ user: "alice", host: "proxy.example", port: 1080, passwordEnv: key });
    expect(spec.password).toBeUndefined();
  });

  test("a named proxy or a URL without a password passes through untouched", async () => {
    const { argvRef } = await import("../src/proxy.ts");
    const env: Record<string, string | undefined> = {};
    expect(argvRef("vpn", env)).toBe("vpn");
    expect(argvRef("socks5h://proxy.example:1080", env)).toBe("socks5h://proxy.example:1080");
    expect(Object.keys(env)).toEqual([]);
  });

  test("curl config values escape quotes and backslashes", async () => {
    const { curlQuote } = await import("../src/proxy.ts");
    expect(curlQuote('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
  });
});
