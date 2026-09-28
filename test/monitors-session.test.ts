import { describe, expect, test } from "bun:test";
import { mainMonitor, parseMonitors, parseRegion, pickMonitor, regionRect } from "../src/monitors.ts";
import { parseLinuxSession, parseMacSession, parseQueryIdle, parseWindowsSession } from "../src/session.ts";
import { captureCmd, droppedStdinCheck, readsStdin } from "../src/core.ts";
import { buildArgs } from "../src/ssh.ts";

// A two-monitor Hyprland layout: a rotated 1080p monitor left of a 1440p one at 1.25.
const HYPR = `@hyprland
[{"id":0,"name":"HDMI-A-1","x":-1080,"y":-384,"width":1920,"height":1080,"scale":1,"transform":1,"focused":false,"disabled":false,"dpmsStatus":false,"solitaryBlockedBy":["LOCK","WINDOWED"]},
 {"id":1,"name":"DP-3","x":0,"y":0,"width":2560,"height":1440,"scale":1.25,"transform":0,"focused":true,"disabled":false,"dpmsStatus":true,"solitaryBlockedBy":["LOCK","CANDIDATE"]}]`;

describe("monitor layouts", () => {
  test("Hyprland: logical size after scale and rotation, power and lock", () => {
    const { source, monitors, locked } = parseMonitors(HYPR);
    expect(source).toBe("hyprland");
    expect(locked).toBe(true);
    expect(monitors[0]).toMatchObject({ name: "HDMI-A-1", width: 1080, height: 1920, on: false });
    expect(monitors[1]).toMatchObject({ name: "DP-3", width: 2048, height: 1152, scale: 1.25, on: true });
    expect(parseMonitors(HYPR.replaceAll('"LOCK",', "")).locked).toBe(false);
    expect(parseMonitors(HYPR.replaceAll('"LOCK"', '"WORKSPACE"')).locked).toBeUndefined();
  });

  test("X11 and sway layouts", () => {
    const x = parseMonitors("@x11\nMonitors: 2\n 0: +*DP-1 2560/597x1440/336+0+0  DP-1\n 1: +HDMI-1 1920/527x1080/296+2560+0  HDMI-1\n");
    expect(x.monitors.map((m) => [m.name, m.primary, m.x])).toEqual([["DP-1", true, 0], ["HDMI-1", false, 2560]]);
    const sw = parseMonitors(`@sway\n[{"name":"eDP-1","active":true,"rect":{"x":0,"y":0,"width":1280,"height":800},"scale":2,"focused":true,"power":false}]`);
    expect(sw.monitors[0]).toMatchObject({ name: "eDP-1", width: 1280, scale: 2, on: false });
  });

  test("main is the primary, else the monitor at 0,0; selectors refuse with the list", () => {
    const { monitors } = parseMonitors(HYPR);
    expect(mainMonitor(monitors)!.name).toBe("DP-3");
    expect(pickMonitor(monitors, "main").name).toBe("DP-3");
    expect(pickMonitor(monitors, "1").name).toBe("HDMI-A-1");
    expect(pickMonitor(monitors, "hdmi-a-1").name).toBe("HDMI-A-1");
    expect(() => pickMonitor(monitors, "DP-9")).toThrow(/have: 1:HDMI-A-1, 2:DP-3 \(main\) \(focused\)/);
  });

  test("regions are fractions of the monitor in layout coordinates", () => {
    const dp3 = parseMonitors(HYPR).monitors[1]!;
    expect(regionRect(dp3, "top-right")).toEqual({ x: 1024, y: 0, width: 1024, height: 576 });
    expect(regionRect(parseMonitors(HYPR).monitors[0]!, "bottom")).toEqual({ x: -1080, y: 576, width: 1080, height: 960 });
    expect(parseRegion("0.25,0.25,0.5,0.5")).toEqual([0.25, 0.25, 0.5, 0.5]);
    expect(() => parseRegion("0.9,0,0.2,1")).toThrow(/outside/);
    expect(() => parseRegion("upper")).toThrow(/top-right/);
  });

  test("a Linux capture is bounded and restores monitors it woke", () => {
    const cmd = captureCmd("linux", { rect: { x: 1024, y: 0, width: 1024, height: 576 }, scale: 1.25,
      wake: { source: "hyprland", outputs: ["DP-3"] } }).cmd;
    expect(cmd).toContain("timeout 20 grim -s 1.25 -g '1024,0 1024x576'");
    expect(cmd).toMatch(/trap '.*dpms off.*DP-3.*' EXIT/);
    expect(cmd.indexOf("dpms on")).toBeLessThan(cmd.indexOf("grim -s"));
    expect(captureCmd("linux", { rect: { x: 0, y: 0, width: 2048, height: 1152 }, output: "DP-3", wholeOutput: true }).cmd)
      .toContain("grim -o 'DP-3'");
  });
});

