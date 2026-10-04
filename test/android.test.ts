import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import {
  androidAct, androidBatch, androidFlow, androidBootstrap, androidElements, androidOpen, androidRelease, androidWait, androidElementsOf, androidInputText, androidKeycode, androidPick, androidShot,
  androidState, androidTargetPattern, parseUiDump, unpackReply, parseNotifications, androidNotifications,
  androidRecordStart, androidRecordStatus, androidRecordStop, androidRevive, androidWatch, androidZoomPlan,
} from "../src/android.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import { UI_JAR_MD5 } from "../src/android-ui-jar.ts";
import { validateConfig } from "../src/config.ts";
import type { ExecResult } from "../src/ssh.ts";
import { androidCu } from "../src/cli.ts";
import type { AndroidFlowStep } from "../src/android.ts";

const phone: Host = { name: "phone", ssh: "phone", os: "linux", android: { serial: "127.0.0.1:5555" } };
const cfg: FleetConfig = { hosts: { phone, box: { name: "box", ssh: "box", os: "linux" } } };

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">`
  + `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,0][1000,2000]">`
  + `<node index="0" text="" resource-id="com.example:id/row" class="android.widget.LinearLayout" package="com.example" content-desc="" clickable="true" enabled="true" bounds="[0,200][1000,300]">`
  + `<node index="0" text="Wi-Fi" resource-id="com.example:id/title" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[40,220][400,280]" />`
  + `<node index="1" text="" resource-id="com.example:id/toggle" class="android.widget.Switch" package="com.example" content-desc="" checkable="true" checked="true" clickable="true" enabled="true" bounds="[800,220][960,280]" />`
  + `</node>`
  + `<node index="1" text="Tom &amp; Jerry &gt; x" resource-id="" class="android.widget.Button" package="com.example" content-desc="a > b" clickable="true" enabled="false" bounds="[0,400][500,500]" />`
  + `<node index="2" text="" resource-id="com.example:id/search" class="android.widget.EditText" package="com.example" content-desc="" hint="Search apps" clickable="true" focusable="true" focused="true" enabled="true" bounds="[0,600][1000,700]" />`
  + `<node index="3" text="Save" resource-id="" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" bounds="[0,800][500,900]" />`
  + `<node index="4" text="Save" resource-id="" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" bounds="[500,800][1000,900]" />`
  + `<node index="5" text="" resource-id="" class="android.view.View" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,950][1000,960]" />`
  + `<node index="6" text="gone" resource-id="" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,3000][100,3100]" />`
  + `<node index="7" text="flat" resource-id="" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[10,10][10,50]" />`
  + `</node></hierarchy>`;

describe("parseUiDump", () => {
  const nodes = parseUiDump(XML);
  test("reads every node with its parent and depth", () => {
    expect(nodes.length).toBe(11);
    expect(nodes[2]!.text).toBe("Wi-Fi");
    expect(nodes[2]!.parent).toBe(1);
    expect(nodes[2]!.depth).toBe(2);
    expect(nodes[4]!.parent).toBe(0);
  });
  test("decodes entities and survives a raw > inside an attribute", () => {
    expect(nodes[4]!.text).toBe("Tom & Jerry > x");
    expect(nodes[4]!.desc).toBe("a > b");
    expect(nodes[4]!.enabled).toBe(false);
  });
  test("parses bounds and flags", () => {
    expect(nodes[3]!.bounds).toEqual({ x1: 800, y1: 220, x2: 960, y2: 280 });
    expect(nodes[3]!.checked).toBe(true);
    expect(nodes[5]!.focused).toBe(true);
  });
});

describe("androidElements", () => {
  const els = androidElements(parseUiDump(XML), { width: 1000, height: 2000 });
  const by = (label: string) => els.find((e) => e.label === label);
  test("a list that only scrolls does not take its rows' text", () => {
    const list = `<hierarchy><node class="androidx.recyclerview.widget.RecyclerView" scrollable="true" bounds="[0,0][100,100]">`
      + `<node text="row one" class="android.widget.TextView" bounds="[0,0][100,50]" /></node></hierarchy>`;
    const [rv] = androidElements(parseUiDump(list));
    expect(rv!.role).toBe("RecyclerView");
    expect(rv!.label).toBe("");
  });
  test("a clickable container with no label takes its children's text", () => {
    const row = els.find((e) => e.id === "row")!;
    expect(row.label).toBe("Wi-Fi");
    expect(row.derived).toBe(true);
    expect(row.actions).toEqual(["tap"]);
    expect(row.center).toEqual({ x: 500, y: 250 });
  });
  test("names actions from flags and the class", () => {
    expect(els.find((e) => e.id === "toggle")!.actions).toEqual(["tap", "check"]);
    expect(els.find((e) => e.id === "search")!.actions).toEqual(["tap", "type"]);
  });
  test("drops unlabeled inert nodes, zero-area nodes, and nodes off the display", () => {
    expect(by("gone")).toBeUndefined();
    expect(by("flat")).toBeUndefined();
    expect(els.some((e) => e.role === "View")).toBe(false);
  });
  test("--all keeps inert nodes", () => {
    const every = androidElements(parseUiDump(XML), { all: true, width: 1000, height: 2000 });
    expect(every.some((e) => e.role === "View")).toBe(true);
  });
});

describe("androidPick", () => {
  const els = androidElements(parseUiDump(XML), { width: 1000, height: 2000 });
  test("a caption collapses into the row that takes the tap", () => {
    const hit = androidPick(els, { label: "wi-fi" });
    expect(hit.id).toBe("row");
  });
  test("matches content-desc and resource-id", () => {
    expect(androidPick(els, { label: "a > b" }).text).toBe("Tom & Jerry > x");
    expect(androidPick(els, { label: "search" }).id).toBe("search");
    expect(androidPick(els, { label: "search apps" }).id).toBe("search");
  });
  test("an ambiguous label is refused with the candidates", () => {
    expect(() => androidPick(els, { label: "Save" })).toThrow(/2 elements match label "Save"[\s\S]*@250,850[\s\S]*@750,850/);
  });
  test("--nth picks among matches", () => {
    expect(androidPick(els, { label: "Save", nth: 2 }).center).toEqual({ x: 750, y: 850 });
    expect(() => androidPick(els, { label: "Save", nth: 3 })).toThrow(/from 1 to 2/);
  });
  test("--role narrows", () => {
    expect(androidPick(els, { role: "Switch" }).id).toBe("toggle");
  });
  test("no match lists what takes input", () => {
    expect(() => androidPick(els, { label: "nothing here" })).toThrow(/no element with label "nothing here"; some that take input/);
  });
});

describe("guards", () => {
  test("target patterns", () => {
    expect(androidTargetPattern("com.android.chrome")).toBe("com.android.chrome");
    expect(androidTargetPattern("chrome")).toBe("*chrome*");
    expect(androidTargetPattern("any")).toBe("*");
    expect(() => androidTargetPattern("x; rm")).toThrow(/package name/);
  });
  test("keys", () => {
    expect(androidKeycode("back")).toBe("KEYCODE_BACK");
    expect(androidKeycode("KEYCODE_CAMERA")).toBe("KEYCODE_CAMERA");
    expect(() => androidKeycode("KEYCODE_POWER")).toThrow(/cannot unlock/);
    expect(() => androidKeycode("nope")).toThrow(/unknown key/);
  });
  test("text", () => {
    expect(androidInputText("hello world")).toBe("hello%sworld");
    expect(() => androidInputText("héllo")).toThrow(/ASCII/);
    expect(() => androidInputText("100%s")).toThrow(/%s/);
  });
});

describe("config", () => {
  const base = (android: unknown, os = "linux") =>
    ({ hosts: { phone: { name: "phone", ssh: "phone", os, android } } }) as unknown as FleetConfig;
  test("accepts an android block", () => expect(() => validateConfig(base({ serial: "127.0.0.1:5555" }), "t")).not.toThrow());
  test("rejects unknown android fields", () => expect(() => validateConfig(base({ port: 1 }), "t")).toThrow(/unknown field.*port/));
  test("rejects a serial with shell characters", () =>
    expect(() => validateConfig(base({ serial: "x;y" }), "t")).toThrow(/adb serial/));
  test("needs os linux", () => expect(() => validateConfig(base({}, "mac"), "t")).toThrow(/os linux/));
  test("accepts a default screenshot width and bounds it", () => {
    expect(() => validateConfig(base({ shotWidth: 400 }), "t")).not.toThrow();
    expect(() => validateConfig(base({ shotWidth: 50 }), "t")).toThrow(/shotWidth/);
  });
});

// ── the runner, against a fake phone ────────────────────────────────────────

const STATE = ["__FA__FOCUS Window{1 u0 com.android.chrome/org.chromium.Main}", "__FA__PKG com.android.chrome",
  "__FA__SIZE 1000 2000", "__FA__SB 100", "__FA__KEYGUARD false", "__FA__AWAKE Awake"];
