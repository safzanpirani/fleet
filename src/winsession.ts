/**
 * A kept-open PowerShell session per Windows host.
 *
 * Every one-shot Windows exec pays for ssh session setup plus a fresh pwsh,
 * about 0.6 s on a LAN host. A pwsh that stays open answers a PowerShell call
 * in tens of milliseconds. A local broker process (`fleet __win-session <host>`)
 * holds that pwsh over its own ssh connection and serves requests on a unix
 * socket. `exec` asks the broker first and falls back to the one-shot path when
 * the broker is missing, starting, or busy, so no call ever waits on it.
 *
 * Isolation between calls: each program runs in a child scope, from the
 * session's starting directory, with environment variables restored afterwards.
 * `$global:` state and imported modules persist. Each program runs as a script
 * file, so `exit N` ends only the program and reports N exactly. A timeout
 * ends the session; the next call starts a new one.
 *
 * Children get NUL as stdin. The session reads requests from its own stdin
 * handle, so a native program that reads stdin (findstr, cua-driver) would
 * otherwise swallow the requests that follow.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host } from "./config.ts";
import { fleetReinvocation, proxyOpts } from "./proxy.ts";

const READY = "__FLEET_SESSION_READY__";
const PIPE_PROBE = "__FLEET_PIPE__";

/** Remove the pipeline probe the session prints before its end marker. Its
 *  absence means the program's pipeline output never reached stdout. */
export function takePipeProbe(stdout: string, end: string): { stdout: string; probed: boolean } {
  const at = stdout.lastIndexOf(PIPE_PROBE + end);
  if (at < 0 || (at > 0 && stdout[at - 1] !== "\n")) return { stdout, probed: false };
  return { stdout: stdout.slice(0, at), probed: true };
}
const IDLE_MS = Math.max(10_000, Number(process.env.FLEET_WIN_SESSION_IDLE_S ?? 600) * 1000 || 600_000);

/** The pwsh program the session runs. Each request is the end marker on its
 *  own line, the base64 program in lines of at most 2000 characters, and a
 *  blank line. After the program, the session writes the
 *  end marker plus the exit status to stdout AND stderr, so the broker knows
 *  both streams are complete. */
