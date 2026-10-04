import { test, expect, describe } from "bun:test";
import {
  deployHosts, deployScript, logsCmd, parseLeadingFlags, parseRecipeStep, resolveDeploySourceRoot,
  restartCmd, routeSelector, statusCmd, waitFor, writeRemoteFile, pickPreferred, splitArgs,
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
      ["--wsl", "--cwd", "/srv", "winbox", "uname", "-a"], BOOLS, VALS);
    expect(flags["--wsl"]).toBe(true);
    expect(flags["--cwd"]).toBe("/srv");
    expect(rest).toEqual(["winbox", "uname", "-a"]);
  });

  test("flags INSIDE the command are never hijacked", () => {
    const { flags, rest } = parseLeadingFlags(
      ["web", "echo", "keep", "--wsl", "these", "--json", "flags", "--cwd", "/x"], BOOLS, VALS);
    expect(flags).toEqual({});
    expect(rest.join(" ")).toBe("echo keep --wsl these --json flags --cwd /x".replace("echo ", "web echo "));
  });

  test("an option cannot silently become another option's value", () => {
    expect(() => parseLeadingFlags(["--cwd", "--json", "vps", "ls"], BOOLS, VALS)).toThrow("--cwd requires a value");
  });

  test("no flags at all", () => {
    const { flags, rest } = parseLeadingFlags(["vps", "uptime"], BOOLS, VALS);
    expect(flags).toEqual({});
    expect(rest).toEqual(["vps", "uptime"]);
  });

  test("missing, unknown, and repeated options fail before dispatch", () => {
    expect(() => parseLeadingFlags(["--cwd"], BOOLS, VALS)).toThrow("--cwd requires a value");
    expect(() => parseLeadingFlags(["--typo", "vps", "ls"], BOOLS, VALS)).toThrow("unknown option");
    expect(() => parseLeadingFlags(["--json", "--json", "vps", "ls"], BOOLS, VALS)).toThrow("duplicate option");
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
        winbox: routeHost("winbox"),
      },
      routes: {
        "main-win": { prefer: ["main", "winbox"] },
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
        winbox: routeHost("winbox"),
      },
      routes: {
        "main-win": { prefer: ["main", "winbox"] },
      },
    };
    const probed: string[] = [];

    const selected = await routeSelector(cfg, "main-win", {
      probe: async (host) => {
        probed.push(host.name);
        return host.name === "winbox";
      },
    });

    expect(selected).toBe("winbox");
    expect(probed).toEqual(["main", "winbox"]);
  });

  test("explicit transport names bypass auto-routing", async () => {
    const cfg: FleetConfig = {
      hosts: {
        main: routeHost("main"),
        winbox: routeHost("winbox"),
      },
      routes: {
        "main-win": { prefer: ["main", "winbox"] },
      },
    };
    const neverProbe = async (): Promise<boolean> => {
      throw new Error("explicit transport must not probe");
    };

    expect(await routeSelector(cfg, "main", { probe: neverProbe })).toBe("main");
    expect(await routeSelector(cfg, "winbox", { probe: neverProbe })).toBe("winbox");
  });

  test("routes compose inside comma selectors and duplicate routes probe once", async () => {
    const cfg: FleetConfig = {
      hosts: {
        main: routeHost("main"),
        winbox: routeHost("winbox"),
        other: routeHost("other"),
      },
      routes: { "main-win": { prefer: ["main", "winbox"] } },
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
        winbox: routeHost("winbox"),
      },
      routes: {
        "main-win": { prefer: ["main", "winbox"] },
      },
    };

    expect(routeSelector(cfg, "main-win", { probe: async () => false }))
      .rejects.toThrow("route main-win is not reachable (tried: main, winbox)");
  });
});

