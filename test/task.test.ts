import { expect, test } from "bun:test";
import {
  androidLocator, androidTaskBackend, androidView, buildQuestions, desktopChord, desktopTaskBackend, desktopView,
  jevTransport, parseSubtask, runTask, taskWindow, validateChoice,
  type ChoiceTransport, type TaskBackend, type TaskExec, type TaskView,
} from "../src/task.ts";
import type { CuElement, CuElements, CuSnapshot, CuTarget, CuWindowInfo } from "../src/core.ts";
import type { AndroidElement } from "../src/android.ts";
import type { FleetConfig } from "../src/config.ts";

const task = (extra: Record<string, unknown> = {}) => parseSubtask({
  goal: "Rename the file", verification: ["The name field shows report.txt"], inputs: { name: "report.txt" }, ...extra,
});

/** One answer: the choice gets all the probability. */
const certain = (choice: string, ids: string[], confidence = 0.95) => ({
  choice, confidence, probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
});

/** A transport that answers each round from a script, choosing for every
 *  question it was asked (the first option when the script names none). */
function scripted(rounds: Record<string, string>[], bodies: any[] = []): ChoiceTransport {
  let i = 0;
  return {
    name: "Jev",
    async ask(state, questions) {
      bodies.push(JSON.parse(JSON.stringify({ state, questions })));
      const want = rounds[Math.min(i++, rounds.length - 1)]!;
      return { answers: Object.fromEntries(Object.entries(questions).map(([name, q]) => {
        const ids = Object.keys(q.criteria);
        return [name, certain(want[name] ?? (name.startsWith("verification_") ? "SATISFIED" : ids[0]!), ids)];
      })) };
    },
  };
}

const field = { id: "e1", role: "TextField", name: "Name", value: "", actions: ["TYPE_TEXT" as const], enabled: true };
const save = { id: "e2", role: "Button", name: "Save", actions: ["CLICK" as const], enabled: true };
const trash = { id: "e3", role: "Button", name: "Move to Trash", actions: ["CLICK" as const], enabled: true };

/** A backend over a list of views: each execute advances to the next view. */
function fakeBackend(views: TaskView[], execs: Partial<TaskExec>[] = []): TaskBackend & { sent: any[] } {
  let v = 0;
  const sent: any[] = [];
  return {
    sent, keys: ["ENTER", "ESCAPE", "TAB"], hotkeys: true, clickModifiers: true,
    async observe() { return views[Math.min(v, views.length - 1)]!; },
    async execute(_view, action) {
      sent.push(action);
      const r = execs[sent.length - 1] ?? {};
      if (r.stale === undefined && r.refusal === undefined && r.error === undefined) v++;
      return { effect: "changed", ...r };
    },
  };
}
const view = (elements: TaskView["elements"], window = "Rename"): TaskView =>
  ({ application: "Finder", window, context: {}, elements });

test("a subtask is validated without coercion", () => {
  expect(task().maxActions).toBe(30);
  expect(() => parseSubtask({ goal: "g", verification: "done" })).toThrow("array of strings");
  expect(() => parseSubtask({ goal: "g", verification: [] })).toThrow("at least one");
  expect(() => parseSubtask({ goal: "g", verification: ["v"], extra: 1 })).toThrow("unknown subtask field");
  expect(() => parseSubtask({ goal: "g", verification: ["v"], allowed_risks: ["format"] })).toThrow("unknown allowed_risks");
  expect(() => parseSubtask({ goal: "g", verification: ["v"], secret_inputs: ["pw"] })).toThrow("not inputs");
  expect(() => parseSubtask({ goal: "g", verification: ["v"], inputs: { NONE: "x" } })).toThrow("reserved");
  expect(() => parseSubtask({ goal: "g", verification: ["v"], inputs: { n: [1] } })).toThrow("finite number");
  expect(() => parseSubtask({ goal: "g", verification: ["v"], shortcuts: { "Command+S": "save" } })).toThrow("modifiers");
  expect(parseSubtask({ goal: "g", verification: ["v"], shortcuts: { "MOD+SHIFT+S": "save as" } }).shortcuts)
    .toEqual({ "MOD+SHIFT+S": "save as" });
});