const deviceScript = (script: string) =>
  Buffer.from(script.match(/adb -s "\$S" shell -n -T "echo ([A-Za-z0-9+/=]+) \| base64 -d \| sh"/)![1]!, "base64").toString("utf8");

/** Each call gets its own UI-tree cache directory, so no test reads another's tree. */
const deps = (f: { run: any }, cacheDir = mkdtempSync(join(tmpdir(), "fleet-android-cache-"))) => ({ exec: f.run, cacheDir });

function fake(...replies: Array<{ stdout: string[]; code?: number }>) {
  const scripts: string[] = [];
  const run = async (_h: Host, script: string): Promise<ExecResult> => {
    scripts.push(script);
    const r = replies[scripts.length - 1] ?? { stdout: [] };
    const code = r.code ?? 0;
    return { host: "phone", ok: code === 0, code, stdout: r.stdout.join("\n"), stderr: "" };
  };
  return { run, scripts };
}

describe("androidAct", () => {
  test("a moved frame that then holds still is changed; the gates run before input", async () => {
    const f = fake({ stdout: [...STATE, "__FA__HA a", "__FA__INPUT 0", "__FA__HB b", "__FA__HC b"] });
    const r = await androidAct(cfg, "phone", "chrome", { kind: "tap", x: 10, y: 20 }, {}, deps(f));
    expect(r.effect).toBe("changed");
    expect(r.result.ok).toBe(true);
    const dev = deviceScript(f.scripts[0]!);
    expect(dev).toContain(`case "$pkg" in *chrome*)`);
    expect(dev.indexOf("inb 10 20")).toBeLessThan(dev.indexOf("input tap 10 20"));
    expect(dev.indexOf("refuse \"the phone is locked")).toBeLessThan(dev.indexOf("input tap"));
    expect(dev.startsWith("(\numask 077\n") && dev.endsWith("\ntrue\n) </dev/null")).toBe(true);
  });
  test("equal frames are no_change", async () => {
    const f = fake({ stdout: [...STATE, "__FA__HA a", "__FA__INPUT 0", "__FA__HB a"] });
    expect((await androidAct(cfg, "phone", "any", { kind: "key", key: "back" }, {}, deps(f))).effect).toBe("no_change");
  });
  test("a screen that never settles is indeterminate", async () => {
    const f = fake({ stdout: [...STATE, "__FA__HA a", "__FA__INPUT 0", "__FA__HB b", "__FA__UNSTABLE g"] });
    const r = await androidAct(cfg, "phone", "any", { kind: "scroll", direction: "down" }, {}, deps(f));
    expect(r.effect).toBe("indeterminate");
    expect(r.reason).toMatch(/kept changing/);
  });
  test("a screen that settles where it started is no_change", async () => {
    const f = fake({ stdout: [...STATE, "__FA__HA a", "__FA__INPUT 0", "__FA__HB b", "__FA__HC a"] });
    const r = await androidAct(cfg, "phone", "any", { kind: "tap", x: 1, y: 1 }, {}, deps(f));
    expect(r.effect).toBe("no_change");
    expect(r.reason).toMatch(/settled back/);
  });
  test("the device script polls for two agreeing frames after a change", async () => {
    const f = fake({ stdout: [...STATE, "__FA__HA a", "__FA__INPUT 0", "__FA__HB a"] });
    await androidAct(cfg, "phone", "any", { kind: "key", key: "back" }, {}, deps(f));
    const dev = deviceScript(f.scripts[0]!);
    expect(dev).toContain(`if [ "$h" = "$prev" ]; then HC=$h; break; fi`);
  });
  test("a refusal fails the call and reports its reason", async () => {
    const f = fake({ stdout: [...STATE, "__FA__REFUSE focus is on com.other (x), not chrome"], code: 3 });
    const r = await androidAct(cfg, "phone", "chrome", { kind: "tap", x: 1, y: 1 }, {}, deps(f));
    expect(r.result.ok).toBe(false);
    expect(r.refusal).toMatch(/focus is on com.other/);
  });
  test("input that throws a Java exception fails even with exit 0", async () => {
    const f = fake({ stdout: [...STATE, "__FA__HA a", "__FA__INPUT 0",
      "__FA__INPUTOUT java.lang.IllegalArgumentException: bad", "__FA__HB a"] });
    const r = await androidAct(cfg, "phone", "any", { kind: "key", key: "back" }, {}, deps(f));
    expect(r.result.ok).toBe(false);
    expect(r.result.stderr).toMatch(/IllegalArgumentException/);
  });
  test("typing reads the focused field back when the cursor keeps blinking", async () => {
    const field = `<hierarchy><node text="hello there" class="android.widget.EditText" focused="true" password="false" bounds="[0,0][10,10]" /></hierarchy>`;
    const f = fake({ stdout: [...STATE, "__FA__HA a", "__FA__INPUT 0", "__FA__HB b", "__FA__UNSTABLE c", "__FA__XML", field, "__FA__XMLEND"] });
    const r = await androidAct(cfg, "phone", "any", { kind: "type", text: "hello there" }, {}, deps(f));
    expect(r.effect).toBe("changed");
    expect(r.reason).toMatch(/reads back/);
    expect(deviceScript(f.scripts[0]!)).toContain("input text 'hello%sthere'");
  });
  test("a label is resolved from a fresh dump and tapped at its center", async () => {
    const f = fake(
      { stdout: [...STATE, "__FA__XML", XML, "__FA__XMLEND"] },
      { stdout: [...STATE, "__FA__HA a", "__FA__INPUT 0", "__FA__HB b", "__FA__HC b"] },
    );
    const r = await androidAct(cfg, "phone", "any", { kind: "tap" }, { element: { label: "Wi-Fi" } }, deps(f));
    expect(r.element?.id).toBe("row");
    expect(deviceScript(f.scripts[1]!)).toContain("input tap 500 250");
  });
  test("a disabled element is refused before any input", async () => {
    const f = fake({ stdout: [...STATE, "__FA__XML", XML, "__FA__XMLEND"] });
    await expect(androidAct(cfg, "phone", "any", { kind: "tap" }, { element: { label: "Tom & Jerry > x" } }, deps(f)))
      .rejects.toThrow(/disabled/);
    expect(f.scripts.length).toBe(1);
  });
  test("a non-Android host is refused", async () => {
    await expect(androidAct(cfg, "box", "any", { kind: "key", key: "back" })).rejects.toThrow(/not an Android host/);
  });
});

