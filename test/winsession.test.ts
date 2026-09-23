import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sessionLoopScript, trySessionExec, winSessionEnabled, winSessionSocket } from "../src/winsession.ts";
import type { Host } from "../src/config.ts";

const win: Host = { name: "w", ssh: "w", os: "windows" };

test("the session is for Windows hosts only, and off in tests or when FLEET_WIN_SESSION=0", () => {
  expect(winSessionEnabled(win, {})).toBe(process.platform !== "win32");
  expect(winSessionEnabled(win, { FLEET_WIN_SESSION: "0" })).toBe(false);
  expect(winSessionEnabled(win, { NODE_ENV: "test" })).toBe(false);
  expect(winSessionEnabled({ ...win, os: "linux" }, {})).toBe(false);
});

test("the status capture is single-quoted, so PowerShell cannot expand $? before the program runs", () => {
  const loop = sessionLoopScript();
  expect(loop).toContain(`'$global:__fleetOk = $?; $global:__fleetLast = $global:LASTEXITCODE; $global:__fleetFell = $true'`);
  expect(loop).not.toContain(`"$__fleetOk`);
});

test("programs run as a script file, so exit ends only the program", () => {
  const loop = sessionLoopScript();
  expect(loop).toContain("& $__fsFile");
  expect(loop).not.toContain("[scriptblock]::Create");
});

test("children get NUL as stdin, and each call starts from the session's first directory", () => {
  const loop = sessionLoopScript();
  expect(loop).toContain("SetStdHandle(-10");
  // A non-inheritable NUL handle broke every Python subprocess started inside the session.
  expect(loop).toContain("SetHandleInformation($__fsNul.SafeFileHandle.DangerousGetHandle(), 1, 1)");
  expect(loop).toContain("Set-Location -LiteralPath $__fsHome");
});

test("each host route gets its own socket", () => {
  expect(winSessionSocket(win)).not.toBe(winSessionSocket({ ...win, ssh: "other" }));
  expect(winSessionSocket(win)).toMatch(/\.fleet\/ws-[0-9a-f]{16}\.sock$/);
});

test("a lost reply after the broker accepted a request cannot trigger one-shot replay", async () => {
  const host = { ...win, ssh: `fake-${crypto.randomUUID()}` };
  // The real broker creates ~/.fleet before listening; a fresh CI home has none.
  mkdirSync(dirname(winSessionSocket(host)), { recursive: true, mode: 0o700 });
  const server = Bun.listen<{ received: boolean }>({
    unix: winSessionSocket(host),
    socket: {
      open(sock) { sock.data = { received: false }; },
      data(sock, chunk) {
        if (sock.data.received || !chunk.includes(10)) return;
        sock.data.received = true;
        sock.end("{truncated");
      },
    },
  });
  try {
    const reply = await trySessionExec(host, "'must-run-once'", 1000);
    expect(reply).toBeDefined();
    expect(reply?.busy).not.toBe(true);
    expect(reply?.code).not.toBe(0);
    expect(reply?.stderr).toContain("status is unknown");
  } finally {
    server.stop(true);
  }
});