test("questions offer only observed actionable targets, and risky ones only when allowed", () => {
  const disabled = { ...save, id: "e4", name: "Apply", enabled: false };
  const readOnly = { id: "e5", role: "StaticText", name: "Kind", actions: [], enabled: true };
  const opts = { keys: ["ENTER"], hotkeys: true, clickModifiers: true };
  const q = buildQuestions(task(), view([field, save, trash, disabled, readOnly]), opts);
  expect(Object.keys(q.questions.click_target!.criteria)).toEqual(["e2"]);
  expect(Object.keys(q.questions.type_text_target!.criteria)).toEqual(["e1"]);
  expect(q.questions.click_target!.criteria.e2).toBe("Element e2 in state.desktop.elements");
  expect(Object.keys(q.questions.type_text_input!.criteria)).toEqual(["name", "NONE"]);
  expect(Object.keys(q.maps.operation!)).toEqual(["CLICK", "TYPE_TEXT", "PRESS_KEY", "HOTKEY", "SCROLL",
    "SUBTASK_COMPLETE", "BLOCKED", "NEEDS_AGENT"]);
  const allowed = buildQuestions(task({ allowed_risks: ["delete"] }), view([save, trash]), opts);
  expect(Object.keys(allowed.questions.click_target!.criteria)).toEqual(["e2", "e3"]);
  // A phone has no chords and no click modifiers.
  const phone = buildQuestions(task(), view([save]), { keys: ["ENTER"], hotkeys: false, clickModifiers: false });
  expect(phone.questions.hotkey_value).toBeUndefined();
  expect(phone.questions.click_modifier).toBeUndefined();
  expect("HOTKEY" in phone.maps.operation!).toBe(false);
});

test("SET_VALUE is offered only when an input fits the control", () => {
  const slider = { id: "e6", role: "Slider", name: "Volume", actions: ["SET_VALUE" as const], enabled: true, valueType: "number" as const };
  const opts = { keys: [], hotkeys: false, clickModifiers: false };
  expect(buildQuestions(task(), view([slider]), opts).questions.set_value_target).toBeUndefined();
  expect(Object.keys(buildQuestions(task({ inputs: { level: 40 } }), view([slider]), opts).questions.set_value_target!.criteria))
    .toEqual(["e6"]);
});

test("an answer must choose among exactly the offered ids with a coherent distribution", () => {
  expect(validateChoice(certain("a", ["a", "b"]), ["a", "b"]).choice).toBe("a");
  expect(() => validateChoice(certain("c", ["a", "c"]), ["a", "b"])).toThrow("invalid");
  expect(() => validateChoice({ choice: "a", confidence: 0.9, probabilities: { a: 0.4, b: 0.6 } }, ["a", "b"])).toThrow("invalid");
  expect(() => validateChoice({ choice: "a", confidence: 0.9, probabilities: { a: 0.5, b: 0.3 } }, ["a", "b"])).toThrow("invalid");
});

test("a run types a supplied input, then completes when every criterion is satisfied", async () => {
  const filled = { ...field, value: "report.txt" };
  const backend = fakeBackend([view([field, save]), view([filled, save])]);
  const r = await runTask(task(), backend, scripted([
    { operation: "TYPE_TEXT", type_text_target: "e1", type_text_input: "name", type_text_then_key: "ENTER" },
    { operation: "SUBTASK_COMPLETE" },
  ]), { lateReactionMs: 0 });
  expect(r.status).toBe("SUBTASK_COMPLETE");
  expect(backend.sent).toEqual([{ op: "TYPE_TEXT", targetId: "e1", value: "report.txt", key: "ENTER" }]);
  expect(r.steps[0]).toMatchObject({ step: 1, action: "TYPE_TEXT", target_name: "Name", effect: "changed", state_changed: true });
  expect(r.jev_calls).toBe(2);
});

