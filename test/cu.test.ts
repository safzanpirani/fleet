import { describe, expect, test } from "bun:test";
import {
  cuDescribe, cuInstall, cuRecordStart, cuRecordStop, cuRun, cuTools,
} from "../src/core.ts";
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

const cuResponse = (stdout: string) => ({
  host: "lin",
  result: { host: "lin", ok: true, code: 0, stdout, stderr: "" },
});

describe("cua-driver 0.22 conveniences", () => {
  test("Windows image calls fail when PowerShell cannot invoke cua-driver", async () => {
    let script = "";
    const response = await cuRun(cfg, "win", ["get_desktop_state"], "shot.png", {
      exec: async (target, command) => {
        script = command;
        return { host: target.name, ok: false, code: 1, stdout: "", stderr: "not recognized" };
      },
    });
    expect(script).toContain("$driverSucceeded = $?");
    expect(script).toContain("if (-not $driverSucceeded)");
    expect(response.result.ok).toBe(false);
    expect(response.result.stderr).toContain("not recognized");
  });

  test("tools uses list-tools and filters lines case-insensitively", async () => {
    const seen: string[][] = [];
    const response = await cuTools(cfg, "lin", "BROWSER", {
      run: async (_cfg, _sel, args) => {
        seen.push(args);
        return cuResponse("click: desktop click\nbrowser_click: CDP click\nbrowser_type: CDP type");
      },
    });

    expect(seen).toEqual([["list-tools"]]);
    expect(response.result.stdout).toBe("browser_click: CDP click\nbrowser_type: CDP type");
  });

  test("describe forwards the exact tool name", async () => {
    const seen: string[][] = [];
    await cuDescribe(cfg, "lin", "get_desktop_state", {
      run: async (_cfg, _sel, args) => {
        seen.push(args);
        return cuResponse("input_schema: {}");
      },
    });
    expect(seen).toEqual([["describe", "get_desktop_state"]]);
  });

  test("record start uses the persistent recording API and returns driver state", async () => {
    const seen: string[][] = [];
    const response = await cuRecordStart(cfg, "lin", "~/captures/run-1", {
      run: async (_cfg, _sel, args) => {
        seen.push(args);
        return args[0] === "recording"
          ? cuResponse("Recording started")
          : cuResponse(JSON.stringify({ enabled: true, output_dir: "~/captures/run-1" }));
      },
    });

    expect(seen).toEqual([
      ["recording", "start", "~/captures/run-1"],
      ["get_recording_state"],
    ]);
    expect(response.state?.enabled).toBe(true);
  });

  test("record stop snapshots state, stops, and pulls through Fleet's pull path", async () => {
    const calls: string[] = [];
    const response = await cuRecordStop(cfg, "lin", "/tmp/local-rec", {
      run: async (_cfg, _sel, args) => {
        calls.push(args[0] ?? "");
        return cuResponse(JSON.stringify(args[0] === "get_recording_state"
          ? { enabled: true, output_dir: "~/.fleet/recordings/run-1" }
          : { enabled: false, output_dir: null, last_video_path: "~/.fleet/recordings/run-1/recording.mp4" }));
      },
      makeDir: async (path) => { calls.push(`mkdir:${path}`); },
      pull: async (_cfg, sel, remote, local, recursive) => {
        calls.push(`pull:${sel}:${remote}:${local}:${recursive}`);
        return { host: "lin", ok: true, code: 0, stdout: "", stderr: "" };
      },
      listLocalFiles: async () => ["/tmp/local-rec/recording.mp4"],
    });

    expect(calls).toEqual([
      "get_recording_state",
      "stop_recording",
      "mkdir:/tmp/local-rec",
      "pull:lin:~/.fleet/recordings/run-1/.:/tmp/local-rec:true",
    ]);
    expect(response.localPaths).toEqual(["/tmp/local-rec/recording.mp4"]);
  });
});
