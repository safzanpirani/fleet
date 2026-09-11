import { describe, expect, test } from "bun:test";
import {
  briefDescribe, compactCuOutput, cuAct, cuBlockerNote, cuCaptureSize, cuDescribe, cuGridCaption,
  cuInstall, cuLooksModal, cuRecordStart, cuRecordStop, cuResolvePoint, cuResolveTargetFrom,
  cuRun, cuTools, parseCuWindows,
} from "../src/core.ts";
import type { CuSnapshot, CuWindowInfo } from "../src/core.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import type { ExecResult } from "../src/ssh.ts";

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

  test("Linux restarts its user service; Windows kicks its autostart task", async () => {
    const cmds = new Map<string, string>();
    await cuInstall(cfg, "all", {
      exec: async (target, cmd) => {
        cmds.set(target.name, cmd);
        return { host: target.name, ok: true, code: 0, stdout: "", stderr: "" };
      },
    });
    expect(cmds.get("lin")).toContain("systemctl --user restart cua-driver.service");
    expect(cmds.get("lin")).not.toContain("autostart kick");
    expect(cmds.get("win")).toContain("autostart kick");
  });

  test.each([
    { download: 22, install: 0, restart: 0, expected: 22 },
    { download: 0, install: 7, restart: 0, expected: 7 },
    { download: 0, install: 0, restart: 9, expected: 9 },
    { download: 0, install: 0, restart: 0, expected: 0 },
  ])("Linux install preserves download/install/restart failures: %j", async (scenario) => {
    const [action] = await cuInstall(cfg, "lin", {
      exec: async (target, command) => {
        const script = `curl() { printf 'exit ${scenario.install}\\n'; return ${scenario.download}; }\n`
          + `systemctl() { printf 'RESTART:%s\\n' "$*"; return ${scenario.restart}; }\n`
          + command;
        const proc = Bun.spawn(["/bin/bash", "-s"], {
          stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
        ]);
        return { host: target.name, code, ok: code === 0, stdout, stderr };
      },
    });
    expect(action!.result.code).toBe(scenario.expected);
    if (scenario.download || scenario.install) expect(action!.result.stdout).not.toContain("RESTART");
    else expect(action!.result.stdout).toContain("RESTART:--user restart cua-driver.service");
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

// ── targeting, blockers, coordinate space, verified effect ──────────────────

const windowFixture = (over: Partial<CuWindowInfo> = {}): CuWindowInfo => ({
  window_id: 7, pid: 100, title: "Playnite", app_name: "Playnite.DesktopApp.exe",
  x: 0, y: 0, width: 1700, height: 1125, on_screen: true, minimized: false, z_index: 18,
  ...over,
});
const snapshotFixture = (over: Partial<CuSnapshot> = {}): CuSnapshot => ({
  apps: [{ name: "Playnite", pid: 100, active: true }],
  windows: [windowFixture()],
  maxImageDimension: 1568,
  result: { host: "win", ok: true, code: 0, stdout: "", stderr: "" },
  ...over,
});

describe("target resolution", () => {
  test("both reported window shapes parse identically", () => {
    const nested = parseCuWindows({ windows: [{
      window_id: 7, pid: 100, title: "T", app_name: "a.exe", z_index: 3,
      bounds: { x: 1, y: 2, width: 30, height: 40 }, is_on_screen: true, minimized: false,
    }] });
    const flat = parseCuWindows({ _legacy_windows: [{
      window_id: 7, pid: 100, title: "T", x: 1, y: 2, width: 30, height: 40,
      is_on_screen: true, minimized: false,
    }] });
    expect(nested[0]!.x).toBe(1);
    expect(nested[0]!.width).toBe(30);
    expect(flat[0]!.height).toBe(40);
    expect(flat[0]!.window_id).toBe(7);
  });

  test.each([
    ["100", "pid"],
    ["Playnite.DesktopApp.exe", "process"],
    ["Playnite.DesktopApp", "process"],
    ["playnite", "process"],
    ["Playnite", "process"],
  ])("%s resolves to the same pid (matched on %s)", (query, matched) => {
    // `windows Playnite.DesktopApp` used to return nothing while `apps` listed
    // the very same process as "Playnite": each subcommand searched one list.
    const t = cuResolveTargetFrom(snapshotFixture(), query);
    expect(t.pid).toBe(100);
    expect(t.matched).toBe(matched as any);
  });

  test("a window title resolves a process whose names do not match", () => {
    const snap = snapshotFixture({
      apps: [{ name: "Code", pid: 200 }],
      windows: [windowFixture({ pid: 200, app_name: "Code.exe", title: "core.ts — fleet" })],
    });
    const t = cuResolveTargetFrom(snap, "fleet");
    expect(t.pid).toBe(200);
    expect(t.matched).toBe("title");
  });

  test("an unmatched query names what is on screen instead of failing blankly", () => {
    expect(() => cuResolveTargetFrom(snapshotFixture(), "nothing-here"))
      .toThrow(/no app, process, or window title matching "nothing-here".*Playnite/s);
  });

  test("the biggest window is targeted, not the frontmost", () => {
    // The frontmost window of a blocked app IS the modal. cua-driver picks the
    // frontmost when window_id is omitted, which anchors window-local
    // coordinates to the dialog's frame and lands the click somewhere else.
    const modal = windowFixture({
      window_id: 9, title: "Playnite is running with elevated privileges",
      x: 600, y: 400, width: 420, height: 200, z_index: 22,
    });
    const t = cuResolveTargetFrom(snapshotFixture({ windows: [windowFixture(), modal] }), "Playnite");
    expect(t.window.window_id).toBe(7);
    expect(t.blockers.map((w) => w.window_id)).toEqual([9]);
    expect(cuLooksModal(t.window, modal)).toBe(true);
    expect(cuBlockerNote(t)).toContain("elevated privileges");
    expect(cuBlockerNote(t)).toContain("modal");
  });

  test("a second window in front but not over the target is not a modal", () => {
    // Same app, another monitor, frontmost. It is above the target, so it is
    // reported — but calling it a modal would be wrong: it covers nothing.
    const other = windowFixture({
      window_id: 9, title: "Second", z_index: 22, x: 2000, width: 1600, height: 1000,
    });
    const t = cuResolveTargetFrom(snapshotFixture({ windows: [windowFixture(), other] }), "Playnite");
    expect(cuLooksModal(t.window, other)).toBe(false);
    expect(cuBlockerNote(t)).not.toContain("modal");
  });

  test("windows below the target are siblings, not blockers", () => {
    const below = windowFixture({ window_id: 9, title: "Behind", z_index: 4 });
    const t = cuResolveTargetFrom(snapshotFixture({ windows: [windowFixture(), below] }), "Playnite");
    expect(t.siblings.map((w) => w.window_id)).toEqual([9]);
    expect(t.blockers).toEqual([]);
    expect(cuBlockerNote(t)).toBeUndefined();
  });
});

describe("coordinate space", () => {
  test("the predicted click space matches the driver's downscale", () => {
    // 1700x1125 capped at 1568 is what the live driver returns as 1568x1037.
    expect(cuCaptureSize({ width: 1700, height: 1125 }, 1568)).toEqual({
      width: 1568, height: 1037, scale: 1568 / 1700,
    });
    expect(cuCaptureSize({ width: 800, height: 600 }, 1568).scale).toBe(1);
  });

  test("window-space points pass through and screen-space points convert", () => {
    const t = cuResolveTargetFrom(snapshotFixture({
      windows: [windowFixture({ x: 306, y: 223 })],
    }), "Playnite");
    expect(cuResolvePoint(t, 166, 447, "window")).toEqual({ x: 166, y: 447 });
    expect(cuResolvePoint(t, 400, 300, "screen")).toEqual({ x: 87, y: 71 });
  });

  test("a point outside the window is refused, not delivered to whatever is there", () => {
    const t = cuResolveTargetFrom(snapshotFixture(), "Playnite");
    expect(() => cuResolvePoint(t, 1600, 20, "window"))
      .toThrow(/outside Playnite w7 — its click space is 0\.\.1567 x 0\.\.1036/);
    expect(() => cuResolvePoint(t, -1, 10, "window")).toThrow(/outside/);
    expect(() => cuResolvePoint(t, 5000, 5000, "screen")).toThrow(/--space window/);
  });

  test("the caption states the frame the numbers are in", () => {
    const caption = cuGridCaption(cuResolveTargetFrom(snapshotFixture(), "Playnite"));
    expect(caption).toContain("window-local px");
    expect(caption).toContain("pid 100");
    expect(caption).toContain("window_id 7");
    expect(caption).toContain("origin = this window's top-left");
  });
});

describe("verified actions", () => {
  const cfgWin: FleetConfig = { hosts: { win: host("win", "windows"), lin: host("lin", "linux") } };
  const snapshot = async () => snapshotFixture();
  const hashes = (a: string, b: string, c?: string) => [
    `${"__FLEET_HASH__"}A|${a}`,
    "__FLEET_CAP__act|",
    '{"effect":"unverifiable"}',
    "__FLEET_END__",
    `${"__FLEET_HASH__"}B|${b}`,
    ...(c ? [`${"__FLEET_HASH__"}C|${c}`] : []),
  ].join("\n");

  test("window_id is always sent, because omitting it targets the frontmost window", async () => {
    let script = "";
    await cuAct(cfgWin, "win", "Playnite", "click", { x: 166, y: 447 }, {}, {
      snapshot,
      exec: async (target, command) => {
        script = command;
        return { host: target.name, ok: true, code: 0, stdout: hashes("aa", "aa"), stderr: "" };
      },
    });
    expect(script).toContain('"window_id":7');
    expect(script).toContain('"pid":100');
    expect(script).toContain('"x":166');
  });

  test.each([
    { before: "aa", after: "aa", settle: undefined, effect: "no_change" },
    { before: "aa", after: "bb", settle: "bb", effect: "changed" },
    { before: "aa", after: "bb", settle: "cc", effect: "indeterminate" },
    { before: "", after: "", settle: undefined, effect: "indeterminate" },
  ])("before/after bitmap hashes report $effect", async (scenario) => {
    const r = await cuAct(cfgWin, "win", "Playnite", "click", { x: 1, y: 1 }, {}, {
      snapshot,
      exec: async (target) => ({
        host: target.name, ok: true, code: 0, stderr: "",
        stdout: hashes(scenario.before, scenario.after, scenario.settle),
      }),
    });
    expect(r.effect).toBe(scenario.effect as any);
    // cua-driver's own field is useless here — that is the whole point.
    expect(r.driverOutput).toContain("unverifiable");
  });

  test("a still-repainting window is reported as indeterminate, not a false change", async () => {
    const r = await cuAct(cfgWin, "win", "Playnite", "click", { x: 1, y: 1 }, {}, {
      snapshot,
      exec: async (target) => ({
        host: target.name, ok: true, code: 0, stderr: "", stdout: hashes("aa", "bb", "cc"),
      }),
    });
    expect(r.reason).toContain("repainting");
  });

  test("the third capture is skipped when nothing moved", async () => {
    let script = "";
    await cuAct(cfgWin, "win", "Playnite", "click", { x: 1, y: 1 }, {}, {
      snapshot,
      exec: async (target, command) => {
        script = command;
        return { host: target.name, ok: true, code: 0, stdout: hashes("aa", "aa"), stderr: "" };
      },
    });
    // Two captures in the common case; the settle capture is guarded by the
    // before/after comparison so a no-op costs one fewer window grab.
    expect(script).toContain("if ($hA -ne $hB)");
  });

  test("Linux hashes with the tool its shell actually has", async () => {
    let script = "";
    await cuAct({ hosts: { lin: host("lin", "linux") } }, "lin", "Playnite", "click", {}, {}, {
      snapshot,
      exec: async (target, command) => {
        script = command;
        return { host: target.name, ok: true, code: 0, stdout: hashes("aa", "aa"), stderr: "" };
      },
    });
    expect(script).toContain("sha256sum");
    expect(script).toContain("shasum -a 256");
  });

  test("captures skip the accessibility walk entirely", async () => {
    let script = "";
    await cuAct(cfgWin, "win", "Playnite", "click", {}, {}, {
      snapshot,
      exec: async (target, command) => {
        script = command;
        return { host: target.name, ok: true, code: 0, stdout: hashes("aa", "aa"), stderr: "" };
      },
    });
    expect(script).toContain('"include_accessibility_tree":false');
  });
});

describe("output shaping", () => {
  const ok = (stdout: string): ExecResult => ({ host: "win", ok: true, code: 0, stdout, stderr: "" });

  test("an empty accessibility tree collapses to the diagnostic that matters", () => {
    const body = JSON.stringify({
      app_name: "Playnite.DesktopApp.exe", pid: 100, window_id: 7, window_title: "Playnite",
      degraded: true, degraded_reason: "ax_tree_empty", element_count: 0,
      window_bounds: { x: 0, y: 0, width: 1700, height: 1125 },
      screenshot_width: 1568, screenshot_height: 1037,
      tree_markdown: "x".repeat(200_000), elements: [],
    });
    const { result, suppressedBytes } = compactCuOutput(["get_window_state"], ok(body));
    expect(suppressedBytes).toBeGreaterThan(190_000);
    expect(result.stdout).toContain("ax_tree_empty");
    expect(result.stdout).toContain("window_id 7");
    expect(result.stdout).toContain("element_index / element_token are UNAVAILABLE");
    expect(result.stdout).not.toContain("xxxxxxxxxx");
  });

  test("a populated tree is left exactly as the driver returned it", () => {
    const body = JSON.stringify({ element_count: 412, elements: [{ element_index: 0 }] });
    const { result, suppressedBytes } = compactCuOutput(["get_window_state"], ok(body));
    expect(suppressedBytes).toBe(0);
    expect(result.stdout).toBe(body);
  });

  test("only get_window_state is reshaped, and only when it succeeded", () => {
    const body = JSON.stringify({ degraded: true, element_count: 0 });
    expect(compactCuOutput(["list_apps"], ok(body)).suppressedBytes).toBe(0);
    expect(compactCuOutput(["get_window_state"],
      { host: "win", ok: false, code: 1, stdout: body, stderr: "" }).suppressedBytes).toBe(0);
  });
});

describe("describe --brief", () => {
  const stdout = [
    "name: click",
    "",
    "description:",
    "Left-click against a target pid. **Prefer `element_index` over pixel coordinates** — it works on hidden windows.",
    "Reach for x, y only on canvas surfaces.",
    "",
    "input_schema:",
    JSON.stringify({
      required: ["pid"],
      properties: {
        pid: { type: "integer", description: "Target process ID for window scope. Omit with scope=desktop." },
        element_index: { type: "integer", description: "Element index from get_window_state." },
        button: { enum: ["left", "right"], description: "Mouse button. Default left." },
      },
    }, null, 2),
  ].join("\n");

  test("brief keeps the name, the summary, and the field list", () => {
    const brief = briefDescribe(stdout);
    expect(brief).toContain("name: click");
    expect(brief).toContain("fields (required: pid)");
    expect(brief).toContain("pid <integer>");
    expect(brief).toContain("button <left|right>");
    expect(brief.length).toBeLessThan(stdout.length);
  });

  test("element guidance is dropped when the probed window has no tree", () => {
    // The stock text pushes element_index hard; on an empty-UIA window that
    // advice cannot be followed at all, so printing it under a line saying the
    // opposite is worse than printing nothing.
    const brief = briefDescribe(stdout, { elementsAvailable: false });
    expect(brief).not.toContain("Prefer `element_index`");
    expect(brief).not.toContain("element_index <integer>");
    expect(brief).toContain("use pixel x,y");
    expect(briefDescribe(stdout, { elementsAvailable: true })).toContain("Prefer `element_index`");
  });
});

describe("act round trips", () => {
  const cfgWin: FleetConfig = { hosts: { win: host("win", "windows") } };
  const snapshot = async () => snapshotFixture();
  const reply = (image: boolean) => [
    "__FLEET_HASH__A|aa", "__FLEET_CAP__act|", "{}", "__FLEET_END__", "__FLEET_HASH__B|aa",
    ...(image ? ["__FLEET_IMG__C:\\Temp\\after.png"] : []),
  ].join("\n");

  test.each([
    { imageOut: undefined, keeps: false },
    { imageOut: "after.png", keeps: true },
  ])("the after-image is cleaned up host-side unless it was asked for (%j)", async (scenario) => {
    const scripts: string[] = [];
    await cuAct(cfgWin, "win", "Playnite", "click", {}, { imageOut: scenario.imageOut }, {
      snapshot,
      deliver: async (_h, _r, path) => ({ result: { host: "win", ok: false, code: 1, stdout: "", stderr: "x" }, path }),
      exec: async (target, command) => {
        scripts.push(command);
        return { host: target.name, ok: true, code: 0, stdout: reply(scenario.keeps), stderr: "" };
      },
    });
    // A verify-only click must not pay a second ssh round trip just to delete a
    // temp PNG it never wanted.
    expect(scripts[0]).toContain(scenario.keeps ? "__FLEET_IMG__" : "Remove-Item -LiteralPath $keep");
    expect(scripts.length).toBe(scenario.keeps ? 2 : 1);
  });
});

describe("display names", () => {
  test("a process known only from list_windows keeps its own capitalization", () => {
    const snap = snapshotFixture({
      apps: [],
      windows: [windowFixture({ app_name: "Playnite.DesktopApp.exe" })],
    });
    expect(cuResolveTargetFrom(snap, "playnite").name).toBe("Playnite.DesktopApp");
    expect(() => cuResolveTargetFrom(snap, "absent")).toThrow(/Playnite\.DesktopApp/);
  });

  test("the app list's display name wins when both sources know the pid", () => {
    expect(cuResolveTargetFrom(snapshotFixture(), "Playnite.DesktopApp.exe").name).toBe("Playnite");
  });
});
