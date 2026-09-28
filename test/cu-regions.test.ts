import { expect, test } from "bun:test";
import { cuAct, cuRegions, cuReplyRefusal, type CuSnapshot } from "../src/core.ts";
import {
  cuPickRegion, parseRegionReply, perceptionScript, regionCenter, regionPs, type CuRegion,
} from "../src/perception.ts";
import type { Host } from "../src/config.ts";
import { cuaFixture } from "./helpers/cua-driver.ts";

const host: Host = { name: "local", ssh: "local", os: "linux" };
const cfg = { hosts: { local: host } };
const ok = { host: "local", ok: true, code: 0, stdout: "", stderr: "" };
const snapshot = async (): Promise<CuSnapshot> => ({
  apps: [{ pid: 42, name: "Fixture" }], maxImageDimension: 400, result: ok,
  windows: [{ pid: 42, window_id: 7, title: "Fixture", x: 100, y: 200, width: 800, height: 600,
    on_screen: true, minimized: false, z_index: 1 }],
});

const raw = [
  { id: "text-1", kind: "text", text: "Save", confidence: 0.9, interactive: false, bounds: { x: 10, y: 20, width: 40, height: 20 } },
  { id: "text-2", kind: "text", text: "Save As", confidence: 0.8, interactive: false, bounds: { x: 60, y: 20, width: 60, height: 20 } },
  { id: "icon-3", kind: "icon", label: "icon-class-0", confidence: 0.7, interactive: true, bounds: { x: 200, y: 5, width: 31, height: 30 } },
  { id: "text-4", kind: "text", text: "Open  file", confidence: 0.6, interactive: false, bounds: { x: 10, y: 60, width: 80, height: 18 } },
  { id: "text-5", kind: "text", text: "Open folder", confidence: 0.6, interactive: false, bounds: { x: 10, y: 90, width: 80, height: 18 } },
  { id: "text-6", kind: "text", text: "Toolbar", confidence: 0.5, interactive: false, bounds: { x: 190, y: 0, width: 100, height: 50 } },
  { id: "icon-7", kind: "icon", label: "icon-class-0", confidence: 0.5, interactive: false, bounds: { x: 400, y: 400, width: 20, height: 20 } },
  { id: "icon-8", kind: "icon", label: "icon-class-0", confidence: 0.5, interactive: false, bounds: { x: 405, y: 405, width: 20, height: 20 } },
];
const regions = (parseRegionReply({ regions: raw }) as { regions: CuRegion[] }).regions;