test("completion with an unverified criterion hands back", async () => {
  const r = await runTask(task(), fakeBackend([view([field])]), scripted([
    { operation: "SUBTASK_COMPLETE", verification_0: "UNKNOWN" },
  ]), { lateReactionMs: 0 });
  expect(r.status).toBe("NEEDS_AGENT");
  expect(r.reason).toContain("not verified");
});

test("a field no input fits ends as NEEDS_INPUT naming the field", async () => {
  const r = await runTask(task(), fakeBackend([view([field])]), scripted([
    { operation: "TYPE_TEXT", type_text_target: "e1", type_text_input: "NONE" },
  ]));
  expect(r.status).toBe("NEEDS_INPUT");
  expect(r.needs_input).toEqual({ element_id: "e1", role: "TextField", name: "Name", value: "" });
});

test("three actions that change nothing end the run as BLOCKED", async () => {
  const same = view([save]);
  const backend = fakeBackend([same, same, same, same], [{ effect: "no_change" }, { effect: "no_change" }, { effect: "no_change" }]);
  const r = await runTask(task(), backend, scripted([{ operation: "CLICK", click_target: "e2" }]), { lateReactionMs: 0 });
  expect(r.status).toBe("BLOCKED");
  expect(r.actions_taken).toBe(3);
});

test("a stale target is read again and decided again, not counted as an action", async () => {
  const backend = fakeBackend([view([save]), view([save], "Done")], [{ stale: "no element with label \"Save\"", effect: "indeterminate" }]);
  const r = await runTask(task(), backend, scripted([
    { operation: "CLICK", click_target: "e2" }, { operation: "CLICK", click_target: "e2" }, { operation: "SUBTASK_COMPLETE" },
  ]), { lateReactionMs: 0 });
  expect(r.status).toBe("SUBTASK_COMPLETE");
  expect(backend.sent).toHaveLength(2);
  expect(r.actions_taken).toBe(1);
});

test("a refused input, low confidence, and a dry run all stop without guessing", async () => {
  const refused = await runTask(task(), fakeBackend([view([save])], [{ refusal: "delivery_failed", effect: "indeterminate" }]),
    scripted([{ operation: "CLICK", click_target: "e2" }]));
  expect(refused.status).toBe("NEEDS_AGENT");
  expect(refused.reason).toContain("delivery_failed");

  const lowConfidence: ChoiceTransport = {
    name: "Jev",
    async ask(_state, questions) {
      return { answers: Object.fromEntries(Object.entries(questions).map(([n, q]) => {
        const ids = Object.keys(q.criteria);
        const choice = n === "operation" ? "CLICK" : ids[0]!;
        return [n, certain(choice, ids, 0.4)];
      })) };
    },
  };
  const backend = fakeBackend([view([save])]);
  const gated = await runTask(task(), backend, lowConfidence, { minConfidence: 0.6 });
  expect(gated.status).toBe("NEEDS_AGENT");
  expect(backend.sent).toHaveLength(0);

  const dry = await runTask(task(), backend, scripted([{ operation: "CLICK", click_target: "e2", click_modifier: "NONE" }]), { dryRun: true });
  expect(dry.status).toBe("DRY_RUN");
  expect(dry.planned_action).toEqual({ action: "CLICK", target: "e2", target_name: "Save" });
  expect(backend.sent).toHaveLength(0);
});

test("an invalid answer is asked again once, then hands back", async () => {
  let calls = 0;
  const broken: ChoiceTransport = { name: "Jev", async ask() { calls++; return { answers: { operation: { choice: "FLY" } } }; } };
  const r = await runTask(task(), fakeBackend([view([save])]), broken);
  expect(r.status).toBe("NEEDS_AGENT");
  expect(r.reason).toContain("question: operation");
  expect(calls).toBe(2);
});