describe("multi-finger gestures", () => {
  const MAP = `<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1000,2000]">`
    + `<node class="android.widget.Button" text="Go" clickable="true" bounds="[0,100][200,200]" />`
    + `<node class="com.google.android.gms.maps.MapView" resource-id="app:id/map" bounds="[0,400][1000,1400]" />`
    + `</node></hierarchy>`;
  const all = (xml: string) => androidElements(parseUiDump(xml), { all: true, width: 1000, height: 2000 });
  const acted = [...STATE, "__FA__HA a", "__FA__INPUT 0", "__FA__HB b", "__FA__HC b"];

  test("swipe2 lands two fingers and moves both by the same offset", async () => {
    const f = fake({ stdout: acted });
    const r = await androidAct(cfg, "phone", "any", { kind: "swipe2", x1: 500, y1: 1200, x2: 800, y2: 1200, dx: -400, dy: 0 }, {}, deps(f));
    expect(r.effect).toBe("changed");
    expect(r.summary).toBe("swipe2 500,1200 + 800,1200 by -400,0 200ms");
    const dev = deviceScript(f.scripts[0]!);
    expect(dev).toContain("ui_gesture '200 500,1200,100,1200 800,1200,400,1200'");
    for (const p of ["inb 500 1200", "inb 100 1200", "inb 800 1200", "inb 400 1200", "ui_ready"])
      expect(dev.indexOf(p)).toBeLessThan(dev.indexOf("HA=$(fh)"));
  });
  test("gesture sends one stroke per finger and bounds its duration and fingers", async () => {
    const f = fake({ stdout: acted });
    await androidAct(cfg, "phone", "any", { kind: "gesture", strokes: [[1, 2, 3, 4], [5, 6, 7, 8], [9, 9, 9, 9]], ms: 150 }, {}, deps(f));
    expect(deviceScript(f.scripts[0]!)).toContain("ui_gesture '150 1,2,3,4 5,6,7,8 9,9,9,9'");
    await expect(androidAct(cfg, "phone", "any", { kind: "gesture", strokes: [[1, 2, 3, 4]], ms: 10 }, {}, deps(f))).rejects.toThrow(/50–5000/);
    await expect(androidAct(cfg, "phone", "any", { kind: "gesture", strokes: Array(6).fill([1, 1, 1, 1]) }, {}, deps(f))).rejects.toThrow(/1 to 5/);
    await expect(androidAct(cfg, "phone", "any", { kind: "gesture", strokes: [[1, 2, 3] as any] }, {}, deps(f))).rejects.toThrow(/four numbers/);
    await expect(androidAct(cfg, "phone", "any", { kind: "swipe2", x1: 1, y1: 1, x2: 2, y2: 2, dx: 0, dy: 0 },
      { element: { label: "x" } }, deps(f))).rejects.toThrow(/does not apply/);
  });
  test("a helper failure fails the input", async () => {
    const f = fake({ stdout: [...STATE, "__FA__HA a", "__FA__INPUT 1", "__FA__INPUTOUT gesture failed: the UI helper did not answer", "__FA__HB a"] });
    const r = await androidAct(cfg, "phone", "any", { kind: "swipe2", x1: 1, y1: 1, x2: 2, y2: 2, dx: 300, dy: 0 }, {}, deps(f));
    expect(r.result.ok).toBe(false);
    expect(r.result.stderr).toMatch(/did not answer/);
  });
  test("a missing helper refuses before input, is installed, and the input is sent once more", async () => {
    const f = fake(
      { stdout: [...STATE, "__FA__UIJAR missing", "__FA__REFUSE the UI helper that sends multi-finger gestures is missing or out of date"], code: 3 },
      { stdout: [] },
      { stdout: acted },
    );
    const r = await androidAct(cfg, "phone", "any", { kind: "swipe2", x1: 1, y1: 1, x2: 2, y2: 2, dx: 300, dy: 0 }, {}, deps(f));
    expect(f.scripts.length).toBe(3);
    expect(f.scripts[1]).toContain('adb -s "$S" push "$j" /data/local/tmp/fleet-ui.jar');
    expect(r.effect).toBe("changed");
    const dev = deviceScript(f.scripts[0]!);
    expect(dev.indexOf("ui_ready()")).toBeLessThan(dev.indexOf(`= ${UI_JAR_MD5} ] || { echo "__FA__UIJAR missing"; refuse`) + 1);
  });

  test("zoom guesses the largest zoomable view and keeps the fingers inside it", () => {
    const p = androidZoomPlan(all(MAP), { direction: "in", width: 1000, height: 2000 });
    expect(p.element?.id).toBe("map");
    expect(p.guess).toMatch(/MapView #map \(guessed\)/);
    expect(p.center).toEqual({ x: 500, y: 900 });
    // The map is 1000 tall inset 8% (80) → y 480–1320; the nearest edge is 420 away.
    expect(p.strokes).toEqual([[332, 732, 80, 480], [668, 1068, 920, 1320]]);
    expect(p.scale).toBe(2.5);
  });
  test("zoom out pinches from far to near; scale and direction are honoured", () => {
    const p = androidZoomPlan(all(MAP), { direction: "out", scale: 4, width: 1000, height: 2000 });
    expect(p.strokes[0]).toEqual([80, 480, 395, 795]);
    expect(p.scale).toBe(4);
    expect(() => androidZoomPlan(all(MAP), { direction: "in", scale: 1, width: 1000, height: 2000 })).toThrow(/1.2 to 10/);
  });
  test("zoom at a point sizes the spread from the smallest zoomable view under it", () => {
    const p = androidZoomPlan(all(MAP), { direction: "in", x: 300, y: 600, width: 1000, height: 2000 });
    expect(p.element?.id).toBe("map");
    expect(p.center).toEqual({ x: 300, y: 600 });
    expect(p.strokes[0]).toEqual([252, 552, 180, 480]);
    expect(() => androidZoomPlan(all(MAP), { direction: "in", x: 300, width: 1000, height: 2000 })).toThrow(/both x and y/);
    expect(() => androidZoomPlan(all(MAP), { direction: "in", x: 90, y: 490, width: 1000, height: 2000 })).toThrow(/no room/);
  });
  test("with nothing zoomable, zoom falls back to the largest view, clear of the display's edges", () => {
    const p = androidZoomPlan(all(XML), { direction: "in", width: 1000, height: 2000 });
    expect(p.element?.role).toBe("FrameLayout");
    for (const [x1, y1, x2, y2] of p.strokes)
      for (const [x, y] of [[x1, y1], [x2, y2]]) { expect(x).toBeGreaterThanOrEqual(80); expect(y).toBeGreaterThanOrEqual(160); expect(y).toBeLessThanOrEqual(1840); }
  });
  test("zoom reads the tree, then sends the planned gesture with the stale check", async () => {
    const H = "0123456789abcdef0123456789abcdef";
    const f = fake({ stdout: [...STATE, "__FA__XML", MAP, "__FA__XMLEND", "__FA__FRAME " + H] }, { stdout: acted });
    const r = await androidAct(cfg, "phone", "maps", { kind: "zoom", direction: "in" }, {}, deps(f));
    expect(r.summary).toBe("zoom in ×2.5 at 500,900 on MapView #map (guessed)");
    const dev = deviceScript(f.scripts[1]!);
    expect(dev).toContain("ui_gesture '400 332,732,80,480 668,1068,920,1320'");
    expect(dev).toContain(`if [ "$HA" != ${H} ]; then`);
    expect(r.element?.id).toBe("map");
  });

  test("batch runs swipe2 and gesture steps through the helper, checked once", async () => {
    const f = fake({ stdout: [...STATE, "__FA__HA a", "__FA__STEP 0 start", "__FA__STEP 0 done", "__FA__STEP 1 start",
      "__FA__STEP 1 done", "__FA__HB b", "__FA__HC b"] });
    const r = await androidBatch(cfg, "phone", "any", [
      { action: "swipe2", x: 500, y: 1200, x2: 800, y2: 1200, dx: 400, dy: 0 },
      { action: "gesture", strokes: [[1, 1, 2, 2]], ms: 100 },
    ], {}, deps(f));
    expect(r.result.ok).toBe(true);
    const dev = deviceScript(f.scripts[0]!);
    expect(dev).toContain("ui_gesture '200 500,1200,900,1200 800,1200,1200,1200'");
    expect(dev.match(/^ui_ready$/gm)?.length).toBe(1);
    await expect(androidBatch(cfg, "phone", "any", [{ action: "swipe2", x: 1, y: 1, x2: 2, y2: 2 }])).rejects.toThrow(/needs dx/);
  });
});

describe("androidState and androidElementsOf", () => {
  test("an unreachable adbd fails with the recovery hint", async () => {
    const f = fake({ stdout: ["__FA__ERR adb cannot reach 127.0.0.1:5555 (offline). adbd stops listening after a reboot"], code: 3 });
    const r = await androidState(cfg, "phone", deps(f));
    expect(r.result.ok).toBe(false);
    expect(r.result.stderr).toMatch(/adbd stops listening after a reboot/);
  });
  test("elements filter over labels and ids", async () => {
    const f = fake({ stdout: [...STATE, "__FA__XML", XML, "__FA__XMLEND"] });
    const r = await androidElementsOf(cfg, "phone", { filter: "toggle" }, deps(f));
    expect(r.elements.map((e) => e.id)).toEqual(["toggle"]);
    expect(r.state.pkg).toBe("com.android.chrome");
  });
});

describe("androidShot", () => {
  test("a host's shotWidth is the default capture width", async () => {
    const slow: FleetConfig = { hosts: { p: { name: "p", ssh: "p", os: "linux", android: { shotWidth: 400 } } } };
    const f = fake({ stdout: [...STATE] });
    await androidShot(slow, "p", "/tmp/never.webp", {}, deps(f)).catch(() => {});
    expect(f.scripts[0]).toContain("OUTW=$(( 400 < RW ? 400 : RW ))");
  });
  test("writes the inline image with the extension of its format", async () => {
    const body = Buffer.alloc(18);
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), body]);
    webp.writeUInt32LE(webp.length - 8, 4);
    const f = fake({ stdout: [...STATE, "__FA__IMG webp 500 1000 1000 2000",
      "__FLEET_B64__screen", webp.toString("base64"), "__FLEET_B64END__"] });
    const dir = await mkdtemp(join(tmpdir(), "fleet-android-"));
    try {
      const r = await androidShot(cfg, "phone", join(dir, "s.png"), {}, deps(f));
      expect(r.localImage).toBe(join(dir, "s.webp"));
      expect(r.image).toEqual({ format: "webp", width: 500, height: 1000, deviceWidth: 1000, deviceHeight: 2000 });
      expect((await readFile(r.localImage!)).equals(webp)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("the saved UI tree", () => {
  const H = "0123456789abcdef0123456789abcdef";
  const acted = [...STATE, "__FA__HA " + H, "__FA__INPUT 0", "__FA__HB b", "__FA__HC b"];

  test("a label resolves from the last elements read and the phone checks the frame first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-android-cache-"));
    const f = fake({ stdout: [...STATE, "__FA__XML", XML, "__FA__XMLEND", "__FA__FRAME " + H] }, { stdout: acted });
    const listed = await androidElementsOf(cfg, "phone", {}, deps(f, dir));
    expect(listed.frame).toBe(H);
    const r = await androidAct(cfg, "phone", "any", { kind: "tap" }, { element: { label: "Wi-Fi" } }, deps(f, dir));
    expect(f.scripts.length).toBe(2);
    const dev = deviceScript(f.scripts[1]!);
    expect(dev).toContain(`if [ "$HA" != ${H} ]; then`);
    // The fallback compares only the element's rows (y 200–300 for the Wi-Fi row).
    expect(dev).toContain("OFF=$((16 + 200 * W * 4 + 1))");
    expect(dev).toContain("Y2=300;");
    expect(dev.indexOf("__FA__STALE")).toBeLessThan(dev.indexOf("input tap 500 250"));
    expect(r.effect).toBe("changed");
  });
  test("a stale screen falls back to a fresh read before anything is sent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-android-cache-"));
    const f = fake(
      { stdout: [...STATE, "__FA__XML", XML, "__FA__XMLEND", "__FA__FRAME " + H] },
      { stdout: [...STATE, "__FA__HA ffffffffffffffffffffffffffffffff", "__FA__STALE ffffffffffffffffffffffffffffffff"], code: 4 },
      { stdout: [...STATE, "__FA__XML", XML, "__FA__XMLEND", "__FA__FRAME " + H] },
      { stdout: acted },
    );
    await androidElementsOf(cfg, "phone", {}, deps(f, dir));
    const r = await androidAct(cfg, "phone", "any", { kind: "tap" }, { element: { label: "Wi-Fi" } }, deps(f, dir));
    expect(f.scripts.length).toBe(4);
    expect(r.effect).toBe("changed");
  });
  test("a screen that changes twice is refused, not guessed at", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-android-cache-"));
    const stale = { stdout: [...STATE, "__FA__STALE ffffffffffffffffffffffffffffffff"], code: 4 };
    const f = fake({ stdout: [...STATE, "__FA__XML", XML, "__FA__XMLEND", "__FA__FRAME " + H] }, stale);
    const r = await androidAct(cfg, "phone", "any", { kind: "tap" }, { element: { label: "Wi-Fi" } }, deps(f, dir));
    expect(r.result.ok).toBe(false);
    expect(r.refusal).toMatch(/nothing was sent/);
  });
  test("an input that changed the screen drops the saved tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-android-cache-"));
    const f = fake({ stdout: [...STATE, "__FA__XML", XML, "__FA__XMLEND", "__FA__FRAME " + H] }, { stdout: acted },
      { stdout: [...STATE, "__FA__XML", XML, "__FA__XMLEND"] }, { stdout: acted });
    await androidElementsOf(cfg, "phone", {}, deps(f, dir));
    await androidAct(cfg, "phone", "any", { kind: "key", key: "back" }, {}, deps(f, dir));
    await androidAct(cfg, "phone", "any", { kind: "tap" }, { element: { label: "Wi-Fi" } }, deps(f, dir));
    // No saved tree left, so the label needed a fresh dump (script 3) before the tap (script 4).
    expect(f.scripts.length).toBe(4);
    expect(deviceScript(f.scripts[2]!)).toContain("uiautomator dump");
  });
});

