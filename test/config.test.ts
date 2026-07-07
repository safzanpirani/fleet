import { test, expect, describe } from "bun:test";
import { resolveHosts, validateConfig } from "../src/config.ts";
import type { FleetConfig, Host } from "../src/config.ts";

const host = (name: string, os: Host["os"], gpu = false): Host =>
  ({ name, ssh: name, os, ...(gpu ? { gpu: true } : {}) });

const cfg: FleetConfig = {
  hosts: {
    vps: host("vps", "linux"),
    oracle: host("oracle", "linux"),
    winbox: host("winbox", "windows", true),
    main: host("main", "windows"),
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

  test("all / * expand to every host", () => {
    expect(names("all").sort()).toEqual(Object.keys(cfg.hosts).sort());
    expect(names("*").sort()).toEqual(Object.keys(cfg.hosts).sort());
  });

  test("@linux / @windows / @mac filter by os", () => {
    expect(names("@linux").sort()).toEqual(["gpubox", "oracle", "vps"]);
    expect(names("@windows").sort()).toEqual(["main", "winbox"]);
    expect(names("@mac")).toEqual(["mac"]);
  });

  test("@gpu filters by the gpu flag", () =>
    expect(names("@gpu").sort()).toEqual(["gpubox", "winbox"]));

  test("custom group expands", () => expect(names("@cloud")).toEqual(["vps", "oracle"]));

  test("unknown group throws", () =>
    expect(() => resolveHosts(cfg, "@whatever")).toThrow(/unknown group @whatever/));

  test("comma-mix dedupes and preserves first-seen order", () =>
    // oracle, then @cloud adds vps (oracle dup), then @gpu adds winbox+gpubox
    // in host-declaration order — winbox is declared before gpubox.
    expect(names("oracle,@cloud,vps,@gpu")).toEqual(["oracle", "vps", "winbox", "gpubox"]));

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
