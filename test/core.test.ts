import { test, expect, describe } from "bun:test";
import { logsCmd, parseLeadingFlags, restartCmd, routeSelector, statusCmd } from "../src/core.ts";
import type { FleetConfig, Host } from "../src/config.ts";

const routeHost = (name: string): Host => ({ name, ssh: name, os: "windows" });

// Plan 002: fleet's own flags must only be consumed from the LEADING tokens —
// a --wsl/--json/--cwd appearing inside the remote command is payload, not a flag.
describe("parseLeadingFlags", () => {
  const BOOLS = ["--json", "--wsl", "--raw"] as const;
  const VALS = ["--cwd", "--timeout"] as const;

  test("leading flags are consumed, selector + command left verbatim", () => {
    const { flags, rest } = parseLeadingFlags(
      ["--wsl", "--cwd", "/srv", "win-box", "uname", "-a"], BOOLS, VALS);
    expect(flags["--wsl"]).toBe(true);
    expect(flags["--cwd"]).toBe("/srv");
    expect(rest).toEqual(["win-box", "uname", "-a"]);
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
  const svc = { type: "systemd-user" as const, name: "user-app" };

  test("restart uses the remote user's manager without sudo", () =>
    expect(restartCmd(svc)).toEqual({
      cmd: "systemctl --user restart 'user-app'",
      shell: "bash",
    }));

  test("logs and status query the remote user's manager", () => {
    expect(logsCmd(svc, 20).cmd).toBe("journalctl --user -u 'user-app' -n 20 --no-pager");
    expect(statusCmd(svc).cmd).toBe("systemctl --user is-active 'user-app' 2>/dev/null || true");
  });
});

describe("logical routes", () => {
  test("prefers the first reachable transport", async () => {
    const cfg: FleetConfig = {
      hosts: {
        "win-lan": routeHost("win-lan"),
        "win-ts": routeHost("win-ts"),
      },
      routes: {
        "win-auto": { prefer: ["win-lan", "win-ts"] },
      },
    };
    const probed: string[] = [];

    const selected = await routeSelector(cfg, "win-auto", {
      probe: async (host) => {
        probed.push(host.name);
        return true;
      },
    });

    expect(selected).toBe("win-lan");
    expect(probed).toEqual(["win-lan"]);
  });

  test("falls back when the preferred transport is unreachable", async () => {
    const cfg: FleetConfig = {
      hosts: {
        "win-lan": routeHost("win-lan"),
        "win-ts": routeHost("win-ts"),
      },
      routes: {
        "win-auto": { prefer: ["win-lan", "win-ts"] },
      },
    };
    const probed: string[] = [];

    const selected = await routeSelector(cfg, "win-auto", {
      probe: async (host) => {
        probed.push(host.name);
        return host.name === "win-ts";
      },
    });

    expect(selected).toBe("win-ts");
    expect(probed).toEqual(["win-lan", "win-ts"]);
  });

  test("explicit transport names bypass auto-routing", async () => {
    const cfg: FleetConfig = {
      hosts: {
        "win-lan": routeHost("win-lan"),
        "win-ts": routeHost("win-ts"),
      },
      routes: {
        "win-auto": { prefer: ["win-lan", "win-ts"] },
      },
    };
    const neverProbe = async (): Promise<boolean> => {
      throw new Error("explicit transport must not probe");
    };

    expect(await routeSelector(cfg, "win-lan", { probe: neverProbe })).toBe("win-lan");
    expect(await routeSelector(cfg, "win-ts", { probe: neverProbe })).toBe("win-ts");
  });

  test("fails before dispatch when no transport is reachable", async () => {
    const cfg: FleetConfig = {
      hosts: {
        "win-lan": routeHost("win-lan"),
        "win-ts": routeHost("win-ts"),
      },
      routes: {
        "win-auto": { prefer: ["win-lan", "win-ts"] },
      },
    };

    expect(routeSelector(cfg, "win-auto", { probe: async () => false }))
      .rejects.toThrow("route win-auto is not reachable (tried: win-lan, win-ts)");
  });
});