describe("androidBootstrap", () => {
  test("reports adbd that already answers", async () => {
    const f = fake({ stdout: ["__FA__ALREADY"] });
    expect((await androidBootstrap(cfg, "phone", {}, deps(f))).outcome).toBe("already");
  });
  test("reports the wireless-debugging port it switched from", async () => {
    const f = fake({ stdout: ["__FA__PORTS 41234 46888", "__FA__FOUND 41234", "__FA__RESTORED 41234"] });
    const r = await androidBootstrap(cfg, "phone", {}, deps(f));
    expect(r.outcome).toBe("restored");
    expect(r.detail).toContain("port 41234");
    expect(f.scripts[0]).toContain("adb -s \"$c\" tcpip 5555");
  });
  test("a failure carries the next step", async () => {
    const f = fake({ stdout: ["__FA__PORTS 46888", "__FA__ERR no port on the phone accepted Termux's adb key (open: 46888)"], code: 1 });
    const r = await androidBootstrap(cfg, "phone", {}, deps(f));
    expect(r.outcome).toBe("failed");
    expect(r.result.ok).toBe(false);
    expect(r.detail).toMatch(/accepted Termux's adb key/);
  });
  test("pairing validates the code and sends it on stdin, not argv", async () => {
    await expect(androidBootstrap(cfg, "phone", { pair: { port: 40000, code: "12ab" } })).rejects.toThrow(/6-digit/);
    const f = fake({ stdout: ["__FA__PAIR Successfully paired", "__FA__RESTORED 40001"] });
    const r = await androidBootstrap(cfg, "phone", { pair: { port: 40000, code: "123456" } }, deps(f));
    expect(f.scripts[0]).toContain("printf '%s\\n' 123456 | timeout 30 adb pair 127.0.0.1:40000");
    expect(r.detail).toContain("pairing: Successfully paired");
  });
  test("refuses a serial that is not the phone's own loopback", async () => {
    const lan: FleetConfig = { hosts: { p: { name: "p", ssh: "p", os: "linux", android: { serial: "192.0.2.10:5555" } } } };
    await expect(androidBootstrap(lan, "p")).rejects.toThrow(/not 127.0.0.1:PORT/);
  });
});

describe("androidOpen", () => {
  test("--in sends a URL to one package", async () => {
    const f = fake({ stdout: [...STATE, "__FA__FOCUS Window{2 u0 app.yt/Main}", "__FA__PKG app.yt"] });
    const r = await androidOpen(cfg, "phone", "https://example.com/v", { inPackage: "app.yt" }, deps(f));
    expect(deviceScript(f.scripts[0]!)).toContain("am start -a android.intent.action.VIEW -d 'https://example.com/v' -p 'app.yt'");
    expect(r.state.pkg).toBe("app.yt");
  });
  test("--in needs a URL and a package name", async () => {
    await expect(androidOpen(cfg, "phone", "com.android.chrome", { inPackage: "app.yt" })).rejects.toThrow(/package opens itself/);
    await expect(androidOpen(cfg, "phone", "https://x.y", { inPackage: "not a pkg" })).rejects.toThrow(/package name/);
  });
});

describe("androidBatch", () => {
  const H = "0123456789abcdef0123456789abcdef";
  test("runs every step in one script, points checked first, focus re-checked per step", async () => {
    const f = fake({ stdout: [...STATE, "__FA__HA a", "__FA__STEP 0 start", "__FA__STEP 0 done", "__FA__STEP 1 start",
      "__FA__STEP 1 done", "__FA__STEP 2 start", "__FA__STEP 2 done", "__FA__HB b", "__FA__HC b"] });
    const r = await androidBatch(cfg, "phone", "chrome", [
      { action: "tap", x: 10, y: 20 }, { action: "type", text: "hi there" }, { action: "key", key: "enter" },
    ], {}, deps(f));
    expect(r.result.ok).toBe(true);
    expect(r.effect).toBe("changed");
    expect(r.steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
    const dev = deviceScript(f.scripts[0]!);
    expect(dev.indexOf("inb 10 20")).toBeLessThan(dev.indexOf("HA=$(fh)"));
    expect(dev.match(/case "\$fp" in \*chrome\*\)/g)?.length).toBe(3);
    expect(dev).toContain("input text 'hi%sthere'");
  });
  test("a halt stops the batch and later steps report not run", async () => {
    const f = fake({ stdout: [...STATE, "__FA__HA a", "__FA__STEP 0 start", "__FA__STEP 0 done", "__FA__STEP 1 start",
      "__FA__HALT 1 focus moved to com.other, not chrome"], code: 5 });
    const r = await androidBatch(cfg, "phone", "chrome", [
      { action: "tap", x: 1, y: 1 }, { action: "key", key: "back" }, { action: "key", key: "home" },
    ], {}, deps(f));
    expect(r.result.ok).toBe(false);
    expect(r.steps.map((s) => s.status)).toEqual(["done", "failed", "not_run"]);
    expect(r.steps[1]!.detail).toMatch(/focus moved/);
  });
  test("labels resolve from one tree; later label steps check their element's rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-android-cache-"));
    const f = fake({ stdout: [...STATE, "__FA__XML", XML, "__FA__XMLEND", "__FA__FRAME " + H] },
      { stdout: [...STATE, "__FA__HA " + H, "__FA__STEP 0 done", "__FA__STEP 1 done", "__FA__HB " + H] });
    await androidElementsOf(cfg, "phone", {}, deps(f, dir));
    const r = await androidBatch(cfg, "phone", "any", [
      { action: "tap", label: "Wi-Fi" }, { action: "tap", label: "search" },
    ], {}, deps(f, dir));
    expect(f.scripts.length).toBe(2);
    const dev = deviceScript(f.scripts[1]!);
    expect(dev).toContain("input tap 500 250");
    expect(dev).toContain("input tap 500 650");
    // Step 2 (the search field, rows 600–700) is checked against the saved frame.
    expect(dev).toContain("OFF=$((16 + 600 * W * 4 + 1))");
    expect(r.effect).toBe("no_change");
  });
  test.each(["key", "sleep"] as const)("the first labelled step rechecks rows after an unlabelled %s", async (first) => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-android-batch-"));
    const frame = join(dir, "saved.raw"), changed = join(dir, "changed.raw");
    try {
      const xml = '<hierarchy><node text="Submit" class="android.widget.Button" enabled="true" clickable="true" bounds="[0,0][10,10]" /></hierarchy>';
      await writeFile(join(dir, "android-phone.json"), JSON.stringify({ hash: H, xml, width: 10, height: 20 }));
      await writeFile(frame, Buffer.alloc(816, 1));
      await writeFile(changed, Buffer.alloc(816, 2));
      let output = "";
      const r = await androidBatch(cfg, "phone", "any", [
        first === "key" ? { action: "key", key: "back" } : { action: "sleep", ms: 1 },
        { action: "tap", label: "Submit" }, { action: "key", key: "enter" },
      ], { gapMs: 0, settleMs: 0 }, { cacheDir: dir, exec: async (_h, script) => {
        const device = deviceScript(script);
        const start = device.indexOf('echo "__FA__STEP 0 start"');
        const end = device.indexOf("sleep 0.000; HB=$(fh)", start);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const body = device.slice(start, end).replaceAll("/data/local/tmp/fleet-ui-frame.raw", JSON.stringify(frame));
        const mocks = [
          "exec 3>&1", "W=10; H=20",
          "input() { printf 'DELIVERED %s\\n' \"$*\" >&3; }",
          "sleep() { :; }",
          `screencap() { cat ${JSON.stringify(changed)}; }`,
          "md5sum() { cksum; }",
        ].join("\n");
        const proc = Bun.spawn(["/bin/sh", "-s"], { stdin: new TextEncoder().encode(mocks + "\n" + body), stdout: "pipe", stderr: "pipe" });
        const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        output = stdout;
        return { host: "phone", ok: code === 0, code, stdout, stderr };
      } });
      expect(r.result.ok).toBe(false);
      expect(r.steps.map((s) => s.status)).toEqual(["done", "failed", "not_run"]);
      expect(r.steps[1]!.detail).toContain("changed since the elements were read");
      expect(output).not.toContain("DELIVERED tap");
      expect(output).not.toContain("KEYCODE_ENTER");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("limits and malformed steps refuse before anything runs", async () => {
    await expect(androidBatch(cfg, "phone", "any", [])).rejects.toThrow(/non-empty/);
    await expect(androidBatch(cfg, "phone", "any", Array.from({ length: 51 }, () => ({ action: "key" as const, key: "back" }))))
      .rejects.toThrow(/at most 50/);
    await expect(androidBatch(cfg, "phone", "any", [{ action: "sleep", ms: 20000 }])).rejects.toThrow(/0–10000/);
    await expect(androidBatch(cfg, "phone", "any", [{ action: "swipe", x: 1, y: 1 }])).rejects.toThrow(/step 1 \(swipe\) needs x2/);
    await expect(androidBatch(cfg, "phone", "any", [{ action: "key", key: "back", label: "x" }])).rejects.toThrow(/label does not apply/);
  });
});

