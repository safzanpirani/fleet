import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { sudoPassword } from "../src/core.ts";
import { assertPrivateSecret, ensurePrivateDir, readTrustedConfig } from "../src/perms.ts";
import type { Host } from "../src/config.ts";

const posix = process.platform !== "win32";
const mode = (path: string) => statSync(path).mode & 0o777;
const config = JSON.stringify({ hosts: { fake: { ssh: "fake.invalid", os: "linux" } } });

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-perms-"))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function load(path: string) {
  const saved = process.env.FLEET_CONFIG;
  process.env.FLEET_CONFIG = path;
  try { return await loadConfig(); }
  finally { if (saved === undefined) delete process.env.FLEET_CONFIG; else process.env.FLEET_CONFIG = saved; }
}

describe.if(posix)("config trust", () => {
  test("a group-writable config is refused with the chmod fix", async () => {
    const path = join(root, "fleet.config.json");
    writeFileSync(path, config); chmodSync(path, 0o664);
    await expect(load(path)).rejects.toThrow(`group- or other-writable (mode 664)`);
    await expect(load(path)).rejects.toThrow(`Fix: chmod go-w ${path}`);
  });

  test("a 644 config loads", async () => {
    const path = join(root, "fleet.config.json");
    writeFileSync(path, config); chmodSync(path, 0o644);
    expect(Object.keys((await load(path)).hosts)).toEqual(["fake"]);
  });

  test("a symlinked config is judged at its target", async () => {
    const target = join(root, "repo", "fleet.config.json");
    mkdirSync(join(root, "repo"));
    writeFileSync(target, config); chmodSync(target, 0o664);
    const link = join(root, "fleet.config.json");
    symlinkSync(target, link);
    await expect(load(link)).rejects.toThrow(`${link} (-> ${target})`);
    await expect(load(link)).rejects.toThrow(`chmod go-w ${target}`);
    chmodSync(target, 0o644);
    expect(Object.keys((await load(link)).hosts)).toEqual(["fake"]);
  });

  test("a symlink kept in an other-writable directory is refused even when its target is private", async () => {
    const target = join(root, "repo", "fleet.config.json");
    mkdirSync(join(root, "repo"));
    writeFileSync(target, config); chmodSync(target, 0o644);
    const shared = join(root, "shared");
    mkdirSync(shared); chmodSync(shared, 0o777);
    const link = join(shared, "fleet.config.json");
    symlinkSync(target, link);
    await expect(load(link)).rejects.toThrow(`its path goes through a symlink in ${shared}, which is writable by every user without the sticky bit (mode 777)`);
    await expect(load(link)).rejects.toThrow(`Fix: chmod o-w ${shared}`);
    // A hop through a second link in that directory is caught the same way.
    const outer = join(root, "fleet.json");
    symlinkSync(link, outer);
    await expect(load(outer)).rejects.toThrow(`a symlink in ${shared}`);
    chmodSync(shared, 0o1777);
    expect(Object.keys((await load(link)).hosts)).toEqual(["fake"]);
  });

  type Entry = { mode: number; uid: number; body?: string; link?: string };
  /** A filesystem in a map. `open` hands out a descriptor for the entry at that
   *  moment and then runs `onOpen`, which may swap the path to something else. */
  const fake = (files: Record<string, Entry>, onOpen: (path: string) => void = () => {}) => {
    const fds: Entry[] = [];
    const at = (p: string) => { const e = files[p]; if (!e) throw new Error(`ENOENT ${p}`); return e; };
    return {
      stat: (p: string) => at(p), realpath: (p: string) => p,
      lstat: (p: string) => ({ isSymbolicLink: () => at(p).link !== undefined }),
      readlink: (p: string) => at(p).link!,
      open: (p: string) => { fds.push(at(p)); onOpen(p); return fds.length - 1; },
      fstat: (fd: number) => fds[fd]!,
      read: (fd: number) => new TextEncoder().encode(fds[fd]!.body ?? "{}"),
      close: () => {},
      uid: 501, platform: "darwin" as const,
    };
  };

  test("a config owned by another user is refused; one owned by root is not", () => {
    const dir = { mode: 0o40755, uid: 501 };
    expect(() => readTrustedConfig("/c/f.json", fake({ "/c/f.json": { mode: 0o100644, uid: 502 }, "/c": dir })))
      .toThrow("owned by uid 502, not by you (uid 501) or root. The config decides");
    expect(() => readTrustedConfig("/c/f.json", fake({ "/c/f.json": { mode: 0o100644, uid: 502 }, "/c": dir })))
      .toThrow("Fix: chown 501 /c/f.json");
    expect(() => readTrustedConfig("/c/f.json", fake({ "/c/f.json": { mode: 0o100644, uid: 0 }, "/c": dir }))).not.toThrow();
  });

  test("an other-writable directory needs the sticky bit", () => {
    const file = { mode: 0o100644, uid: 501 };
    expect(() => readTrustedConfig("/t/f.json", fake({ "/t/f.json": file, "/t": { mode: 0o40777, uid: 0 } })))
      .toThrow("Fix: chmod o-w /t");
    expect(() => readTrustedConfig("/t/f.json", fake({ "/t/f.json": file, "/t": { mode: 0o41777, uid: 0 } }))).not.toThrow();
    // Group-writable alone is the owner's call for a directory.
    expect(() => readTrustedConfig("/t/f.json", fake({ "/t/f.json": file, "/t": { mode: 0o40775, uid: 501 } }))).not.toThrow();
  });

  test("the returned bytes come from the descriptor that was checked, not from a later reopen", () => {
    const dir = { mode: 0o40755, uid: 501 };
    const checked = '{"hosts":{"mine":{"ssh":"mine","os":"linux"}}}';
    const files: Record<string, Entry> = { "/c": dir, "/c/f.json": { mode: 0o100644, uid: 501, body: checked } };
    // Swapped for another user's writable file right after it was opened.
    const swap = () => { files["/c/f.json"] = { mode: 0o100666, uid: 502, body: '{"hosts":{"evil":{}}}' }; };
    expect(readTrustedConfig("/c/f.json", fake(files, swap))).toBe(checked);
  });

  test("the mode and owner are judged on the opened descriptor", () => {
    const dir = { mode: 0o40755, uid: 501 };
    const files: Record<string, Entry> = { "/c": dir, "/c/f.json": { mode: 0o100644, uid: 501 } };
    // The path looks private until the open lands on a replacement.
    const deps = fake(files);
    const open = deps.open;
    deps.open = (p: string) => { files[p] = { mode: 0o100666, uid: 501, body: "{}" }; return open(p); };
    expect(() => readTrustedConfig("/c/f.json", deps)).toThrow("group- or other-writable (mode 666)");
  });

  test("a link's own directory is checked with the target's", () => {
    const files: Record<string, Entry> = {
      "/pub": { mode: 0o40777, uid: 0 }, "/pub/f.json": { mode: 0o120777, uid: 502, link: "/c/f.json" },
      "/c": { mode: 0o40755, uid: 501 }, "/c/f.json": { mode: 0o100644, uid: 501 },
    };
    expect(() => readTrustedConfig("/pub/f.json", fake(files)))
      .toThrow("refusing to load fleet config /pub/f.json (-> /c/f.json): its path goes through a symlink in /pub");
    files["/pub"] = { mode: 0o41777, uid: 0 };
    expect(() => readTrustedConfig("/pub/f.json", fake(files))).not.toThrow();
  });

  test("a Windows controller skips mode checks and still reads one descriptor", () => {
    expect(readTrustedConfig("C:/f.json", { ...fake({ "C:/f.json": { mode: 0o100666, uid: 9, body: "{\"a\":1}" } }), platform: "win32" }))
      .toBe("{\"a\":1}");
  });
});

