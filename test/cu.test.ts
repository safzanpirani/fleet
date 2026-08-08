import { describe, expect, test } from "bun:test";
import { cuInstall } from "../src/core.ts";
import type { FleetConfig, Host } from "../src/config.ts";

const host = (name: string, os: Host["os"]): Host => ({ name, ssh: name, os });

const cfg: FleetConfig = {
  hosts: {
    lin: host("lin", "linux"),
    win: host("win", "windows"),
    mac: host("mac", "mac"),
  },
  groups: { desks: ["lin", "win"] },
};

describe("cuInstall", () => {
  test("installs on every host a selector resolves to, not just the first", async () => {
    const seen: string[] = [];
    const actions = await cuInstall(cfg, "all", {
      exec: async (target) => {
        seen.push(target.name);
        return { host: target.name, ok: true, code: 0, stdout: "installed", stderr: "" };
      },
    });

    expect(seen.sort()).toEqual(["lin", "mac", "win"]);
    expect(actions.map((a) => a.host).sort()).toEqual(["lin", "mac", "win"]);
  });

  test("a group selector provisions the whole group", async () => {
    const actions = await cuInstall(cfg, "@desks", {
      exec: async (target) => ({ host: target.name, ok: true, code: 0, stdout: "", stderr: "" }),
    });
    expect(actions.map((a) => a.host).sort()).toEqual(["lin", "win"]);
  });

  test("each host gets its own OS's installer and shell", async () => {
    const byHost = new Map<string, { cmd: string; shell: string }>();
    await cuInstall(cfg, "lin,win", {
      exec: async (target, cmd, shell) => {
        byHost.set(target.name, { cmd, shell: shell ?? "auto" });
        return { host: target.name, ok: true, code: 0, stdout: "", stderr: "" };
      },
    });

    expect(byHost.get("win")!.shell).toBe("powershell");
    expect(byHost.get("win")!.cmd).toContain("install.ps1");
    expect(byHost.get("lin")!.shell).toBe("bash");
    expect(byHost.get("lin")!.cmd).toContain("install.sh");
  });

  test("every host is kicked into autostart, so the daemon survives a reboot", async () => {
    const cmds: string[] = [];
    await cuInstall(cfg, "all", {
      exec: async (target, cmd) => {
        cmds.push(cmd);
        return { host: target.name, ok: true, code: 0, stdout: "", stderr: "" };
      },
    });
    expect(cmds).toHaveLength(3);
    for (const cmd of cmds) expect(cmd).toContain("autostart kick");
  });

  test("one host failing does not hide the others' results", async () => {
    const actions = await cuInstall(cfg, "all", {
      exec: async (target) => ({
        host: target.name,
        ok: target.name !== "win",
        code: target.name === "win" ? 1 : 0,
        stdout: "",
        stderr: target.name === "win" ? "installer failed" : "",
      }),
    });

    expect(actions.filter((a) => a.result.ok).map((a) => a.host).sort()).toEqual(["lin", "mac"]);
    expect(actions.find((a) => a.host === "win")!.result.stderr).toContain("installer failed");
  });
});