describe("androidFlow", () => {
  const H = "0123456789abcdef0123456789abcdef";
  const screen = [...STATE, "__FA__XML", XML, "__FA__XMLEND", "__FA__FRAME " + H];
  test("each label step reads the screen when its turn comes, then the last screen is returned", async () => {
    const f = fake({ stdout: screen },
      { stdout: [...STATE, "__FA__HA a", "__FA__INPUT 0", "__FA__HB b", "__FA__HC b"] },
      { stdout: screen });
    const r = await androidFlow(cfg, "phone", [
      { action: "expect", label: "Wi-Fi" }, { action: "tap", label: "Wi-Fi" },
    ], { target: "com.example" }, deps(f));
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.status)).toEqual(["done", "done"]);
    expect(f.scripts.length).toBe(3);
    expect(deviceScript(f.scripts[1]!)).toContain("input tap 500 250");
    expect(deviceScript(f.scripts[1]!)).toContain(`case "$pkg" in com.example)`);
    expect(r.elements?.length).toBeGreaterThan(0);
  });
  test("a failed expect stops the flow before any input goes out", async () => {
    const f = fake({ stdout: screen }, { stdout: screen });
    const r = await androidFlow(cfg, "phone", [
      { action: "expect", label: "Wi-Fi", text: "Bluetooth" }, { action: "type", label: "search", text: "hi" },
    ], {}, deps(f));
    expect(r.ok).toBe(false);
    expect(r.steps.map((s) => s.status)).toEqual(["failed", "not_run"]);
    expect(r.steps[0]!.detail).toMatch(/not "Bluetooth"/);
    expect(f.scripts.length).toBe(2);
    expect(f.scripts.some((x) => deviceScript(x).includes("input text"))).toBe(false);
    expect(r.elements).toBeDefined();
  });
  test("gone expects an absent label; --no-read skips the final read", async () => {
    const f = fake({ stdout: screen });
    const r = await androidFlow(cfg, "phone", [{ action: "expect", label: "Bluetooth", gone: true }], { read: false }, deps(f));
    expect(r.ok).toBe(true);
    expect(r.elements).toBeUndefined();
    expect(f.scripts.length).toBe(1);
  });
  test("a wait that times out fails the flow", async () => {
    const f = fake({ stdout: [...STATE, "__FA__XML", XML, "__FA__XMLEND", "__FA__TIMEOUT"] });
    const r = await androidFlow(cfg, "phone", [{ action: "wait", label: "Bluetooth", timeoutMs: 1000 }, { action: "key", key: "back" }],
      { read: false }, deps(f));
    expect(r.ok).toBe(false);
    expect(r.steps.map((s) => s.status)).toEqual(["failed", "not_run"]);
    expect(r.steps[0]!.detail).toMatch(/not there/);
    expect(f.scripts.some((x) => /input (?:tap|text|keyevent|swipe)/.test(deviceScript(x)))).toBe(false);
  });
  test("invalid later steps refuse before the earlier input can run", async () => {
    const invalid: unknown[] = [
      null, [], {}, { action: "constructor" }, { action: "open", what: 42 },
      { action: "open", what: "invalid" }, { action: "open", what: "com.example", in: "com.other" },
      { action: "open", what: "https://example.com", in: "bad" },
      { action: "tap", label: " " }, { action: "tap", label: 3 }, { action: "tap", role: false },
      { action: "tap", label: "Save", nth: 0 }, { action: "tap", label: "Save", nth: 1.5 },
      { action: "tap", label: "Save", nth: "2" }, { action: "tap", label: "Save", typo: true },
      { action: "type", label: "search", text: "" }, { action: "type", label: "search", text: 42 },
      { action: "type", label: "search", text: "héllo" }, { action: "type", label: "search", text: "100%s" },
      { action: "scroll", label: "x", direction: "diagonal" },
      ...[0, 11, 1.5, "2"].map((amount) => ({ action: "scroll", label: "x", direction: "down", amount })),
      ...[0, 10001, -1, 1.5, "800"].map((ms) => ({ action: "long_press", label: "x", ms })),
      { action: "key", key: "power" }, { action: "key", key: "KEYCODE_SLEEP" }, { action: "key", key: "unknown" },
      { action: "wait", focus: "x;bad" }, { action: "wait", focus: "chrome", nth: 1 },
      ...[-1, 120001, 0.5, "1000"].map((timeoutMs) => ({ action: "wait", label: "x", timeoutMs })),
      { action: "expect", label: "x", gone: "false" }, { action: "expect", label: "x", text: 1 },
      { action: "expect", label: "x", gone: true, text: "y" },
      { action: "sleep" }, { action: "sleep", ms: -1 }, { action: "sleep", ms: 0.5 },
    ];
    for (const step of invalid) {
      const f = fake();
      await expect(androidFlow(cfg, "phone", [{ action: "key", key: "back" }, step] as AndroidFlowStep[], {}, deps(f)))
        .rejects.toThrow();
      expect(f.scripts).toEqual([]);
    }
  });
  test("ambiguous or out-of-range gone expectations stop before input", async () => {
    for (const nth of [undefined, 3]) {
      const f = fake({ stdout: screen });
      const r = await androidFlow(cfg, "phone", [
        { action: "expect", label: "Save", gone: true, nth }, { action: "key", key: "back" },
      ], { read: false }, deps(f));
      expect(r.steps.map((s) => s.status)).toEqual(["failed", "not_run"]);
      expect(f.scripts.some((x) => deviceScript(x).includes("input keyevent"))).toBe(false);
    }
  });
  test("expect checks text case-insensitively and nth selects the intended match", async () => {
    const f = fake({ stdout: screen }, { stdout: screen });
    const r = await androidFlow(cfg, "phone", [
      { action: "expect", label: "Wi-Fi", text: "WI-FI" }, { action: "expect", label: "Save", nth: 2 },
    ], { read: false }, deps(f));
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.status)).toEqual(["done", "done"]);
  });
  test("a thrown step error retains earlier results and does not retry input", async () => {
    const f = fake({ stdout: [...STATE, "__FA__HA a", "__FA__INPUT 0", "__FA__HB a"] });
    const d = deps(f);
    let calls = 0;
    d.exec = async (...args: Parameters<typeof f.run>) => {
      const reply = await f.run(...args);
      if (++calls === 2) throw new Error("connection lost after send");
      return reply;
    };
    const r = await androidFlow(cfg, "phone", [
      { action: "key", key: "back" }, { action: "key", key: "enter" }, { action: "key", key: "home" },
    ], { read: false }, d);
    expect(r.ok).toBe(false);
    expect(r.steps.map((s) => s.status)).toEqual(["done", "failed", "not_run"]);
    expect(r.steps[1]!.detail).toBe("connection lost after send");
    expect(calls).toBe(2);
    expect(f.scripts.filter((x) => deviceScript(x).includes("KEYCODE_ENTER"))).toHaveLength(1);
    expect(f.scripts.some((x) => deviceScript(x).includes("KEYCODE_HOME"))).toBe(false);
  });
  test("a later label resolves from the new screen after an earlier tap changes it", async () => {
    const nextXml = XML.replace('text="Wi-Fi"', 'text="Opened"').replace('text="Save"', 'text="Next"');
    const nextScreen = [...STATE, "__FA__XML", nextXml, "__FA__XMLEND", "__FA__FRAME " + H];
    const changed = { stdout: [...STATE, "__FA__HA a", "__FA__INPUT 0", "__FA__HB b", "__FA__HC b"] };
    const f = fake({ stdout: screen }, changed, { stdout: nextScreen }, changed, { stdout: nextScreen });
    const r = await androidFlow(cfg, "phone", [
      { action: "tap", label: "Wi-Fi" }, { action: "tap", label: "Next" },
    ], { target: "chrome" }, deps(f));
    expect(r.ok).toBe(true);
    expect(deviceScript(f.scripts[1]!)).toContain("input tap 500 250");
    expect(deviceScript(f.scripts[3]!)).toContain("input tap 250 850");
    expect(r.elements?.some((e) => e.label === "Next")).toBe(true);
  });
  test("a refused input stops every subsequent step without a retry", async () => {
    const f = fake({ stdout: [...STATE, "__FA__REFUSE focus moved before input delivery"], code: 3 });
    const r = await androidFlow(cfg, "phone", [
      { action: "key", key: "enter" }, { action: "key", key: "home" }, { action: "expect", label: "Wi-Fi" },
    ], { read: false }, deps(f));
    expect(r.steps.map((s) => s.status)).toEqual(["failed", "not_run", "not_run"]);
    expect(f.scripts.filter((x) => deviceScript(x).includes("KEYCODE_ENTER"))).toHaveLength(1);
    expect(f.scripts.some((x) => deviceScript(x).includes("KEYCODE_HOME"))).toBe(false);
  });
  test("a missing input label becomes a failed step with a final read", async () => {
    const f = fake({ stdout: screen }, { stdout: screen });
    const r = await androidFlow(cfg, "phone", [
      { action: "tap", label: "missing" }, { action: "key", key: "back" },
    ], {}, deps(f));
    expect(r.steps.map((s) => s.status)).toEqual(["failed", "not_run"]);
    expect(r.elements).toBeDefined();
    expect(f.scripts.some((x) => /input (?:tap|keyevent)/.test(deviceScript(x)))).toBe(false);
  });
  test("failed or thrown final reads preserve both successful and failed flow outcomes", async () => {
    for (const ok of [true, false]) for (const throws of [true, false]) {
      const f = fake({ stdout: screen }, { stdout: [], code: 1 });
      const d = deps(f);
      let calls = 0;
      d.exec = async (...args: Parameters<typeof f.run>) => {
        if (++calls === 2 && throws) throw new Error("final read disconnected");
        return f.run(...args);
      };
      const r = await androidFlow(cfg, "phone", [{ action: "expect", label: ok ? "Wi-Fi" : "missing" }], {}, d);
      expect(r.ok).toBe(ok);
      expect(r.steps[0]!.status).toBe(ok ? "done" : "failed");
      expect(r.readError).toBeDefined();
      expect(r.elements).toBeUndefined();
    }
  });
  test("every open updates the input target, including URLs without in", async () => {
    for (const opening of [
      { action: "open" as const, what: "com.android.chrome" },
      { action: "open" as const, what: "https://example.com", in: "com.android.chrome" },
      { action: "open" as const, what: "https://example.com" },
    ]) {
      const f = fake({ stdout: [...STATE, "__FA__PKG com.old"] }, { stdout: STATE },
        { stdout: screen }, { stdout: [...STATE, "__FA__HA a", "__FA__INPUT 0", "__FA__HB a"] });
      const r = await androidFlow(cfg, "phone", [
        { action: "open", what: "com.old" }, opening, { action: "tap", label: "Wi-Fi" },
      ], { read: false }, deps(f));
      expect(r.ok).toBe(true);
      const dev = deviceScript(f.scripts[3]!);
      expect(dev).toContain('case "$pkg" in com.android.chrome)');
      expect(dev.indexOf('case "$pkg"')).toBeLessThan(dev.indexOf("input tap"));
    }
  });
  test("open refuses later inputs when the named package never gains focus", async () => {
    for (const opening of [
      { action: "open" as const, what: "com.other" },
      { action: "open" as const, what: "https://example.com", in: "com.other" },
    ]) {
      const f = fake({ stdout: STATE });
      const r = await androidFlow(cfg, "phone", [opening, { action: "key", key: "back" }], { read: false }, deps(f));
      expect(r.ok).toBe(false);
      expect(r.steps.map((s) => s.status)).toEqual(["failed", "not_run"]);
      expect(f.scripts.some((x) => deviceScript(x).includes("input keyevent"))).toBe(false);
    }
  });
  test("wait honors nth and never accepts a timeout or failed dump as absence", async () => {
    const nth = fake({ stdout: screen });
    const selected = await androidWait(cfg, "phone", { label: "Save", nth: 2 }, deps(nth));
    expect(selected.satisfied).toBe(true);
    expect(selected.element?.center).toEqual({ x: 750, y: 850 });
    for (const reply of [
      { stdout: [...screen, "__FA__TIMEOUT"] },
      { stdout: screen, code: 1 }, { stdout: STATE },
    ]) {
      const f = fake(reply);
      const r = await androidFlow(cfg, "phone", [
        { action: "wait", label: "missing", gone: true }, { action: "key", key: "back" },
      ], { read: false }, deps(f));
      expect(r.steps.map((s) => s.status)).toEqual(["failed", "not_run"]);
      expect(f.scripts.some((x) => deviceScript(x).includes("input keyevent"))).toBe(false);
    }
  });
  test("the device script withholds input on wrong focus and text after its tap changes apps", async () => {
    for (const target of ["com.example", "any"]) for (const mode of ["wrong", "before", "after"]) {
      if (target === "any" && mode === "wrong") continue; // any has no expected app; see the flow policy TODO.
      const root = await mkdtemp(join(tmpdir(), "fleet-device-gate-"));
      const focusFile = join(root, "focus");
      const eventsFile = join(root, "events");
      await writeFile(focusFile, mode === "wrong" ? "com.other" : "com.example");
      await writeFile(eventsFile, "");
      const f = fake({ stdout: screen });
      const d = deps(f);
      d.exec = async (h: Host, script: string): Promise<ExecResult> => {
        if (!deviceScript(script).includes("input text")) return f.run(h, script);
        const mocks = `
dumpsys() {
  if [ "$1" = window ]; then
    printf 'mCurrentFocus=Window{1 u0 %s/Main}\\ncur=1000x2000\\nisKeyguardShowing=false\\n' "$(cat "$FOCUS_FILE")"
  else printf 'mWakefulness=Awake\\n'; fi
}
screencap() { [ "$MODE" != before ] || printf com.other > "$FOCUS_FILE"; printf frame; }
md5sum() { cat >/dev/null; printf '${H}  -\\n'; }
input() { printf '%s\\n' "$*" >> "$EVENTS_FILE"; [ "$1" != tap ] || printf com.other > "$FOCUS_FILE"; }
`;
        const proc = Bun.spawn(["/bin/bash", "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe",
          env: { ...process.env, FOCUS_FILE: focusFile, EVENTS_FILE: eventsFile, MODE: mode } });
        proc.stdin.write(mocks + deviceScript(script));
        proc.stdin.end();
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
        ]);
        return { host: h.name, stdout, stderr, code, ok: code === 0 };
      };
      try {
        const r = await androidFlow(cfg, "phone", [
          { action: "type", label: "search", text: "hi" }, { action: "key", key: "back" },
        ], { target, settleMs: 0, read: false }, d);
        expect(r.steps.map((s) => s.status)).toEqual(["failed", "not_run"]);
        const events = await readFile(eventsFile, "utf8");
        expect(events).not.toContain("text");
        expect(events).not.toContain("keyevent");
        if (mode === "after") expect(events, r.steps[0]!.detail).toContain("tap");
        else expect(events).toBe("");
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  });
  test("malformed steps refuse before anything runs", async () => {
    await expect(androidFlow(cfg, "phone", [])).rejects.toThrow(/non-empty/);
    await expect(androidFlow(cfg, "phone", Array.from({ length: 31 }, () => ({ action: "key" as const, key: "back" })))).rejects.toThrow(/at most 30/);
    await expect(androidFlow(cfg, "phone", [{ action: "open" }])).rejects.toThrow(/needs what/);
    await expect(androidFlow(cfg, "phone", [{ action: "tap" }])).rejects.toThrow(/needs label or role/);
    await expect(androidFlow(cfg, "phone", [{ action: "type", label: "x" }])).rejects.toThrow(/needs text/);
    await expect(androidFlow(cfg, "phone", [{ action: "wait", label: "x", focus: "y" }])).rejects.toThrow(/label\/role or focus/);
    await expect(androidFlow(cfg, "phone", [{ action: "sleep", ms: 20000 }])).rejects.toThrow(/0–10000/);
  });
});

