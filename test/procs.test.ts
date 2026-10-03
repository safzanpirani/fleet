import { describe, expect, test } from "bun:test";
import type { FleetConfig, Host } from "../src/config.ts";
import type { ExecResult } from "../src/ssh.ts";
import {
  etimeSeconds, parsePosixList, parseWindowsList, resolveKill, parseKillOutput, processList, processKill,
} from "../src/procs.ts";
import type { ProcRow } from "../src/procs.ts";

const S = "__FLEET_PS__";
const lin: Host = { name: "lin", ssh: "lin", os: "linux" };
const mac: Host = { name: "mac", ssh: "mac", os: "mac" };
const win: Host = { name: "win", ssh: "win", os: "windows" };
const cfg: FleetConfig = { hosts: { lin, mac, win } };

// ps -o pid=,ppid=,pcpu=,rss=,etime=,user=,comm=  then  ps -o pid=,args=
const linuxOut = [
  `${S}chain| 900 899 800`,
  `${S}job|build-abc|500`,
  `${S}job|stale-xyz|700`,
  `${S}ps`,
  `    1     0  0.0  1024 5-01:00:00 root     systemd`,
  `  500     1  0.0  2048    01:00 alice    run`,
  `  501   500 50.5 204800    00:59 alice    node`,
  `  502   501 10.0 10240    00:30 alice    node`,
  `  600     1  1.0  4096 2-00:00:00 alice    python3`,
  `  601     1  2.0  4096    10:00 alice    python3`,
  `  700     1  0.0  1024    00:05 bob      nginx`,
  `  800     1  0.0  1024    00:05 root     sshd`,
  `  899   800  0.0  1024    00:01 alice    bash`,
  `  900   899  0.0  1024    00:01 alice    bash`,
  `${S}args`,
  `    1 /sbin/init`,
  `  500 /bin/bash /home/alice/.fleet/jobs/build-abc/run`,
  `  501 node server.js --port 3000`,
  `  502 node worker.js`,
  `  600 python3 train.py`,
  `  601 python3 eval.py`,
  `  700 nginx: master process`,
  `  800 sshd: alice [priv]`,
  `  899 bash -ls`,
  `  900 bash -ls`,
  `${S}end`,
].join("\n");

const ok = (stdout: string): ExecResult => ({ host: "x", ok: true, code: 0, stdout, stderr: "" });

describe("parsing", () => {
  test("etime covers seconds, hours and days", () => {
    expect(etimeSeconds("00:59")).toBe(59);
    expect(etimeSeconds("01:02:03")).toBe(3723);
    expect(etimeSeconds("2-00:00:01")).toBe(172801);
    expect(etimeSeconds("bogus")).toBeNull();
  });

  test("posix rows take the full command line and memory in MB", () => {
    const p = parsePosixList(lin, linuxOut);
    const node = p.rows.find((r) => r.pid === 501)!;
    expect(node).toMatchObject({ ppid: 500, name: "node", user: "alice", cpu: 50.5, mem_mb: 200, age_s: 59, cmd: "node server.js --port 3000" });
    expect([...p.chain]).toEqual([900, 899, 800]);
    expect(p.jobs).toEqual([{ id: "build-abc", pid: 500 }, { id: "stale-xyz", pid: 700 }]);
  });

  test("a mac comm is a path; the name is its last part", () => {
    const p = parsePosixList(mac, `${S}ps\n  42     1  3.0  1024 00:10 me /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n${S}end`);
    expect(p.rows[0]!.name).toBe("Google Chrome");
  });

  test("windows rows drop .exe and keep the session", () => {
    const json = JSON.stringify({ chain: 77, jobs: { id: "j1", pid: 10 },
      rows: [{ pid: 10, ppid: 4, name: "pwsh.exe", cmd: "pwsh -File C:\\x\\.fleet\\jobs\\j1\\run.ps1", session: 1, mem: 80, cpu: 0, age: 5 }] });
    const p = parseWindowsList(win, `noise\n${S}json|${json}\n`);
    expect(p.rows[0]).toMatchObject({ name: "pwsh", session: 1, user: null, mem_mb: 80 });
    expect([...p.chain]).toEqual([77]);
    expect(p.jobs).toEqual([{ id: "j1", pid: 10 }]);
  });
});

describe("ps", () => {
  const list = async () => (await processList(cfg, "lin", {}, { exec: async () => ok(linuxOut) }))[0]!.rows;

  test("job ownership follows parents, and a reused job pid is not a job", async () => {
    const rows = await list();
    expect(rows.find((r) => r.pid === 502)!.job).toBe("build-abc");
    // pid 700 is in the stale spool but is nginx now, not that job's runner
    expect(rows.find((r) => r.pid === 700)!.job).toBeUndefined();
  });

  test("fleet's session chain, pid 1, and system names are protected", async () => {
    const rows = await list();
    expect(rows.find((r) => r.pid === 900)!.protected).toBe("fleet's own session");
    expect(rows.find((r) => r.pid === 1)!.protected).toBe("a core system process");
    expect(rows.find((r) => r.pid === 501)!.protected).toBeUndefined();
  });

  test("the filter matches names, never command lines", async () => {
    const [l] = await processList(cfg, "lin", { filter: "server" }, { exec: async () => ok(linuxOut) });
    expect(l!.rows).toEqual([]);
    const [byName] = await processList(cfg, "lin", { filter: "python", sort: "cpu" }, { exec: async () => ok(linuxOut) });
    expect(byName!.rows.map((r) => r.pid)).toEqual([601, 600]);
  });
});

