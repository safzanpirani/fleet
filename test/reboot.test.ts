import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rebootHosts } from "../src/core.ts";
import type { FleetConfig } from "../src/config.ts";

import * as ssh from "../src/ssh.ts";
let transport: ReturnType<typeof spyOn>;
beforeEach(() => { transport = spyOn(ssh, "exec").mockResolvedValue({ host: "target", ok: true, code: 0, stdout: "", stderr: "" }); });
afterEach(() => transport.mockRestore());

const cfg: FleetConfig = { hosts: { target: { name: "target", ssh: "fixture-target", os: "linux" } } };
function simulation(sequence: boolean[], code = 0) {
  let clock = 0, probes = 0, sends = 0;
  return {
    deps: {
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
      probe: async () => { const value = sequence[Math.min(probes, sequence.length - 1)]!; probes++; return value; },
      exec: async () => { sends++; return { host: "target", ok: code === 0, code, stdout: "", stderr: code ? "fixture trigger failure" : "" }; },
    },
    counts: () => ({ probes, sends }),
  };
}

test("reboot wait ignores an initially healthy old boot", async () => {
  const sim = simulation([true, true, false, true]);
  const [r] = await rebootHosts(cfg, "target", { wait: true, timeoutMs: 100, intervalMs: 10, deps: sim.deps });
  expect(sim.counts()).toEqual({ sends: 1, probes: 4 });
  expect(r!.result.ok).toBe(true);
  expect(r!.lifecycle).toMatchObject({ phase: "ready", wentDown: true, ready: true });
});

test("reboot wait distinguishes never-down and never-returned deadlines", async () => {
  for (const [sequence, phase] of [[[true], "waiting-down"], [[false], "waiting-up"]] as const) {
    const sim = simulation([...sequence]);
    const [r] = await rebootHosts(cfg, "target", { wait: true, timeoutMs: 30, intervalMs: 10, deps: sim.deps });
    expect(r!.result.ok).toBe(false);
    expect(r!.result.code).toBe(124);
    expect(r!.result.stderr).toContain("target");
    expect(r!.result.stderr).toContain(phase);
    expect(r!.lifecycle!.phase).toBe(phase);
  }
});

test("lost reboot acknowledgement is observed without replay", async () => {
  for (const code of [255, 124, 1]) {
    const sim = simulation([false, true], code);
    const [r] = await rebootHosts(cfg, "target", { wait: true, timeoutMs: 30, intervalMs: 10, deps: sim.deps });
    expect(sim.counts()).toEqual({ sends: 1, probes: code === 1 ? 0 : 2 });
    expect(r!.result.ok).toBe(code !== 1);
    if (code !== 1) expect(r!.triggered!.code).toBe(code);
  }
});