export function sessionLoopScript(): string {
  // TODO(review): global functions and imported modules persist; decide whether full runspace isolation is required.
  return `$ErrorActionPreference = 'Continue'
try { $PSStyle.OutputRendering = 'PlainText' } catch {}
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -Namespace FleetSession -Name Std -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool SetStdHandle(int n, System.IntPtr h); [DllImport("kernel32.dll")] public static extern bool SetHandleInformation(System.IntPtr h, int mask, int flags);'
$__fsReader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))
$__fsNul = [System.IO.File]::Open('NUL', 'Open', 'Read')
# Children inherit stdin by handle value, so NUL must be inheritable, or a
# child that duplicates its stdin (Python's subprocess) gets "handle is invalid".
[void][FleetSession.Std]::SetHandleInformation($__fsNul.SafeFileHandle.DangerousGetHandle(), 1, 1)
[void][FleetSession.Std]::SetStdHandle(-10, $__fsNul.SafeFileHandle.DangerousGetHandle())
$__fsHome = (Get-Location).Path
$__fsFile = Join-Path ([IO.Path]::GetTempPath()) ('fleet-session-' + $PID + '.ps1')
$__fsEnv = @{}; Get-ChildItem env: | ForEach-Object { $__fsEnv[$_.Name] = $_.Value }
[Console]::Out.WriteLine('${READY}'); [Console]::Out.Flush()
while ($null -ne ($__fsLine = $__fsReader.ReadLine())) {
  if (-not $__fsLine) { continue }
  # A request is its end marker on one line, then the base64 program in short
  # lines, then a blank line: a single line near 8 KB never arrived whole.
  $__fsEnd = $__fsLine.Trim()
  $__fsB64 = New-Object System.Text.StringBuilder
  while ($null -ne ($__fsChunk = $__fsReader.ReadLine()) -and $__fsChunk) { [void]$__fsB64.Append($__fsChunk) }
  $__fsSrc = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($__fsB64.ToString())) + "\`n" + '$global:__fleetOk = $?; $global:__fleetLast = $global:LASTEXITCODE; $global:__fleetFell = $true'
  # A script file, not a scriptblock: \`exit N\` in a script file ends only that
  # script and sets $LASTEXITCODE, so the program cannot end the session.
  [System.IO.File]::WriteAllText($__fsFile, $__fsSrc)
  Set-Location -LiteralPath $__fsHome
  $global:LASTEXITCODE = 0
  $global:__fleetFell = $false
  $script:__fsCode = 1
  $__fsGlobals = @{}; Get-Variable -Scope Global | Where-Object Name -NotLike '__fs*' | ForEach-Object { $__fsGlobals[$_.Name] = $_.Value }
  try {
    & $__fsFile
    $script:__fsCode = if (-not $global:__fleetFell) { if ($null -ne $global:LASTEXITCODE) { $global:LASTEXITCODE } else { 0 } }
      elseif ($global:__fleetOk) { 0 } elseif ($global:__fleetLast) { $global:__fleetLast } else { 1 }
  } catch {
    [Console]::Error.WriteLine(($_ | Out-String).TrimEnd())
    $script:__fsCode = 1
  }
  # Sent the way program output travels (the pipeline), unlike the end markers.
  # Its absence means the session lost this call's output.
  '${PIPE_PROBE}' + $__fsEnd
  foreach ($__fsVar in @(Get-Variable -Scope Global)) {
    if ($__fsVar.Name -notlike '__fs*' -and -not $__fsGlobals.ContainsKey($__fsVar.Name)) { Remove-Variable -Name $__fsVar.Name -Scope Global -EA SilentlyContinue }
  }
  foreach ($__fsName in $__fsGlobals.Keys) {
    Set-Variable -Name $__fsName -Value $__fsGlobals[$__fsName] -Scope Global -EA SilentlyContinue
  }
  Remove-Item -LiteralPath $__fsFile -Force -EA SilentlyContinue
  foreach ($__fsVar in @(Get-ChildItem env:)) {
    if (-not $__fsEnv.ContainsKey($__fsVar.Name)) { Remove-Item -LiteralPath ('env:' + $__fsVar.Name) -EA SilentlyContinue }
  }
  foreach ($__fsName in $__fsEnv.Keys) {
    if ([Environment]::GetEnvironmentVariable($__fsName) -ne $__fsEnv[$__fsName]) { [Environment]::SetEnvironmentVariable($__fsName, $__fsEnv[$__fsName]) }
  }
  [Console]::Out.WriteLine($__fsEnd + $script:__fsCode); [Console]::Out.Flush()
  [Console]::Error.WriteLine($__fsEnd + $script:__fsCode); [Console]::Error.Flush()
}`;
}

/** The session is on unless turned off, and never inside tests or on a
 *  Windows controller (no unix sockets there). */
export function winSessionEnabled(host: Host, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FLEET_WIN_SESSION === "0" || env.NODE_ENV === "test") return false;
  if (process.platform === "win32") return false;
  return host.os === "windows" && host.transport !== "daytona";
}

/** One socket per host route and per session program, so a fleet upgrade that
 *  changes the program never talks to an old broker. */
export function winSessionSocket(host: Host): string {
  const key = createHash("sha256")
    .update(JSON.stringify([host.ssh, host.proxy ?? null, sessionLoopScript()]))
    .digest("hex").slice(0, 16);
  return join(homedir(), ".fleet", `ws-${key}.sock`);
}

export interface SessionReply {
  busy?: boolean;
  stdout: string;
  stderr: string;
  code: number;
  timedOut?: boolean;
  /** The program ended the session (`exit`), so its status is pwsh's. */
  ended?: boolean;
}

const lostReply = (): SessionReply => ({ stdout: "", stderr: "fleet: Windows session connection lost after request; execution status is unknown", code: 1 });

/** How long a broker gets to accept the connection. Nothing has been sent
 *  before it does, so falling back after this is always safe. */
const OPEN_TIMEOUT_MS = 1500;

