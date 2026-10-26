import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { FleetConfig, Host } from "../src/config.ts";
import { deliverImage, preferredImageExt, routeSelector, runExec } from "../src/core.ts";
import { spawnJob } from "../src/jobs.ts";
import { execTimeoutMs, probeTimeout } from "../src/settings.ts";
import { probeDetail, type ExecResult } from "../src/ssh.ts";

const host = (name: string, extra: Partial<Host> = {}): Host => ({ name, ssh: `${name}.invalid`, os: "linux", ...extra });

describe("knob precedence", () => {
  const cfg: FleetConfig = { hosts: {}, defaults: { execTimeoutS: 30, probeTimeoutMs: 3000 } };
  const tuned = host("tuned", { settings: { execTimeoutS: 5, probeTimeoutMs: 1200 } });
  const plain = host("plain");

  test("exec deadline: env beats the host, the host beats defaults, defaults beat the built-in", () => {
    expect(execTimeoutMs(tuned, { FLEET_EXEC_TIMEOUT: "2" }, cfg)).toBe(2000);
    expect(execTimeoutMs(tuned, {}, cfg)).toBe(5000);
    expect(execTimeoutMs(plain, {}, cfg)).toBe(30_000);
    expect(execTimeoutMs(plain, {}, { hosts: {} })).toBe(0);
    // An explicit 0 on the host lifts a fleet-wide deadline.
    expect(execTimeoutMs(host("open", { settings: { execTimeoutS: 0 } }), {}, cfg)).toBe(0);
  });

  test("probe cap: env beats the host, the host beats defaults, defaults beat the built-in", () => {
    expect(probeTimeout(tuned, { FLEET_PROBE_TIMEOUT_MS: "700" }, cfg)).toEqual({ ms: 700, pinned: true });
    expect(probeTimeout(tuned, {}, cfg)).toEqual({ ms: 1200, pinned: true });
    expect(probeTimeout(plain, {}, cfg)).toEqual({ ms: 3000, pinned: true });
    expect(probeTimeout(plain, {}, { hosts: {} })).toEqual({ ms: 4000, pinned: false });
  });

  test("a host with probeTimeoutMs gets no proxy bonus", async () => {
    // A reachable proxy and an ssh that never answers: the probe ends at the cap.
    const proxy = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const bin = mkdtempSync(join(tmpdir(), "fleet-probe-"));
    writeFileSync(join(bin, "ssh"), "#!/bin/sh\nexec sleep 10\n");
    chmodSync(join(bin, "ssh"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
    try {
      const proxied = host("proxied", { proxy: `socks5://127.0.0.1:${proxy.port}`, settings: { probeTimeoutMs: 300 } });
      const started = Date.now();
      const result = await probeDetail(proxied);
      const elapsed = Date.now() - started;
      expect(result).toMatchObject({ up: false, down: "host" });
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(1500);   // 300 ms, not 300 + 2000
    } finally {
      process.env.PATH = path;
      proxy.stop(true);
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe("parallel.exec", () => {
  const hosts = { a: host("a"), b: host("b"), c: host("c") };
  const counting = () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const exec = async (h: Host): Promise<ExecResult> => {
      active++; peak = Math.max(peak, active); order.push(`start ${h.name}`);
      // Yield once: a pool that started another host before this one ends shows it now.
      await Promise.resolve();
      active--; order.push(`end ${h.name}`);
      return { host: h.name, ok: true, code: 0, stdout: "", stderr: "" };
    };
    return { exec, peak: () => peak, order };
  };

  test("parallel.exec=1 runs a three-host fan-out one host at a time, in order", async () => {
    const run = counting();
    const results = await runExec({ hosts, defaults: { parallel: { exec: 1 } } }, "all", "true", {}, { exec: run.exec });
    expect(results.map((r) => r.host)).toEqual(["a", "b", "c"]);
    expect(run.peak()).toBe(1);
    expect(run.order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  test("without parallel.exec every host runs at once", async () => {
    const run = counting();
    await runExec({ hosts }, "all", "true", {}, { exec: run.exec });
    expect(run.peak()).toBe(3);
  });

  test("spawn honours parallel.exec too", async () => {
    let active = 0;
    let peak = 0;
    const exec = async (h: Host, script: string): Promise<ExecResult> => {
      active++; peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      const id = /job-\d+/.exec(script)?.[0];
      return { host: h.name, ok: true, code: 0, stdout: `OK ${id} 42\n`, stderr: "" };
    };
    let n = 0;
    const results = await spawnJob({ hosts, defaults: { parallel: { exec: 2 } } }, "all", "sleep 1", {},
      { exec, newId: () => `job-${++n}` });
    expect(results).toHaveLength(3);
    expect(peak).toBe(2);
  });
});

describe("capture settings", () => {
  test("shot.format png picks a png file and skips the webp transcode", async () => {
    const pngHost = host("pngbox", { os: "windows", settings: { shot: { format: "png" } } });
    const cfg: FleetConfig = { hosts: { pngbox: pngHost }, defaults: { shot: { format: "webp" } } };
    expect(await preferredImageExt(pngHost, cfg)).toBe("png");
    expect(await preferredImageExt(host("other"), cfg)).toBe("webp");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const root = await mkdtemp(join(tmpdir(), "fleet-format-"));
    try {
      const out = join(root, `shot.${await preferredImageExt(pngHost, cfg)}`);
      const result = await deliverImage(pngHost, "C:\\Temp\\capture.png", out, {
        pull: async (_host, _remote, path) => { await writeFile(path, png); return { host: "pngbox", ok: true, code: 0, stdout: "", stderr: "" }; },
      });
      expect(result).toMatchObject({ result: { ok: true }, path: out });
      expect(await readFile(out)).toEqual(png);   // the pulled bytes, untouched by cwebp
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("defaults.routeGraceMs", () => {
  test("a stalled preferred transport hands over after the configured grace", async () => {
    const cfg: FleetConfig = {
      hosts: { lan: host("lan"), ts: host("ts") },
      routes: { box: { prefer: ["lan", "ts"] } },
      defaults: { routeGraceMs: 20 },
    };
    const probe = (h: Host) => h.name === "lan" ? new Promise<boolean>(() => {}) : Promise.resolve(true);
    const started = Date.now();
    expect(await routeSelector(cfg, "box", { probe })).toBe("ts");
    expect(Date.now() - started).toBeLessThan(1000);   // the built-in grace is 1500 ms
  });
});

describe("fleet config", () => {
  test("<host> --json emits one JSON value naming each knob's source", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-config-"));
    const config = join(root, "fleet.config.json");
    writeFileSync(config, JSON.stringify({
      hosts: {
        box: { ssh: "box.invalid", os: "linux", disable: ["webcam"], settings: { probeTimeoutMs: 900, shot: { format: "png" } } },
        other: { ssh: "other.invalid", os: "linux" },
      },
      disable: ["power"],
      defaults: { doneGraceMs: 800, parallel: { exec: 4 } },
    }));
    try {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "config", "box", "--json"], {
        env: { ...process.env, FLEET_CONFIG: config, FLEET_EXEC_TIMEOUT: "9", FLEET_PROBE_TIMEOUT_MS: "" },
        stdout: "pipe", stderr: "pipe", stdin: "ignore",
      });
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).toBe(0);
      const view = JSON.parse(stdout);
      expect(view.hosts.map((h: { host: string }) => h.host)).toEqual(["box"]);
      const setting = (key: string) => view.hosts[0].settings.find((s: { key: string }) => s.key === key);
      expect(setting("execTimeoutS")).toEqual({ key: "execTimeoutS", value: 9, source: "env", env: "FLEET_EXEC_TIMEOUT" });
      expect(setting("probeTimeoutMs")).toEqual({ key: "probeTimeoutMs", value: 900, source: "host" });
      expect(setting("doneGraceMs")).toEqual({ key: "doneGraceMs", value: 800, source: "defaults" });
      expect(setting("sshPersist")).toMatchObject({ value: "60s", source: "built-in" });
      expect(setting("shot.format")).toEqual({ key: "shot.format", value: "png", source: "host" });
      expect(view.global).toContainEqual({ key: "parallel.exec", value: 4, source: "defaults" });
      expect(view.hosts[0].refused).toEqual([{ feature: "webcam", source: "host" }, { feature: "power", source: "top-level" }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
