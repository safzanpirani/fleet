import { beforeAll, describe, expect, test } from "bun:test";
import {
  cuAct, cuElements, cuPickElement, cuReplyRefusal, cuReplyText, cuResolveTargetFrom, cuVerify,
  parseCuElements, takeInlineImages,
} from "../src/core.ts";
import type { CuElement, CuSnapshot } from "../src/core.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const host = (name: string, os: Host["os"]): Host => ({ name, ssh: name, os });
const cfg: FleetConfig = { hosts: { win: host("win", "windows"), lin: host("lin", "linux") } };
const ok = { host: "win", ok: true, code: 0, stdout: "", stderr: "" };

const snapshot = async (): Promise<CuSnapshot> => ({
  apps: [{ pid: 42, name: "Character Map" }], maxImageDimension: 0, result: ok,
  windows: [{ pid: 42, window_id: 7, title: "Character Map", x: 100, y: 200, width: 400, height: 300,
    on_screen: true, minimized: false, z_index: 1 }],
});
const target = async () => cuResolveTargetFrom(await snapshot(), "Character Map");

const envelope = (result: unknown, id = 3) => JSON.stringify({ jsonrpc: "2.0", id, result });

// A 1x1 PNG, so delivery's artifact validation accepts it.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const elementsReply = JSON.stringify({
  snapshot_id: "s0000000c", total_element_count: 5, element_count: 5,
  elements: [
    { element_index: 0, element_token: "s0000000c:0", role: "Edit", label: "Characters to copy :", value: "",
      actions: ["set_value"], frame: { x: 150, y: 400, w: 100, h: 20 } },
    { element_index: 1, element_token: "s0000000c:1", role: "Button", label: "Select", actions: ["invoke"],
      frame: { x: 300, y: 400, w: 60, h: 20 } },
    { element_index: 2, element_token: "s0000000c:2", role: "Button", label: "Copy", actions: ["invoke"],
      frame: { x: 380, y: 400, w: 60, h: 20 } },
    { element_index: 3, element_token: "s0000000c:3", role: "CheckBox", label: "Advanced view", actions: ["toggle"],
      frame: { x: 110, y: 450, w: 90, h: 20 } },
    { element_index: 4, element_token: "s0000000c:4", role: "Button", label: "Copy all", enabled: false, actions: [],
      frame: { x: 9000, y: 9000, w: 10, h: 10 } },
  ],
});

