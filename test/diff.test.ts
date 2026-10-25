import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeDiffText, DIFF_MAX_BYTES, unifiedDiff } from "../src/diff.ts";
import { diffFiles, readRemoteBytes } from "../src/core.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import type { exec, ExecResult } from "../src/ssh.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const linux = { name: "box", ssh: "box", os: "linux" } as Host;
const windows = { name: "win", ssh: "win", os: "windows" } as Host;
const cfg = {
  hosts: { box: { ssh: "box", os: "linux" }, win: { ssh: "win", os: "windows" } },
} as unknown as FleetConfig;

/** Run the real POSIX read script in a local bash, as the remote login shell would. */
const localBash = (async (host: Host, command: string): Promise<ExecResult> => {
  const p = Bun.spawnSync(["bash", "-c", command]);
  return { host: host.name, ok: p.exitCode === 0, code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}) as typeof exec;

function tmp(): string { return mkdtempSync(join(tmpdir(), "fleet-diff-")); }

describe("unifiedDiff", () => {
  test("identical texts give an empty diff", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", "x", "y")).toBe("");
  });

  test("matches diff -u for a change and an append without a final newline", () => {
    expect(unifiedDiff("a\nb\nc\nd\n", "a\nB\nc\nd\ne", "x", "y")).toBe(
      "--- x\n+++ y\n@@ -1,4 +1,5 @@\n a\n-b\n+B\n c\n d\n+e\n\\ No newline at end of file\n");
  });

  test("separate changes get separate hunks; -U 0 shows no context", () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n") + "\n";
    const b = a.replace("l2\n", "L2\n").replace("l17\n", "L17\n");
    expect(unifiedDiff(a, b, "x", "y", 0)).toBe("--- x\n+++ y\n@@ -3 +3 @@\n-l2\n+L2\n@@ -18 +18 @@\n-l17\n+L17\n");
    expect(unifiedDiff(a, b, "x", "y", 3).match(/^@@/gm)).toHaveLength(2);
    expect(unifiedDiff(a, b, "x", "y", 8).match(/^@@/gm)).toHaveLength(1);
  });

  test("empty sides use the 0,0 range", () => {
    expect(unifiedDiff("", "a\n", "x", "y")).toBe("--- x\n+++ y\n@@ -0,0 +1 @@\n+a\n");
    expect(unifiedDiff("a\nb\n", "", "x", "y")).toBe("--- x\n+++ y\n@@ -1,2 +0,0 @@\n-a\n-b\n");
  });

  test("a line that only lost its final newline is a change", () => {
    expect(unifiedDiff("a\n", "a", "x", "y")).toBe("--- x\n+++ y\n@@ -1 +1 @@\n-a\n+a\n\\ No newline at end of file\n");
  });

  test("random edits round-trip through patch(1)", () => {
    const dir = tmp();
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    for (let round = 0; round < 40; round++) {
      const a = Array.from({ length: rnd(30) }, () => `w${rnd(6)}`);
      const b = a.flatMap((line) => [[], [line], [line], [`n${rnd(6)}`], [line, `n${rnd(6)}`]][rnd(5)]!);
      const ta = a.join("\n") + (rnd(2) ? "\n" : ""), tb = b.join("\n") + (rnd(2) ? "\n" : "");
      const d = unifiedDiff(ta, tb, "a", "b", rnd(4));
      if (ta === tb) { expect(d).toBe(""); continue; }
      writeFileSync(join(dir, "a"), ta);
      writeFileSync(join(dir, "patch"), d);
      const p = Bun.spawnSync(["patch", "-s", "-o", join(dir, "out"), join(dir, "a"), join(dir, "patch")]);
      expect(p.exitCode).toBe(0);
      expect(readFileSync(join(dir, "out"), "utf8")).toBe(tb);
    }
  });

  test("a large unrelated pair falls back to one replace block", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n") + "\n";
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n") + "\n";
    const d = unifiedDiff(a, b, "x", "y");
    expect(d.split("\n")[2]).toBe("@@ -1,3000 +1,3000 @@");
    expect(d.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"))).toHaveLength(3000);
  });
});

describe("decodeDiffText", () => {
  test("refuses NUL bytes, invalid UTF-8 and oversized input", () => {
    expect(() => decodeDiffText(new Uint8Array([97, 0, 98]), "f")).toThrow("binary file (contains NUL bytes)");
    expect(() => decodeDiffText(new Uint8Array([0xff, 0xfe, 0x41]), "f")).toThrow("not valid UTF-8");
    expect(() => decodeDiffText(new Uint8Array(DIFF_MAX_BYTES + 1).fill(97), "f")).toThrow("diff limit");
    expect(decodeDiffText(new TextEncoder().encode("héllo\r\n"), "f")).toBe("héllo\r\n");
  });
});

