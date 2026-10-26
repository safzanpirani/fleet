import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { FleetConfig, FleetPolicy, Host } from "../src/config.ts";
import { sessionRefusal, winSessionEnabled } from "../src/winsession.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const winsession = join(import.meta.dir, "../src/winsession.ts");
const win: Host = { name: "win", ssh: "win.invalid", os: "windows", winShell: "pwsh" };
const policy = (body: Partial<FleetPolicy>): FleetPolicy => ({ path: "/test/policy.json", disable: [], hosts: {}, ...body });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "fleet-wsgate-"));
  roots.push(root);
  return root;
}

interface Fixture {
  home: string;
  bin: string;
  config: string;
  sshCalls(): string[];
  brokerLocks(): string[];
}

/** A controller home, a config whose `win` host refuses exec, and an `ssh` on
 *  PATH that logs its argv instead of connecting anywhere. */
function fixture(): Fixture {
  const root = tempRoot();
  const home = join(root, "home"), bin = join(root, "bin"), log = join(root, "ssh.log");
  mkdirSync(home); mkdirSync(bin);
  const config = join(root, "fleet.config.json");
  writeFileSync(config, JSON.stringify({ hosts: { win: { ssh: win.ssh, os: "windows", winShell: "pwsh", disable: ["exec"] } } }));
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncat >/dev/null\nexit 0\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  return {
    home, bin, config,
    sshCalls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
    brokerLocks: () => existsSync(join(home, ".fleet")) ? readdirSync(join(home, ".fleet")).filter((f) => /^ws-.*\.lock$/.test(f)) : [],
  };
}

async function runCli(f: Fixture, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", cli, ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, HOME: f.home, FLEET_CONFIG: f.config, PATH: `${f.bin}${delimiter}${process.env.PATH ?? ""}`, FLEET_NO_SSH_MUX: "1", ...env },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  // A wrongly started broker or transport serves until idle or stdin EOF;
  // kill it inside bun's 5 s test timeout so the test fails instead of hanging.
  const deadline = setTimeout(() => proc.kill("SIGKILL"), 4_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(deadline);
  return { stdout, stderr, code };
}

describe.skipIf(process.platform === "win32")("the Windows session obeys the exec gate", () => {
  test("the hidden transport refuses an exec-disabled host before it starts ssh", async () => {
    const f = fixture();
    const r = await runCli(f, ["__win-session-transport", "win"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("exec is disabled on win");
    expect(f.sshCalls()).toEqual([]);
  });

  test("the hidden broker refuses an exec-disabled host before it claims a socket or starts a session", async () => {
    const f = fixture();
    const r = await runCli(f, ["__win-session", "win"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("exec is disabled on win");
    expect(f.brokerLocks()).toEqual([]);
    expect(f.sshCalls()).toEqual([]);
  });

  test("a read-only command on an exec-disabled Windows host runs one-shot and starts no broker", async () => {
    const f = fixture();
    // NODE_ENV=test would turn the session off by itself; clear it so the gate decides.
    await runCli(f, ["which", "git", "win"], { NODE_ENV: "", FLEET_WIN_SESSION_IDLE_S: "1" });
    // A broker would start detached after the call returns, so there is no
    // event to await for its absence; give one time to appear.
    await Bun.sleep(1500);
    expect(f.brokerLocks()).toEqual([]);
    expect(f.sshCalls().length).toBeGreaterThan(0);
    expect(f.sshCalls().filter((argv) => argv.includes("-EncodedCommand"))).toEqual([]);
  });

  test("routing: no session when the config or the policy refuses exec", () => {
    const cfg: FleetConfig = { hosts: { win } };
    expect(winSessionEnabled(win, {}, cfg, null)).toBe(true);
    expect(winSessionEnabled({ ...win, disable: ["exec"] }, {}, cfg, null)).toBe(false);
    expect(winSessionEnabled(win, {}, { ...cfg, disable: ["exec"] }, null)).toBe(false);
    expect(winSessionEnabled(win, {}, cfg, policy({ hosts: { [win.ssh]: { disable: ["exec"] } } }))).toBe(false);
    expect(winSessionEnabled(win, {}, cfg, policy({ error: "bad json" }))).toBe(false);
  });

  test("an invalid policy file fails closed for the session", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "policy.json"), "{ not json");
    expect(await sessionRefusal(win, null, join(root, "policy.json"))).toMatch(/exec is disabled on win by the fleet policy file .*invalid/);
    expect(await sessionRefusal(win, null, join(root, "missing.json"))).toBeUndefined();
  });

  test("a running broker refuses requests once the policy refuses exec, without running them", async () => {
    const root = tempRoot();
    const socket = join(root, "b.sock"), policyFile = join(root, "policy.json"), runs = join(root, "runs");
    const script = join(root, "broker.ts");
    writeFileSync(script, `import { appendFileSync } from "node:fs";
import { runWinSessionBroker } from ${JSON.stringify(winsession)};
const ok = await runWinSessionBroker(${JSON.stringify(win)}, {
  socket: ${JSON.stringify(socket)}, policyFile: ${JSON.stringify(policyFile)},
  startSession: async () => ({
    dead: false,
    async run(program) { appendFileSync(${JSON.stringify(runs)}, "run " + program + "\\n"); return { stdout: "ran", stderr: "", code: 0 }; },
    kill() { this.dead = true; appendFileSync(${JSON.stringify(runs)}, "kill\\n"); },
  }),
});
console.log(ok ? "ready" : "taken");
`);
    // The broker exits on its own only after idling; the test kills it.
    const child = Bun.spawn(["bun", script], {
      env: { ...process.env, HOME: root, FLEET_WIN_SESSION_IDLE_S: "60" }, stdout: "pipe", stderr: "inherit", stdin: "ignore",
    });
    const ask = (program: string): Promise<Record<string, unknown>> => {
      const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
      const chunks: Buffer[] = [];
      Bun.connect({ unix: socket, socket: {
        open(sock) { sock.write(JSON.stringify({ program, timeoutMs: 5000 }) + "\n"); },
        data(_sock, chunk) { chunks.push(Buffer.from(chunk)); },
        close() { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); },
        connectError(_sock, error) { reject(error); },
      } }).catch(reject);
      return promise;
    };
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("ready");
      reader.releaseLock();
      expect(await ask("first")).toMatchObject({ stdout: "ran", code: 0 });
      // Root refuses exec for the box by its ssh destination.
      writeFileSync(policyFile, JSON.stringify({ hosts: { [win.ssh]: { disable: ["exec"] } } }));
      const refused = await ask("second");
      expect(refused).toMatchObject({ busy: true, code: 1 });
      expect(String(refused.stderr)).toContain("exec is disabled on win by the fleet policy file");
      expect(readFileSync(runs, "utf8").trim().split("\n")).toEqual(["run first", "kill"]);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });
});