/** Ask the host's broker to run a PowerShell program. Returns undefined when
 *  there is no broker (and starts one for later calls), it is busy, or it does
 *  not accept in time; the caller then runs the program the one-shot way. */
export async function trySessionExec(
  host: Host, program: string, timeoutMs: number,
): Promise<SessionReply | undefined> {
  const path = winSessionSocket(host);
  const chunks: Buffer[] = [];
  let pending: Uint8Array | undefined;
  let abandoned = false;
  let socket: import("bun").Socket<undefined> | undefined;
  const send = (sock: import("bun").Socket<undefined>) => {
    if (!pending) return;
    const n = sock.write(pending);
    pending = n < pending.length ? pending.subarray(Math.max(0, n)) : undefined;
  };
  let settle: (v: SessionReply | undefined) => void = () => {};
  const result = new Promise<SessionReply | undefined>((resolve) => { settle = resolve; });
  let opened: (v: "open" | "absent") => void = () => {};
  const openState = new Promise<"open" | "absent">((resolve) => { opened = resolve; });
  Bun.connect({
    unix: path,
    socket: {
      open(sock) {
        // A connection that opens after the caller gave up must not run anything.
        if (abandoned) { sock.end(); return; }
        socket = sock;
        opened("open");
        // A socket write can take only part of a large request; the rest goes
        // out as the socket drains.
        pending = new TextEncoder().encode(JSON.stringify({ program, timeoutMs }) + "\n");
        send(sock);
      },
      drain(sock) { send(sock); },
      data(_sock, chunk) { chunks.push(Buffer.from(chunk)); },
      close() {
        // Decode once at the end: a character split across chunks survives.
        try { settle(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { settle(lostReply()); }
      },
      error() { settle(lostReply()); },
      connectError() { opened("absent"); settle(undefined); },
    },
  }).catch(() => { opened("absent"); settle(lostReply()); });

  let openTimer: ReturnType<typeof setTimeout> | undefined;
  const state = await Promise.race([openState,
    new Promise<"slow">((resolve) => { openTimer = setTimeout(() => resolve("slow"), OPEN_TIMEOUT_MS); })]);
  clearTimeout(openTimer);
  if (state !== "open") {
    abandoned = true;
    socket?.terminate();
    if (state === "absent") startBroker(host);
    return undefined;
  }
  // The broker enforces the program's timeout; this bounds a broker that
  // stopped answering. The program may have run, so this is an error, not a
  // silent fallback that could run it twice.
  // TODO(review): define heartbeat policy for a frozen broker when timeoutMs is zero.
  const deadline = timeoutMs > 0 ? timeoutMs + 5_000 : 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<SessionReply>((resolve) => {
    if (deadline > 0) timer = setTimeout(() => resolve({
      stdout: "", stderr: "fleet: the Windows session stopped answering", code: 124, timedOut: true }), deadline);
  });
  const r = await Promise.race([result, stalled]);
  if (timer) clearTimeout(timer);
  // A stalled broker's socket would otherwise keep this process alive.
  if (r?.timedOut) socket?.terminate();
  // Only an explicit busy reply proves the broker did not run the program.
  // A truncated or lost reply after open must never trigger a second run.
  return r?.busy ? undefined : (r ?? lostReply());
}

function startBroker(host: Host): void {
  try {
    const proc = Bun.spawn([...fleetReinvocation(), "__win-session", host.name], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
      detached: true,
      env: { ...process.env, FLEET_WIN_SESSION: "0" },
    });
    proc.unref();
  } catch { /* the one-shot path still works */ }
}

/** The broker: owns one pwsh session for `host` and serves one request at a
 *  time. Exits after IDLE_MS without a request. Returns false when another
 *  broker already serves the host. */
export async function runWinSessionBroker(host: Host): Promise<boolean> {
  const path = winSessionSocket(host);
  mkdirSync(join(homedir(), ".fleet"), { recursive: true, mode: 0o700 });
  // A socket file left by a dead broker blocks listen. A live broker answers
  // this connect, and then this one bows out.
  const alive = await new Promise<boolean>((resolve) => {
    Bun.connect({ unix: path, socket: {
      open(s) { s.end(); resolve(true); }, data() {}, error() { resolve(false); }, connectError() { resolve(false); },
    } }).catch(() => resolve(false));
  });
  if (alive) return false;
  // TODO(review): use an atomic owner lock; simultaneous starters can unlink a fresh socket.
  rmSync(path, { force: true });

  let session: Session | undefined;
  let starting: Promise<Session> | undefined;
  let busy = false;
  let activeReplies = 0;
  let idle: ReturnType<typeof setTimeout>;
  const armIdle = () => {
    clearTimeout(idle);
    if (!busy && activeReplies === 0) idle = setTimeout(shutdown, IDLE_MS);
  };
  // TODO(review): verify remote pwsh teardown after local broker SIGKILL on supported hosts.
  const shutdown = () => { session?.kill(); server.stop(true); rmSync(path, { force: true }); process.exit(0); };
  const ensure = async () => {
    if (session && !session.dead) return session;
    if (!starting) starting = Session.start(host);
    try { session = await starting; return session; }
    finally { starting = undefined; }
  };

  // A socket write can take only part of a large reply; the rest goes out as
  // the socket drains, and only then does the socket close.
  const flush = (sock: import("bun").Socket<{ buf: string; replyPending?: boolean; out?: Uint8Array }>) => {
    const out = sock.data.out;
    if (!out) return;
    const n = sock.write(out);
    sock.data.out = n < out.length ? out.subarray(Math.max(0, n)) : undefined;
    if (!sock.data.out) sock.end();
  };
  const reply = (sock: import("bun").Socket<{ buf: string; replyPending?: boolean; out?: Uint8Array }>, body: object) => {
    if (!sock.data.replyPending) { sock.data.replyPending = true; activeReplies++; }
    clearTimeout(idle);
    sock.data.out = new TextEncoder().encode(JSON.stringify(body));
    flush(sock);
  };
  const BUSY = { busy: true, stdout: "", stderr: "", code: 0 };

  const server = Bun.listen<{ buf: string; decoder: TextDecoder; handled: boolean; replyPending?: boolean; out?: Uint8Array }>({
    unix: path,
    socket: {
      open(sock) { sock.data = { buf: "", decoder: new TextDecoder(), handled: false }; },
      close(sock) {
        if (sock.data.replyPending) { activeReplies--; armIdle(); }
      },
      drain(sock) { flush(sock); },
      async data(sock, chunk) {
        if (sock.data.handled) return;
        sock.data.buf += sock.data.decoder.decode(chunk, { stream: true });
        const nl = sock.data.buf.indexOf("\n");
        if (nl < 0) return;
        sock.data.handled = true;
        let req: { program: string; timeoutMs: number };
        try { req = JSON.parse(sock.data.buf.slice(0, nl)); } catch { sock.end(); return; }
        if (busy) { reply(sock, BUSY); return; }
        busy = true;
        clearTimeout(idle);
        const acceptedAt = Date.now();
        try {
          // A session that cannot start has run nothing, so the caller may
          // safely fall back to the one-shot path.
          let s: Session;
          try { s = await ensure(); } catch { reply(sock, BUSY); return; }
          const left = req.timeoutMs > 0 ? req.timeoutMs - (Date.now() - acceptedAt) : 0;
          if (req.timeoutMs > 0 && left <= 0) {
            reply(sock, { stdout: "", stderr: "", code: 124, timedOut: true });
            return;
          }
          try { reply(sock, await s.run(req.program, left)); }
          catch { s.kill(); reply(sock, lostReply()); }
        } finally {
          busy = false;
          armIdle();
        }
      },
    },
  });
  armIdle();
  process.on("SIGTERM", shutdown);
  // Warm the session now, so the call after the one that started the broker is fast.
  ensure().catch(() => {});
  return true;
}

class Session {
  dead = false;
  private out = "";
  private err = "";
  private waiters: (() => void)[] = [];
  private constructor(private proc: ReturnType<typeof Bun.spawn>) {}

  static async start(host: Host): Promise<Session> {
    const encoded = Buffer.from(sessionLoopScript(), "utf16le").toString("base64");
    // Its own connection, not the shared control master: killing this ssh must
    // close the channel, so a timed-out program dies with its session.
    const proc = Bun.spawn(["ssh", ...proxyOpts(host), "-o", "ControlMaster=no", "-o", "ControlPath=none",
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30", host.ssh,
      "pwsh", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", encoded],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const s = new Session(proc);
    s.pump(proc.stdout as ReadableStream<Uint8Array>, "out");
    s.pump(proc.stderr as ReadableStream<Uint8Array>, "err");
    proc.exited.then(() => { s.dead = true; s.wake(); });
    const ready = await s.until(() => s.out.includes(READY) || s.dead, 20_000);
    if (!ready || s.dead) { s.kill(); throw new Error("session did not start"); }
    s.out = s.out.slice(s.out.indexOf(READY) + READY.length).replace(/^\r?\n/, "");
    return s;
  }

  private async pump(stream: ReadableStream<Uint8Array>, which: "out" | "err") {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        this[which] += decoder.decode(chunk, { stream: true });
        this.wake();
      }
      this[which] += decoder.decode();
    } catch { /* process exit wakes the request below */ } finally {
      // The loop needs both streams; EOF on either means it cannot complete
      // another request even if a child keeps the ssh process alive.
      this.kill();
      this.wake();
    }
  }
  private wake() { for (const w of this.waiters.splice(0)) w(); }
  private until(done: () => boolean, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = ms > 0 ? setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== check);
        resolve(false);
      }, ms) : undefined;
      const check = () => {
        if (done()) { if (timer) clearTimeout(timer); resolve(true); }
        else this.waiters.push(check);
      };
      check();
    });
  }

  kill() { this.dead = true; try { this.proc.kill("SIGKILL"); } catch {} this.wake(); }

  async run(program: string, timeoutMs: number): Promise<SessionReply> {
    const end = `__FLEET_END_${crypto.randomUUID().replaceAll("-", "")}__`;
    // TODO(review): inherited output handles from a detached child can write after its marker into the next call.
    this.out = ""; this.err = "";
    const sink = this.proc.stdin as import("bun").FileSink;
    const b64 = Buffer.from(program, "utf8").toString("base64");
    sink.write(`${end}\n${(b64.match(/.{1,2000}/g) ?? []).join("\n")}\n\n`);
    sink.flush();
    const re = new RegExp(`${end}(-?\\d+)\\r?\\n`);
    const finished = await this.until(() => (re.test(this.out) && re.test(this.err)) || this.dead, timeoutMs);
    if (!finished) {
      const { out, err } = this;
      this.kill();
      return { stdout: out, stderr: err, code: 124, timedOut: true };
    }
    const mo = re.exec(this.out), me = re.exec(this.err);
    if (!mo || !me) {
      // The session died mid-program ([Environment]::Exit, a crash). A child it
      // started can hold the ssh channel open, so do not wait on it for long.
      const code = await Promise.race([this.proc.exited, Bun.sleep(2000).then(() => null)]);
      this.kill();
      return { stdout: this.out, stderr: this.err, code: typeof code === "number" ? code : 1, ended: true };
    }
    // Errors name the session's temp file; the caller only knows "its script".
    const stderr = this.err.slice(0, me.index).replace(/[A-Za-z]:\\[^\r\n:]*?fleet-session-\d+\.ps1/g, "script");
    const { stdout, probed } = takePipeProbe(this.out.slice(0, mo.index), end);
    if (!probed) {
      // Seen once on a long-lived session: every later call returned empty
      // stdout with exit 0. Fail this call and start a fresh session; the
      // program already ran, so it is never replayed.
      this.kill();
      return { stdout, code: Number(mo[1]) || 1,
        stderr: [stderr, "fleet: the Windows session lost this program's PowerShell output; "
          + "the session was restarted, so run the command again if you need its output"].filter(Boolean).join("\n") };
    }
    return { stdout, stderr, code: Number(mo[1]) };
  }
}
