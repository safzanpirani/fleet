import { test, expect, describe, spyOn } from "bun:test";
import { jobLog, jobTail, killScript, listJobs, pruneJobs, resolveJobRef, parseRows, newId, spawnJob, unixSpawnScript, waitJob, waitPoll } from "../src/jobs.ts";
import * as ssh from "../src/ssh.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const host = (name: string, os: Host["os"]): Host => ({ name, ssh: name, os });
const cfg: FleetConfig = {
  hosts: { web: host("web", "linux"), winbox: host("winbox", "windows") },
  groups: { cloud: ["web", "winbox"] },
};

describe("resolveJobRef", () => {
  test("two-arg form: host + id", () => {
    const { host, id } = resolveJobRef(cfg, "web", "abc123-xy");
    expect(host.name).toBe("web");
    expect(id).toBe("abc123-xy");
  });

  test("collapsed host:id form", () => {
    const { host, id } = resolveJobRef(cfg, "web:abc123-xy");
    expect(host.name).toBe("web");
    expect(id).toBe("abc123-xy");
  });

  test("collapsed Daytona ref splits the job id at the last colon", () => {
    const { host, id } = resolveJobRef(cfg, "dt:sandbox-123:abc123-xy");
    expect(host).toMatchObject({ name: "dt:sandbox-123", ssh: "sandbox-123", transport: "daytona" });
    expect(id).toBe("abc123-xy");
  });

  test("label-prefixed id (contains hyphens) round-trips", () =>
    expect(resolveJobRef(cfg, "web:my-train-mr0g-rzgy").id).toBe("my-train-mr0g-rzgy"));

  test("missing id throws usage", () =>
    expect(() => resolveJobRef(cfg, "web")).toThrow(/usage:/));

  test("id outside [a-z0-9-] is rejected (path-injection guard)", () => {
    expect(() => resolveJobRef(cfg, "web", "../etc")).toThrow(/bad job id/);
    expect(() => resolveJobRef(cfg, "web", "a b")).toThrow(/bad job id/);
    expect(() => resolveJobRef(cfg, "web:$(whoami)")).toThrow(/bad job id/);
  });

  test("a selector that resolves to >1 host is rejected", () =>
    expect(() => resolveJobRef(cfg, "@cloud:abc")).toThrow(/exactly one host/));
});

describe("parseRows", () => {
  test("parses a well-formed row", () => {
    const [r] = parseRows("web", "id1\trunning\t-\t4242\t1700000000\techo hi");
    expect(r).toEqual({
      host: "web", id: "id1", status: "running",
      code: null, pid: 4242, started: 1700000000, cmd: "echo hi",
    });
  });

  test("exited row carries the exit code; '-' fields become null", () => {
    const [r] = parseRows("web", "id2\texited\t0\t-\t-\tdone");
    expect(r!.status).toBe("exited");
    expect(r!.code).toBe(0);
    expect(r!.pid).toBeNull();
    expect(r!.started).toBeNull();
  });

  test("strips trailing CR (windows CRLF output)", () =>
    expect(parseRows("winbox", "id3\texited\t1\t100\t1700\tcmd\r")[0]!.cmd).toBe("cmd"));

  test("a command containing tabs is preserved (rejoined)", () =>
    expect(parseRows("web", "id4\trunning\t-\t1\t2\ta\tb\tc")[0]!.cmd).toBe("a\tb\tc"));

  test("blank lines are skipped", () =>
    expect(parseRows("web", "\nid5\trunning\t-\t1\t2\tx\n\n").length).toBe(1));

  test("an unrecognised status token degrades to 'dead', never garbage", () =>
    expect(parseRows("web", "id6\tWARNING: whatever\t-\t1\t2\tx")[0]!.status).toBe("dead"));

  test("non-numeric code/pid/started become null, not NaN", () => {
    const [r] = parseRows("web", "id7\texited\tabc\txyz\tnope\tx");
    expect(r!.code).toBeNull();
    expect(r!.pid).toBeNull();
    expect(r!.started).toBeNull();
  });
});

describe("newId", () => {
  test("bare id matches the safe charset and is time-sortable shape", () =>
    expect(newId()).toMatch(/^[a-z0-9]+-[a-z0-9]{4}$/));

  test("label is slugged onto the front, kept in the id charset", () => {
    expect(newId("My Train Run!")).toMatch(/^my-train-run-[a-z0-9]+-[a-z0-9]{4}$/);
    expect(newId("../../etc")).toMatch(/^etc-[a-z0-9]+-[a-z0-9]{4}$/);   // dangerous chars stripped
  });

  test("an all-junk label degrades to a bare id (never empty/unsafe)", () =>
    expect(newId("!!!")).toMatch(/^[a-z0-9]+-[a-z0-9]{4}$/));
});