describe("Android CLI flow and reads", () => {
  const screen = [...STATE, "__FA__XML", XML, "__FA__XMLEND"];
  const input = [...STATE, "__FA__HA a", "__FA__INPUT 0", "__FA__HB a"];
  const options = { grid: false, gridStep: 100, noOpen: true, settle: 0, wantShot: false };
  const invoke = async (args: string[], f: ReturnType<typeof fake>, extra = {}, d = deps(f)) => {
    const stdout: string[] = [], stderr: string[] = [];
    const log = spyOn(console, "log").mockImplementation((s) => { stdout.push(String(s)); });
    const error = spyOn(console, "error").mockImplementation((s) => { stderr.push(String(s)); });
    const exit = spyOn(process, "exit").mockImplementation(() => { throw new Error("CLI refused"); });
    try {
      const code = await androidCu(cfg, "phone", "phone", [...args], { ...options, ...extra }, d);
      return { code, stdout, stderr };
    } finally { log.mockRestore(); error.mockRestore(); exit.mockRestore(); }
  };
  test("flow emits one JSON result with its filtered final read", async () => {
    const f = fake({ stdout: screen }, { stdout: screen });
    const r = await invoke(["flow", '[{"action":"expect","label":"Wi-Fi"}]', "--read", "Wi-Fi", "--target", "chrome", "--json"], f);
    expect(r.code).toBe(0);
    expect(r.stdout).toHaveLength(1);
    const body = JSON.parse(r.stdout[0]!);
    expect(body.ok).toBe(true);
    expect(body.elements.every((e: any) => e.label.includes("Wi-Fi"))).toBe(true);
  });
  test("open and act read only after success and emit a single JSON value", async () => {
    for (const args of [["open", "com.android.chrome"], ["key", "chrome", "back"]]) for (const ok of [true, false]) {
      const first = args[0] === "open" ? STATE : input;
      const f = fake({ stdout: ok ? first : [...STATE, "__FA__REFUSE wrong focus"], code: ok ? 0 : 3 }, { stdout: screen });
      const r = await invoke([...args, "--read", "*", "--json"], f);
      expect(r.code).toBe(ok ? 0 : 1);
      expect(r.stdout).toHaveLength(1);
      const body = JSON.parse(r.stdout[0]!);
      expect(body.result.ok).toBe(ok);
      expect(body.read !== undefined).toBe(ok);
      expect(f.scripts.length).toBe(ok ? 2 : 1);
      if (ok) expect(body.read.elements.length).toBeGreaterThan(0);
    }
  });
  test("a read exception preserves a successful action's exit and JSON report", async () => {
    const f = fake({ stdout: input });
    const d = deps(f);
    let calls = 0;
    d.exec = async (...args: Parameters<typeof f.run>) => {
      if (++calls === 2) throw new Error("read disconnected");
      return f.run(...args);
    };
    const r = await invoke(["key", "chrome", "back", "--read", "*", "--json"], f, {}, d);
    expect(r.code).toBe(0);
    expect(r.stdout).toHaveLength(1);
    expect(JSON.parse(r.stdout[0]!).readError).toBe("read disconnected");
  });
  test("the new flags preserve literal type text and element filters", async () => {
    for (const literal of ["--read", "--target", "--no-read"]) {
      const typed = fake({ stdout: input });
      const r = await invoke(["type", "chrome", literal, "--json"], typed);
      expect(r.code).toBe(0);
      expect(deviceScript(typed.scripts[0]!)).toContain(`input text '${literal}'`);
      const elements = fake({ stdout: screen });
      const filtered = await invoke(["elements", literal, "--json"], elements);
      expect(filtered.code).toBe(0);
      expect(JSON.parse(filtered.stdout[0]!).elements).toEqual([]);
    }
  });
  test("malformed flags refuse before any device script is submitted", async () => {
    for (const flags of [["--read"], ["--target"], ["--no-read", "--read", "*"], ["--read", "--target", "chrome"]]) {
      const f = fake();
      await expect(invoke(["flow", '[{"action":"key","key":"back"}]', ...flags], f)).rejects.toThrow();
      expect(f.scripts).toEqual([]);
    }
    const unrelated = fake();
    await expect(invoke(["state", "--target", "chrome"], unrelated)).rejects.toThrow();
    expect(unrelated.scripts).toEqual([]);
  });
  test("no-read skips flow's final screen", async () => {
    const f = fake({ stdout: input });
    const r = await invoke(["flow", '[{"action":"key","key":"back"}]', "--no-read", "--json"], f);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout[0]!).elements).toBeUndefined();
    expect(f.scripts.length).toBe(1);
  });
  test("elements preserves every legacy field and the within suffix rule", async () => {
    const oldLines = (hideWithin: boolean) => androidElements(parseUiDump(XML), { width: 1000, height: 2000 }).map((e) =>
      `@${e.center.x},${e.center.y}`.padEnd(11) + " " + "  ".repeat(Math.min(6, Math.max(0, e.depth - 1)))
      + e.role + " " + JSON.stringify(e.label) + (e.derived ? " (from children)" : "")
      + (e.id ? ` #${e.id}` : "") + (e.actions.length ? ` [${e.actions.join(",")}]` : "")
      + (e.checked !== undefined ? (e.checked ? " checked" : " unchecked") : "")
      + (e.enabled ? "" : " disabled") + (e.focused ? " focused" : "") + (e.selected ? " selected" : "")
      + (!hideWithin && e.within ? ` in ${e.within}` : ""));
    const strip = (lines: string[]) => lines.map((s) => s.replace(/\x1b\[[0-9;]*m/g, ""));
    for (const [args, extra, hideWithin] of [
      [["elements"], {}, true], [["elements", "Wi-Fi"], {}, false], [["elements"], { label: "Wi-Fi" }, false],
      [["elements"], { role: "TextView" }, true],
    ] as const) {
      const r = await invoke([...args], fake({ stdout: screen }), extra);
      const expected = oldLines(hideWithin).filter((s) => args[1] || "label" in extra ? s.includes('"Wi-Fi"')
        : "role" in extra ? s.includes("TextView") : true);
      expect(strip(r.stdout.slice(1))).toEqual(expected);
    }
  });
});