describe("session replies", () => {
  test("a JSON-RPC envelope becomes the structured payload the CLI would print", () => {
    const text = cuReplyText(envelope({ content: [{ type: "text", text: "✅ Found 1 window" }],
      structuredContent: { windows: [{ window_id: 7 }] } }));
    expect(JSON.parse(text)).toEqual({ windows: [{ window_id: 7 }] });
  });

  test("text-only replies, errors, and plain CLI output all normalize", () => {
    expect(cuReplyText(envelope({ content: [{ type: "text", text: "✅ done" }] }))).toBe("done");
    expect(cuReplyText(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad params" } })))
      .toBe("bad params");
    expect(cuReplyText('{"effect":"unverifiable"}')).toBe('{"effect":"unverifiable"}');
    expect(cuReplyText("not json at all")).toBe("not json at all");
  });

  test("a delivery the app dropped is a refusal even with exit 0", () => {
    expect(cuReplyRefusal('{"effect":"unverifiable","escalation":{"reason":"delivery_failed"}}'))
      .toContain("--foreground");
    expect(cuReplyRefusal('{"status":"refused","refusal":{"code":"menu_path_unavailable"}}')).toContain("refused");
    expect(cuReplyRefusal('{"effect":"unverifiable","route":"accessibility"}')).toBeUndefined();
    expect(cuReplyRefusal("plain text")).toBeUndefined();
  });
});

describe("inline images", () => {
  test("framed base64 is lifted out and the rest of stdout is kept in order", () => {
    const b64 = PNG.toString("base64");
    const stdout = ["before", "__FLEET_B64__after", b64.slice(0, 20), b64.slice(20), "__FLEET_B64END__", "after"].join("\n");
    const { images, rest } = takeInlineImages(stdout);
    expect(Buffer.from(images.get("after")!).equals(PNG)).toBe(true);
    expect(rest).toBe("before\nafter");
  });

  test("a real Bash act returns its after-image in the same round trip and deletes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-cu-inline-"));
    const png = join(root, "fixture.png");
    const driver = join(root, "cua-driver");
    try {
      await writeFile(png, PNG);
      await writeFile(driver, `#!${process.execPath}\n`
        + `const payload = JSON.parse(await Bun.stdin.text());\n`
        + `if (process.argv[2] === 'get_window_state') await Bun.write(payload.screenshot_out_file, Bun.file(${JSON.stringify(png)}));\n`
        + `else console.log('{"effect":"unverifiable"}');\n`, { mode: 0o755 });
      const calls: string[] = [];
      const out = join(root, "local", "after.png");
      const result = await cuAct(cfg, "lin", "Character Map", "click", { x: 1, y: 1 }, { settleMs: 0, imageOut: out }, {
        snapshot,
        exec: async (h, script) => {
          calls.push(script);
          const proc = Bun.spawn(["/bin/bash", "-s"], {
            env: { ...process.env, TMPDIR: root },
            stdin: new TextEncoder().encode(script.replace(/^fcd=.*$/m, `fcd='${driver}'`)),
            stdout: "pipe", stderr: "pipe",
          });
          const [code, stdout, stderr] = await Promise.all([
            proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
          return { host: h.name, ok: code === 0, code, stdout, stderr };
        },
      });
      expect(result.result.ok, result.result.stderr).toBe(true);
      expect(result.effect).toBe("no_change");
      expect(calls.length).toBe(1);
      expect((await readFile(out)).equals(PNG)).toBe(true);
      const leftovers = [...new Bun.Glob("fleet_cu_*").scanSync(root)];
      expect(leftovers).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("Windows session transport", () => {
  const reply = (actReply: string) => [
    "__FLEET_HASH__A|aa", "__FLEET_CAP__act|", actReply, "__FLEET_END__", "__FLEET_HASH__B|aa",
  ].join("\n");

  test("one mcp session carries the captures and the action, then closes", async () => {
    let script = "";
    const r = await cuAct(cfg, "win", "Character Map", "click", { x: 5, y: 5 }, {}, {
      snapshot,
      exec: async (h, command) => {
        script = command;
        return { ...ok, host: h.name, stdout: reply(envelope({ content: [{ type: "text", text: "clicked" }],
          structuredContent: { effect: "unverifiable", route: "accessibility" } })) };
      },
    });
    expect(script).toContain("mcp --socket \\\\.\\pipe\\cua-driver");
    expect(script).toContain(`Invoke-FleetCua 'click' '{"x":5,"y":5,"pid":42,"window_id":7}'`);
    expect(script.match(/Invoke-FleetCua 'get_window_state'/g)?.length).toBe(3);
    expect(script.indexOf("Stop-FleetCua\n")).toBeGreaterThan(script.indexOf("$hC"));
    expect(JSON.parse(r.driverOutput)).toEqual({ effect: "unverifiable", route: "accessibility" });
    expect(r.result.ok).toBe(true);
  });

  test("a session reply that says delivery failed fails the action", async () => {
    const r = await cuAct(cfg, "win", "Character Map", "press_key", { key: "a" }, {}, {
      snapshot,
      exec: async (h) => ({ ...ok, host: h.name, stdout: reply(envelope({ content: [],
        structuredContent: { effect: "unverifiable", escalation: { reason: "delivery_failed", target: "foreground" } } })) }),
    });
    expect(r.result.ok).toBe(false);
    expect(r.refusal).toContain("delivery_failed");
    expect(r.result.stderr).toContain("--foreground");
  });
});

describe("elements", () => {
  test("structured elements parse with tokens and a window-local center", async () => {
    const t = await target();
    const parsed = parseCuElements(elementsReply, t);
    expect(parsed.available).toBe(true);
    expect(parsed.snapshotId).toBe("s0000000c");
    expect(parsed.elements[1]).toMatchObject({ token: "s0000000c:1", role: "Button", label: "Select", actions: ["invoke"] });
    // frame center (330, 410) on screen, window origin (100, 200)
    expect(parsed.elements[1]!.center).toEqual({ x: 230, y: 210 });
    // a frame outside the window is not trusted as a click point
    expect(parsed.elements[4]!.center).toBeUndefined();
  });

  test("an empty or degraded walk says elements are unavailable", async () => {
    const t = await target();
    expect(parseCuElements('{"elements":[],"total_element_count":0}', t).available).toBe(false);
    expect(parseCuElements('{"elements":[],"degraded":true,"total_element_count":3}', t).available).toBe(false);
    expect(parseCuElements("no json", t).available).toBe(false);
  });

  test("the tree read skips the screenshot and projects host-side", async () => {
    let args: string[] = [];
    const r = await cuElements(cfg, "win", "Character Map", { filter: "copy" }, {
      snapshot,
      run: async (_c, _s, a) => { args = a; return { host: "win", result: { ...ok, stdout: elementsReply } }; },
    });
    expect(args[0]).toBe("get_window_state");
    expect(JSON.parse(args[1]!)).toEqual({ pid: 42, window_id: 7, include_screenshot: false, query: "copy" });
    expect(r.elements.length).toBe(5);
  });
});

describe("picking an element", () => {
  let elements: CuElement[] = [];
  beforeAll(async () => { elements = parseCuElements(elementsReply, await target()).elements; });

  test("an exact label beats a substring match", () => {
    expect(cuPickElement(elements, { label: "copy" }).token).toBe("s0000000c:2");
  });

  test("role narrows, and a substring match stands in when nothing is exact", () => {
    expect(cuPickElement(elements, { label: "characters", role: "edit" }).token).toBe("s0000000c:0");
  });

  test("an ambiguous label is refused with every candidate's token", () => {
    expect(() => cuPickElement(elements, { role: "Button" })).toThrow(/3 elements match role Button[\s\S]*s0000000c:4/);
    expect(cuPickElement(elements, { role: "Button", nth: 2 }).label).toBe("Copy");
    expect(() => cuPickElement(elements, { role: "Button", nth: 4 })).toThrow("--nth must be from 1 to 3");
  });

  test("a missing label lists what exists instead of failing blankly", () => {
    expect(() => cuPickElement(elements, { label: "Save" })).toThrow(/no element with label "Save"[\s\S]*Advanced view/);
  });
});

describe("element-addressed actions", () => {
  test("a label resolves to a token that replaces x,y in the action", async () => {
    let script = "";
    const r = await cuAct(cfg, "lin", "Character Map", "click", {}, { element: { label: "Select" } }, {
      snapshot,
      elements: async (_c, _s, _q, opts, deps) => {
        expect(opts?.filter).toBe("Select");
        return { host: "lin", result: ok, ...parseCuElements(elementsReply, deps!.target!) };
      },
      exec: async (h, command) => { script = command; return { ...ok, host: h.name, stdout: "__FLEET_HASH__A|aa\n__FLEET_HASH__B|aa" }; },
    });
    expect(script).toContain('"element_token":"s0000000c:1","pid":42,"window_id":7');
    expect(r.element?.label).toBe("Select");
  });

  test("a token needs no tree read", async () => {
    let script = "";
    await cuAct(cfg, "lin", "Character Map", "click", {}, { element: { token: "s00000009:4" } }, {
      snapshot,
      elements: async () => { throw new Error("must not read the tree"); },
      exec: async (h, command) => { script = command; return { ...ok, host: h.name, stdout: "" }; },
    });
    expect(script).toContain('"element_token":"s00000009:4"');
  });

  test("an element and a pixel point cannot both address one action", async () => {
    await expect(cuAct(cfg, "lin", "Character Map", "click", { x: 1, y: 1 }, { element: { label: "Select" } }, {
      snapshot, exec: async () => { throw new Error("must not deliver input"); },
    })).rejects.toThrow("not both");
  });
});

describe("verify", () => {
  const run = (stdout: string, code = 0) => async (_c: FleetConfig, _s: string, args: string[]) => {
    run.last = args;
    return { host: "win", result: { ...ok, ok: code === 0, code, stdout } };
  };
  run.last = [] as string[];

  test("predicates go to verify_state against the exact window", async () => {
    const r = await cuVerify(cfg, "win", "Character Map",
      [{ element: { selector: { label_contains: "Search" }, exists: true } }], { timeoutMs: 0 }, {
        snapshot,
        run: run(JSON.stringify({ status: "satisfied", elapsed_ms: 12, predicates: [
          { index: 0, status: "satisfied", observed_json: '{"label":"Search for :"}', unknown_reason: null }] })),
      });
    expect(JSON.parse(run.last[1]!)).toMatchObject({ pid: 42, window_id: 7, timeout_ms: 0 });
    expect(r.status).toBe("satisfied");
    expect(r.result.ok).toBe(true);
    expect(r.predicates[0]).toEqual({ index: 0, status: "satisfied", observed: { label: "Search for :" } });
  });

  test.each(["unsatisfied", "unknown"])("%s is never success", async (status) => {
    const r = await cuVerify(cfg, "win", "Character Map", [{ window: { exists: true } }], {}, {
      snapshot, run: run(JSON.stringify({ status, predicates: [{ index: 0, status, unknown_reason: "unsupported_predicate" }] })),
    });
    expect(r.status).toBe(status as any);
    expect(r.result.ok).toBe(false);
    expect(r.predicates[0]!.reason).toBe("unsupported_predicate");
  });

  test("bad bounds are refused before any host call", async () => {
    await expect(cuVerify(cfg, "win", "x", [], {}, { snapshot })).rejects.toThrow("1 to 8");
    await expect(cuVerify(cfg, "win", "x", [{}], { timeoutMs: 20000 }, { snapshot })).rejects.toThrow("timeout");
  });
});