async function viaBash(env: Record<string, string | undefined>, calls?: { n: number }) {
  return async (_host: Host, script: string) => {
    if (calls) calls.n++;
    const proc = Bun.spawn(["/bin/bash", "-s"], { env, stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { host: "local", ok: code === 0, code, stdout, stderr };
  };
}

test("a region's click point is inside its half-open bounds", () => {
  expect(regionCenter({ x: 10, y: 20, width: 40, height: 20 })).toEqual({ x: 29, y: 29 });
  expect(regionCenter({ x: 5, y: 5, width: 1, height: 1 })).toEqual({ x: 5, y: 5 });
  expect(regions[2]!.center).toEqual({ x: 215, y: 19 });
});

test("parse replies keep valid regions and surface driver errors", () => {
  const envelope = { jsonrpc: "2.0", id: 3, result: { structuredContent: { regions: [...raw, { id: "bad", kind: "text", bounds: { x: -1, y: 0, width: 1, height: 1 } }],
    capture: { capture_id: "capture_a_1", screenshot: { width: 800, height: 600 } }, timing: { duration_ms: 3000 } } } };
  const parsed = parseRegionReply(envelope);
  expect("regions" in parsed && parsed.regions.map((r) => r.id)).toEqual(raw.map((r) => r.id));
  expect("regions" in parsed && [parsed.captureId, parsed.width, parsed.durationMs]).toEqual(["capture_a_1", 800, 3000]);
  const absent = parseRegionReply({ jsonrpc: "2.0", id: 3, result: { isError: true,
    structuredContent: { code: "not_installed", message: "the optional cua-perception extension is not installed", retryable: false } } });
  expect(absent).toMatchObject({ code: "not_installed", retryable: false });
});

test("a region pick prefers exact text, refuses ambiguity, and never matches an icon's class label", () => {
  expect(cuPickRegion(regions, { text: "save" }).id).toBe("text-1");
  expect(cuPickRegion(regions, { text: "open file" }).id).toBe("text-4");
  expect(() => cuPickRegion(regions, { text: "open" })).toThrow(/2 regions match text "open"[^]*text-4[^]*text-5/);
  expect(cuPickRegion(regions, { text: "open", nth: 2 }).id).toBe("text-5");
  expect(() => cuPickRegion(regions, { text: "open", nth: 3 })).toThrow("--nth must be from 1 to 2");
  expect(() => cuPickRegion(regions, { text: "icon-class-0" })).toThrow(/no region with text/);
  expect(cuPickRegion(regions, { at: { x: 215, y: 19 } }).id).toBe("icon-3");
  expect(cuPickRegion(regions, { at: { x: 215, y: 19 }, kind: "text" }).id).toBe("text-6");
  expect(cuPickRegion(regions, { at: { x: 280, y: 40 } }).id).toBe("text-6");
  expect(() => cuPickRegion(regions, { at: { x: 410, y: 410 } })).toThrow(/2 regions match a region at 410,410; pass --nth N:/);
  expect(cuPickRegion(regions, { at: { x: 410, y: 410 }, nth: 2 }).id).toBe("icon-8");
  expect(() => cuPickRegion(regions, { at: { x: 290, y: 50 } })).toThrow(/^no region contains 290,50/);
  expect(() => cuPickRegion(regions, { text: "save", at: { x: 1, y: 1 } })).toThrow("not both");
  expect(() => cuPickRegion(regions, { at: { x: 1.5, y: 1 } })).toThrow("non-negative integer");
});

test("regions capture and parse in one driver session and return the parsed capture", async () => {
  const fixture = await cuaFixture();
  try {
    const r = await cuRegions(cfg, "local", "Fixture", { filter: "open", minConfidence: 0.5, imageOut: `${fixture.root}/regions.png` },
      { snapshot, exec: await viaBash({ ...fixture.env, CUA_FIXTURE_REGIONS: JSON.stringify(raw) }) });
    expect(r.result.ok, r.result.stderr).toBe(true);
    expect(r.captureId).toBe("capture_fixture_1");
    expect(r.regions.map((g) => g.id)).toEqual(["text-4", "text-5"]);
    expect(r.total).toBe(8);
    expect([...new Uint8Array(await Bun.file(r.localImage!).arrayBuffer()).slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    const session = await fixture.read("session");
    expect(session[0].argv).toEqual(["--socket", `${fixture.root}/driver.sock`]);
    expect(session.slice(1).map((e: any) => e.name)).toEqual(["get_window_state", "parse_visual_regions"]);
    expect(session[1].args).toMatchObject({ pid: 42, window_id: 7, include_accessibility_tree: false });
    expect(session[2].args).toEqual({ capture_id: "capture_fixture_1", options: { min_confidence: 0.5 } });
  } finally { await fixture.cleanup(); }
});

test("a missing extension fails with its install command", async () => {
  const fixture = await cuaFixture();
  try {
    const r = await cuRegions(cfg, "local", "Fixture", {},
      { snapshot, exec: await viaBash({ ...fixture.env, CUA_FIXTURE_PERCEPTION: "absent" }) });
    expect(r.result.ok).toBe(false);
    expect(r.error?.code).toBe("not_installed");
    expect(r.hint).toBe("the cua-perception extension is not installed; install it with: fleet cu local perception install");
  } finally { await fixture.cleanup(); }
});

test("a region click binds to the parsed capture, clicks the region's center once, and verifies by pixels", async () => {
  const fixture = await cuaFixture();
  const calls = { n: 0 };
  try {
    const r = await cuAct(cfg, "local", "Fixture", "click", { count: 1 }, { settleMs: 0, region: { text: "save as" } },
      { snapshot, exec: await viaBash({ ...fixture.env, CUA_FIXTURE_REGIONS: JSON.stringify(raw) }, calls) });
    expect(r.result.ok, r.result.stderr).toBe(true);
    expect(calls.n).toBe(1);
    expect(r.region?.id).toBe("text-2");
    expect(r.effect).toBe("changed");
    const events = await fixture.read("events");
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe("click");
    expect(events[0].payload).toEqual({ count: 1, pid: 42, window_id: 7, x: 89, y: 29, capture_id: "capture_fixture_1" });
    expect(r.driverOutput).toContain("confirmed");
  } finally { await fixture.cleanup(); }
});

test("an ambiguous or missing region sends no input and names the candidates", async () => {
  const fixture = await cuaFixture();
  try {
    const exec = await viaBash({ ...fixture.env, CUA_FIXTURE_REGIONS: JSON.stringify(raw) });
    await expect(cuAct(cfg, "local", "Fixture", "click", {}, { settleMs: 0, region: { text: "open" } }, { snapshot, exec }))
      .rejects.toThrow(/2 regions match text "open"/);
    await expect(cuAct(cfg, "local", "Fixture", "click", {}, { settleMs: 0, region: { text: "close" } }, { snapshot, exec }))
      .rejects.toThrow(/no region with text "close"/);
    expect(await Bun.file(`${fixture.root}/events.json`).exists()).toBe(false);
  } finally { await fixture.cleanup(); }
});

test("a refused capture-bound click fails and is not retried", async () => {
  const fixture = await cuaFixture();
  try {
    const r = await cuAct(cfg, "local", "Fixture", "click", {}, { settleMs: 0, region: { at: { x: 215, y: 19 } } },
      { snapshot, exec: await viaBash({ ...fixture.env, CUA_FIXTURE_REGIONS: JSON.stringify(raw),
        CUA_FIXTURE_CLICK_REPLY: JSON.stringify({ effect: "refused", code: "capture_frame_mismatch" }) }) });
    expect(r.result.ok).toBe(false);
    expect(r.refusal).toBe("the driver refused the input (capture_frame_mismatch)");
    const clicks = (await fixture.read("session")).filter((e: any) => e.name === "click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0].args).toMatchObject({ x: 215, y: 19, capture_id: "capture_fixture_1" });
  } finally { await fixture.cleanup(); }
});

test("region clicks reject other addressing and non-click tools before any remote call", async () => {
  const exec = async () => { throw new Error("must not run"); };
  await expect(cuAct(cfg, "local", "Fixture", "type_text", { text: "x" }, { region: { text: "a" } }, { snapshot, exec }))
    .rejects.toThrow("click, right_click, and double_click only");
  await expect(cuAct(cfg, "local", "Fixture", "click", { x: 1, y: 1 }, { region: { text: "a" } }, { snapshot, exec }))
    .rejects.toThrow("only one");
  await expect(cuAct(cfg, "local", "Fixture", "click", {}, { region: {} }, { snapshot, exec }))
    .rejects.toThrow("a region needs its text or a point inside it");
});

test("a capture refusal reads as a refusal", () => {
  expect(cuReplyRefusal(JSON.stringify({ effect: "refused", code: "capture_expired" }))).toBe("the driver refused the input (capture_expired)");
  expect(cuReplyRefusal(JSON.stringify({ effect: "confirmed" }))).toBeUndefined();
});

test("the Windows session program refuses to run without a live mcp session", () => {
  const ps = regionPs();
  expect(ps).toContain("if ($script:fcuCli -or -not $script:fcuP)");
  expect(ps).toContain('"capture_id":"\' + $cp.capture_id');
});

test("perception install checks hashes and publisher verification and resolves the release per target", () => {
  const linux = perceptionScript("linux", "install");
  expect(linux).toContain("cua-perception-$ver-x86_64-unknown-linux-gnu");
  expect(linux).toContain("failed its SHA256SUMS check");
  expect(linux).toContain("^Trust: publisher-verified");
  expect(linux).toContain('verb=install; [ -n "$active" ] && verb=update');
  expect(perceptionScript("mac", "install", "0.2.1")).toContain("ver=0.2.1");
  expect(perceptionScript("mac", "install")).toContain("aarch64-apple-darwin");
  expect(perceptionScript("windows", "install")).toContain("x86_64-pc-windows-msvc");
  expect(perceptionScript("windows", "remove")).toContain("extension remove cua-perception");
  expect(() => perceptionScript("linux", "install", "1.0; rm -rf ~")).toThrow("version must look like");
});
