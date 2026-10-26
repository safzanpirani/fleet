import { test, expect, describe } from "bun:test";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyScript,
  inventoryScript,
  judgeSkill,
  parseInventory,
  selectSkills,
  skillsStatus,
  syncSkills,
  treeHash,
} from "../src/skills.ts";
import type { SkillCopy, SkillVerdict } from "../src/skills.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import type { ExecResult } from "../src/ssh.ts";

const temp = (label: string): string => mkdtempSync(join(tmpdir(), `fleet-skills-${label}-`));
const write = (path: string, body: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
};
const skill = (root: string, name: string, body = `---\nname: ${name}\n---\n# ${name}\n`): string => {
  write(join(root, name, "SKILL.md"), body);
  return join(root, name);
};

describe("skill selection", () => {
  test("include then exclude globs, symlinked dirs followed, tool-owned names held for tools", async () => {
    const root = temp("root");
    const outside = temp("outside");
    const toolRoot = temp("tool");
    try {
      skill(root, "alpha");
      skill(root, "alpha-old");
      skill(root, "beta");
      mkdirSync(join(root, "not-a-skill"));            // no SKILL.md
      const linked = skill(outside, "real-gamma");
      write(join(linked, "refs", "notes.md"), "notes\n");
      symlinkSync(linked, join(root, "gamma"));
      skill(root, "democli");                          // shipped by the democli tool
      write(join(toolRoot, "skills", "democli", "SKILL.md"), "---\nname: democli\n---\n");
      const cfg: FleetConfig = {
        hosts: { web: { name: "web", ssh: "web", os: "linux" } },
        tools: { democli: { root: toolRoot } },
        skills: { core: { hosts: "web", root, include: ["alpha*", "gamma", "democli", "nomatch-*"], exclude: ["*-old"] } },
      };
      const selection = await selectSkills(cfg, "core");
      expect(selection.skills.map((s) => s.name)).toEqual(["alpha", "gamma"]);
      expect(selection.toolOwned).toEqual([{ name: "democli", tool: "democli" }]);
      expect(selection.unmatched).toEqual(["nomatch-*"]);
      const gamma = selection.skills.find((s) => s.name === "gamma")!;
      expect(gamma.files).toBe(2);
      expect(gamma.hash).toBe((await treeHash(linked)).hash);
    } finally {
      for (const dir of [root, outside, toolRoot]) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("junk files never change a skill's hash", async () => {
    const root = temp("junk");
    try {
      const dir = skill(root, "alpha");
      const before = await treeHash(dir);
      write(join(dir, "._SKILL.md"), "resource fork");
      write(join(dir, ".DS_Store"), "finder");
      write(join(dir, "node_modules", "x", "index.js"), "x");
      write(join(dir, "sub", ".git", "HEAD"), "ref");
      expect(await treeHash(dir)).toEqual(before);
      write(join(dir, "sub", "real.md"), "real");
      expect((await treeHash(dir)).hash).not.toBe(before.hash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("judgeSkill", () => {
  const S = "s".repeat(64), M = "m".repeat(64), X = "x".repeat(64);
  const copies = (agents: Partial<SkillCopy> | null, claude: Partial<SkillCopy> = { kind: "link" }, openclaw: Partial<SkillCopy> = { kind: "link" }): SkillCopy[] => [
    { root: ".agents", kind: "missing", ...(agents ?? {}) } as SkillCopy,
    { root: ".claude", kind: "missing", ...claude } as SkillCopy,
    { root: ".openclaw", kind: "missing", ...openclaw } as SkillCopy,
  ];
  const cases: [string, string | undefined, SkillCopy[], SkillVerdict][] = [
    ["remote equals source", M, copies({ kind: "dir", hash: S }), "current"],
    ["remote equals manifest, source moved on", M, copies({ kind: "dir", hash: M }), "stale"],
    ["remote edited since sync", M, copies({ kind: "dir", hash: X }), "drifted"],
    ["no manifest entry and different", undefined, copies({ kind: "dir", hash: X }), "unmanaged"],
    ["no manifest entry but equal (adoptable)", undefined, copies({ kind: "dir", hash: S }), "current"],
    ["nothing on the host", undefined, copies(null, { kind: "missing" }, { kind: "missing" }), "missing"],
    ["agents copy current, a link missing", M, copies({ kind: "dir", hash: S }, { kind: "missing" }), "stale"],
    ["real dir under .claude edited", M, copies({ kind: "dir", hash: S }, { kind: "dir", hash: X }), "drifted"],
    ["real dir under .openclaw unmanaged", undefined, copies({ kind: "dir", hash: S }, { kind: "link" }, { kind: "dir", hash: X }), "unmanaged"],
    ["a plain file where the copy belongs", M, copies({ kind: "file" }), "drifted"],
    ["symlinked agents dir judged by its contents", M, copies({ kind: "link", hash: M }), "stale"],
  ];
  for (const [name, manifest, list, state] of cases)
    test(name, () => expect(judgeSkill(S, manifest, list)).toBe(state));
});

/** Run a script as a remote bash host would, with HOME pointed at a temp dir. */
function localBash(home: string, path?: string) {
  const calls: string[] = [];
  const exec = async (h: Host, cmd: string): Promise<ExecResult> => {
    calls.push(cmd);
    const proc = Bun.spawn(["bash"], {
      stdin: new Blob([cmd]), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: home, ...(path ? { PATH: path } : {}) },
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { host: h.name, ok: code === 0, code, stdout, stderr };
  };
  const pushes: string[] = [];
  const scp = async (h: Host, local: string | string[], remote: string): Promise<ExecResult> => {
    pushes.push(remote);
    copyFileSync(local as string, join(home, remote));
    return { host: h.name, ok: true, code: 0, stdout: "", stderr: "" };
  };
  return { exec, scp, calls, pushes };
}

describe("tree hash parity", () => {
  const web: Host = { name: "web", ssh: "web", os: "linux" };
  for (const [label, path] of [["sha256sum", undefined], ["shasum -a 256", "/usr/bin:/bin"]] as const) {
    test(`the bash inventory script hashes like the controller (${label})`, async () => {
      const home = temp("home");
      const outside = temp("outside");
      try {
        const dir = skill(join(home, ".agents", "skills"), "probe");
        write(join(dir, "sub", "deep", "a.txt"), "deep\n");
        write(join(dir, "with space.md"), "spaced\n");
        write(join(dir, ".hidden"), "hidden\n");
        write(join(dir, "node_modules", "x.js"), "skip");
        write(join(dir, "._probe"), "skip");
        write(join(dir, ".DS_Store"), "skip");
        write(join(outside, "target.md"), "linked file\n");
        write(join(outside, "tree", "inner.md"), "linked tree\n");
        symlinkSync(join(outside, "target.md"), join(dir, "link.md"));
        symlinkSync(join(outside, "tree"), join(dir, "linked-tree"));
        mkdirSync(join(home, ".agents", "skills", "empty"));
        write(join(home, ".agents", "skills", "empty", ".DS_Store"), "skip");
        mkdirSync(join(home, ".claude", "skills"), { recursive: true });
        symlinkSync("../../.agents/skills/probe", join(home, ".claude", "skills", "probe"));
        write(join(home, ".fleet-tools", "skills", "manifest.json"),
          JSON.stringify({ version: 1, skills: { probe: { hash: "0".repeat(64), set: "core", syncedAt: "2026-01-01T00:00:00Z" } } }));

        const { exec } = localBash(home, path);
        const { cmd } = inventoryScript(web, ["probe", "empty"]);
        const result = await exec(web, cmd);
        expect(result.ok).toBe(true);
        const inventory = parseInventory(result.stdout);
        expect(inventory.copies.get("probe")).toEqual([
          { root: ".agents", kind: "dir", hash: (await treeHash(dir)).hash },
          { root: ".claude", kind: "link" },
          { root: ".openclaw", kind: "missing" },
        ]);
        expect(inventory.copies.get("empty")![0]).toEqual({ root: ".agents", kind: "dir", hash: (await treeHash(join(home, ".agents", "skills", "empty"))).hash });
        expect(inventory.manifest.probe?.set).toBe("core");
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }
});

describe("Windows PowerShell scripts", () => {
  const pscheck = Bun.which("pscheck");
  test.skipIf(!pscheck)("inventory and apply scripts parse under Windows PowerShell 5.1", async () => {
    const dir = temp("ps");
    try {
      const win: Host = { name: "box", ssh: "box", os: "windows" };
      const files = [
        ["inventory.ps1", inventoryScript(win, ["alpha", "beta.v2"]).cmd],
        ["apply.ps1", applyScript(win, "abc-123", "fleet-skills-abc-123.tgz", [
          { name: "alpha", roots: [{ root: ".agents", op: "copy" }, { root: ".claude", op: "copy" }], next: `"alpha":{"hash":"h","set":"it's","syncedAt":"t"}`, previous: `"alpha":{"hash":"o","set":"core","syncedAt":"t"}` },
          { name: "beta.v2", roots: [{ root: ".agents", op: "copy" }], next: `"beta.v2":{"hash":"h","set":"core","syncedAt":"t"}` },
        ], [`"kept":{"hash":"k","set":"core","syncedAt":"t"}`]).cmd],
      ].map(([name, body]) => { const path = join(dir, name!); writeFileSync(path, body!); return path; });
      const proc = Bun.spawn([pscheck!, ...files], { stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect({ code, out, err }).toMatchObject({ code: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("skills sync", () => {
  const S = (home: string) => join(home, ".agents", "skills");

  function scenario() {
    const root = temp("src");
    const home = temp("remote");
    skill(root, "alpha", "---\nname: alpha\n---\nsource v2\n");
    skill(root, "beta");
    skill(root, "gamma");
    // alpha: edited on the host after a sync of some other version → drifted.
    skill(S(home), "alpha", "---\nname: alpha\n---\nhand edit\n");
    // beta: absent, but ~/.claude/skills/beta is a user symlink → left alone.
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    mkdirSync(join(home, "elsewhere"));
    symlinkSync(join(home, "elsewhere"), join(home, ".claude", "skills", "beta"));
    // gamma: an identical copy nobody recorded, already linked → adopted.
    skill(S(home), "gamma");
    mkdirSync(join(home, ".openclaw", "skills"), { recursive: true });
    for (const agent of [".claude", ".openclaw"])
      symlinkSync("../../.agents/skills/gamma", join(home, agent, "skills", "gamma"));
    write(join(home, ".fleet-tools", "skills", "manifest.json"), JSON.stringify({
      version: 1,
      skills: {
        alpha: { hash: "b".repeat(64), set: "core", syncedAt: "2026-01-01T00:00:00Z" },
        retired: { hash: "c".repeat(64), set: "core", syncedAt: "2026-01-01T00:00:00Z" },
      },
    }));
    const cfg: FleetConfig = {
      hosts: { web: { name: "web", ssh: "web", os: "linux" } },
      skills: { core: { hosts: "web", root, include: ["*"] } },
    };
    const cleanup = () => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); };
    return { root, home, cfg, cleanup };
  }
  const manifestOf = (home: string) =>
    JSON.parse(readFileSync(join(home, ".fleet-tools", "skills", "manifest.json"), "utf8")).skills as Record<string, { hash: string; set: string }>;

  test("holds a drifted skill without --force, applies the rest, then --force applies it", async () => {
    const { root, home, cfg, cleanup } = scenario();
    try {
      const remote = localBash(home);
      const deps = { exec: remote.exec, scp: remote.scp, toolOwned: new Map<string, string>() };

      const [held] = await syncSkills(cfg, "core", undefined, {}, deps);
      expect(held!.ok).toBe(false);
      expect(held!.error).toBeUndefined();
      expect(held!.orphans).toEqual(["retired"]);
      expect(held!.items.map(({ skill, state, action, ok }) => ({ skill, state, action, ok }))).toEqual([
        { skill: "alpha", state: "drifted", action: "held", ok: undefined },
        { skill: "beta", state: "missing", action: "apply", ok: true },
        { skill: "gamma", state: "current", action: "adopt", ok: undefined },
      ]);
      expect(held!.items[0]!.reason).toMatch(/--force/);
      expect(readFileSync(join(S(home), "alpha", "SKILL.md"), "utf8")).toContain("hand edit");
      expect(readFileSync(join(S(home), "beta", "SKILL.md"), "utf8")).toBe(readFileSync(join(root, "beta", "SKILL.md"), "utf8"));
      expect(readlinkSync(join(home, ".claude", "skills", "beta"))).toBe(join(home, "elsewhere"));
      expect(readlinkSync(join(home, ".openclaw", "skills", "beta"))).toBe("../../.agents/skills/beta");
      let manifest = manifestOf(home);
      expect(manifest.alpha!.hash).toBe("b".repeat(64));               // held: previous entry kept
      expect(manifest.beta!.hash).toBe((await treeHash(join(root, "beta"))).hash);
      expect(manifest.gamma!.hash).toBe((await treeHash(join(root, "gamma"))).hash);
      expect(manifest.retired).toBeDefined();                           // orphans are never removed
      // Lock released, archive and staging gone.
      expect(readdirSync(join(home, ".agents")).filter((n) => n.includes("lock"))).toEqual([]);
      expect(readdirSync(home).filter((n) => n.endsWith(".tgz"))).toEqual([]);
      expect(readdirSync(join(home, ".fleet-tools", "skills"))).toEqual(["manifest.json"]);

      const [forced] = await syncSkills(cfg, "core", undefined, { force: true }, deps);
      expect(forced!.ok).toBe(true);
      expect(forced!.items.find((i) => i.skill === "alpha")).toMatchObject({ state: "drifted", action: "apply", ok: true });
      expect(readFileSync(join(S(home), "alpha", "SKILL.md"), "utf8")).toContain("source v2");
      expect(readdirSync(S(home)).filter((n) => n.includes(".fleet-"))).toEqual([]);
      manifest = manifestOf(home);
      expect(manifest.alpha!.hash).toBe((await treeHash(join(root, "alpha"))).hash);

      const rows = await skillsStatus(cfg, ["core"], undefined, deps);
      expect(rows.filter((r) => r.state !== "orphan").map((r) => [r.skill, r.state])).toEqual([
        ["alpha", "current"], ["beta", "current"], ["gamma", "current"],
      ]);
      expect(rows.some((r) => r.adopt)).toBe(false);
      // The orphan stays listed and on disk.
      expect(rows.find((r) => r.state === "orphan")?.skill).toBe("retired");

      // A skill dropped from the set becomes an orphan and stays on the host.
      const narrowed: FleetConfig = { ...cfg, skills: { core: { ...cfg.skills!.core!, include: ["alpha", "gamma"] } } };
      const after = await skillsStatus(narrowed, ["core"], undefined, deps);
      expect(after.filter((r) => r.state === "orphan").map((r) => r.skill).sort()).toEqual(["beta", "retired"]);
      expect(existsSync(join(S(home), "beta", "SKILL.md"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("--dry-run plans without locking, pushing or writing", async () => {
    const { home, cfg, cleanup } = scenario();
    try {
      const remote = localBash(home);
      const before = readFileSync(join(home, ".fleet-tools", "skills", "manifest.json"), "utf8");
      const [plan] = await syncSkills(cfg, "core", undefined, { dryRun: true }, { exec: remote.exec, scp: remote.scp, toolOwned: new Map() });
      expect(plan!.dryRun).toBe(true);
      expect(plan!.items.map((i) => i.action)).toEqual(["held", "apply", "adopt"]);
      expect(remote.pushes).toEqual([]);
      expect(remote.calls.some((cmd) => cmd.includes("fleet-install-lock"))).toBe(false);
      expect(existsSync(join(S(home), "beta"))).toBe(false);
      expect(readFileSync(join(home, ".fleet-tools", "skills", "manifest.json"), "utf8")).toBe(before);
    } finally {
      cleanup();
    }
  });

  test("a host with deploy disabled refuses before any host is contacted", async () => {
    const { home, cfg, cleanup } = scenario();
    try {
      const remote = localBash(home);
      cfg.hosts.web!.disable = ["deploy"];
      await expect(syncSkills(cfg, "core", undefined, {}, { exec: remote.exec, scp: remote.scp, toolOwned: new Map() }))
        .rejects.toThrow(/deploy is disabled on web/);
      expect(remote.calls).toEqual([]);
      expect(lstatSync(join(S(home), "alpha")).isDirectory()).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a secret-looking file refuses the whole set before any exec or scp, dry run included", async () => {
    const { root, home, cfg, cleanup } = scenario();
    try {
      write(join(root, "beta", ".env.local"), "TOKEN=1\n");
      write(join(root, "gamma", "notes.md"), `token ${"ghp" + "_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}\n`);
      write(join(root, "gamma", ".env.example"), "TOKEN=\n");
      const before = readFileSync(join(home, ".fleet-tools", "skills", "manifest.json"), "utf8");
      const calls: string[] = [];
      const deps = {
        exec: async (h: Host, cmd: string): Promise<ExecResult> => { calls.push(cmd); return { host: h.name, ok: true, code: 0, stdout: "", stderr: "" }; },
        scp: async (h: Host): Promise<ExecResult> => { calls.push("scp"); return { host: h.name, ok: true, code: 0, stdout: "", stderr: "" }; },
        toolOwned: new Map<string, string>(),
      };
      for (const dryRun of [false, true]) {
        const refusal = syncSkills(cfg, "core", undefined, { force: true, dryRun }, deps);
        await expect(refusal).rejects.toThrow(/refusing to sync skill set core: 2 files look secret; nothing was sent/);
        const message = await refusal.catch((error: Error) => error.message);
        expect(message).toContain("  beta/.env.local: env file");
        expect(message).toContain("  gamma/notes.md: GitHub token");
        expect(message).toContain("skills.core.allowFiles");
        expect(message).not.toContain("a1B2c3");
      }
      expect(calls).toEqual([]);
      expect(readFileSync(join(home, ".fleet-tools", "skills", "manifest.json"), "utf8")).toBe(before);

      const allowed: FleetConfig = { ...cfg, skills: { core: { ...cfg.skills!.core!, allowFiles: ["beta/.env.local", "gamma/*.md"] } } };
      const remote = localBash(home);
      const [synced] = await syncSkills(allowed, "core", undefined, { force: true }, { exec: remote.exec, scp: remote.scp, toolOwned: new Map() });
      expect(synced!.ok, synced!.error).toBe(true);
      expect(remote.pushes.length).toBe(1);
    } finally {
      cleanup();
    }
  });
});
