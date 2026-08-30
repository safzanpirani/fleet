import { test, expect, describe } from "bun:test";
import {
  deployHosts, deployScript, logsCmd, parseLeadingFlags, parseRecipeStep, resolveDeploySourceRoot,
  restartCmd, routeSelector, statusCmd, waitFor, writeRemoteFile,
} from "../src/core.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const routeHost = (name: string): Host => ({ name, ssh: name, os: "windows" });

// Plan 002: fleet's own flags must only be consumed from the LEADING tokens —
// a --wsl/--json/--cwd appearing inside the remote command is payload, not a flag.
describe("parseLeadingFlags", () => {
  const BOOLS = ["--json", "--wsl", "--raw"] as const;
  const VALS = ["--cwd", "--timeout"] as const;

  test("leading flags are consumed, selector + command left verbatim", () => {
    const { flags, rest } = parseLeadingFlags(
      ["--wsl", "--cwd", "/srv", "maints", "uname", "-a"], BOOLS, VALS);
    expect(flags["--wsl"]).toBe(true);
    expect(flags["--cwd"]).toBe("/srv");
    expect(rest).toEqual(["maints", "uname", "-a"]);
  });

  test("flags INSIDE the command are never hijacked", () => {
    const { flags, rest } = parseLeadingFlags(
      ["oracle", "echo", "keep", "--wsl", "these", "--json", "flags", "--cwd", "/x"], BOOLS, VALS);
    expect(flags).toEqual({});
    expect(rest.join(" ")).toBe("echo keep --wsl these --json flags --cwd /x".replace("echo ", "oracle echo "));
  });

  test("a flag-valued token stops nothing: value is taken verbatim", () => {
    const { flags, rest } = parseLeadingFlags(["--cwd", "--json", "vps", "ls"], BOOLS, VALS);
    expect(flags["--cwd"]).toBe("--json"); // consumed as the value, garbage in → visible out
    expect(rest).toEqual(["vps", "ls"]);
  });

  test("no flags at all", () => {
    const { flags, rest } = parseLeadingFlags(["vps", "uptime"], BOOLS, VALS);
    expect(flags).toEqual({});
    expect(rest).toEqual(["vps", "uptime"]);
  });

  test("value flag at end of argv yields empty string, not crash", () => {
    const { flags, rest } = parseLeadingFlags(["--cwd"], BOOLS, VALS);
    expect(flags["--cwd"]).toBe("");
    expect(rest).toEqual([]);
  });
});

describe("systemd user services", () => {
  const svc = { type: "systemd-user" as const, name: "pocketace" };

  test("restart uses the remote user's manager without sudo", () =>
    expect(restartCmd(svc)).toEqual({
      cmd: "systemctl --user restart 'pocketace'",
      shell: "bash",
    }));

  test("logs and status query the remote user's manager", () => {
    expect(logsCmd(svc, 20).cmd).toBe("journalctl --user -u 'pocketace' -n 20 --no-pager");
    expect(statusCmd(svc).cmd).toBe("systemctl --user is-active 'pocketace' 2>/dev/null || true");
  });
});

describe("logical routes", () => {
  test("prefers the first reachable transport", async () => {
    const cfg: FleetConfig = {
      hosts: {
        main: routeHost("main"),
        maints: routeHost("maints"),
      },
      routes: {
        "main-win": { prefer: ["main", "maints"] },
      },
    };
    const probed: string[] = [];

    const selected = await routeSelector(cfg, "main-win", {
      probe: async (host) => {
        probed.push(host.name);
        return true;
      },
    });

    expect(selected).toBe("main");
    expect(probed).toEqual(["main"]);
  });

  test("falls back when the preferred transport is unreachable", async () => {
    const cfg: FleetConfig = {
      hosts: {
        main: routeHost("main"),
        maints: routeHost("maints"),
      },
      routes: {
        "main-win": { prefer: ["main", "maints"] },
      },
    };
    const probed: string[] = [];

    const selected = await routeSelector(cfg, "main-win", {
      probe: async (host) => {
        probed.push(host.name);
        return host.name === "maints";
      },
    });

    expect(selected).toBe("maints");
    expect(probed).toEqual(["main", "maints"]);
  });

  test("explicit transport names bypass auto-routing", async () => {
    const cfg: FleetConfig = {
      hosts: {
        main: routeHost("main"),
        maints: routeHost("maints"),
      },
      routes: {
        "main-win": { prefer: ["main", "maints"] },
      },
    };
    const neverProbe = async (): Promise<boolean> => {
      throw new Error("explicit transport must not probe");
    };

    expect(await routeSelector(cfg, "main", { probe: neverProbe })).toBe("main");
    expect(await routeSelector(cfg, "maints", { probe: neverProbe })).toBe("maints");
  });

  test("routes compose inside comma selectors and duplicate routes probe once", async () => {
    const cfg: FleetConfig = {
      hosts: {
        main: routeHost("main"),
        maints: routeHost("maints"),
        other: routeHost("other"),
      },
      routes: { "main-win": { prefer: ["main", "maints"] } },
    };
    const probed: string[] = [];
    const selected = await routeSelector(cfg, "main-win,other,main-win", {
      probe: async (host) => { probed.push(host.name); return true; },
    });
    expect(selected).toBe("main,other,main");
    expect(probed).toEqual(["main"]);
  });

  test("fails before dispatch when no transport is reachable", async () => {
    const cfg: FleetConfig = {
      hosts: {
        main: routeHost("main"),
        maints: routeHost("maints"),
      },
      routes: {
        "main-win": { prefer: ["main", "maints"] },
      },
    };

    expect(routeSelector(cfg, "main-win", { probe: async () => false }))
      .rejects.toThrow("route main-win is not reachable (tried: main, maints)");
  });
});

