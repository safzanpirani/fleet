import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duCmd, duLimit, parseDu, summarizeDu } from "../src/core.ts";
import { humanSize } from "../src/cli.ts";
import type { Host } from "../src/config.ts";
import type { ExecResult } from "../src/ssh.ts";

const win: Host = { name: "winbox", ssh: "winbox", os: "windows" };
const lin: Host = { name: "vps", ssh: "vps", os: "linux" };
const mac: Host = { name: "mac", ssh: "mac", os: "mac" };

const result = (stdout: string, code = 0, stderr = ""): ExecResult =>
  ({ host: "vps", ok: code === 0, code, stdout, stderr });

/** Run the POSIX program the way exec does: bash reading it from stdin. */
function runPosix(path: string, home: string): { stdout: string; stderr: string; code: number } {
  const p = Bun.spawnSync(["bash", "-s"], { stdin: Buffer.from(duCmd(lin, path).cmd), cwd: home, env: { ...process.env, HOME: home } });
  return { stdout: p.stdout.toString(), stderr: p.stderr.toString(), code: p.exitCode };
}

describe("duCmd", () => {
  test("unix measures each child with du -skx and the same script serves macOS", () => {
    const { cmd, shell } = duCmd(lin, "/var");
    expect(shell).toBe("bash");
    expect(cmd).toContain("du -skx --");
    expect(duCmd(mac, "/var").cmd).toBe(cmd);
  });

  test("windows sums file lengths with -Force and SilentlyContinue", () => {
    const { cmd, shell } = duCmd(win, "C:\\Users");
    expect(shell).toBe("powershell");
    expect(cmd).toContain("-Recurse -Force -File -ErrorAction SilentlyContinue -ErrorVariable err");
    expect(cmd).toContain("Measure-Object -Property Length -Sum");
    expect(cmd).toContain("-LiteralPath 'C:\\Users'");
  });

  test("quotes the directory for each shell", () => {
    expect(duCmd(lin, "/a b/it's").cmd).toContain(`cd -- '/a b/it'\\''s'`);
    expect(duCmd(win, "C:\\it's").cmd).toContain(`-LiteralPath 'C:\\it''s'`);
    expect(duCmd(lin, "~/x y").cmd).toContain(`cd -- "$HOME"/'x y'`);
    expect(duCmd(lin, "").cmd).toContain(`cd -- "$HOME"`);
  });
});

describe("parseDu", () => {
  test("reads the same line format from every OS, CRLF included", () => {
    const unix = "D\t/srv\nN\t2\nE\t4096\t0\td\tdata\nE\t1048576\t1\tf\ta\tb\n";
    const windows = unix.replaceAll("\n", "\r\n");
    for (const out of [unix, windows]) {
      expect(parseDu(out)).toEqual({ resolved: "/srv", count: 2, entries: [
        { name: "data", type: "d", bytes: 4096, partial: false },
        { name: "a\tb", type: "f", bytes: 1048576, partial: true },
      ] });
    }
  });

  test("ignores noise and malformed lines", () => {
    expect(parseDu("motd banner\nE\tx\t0\td\tbad\nE\t5\t2\td\tbad\nE\t5\t0\tq\tbad\n").entries).toEqual([]);
  });
});