test("a secret input reaches the host but never Jev or the result", async () => {
  const pw = { id: "e7", role: "SecureTextField", name: "Password", value: "", actions: ["TYPE_TEXT" as const], enabled: true };
  const echoed = { ...pw, value: "hunter22" };     // an app that shows what was typed
  const backend = fakeBackend([view([pw]), view([echoed])]);
  const bodies: any[] = [];
  const r = await runTask(task({ inputs: { pw: "hunter22" }, secret_inputs: ["pw"] }), backend, scripted([
    { operation: "TYPE_TEXT", type_text_target: "e7", type_text_input: "pw", type_text_then_key: "NONE" },
    { operation: "NEEDS_AGENT" },
  ], bodies), { lateReactionMs: 0 });
  expect(backend.sent[0].value).toBe("hunter22");
  expect(JSON.stringify(bodies)).not.toContain("hunter22");
  expect(JSON.stringify(bodies)).toContain("[secret]");
  expect(JSON.stringify(r)).not.toContain("hunter22");
});

test("the transport retries rate limits and never surfaces the server body", async () => {
  const key = { apiKey: "k", model: "jev-latest", endpoint: "https://example.invalid", timeoutMs: 1000 };
  let n = 0;
  const flaky = (async () => (++n < 3 ? new Response("busy", { status: 429 })
    : new Response(JSON.stringify({ answers: { a: 1 } })))) as unknown as typeof fetch;
  expect(await jevTransport(key, { fetch: flaky, sleep: async () => {} }).ask({}, {})).toEqual({ answers: { a: 1 } });
  const tooBig = (async () => new Response(JSON.stringify({ detail: { error_type: "max_tokens_exceeded", message: "echo of the request" } }),
    { status: 400 })) as unknown as typeof fetch;
  const error = await jevTransport(key, { fetch: tooBig }).ask({}, {}).then(() => undefined, (e: Error) => e);
  expect(error?.message).toContain("max_tokens_exceeded");
  expect(error?.message).not.toContain("echo");
});

// ── desktop backend ──────────────────────────────────────────────────────────

const win = (id: number, extra: Partial<CuWindowInfo> = {}): CuWindowInfo => ({
  window_id: id, pid: 10, title: "Untitled", app_name: "TextEdit", x: 0, y: 0, width: 800, height: 600,
  on_screen: true, minimized: false, z_index: 1, ...extra,
});
const target = (w = win(5), blockers: CuWindowInfo[] = []): CuTarget => ({
  pid: 10, name: "TextEdit", matched: "app", window: w, siblings: blockers, blockers, capture: { width: 800, height: 600, scale: 1 },
});
const cu = (index: number, role: string, label: string, actions: string[], extra: Partial<CuElement> = {}): CuElement =>
  ({ index, token: `s1:${index}`, role, label, actions, ...extra });
const elements = (rows: CuElement[], t = target()): CuElements =>
  ({ host: "mac", result: { host: "mac", ok: true, code: 0, stdout: "", stderr: "" } as any, target: t, total: rows.length, elements: rows, available: true });

