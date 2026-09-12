import { expect, test } from "bun:test";
import { cuAct, cuBatch, type CuBatchAction, type CuSnapshot } from "../src/core.ts";
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

test("a real batch keeps quoting and target identity, runs in order, and captures only around the sequence", async () => {
  const fixture = await cuaFixture();
  let calls = 0;
  try {
    const text = "quotes ' \" $HOME `uname`\nline two";
    const result = await cuBatch(cfg, "local", "Fixture", [
      { tool: "click", args: { x: 10, y: 20 } },
      { tool: "type_text", args: { text }, delayMs: 1 },
      { tool: "drag", space: "screen", args: { from_x: 120, from_y: 240, to_x: 300, to_y: 400 } },
    ], { settleMs: 0 }, { snapshot, exec: async (_host, script) => {
      calls++;
      const proc = Bun.spawn(["/bin/bash", "-s"], { env: fixture.env,
        stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { host: "local", ok: code === 0, code, stdout, stderr };
    } });
    expect(result.result.ok, result.result.stderr).toBe(true);
    expect(calls).toBe(1);
    expect(result.effect).toBe("changed");
    expect(result.actions.map((step) => step.status)).toEqual(["completed", "completed", "completed"]);
    expect(result.actions.map((step) => step.driverOutput)).toEqual(["reply click", "reply type_text", "reply drag"]);
    const events = await fixture.read("events");
    expect(events.map((event: any) => event.tool)).toEqual(["click", "type_text", "drag"]);
    expect(events[1].payload.text).toBe(text);
    expect(events.every((event: any) => event.payload.pid === 42 && event.payload.window_id === 7)).toBe(true);
    expect(events[2].payload).toMatchObject({ from_x: 10, from_y: 20, to_x: 100, to_y: 100 });
    expect((await fixture.read("captures")).map((capture: any) => capture.actions)).toEqual([0, 3, 3]);
  } finally { await fixture.cleanup(); }
});

test.each([false, true])("driver and before-capture failures stop without retrying (capture failure %s)", async (captureFail) => {
  const fixture = await cuaFixture();
  try {
    const result = await cuBatch(cfg, "local", "Fixture", [
      { tool: "click", args: { x: 1, y: 1 } },
      { tool: "type_text", args: { text: "reject" } },
      { tool: "type_text", args: { text: "must not happen" } },
    ], { settleMs: 0 }, { snapshot, exec: async (_host, script) => {
      const proc = Bun.spawn(["/bin/bash", "-s"], { env: { ...fixture.env, CUA_FIXTURE_CAPTURE_FAIL: captureFail ? "1" : "0" },
        stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { host: "local", ok: code === 0, code, stdout, stderr };
    } });
    expect(result.result.code).toBe(captureFail ? 1 : 17);
    expect(result.result.ok).toBe(false);
    expect(result.actions.map((step) => step.status)).toEqual(captureFail ? ["not_run", "not_run", "not_run"] : ["completed", "failed", "not_run"]);
    if (!captureFail) expect((await fixture.read("events")).length).toBe(2);
  } finally { await fixture.cleanup(); }
});

test.each([
  { status: "refused", refusal: { code: "stale_element_token" } },
  { isError: true, content: [{ type: "text", text: "tool error" }] },
  { content: [{ type: "text", text: JSON.stringify({ status: "refused" }) }] },
  { escalation: { reason: "delivery_failed", target: "foreground" } },
])("structured refusal with exit zero stops remaining actions: %j", async (reply) => {
  const fixture = await cuaFixture();
  try {
    const result = await cuBatch(cfg, "local", "Fixture", [
      { tool: "click", args: { x: 1, y: 1 } },
      { tool: "type_text", args: { text: "refuse" } },
      { tool: "click", args: { x: 1, y: 1 } },
    ], { settleMs: 0 }, { snapshot, exec: async (_host, script) => {
      const proc = Bun.spawn(["/bin/bash", "-s"], { env: { ...fixture.env, CUA_FIXTURE_REPLY: JSON.stringify(reply) },
        stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { host: "local", ok: code === 0, code, stdout, stderr };
    } });
    expect(result.result.ok).toBe(false);
    expect(result.actions.map((step) => step.status)).toEqual(["completed", "failed", "not_run"]);
    expect(JSON.parse(result.actions[1]!.driverOutput)).toEqual(reply);
    expect((await fixture.read("events")).length).toBe(2);
  } finally { await fixture.cleanup(); }
});

test.each([
  { tool: "drag", args: { from_x: -1, from_y: 0, to_x: 1, to_y: 1 } },
  { tool: "drag", args: { from_x: 1, from_y: 1, to_x: 999, to_y: 1 } },
  { tool: "drag", args: { from_x: 1, from_y: 1, to_x: 1 } },
  { tool: "click", args: { target: { kind: "desktop", display_id: "primary" }, x: 1, y: 1 } },
  { tool: "click", args: { from_zoom: true, x: 1, y: 1 } },
  { tool: "click", args: { x: NaN, y: 1 } },
  { tool: "click", args: null },
  { tool: "click", delayMs: null },
  { tool: "click", delayMs: -1 },
  { tool: "click", delayMs: 0.5 },
  { tool: "click", space: "other" },
  { tool: "click", typo: true },
  { tool: "get_window_state" },
])("bad later input is rejected before any action: %j", async (bad) => {
  let inputs = 0;
  await expect(cuBatch(cfg, "local", "Fixture", [
    { tool: "click", args: { x: 1, y: 1 } }, bad as unknown as CuBatchAction,
  ], {}, { snapshot, exec: async () => { inputs++; return ok; } })).rejects.toThrow();
  expect(inputs).toBe(0);
});

test("single actions validate both drag endpoints and reject nested target overrides", async () => {
  for (const args of [{ from_x: 0, from_y: 0, to_x: 1000, to_y: 1000 }, { target: { kind: "desktop" } }])
    await expect(cuAct(cfg, "local", "Fixture", "drag", args, {}, { snapshot,
      exec: async () => { throw new Error("input must not run"); } })).rejects.toThrow(/outside|supplied/);
});

test("lost transport keeps completed receipts and marks missing confirmation without replay", async () => {
  let calls = 0;
  const result = await cuBatch(cfg, "local", "Fixture", [
    { tool: "click", args: { x: 1, y: 1 } }, { tool: "press_key", args: { key: "Return" } },
    { tool: "type_text", args: { text: "after" } },
  ], {}, { snapshot, exec: async (_host, script) => {
    calls++;
    const marker = script.match(/__FLEET_STEP_[a-f0-9]+__/)![0];
    return { ...ok, ok: false, code: 255, stderr: "connection lost", stdout:
      `__FLEET_CAP__act|\n${marker}0|start\nfirst reply\n${marker}0|exit|0\n${marker}1|start\npartial reply` };
  } });
  expect(calls).toBe(1);
  expect(result.actions.map((step) => step.status)).toEqual(["completed", "unconfirmed", "unconfirmed"]);
  expect(result.actions[1]?.driverOutput).toBe("partial reply");
  expect(result.result.stderr).toContain("inspect the window");
});
