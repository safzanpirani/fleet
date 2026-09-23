import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LS_KNOWN_DOWN_CAP_MS, lsHosts } from "../src/core.ts";
import type { FleetConfig, Host } from "../src/config.ts";

const host = (name: string, extra: Partial<Host> = {}): Host => ({ name, ssh: name, os: "linux", ...extra });

test("ls shortens the probe only for hosts that were down last time, and checks health alongside ssh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-ls-"));
  const statePath = join(dir, "ls-state.json");
  const cfg: FleetConfig = { hosts: { live: host("live"), dead: host("dead", { health: "http://dead.invalid/h" }) } };
  const caps: Record<string, number | undefined> = {};
  const order: string[] = [];
  const probe = async (h: Host, cap?: number) => {
    caps[h.name] = cap;
    order.push(`ssh:${h.name}`);
    return { up: h.name === "live", down: h.name === "live" ? undefined : "host" as const };
  };
  const http = async () => { order.push("http:dead"); return true; };
  try {
    const first = await lsHosts(cfg, undefined, { statePath, probe: probe as any, http });
    expect(caps).toEqual({ live: undefined, dead: undefined });
    expect(order.indexOf("http:dead")).toBeLessThan(order.indexOf("ssh:dead"));
    expect(first.find((r) => r.name === "dead")?.httpUp).toBe(true);
    await lsHosts(cfg, undefined, { statePath, probe: probe as any, http });
    expect(caps).toEqual({ live: undefined, dead: LS_KNOWN_DOWN_CAP_MS });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