describe("androidWait", () => {
  test("focus waits poll dumpsys and report the package", async () => {
    const f = fake({ stdout: [...STATE, "__FA__MET com.android.chrome"] });
    const r = await androidWait(cfg, "phone", { focus: "chrome", timeoutMs: 3000 }, deps(f));
    expect(r.satisfied).toBe(true);
    expect(deviceScript(f.scripts[0]!)).toContain(`case "$fp" in *chrome*) hit=1`);
  });
  test("label waits are confirmed with the real matcher", async () => {
    const f = fake({ stdout: [...STATE, "__FA__XML", XML, "__FA__XMLEND"] });
    const r = await androidWait(cfg, "phone", { label: "Wi-Fi" }, deps(f));
    expect(r.satisfied).toBe(true);
    expect(r.element?.id).toBe("row");
    expect(deviceScript(f.scripts[0]!)).toContain(`grep -qiE '(text|content-desc|hint|resource-id)="[^"]*Wi-Fi'`);
  });
  test("a timeout is unsatisfied with the reason", async () => {
    const f = fake({ stdout: [...STATE, "__FA__XML", XML, "__FA__XMLEND", "__FA__TIMEOUT"] });
    const r = await androidWait(cfg, "phone", { label: "Bluetooth", timeoutMs: 1000 }, deps(f));
    expect(r.satisfied).toBe(false);
    expect(r.reason).toMatch(/after 1000 ms label "Bluetooth" is not there/);
  });
  test("gone is satisfied when the label is absent", async () => {
    const f = fake({ stdout: [...STATE, "__FA__XML", XML, "__FA__XMLEND"] });
    expect((await androidWait(cfg, "phone", { label: "Bluetooth", gone: true }, deps(f))).satisfied).toBe(true);
  });
  test("needs exactly one kind of condition", async () => {
    await expect(androidWait(cfg, "phone", {})).rejects.toThrow(/either/);
    await expect(androidWait(cfg, "phone", { label: "x", focus: "y" })).rejects.toThrow(/either/);
  });
});