describe("readRemoteBytes", () => {
  test("POSIX script returns the bytes, and refuses missing, directory and oversized files", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "it's.txt"), "one\ntwo\n");
    expect((await readRemoteBytes(linux, join(dir, "it's.txt"), 100, { exec: localBash })).toString()).toBe("one\ntwo\n");
    await expect(readRemoteBytes(linux, join(dir, "nope"), 100, { exec: localBash })).rejects.toThrow("box:" + join(dir, "nope") + ": no such file");
    await expect(readRemoteBytes(linux, dir, 100, { exec: localBash })).rejects.toThrow("not a regular file");
    await expect(readRemoteBytes(linux, join(dir, "it's.txt"), 4, { exec: localBash })).rejects.toThrow("file is 8 bytes, over the 4-byte diff limit");
  });

  test("Windows sends PowerShell with an escaped literal path and decodes CRLF-wrapped base64", async () => {
    let sent = "";
    const fake = (async (host: Host, command: string): Promise<ExecResult> => {
      sent = command;
      return { host: host.name, ok: true, code: 0, stdout: Buffer.from("a\r\nb\r\n").toString("base64") + "\r\n", stderr: "" };
    }) as typeof exec;
    const bytes = await readRemoteBytes(windows, "C:\\Users\\o'brien\\x.txt", 100, { exec: fake });
    expect(bytes.toString()).toBe("a\r\nb\r\n");
    expect(sent).toContain("Get-Item -LiteralPath 'C:\\Users\\o''brien\\x.txt'");
    expect(sent).toContain("$f.Length -gt 100");
    expect(sent).not.toContain("bash");
  });

  test("a failed remote read surfaces stderr", async () => {
    const fake = (async (host: Host): Promise<ExecResult> =>
      ({ host: host.name, ok: false, code: 1, stdout: "", stderr: "file is 9 bytes, over the 4-byte diff limit\r\n" })) as typeof exec;
    await expect(readRemoteBytes(windows, "C:/x", 4, { exec: fake })).rejects.toThrow("win:C:/x: file is 9 bytes, over the 4-byte diff limit");
  });
});

describe("diffFiles", () => {
  test("diffs a remote side against a local one and reports the JSON shape", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "remote"), "x\ny\n");
    writeFileSync(join(dir, "local"), "x\nz\n");
    const r = await diffFiles(cfg, { label: "box:/r", sel: "box", path: join(dir, "remote") },
      { label: "local", path: join(dir, "local") }, 3, { exec: localBash });
    expect(Object.keys(r)).toEqual(["identical", "a", "b", "diff"]);
    expect(r).toEqual({ identical: false, a: "box:/r", b: "local", diff: "--- box:/r\n+++ local\n@@ -1,2 +1,2 @@\n x\n-y\n+z\n" });
  });

  test("refuses a selector with several hosts, a binary local file and a missing one", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "bin"), new Uint8Array([1, 0, 2]));
    writeFileSync(join(dir, "ok"), "ok\n");
    const ok = { label: "ok", path: join(dir, "ok") };
    await expect(diffFiles(cfg, { label: "box,win:/x", sel: "box,win", path: "/x" }, ok)).rejects.toThrow("selects 2 hosts");
    await expect(diffFiles(cfg, { label: "bin", path: join(dir, "bin") }, ok)).rejects.toThrow("bin: binary file");
    await expect(diffFiles(cfg, { label: "gone", path: join(dir, "gone") }, ok)).rejects.toThrow("gone: no such file");
    await expect(diffFiles(cfg, { label: "dir", path: dir }, ok)).rejects.toThrow("dir: not a regular file");
  });
});

describe("fleet diff CLI", () => {
  const dir = tmp();
  const config = join(dir, "fleet.config.json");
  writeFileSync(config, JSON.stringify({ hosts: { local: { ssh: "local", os: "linux" } } }));
  writeFileSync(join(dir, "a"), "1\n2\n");
  writeFileSync(join(dir, "b"), "1\n3\n");
  writeFileSync(join(dir, "bin"), new Uint8Array([0]));
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["bun", cli, "diff", ...args], {
      cwd: dir, env: { ...process.env, FLEET_CONFIG: config, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  };

  test("exit 0 identical, 1 different, with plain unified output when piped", async () => {
    expect(await run("a", "a")).toEqual({ stdout: "", stderr: "", code: 0 });
    const r = await run("-U", "0", "a", "b");
    expect(r).toEqual({ stdout: "--- a\n+++ b\n@@ -2 +2 @@\n-2\n+3\n", stderr: "", code: 1 });
  });

  test("--json emits one value with the documented keys", async () => {
    const r = await run("a", "b", "--json");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ identical: false, a: "a", b: "b", diff: "--- a\n+++ b\n@@ -1,2 +1,2 @@\n 1\n-2\n+3\n" });
  });

  test("errors exit 2: usage, bad -U, unknown option, binary file", async () => {
    expect((await run("a")).code).toBe(2);
    const badU = await run("-U", "1.5", "a", "b");
    expect(badU.code).toBe(2);
    expect(badU.stderr).toContain("-U needs an integer");
    expect((await run("--bogus", "a", "b")).code).toBe(2);
    const bin = await run("a", "bin", "--json");
    expect(bin.code).toBe(2);
    expect(JSON.parse(bin.stdout)).toEqual({ ok: false, error: "bin: binary file (contains NUL bytes); fleet diff compares text only" });
  });
});