describe("recipes", () => {
  const cfg: FleetConfig = {
    hosts: {
      web: { name: "web", ssh: "web", os: "linux" },
      main: routeHost("main"),
      winbox: routeHost("winbox"),
    },
    routes: { "main-win": { prefer: ["main", "winbox"] } },
  };

  test("quoted exec recipes preserve escaped command quotes", async () => {
    const parsed = parseRecipeStep(cfg, String.raw`exec web "printf '%s\n' \"two words\""`);
    expect(parsed.kind).toBe("exec");
    if (parsed.kind !== "exec") throw new Error("expected exec recipe");
    expect(parsed.command).toBe(String.raw`printf '%s\n' "two words"`);
    const proc = Bun.spawn(["bash", "--noprofile", "--norc", "-c", parsed.command], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect({ stdout, stderr, code }).toEqual({ stdout: "two words\n", stderr: "", code: 0 });
  });

  test("recipe quote escapes leave ordinary path backslashes intact", () => {
    expect(splitArgs(String.raw`"a\\b \"c\""`)).toEqual([String.raw`a\b "c"`]);
    expect(parseRecipeStep(cfg, String.raw`cp "C:\work dir\file.txt" web:/tmp/file`)).toMatchObject({
      kind: "cp", local: String.raw`C:\work dir\file.txt`,
    });
  });

  test("exec flags inside the remote command stay payload", () => {
    expect(parseRecipeStep(cfg, "exec web echo keep --wsl --json --raw --cwd /x")).toEqual({
      kind: "exec",
      selector: "web",
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
    expect(() => parseRecipeStep(cfg, "exec --timeout nope web true")).toThrow(/--timeout needs an integer/);
    expect(() => parseRecipeStep(cfg, "exec --timeout 0.5 web true")).toThrow(/--timeout needs an integer/);
    expect(parseRecipeStep(cfg, "exec --timeout 0 web true")).toMatchObject({ timeoutMs: 0 });
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
  test("wait retries an unavailable logical route until it becomes reachable", async () => {
    const cfg: FleetConfig = { hosts: { local: { name: "local", ssh: "unused", os: "linux" } },
      routes: { route: { prefer: ["local"] } } };
    let probes = 0;
    const result = await waitFor(cfg, "route", { timeoutMs: 200, intervalMs: 5 }, {
      probe: async () => ++probes > 1,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(probes).toBe(3);
  });

  test("wait returns timeout for a down route and rejects unknown targets immediately", async () => {
    const cfg: FleetConfig = { hosts: { local: { name: "local", ssh: "unused", os: "linux" } },
      routes: { route: { prefer: ["local"] } } };
    const result = await waitFor(cfg, "route", { timeoutMs: 30, intervalMs: 5 }, { probe: async () => false });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBeGreaterThan(1);
    await expect(waitFor(cfg, "typo", { timeoutMs: 100 })).rejects.toThrow("unknown host");
  });

  test("--sudo ships the whole write through sudo and refuses Windows shells", async () => {
    let sent = "";
    await writeRemoteFile({ name: "box", ssh: "box", os: "linux" }, "/etc/x", "new", null, "auto", {
      sudo: true,
      exec: async (host, command) => { sent = command; return { host: host.name, ok: true, code: 0, stdout: "", stderr: "" }; },
    });
    const b64 = /^fleet_root_script\(\) \{ printf %s '([^']+)' \| base64 -d; \}$/m.exec(sent)![1]!;
    expect(Buffer.from(b64, "base64").toString("utf8")).toContain(`mv -- "$tmp" "$p"`);
    expect(sent).toContain("fleet_root_script | sudo -n bash");
    await expect(writeRemoteFile({ name: "win", ssh: "win", os: "windows" }, "C:/x", "new", null, "auto", { sudo: true }))
      .rejects.toThrow("--sudo needs a POSIX shell");
  });

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
    const { cmd, shell } = deployScript({ name: "linuxbox", ssh: "linuxbox", os: "linux" });
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

describe("pickPreferred", () => {
  const after = (ms: number, ok: boolean) => () => new Promise<boolean>((r) => setTimeout(() => r(ok), ms));
  test("a prompt preferred transport is the only one probed", async () => {
    const started: number[] = [];
    const probe = (i: number, ms: number, ok: boolean) => () => { started.push(i); return after(ms, ok)(); };
    expect(await pickPreferred([probe(0, 10, true), probe(1, 10, true)], 200)).toBe(0);
    expect(started).toEqual([0]);
  });
  test("a slow preferred transport lets the next one start after the grace", async () => {
    const t0 = Date.now();
    expect(await pickPreferred([after(2000, false), after(10, true)], 100)).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  test("a failed preferred transport starts the next at once", async () => {
    const t0 = Date.now();
    expect(await pickPreferred([after(5, false), after(5, true)], 5000)).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  test("the preferred transport still wins if it answers first after the grace", async () => {
    expect(await pickPreferred([after(150, true), after(400, true)], 100)).toBe(0);
  });
  test("none reachable is -1", async () => {
    expect(await pickPreferred([after(5, false), after(5, false)], 50)).toBe(-1);
    expect(await pickPreferred([], 50)).toBe(-1);
  });
});