describe("resolving a kill", () => {
  let rows: ProcRow[] = [];
  const load = async () => { rows = (await processList(cfg, "lin", {}, { exec: async () => ok(linuxOut) }))[0]!.rows; };

  test("a name matching several processes is refused with the candidates", async () => {
    await load();
    expect(() => resolveKill(rows, "python3")).toThrow(/matches 2 processes[\s\S]*601  python3  python3 eval\.py[\s\S]*600/);
    expect(resolveKill(rows, "python3", { all: true }).map((r) => r.pid).sort()).toEqual([600, 601]);
  });

  test("an exact name beats a substring", async () => {
    await load();
    const extra = [...rows, { ...rows.find((r) => r.pid === 600)!, pid: 650, name: "python3-config" }];
    expect(() => resolveKill(extra, "python3")).toThrow(/matches 2/);
    expect(resolveKill(rows, "ngin").map((r) => r.pid)).toEqual([700]);
  });

  test("--tree puts children before their parent", async () => {
    await load();
    expect(resolveKill(rows, "500", { tree: true }).map((r) => r.pid)).toEqual([502, 501, 500]);
  });

  test("a comma list resolves each pid and fails on one that is gone", async () => {
    await load();
    expect(resolveKill(rows, "501,502").map((r) => r.pid)).toEqual([501, 502]);
    expect(() => resolveKill(rows, "501,9999")).toThrow("no process with pid 9999");
  });

  test("protection: session never lifts; system names lift with system", async () => {
    await load();
    expect(() => resolveKill(rows, "900")).toThrow(/fleet's own session/);
    expect(() => resolveKill(rows, "900", { system: true })).toThrow(/fleet's own session/);
    expect(() => resolveKill(rows, "sshd")).toThrow(/fleet's own session/); // 800 is in the chain too
    const sys = rows.map((r) => (r.pid === 800 ? { ...r, protected: "a system process (pass system to override)" } : r));
    expect(() => resolveKill(sys, "sshd")).toThrow(/system process/);
    expect(resolveKill(sys, "sshd", { system: true }).map((r) => r.pid)).toEqual([800]);
  });
});

describe("kill", () => {
  test("dry-run returns the plan with job and command, and signals nothing", async () => {
    const calls: string[] = [];
    const [r] = await processKill(cfg, "lin", "502", { dryRun: true }, { exec: async (_h, c) => { calls.push(c); return ok(linuxOut); } });
    expect(calls.length).toBe(1);
    expect(r!.targets).toEqual([{ pid: 502, name: "node", outcome: "planned", job: "build-abc", cmd: "node worker.js" }]);
  });

  test("the kill script re-checks names and its own session, and reports each pid", async () => {
    let script = "";
    const [r] = await processKill(cfg, "lin", "501,502", {}, { exec: async (_h, c) => {
      if (c.includes("-o pid=,args=")) return ok(linuxOut);
      script = c;
      return ok(`${S}k|501|exited\n${S}k|502|changed|now vim`);
    } });
    expect(script).toContain("kill -TERM");
    expect(script).not.toContain("kill -KILL");
    expect(script).toContain('case " $chain "');
    expect(r!.ok).toBe(false);
    expect(r!.targets).toEqual([
      { pid: 501, name: "node", outcome: "exited" },
      { pid: 502, name: "node", outcome: "changed", detail: "now vim" },
    ]);
  });

  test("force adds SIGKILL; a pid with no report is not counted as stopped", async () => {
    let script = "";
    const [r] = await processKill(cfg, "lin", "501", { force: true }, { exec: async (_h, c) => {
      if (c.includes("-o pid=,args=")) return ok(linuxOut);
      script = c; return ok("");
    } });
    expect(script).toContain("kill -KILL");
    expect(r!.targets[0]).toMatchObject({ outcome: "running", detail: "no report from the host" });
  });

  test("windows asks politely with taskkill and forces with Stop-Process", async () => {
    const json = JSON.stringify({ chain: [77], jobs: [], rows: [{ pid: 10, ppid: 4, name: "notepad.exe", cmd: "notepad", session: 1, mem: 5, cpu: 0, age: 5 }] });
    let script = "";
    await processKill(cfg, "win", "notepad", { force: true }, { exec: async (_h, c) => {
      if (c.includes("Win32_Process") && !c.includes("taskkill")) return ok(`${S}json|${json}`);
      script = c; return ok(`${S}k|10|killed|`);
    } });
    expect(script).toContain("taskkill.exe /PID");
    expect(script).toContain("Stop-Process -Id $p -Force");
  });

  test("parseKillOutput keeps pipes inside the detail", () => {
    const rows = parseKillOutput(`${S}k|5|denied|kill: (5) - Operation not permitted | x`, [{ pid: 5, name: "a" } as ProcRow]);
    expect(rows[0]).toEqual({ pid: 5, name: "a", outcome: "denied", detail: "kill: (5) - Operation not permitted | x" });
  });
});