test("cua-driver elements map to operations, addressed by role, label and position", () => {
  const rows = [
    cu(0, "AXWindow", "Untitled", ["AXRaise"]),
    cu(1, "AXButton", "OK", ["AXPress"]),
    cu(2, "AXTextField", "Name", [], { value: "draft" }),
    cu(3, "AXRow", "", ["AXShowDefaultUI"]),
    cu(4, "AXRow", "report.txt", ["AXShowMenu"]),
    cu(5, "AXButton", "OK", ["AXPress"]),
    cu(6, "AXSlider", "Zoom", ["AXIncrement"]),
    cu(7, "AXButton", "Disabled", ["AXPress"], { enabled: false }),
  ];
  const { view: v, refs } = desktopView(elements(rows), "mac");
  const ops = Object.fromEntries(v.elements.map((e) => [e.id, e.actions]));
  expect(ops).toEqual({
    e0: [], e1: ["CLICK"], e2: ["TYPE_TEXT"], e3: [], e4: ["CLICK", "DOUBLE_CLICK", "RIGHT_CLICK"],
    e5: ["CLICK"], e6: ["SET_VALUE"], e7: [],
  });
  expect(v.elements.find((e) => e.id === "e2")!.value).toBe("draft");
  expect(v.elements.find((e) => e.id === "e6")!.valueType).toBe("number");
  expect(refs.get("e1")!.locator).toEqual({ label: "OK", role: "Button", nth: 1 });
  expect(refs.get("e5")!.locator).toEqual({ label: "OK", role: "Button", nth: 2 });
  // Off Windows a token dies with its read, so an unlabelled control is read-only;
  // on Windows the token survives and addresses it.
  const onWindows = desktopView(elements([cu(3, "DataItem", "", ["invoke"])]), "windows");
  expect(onWindows.view.elements[0]!.actions).toEqual(["CLICK", "DOUBLE_CLICK"]);
  expect(onWindows.refs.get("e3")!.locator).toEqual({ token: "s1:3" });
});

test("a task works in a modal dialog over its window, not in another document window", () => {
  const main = win(5, { z_index: 1 });
  const dialog = win(9, { title: "Save", width: 400, height: 200, x: 200, y: 100, z_index: 3 });
  const other = win(7, { title: "Other", width: 900, height: 700, z_index: 2 });
  const snap: CuSnapshot = { apps: [{ name: "TextEdit", pid: 10 }], windows: [main, dialog, other], maxImageDimension: 0,
    result: { host: "mac", ok: true, code: 0, stdout: "", stderr: "" } as any };
  expect(taskWindow(target(main, [dialog, other]), snap).window.window_id).toBe(9);
  expect(taskWindow(target(main, [other]), snap).window.window_id).toBe(5);
});

test("desktop actions go through cuAct with the right tool, keys and locator", async () => {
  const cfg: FleetConfig = { hosts: { mac: { name: "mac", ssh: "mac", os: "mac" } } };
  const calls: any[] = [];
  const t = target();
  const rows = [cu(1, "AXTextField", "Name", []), cu(2, "AXButton", "OK", ["AXPress"])];
  let failNext = "";
  const backend = desktopTaskBackend(cfg, "mac", "TextEdit", {}, {
    resolve: async () => ({ target: t, snapshot: { apps: [], windows: [t.window], maxImageDimension: 0, result: {} as any } }),
    elements: async () => elements(rows, t),
    act: (async (_cfg: unknown, _sel: string, query: string, tool: string, payload: Record<string, unknown>, opts: any) => {
      calls.push({ query, tool, payload, element: opts.element });
      if (failNext) { const m = failNext; failNext = ""; throw new Error(m); }
      return { effect: "changed", result: { ok: true, code: 0, stdout: "", stderr: "" }, driverOutput: "" };
    }) as any,
  });
  const v = await backend.observe();
  expect(v.context.window_id).toBe(5);
  await backend.execute(v, { op: "TYPE_TEXT", targetId: "e1", value: "a.txt", key: "ENTER" });
  await backend.execute(v, { op: "CLICK", targetId: "e2", clickModifier: "MOD" });
  await backend.execute(v, { op: "HOTKEY", hotkey: "MOD+SHIFT+Z" });
  await backend.execute(v, { op: "PRESS_KEY", key: "ARROW_DOWN" });
  expect(calls).toEqual([
    { query: "w5", tool: "set_value", payload: { value: "a.txt" }, element: { label: "Name", role: "TextField", nth: 1 } },
    { query: "w5", tool: "press_key", payload: { key: "return" }, element: { label: "Name", role: "TextField", nth: 1 } },
    { query: "w5", tool: "click", payload: { modifier: ["cmd"] }, element: { label: "OK", role: "Button", nth: 1 } },
    { query: "w5", tool: "hotkey", payload: { keys: ["cmd", "shift", "z"] }, element: undefined },
    { query: "w5", tool: "press_key", payload: { key: "down" }, element: undefined },
  ]);
  failNext = 'no element with role AXButton and label "OK"';
  expect((await backend.execute(v, { op: "CLICK", targetId: "e2" })).stale).toContain("no element");
  failNext = "ssh: connection reset";
  expect((await backend.execute(v, { op: "CLICK", targetId: "e2" })).error).toContain("connection reset");
  expect(desktopChord("MOD+S", "windows")).toEqual(["ctrl", "s"]);
});

