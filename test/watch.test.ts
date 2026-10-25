import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ExecResult } from "../src/ssh.ts";
import { changedLines, parseWatchInterval, watchLoop, type WatchDeps, type WatchRun } from "../src/watch.ts";

/** A fake clock: sleep advances time; each exec costs `execMs`. */
function harness(outputs: (string | Partial<ExecResult>)[], execMs = 100, stopAfter?: number) {
  let t = 1_000;
  const runs: WatchRun[] = [];
  const sleeps: number[] = [];
  const execTimeouts: (number | undefined)[] = [];
  let calls = 0;
  const deps: WatchDeps = {
    exec: async (timeoutMs) => {
      execTimeouts.push(timeoutMs);
      t += execMs;
      const o = outputs[Math.min(calls++, outputs.length - 1)]!;
      return { host: "h", ok: true, code: 0, stdout: "", stderr: "", ...(typeof o === "string" ? { stdout: o } : o) };
    },
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    render: (run) => { runs.push(run); },
    stopped: () => stopAfter !== undefined && runs.length >= stopAfter,
  };
  return { deps, runs, sleeps, execTimeouts };
}

describe("watchLoop", () => {
  test("--until stops on the first matching run and reports it", async () => {
    const h = harness(["starting\n", "starting\n", "ready\n"]);
    const out = await watchLoop({ intervalMs: 2000, until: /ready/ }, h.deps);
    expect(out.reason).toBe("matched");
    expect(out.runs).toBe(3);
    expect(h.runs.map((r) => r.matched)).toEqual([false, false, true]);
    // Interval runs start to start: each 100 ms exec leaves 1900 ms of sleep.
    expect(h.sleeps).toEqual([1900, 1900]);
  });

  test("--until also matches stderr", async () => {
    const h = harness([{ stderr: "unit is active\n", code: 3 }]);
    const out = await watchLoop({ intervalMs: 500, until: /active/ }, h.deps);
    expect(out).toMatchObject({ reason: "matched", runs: 1 });
  });

  test("--timeout ends an unmatched watch, never sleeping past the deadline", async () => {
    const h = harness(["no\n"]);
    const out = await watchLoop({ intervalMs: 2000, until: /yes/, timeoutMs: 3500 }, h.deps);
    expect(out.reason).toBe("timeout");
    expect(out.runs).toBe(2);
    expect(h.sleeps).toEqual([1900, 1400]);
    // Each exec is capped at the time left.
    expect(h.execTimeouts).toEqual([3500, 1500]);
  });

  test("an exec slower than the interval reruns immediately", async () => {
    const h = harness(["x"], 3000, 2);
    const out = await watchLoop({ intervalMs: 500 }, h.deps);
    expect(out.reason).toBe("stopped");
    expect(h.sleeps).toEqual([0, 0]);
  });

  test("a stop request ends the loop without matching", async () => {
    const h = harness(["a\n", "b\n", "c\n"], 10, 2);
    const out = await watchLoop({ intervalMs: 500 }, h.deps);
    expect(out).toMatchObject({ reason: "stopped", runs: 2 });
    expect(h.execTimeouts).toEqual([undefined, undefined]);
  });

  test("each run carries the lines that changed since the previous one", async () => {
    const h = harness(["a\nb\nc\n", "a\nB\nc\nd\n"], 10, 2);
    await watchLoop({ intervalMs: 500 }, h.deps);
    expect(h.runs[0]!.changed).toEqual([]);
    expect(h.runs[1]!.changed).toEqual([1, 3]);
  });
});