describe("killScript", () => {
  test("Windows diagnostic delimits the pid variable before a colon", () => {
    const script = killScript(host("winbox", "windows"), "job-123");
    expect(script).toContain("pid $($jpid): it is not job job-123");
    expect(script).not.toContain("pid $jpid:");
  });
});

async function runBash(script: string, home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash"], {
    env: { ...process.env, HOME: home },
    stdin: new TextEncoder().encode(script),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("job log and tail", () => {
  test("an existing POSIX job with no output returns an empty result", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-job-empty-"));
    const id = "empty-job";
    mkdirSync(join(home, ".fleet", "jobs", id), { recursive: true });
    const execSpy = spyOn(ssh, "exec").mockImplementation(async (remoteHost, script) => {
      const result = await runBash(script, home);
      return { host: remoteHost.name, ok: result.code === 0, ...result };
    });
    try {
      expect(await jobLog(cfg, "web", id)).toEqual({ host: "web", output: "" });
      expect(await jobTail(cfg, "web", id, 10)).toEqual({ host: "web", output: "" });
    } finally {
      execSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a missing POSIX job fails log and tail explicitly", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-job-missing-"));
    const execSpy = spyOn(ssh, "exec").mockImplementation(async (remoteHost, script) => {
      const result = await runBash(script, home);
      return { host: remoteHost.name, ok: result.code === 0, ...result };
    });
    try {
      await expect(jobLog(cfg, "web", "missing-job")).rejects.toThrow("fleet: no such job: missing-job");
      await expect(jobTail(cfg, "web", "missing-job", 10)).rejects.toThrow("fleet: no such job: missing-job");
    } finally {
      execSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Windows log and tail scripts fail a missing spool but allow a missing output file", async () => {
    const execSpy = spyOn(ssh, "exec").mockResolvedValue({
      host: "winbox", ok: true, code: 0, stdout: "", stderr: "",
    });
    try {
      await jobLog(cfg, "winbox", "windows-job");
      await jobTail(cfg, "winbox", "windows-job", 10);
      for (const call of execSpy.mock.calls) {
        const script = call[1];
        expect(script).toContain("Test-Path -LiteralPath $d -PathType Container");
        expect(script).toContain("fleet: no such job: windows-job");
        expect(script).toContain("exit 1");
        expect(script).toContain("Test-Path -LiteralPath $o -PathType Leaf");
      }
    } finally {
      execSpy.mockRestore();
    }
  });

  test("log and tail throw a useful fallback for every failed exec", async () => {
    const execSpy = spyOn(ssh, "exec").mockResolvedValue({
      host: "web", ok: false, code: 255, stdout: "", stderr: "",
    });
    try {
      await expect(jobLog(cfg, "web", "failed-job")).rejects.toThrow(
        "failed to read job failed-job output (exit 255)",
      );
      await expect(jobTail(cfg, "web", "failed-job", 10)).rejects.toThrow(
        "failed to tail job failed-job output (exit 255)",
      );
    } finally {
      execSpy.mockRestore();
    }
  });
});

