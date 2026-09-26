import { test, expect, describe } from "bun:test";
import { configNotFoundMessage, configSearchPaths, resolveHosts, staleBinaryHint, validateConfig } from "../src/config.ts";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetConfig, Host } from "../src/config.ts";

const host = (name: string, os: Host["os"], gpu = false): Host =>
  ({ name, ssh: name, os, ...(gpu ? { gpu: true } : {}) });

const cfg: FleetConfig = {
  hosts: {
    vps: host("vps", "linux"),
    web: host("web", "linux"),
    winbox: host("winbox", "windows", true),
    main: host("main", "windows"),
    mac: host("mac", "mac"),
    gpubox: host("gpubox", "linux", true),
  },
  groups: {
    cloud: ["vps", "web"],
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
    expect(names("@linux").sort()).toEqual(["gpubox", "vps", "web"]);
    expect(names("@windows").sort()).toEqual(["main", "winbox"]);
    expect(names("@mac")).toEqual(["mac"]);
  });

  test("@gpu filters by the gpu flag", () =>
    expect(names("@gpu").sort()).toEqual(["gpubox", "winbox"]));

  test("custom group expands", () => expect(names("@cloud")).toEqual(["vps", "web"]));

  test("unknown group throws", () =>
    expect(() => resolveHosts(cfg, "@whatever")).toThrow(/unknown group @whatever/));

  test("comma-mix dedupes and preserves first-seen order", () =>
    // web, then @cloud adds vps (web dup), then @gpu adds winbox+gpubox
    // in host-declaration order — winbox is declared before gpubox.
    expect(names("web,@cloud,vps,@gpu")).toEqual(["web", "vps", "winbox", "gpubox"]));

  test("whitespace around comma tokens is tolerated", () =>
    expect(names(" vps , web ")).toEqual(["vps", "web"]));

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
    ok.hosts.vps!.cdp = "http://192.0.2.10:9223";
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
    // Use an obviously fake field name so the fixture cannot imply a feature.
    (badHost.hosts.vps as any).notAHostField = true;
    expect(() => validateConfig(badHost, "t")).toThrow(/hosts\.vps.*notAHostField/);
    const badService = base();
    badService.hosts.vps!.services = { web: { type: "systemd", name: "web", typo: 1 } as any };
    expect(() => validateConfig(badService, "t")).toThrow(/services\.web.*typo/);
  });

  test("tools registry: root is required, fields are typed, typos are loud", () => {
    const ok = base();
    ok.tools = { tg: { root: "~/Development/tg", hosts: "web", exclude: ["fixtures"] } };
    expect(() => validateConfig(ok, "t")).not.toThrow();

    const noRoot = base();
    noRoot.tools = { tg: { hosts: "web" } as any };
    expect(() => validateConfig(noRoot, "t")).toThrow(/tools\.tg.*root/);

    const typo = base();
    typo.tools = { tg: { root: "~/x", host: "web" } as any };
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

describe("finding a config", () => {
  const withEnv = async <T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> => {
    const had = Object.hasOwn(process.env, "FLEET_CONFIG");
    const prev = process.env.FLEET_CONFIG;
    if (value === undefined) delete process.env.FLEET_CONFIG;
    else process.env.FLEET_CONFIG = value;
    try { return await fn(); }
    finally {
      if (had) process.env.FLEET_CONFIG = prev;
      else delete process.env.FLEET_CONFIG;
    }
  };

  test("FLEET_CONFIG is the only candidate when it is set", async () => {
    expect(await withEnv("/tmp/explicit.json", configSearchPaths)).toEqual(["/tmp/explicit.json"]);
  });

  test("without it, every fallback is searched in order", async () => {
    const paths = await withEnv(undefined, configSearchPaths);
    expect(paths.length).toBeGreaterThan(1);
    expect(paths.every((p) => /fleet\.config(?:\.example)?\.json$/.test(p))).toBe(true);
    expect(paths[1]).toBe(paths[0]!.replace("fleet.config.json", "fleet.config.example.json"));
  });

  test("an explicit FLEET_CONFIG that does not exist names itself", async () => {
    expect(await withEnv("/nope/missing.json", () => configNotFoundMessage()))
      .toBe("FLEET_CONFIG points at /nope/missing.json, which does not exist");
  });

  test("the not-found message lists real places and never a /$bunfs path", async () => {
    // A compiled binary resolves its own root inside Bun's embedded filesystem,
    // so the bare ENOENT this replaced told the reader to look at
    // `/$bunfs/fleet.config.json` — a path inside the executable that cannot be
    // inspected or created.
    const message = await withEnv(undefined, () => configNotFoundMessage([
      "/$bunfs/fleet.config.json",
      "/opt/fleet/fleet.config.json",
      "/home/u/.config/fleet/fleet.config.json",
    ]));
    expect(message).not.toContain("bunfs");
    expect(message).toContain("FLEET_CONFIG=");
    expect(message).toContain("/opt/fleet/fleet.config.json");
    expect(message).toContain("/home/u/.config/fleet/fleet.config.json");
  });

  test("a single usable location does not say \"any of\"", async () => {
    const message = await withEnv(undefined,
      () => configNotFoundMessage(["/$bunfs/fleet.config.json", "/opt/fleet/fleet.config.json"]));
    expect(message).not.toContain("any of");
    expect(message).toContain("/opt/fleet/fleet.config.json");
  });
});

describe("staleBinaryHint", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-stale-"));
    const checkout = join(root, "checkout");
    mkdirSync(join(checkout, "src"), { recursive: true });
    writeFileSync(join(checkout, "src", "config.ts"), `const keys = ["ssh", "os", "android"];`);
    writeFileSync(join(checkout, "fleet.config.json"), "{}");
    symlinkSync(join(checkout, "fleet.config.json"), join(root, "fleet.config.json"));
    return { root, checkout, installed: join(root, "fleet.config.json") };
  };
  const message = "invalid config x: hosts.phone: unknown field 'android'";

  test("names the checkout when its source accepts the field", async () => {
    const { root, checkout, installed } = setup();
    try {
      expect(await staleBinaryHint(message, installed, "/$bunfs")).toBe(
        `this fleet is older than the source at ${realpathSync(checkout)}, which accepts 'android'; rebuild it there with: bun run build:local`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("stays quiet when the checkout is the running source", async () => {
    const { root, checkout, installed } = setup();
    try { expect(await staleBinaryHint(message, installed, checkout)).toBeUndefined(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("stays quiet when the checkout does not know the field either", async () => {
    const { root, installed } = setup();
    try { expect(await staleBinaryHint("invalid config x: hosts.a: unknown field 'typo'", installed, "/$bunfs")).toBeUndefined(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("ignores errors that are not about unknown fields", async () => {
    const { root, installed } = setup();
    try { expect(await staleBinaryHint("invalid config x: hosts.a: missing/invalid `ssh`", installed, "/$bunfs")).toBeUndefined(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
});