describe("session state", () => {
  const lin = (sessions: string, extra = "") =>
    `@now 1790600000\n${sessions}\n@dm sddm\n@lockers ${extra}\n${HYPR}`;
  const seat = "@session Id=5 Name=alex Type=wayland Class=user State=active Active=yes LockedHint=no IdleHint=no IdleSinceHint=0 Remote=no Seat=seat0";

  test("Linux: a Hyprland session lock, powered-off displays, unknown idle", () => {
    const s = parseLinuxSession(lin(seat));
    expect(s).toMatchObject({ state: "locked", user: "alex", lock: "compositor session lock", idleSeconds: undefined });
    expect(s.displays).toEqual([{ name: "HDMI-A-1", on: false }, { name: "DP-3", on: true }]);
  });

  test("Linux: unlocked, a locker process, idle from logind, and the login screen", () => {
    const unlocked = lin(seat).replaceAll('"LOCK",', "");
    expect(parseLinuxSession(unlocked).state).toBe("logged-in");
    expect(parseLinuxSession(lin(seat, "hyprlock").replaceAll('"LOCK",', "")).lock).toBe("locker running: hyprlock");
    const idle = seat.replace("IdleHint=no IdleSinceHint=0", "IdleHint=yes IdleSinceHint=1790599400000000");
    expect(parseLinuxSession(lin(idle).replaceAll('"LOCK",', "")).idleSeconds).toBe(600);
    expect(parseLinuxSession("@now 1\n@session Id=c1 Name=sddm Type=wayland Class=greeter Active=yes Seat=seat0\n@dm sddm\n@lockers \n@none").state).toBe("login-screen");
  });

  test("Windows: query user, LogonUI and idle", () => {
    const text = "@user admin                console             1  Active      1:05  9/28/2026 9:00 AM\n@logonui \n@console 1";
    expect(parseWindowsSession(text)).toMatchObject({ state: "logged-in", user: "admin", idleSeconds: 3900 });
    expect(parseWindowsSession(text.replace("@logonui ", "@logonui 1")).state).toBe("locked");
    expect(parseWindowsSession("@logonui 1\n@console 1").state).toBe("login-screen");
    expect(parseQueryIdle("2+03:04")).toBe(((2 * 24 + 3) * 60 + 4) * 60);
    expect(parseQueryIdle("none")).toBe(0);
  });

  test("macOS: IOConsoleUsers and HID idle", () => {
    const users = JSON.stringify([{ kCGSSessionOnConsoleKey: true, kCGSSessionUserNameKey: "alex", CGSSessionScreenIsLocked: true }]);
    expect(parseMacSession(`@console ${users}\n@hid_idle_ns 5000000000`)).toMatchObject({ state: "locked", user: "alex", idleSeconds: 5 });
  });
});

describe("dropped stdin and fresh logins", () => {
  test.each(["bash -s", "sudo bash -s", "sh -", "python3 -", "cd /x && bash -s", "cat > /tmp/x", "tee /etc/x", "pwsh -Command -"])(
    "%s reads stdin", (c) => expect(readsStdin(c)).toBe(true));
  test.each(["bash -lc 'echo hi'", "echo hi | bash -s", "cat /etc/hosts", "ls | tee out", "python3 x.py", "git diff -- f"])(
    "%s does not", (c) => expect(readsStdin(c)).toBe(false));

  test("a stdin-reading command with local input refuses; a file warns; a pipe or terminal passes", () => {
    expect(droppedStdinCheck("bash -s", "file").refuse).toMatch(/--script -/);
    expect(droppedStdinCheck("bash -s", "pipe").refuse).toBeDefined();
    expect(droppedStdinCheck("ls", "file").warn).toBeDefined();
    expect(droppedStdinCheck("ls", "pipe")).toEqual({});
    expect(droppedStdinCheck("bash -s", "tty")).toEqual({});
  });

  test("a fresh exec neither reuses nor creates a shared master", () => {
    const h = { name: "h", ssh: "h", os: "linux" as const };
    expect(buildArgs(h, "true", "bash", "powershell", undefined, true).args).toContain("ControlPath=none");
    expect(buildArgs(h, "true", "bash").args.some((a) => a.startsWith("ControlPath=") && a !== "ControlPath=none")).toBe(true);
  });
});