describe("summarizeDu", () => {
  const out = "D\t/srv\nN\t4\nE\t100\t0\tf\tsmall\nE\t5000\t1\td\tbig\nE\t300\t0\td\tmid\nE\t200\t0\tl\tlink\n";

  test("sorts largest first, keeps the top N, folds the rest", () => {
    const r = summarizeDu(lin, "/srv", result(out), 2);
    expect(r).toEqual({
      host: "vps", os: "linux", ok: true, path: "/srv", resolved: "/srv", total_bytes: 5600, count: 4, measured: 4,
      entries: [{ name: "big", type: "d", bytes: 5000, partial: true }, { name: "mid", type: "d", bytes: 300, partial: false }],
      rest: { count: 2, bytes: 300 }, complete: true, partial: true,
    });
  });

  test("a timeout keeps what was measured and says how much", () => {
    const partialOut = "D\t/srv\nN\t4\nE\t100\t0\tf\tsmall\n";
    const r = summarizeDu(lin, "/srv", result(partialOut, 124, "fleet: command timed out after 5s"), 15);
    expect(r.ok).toBe(false);
    expect(r.complete).toBe(false);
    expect(r.measured).toBe(1);
    expect(r.count).toBe(4);
    expect(r.entries.map((e) => e.name)).toEqual(["small"]);
    expect(r.error).toBe("timed out after measuring 1 of 4 children");
  });

  test("a missing directory reports the host's message", () => {
    const r = summarizeDu(lin, "/nope", result("", 2, "fleet du: not a readable directory: /nope"), 15);
    expect(r).toMatchObject({ ok: false, measured: 0, entries: [], error: "fleet du: not a readable directory: /nope" });
    expect(r.resolved).toBeUndefined();
  });
});

describe("options", () => {
  test("-n must be a positive integer", () => {
    expect(duLimit(1)).toBe(1);
    for (const bad of [0, -1, 1.5, NaN, "3"]) expect(() => duLimit(bad)).toThrow("-n needs an integer ≥ 1");
  });

  test("human sizes are 1024-based", () => {
    expect([0, 1023, 1536, 10 * 1024 ** 2, 5.25 * 1024 ** 3].map(humanSize)).toEqual(["0B", "1023B", "1.5K", "10M", "5.3G"]);
  });
});

describe("POSIX program against a real directory", () => {
  test("lists every child, hidden and symlinked ones included, sized in bytes", () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-du-"));
    try {
      const dir = join(home, "it's here");
      mkdirSync(join(dir, "data"), { recursive: true });
      writeFileSync(join(dir, "data", "blob"), Buffer.alloc(256 * 1024, 1));
      writeFileSync(join(dir, ".hidden"), "x");
      writeFileSync(join(dir, "with space"), Buffer.alloc(64 * 1024, 1));
      symlinkSync(join(dir, "data"), join(dir, "link"));
      const r = runPosix("~/it's here", home);
      expect(r.code).toBe(0);
      const p = parseDu(r.stdout);
      expect(p.count).toBe(4);
      const byName = Object.fromEntries(p.entries.map((e) => [e.name, e]));
      expect(Object.keys(byName).sort()).toEqual([".hidden", "data", "link", "with space"]);
      expect(byName.data!.type).toBe("d");
      expect(byName.data!.bytes).toBeGreaterThanOrEqual(256 * 1024);
      expect(byName.link!.type).toBe("l");
      expect(byName.link!.bytes).toBeLessThan(64 * 1024);   // the link itself, not its target
      expect(byName["with space"]!.type).toBe("f");
      expect(p.entries.every((e) => !e.partial)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test.skipIf(process.getuid?.() === 0)("an unreadable subtree marks its child partial without failing the listing", () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-du-"));
    const locked = join(home, "d", "locked");
    try {
      mkdirSync(join(locked, "inner"), { recursive: true });
      writeFileSync(join(home, "d", "ok"), "fine");
      chmodSync(locked, 0o000);
      const r = runPosix("d", home);
      expect(r.code).toBe(0);
      const s = summarizeDu(lin, "d", result(r.stdout), 15);
      expect(s.ok).toBe(true);
      expect(s.partial).toBe(true);
      expect(s.entries.find((e) => e.name === "locked")?.partial).toBe(true);
      expect(s.entries.find((e) => e.name === "ok")?.partial).toBe(false);
    } finally { chmodSync(locked, 0o755); rmSync(home, { recursive: true, force: true }); }
  });

  test("a missing directory exits 2 with a message", () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-du-"));
    try {
      const r = runPosix("/definitely/not/here", home);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("fleet du: not a readable directory: /definitely/not/here");
      expect(r.stdout).toBe("");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