// ── Android backend ──────────────────────────────────────────────────────────

const ae = (index: number, role: string, extra: Partial<AndroidElement>): AndroidElement => ({
  index, ancestors: [], depth: 1, role, label: "", derived: false, text: "", desc: "", hint: "", id: "", pkg: "com.example",
  actions: [], enabled: true, selected: false, focused: false, password: false,
  bounds: { x1: 0, y1: index * 100, x2: 100, y2: index * 100 + 90 }, center: { x: 50, y: index * 100 + 45 }, ...extra,
});

test("a phone screen maps taps, long presses, and typing into empty fields only", () => {
  const rows = [
    ae(1, "EditText", { hint: "Search", label: "Search", actions: ["tap", "type"] }),
    ae(2, "EditText", { text: "hello", label: "hello", id: "msg", actions: ["tap", "type"] }),
    ae(3, "Button", { text: "Send", label: "Send", actions: ["tap", "long_press"] }),
    ae(4, "TextView", { text: "Inbox", label: "Inbox" }),
    ae(5, "Button", { text: "Send", label: "Send", actions: ["tap"] }),
  ];
  const { view: v } = androidView(rows, { pkg: "com.example", width: 1080, height: 2400 });
  const ops = Object.fromEntries(v.elements.map((e) => [e.id, e.actions]));
  expect(ops).toEqual({ a1: ["CLICK", "TYPE_TEXT"], a2: ["CLICK"], a3: ["CLICK", "RIGHT_CLICK"], a4: [], a5: ["CLICK"] });
  expect(v.elements[1]!.value).toBe("hello");
  expect(androidLocator(rows, rows[4]!)).toEqual({ label: "Send", role: "Button", nth: 2 });
});

test("phone actions go through androidAct with the focus gate and mapped keys", async () => {
  const cfg: FleetConfig = { hosts: { phone: { name: "phone", ssh: "phone", os: "linux" } } } as FleetConfig;
  const calls: any[] = [];
  const rows = [ae(1, "EditText", { hint: "Search", label: "Search", actions: ["tap", "type"] })];
  const backend = androidTaskBackend(cfg, "phone", "com.example", {}, {
    elementsOf: (async () => ({ host: "phone", result: { ok: true, code: 0, stdout: "", stderr: "" }, state: { pkg: "com.example" }, elements: rows, total: 1 })) as any,
    act: (async (_cfg: unknown, _sel: string, gate: string, a: unknown, opts: any) => {
      calls.push({ gate, a, element: opts.element });
      return { effect: "changed", result: { ok: true, code: 0, stdout: "", stderr: "" } };
    }) as any,
  });
  const v = await backend.observe();
  await backend.execute(v, { op: "TYPE_TEXT", targetId: "a1", value: "cats", key: "ENTER" });
  await backend.execute(v, { op: "PRESS_KEY", key: "ESCAPE" });
  expect(calls).toEqual([
    { gate: "com.example", a: { kind: "type", text: "cats" }, element: { label: "Search", role: "EditText", nth: 1 } },
    { gate: "com.example", a: { kind: "key", key: "enter" }, element: undefined },
    { gate: "com.example", a: { kind: "key", key: "back" }, element: undefined },
  ]);
  expect(backend.hotkeys).toBe(false);
});
