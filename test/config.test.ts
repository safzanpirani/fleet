import { test, expect, describe } from "bun:test";
import { resolveHosts, validateConfig } from "../src/config.ts";
import type { FleetConfig, Host } from "../src/config.ts";

const host = (name: string, os: Host["os"], gpu = false): Host =>
  ({ name, ssh: name, os, ...(gpu ? { gpu: true } : {}) });

const cfg: FleetConfig = {
  hosts: {
    vps: host("vps", "linux"),
    oracle: host("oracle", "linux"),
    maints: host("maints", "windows", true),
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
    expect(names("@windows").sort()).toEqual(["main", "maints"]);
    expect(names("@mac")).toEqual(["mac"]);
  });

  test("@gpu filters by the gpu flag", () =>
    expect(names("@gpu").sort()).toEqual(["gpubox", "maints"]));

  test("custom group expands", () => expect(names("@cloud")).toEqual(["vps", "oracle"]));

  test("unknown group throws", () =>
    expect(() => resolveHosts(cfg, "@whatever")).toThrow(/unknown group @whatever/));

  test("comma-mix dedupes and preserves first-seen order", () =>
    // oracle, then @cloud adds vps (oracle dup), then @gpu adds maints+gpubox
    // in host-declaration order — maints is declared before gpubox.
    expect(names("oracle,@cloud,vps,@gpu")).toEqual(["oracle", "vps", "maints", "gpubox"]));

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

  test("a JSON Schema comment passes", () => {
    const cfg = base();
    cfg.$comment = "copy this example before use";
    expect(() => validateConfig(cfg, "t")).not.toThrow();
  });

  test("empty hosts fails", () =>
    expect(() => validateConfig({ hosts: {} } as FleetConfig, "t")).toThrow(/hosts/));

  test("bad os fails with the offending host named", () => {
    const cfg = base();
    (cfg.hosts.vps as any).os = "plan9";
    expect(() => validateConfig(cfg, "t")).toThrow(/hosts\.vps.*plan9/);
  });

  test("ssh aliases cannot be parsed as local ssh options", () => {
    const bad = { hosts: { unsafe: { name: "unsafe", ssh: "-oProxyCommand=touch /tmp/x", os: "linux" } } } as FleetConfig;
    expect(() => validateConfig(bad, "test.json")).toThrow(/hosts\.unsafe\.ssh must not begin/);
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

  test("cdp accepts absolute HTTP endpoints and rejects other values", () => {
    const ok = base();
    ok.hosts.vps!.cdp = "http://100.91.226.87:9223";
    expect(() => validateConfig(ok, "t")).not.toThrow();

    const bad = base();
    bad.hosts.vps!.cdp = "localhost:9223";
    expect(() => validateConfig(bad, "t")).toThrow(/hosts\.vps\.cdp.*http/);
  });

  test("dashboard and health require absolute HTTP endpoints", () => {
    const badDashboard = base();
    badDashboard.dashboard = "dashboard.local";
    expect(() => validateConfig(badDashboard, "t")).toThrow(/dashboard must be an absolute http/);

    const badHealth = base();
    badHealth.hosts.vps!.health = "file:///tmp/alive";
    expect(() => validateConfig(badHealth, "t")).toThrow(/hosts\.vps\.health must be an absolute http/);
  });

  test("service types must match the host OS", () => {
    const windowsSystemd = base();
    windowsSystemd.hosts.win = {
      ...host("win", "windows"),
      services: { bad: { type: "systemd", name: "bad" } },
    };
    expect(() => validateConfig(windowsSystemd, "t")).toThrow(/systemd requires a linux host/);

    const linuxWinService = base();
    linuxWinService.hosts.vps!.services = { bad: { type: "winservice", name: "bad" } };
    expect(() => validateConfig(linuxWinService, "t")).toThrow(/winservice requires a windows host/);
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

  test("unknown top-level, host, and nested fields fail instead of becoming no-ops", () => {
    expect(() => validateConfig({ ...base(), typo: true } as any, "t")).toThrow(/unknown field.*typo/);
    const badHost = base();
    (badHost.hosts.vps as any).loadout = true;
    expect(() => validateConfig(badHost, "t")).toThrow(/hosts\.vps.*loadout/);
    const badService = base();
    badService.hosts.vps!.services = { web: { type: "systemd", name: "web", typo: 1 } as any };
    expect(() => validateConfig(badService, "t")).toThrow(/services\.web.*typo/);
  });

  test("tools registry: root is required, fields are typed, typos are loud", () => {
    const ok = base();
    ok.tools = { tg: { root: "~/Development/tg", hosts: "oracle", exclude: ["fixtures"] } };
    expect(() => validateConfig(ok, "t")).not.toThrow();

    const noRoot = base();
    noRoot.tools = { tg: { hosts: "oracle" } as any };
    expect(() => validateConfig(noRoot, "t")).toThrow(/tools\.tg.*root/);

    const typo = base();
    typo.tools = { tg: { root: "~/x", host: "oracle" } as any };
    expect(() => validateConfig(typo, "t")).toThrow(/tools\.tg.*'host'/);

    const badExclude = base();
    badExclude.tools = { tg: { root: "~/x", exclude: "fixtures" } as any };
    expect(() => validateConfig(badExclude, "t")).toThrow(/tools\.tg\.exclude must be an array/);
  });

  test("null optional containers fail with their exact path", () => {
    const bad = base();
    bad.groups = null as any;
    expect(() => validateConfig(bad, "t")).toThrow(/groups must be an object/);
  });

  test("deploy service must exist on that host", () => {
    const bad = {
      hosts: { app: { name: "app", ssh: "app", os: "linux", services: {}, deploy: { service: "typo" } } },
    } as FleetConfig;
    expect(() => validateConfig(bad, "test.json")).toThrow(/deploy\.service: unknown service 'typo'/);
  });
});
