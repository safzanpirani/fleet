import { describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployOne } from "../src/core.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import type { ExecResult } from "../src/ssh.ts";

const ok = (host: string): ExecResult => ({ host, ok: true, code: 0, stdout: "", stderr: "" });

describe("deployment isolation", () => {
  test("each deployment uses its own remote archive and releases its lock after failure", async () => {
    const host: Host = { name: "local", ssh: "unused", os: "linux" };
    const cfg: FleetConfig = { hosts: { local: host } };
    const archives: string[] = [];
    const commands: string[] = [];
    for (let i = 0; i < 2; i++) {
      const result = await deployOne(cfg, host, "unused.tgz", false, {
        exec: async (h, command) => { commands.push(command); return ok(h.name); },
        scp: async (h, _local, remote) => { archives.push(remote); return { ...ok(h.name), ok: false, code: 1, stderr: "upload failed" }; },
      });
      expect(result.ok).toBe(false);
    }
    expect(new Set(archives).size).toBe(2);
    expect(commands).toHaveLength(4);
    expect(commands[1]).toContain(archives[0]!);
    expect(commands[3]).toContain(archives[1]!);
    expect(commands[1]).toContain("rmdir");
  });

  test("unconfirmed installation retains the lock and never retries or restarts", async () => {
    const host: Host = { name: "local", ssh: "unused", os: "linux" };
    const cfg: FleetConfig = { hosts: { local: host } };
    for (const code of [124, 255]) {
      let installs = 0, restarts = 0;
      const commands: string[] = [];
      const result = await deployOne(cfg, host, "unused.tgz", false, {
        exec: async (h, command) => {
          commands.push(command);
          if (command.includes("tar -xzf")) { installs++; return { ...ok(h.name), ok: false, code }; }
          return ok(h.name);
        },
        scp: async (h) => ok(h.name),
        restart: async () => { restarts++; return []; },
      });
      expect(result.ok).toBe(false);
      expect(result.result.stderr).toContain("unconfirmed");
      expect(commands).toHaveLength(2);
      expect(installs).toBe(1);
      expect(restarts).toBe(0);
    }
  });

  test("POSIX deployment makes the active launcher execute the newly extracted source", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-deploy-test-"));
    try {
      const home = join(root, "home");
      const source = join(root, "source");
      const bin = join(home, ".local", "bin");
      await mkdir(join(source, "src"), { recursive: true });
      await mkdir(bin, { recursive: true });
      await writeFile(join(source, "package.json"), JSON.stringify({ name: "fleet-fixture", type: "module" }));
      await writeFile(join(source, "src", "cli.ts"), "console.log('new-fleet-source')\n");
      const fakeBun = join(root, "bun");
      await writeFile(fakeBun, `#!/bin/sh\nif [ "$1" = install ]; then exit 0; fi\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`);
      await chmod(fakeBun, 0o755);
      await writeFile(join(bin, "fleet"), "#!/bin/sh\necho old-fleet-source\n");
      await chmod(join(bin, "fleet"), 0o755);
      const archive = join(root, "source.tgz");
      expect(await Bun.spawn(["tar", "czf", archive, "-C", source, "."]).exited).toBe(0);
      const host: Host = { name: "local", ssh: "unused", os: "linux", deploy: { bun: fakeBun } };
      const cfg: FleetConfig = { hosts: { local: host } };
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
      const result = await deployOne(cfg, host, archive, false, {
        exec: async (h, command) => {
          const proc = Bun.spawn(["bash", "-s"], { env, stdin: new TextEncoder().encode(command), stdout: "pipe", stderr: "pipe" });
          const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
          return { host: h.name, ok: code === 0, code, stdout, stderr };
        },
        scp: async (h, local, remote) => { await copyFile(local as string, join(home, remote)); return ok(h.name); },
      });
      expect(result.ok, result.result.stderr).toBe(true);
      const active = Bun.spawn(["fleet"], { env, stdout: "pipe", stderr: "pipe" });
      expect((await new Response(active.stdout).text()).trim()).toBe("new-fleet-source");
      expect(await active.exited).toBe(0);
      expect(await readFile(join(home, "fleet", "src", "cli.ts"), "utf8")).toContain("new-fleet-source");
      expect((await readdir(home)).some((name) => name.includes("install-lock") || name.endsWith(".tgz"))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
