import { test, expect, describe } from "bun:test";
import { resolveHosts, validateConfig } from "../src/config.ts";
import type { FleetConfig, Host } from "../src/config.ts";

const host = (name: string, os: Host["os"], gpu = false): Host =>
  ({ name, ssh: name, os, ...(gpu ? { gpu: true } : {}) });

const cfg: FleetConfig = {
  hosts: {
    vps: host("vps", "linux"),
    oracle: host("oracle", "linux"),
    "win-box": host("win-box", "windows", true),
    "win-lan": host("win-lan", "windows"),
    mac: host("mac", "mac"),
    gpubox: host("gpubox", "linux", true),
  },
  groups: {
    cloud: ["vps", "oracle"],
    broken: ["vps", "ghost"],   // references a host that doesn't exist
  },
};
const names = (sel: string) => resolveHosts(cfg, sel).map((h) => h.name);

describe("resolveHosts", () => {
  test("single host", () => expect(names("vps")).toEqual(["vps"]));

  test("unknown host throws with the list", () =>
    expect(() => resolveHosts(cfg, "nope")).toThrow(/unknown host: nope/));

  test("dt: selector synthesizes an ephemeral daytona host", () => {
    const hs = resolveHosts(cfg, "dt:spore-run42");
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ name: "dt:spore-run42", ssh: "spore-run42", os: "linux", transport: "daytona" });
  });

  test("dt: with an empty token throws", () =>
    expect(() => resolveHosts(cfg, "dt:")).toThrow(/dt: selector needs/));

  test("dt: mixes with config hosts in one selector", () =>
    expect(names("vps,dt:abc")).toEqual(["vps", "dt:abc"]));

  test("all / * expand to every host", () => {
    expect(names("all").sort()).toEqual(Object.keys(cfg.hosts).sort());
    expect(names("*").sort()).toEqual(Object.keys(cfg.hosts).sort());
  });

  test("@linux / @windows / @mac filter by os", () => {
    expect(names("@linux").sort()).toEqual(["gpubox", "oracle", "vps"]);
    expect(names("@windows").sort()).toEqual(["win-box", "win-lan"]);
    expect(names("@mac")).toEqual(["mac"]);
  });

  test("@gpu filters by the gpu flag", () =>
    expect(names("@gpu").sort()).toEqual(["gpubox", "win-box"]));

  test("custom group expands", () => expect(names("@cloud")).toEqual(["vps", "oracle"]));

  test("unknown group throws", () =>
    expect(() => resolveHosts(cfg, "@whatever")).toThrow(/unknown group @whatever/));

  test("comma-mix dedupes and preserves first-seen order", () =>
    // oracle, then @cloud adds vps (oracle dup), then @gpu adds win-box+gpubox
    // in host-declaration order — win-box is declared before gpubox.
    expect(names("oracle,@cloud,vps,@gpu")).toEqual(["oracle", "vps", "win-box", "gpubox"]));

  test("whitespace around comma tokens is tolerated", () =>
    expect(names(" vps , oracle ")).toEqual(["vps", "oracle"]));

  test("empty selector throws", () => expect(() => resolveHosts(cfg, "")).toThrow(/no hosts matched/));

  test("a group referencing a missing host throws (a typo must not shrink a fan-out)", () =>
    expect(() => names("@broken")).toThrow(/group @broken references unknown host 'ghost'/));
});

describe("validateConfig", () => {
  const base = (): FleetConfig => ({ hosts: { vps: host("vps", "linux") } });

  test("a minimal valid config passes", () =>
    expect(() => validateConfig(base(), "t")).not.toThrow());

  test("empty hosts fails", () =>
    expect(() => validateConfig({ hosts: {} } as FleetConfig, "t")).toThrow(/hosts/));

  test("bad os fails with the offending host named", () => {
    const cfg = base();
    (cfg.hosts.vps as any).os = "plan9";
    expect(() => validateConfig(cfg, "t")).toThrow(/hosts\.vps.*plan9/);
  });

  test("invalid configured Windows shell fails at load", () => {
    const cfg = base();
    cfg.hosts.win = { ...host("win", "windows"), winShell: "cmd" as any };
    expect(() => validateConfig(cfg, "t")).toThrow(/hosts\.win.*winShell.*cmd/);
  });

  test("bad service type fails", () => {
    const cfg = base();
    cfg.hosts.vps!.services = { web: { type: "initd" as any, name: "web" } };
    expect(() => validateConfig(cfg, "t")).toThrow(/services\.web/);
  });

  test("group with unknown member fails at load", () => {
    const cfg = base();
    cfg.groups = { g: ["vps", "ghost"] };
    expect(() => validateConfig(cfg, "t")).toThrow(/groups\.g.*ghost/);
  });

  test("machine boot referencing unknown host fails at load", () => {
    const cfg = base();
    cfg.machines = { box: { boots: { linux: { host: "nope" } } } };
    expect(() => validateConfig(cfg, "t")).toThrow(/machines\.box.*nope/);
  });

  test("route referencing an unknown transport fails at load", () => {
    const cfg = base();
    cfg.routes = { remote: { prefer: ["vps", "ghost"] } };
    expect(() => validateConfig(cfg, "t")).toThrow(/routes\.remote.*ghost/);
  });

  test("route name cannot be shadowed by a concrete host", () => {
    const cfg = base();
    cfg.routes = { vps: { prefer: ["vps"] } };
    expect(() => validateConfig(cfg, "t")).toThrow(/routes\.vps.*conflicts.*host/);
  });

  test("route name cannot shadow a dual-boot machine", () => {
    const cfg = base();
    cfg.machines = { box: { boots: { linux: { host: "vps" } } } };
    cfg.routes = { box: { prefer: ["vps"] } };
    expect(() => validateConfig(cfg, "t")).toThrow(/routes\.box.*conflicts.*machine/);
  });

  test("route transports must target the same OS", () => {
    const cfg = base();
    cfg.hosts.win = host("win", "windows");
    cfg.routes = { mixed: { prefer: ["vps", "win"] } };
    expect(() => validateConfig(cfg, "t")).toThrow(/routes\.mixed.*same OS/);
  });

  test("switch target without a matching boot fails", () => {
    const cfg = base();
    cfg.machines = { box: { boots: { linux: { host: "vps" } }, switch: { windows: "reboot" } } };
    expect(() => validateConfig(cfg, "t")).toThrow(/switch\.windows/);
  });

  test("recipe that isn't a string array fails", () => {
    const cfg = base();
    cfg.recipes = { r: [{ bad: true }] as any };
    expect(() => validateConfig(cfg, "t")).toThrow(/recipes\.r/);
  });
});