describe("watch helpers", () => {
  test("changedLines marks new and differing lines only", () => {
    expect(changedLines(undefined, "a\nb")).toEqual([]);
    expect(changedLines("a\nb", "a\nb")).toEqual([]);
    expect(changedLines("a\nb\nc", "a\nx")).toEqual([1]);
    expect(changedLines("a", "a\nb")).toEqual([1]);
  });

  test("parseWatchInterval defaults to 2 and refuses less than 0.5", () => {
    expect(parseWatchInterval(undefined)).toBe(2);
    expect(parseWatchInterval("0.5")).toBe(0.5);
    expect(parseWatchInterval("10")).toBe(10);
    for (const bad of ["0.4", "0", "-1", "abc", "", true] as const)
      expect(parseWatchInterval(bad)).toContain("-n needs a number of seconds");
  });
});

const cli = join(import.meta.dir, "../src/cli.ts");

function fixture(hosts: Record<string, unknown> = { local: { ssh: "local", os: "mac" } }) {
  const root = mkdtempSync(join(tmpdir(), "fleet-watch-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const config = join(root, "fleet.config.json");
  writeFileSync(config, JSON.stringify({ hosts }));
  // A fake ssh that runs the shipped program in a local bash.
  const ssh = join(bin, "ssh");
  writeFileSync(ssh, `#!/bin/sh\nexport HOME='${root}'\nscript=$(cat)\nprintf '%s' "$script" | /bin/bash -s\n`);
  chmodSync(ssh, 0o755);
  return { root, bin, config };
}

async function runCli(args: string[], f: { bin: string; config: string }) {
  const proc = Bun.spawn(["bun", cli, ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, FLEET_CONFIG: f.config, PATH: `${f.bin}${delimiter}${process.env.PATH ?? ""}`, NO_COLOR: "1" },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const deadline = setTimeout(() => proc.kill("SIGKILL"), 20_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  clearTimeout(deadline);
  return { stdout, stderr, code };
}

describe("fleet watch CLI", () => {
  test("validates options before resolving the selector", async () => {
    const f = fixture();
    try {
      for (const [args, message] of [
        [["-n", "0.1", "nohost", "true"], "-n needs a number of seconds ≥ 0.5"],
        [["--until", "(", "nohost", "true"], "--until:"],
        [["--timeout", "5", "nohost", "true"], "--timeout requires --until"],
        [["--until", "x", "--timeout", "1.5", "nohost", "true"], "--timeout needs an integer"],
        [["--bogus", "nohost", "true"], "--bogus"],
        [["nohost"], "usage: fleet watch"],
      ] as const) {
        const r = await runCli(["watch", ...args], f);
        expect(r.code, r.stderr).toBe(1);
        expect(r.stderr).toContain(message);
        expect(r.stderr).not.toContain("unknown host");
      }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 60_000);

  test("refuses a selector with more than one host", async () => {
    const f = fixture({ a: { ssh: "a", os: "mac" }, b: { ssh: "b", os: "mac" } });
    try {
      const r = await runCli(["watch", "all", "--", "true"], f);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("fleet watch takes one host");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("piped output prints each run after a timestamp line and exits 0 on --until", async () => {
    const f = fixture();
    try {
      const r = await runCli(["watch", "-n", "0.5", "--until", "^tick 2$", "--timeout", "15", "local", "--",
        'n=$(cat "$HOME/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$HOME/n"; echo "tick $n"'], f);
      expect(r.code, r.stderr).toBe(0);
      const stamps = r.stdout.split("\n").filter((l) => l.startsWith("── "));
      expect(stamps).toHaveLength(2);
      expect(stamps[0]).toMatch(/^── \d{4}-\d\d-\d\dT[\d:.]+Z · local · run 1 · exit 0 ──$/);
      expect(r.stdout).toContain("tick 1\n");
      expect(r.stdout).toContain("tick 2\n");
      expect(r.stdout).not.toContain("\x1b[");
      expect(r.stderr).toContain("matched --until after 2 runs");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  test("--timeout without a match exits 1", async () => {
    const f = fixture();
    try {
      const r = await runCli(["watch", "-n", "0.5", "--until", "never", "--timeout", "1", "local", "--", "echo waiting"], f);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("waiting\n");
      expect(r.stderr).toContain("did not match within 1s");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);
});