describe.if(posix)("sudo passwordFile", () => {
  const host = (passwordFile: string): Host => ({ name: "box", ssh: "box", os: "linux", sudo: { passwordFile } });

  test("a 0644 file is refused with the fix and without its contents", async () => {
    const file = join(root, "sudo-pw");
    writeFileSync(file, "hunter2\n"); chmodSync(file, 0o644);
    const err = await sudoPassword(host(file)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(`box: sudo.passwordFile ${file} is accessible to other users (mode 644); fix: chmod 600 ${file}`);
  });

  test("a group-readable file is refused before it is read", async () => {
    // The owner cannot read 0240, so reading first would fail differently.
    const file = join(root, "sudo-pw");
    writeFileSync(file, "hunter2\n"); chmodSync(file, 0o240);
    await expect(sudoPassword(host(file))).rejects.toThrow("(mode 240); fix: chmod 600");
  });

  test("a 0600 file is read", async () => {
    const file = join(root, "sudo-pw");
    writeFileSync(file, "hunter2\nsecond line\n"); chmodSync(file, 0o600);
    expect(await sudoPassword(host(file))).toBe("hunter2");
  });

  test("a file owned by another user is refused", () => {
    const deps = { stat: () => ({ mode: 0o100600, uid: 502 }), uid: 501, platform: "linux" as const };
    expect(() => assertPrivateSecret("/s/pw", "proxy passwordFile", deps))
      .toThrow("proxy passwordFile /s/pw is owned by uid 502, not by you (uid 501); fix: chown 501 /s/pw && chmod 600 /s/pw");
  });
});

describe.if(posix)("private state directories", () => {
  test("a new directory and its missing parents are created 0700", () => {
    const dir = join(root, "home", ".fleet", "ssh");
    ensurePrivateDir(dir);
    expect(mode(join(root, "home", ".fleet"))).toBe(0o700);
    expect(mode(dir)).toBe(0o700);
  });

  test("ssh multiplexing creates ~/.fleet and ~/.fleet/ssh private and tightens wider ones", async () => {
    for (const existing of [false, true]) {
      const home = join(root, existing ? "old" : "new");
      mkdirSync(home);
      if (existing) {
        mkdirSync(join(home, ".fleet", "ssh"), { recursive: true });
        chmodSync(join(home, ".fleet"), 0o755); chmodSync(join(home, ".fleet", "ssh"), 0o755);
      }
      const proc = Bun.spawn([process.execPath, "-e",
        `import { muxOpts } from "${join(import.meta.dir, "../src/ssh.ts")}";
         console.log(muxOpts({ name: "h", ssh: "h", os: "linux" }).join(" "));`],
      { env: { ...process.env, HOME: home, FLEET_NO_SSH_MUX: "", FLEET_SSH_MUX: "" }, stdout: "pipe", stderr: "pipe" });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).toBe(0);
      expect(out).toContain(`ControlPath=${join(home, ".fleet", "ssh")}/cm-`);
      expect(mode(join(home, ".fleet"))).toBe(0o700);
      expect(mode(join(home, ".fleet", "ssh"))).toBe(0o700);
    }
  });

  test("a directory that cannot be created does not throw", () => {
    const file = join(root, "plain-file");
    writeFileSync(file, "");
    expect(() => ensurePrivateDir(join(file, "sub"))).not.toThrow();
  });
});