describe("detached job lifecycle", () => {
  test("list and prune preserve a live macOS job spool", async () => {
    const fixtureHome = mkdtempSync(join(tmpdir(), "fleet-job-live-prune-"));
    const local = host("local", "mac");
    const fixtureConfig: FleetConfig = { hosts: { local }, groups: {} };
    const dir = join(fixtureHome, ".fleet", "jobs", "live-job");
    const execSpy = spyOn(ssh, "exec").mockImplementation(async (h, script) => {
      const r = await runBash(script, fixtureHome);
      return { host: h.name, ok: r.code === 0, ...r };
    });
    try {
      const launch = await runBash(unixSpawnScript(local, "live-job",
        'for i in {1..100}; do [ -f "$HOME/release" ] && break; sleep 0.05; done'), fixtureHome);
      expect(launch.code, launch.stderr).toBe(0);
      expect(await listJobs(fixtureConfig, "local")).toMatchObject([{ id: "live-job", status: "running" }]);
      expect(await pruneJobs(fixtureConfig, "local", true)).toEqual([{ host: "local", removed: 0 }]);
      expect(await Bun.file(join(dir, "run")).exists()).toBe(true);
      expect(() => process.kill(Number(readFileSync(join(dir, "pid"), "utf8")), 0)).not.toThrow();
    } finally {
      execSpy.mockRestore();
      writeFileSync(join(fixtureHome, "release"), "");
      for (let i = 0; i < 200 && !Bun.file(join(dir, "exit")).size; i++) await Bun.sleep(10);
      rmSync(fixtureHome, { recursive: true, force: true });
    }
  });

  test("macOS kill escalates against resistant descendants after their runner exits", async () => {
    const fixtureHome = mkdtempSync(join(tmpdir(), "fleet-job-kill-tree-"));
    const local = host("local", "mac");
    const dir = join(fixtureHome, ".fleet", "jobs", "resistant-job");
    const unrelated = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const pids: number[] = [];
    const running = async (pid: number) => {
      const ps = Bun.spawn(["ps", "-p", String(pid), "-o", "stat="], { stdout: "pipe", stderr: "ignore" });
      const state = (await new Response(ps.stdout).text()).trim();
      await ps.exited;
      return state !== "" && !state.includes("Z");
    };
    try {
      const launch = await runBash(unixSpawnScript(local, "resistant-job",
        'trap "" TERM\necho $$ > "$HOME/workload-pid"\nsleep 30 &\necho $! > "$HOME/leaf-pid"\nwait'), fixtureHome);
      expect(launch.code, launch.stderr).toBe(0);
      pids.push(Number(readFileSync(join(dir, "pid"), "utf8")));
      for (let i = 0; i < 100 && !Bun.file(join(fixtureHome, "leaf-pid")).size; i++) await Bun.sleep(10);
      pids.push(Number(readFileSync(join(fixtureHome, "workload-pid"), "utf8")),
        Number(readFileSync(join(fixtureHome, "leaf-pid"), "utf8")));
      const killed = await runBash(killScript(local, "resistant-job"), fixtureHome);
      expect(killed.code, killed.stderr).toBe(0);
      for (const pid of pids) expect(await running(pid)).toBe(false);
      // Preserve a runner exit record if TERM completed its immediate shell;
      // escalation still has to remove the resistant descendants.
      expect(["137", "143"]).toContain(readFileSync(join(dir, "exit"), "utf8").trim());
      expect(await running(unrelated.pid)).toBe(true);
    } finally {
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      unrelated.kill();
      await unrelated.exited;
      rmSync(fixtureHome, { recursive: true, force: true });
    }
  }, 15_000);

  test("unconfirmed launches retain each attempted id and never retry", async () => {
    const attempts: string[] = [];
    const results = await spawnJob(cfg, "@cloud", "echo fixture", {}, {
      newId: () => "attempt-id",
      exec: async (h) => {
        attempts.push(h.name);
        if (h.os === "windows") throw new Error("transport disconnected");
        return { host: h.name, ok: false, code: 255, stdout: "", stderr: "connection lost" };
      },
    });
    expect(attempts).toEqual(["web", "winbox"]);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r).toMatchObject({ ok: false, id: "attempt-id", pid: null });
      expect(r.error).toContain("inspect this job before retrying");
    }
  });

  test("spawn does not accept another job's acknowledgement", async () => {
    const [r] = await spawnJob(cfg, "web", "echo fixture", {}, {
      newId: () => "expected-id",
      exec: async () => ({ host: "web", ok: true, code: 0, stdout: "OK other-id 123\n", stderr: "" }),
    });
    expect(r).toMatchObject({ ok: false, id: "expected-id" });
  });

  test("wait detects a dead runner without mistaking a reused PID for ownership", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-job-dead-"));
    const sleeper = Bun.spawn(["sleep", "10"], { stdout: "ignore", stderr: "ignore" });
    const id = "dead-runner";
    const dir = join(home, ".fleet", "jobs", id);
    let inspections = 0;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pid"), String(sleeper.pid));
      const result = await waitJob(cfg, "web", id, { intervalMs: 1, timeoutMs: 1000 }, {
        exec: async (h, script) => {
          inspections++;
          const r = await runBash(script, home);
          return { host: h.name, ok: r.code === 0, ...r };
        },
      });
      expect(result).toMatchObject({ outcome: "dead", code: null });
      expect(inspections).toBe(3);
      expect(() => process.kill(sleeper.pid, 0)).not.toThrow();
      expect(await Bun.file(join(dir, "exit")).exists()).toBe(false);
    } finally {
      sleeper.kill();
      await sleeper.exited;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("wait permits an exit record to arrive after a dead observation", async () => {
    const outputs = ["DEAD\n", "EXIT:7\n"];
    const result = await waitJob(cfg, "web:race", undefined, { intervalMs: 1 }, {
      exec: async () => ({ host: "web", ok: true, code: 0, stdout: outputs.shift()!, stderr: "" }),
    });
    expect(result).toMatchObject({ outcome: "exited", code: 7 });
  });

  test("wait validates timing and does not retry permanent poll failures", async () => {
    for (const opts of [{ timeoutMs: NaN }, { timeoutMs: -1 }, { intervalMs: 0 }, { intervalMs: Infinity }])
      await expect(waitJob(cfg, "web:bad", undefined, opts)).rejects.toThrow("must be a finite");
    let calls = 0;
    await expect(waitJob(cfg, "web:regex", undefined, {}, {
      exec: async () => {
        calls++;
        return { host: "web", ok: false, code: 2, stdout: "", stderr: "invalid --until regex" };
      },
    })).rejects.toThrow("invalid --until regex");
    expect(calls).toBe(1);
  });

  test("a deadline preserves the remote job and a new wait observes completion", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-job-resume-"));
    const id = "resume-job";
    const dir = join(home, ".fleet", "jobs", id);
    const inspect: typeof ssh.exec = async (h, script) => {
      const r = await runBash(script, home);
      return { host: h.name, ok: r.code === 0, ...r };
    };
    try {
      const launch = await runBash("umask 022\n" + unixSpawnScript(host("local", "mac"), id,
        'for i in {1..100}; do [ -f "$HOME/release" ] && break; sleep 0.05; done; touch "$HOME/artifact"; printf done; exit 7'), home);
      expect(launch.code, launch.stderr).toBe(0);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "cmd")).mode & 0o777).toBe(0o600);
      const first = await waitJob(cfg, "web", id, { timeoutMs: 60, intervalMs: 10 }, { exec: inspect });
      expect(first.outcome).toBe("timeout");
      expect(await Bun.file(join(dir, "exit")).exists()).toBe(false);
      writeFileSync(join(home, "release"), "");
      const second = await waitJob(cfg, "web", id, { timeoutMs: 2000, intervalMs: 10 }, { exec: inspect });
      expect(second).toMatchObject({ outcome: "exited", code: 7 });
      expect(readFileSync(join(dir, "out"), "utf8")).toBe("done");
      expect(statSync(join(dir, "out")).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, "artifact")).mode & 0o777).toBe(0o644);
    } finally {
      writeFileSync(join(home, "release"), "");
      // Finish the bounded fixture runner before removing its spool.
      for (let i = 0; i < 100 && !Bun.file(join(dir, "exit")).size; i++) await Bun.sleep(10);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a regex beginning with a dash is data, not a grep option", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-job-dash-"));
    try {
      const dir = join(home, ".fleet", "jobs", "dash-regex");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "out"), "--ready\n");
      const r = await runBash(waitPoll(host("local", "mac"), "dash-regex", "--ready"), home);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain("MATCH");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  test("Linux launch stamps an ownership marker for runner command-line changes", () => {
    const script = unixSpawnScript(host("web", "linux"), "owned-job", "true");
    expect(script).toContain('FLEET_JOB_ID="$id" setsid');
  });

  test("wait retries transient inspection failures", async () => {
    const execSpy = spyOn(ssh, "exec")
      .mockResolvedValueOnce({ host: "web", ok: false, code: 255, stdout: "", stderr: "connection reset" })
      .mockResolvedValueOnce({ host: "web", ok: true, code: 0, stdout: "EXIT:0\n", stderr: "" });
    try {
      const result = await waitJob(cfg, "web:retry-job", undefined, { intervalMs: 1 });
      expect(result).toMatchObject({ outcome: "exited", code: 0 });
      expect(execSpy).toHaveBeenCalledTimes(2);
    } finally {
      execSpy.mockRestore();
    }
  });

  test("wait tolerates brief spool visibility delay", async () => {
    const execSpy = spyOn(ssh, "exec")
      .mockResolvedValueOnce({ host: "web", ok: true, code: 0, stdout: "MISSING\n", stderr: "" })
      .mockResolvedValueOnce({ host: "web", ok: true, code: 0, stdout: "EXIT:7\n", stderr: "" });
    try {
      const result = await waitJob(cfg, "web:late-spool", undefined, { intervalMs: 1 });
      expect(result).toMatchObject({ outcome: "exited", code: 7 });
    } finally {
      execSpy.mockRestore();
    }
  });

  test("macOS launch uses nohup, records the runner pid, and really completes", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-job-home-"));
    const mac = host("mac", "mac");
    const id = "mac-real-job";
    try {
      const launched = await runBash(unixSpawnScript(mac, id, "printf 'done\\n'; exit 7"), home);
      expect(launched.code, launched.stderr).toBe(0);
      expect(launched.stdout).toMatch(/^OK mac-real-job \d+/);
      const dir = join(home, ".fleet", "jobs", id);
      for (let i = 0; i < 100 && !Bun.file(join(dir, "exit")).size; i++) await Bun.sleep(10);
      expect(readFileSync(join(dir, "out"), "utf8")).toBe("done\n");
      expect(readFileSync(join(dir, "exit"), "utf8").trim()).toBe("7");
      expect(unixSpawnScript(mac, "another", "true")).toContain('nohup "$dir/run"');
      expect(unixSpawnScript(mac, "another", "true")).not.toContain('setsid "$dir/run"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("kill refuses a live pid whose command line is not this job's runner", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-job-owner-"));
    const sleeper = Bun.spawn(["sleep", "10"], { stdout: "ignore", stderr: "ignore" });
    const id = "reused-pid";
    const dir = join(home, ".fleet", "jobs", id);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pid"), String(sleeper.pid));
      writeFileSync(join(dir, "run"), "#!/bin/bash\n");
      const result = await runBash(killScript(host("linux", "linux"), id), home);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("refusing to kill");
      expect(() => process.kill(sleeper.pid, 0)).not.toThrow();
    } finally {
      sleeper.kill();
      await sleeper.exited;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("spawn expands a leading ~ in --cwd and records a missing cwd in the job output", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-job-cwd-"));
    const mac = host("mac", "mac");
    try {
      mkdirSync(join(home, "work"), { recursive: true });
      const ok = await runBash(unixSpawnScript(mac, "tilde-cwd", "pwd", "~/work"), home);
      expect(ok.code, ok.stderr).toBe(0);
      const okDir = join(home, ".fleet", "jobs", "tilde-cwd");
      for (let i = 0; i < 100 && !Bun.file(join(okDir, "exit")).size; i++) await Bun.sleep(10);
      expect(readFileSync(join(okDir, "cwd"), "utf8")).toBe(join(home, "work"));
      expect(readFileSync(join(okDir, "exit"), "utf8").trim()).toBe("0");

      const bad = await runBash(unixSpawnScript(mac, "missing-cwd", "pwd", "~/nope"), home);
      expect(bad.code, bad.stderr).toBe(0);
      const badDir = join(home, ".fleet", "jobs", "missing-cwd");
      for (let i = 0; i < 100 && !Bun.file(join(badDir, "exit")).size; i++) await Bun.sleep(10);
      expect(readFileSync(join(badDir, "exit"), "utf8").trim()).toBe("127");
      expect(readFileSync(join(badDir, "out"), "utf8")).toContain("cwd not found: " + join(home, "nope"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("polling a still-running job without --until exits 0 with no verdict", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-job-running-"));
    const id = "still-running";
    const dir = join(home, ".fleet", "jobs", id);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "out"), "starting\n");
      const plain = await runBash(waitPoll(host("linux", "linux"), id), home);
      expect(plain.code, plain.stderr).toBe(0);
      expect(plain.stdout).not.toMatch(/EXIT:|MISSING|MATCH/);
      const until = await runBash(waitPoll(host("linux", "linux"), id, "never"), home);
      expect(until.code, until.stderr).toBe(0);
      expect(until.stdout).not.toMatch(/EXIT:|MISSING|MATCH/);
      writeFileSync(join(dir, "exit"), "3\n");
      const done = await runBash(waitPoll(host("linux", "linux"), id), home);
      expect(done.code).toBe(0);
      expect(done.stdout).toContain("EXIT:3");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an invalid --until regex fails the poll instead of spinning", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-job-regex-"));
    const id = "bad-regex";
    const dir = join(home, ".fleet", "jobs", id);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "out"), "hello\n");
      const result = await runBash(waitPoll(host("linux", "linux"), id, "["), home);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("invalid --until regex");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
