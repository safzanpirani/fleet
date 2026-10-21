import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimBroker, sessionLoopScript } from "../src/winsession.ts";

const modulePath = new URL("../src/winsession.ts", import.meta.url).pathname;
const host = { name: "fixture", ssh: "fixture", os: "windows" };
// These integration conditions live in separate OS processes; fake timers cannot
// drive process death, pipe EOF or the Windows descendant's inherited handles.
async function until(done: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!done()) {
    if (Date.now() >= deadline) throw new Error("fixture did not settle");
    await Bun.sleep(10);
  }
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test.skipIf(process.platform === "win32")("concurrent starters share one lifetime lock, released after SIGKILL", async () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-lock-"));
  const path = join(root, "broker.sock");
  const code = `import { claimBroker } from ${JSON.stringify(modulePath)};
const release = claimBroker(${JSON.stringify(path)});
console.log(release ? 'owner' : 'busy');
if (!release) process.exit(0);
await Bun.stdin.text();`;
  const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "-e", code], {
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
  }));
  try {
    const replies = await Promise.all(children.map(async (child) => {
      const reader = child.stdout.getReader();
      const chunk = await reader.read();
      reader.releaseLock();
      return new TextDecoder().decode(chunk.value).trim();
    }));
    expect(replies.filter((reply) => reply === "owner")).toHaveLength(1);
    expect(replies.filter((reply) => reply === "busy")).toHaveLength(7);
    expect(claimBroker(path)).toBeUndefined();
    const owner = children[replies.indexOf("owner")]!;
    owner.kill("SIGKILL");
    await owner.exited;
    const release = claimBroker(path);
    expect(release).toBeDefined();
    release?.();
    expect(existsSync(path + ".lock")).toBe(true);
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("broker SIGKILL closes its pipe and the surviving transport kills busy ssh", async () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-transport-"));
  const sshPid = join(root, "ssh-pid");
  const transportPid = join(root, "transport-pid");
  const received = join(root, "received");
  writeFileSync(join(root, "ssh"), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
writeFileSync(process.env.FLEET_TEST_SSH_PID, String(process.pid));
for await (const chunk of Bun.stdin.stream()) writeFileSync(process.env.FLEET_TEST_RECEIVED, chunk);
\n`, { mode: 0o700 });
  const transport = `import { writeFileSync } from 'node:fs';
import { runWinSessionTransport } from ${JSON.stringify(modulePath)};
writeFileSync(${JSON.stringify(transportPid)}, String(process.pid));
process.exit(await runWinSessionTransport(${JSON.stringify(host)}));`;
  const parent = `const child = Bun.spawn([process.execPath, '-e', ${JSON.stringify(transport)}], {
stdin: 'pipe', stdout: 'ignore', stderr: 'inherit', env: process.env });
child.stdin.write('busy-program\\n'); await child.stdin.flush();
await child.exited;`;
  const broker = Bun.spawn([process.execPath, "-e", parent], {
    stdin: "ignore", stdout: "ignore", stderr: "inherit",
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, FLEET_TEST_SSH_PID: sshPid, FLEET_TEST_RECEIVED: received },
  });
  try {
    await until(() => existsSync(received));
    expect(readFileSync(received, "utf8")).toBe("busy-program\n");
    const ssh = Number(readFileSync(sshPid, "utf8"));
    const guardian = Number(readFileSync(transportPid, "utf8"));
    broker.kill("SIGKILL");
    await broker.exited;
    await until(() => !alive(ssh) && !alive(guardian));
  } finally {
    broker.kill("SIGKILL");
    await broker.exited;
    for (const file of [sshPid, transportPid]) {
      if (existsSync(file)) {
        const pid = Number(readFileSync(file, "utf8"));
        if (alive(pid)) process.kill(pid, "SIGKILL");
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("a Windows call keeps native output in order and late descendants out", async () => {
  const proc = Bun.spawn(["pwsh", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(sessionLoopScript(), "utf16le").toString("base64")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let out = "", err = "";
  const pump = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
  };
  const pumps = [pump(proc.stdout, (text) => { out += text; }), pump(proc.stderr, (text) => { err += text; })];
  const send = async (end: string, program: string) => {
    proc.stdin.write(`${end}\n${Buffer.from(program).toString("base64")}\n\n`);
    await proc.stdin.flush();
    await until(() => out.includes(`${end}0\n`) || out.includes(`${end}0\r\n`));
    await until(() => err.includes(`${end}0\n`) || err.includes(`${end}0\r\n`));
  };
  try {
    await until(() => out.includes("__FLEET_SESSION_READY__"));
    const child = Buffer.from("Start-Sleep -Milliseconds 300; [Console]::Out.WriteLine('late-out'); [Console]::Error.WriteLine('late-err')", "utf16le").toString("base64");
    await send("__FLEET_END_first__", `[Console]::Out.WriteLine('first'); Start-Process -FilePath (Get-Process -Id $PID).Path -NoNewWindow -ArgumentList '-NoProfile','-EncodedCommand','${child}'`);
    const boundary = out.length, errorBoundary = err.length;
    await send("__FLEET_END_second__", "Start-Sleep -Milliseconds 700; [Console]::Out.WriteLine('second'); 'formatted'");
    expect(out.slice(boundary)).toContain("second");
    expect(out.slice(boundary)).toContain("formatted");
    expect(out.slice(boundary)).not.toContain("late-out");
    expect(err.slice(errorBoundary)).not.toContain("late-err");
    // Native children, [Console]::Out, Write-Host and formatted output all
    // reach one file; each keeps its place and none overwrites another.
    const third = out.length;
    await send("__FLEET_END_third__", "'formatted-1'; [Console]::Out.WriteLine('direct-1'); cmd /c echo native-1; Write-Host host-1; 'formatted-2'");
    expect(out.slice(third)).toMatch(/formatted-1\s+direct-1\s+native-1\s+host-1\s+formatted-2/);
  } finally {
    proc.kill("SIGKILL");
    await proc.exited;
    await Promise.all(pumps);
  }
});