describe("recipes", () => {
  const cfg: FleetConfig = {
    hosts: {
      oracle: { name: "oracle", ssh: "oracle", os: "linux" },
      main: routeHost("main"),
      maints: routeHost("maints"),
    },
    routes: { "main-win": { prefer: ["main", "maints"] } },
  };

  test("exec flags inside the remote command stay payload", () => {
    expect(parseRecipeStep(cfg, "exec oracle echo keep --wsl --json --raw --cwd /x")).toEqual({
      kind: "exec",
      selector: "oracle",
      command: "echo keep --wsl --json --raw --cwd /x",
      wsl: false,
    });
  });

  test("leading exec flags are parsed strictly", () => {
    expect(parseRecipeStep(cfg, "exec --wsl --cwd /srv --timeout 8 main-win uname -a")).toEqual({
      kind: "exec",
      selector: "main-win",
      command: "uname -a",
      wsl: true,
      cwd: "/srv",
      timeoutMs: 8000,
    });
    expect(() => parseRecipeStep(cfg, "exec --timeout nope oracle true")).toThrow(/--timeout needs a number/);
  });

  test("cp parses logical and Daytona remote selectors without slicing at the wrong colon", () => {
    expect(parseRecipeStep(cfg, "cp -r ./model dt:box:/tmp/model")).toEqual({
      kind: "cp",
      local: "./model",
      selector: "dt:box",
      remote: "/tmp/model",
      recursive: true,
    });
  });
});

describe("hard deadlines and deploy source", () => {
  test("remote writes refuse to replace POSIX symlinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-edit-symlink-"));
    const target = join(root, "target");
    const link = join(root, "link");
    writeFileSync(target, "before");
    symlinkSync(target, link);
    try {
      const result = await writeRemoteFile(
        { name: "local", ssh: "local", os: "linux" }, link, "after",
        Buffer.from("before").toString("base64"), "bash",
        {
          exec: async (host, command) => {
            const proc = Bun.spawn(["bash", "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
            proc.stdin.write(command);
            proc.stdin.end();
            const [stdout, stderr, code] = await Promise.all([
              new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
            ]);
            return { host: host.name, ok: code === 0, code, stdout, stderr };
          },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("refusing to replace symlink");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("before");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an HTTP wait cannot overrun its total timeout by the per-request cap", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(1000);
        return new Response("late");
      },
    });
    try {
      const start = performance.now();
      const result = await waitFor({ hosts: {} }, `unused`, {
        http: `http://127.0.0.1:${server.port}`,
        timeoutMs: 60,
        intervalMs: 5,
      });
      expect(result.ok).toBe(false);
      expect(performance.now() - start).toBeLessThan(500);
    } finally {
      server.stop(true);
    }
  });

  test("deploy source resolution accepts a public checkout without private config and rejects a compiled-only root", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-source-"));
    const bad = mkdtempSync(join(tmpdir(), "fleet-bunfs-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(join(root, "src", "cli.ts"), "");
      expect(await resolveDeploySourceRoot({ explicit: root })).toBe(root);
      expect(resolveDeploySourceRoot({ explicit: bad })).rejects.toThrow(/FLEET_SOURCE_ROOT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bad, { recursive: true, force: true });
    }
  });

  test("deploy installs an absolute-Bun launcher and rejects shadowing on POSIX", () => {
    const { cmd, shell } = deployScript({ name: "ampere", ssh: "ampere", os: "linux" });
    expect(shell).toBe("bash");
    expect(cmd).toContain('exec "$bun" "$dir/src/cli.ts" "\\$@"');
    expect(cmd).toContain('chmod 755 "$HOME/.local/bin/fleet"');
    expect(cmd).toContain('resolved="$(command -v fleet || true)"');
    expect(cmd).toContain('if [ "$resolved" != "$HOME/.local/bin/fleet" ]');
    expect(cmd).toContain("trap 'rm -f \"$HOME/fleet-deploy.tgz\"' EXIT");
  });

  test("deploy installs a Windows shim and rejects a shadowing executable", () => {
    const { cmd, shell } = deployScript({ name: "main", ssh: "main", os: "windows" });
    expect(shell).toBe("powershell");
    expect(cmd).toContain('$shim="$env:USERPROFILE\\.local\\bin"');
    expect(cmd).toContain("+ $dir + '\\src\\cli.ts\" %*'");
    expect(cmd).toContain('Get-Command fleet');
    expect(cmd).toContain('deployed Fleet is shadowed');
    expect(cmd).toContain('if($LASTEXITCODE -ne 0){throw "tar extraction failed');
    expect(cmd).toContain('if($LASTEXITCODE -ne 0){throw "bun install failed');
    expect(cmd).toContain("} finally {");
  });

  test("deploy rejects an explicit restart service before building or shipping", async () => {
    const cfg: FleetConfig = {
      hosts: { app: { name: "app", ssh: "app", os: "linux", services: {} } },
    };
    await expect(deployHosts(cfg, "app", { restart: "typo" })).rejects.toThrow(
      /restart service 'typo' is not configured/,
    );
  });
});
