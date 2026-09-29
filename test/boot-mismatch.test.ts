import { expect, test } from "bun:test";
import { bootMismatchNote } from "../src/core.ts";

const cfg = {
  hosts: {
    "duo-win": { ssh: "duo-win", os: "windows" }, "duo-lin": { ssh: "duo-lin", os: "linux" }, "solo": { ssh: "solo", os: "linux" },
  },
  machines: { duo: { boots: { windows: { host: "duo-win" }, linux: { host: "duo-lin" } } } },
} as any;
const fail = (host: string, stderr: string, over: object = {}) => ({ host, ok: false, code: 255, stderr, ...over });
const live = (os: string | null) => async (_c: any, machine: string) => ({ machine, live: os, liveHost: null, transport: null, boots: [] }) as any;

test("an unreachable boot names the OS the machine is running and how to switch", async () => {
  const note = await bootMismatchNote(cfg, fail("duo-win", "ssh: Could not resolve hostname duo-win.local"), { state: live("linux") });
  expect(note).toBe("duo is booted into linux, and duo-win is its windows boot; switch with: fleet switch duo --to windows (status: fleet boot duo)");
});

test("a machine that answers on no boot is reported as off or rebooting", async () => {
  const note = await bootMismatchNote(cfg, fail("duo-lin", "ssh: connect to host x port 22: Operation timed out"), { state: live(null) });
  expect(note).toContain("duo answers on none of its boots (windows, linux)");
});

test("no note when the wanted boot is live, the host is not part of a machine, or the failure is something else", async () => {
  const state = live("windows");
  expect(await bootMismatchNote(cfg, fail("duo-win", "ssh: connection timed out"), { state })).toBeUndefined();
  expect(await bootMismatchNote(cfg, fail("solo", "ssh: Could not resolve hostname solo"), { state: live("linux") })).toBeUndefined();
  expect(await bootMismatchNote(cfg, fail("duo-win", "Permission denied (publickey)"), { state: live("linux") })).toBeUndefined();
  expect(await bootMismatchNote(cfg, fail("duo-win", "ssh: Could not resolve hostname x", { code: 1 }), { state: live("linux") })).toBeUndefined();
  expect(await bootMismatchNote(cfg, fail("duo-win", "timed out", { ok: true }), { state: live("linux") })).toBeUndefined();
});

test("a probe failure never hides the original error", async () => {
  const state = async () => { throw new Error("probe broke"); };
  expect(await bootMismatchNote(cfg, fail("duo-win", "ssh: Could not resolve hostname x"), { state: state as any })).toBeUndefined();
});
