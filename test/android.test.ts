import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import {
  androidAct, androidBatch, androidBootstrap, androidElements, androidOpen, androidRelease, androidWait, androidElementsOf, androidInputText, androidKeycode, androidPick, androidShot,
  androidState, androidTargetPattern, parseUiDump, unpackReply,
} from "../src/android.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import { UI_JAR_MD5 } from "../src/android-ui-jar.ts";
import { validateConfig } from "../src/config.ts";
import type { ExecResult } from "../src/ssh.ts";

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
  test("limits and malformed steps refuse before anything runs", async () => {
    await expect(androidBatch(cfg, "phone", "any", [])).rejects.toThrow(/non-empty/);
    await expect(androidBatch(cfg, "phone", "any", Array.from({ length: 51 }, () => ({ action: "key" as const, key: "back" }))))
      .rejects.toThrow(/at most 50/);
    await expect(androidBatch(cfg, "phone", "any", [{ action: "sleep", ms: 20000 }])).rejects.toThrow(/0–10000/);
    await expect(androidBatch(cfg, "phone", "any", [{ action: "swipe", x: 1, y: 1 }])).rejects.toThrow(/step 1 \(swipe\) needs x2/);
    await expect(androidBatch(cfg, "phone", "any", [{ action: "key", key: "back", label: "x" }])).rejects.toThrow(/label does not apply/);
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
