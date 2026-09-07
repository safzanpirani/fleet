import { test, expect, describe, spyOn } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  fingerprint,
  fingerprintTools,
  hashFiles,
  installScript,
  mapPool,
  resolveTool,
  serializeToolSyncResults,
  shippedFiles,
  skillDestinations,
  stampSkill,
  syncTools,
  syncTool,
  toolDir,
  toolsStatus,
  toolSyncParallelism,
  toolSyncLockScript,
} from "../src/tools.ts";
import * as ssh from "../src/ssh.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import type { MultiToolSyncResult, ToolSyncResult } from "../src/tools.ts";

const host = (name: string, os: Host["os"]): Host => ({ name, ssh: name, os });

/** A throwaway tool tree: package.json + src/cli.ts + a bundled skill. */
function makeTool(version = "1.2.3"): string {
  const root = mkdtempSync(join(tmpdir(), "fleet-tool-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", version }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "cli.ts"), "console.log('hi')\n");
  mkdirSync(join(root, "skills", "demo"), { recursive: true });
  writeFileSync(join(root, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: a demo\n---\n\n# demo\n");
  return root;
}
const cfgFor = (root: string, extra: Record<string, unknown> = {}): FleetConfig => ({
  hosts: { web: host("web", "linux"), main: host("main", "windows") },
  tools: { demo: { root, ...extra } },
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function completeInOrder(
  names: string[],
  gates: Record<string, ReturnType<typeof deferred>>,
  finished: Record<string, ReturnType<typeof deferred>>,
): Promise<void> {
  for (const name of names) {
    gates[name]!.resolve();
    await finished[name]!.promise;
  }
}

describe("bounded deterministic concurrency", () => {
  test("hashing does not read beyond one batch while its first file is pending", async () => {
    const gate = deferred();
    const reads: string[] = [];
    const pending = hashFiles("/unused", ["a", "b", "c", "d"], undefined, {
      maxParallel: 2,
      readFile: async (path) => {
        reads.push(basename(path));
        if (path.endsWith("/a")) await gate.promise;
        return new TextEncoder().encode(path);
      },
    });
    await Bun.sleep(5);
    expect(reads).toEqual(["a", "b"]);
    gate.resolve();
    await pending;
    expect(reads).toEqual(["a", "b", "c", "d"]);
  });

  test("mapPool drains in-flight work before returning a failure", async () => {
    const gate = deferred();
    let settled = false;
    const pending = mapPool([0, 1], 2, async (n) => {
      if (n === 0) throw new Error("failed");
      await gate.promise;
    });
    void pending.catch(() => { settled = true; });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    gate.resolve();
    await expect(pending).rejects.toThrow("failed");
  });
  test("mapPool caps active work and returns input order after reverse completion", async () => {
    let active = 0;
    let peak = 0;
    const completed: number[] = [];
    const values = await mapPool([0, 1, 2, 3, 4, 5], 3, async (value) => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep((6 - value) * 3);
      completed.push(value);
      active--;
      return `value-${value}`;
    });

    expect(peak).toBe(3);
    expect(completed).not.toEqual([0, 1, 2, 3, 4, 5]);
    expect(values).toEqual(["value-0", "value-1", "value-2", "value-3", "value-4", "value-5"]);
  });

  test("recursive traversal is stable and caps concurrent directory reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-walk-"));
    try {
      for (let index = 0; index < 12; index++) {
        const directory = join(root, `dir-${String(index).padStart(2, "0")}`);
        mkdirSync(directory);
        writeFileSync(join(directory, "file.txt"), `${index}`);
      }
      let active = 0;
      let peak = 0;
      const files = await shippedFiles(root, [], {
        readDirectory: async (...args) => {
          active++;
          peak = Math.max(peak, active);
          await Bun.sleep(2);
          try { return await readdir(...args); }
          finally { active--; }
        },
      });

      expect(peak).toBe(8);
      expect(files).toEqual(
        readdirSync(root).sort().map((directory) => `${directory}/file.txt`),
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("tools list fingerprints at most four entries and retains registry order", async () => {
    const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"];
    let active = 0;
    let peak = 0;
    const completed: string[] = [];
    const fingerprints = await fingerprintTools({ hosts: {} } as FleetConfig, names, {
      fingerprint: async (_cfg, name) => {
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep((names.length - names.indexOf(name)) * 2);
        completed.push(name);
        active--;
        return { name, version: "1.0.0", hash: `hash-${name}`, files: 1, root: `/${name}` };
      },
    });

    expect(peak).toBe(4);
    expect(completed).not.toEqual(names);
    expect(fingerprints.map((result) => result instanceof Error ? result.message : result.name)).toEqual(names);
  });

  test("file reads can finish in reverse while hashing stays in path order", async () => {
    const rels = ["a", "b", "c", "d"];
    const completed: string[] = [];
    let active = 0;
    let peak = 0;
    const hash = await hashFiles("/unused", rels, undefined, {
      maxParallel: 4,
      readFile: async (path) => {
        const rel = path.split("/").pop()!;
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep((5 - rels.indexOf(rel)) * 2);
        completed.push(rel);
        active--;
        return new TextEncoder().encode(`contents-${rel}`);
      },
    });
    const expected = await hashFiles("/unused", rels, undefined, {
      maxParallel: 1,
      readFile: async (path) => new TextEncoder().encode(`contents-${basename(path)}`),
    });

    expect(peak).toBe(4);
    expect(completed).toEqual(["d", "c", "b", "a"]);
    expect(hash).toBe(expected);
  });

  test("hash framing distinguishes content that moves across file boundaries", async () => {
    const rels = ["a", "b"];
    const encode = (value: string) => new TextEncoder().encode(value);
    const left = await hashFiles("/unused", rels, undefined, {
      readFile: async (path) => encode(path.endsWith("/a") ? "" : "b"),
    });
    const right = await hashFiles("/unused", rels, undefined, {
      readFile: async (path) => encode(path.endsWith("/a") ? "b" : ""),
    });

    expect(left).not.toBe(right);
  });

  test("tree traversal fails closed and fingerprints symlink targets", async () => {
    await expect(shippedFiles("/unreadable", [], {
      readDirectory: async () => { throw new Error("EACCES"); },
    })).rejects.toThrow("EACCES");

    const root = mkdtempSync(join(tmpdir(), "fleet-links-"));
    const link = join(root, "entry");
    try {
      writeFileSync(join(root, "target-a"), "same bytes");
      writeFileSync(join(root, "target-b"), "same bytes");
      symlinkSync("target-a", link);
      const files = await shippedFiles(root, []);
      expect(files).toContain("entry");
      const before = await hashFiles(root, files);

      unlinkSync(link);
      symlinkSync("target-b", link);
      const after = await hashFiles(root, await shippedFiles(root, []));
      expect(after).not.toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("install scripts stop after a failed bun install", () => {
    const manifest = {
      tool: "demo", version: "1.0.0", hash: "abc123", syncedAt: "2026-08-31T00:00:00Z", dir: "$HOME/demo",
    };
    const posix = installScript(host("web", "linux"), { name: "demo" }, "$HOME/demo", manifest, "demo").cmd;
    expect(posix).toContain('(cd "$dir" && "$bun" install >/dev/null 2>&1)');
    expect(posix).not.toContain("|| true");
    expect(posix.indexOf('"$bun" install')).toBeLessThan(posix.indexOf("LAUNCHER"));

    const windows = installScript(host("main", "windows"), { name: "demo" }, "$env:USERPROFILE\\demo", manifest, "demo").cmd;
    expect(windows).toContain("$installCode=$LASTEXITCODE");
    expect(windows).toContain('if ($LASTEXITCODE -ne 0) { throw "tar extraction failed with exit $LASTEXITCODE" }');
    expect(windows.indexOf("tar extraction failed")).toBeLessThan(windows.indexOf("$installCode=0"));
    expect(windows).toContain('if ($installCode -ne 0) { throw "bun install failed with exit $installCode" }');
    expect(windows.indexOf("$installCode -ne 0")).toBeLessThan(windows.indexOf("Set-Content -Path"));
  });

  test("toolsStatus bounds fingerprint and unique-host fan-out while preserving order", async () => {
    const toolNames = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    const hostNames = Array.from({ length: 10 }, (_, index) => `host-${index}`);
    const cfg: FleetConfig = {
      hosts: Object.fromEntries(hostNames.map((name) => [name, host(name, "linux")])),
      tools: Object.fromEntries(toolNames.map((name) => [name, { root: `/${name}` }])),
    };
    const fingerprintCompletions: string[] = [];
    const manifestCompletions: string[] = [];
    let fingerprintActive = 0;
    let fingerprintPeak = 0;
    let manifestActive = 0;
    let manifestPeak = 0;
    const rows = await toolsStatus(cfg, toolNames, undefined, {
      fingerprint: async (_cfg, name) => {
        fingerprintActive++;
        fingerprintPeak = Math.max(fingerprintPeak, fingerprintActive);
        await Bun.sleep((toolNames.length - toolNames.indexOf(name)) * 2);
        fingerprintCompletions.push(name);
        fingerprintActive--;
        return { name, version: "1.0.0", hash: `hash-${name}`, files: 1, root: `/${name}` };
      },
      readManifests: async (target) => {
        manifestActive++;
        manifestPeak = Math.max(manifestPeak, manifestActive);
        await Bun.sleep((hostNames.length - hostNames.indexOf(target.name)) * 2);
        manifestCompletions.push(target.name);
        manifestActive--;
        return {
          manifests: toolNames.map((tool) => ({
            tool, version: "1.0.0", hash: `hash-${tool}`, syncedAt: "2026-08-30T00:00:00Z", dir: `/${tool}`,
          })),
        };
      },
    });

    expect(fingerprintPeak).toBe(4);
    expect(manifestPeak).toBe(8);
    expect(fingerprintCompletions).not.toEqual(toolNames);
    expect(manifestCompletions).not.toEqual(hostNames);
    expect(manifestCompletions).toHaveLength(hostNames.length);
    expect(rows.map((row) => `${row.tool}:${row.host}`)).toEqual(
      toolNames.flatMap((tool) => hostNames.map((target) => `${tool}:${target}`)),
    );
  });

  test("multi-tool sync caps work at two and buffers blocks in registry order", async () => {
    const names = ["alpha", "beta", "gamma", "delta"];
    let active = 0;
    let peak = 0;
    const completed: string[] = [];
    const fakeSync = async (_cfg: FleetConfig, name: string): Promise<ToolSyncResult[]> => {
      active++;
      peak = Math.max(peak, active);
      const index = names.indexOf(name);
      await Bun.sleep(index % 2 === 0 ? 8 : 2);
      completed.push(name);
      active--;
      return [];
    };
    const blocks = await syncTools({ hosts: {} } as FleetConfig, names, "all", { sync: fakeSync });

    expect(peak).toBe(2);
    expect(completed.slice(0, 2)).toEqual(["beta", "alpha"]);
    expect(completed).not.toEqual(names);
    expect(blocks.map((block) => block.tool)).toEqual(names);
  });

  test("multi-tool sync JSON is one parseable value in registry order", () => {
    const result = (tool: string): ToolSyncResult => ({
      tool,
      host: "web",
      ok: true,
      dir: `/${tool}`,
      version: "1.0.0",
      hash: `hash-${tool}`,
      result: { host: "web", ok: true, code: 0, stdout: "", stderr: "" },
    });
    const blocks: MultiToolSyncResult[] = [
      { tool: "alpha", results: [result("alpha")] },
      { tool: "beta", results: [result("beta")] },
      { tool: "gamma", results: [], error: "failed" },
    ];

    const stdout = serializeToolSyncResults(blocks, true);
    const parsed = JSON.parse(stdout) as MultiToolSyncResult[];
    expect(parsed.map((block) => block.tool)).toEqual(["alpha", "beta", "gamma"]);
    expect(parsed[0]?.results[0]?.tool).toBe("alpha");
    expect(stdout).not.toContain("◎");
    expect(stdout).not.toContain("\u001b[");
  });

  test("tools sync --all --json writes only one ordered JSON value", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-sync-json-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      for (const command of ["ssh", "scp"]) {
        const path = join(bin, command);
        writeFileSync(path, "#!/bin/sh\nexit 0\n");
        chmodSync(path, 0o755);
      }
      const tools = Object.fromEntries(["alpha", "beta", "gamma"].map((name) => {
        const toolRoot = join(root, name);
        mkdirSync(join(toolRoot, "src"), { recursive: true });
        writeFileSync(join(toolRoot, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
        writeFileSync(join(toolRoot, "src", "cli.ts"), "console.log('ok')\n");
        return [name, { root: toolRoot }];
      }));
      const config = join(root, "fleet.config.json");
      writeFileSync(config, JSON.stringify({
        hosts: { local: { ssh: "local", os: "linux" } },
        tools,
      }));
      const run = async (extra: string[] = []) => {
        const proc = Bun.spawn([
          "bun", join(import.meta.dir, "../src/cli.ts"),
          "tools", "sync", "--all", "local", "--no-skill", "--json", ...extra,
        ], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FLEET_CONFIG: config },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout, stderr, code };
      };
      const { stdout, stderr, code } = await run();
      const serial = await run(["--max-parallel", "1"]);

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(serial.code).toBe(0);
      expect(serial.stderr).toBe("");
      const parsed = JSON.parse(stdout) as MultiToolSyncResult[];
      expect(parsed.map((block) => block.tool)).toEqual(["alpha", "beta", "gamma"]);
      expect(parsed.every((block) => block.results[0]?.host === "local")).toBe(true);
      expect(JSON.parse(serial.stdout)).toEqual(parsed);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("--max-parallel is accepted only for multi-tool sync", () => {
    expect(toolSyncParallelism(4)).toBe(2);
    expect(toolSyncParallelism(4, "3")).toBe(3);
    expect(() => toolSyncParallelism(1, "3")).toThrow(/only valid with multi-tool sync/);
    expect(() => toolSyncParallelism(4, "0")).toThrow(/integer/);
    expect(() => toolSyncParallelism(4, "1.5")).toThrow(/integer/);
  });
});

describe("serial and default concurrency equality", () => {
  test("mapPool returns the maxParallel=1 result after reverse concurrent completion", async () => {
    const names = ["alpha", "beta", "gamma", "delta"];
    const serial = await mapPool(names, 1, async (name, index) => `${index}:${name}`);
    const gates = Object.fromEntries(names.map((name) => [name, deferred()])) as Record<string, ReturnType<typeof deferred>>;
    const finished = Object.fromEntries(names.map((name) => [name, deferred()])) as Record<string, ReturnType<typeof deferred>>;
    const allStarted = deferred();
    const completed: string[] = [];
    let started = 0;
    const pending = mapPool(names, names.length, async (name, index) => {
      started += 1;
      if (started === names.length) allStarted.resolve();
      await gates[name]!.promise;
      completed.push(name);
      finished[name]!.resolve();
      return `${index}:${name}`;
    });

    await allStarted.promise;
    await completeInOrder([...names].reverse(), gates, finished);

    expect(completed).toEqual([...names].reverse());
    expect(await pending).toEqual(serial);
  });

  test("shippedFiles default traversal equals maxParallel=1 after reverse directory reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-walk-equality-"));
    const names = ["alpha", "beta", "gamma", "delta"];
    try {
      for (const name of names) {
        mkdirSync(join(root, name));
        writeFileSync(join(root, name, `${name}.txt`), name);
      }
      const serial = await shippedFiles(root, [], { maxParallel: 1 });
      const gates = Object.fromEntries(names.map((name) => [name, deferred()])) as Record<string, ReturnType<typeof deferred>>;
      const finished = Object.fromEntries(names.map((name) => [name, deferred()])) as Record<string, ReturnType<typeof deferred>>;
      const allStarted = deferred();
      const completed: string[] = [];
      let started = 0;
      const pending = shippedFiles(root, [], {
        readDirectory: async (...args) => {
          if (args[0] === root) return readdir(...args);
          const name = basename(args[0]);
          started += 1;
          if (started === names.length) allStarted.resolve();
          await gates[name]!.promise;
          const entries = await readdir(...args);
          completed.push(name);
          finished[name]!.resolve();
          return entries;
        },
      });

      await allStarted.promise;
      await completeInOrder([...names].reverse(), gates, finished);

      expect(completed).toEqual([...names].reverse());
      expect(await pending).toEqual(serial);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("hashFiles default reads equal maxParallel=1 after reverse completion", async () => {
    const rels = ["alpha", "beta", "gamma", "delta"];
    const contents = (path: string) => new TextEncoder().encode(`contents-${basename(path)}`);
    const serial = await hashFiles("/unused", rels, undefined, {
      maxParallel: 1,
      readFile: async (path) => contents(path),
    });
    const gates = Object.fromEntries(rels.map((rel) => [rel, deferred()])) as Record<string, ReturnType<typeof deferred>>;
    const finished = Object.fromEntries(rels.map((rel) => [rel, deferred()])) as Record<string, ReturnType<typeof deferred>>;
    const allStarted = deferred();
    const completed: string[] = [];
    let started = 0;
    const pending = hashFiles("/unused", rels, undefined, {
      readFile: async (path) => {
        const rel = basename(path);
        started += 1;
        if (started === rels.length) allStarted.resolve();
        await gates[rel]!.promise;
        completed.push(rel);
        finished[rel]!.resolve();
        return contents(path);
      },
    });

    await allStarted.promise;
    await completeInOrder([...rels].reverse(), gates, finished);

    expect(completed).toEqual([...rels].reverse());
    expect(await pending).toBe(serial);
  });

  test("fingerprintTools default fan-out equals a maxParallel=1 registry pass", async () => {
    const names = ["alpha", "beta", "gamma", "delta"];
    const cfg = { hosts: {} } as FleetConfig;
    const valueFor = (name: string) => ({
      name, version: "1.0.0", hash: `hash-${name}`, files: name.length, root: `/${name}`,
    });
    const serial = await mapPool(names, 1, async (name) => valueFor(name));
    const gates = Object.fromEntries(names.map((name) => [name, deferred()])) as Record<string, ReturnType<typeof deferred>>;
    const finished = Object.fromEntries(names.map((name) => [name, deferred()])) as Record<string, ReturnType<typeof deferred>>;
    const allStarted = deferred();
    const completed: string[] = [];
    let started = 0;
    const pending = fingerprintTools(cfg, names, {
      fingerprint: async (_cfg, name) => {
        started += 1;
        if (started === names.length) allStarted.resolve();
        await gates[name]!.promise;
        completed.push(name);
        finished[name]!.resolve();
        return valueFor(name);
      },
    });

    await allStarted.promise;
    await completeInOrder([...names].reverse(), gates, finished);

    expect(completed).toEqual([...names].reverse());
    expect(await pending).toEqual(serial);
  });

  test("toolsStatus default fan-out equals maxParallel=1 tool and host passes", async () => {
    const toolNames = ["alpha", "beta", "gamma"];
    const hostNames = ["host-a", "host-b", "host-c"];
    const cfg: FleetConfig = {
      hosts: Object.fromEntries(hostNames.map((name) => [name, host(name, "linux")])),
      tools: Object.fromEntries(toolNames.map((name) => [name, { root: `/${name}` }])),
    };
    const fingerprintFor = async (_cfg: FleetConfig, name: string) => ({
      name, version: "1.0.0", hash: `hash-${name}`, files: 1, root: `/${name}`,
    });
    const manifestsFor = async (target: Host) => ({
      manifests: toolNames.map((tool) => ({
        tool,
        version: "1.0.0",
        hash: target.name === "host-b" ? `old-${tool}` : `hash-${tool}`,
        syncedAt: "2026-08-30T00:00:00Z",
        dir: `/${tool}`,
      })),
    });
    const serial = (await mapPool(toolNames, 1, async (tool) =>
      (await mapPool(hostNames, 1, async (hostName) =>
        toolsStatus(cfg, [tool], hostName, {
          fingerprint: fingerprintFor,
          readManifests: manifestsFor,
        })
      )).flat()
    )).flat();

    const fingerprintGates = Object.fromEntries(toolNames.map((name) => [name, deferred()])) as Record<string, ReturnType<typeof deferred>>;
    const fingerprintFinished = Object.fromEntries(toolNames.map((name) => [name, deferred()])) as Record<string, ReturnType<typeof deferred>>;
    const fingerprintsStarted = deferred();
    let fingerprintCount = 0;
    const hostGates = Object.fromEntries(hostNames.map((name) => [name, deferred()])) as Record<string, ReturnType<typeof deferred>>;
    const hostFinished = Object.fromEntries(hostNames.map((name) => [name, deferred()])) as Record<string, ReturnType<typeof deferred>>;
    const hostsStarted = deferred();
    let hostCount = 0;
    const pending = toolsStatus(cfg, toolNames, undefined, {
      fingerprint: async (...args) => {
        const name = args[1];
        fingerprintCount += 1;
        if (fingerprintCount === toolNames.length) fingerprintsStarted.resolve();
        await fingerprintGates[name]!.promise;
        const result = await fingerprintFor(...args);
        fingerprintFinished[name]!.resolve();
        return result;
      },
      readManifests: async (target) => {
        hostCount += 1;
        if (hostCount === hostNames.length) hostsStarted.resolve();
        await hostGates[target.name]!.promise;
        const result = await manifestsFor(target);
        hostFinished[target.name]!.resolve();
        return result;
      },
    });

    await fingerprintsStarted.promise;
    await completeInOrder([...toolNames].reverse(), fingerprintGates, fingerprintFinished);
    await hostsStarted.promise;
    await completeInOrder([...hostNames].reverse(), hostGates, hostFinished);

    expect(await pending).toEqual(serial);
  });

  test("syncTools default pool equals maxParallel=1 after reverse completion", async () => {
    const names = ["alpha", "beta"];
    const cfg = { hosts: {} } as FleetConfig;
    const resultFor = (tool: string): ToolSyncResult[] => [{
      tool,
      host: "web",
      ok: true,
      dir: `/${tool}`,
      version: "1.0.0",
      hash: `hash-${tool}`,
      result: { host: "web", ok: true, code: 0, stdout: tool, stderr: "" },
    }];
    const serial = await syncTools(cfg, names, "all", {
      maxParallel: 1,
      sync: async (_cfg, name) => resultFor(name),
    });
    const gates = Object.fromEntries(names.map((name) => [name, deferred()])) as Record<string, ReturnType<typeof deferred>>;
    const finished = Object.fromEntries(names.map((name) => [name, deferred()])) as Record<string, ReturnType<typeof deferred>>;
    const allStarted = deferred();
    const completed: string[] = [];
    let started = 0;
    const pending = syncTools(cfg, names, "all", {
      sync: async (_cfg, name) => {
        started += 1;
        if (started === names.length) allStarted.resolve();
        await gates[name]!.promise;
        completed.push(name);
        finished[name]!.resolve();
        return resultFor(name);
      },
    });

    await allStarted.promise;
    await completeInOrder([...names].reverse(), gates, finished);

    expect(completed).toEqual([...names].reverse());
    expect(await pending).toEqual(serial);
  });
});

describe("resolveTool", () => {
  test("names the known tools when one is missing", () => {
    const cfg = cfgFor("/nope");
    expect(() => resolveTool(cfg, "ghost")).toThrow(/unknown tool 'ghost'.*demo/s);
  });
  test("says so when there is no registry at all", () => {
    expect(() => resolveTool({ hosts: {} } as FleetConfig, "demo")).toThrow(/no `tools` block/);
  });
});

describe("toolDir", () => {
  test("per-OS defaults", () => {
    expect(toolDir({ name: "tg" }, host("web", "linux"))).toBe("$HOME/tg");
    expect(toolDir({ name: "tg" }, host("main", "windows"))).toBe("$env:USERPROFILE\\tg");
  });
  test("explicit dir wins on every OS", () => {
    expect(toolDir({ name: "tg", dir: "/opt/tg" }, host("web", "linux"))).toBe("/opt/tg");
  });
});

describe("skillDestinations", () => {
  test("installs paired skills for every supported agent on POSIX", async () => {
    expect(await skillDestinations(host("web", "linux"), "fleet")).toEqual([
      ".claude/skills/fleet/SKILL.md",
      ".agents/skills/fleet/SKILL.md",
      ".openclaw/skills/fleet/SKILL.md",
    ]);
  });
});

async function localScript(home: string, cmd: string): Promise<ssh.ExecResult> {
  const proc = Bun.spawn(["bash", "-s"], {
    cwd: home,
    env: { ...process.env, HOME: home, PATH: `${join(home, "bin")}:${process.env.PATH}` },
    stdin: new TextEncoder().encode(cmd), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { host: "web", ok: code === 0, code, stdout, stderr };
}

describe("tool installation transactions", () => {
  test("Windows locks use exclusive create and close the owner stream", () => {
    const h = host("main", "windows");
    const acquire = toolSyncLockScript(h, "$env:USERPROFILE\\demo", "owner-one").cmd;
    expect(acquire).toContain("[System.IO.FileMode]::CreateNew");
    expect(acquire).toContain("[System.IO.FileShare]::None");
    expect(acquire).toContain("$lockStream.Write($ownerBytes, 0, $ownerBytes.Length)");
    expect(acquire).toContain("finally { $lockStream.Dispose() }");
    expect(acquire).not.toContain("New-Item -ItemType Directory -Path $lock");
    const release = toolSyncLockScript(h, "$env:USERPROFILE\\demo", "owner-one", true).cmd;
    expect(release.indexOf("[System.IO.File]::ReadAllText($lock)")).toBeLessThan(release.indexOf("[System.IO.File]::Delete($lock)"));
  });

  test("destination locks reject overlap and require the same owner for release", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-lock-"));
    try {
      const h = host("web", "linux");
      const run = (token: string, release = false) => localScript(home,
        toolSyncLockScript(h, "$HOME/custom-install", token, release).cmd);
      expect((await run("first")).ok).toBe(true);
      const blocked = await run("second");
      expect(blocked.ok).toBe(false);
      expect(blocked.stderr).toContain("installation locked");
      expect((await run("second", true)).ok).toBe(false);
      expect((await run("first", true)).ok).toBe(true);
      expect((await run("second")).ok).toBe(true);
      expect((await run("second", true)).ok).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("sync ships its fingerprinted snapshot and records skipped skills truthfully", async () => {
    const root = makeTool();
    const home = mkdtempSync(join(tmpdir(), "fleet-sync-host-"));
    const cfg = cfgFor(root, { exclude: ["skills", "*.log", "src/private/**"] });
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(root, "src", "trace.log"), "excluded");
    mkdirSync(join(root, "src", "private"));
    writeFileSync(join(root, "src", "private", "hidden.ts"), "excluded");
    writeFileSync(join(root, "line\nbreak.txt"), "unusual filename");
    symlinkSync("src/cli.ts", join(root, "entry-link"));
    const initial = await fingerprint(cfg, "demo");
    const archives: string[] = [];
    const localArchives: string[] = [];
    let editOnUpload = true;
    const execute = spyOn(ssh, "exec").mockImplementation(async (_h, cmd) => localScript(home, cmd));
    const transfer = spyOn(ssh, "scp").mockImplementation(async (_h, local, remote) => {
      if (typeof local !== "string") throw new Error("unexpected multi-file copy");
      await mkdir(join(home, remote, ".."), { recursive: true });
      await copyFile(local, join(home, remote));
      if (remote.endsWith(".tgz")) {
        archives.push(remote);
        localArchives.push(local);
        if (editOnUpload) {
          editOnUpload = false;
          writeFileSync(join(root, "src", "cli.ts"), "edited during upload");
          writeFileSync(join(root, "skills", "demo", "SKILL.md"), "edited skill during upload");
        }
      }
      return { host: "web", ok: true, code: 0, stdout: "", stderr: "" };
    });
    try {
      const [installed] = await syncTool(cfg, "demo", "web");
      expect(installed?.ok, installed?.error).toBe(true);
      expect(installed?.hash).toBe(initial.hash);
      expect(await Bun.file(join(home, "demo", "src", "cli.ts")).text()).toBe("console.log('hi')\n");
      expect(await Bun.file(join(home, "demo", "line\nbreak.txt")).text()).toBe("unusual filename");
      expect(await Bun.file(join(home, "demo", "entry-link")).text()).toBe("console.log('hi')\n");
      expect(await Bun.file(join(home, "demo", "src", "trace.log")).exists()).toBe(false);
      expect(await Bun.file(join(home, "demo", "src", "private", "hidden.ts")).exists()).toBe(false);
      const manifestPath = join(home, ".fleet-tools", "demo.json");
      expect((await Bun.file(manifestPath).json()).skill).toBe(initial.skillHash);
      expect(await Bun.file(join(home, ".agents", "skills", "demo", "SKILL.md")).text()).toContain("# demo");

      const [skipped] = await syncTool(cfg, "demo", "web", { skill: false });
      expect(skipped?.ok, skipped?.error).toBe(true);
      const skippedManifest = await Bun.file(manifestPath).json();
      expect(skippedManifest.skillSkipped).toBe(true);
      expect(skippedManifest.skill).toBeUndefined();
      expect(skippedManifest.hash).toBe(`skill-skipped:${skippedManifest.sourceHash}`);
      expect((await toolsStatus(cfg, ["demo"], "web"))[0]?.state).toBe("stale");
      const legacyRows = await toolsStatus(cfg, ["demo"], "web", {
        fingerprint: async () => ({ name: "demo", version: "1.2.3", hash: skippedManifest.sourceHash, files: 1, root }),
      });
      expect(legacyRows[0]?.state).toBe("stale");

      const [resynced] = await syncTool(cfg, "demo", "web");
      expect(resynced?.ok, resynced?.error).toBe(true);
      expect((await toolsStatus(cfg, ["demo"], "web"))[0]?.state).toBe("current");
      expect(new Set(archives).size).toBe(3);
      expect(new Set(localArchives).size).toBe(3);
      for (const path of localArchives) expect(await Bun.file(path).exists()).toBe(false);
      expect(readdirSync(home).some((name) => name.endsWith(".tgz") || name.endsWith(".fleet-install-lock"))).toBe(false);
    } finally {
      transfer.mockRestore(); execute.mockRestore();
      rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
    }
  });

  test("a failed archive upload releases the installation lock", async () => {
    const root = makeTool();
    const home = mkdtempSync(join(tmpdir(), "fleet-sync-failed-"));
    const execute = spyOn(ssh, "exec").mockImplementation(async (_h, cmd) => localScript(home, cmd));
    const transfer = spyOn(ssh, "scp").mockRejectedValue(new Error("upload failed"));
    try {
      const [result] = await syncTool(cfgFor(root), "demo", "web");
      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("upload failed");
      expect(readdirSync(home).some((name) => name.endsWith(".fleet-install-lock"))).toBe(false);
      expect(await Bun.file(join(home, ".fleet-tools", "demo.json")).exists()).toBe(false);
    } finally {
      transfer.mockRestore(); execute.mockRestore();
      rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
    }
  });

  for (const failure of [124, 255, "throw"] as const) {
    test(`an unconfirmed installer (${failure}) retains its lock and archive`, async () => {
      const root = makeTool();
      const home = mkdtempSync(join(tmpdir(), "fleet-sync-unconfirmed-"));
      const execute = spyOn(ssh, "exec").mockImplementation(async (_h, cmd) => {
        if (cmd.includes("tar -xzf")) {
          if (failure === "throw") throw new Error("connection lost");
          return { host: "web", ok: false, code: failure, stdout: "", stderr: "connection lost" };
        }
        return localScript(home, cmd);
      });
      const transfer = spyOn(ssh, "scp").mockImplementation(async (_h, local, remote) => {
        if (typeof local !== "string") throw new Error("unexpected sources");
        await copyFile(local, join(home, remote));
        return { host: "web", ok: true, code: 0, stdout: "", stderr: "" };
      });
      try {
        const [result] = await syncTool(cfgFor(root), "demo", "web", { skill: false });
        expect(result?.ok).toBe(false);
        expect(result?.error).toContain("outcome is unconfirmed");
        expect(readdirSync(home).some((name) => name.endsWith(".tgz"))).toBe(true);
        expect(await Bun.file(join(home, "demo.fleet-install-lock", "owner")).exists()).toBe(true);
      } finally {
        transfer.mockRestore(); execute.mockRestore();
        rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

describe("fingerprint", () => {
  test("reads the version and finds the bundled skill", async () => {
    const root = makeTool();
    try {
      const fp = await fingerprint(cfgFor(root), "demo");
      expect(fp.version).toBe("1.2.3");
      expect(fp.hash).toHaveLength(12);
      expect(fp.skillPath).toBe(join(root, "skills", "demo", "SKILL.md"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("is stable across calls but moves when any shipped byte changes", async () => {
    const root = makeTool();
    try {
      const cfg = cfgFor(root);
      const a = await fingerprint(cfg, "demo");
      expect((await fingerprint(cfg, "demo")).hash).toBe(a.hash);
      writeFileSync(join(root, "src", "cli.ts"), "console.log('changed')\n");
      expect((await fingerprint(cfg, "demo")).hash).not.toBe(a.hash);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a skill-only edit still moves the hash", async () => {
    const root = makeTool();
    try {
      const cfg = cfgFor(root);
      const a = await fingerprint(cfg, "demo");
      writeFileSync(join(root, "skills", "demo", "SKILL.md"),
        "---\nname: demo\ndescription: a demo\n---\n\n# demo\n\nnew guidance\n");
      // Otherwise every box reports "current" while running yesterday's instructions.
      expect((await fingerprint(cfg, "demo")).hash).not.toBe(a.hash);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("excluded dirs do not affect the hash", async () => {
    const root = makeTool();
    try {
      const cfg = cfgFor(root);
      const a = await fingerprint(cfg, "demo");
      mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
      writeFileSync(join(root, "node_modules", "junk", "x.js"), "whatever");
      expect((await fingerprint(cfg, "demo")).hash).toBe(a.hash);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a missing root fails loudly rather than shipping nothing", async () => {
    await expect(fingerprint(cfgFor("/definitely/not/here"), "demo")).rejects.toThrow(/not a directory/);
  });

  test("an explicit skill path that does not exist is an error, not a silent skip", async () => {
    const root = makeTool();
    try {
      await expect(fingerprint(cfgFor(root, { skill: "docs/NOPE.md" }), "demo"))
        .rejects.toThrow(/points at a missing file/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("stampSkill", () => {
  const write = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-skill-"));
    const p = join(dir, "SKILL.md");
    writeFileSync(p, body);
    return p;
  };

  test("inserts version + updated right after name", async () => {
    const p = write("---\nname: demo\ndescription: d\n---\n\nbody\n");
    expect(await stampSkill(p, "1.0.0", "2026-08-05")).toBe(true);
    const out = await Bun.file(p).text();
    expect(out).toStartWith("---\nname: demo\nversion: 1.0.0\nupdated: 2026-08-05\ndescription: d\n---\n");
    expect(out).toEndWith("\nbody\n");
  });

  test("is idempotent — re-stamping the same values rewrites nothing", async () => {
    const p = write("---\nname: demo\ndescription: d\n---\n\nbody\n");
    await stampSkill(p, "1.0.0", "2026-08-05");
    expect(await stampSkill(p, "1.0.0", "2026-08-05")).toBe(false);
  });

  test("replaces an existing stamp instead of appending a second one", async () => {
    const p = write("---\nname: demo\nversion: 0.9.0\nupdated: 2020-01-01\ndescription: d\n---\n\nbody\n");
    await stampSkill(p, "1.0.0", "2026-08-05");
    const out = await Bun.file(p).text();
    expect(out.match(/^version:/gm)).toHaveLength(1);
    expect(out).toContain("version: 1.0.0");
    expect(out).not.toContain("0.9.0");
  });

  test("refuses a file with no frontmatter rather than corrupting it", async () => {
    const p = write("# just a heading\n");
    await expect(stampSkill(p, "1.0.0", "2026-08-05")).rejects.toThrow(/no YAML frontmatter/);
    expect(await Bun.file(p).text()).toBe("# just a heading\n");
  });
});
