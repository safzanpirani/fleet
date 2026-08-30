import { test, expect, describe, spyOn } from "bun:test";
import { jobLog, jobTail, killScript, resolveJobRef, parseRows, newId, unixSpawnScript, waitPoll } from "../src/jobs.ts";
import * as ssh from "../src/ssh.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const host = (name: string, os: Host["os"]): Host => ({ name, ssh: name, os });
const cfg: FleetConfig = {
  hosts: { oracle: host("oracle", "linux"), maints: host("maints", "windows") },
  groups: { cloud: ["oracle", "maints"] },
};

describe("resolveJobRef", () => {
  test("two-arg form: host + id", () => {
    const { host, id } = resolveJobRef(cfg, "oracle", "abc123-xy");
    expect(host.name).toBe("oracle");
    expect(id).toBe("abc123-xy");
  });

  test("collapsed host:id form", () => {
    const { host, id } = resolveJobRef(cfg, "oracle:abc123-xy");
    expect(host.name).toBe("oracle");
    expect(id).toBe("abc123-xy");
  });

  test("collapsed Daytona ref splits the job id at the last colon", () => {
    const { host, id } = resolveJobRef(cfg, "dt:sandbox-123:abc123-xy");
    expect(host).toMatchObject({ name: "dt:sandbox-123", ssh: "sandbox-123", transport: "daytona" });
    expect(id).toBe("abc123-xy");
  });

  test("label-prefixed id (contains hyphens) round-trips", () =>
    expect(resolveJobRef(cfg, "oracle:my-train-mr0g-rzgy").id).toBe("my-train-mr0g-rzgy"));

  test("missing id throws usage", () =>
    expect(() => resolveJobRef(cfg, "oracle")).toThrow(/usage:/));

  test("id outside [a-z0-9-] is rejected (path-injection guard)", () => {
    expect(() => resolveJobRef(cfg, "oracle", "../etc")).toThrow(/bad job id/);
    expect(() => resolveJobRef(cfg, "oracle", "a b")).toThrow(/bad job id/);
    expect(() => resolveJobRef(cfg, "oracle:$(whoami)")).toThrow(/bad job id/);
  });

  test("a selector that resolves to >1 host is rejected", () =>
    expect(() => resolveJobRef(cfg, "@cloud:abc")).toThrow(/exactly one host/));
});

describe("parseRows", () => {
  test("parses a well-formed row", () => {
    const [r] = parseRows("oracle", "id1\trunning\t-\t4242\t1700000000\techo hi");
    expect(r).toEqual({
      host: "oracle", id: "id1", status: "running",
      code: null, pid: 4242, started: 1700000000, cmd: "echo hi",
    });
  });

  test("exited row carries the exit code; '-' fields become null", () => {
    const [r] = parseRows("oracle", "id2\texited\t0\t-\t-\tdone");
    expect(r!.status).toBe("exited");
    expect(r!.code).toBe(0);
    expect(r!.pid).toBeNull();
    expect(r!.started).toBeNull();
  });

  test("strips trailing CR (windows CRLF output)", () =>
    expect(parseRows("maints", "id3\texited\t1\t100\t1700\tcmd\r")[0]!.cmd).toBe("cmd"));

  test("a command containing tabs is preserved (rejoined)", () =>
    expect(parseRows("oracle", "id4\trunning\t-\t1\t2\ta\tb\tc")[0]!.cmd).toBe("a\tb\tc"));

  test("blank lines are skipped", () =>
    expect(parseRows("oracle", "\nid5\trunning\t-\t1\t2\tx\n\n").length).toBe(1));

  test("an unrecognised status token degrades to 'dead', never garbage", () =>
    expect(parseRows("oracle", "id6\tWARNING: whatever\t-\t1\t2\tx")[0]!.status).toBe("dead"));

  test("non-numeric code/pid/started become null, not NaN", () => {
    const [r] = parseRows("oracle", "id7\texited\tabc\txyz\tnope\tx");
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
    const script = killScript(host("maints", "windows"), "job-123");
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
      expect(await jobLog(cfg, "oracle", id)).toEqual({ host: "oracle", output: "" });
      expect(await jobTail(cfg, "oracle", id, 10)).toEqual({ host: "oracle", output: "" });
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
      await expect(jobLog(cfg, "oracle", "missing-job")).rejects.toThrow("fleet: no such job: missing-job");
      await expect(jobTail(cfg, "oracle", "missing-job", 10)).rejects.toThrow("fleet: no such job: missing-job");
    } finally {
      execSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Windows log and tail scripts fail a missing spool but allow a missing output file", async () => {
    const execSpy = spyOn(ssh, "exec").mockResolvedValue({
      host: "maints", ok: true, code: 0, stdout: "", stderr: "",
    });
    try {
      await jobLog(cfg, "maints", "windows-job");
      await jobTail(cfg, "maints", "windows-job", 10);
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
      host: "oracle", ok: false, code: 255, stdout: "", stderr: "",
    });
    try {
      await expect(jobLog(cfg, "oracle", "failed-job")).rejects.toThrow(
        "failed to read job failed-job output (exit 255)",
      );
      await expect(jobTail(cfg, "oracle", "failed-job", 10)).rejects.toThrow(
        "failed to tail job failed-job output (exit 255)",
      );
    } finally {
      execSpy.mockRestore();
    }
  });
});

describe("detached job lifecycle", () => {
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
