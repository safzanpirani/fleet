import { expect, test } from "bun:test";
import { decideFocus, focusElements, FOCUS_MIN_ROWS } from "../src/focus.ts";
import { cuOpen } from "../src/core.ts";
import type { CuElement, CuSnapshot } from "../src/core.ts";
import type { FleetConfig } from "../src/config.ts";

const el = (i: number, label: string): CuElement => ({ index: i, role: "ListItem", label, actions: ["invoke"] });
const key = { apiKey: "k", model: "m", endpoint: "https://example.invalid", timeoutMs: 1000 };

test("a row is hidden only when Jev answered and is confident it is unneeded", () => {
  expect(decideFocus(4, { r0: { noul: 0.01 }, r1: { noul: 0.9 }, r2: {}, r3: { noul: Number.NaN } }, 0.15))
    .toEqual([false, true, true, true]);
});

test("focus fails open without a key, below the row floor, or when the judge errors", async () => {
  const many = Array.from({ length: FOCUS_MIN_ROWS + 5 }, (_v, i) => el(i, `item ${i}`));
  expect((await focusElements(many, "t", "w", { key: null })).elements).toHaveLength(many.length);
  expect((await focusElements(many.slice(0, 3), "t", "w", { key })).hidden).toHaveLength(0);
  const broken = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
  const r = await focusElements(many, "t", "w", { key, fetch: broken });
  expect(r.elements).toHaveLength(many.length);
  expect(r.note).toContain("focus skipped");
});

test("focus keeps the rows Jev needs and names what it hid", async () => {
  const many = Array.from({ length: FOCUS_MIN_ROWS + 5 }, (_v, i) => el(i, i === 7 ? "Fonts" : `item ${i}`));
  const judge = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const answers = Object.fromEntries(Object.entries(body.questions).map(([k, q]: [string, any]) =>
      [k, { noul: q.instructions.row.includes("Fonts") ? 0.95 : 0.02 }]));
    return new Response(JSON.stringify({ answers }));
  }) as unknown as typeof fetch;
  const r = await focusElements(many, "open Fonts", "Explorer", { key, fetch: judge });
  expect(r.elements.map((e) => e.label)).toEqual(["Fonts"]);
  expect(r.note).toContain(`hid ${many.length - 1} controls`);
});

test("open sends a URL to the default browser, or as an argument to a named app, and names the new window", async () => {
  const cfg: FleetConfig = { hosts: { box: { name: "box", ssh: "box", os: "windows" } } };
  const calls: string[] = [];
  const win = (id: number, pid: number, title: string) => ({ window_id: id, pid, title, x: 0, y: 0, width: 800,
    height: 600, on_screen: true, minimized: false, z_index: 1 });
  let snaps = 0;
  const snapshot = async () => ({ apps: [], maxImageDimension: 0, result: {} as any,
    windows: snaps++ === 0 ? [win(1, 10, "old")] : [win(1, 10, "old"), win(2, 20, "C:\\Windows - File Explorer")] } as CuSnapshot);
  const run = async (_c: FleetConfig, _s: string, args: string[]) => {
    calls.push(args[1]!);
    return { host: "box", result: { host: "box", ok: true, code: 0, stdout: '{"pid":20}', stderr: "" } };
  };
  const r = await cuOpen(cfg, "box", "explorer", "C:\\Windows", {}, { run, snapshot, sleep: async () => {} });
  expect(JSON.parse(calls[0]!)).toEqual({ name: "explorer", additional_arguments: ["C:\\Windows"] });
  expect(r.targetName).toBe("C:\\Windows - File Explorer");
  snaps = 0;
  await cuOpen(cfg, "box", undefined, "https://example.com", {}, { run, snapshot, sleep: async () => {} });
  expect(JSON.parse(calls[1]!)).toEqual({ urls: ["https://example.com"] });
  await expect(cuOpen(cfg, "box", undefined, undefined, {}, { run, snapshot })).rejects.toThrow("open needs");
});
