import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetConfig, Host } from "../src/config.ts";
import { validateConfig } from "../src/config.ts";
import { fingerprint, installScript, syncTool, toolsStatus, type ToolManifest } from "../src/tools.ts";

const target: Host = { name: "test", ssh: "test", os: process.platform === "darwin" ? "mac" : "linux" };
const manifest: ToolManifest = { tool: "demo", dir: "unused", version: "1", hash: "new", syncedAt: "2026-09-08", compiled: true };

async function run(command: string[], cwd?: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test("compiled sync atomically updates a native executable and preserves it on build or smoke failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet compiled "));
  const source = join(root, "source");
  const launcher = join(root, ".local/bin/demo");
  const manifestPath = join(root, ".fleet-tools/demo.json");
  try {
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "package.json"), '{"name":"demo","version":"1.0.0"}');
    const install = async (text: string) => {
      await writeFile(join(source, "src/cli.ts"), text);
      expect((await run(["tar", "czf", join(root, "demo-sync.tgz"), "-C", source, "."])).code).toBe(0);
      const script = installScript(target, { name: "demo", compile: true }, join(root, "demo"), manifest, "demo");
      return run(["bash", "-c", script.cmd.replaceAll("$HOME", root)]);
    };
    const first = await install('console.log("first")');
    expect(first.code, first.stderr).toBe(0);
    expect((await run([launcher])).stdout.trim()).toBe("first");
    expect((await readFile(launcher)).subarray(0, 2).toString()).not.toBe("#!");
    expect(JSON.parse(await readFile(manifestPath, "utf8")).compiled).toBe(true);

    const second = await install('console.log("second")');
    expect(second.code, second.stderr).toBe(0);
    expect((await run([launcher])).stdout.trim()).toBe("second");
    const goodBinary = await readFile(launcher);
    const goodManifest = await readFile(manifestPath, "utf8");

    for (const broken of ['const = invalid syntax', 'process.exit(23)']) {
      const failed = await install(broken);
      expect(failed.code).not.toBe(0);
      expect(await readFile(launcher)).toEqual(goodBinary);
      expect(await readFile(manifestPath, "utf8")).toBe(goodManifest);
      expect(await readdir(join(root, ".local/bin"))).toEqual(["demo"]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

test("installation mode changes invalidate the manifest without invalidating legacy source installs", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-compile-status-"));
  try {
    await writeFile(join(root, "package.json"), '{"version":"1"}');
    const cfg: FleetConfig = { hosts: { test: target }, tools: { demo: { root } } };
    const source = await fingerprint(cfg, "demo");
    cfg.tools!.demo!.compile = true;
    const compiled = await fingerprint(cfg, "demo");
    expect(compiled.hash).not.toBe(source.hash);
    expect(compiled.sourceHash).toBe(source.sourceHash);
    const previous: ToolManifest = { ...manifest, hash: source.hash, sourceHash: source.sourceHash, skill: source.skillHash, compiled: undefined };
    const status = async (requested: typeof source, installed: ToolManifest) => toolsStatus(cfg, ["demo"], "test", {
      fingerprint: async () => requested,
      readManifests: async () => ({ manifests: [installed] }),
    });
    expect((await status(compiled, previous))[0]?.state).toBe("stale");
    expect((await status(source, previous))[0]?.state).toBe("current");
    const installed = { ...previous, hash: compiled.hash, compiled: true };
    expect((await status(compiled, installed))[0]?.state).toBe("current");
    expect((await status(source, installed))[0]?.state).toBe("stale");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("compile configuration is boolean and Windows targets fail before source reads or sync", async () => {
  const cfg: FleetConfig = { hosts: { test: { ...target, os: "windows" } }, tools: { demo: { root: "/missing", compile: true } } };
  expect(() => validateConfig(cfg, "test")).not.toThrow();
  await expect(syncTool(cfg, "demo", "test")).rejects.toThrow("no hosts were synced");
  expect(() => installScript(cfg.hosts.test!, { name: "demo", compile: true }, "ignored", manifest, "demo")).toThrow("Linux and macOS only");
  for (const value of ["true", 1, null, {}]) {
    cfg.tools!.demo!.compile = value as boolean;
    expect(() => validateConfig(cfg, "test")).toThrow("compile must be a boolean");
  }
});