describe("the UI helper", () => {
  test("every tree read tries the helper, starts it, then falls back to uiautomator", async () => {
    const f = fake({ stdout: [...STATE, "__FA__UIVIA helper", "__FA__XML", XML, "__FA__XMLEND"] });
    const r = await androidElementsOf(cfg, "phone", {}, deps(f));
    expect(r.via).toBe("helper");
    const dev = deviceScript(f.scripts[0]!);
    expect(dev).toContain(`= ${UI_JAR_MD5} ] || { echo "__FA__UIJAR missing"; return 1; }`);
    expect(dev).toContain("setsid app_process / fleet.UiServer $port /data/local/tmp/fleet-ui.token 120000");
    expect(dev.indexOf("ui_start && ui_ask dump")).toBeLessThan(dev.indexOf("uiautomator dump"));
  });
  test("a phone without the jar gets it installed after the read", async () => {
    const f = fake({ stdout: [...STATE, "__FA__UIJAR missing", "__FA__UIVIA uiautomator", "__FA__XML", XML, "__FA__XMLEND"] }, { stdout: [] });
    const r = await androidElementsOf(cfg, "phone", {}, deps(f));
    expect(r.via).toBe("uiautomator");
    expect(f.scripts.length).toBe(2);
    expect(f.scripts[1]).toContain('adb -s "$S" push "$j" /data/local/tmp/fleet-ui.jar');
    expect(f.scripts[1]).toContain(`[ "$got" = ${UI_JAR_MD5} ]`);
  });
  test("release stops a running helper", async () => {
    const f = fake({ stdout: ["__FA__RELEASED"] });
    expect((await androidRelease(cfg, "phone", deps(f))).detail).toMatch(/released/);
    const g = fake({ stdout: ["__FA__IDLE"] });
    expect((await androidRelease(cfg, "phone", deps(g))).detail).toMatch(/not running/);
  });
});

describe("compressed replies", () => {
  test("a gzip block expands in place", async () => {
    const { gzipSync } = await import("node:zlib");
    const body = [...STATE, "__FA__XML", XML, "__FA__XMLEND"].join("\n") + "\n";
    const b64 = gzipSync(Buffer.from(body)).toString("base64").replace(/(.{76})/g, "$1\n");
    const out = unpackReply(`before\n__FA__GZ\n${b64}\n__FA__GZEND\nafter`);
    expect(out).toBe(`before\n${body}after`);
    const f = fake({ stdout: [`__FA__GZ`, gzipSync(Buffer.from(body)).toString("base64"), "__FA__GZEND"] });
    const r = await androidElementsOf(cfg, "phone", {}, deps(f));
    expect(r.state.pkg).toBe("com.android.chrome");
    expect(r.elements.some((e) => e.id === "row")).toBe(true);
  });
  test("a reply without a block is unchanged", () => expect(unpackReply("a\nb")).toBe("a\nb"));
});

describe("notifications", () => {
  const lines = [
    "NotificationRecord(0x0abc: pkg=com.whatsapp user=UserHandle{0} id=1 tag=null importance=4 key=0|com.whatsapp|1|null|10123: Notification(channel=group shortcut=x)",
    "when=1790000000000/+5m",
    "android.title=String (Family)",
    "android.text=String (see you at 8)",
    "android.subText=null",
    "NotificationRecord(0x0def: pkg=com.android.systemui user=UserHandle{0} id=7 tag=x importance=1 key=0|com.android.systemui|7|x|10000: Notification(channel=x)",
    "when=1790000100000/+1m",
    "android.title=SpannableString (USB debugging connected)",
    "android.text=String (Tap to turn off)",
    "NotificationRecord(0x0fff: pkg=com.empty user=UserHandle{0} id=2 tag=null importance=2 key=0|com.empty|2|null|10: Notification(channel=x)",
  ];
  test("parses records, unwraps values, drops empty ones, newest first", () => {
    const n = parseNotifications(lines);
    expect(n.map((x) => x.pkg)).toEqual(["com.android.systemui", "com.whatsapp"]);
    expect(n[1]).toEqual({ pkg: "com.whatsapp", importance: 4, key: "0|com.whatsapp|1|null|10123",
      when: 1790000000000, title: "Family", text: "see you at 8" });
    expect(n[0]!.title).toBe("USB debugging connected");
  });
  test("reads only the live list and filters by package", async () => {
    const f = fake({ stdout: lines.map((l) => "__FA__N " + l) });
    const r = await androidNotifications(cfg, "phone", { pkg: "whats" }, deps(f));
    expect(r.notifications.map((x) => x.title)).toEqual(["Family"]);
    expect(deviceScript(f.scripts[0]!)).toContain("awk '/^  mArchive=/{exit}");
  });
});

describe("the controller's own adb", () => {
  const lan: Host = { name: "handset-wifi", ssh: "phone", os: "linux", android: { serial: "127.0.0.1:5555" } };
  // A local runner that answers ssh -G and adb like a reachable phone.
  const local = (calls: string[][], opts: { adbState?: string; sshUp?: boolean } = {}) => async (cmd: string[]) => {
    calls.push(cmd);
    if (cmd[0] === "ssh") return { code: 0, stdout: "hostname 127.0.0.1\nport 8022\n", stderr: "" };
    if (cmd.includes("get-state")) return { code: 0, stdout: `${opts.adbState ?? "device"}\n`, stderr: "" };
    if (cmd.join(" ").includes("mCurrentFocus")) return { code: 0, stdout: "  mCurrentFocus=Window{1 u0 com.whatsapp/com.whatsapp.Main}\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const fakeSpawn = (argvs: string[][]) => ((argv: string[]) => { argvs.push(argv); return { pid: 999999, unref() {} }; }) as any;

  test("watch opens scrcpy on the phone's network serial, view-only on request", async () => {
    // 127.0.0.1:5555 is closed here, so point the serial at a port that answers.
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const h: Host = { ...lan, android: { serial: `127.0.0.1:${server.port}` } };
      const argvs: string[][] = [];
      const r = await androidWatch([h], { viewOnly: true }, { local: local([]), spawn: fakeSpawn(argvs) });
      expect(r.ok).toBe(true);
      expect(argvs[0]).toEqual(expect.arrayContaining(["scrcpy", "-s", `127.0.0.1:${server.port}`, "--no-control"]));
    } finally { server.stop(true); }
  });
  test("an unreachable adb address is skipped without adb connect", async () => {
    const calls: string[][] = [];
    const h: Host = { ...lan, android: { serial: "127.0.0.1:1" } };
    const r = await androidWatch([h], {}, { local: local(calls), spawn: fakeSpawn([]) });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/nothing answers on 127.0.0.1:1/);
    expect(calls.some((c) => c.includes("connect"))).toBe(false);
  });
  test("record start remembers the scrcpy process, status and stop read it back", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const dir = mkdtempSync(join(tmpdir(), "fleet-rec-"));
    try {
      const h: Host = { ...lan, android: { serial: `127.0.0.1:${server.port}` } };
      const argvs: string[][] = [];
      const file = join(dir, "demo.mp4");
      const r = await androidRecordStart([h], file, { limitS: 30 }, { local: local([]), spawn: fakeSpawn(argvs), cacheDir: dir });
      expect(r.recording).toBe(true);
      expect(argvs[0]).toEqual(expect.arrayContaining(["--no-playback", "--record", file, "--time-limit", "30"]));
      // pid 999999 is not a live process, so the recording reads as ended.
      expect((await androidRecordStatus([h], { cacheDir: dir })).recording).toBe(false);
      await Bun.write(file, "fake mp4 bytes");
      const stopped = await androidRecordStop([h], { cacheDir: dir });
      expect(stopped).toMatchObject({ ok: true, localVideo: file, bytes: 14 });
      expect((await androidRecordStop([h], { cacheDir: dir })).ok).toBe(false);
      await expect(androidRecordStart([h], file, { limitS: 5000 })).rejects.toThrow(/1–3600/);
    } finally { server.stop(true); await rm(dir, { recursive: true, force: true }); }
  });
  test("revive opens Termux through adb and returns to the app the user was in", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const h: Host = { ...lan, android: { serial: `127.0.0.1:${server.port}` } };
      const calls: string[][] = [];
      let probes = 0;
      const r = await androidRevive([h], { waitMs: 5000 }, { local: local(calls), probe: async () => ++probes > 1 });
      expect(r.ok).toBe(true);
      const shells = calls.filter((c) => c.includes("shell")).map((c) => c.at(-1));
      expect(shells).toContain("am start -n com.termux/.app.TermuxActivity");
      expect(shells.some((c) => c?.startsWith("monkey -p com.whatsapp"))).toBe(true);
      expect(shells).not.toContain("am force-stop com.termux");
    } finally { server.stop(true); }
  });
  test("revive says so when SSH already works", async () => {
    const r = await androidRevive([lan], {}, { local: local([]), probe: async () => true });
    expect(r).toMatchObject({ ok: true, detail: "SSH to handset-wifi already works" });
  });
});
