import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertFeature, featureRefusal, HOST_FEATURES, loadConfig, loadPolicy, parsePolicy, policyPath, policyProtection,
  resolveHosts, setActiveConfig, setActivePolicy, validateConfig,
} from "../src/config.ts";
import type { FleetConfig, FleetPolicy, Host } from "../src/config.ts";
import { configView, lsHosts } from "../src/core.ts";

const host = (name: string, extra: Partial<Host> = {}): Host => ({ name, ssh: `${name}.invalid`, os: "linux", ...extra });
const policy = (body: Partial<FleetPolicy>): FleetPolicy => ({ path: "/test/policy.json", disable: [], hosts: {}, ...body });

afterEach(() => { setActivePolicy(null); setActiveConfig(null); });

function withConfig<T>(config: unknown, policyText: string | undefined, fn: (paths: { config: string; policy: string }) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "fleet-policy-"));
  const paths = { config: join(root, "fleet.config.json"), policy: join(root, "policy.json") };
  writeFileSync(paths.config, JSON.stringify(config));
  if (policyText !== undefined) writeFileSync(paths.policy, policyText);
  const prev = process.env.FLEET_CONFIG;
  process.env.FLEET_CONFIG = paths.config;
  return fn(paths).finally(() => {
    if (prev === undefined) delete process.env.FLEET_CONFIG; else process.env.FLEET_CONFIG = prev;
    rmSync(root, { recursive: true, force: true });
  });
}

describe("policy file", () => {
  test("the path is fixed per platform", () => {
    expect(policyPath("darwin")).toBe("/etc/fleet/policy.json");
    expect(policyPath("linux")).toBe("/etc/fleet/policy.json");
    expect(policyPath("win32")).toBe("C:\\ProgramData\\fleet\\policy.json");
  });

  test("a policy deny beats the host's enable and names the policy as the source", () => {
    const cfg: FleetConfig = { hosts: { a: host("a", { enable: ["exec"] }), b: host("b") }, disable: ["exec"] };
    const p = policy({ hosts: { a: { disable: ["exec"] } } });
    expect(featureRefusal(cfg.hosts.a!, "exec", cfg, p)).toBe("policy");
    expect(featureRefusal(cfg.hosts.a!, "exec", cfg, null)).toBeNull();
    expect(() => assertFeature(resolveHosts(cfg, "a,b"), "exec", cfg, p)).toThrow(
      "exec is disabled on a by the fleet policy file /test/policy.json, which fleet.config.json cannot override; "
      + "on b by the fleet config");
    // A global deny reaches every host, enable or not.
    expect(featureRefusal(cfg.hosts.a!, "files", cfg, policy({ disable: ["files"] }))).toBe("policy");
  });

  test("unknown keys and features are errors; unknown host names are allowed", () => {
    expect(() => parsePolicy(JSON.stringify({ disable: ["exec"], allow: [] }), "p")).toThrow("unknown key 'allow'");
    expect(() => parsePolicy(JSON.stringify({ disable: ["telepathy"] }), "p")).toThrow("disable: unknown feature 'telepathy'");
    expect(() => parsePolicy(JSON.stringify({ hosts: { a: { enable: ["exec"] } } }), "p")).toThrow("hosts.a: unknown key 'enable'");
    expect(parsePolicy(JSON.stringify({ hosts: { gone: { disable: ["cu"] } } }), "p").hosts.gone!.disable).toEqual(["cu"]);
  });

  test("a missing policy changes nothing", async () => {
    const config = { hosts: { box: { ssh: "box.invalid", os: "linux", disable: ["webcam"] } } };
    await withConfig(config, undefined, async (paths) => {
      expect(await loadPolicy(paths.policy)).toBeNull();
      const cfg = await loadConfig(paths.policy);
      const view = configView(cfg);
      expect(view.policy).toMatchObject({ present: false });
      expect(view.hosts[0]!.refused).toEqual([{ feature: "webcam", source: "host" }]);
      expect(() => assertFeature([cfg.hosts.box!], "exec", cfg)).not.toThrow();
    });
  });

  test("an invalid policy refuses every gated feature, yet the config still loads and names the error", async () => {
    const config = { hosts: { box: { ssh: "box.invalid", os: "linux", enable: ["exec"] } } };
    await withConfig(config, "{ not json", async (paths) => {
      const cfg = await loadConfig(paths.policy);
      const view = configView(cfg);
      expect(view.policy.path).toBe(paths.policy);
      expect(view.policy.error).toBeString();
      expect(view.hosts[0]!.refused).toEqual(HOST_FEATURES.map((feature) => ({ feature, source: "policy" })));
      expect(() => assertFeature([cfg.hosts.box!], "exec", cfg)).toThrow(
        new RegExp(`exec is disabled on box by the fleet policy file ${paths.policy}, which is invalid \\(.+\\)`));
    });
    await withConfig(config, JSON.stringify({ disable: ["telepathy"] }), async (paths) => {
      const cfg = await loadConfig(paths.policy);
      expect(configView(cfg).policy.error).toContain("unknown feature 'telepathy'");
      expect(() => assertFeature([cfg.hosts.box!], "files", cfg)).toThrow("unknown feature 'telepathy'");
    });
  });

  test("fleet config warns about policy hosts the config does not define", async () => {
    const config = { hosts: { box: { ssh: "box.invalid", os: "linux" } } };
    await withConfig(config, JSON.stringify({ hosts: { box: { disable: ["kill"] }, retired: { disable: ["exec"] } } }), async (paths) => {
      const view = configView(await loadConfig(paths.policy));
      expect(view.policy.unknownHosts).toEqual(["retired"]);
      expect(view.hosts[0]!.refused).toEqual([{ feature: "kill", source: "policy" }]);
    });
  });

  test("fleet ls --json reports policy refusals with their source", async () => {
    const cfg: FleetConfig = { hosts: { box: host("box", { disable: ["webcam"] }) } };
    setActivePolicy(policy({ disable: ["power"] }));
    const root = mkdtempSync(join(tmpdir(), "fleet-policy-ls-"));
    try {
      const [r] = await lsHosts(cfg, undefined, { statePath: join(root, "state.json"), probe: async () => ({ up: true }) });
      expect(r!.disabled).toEqual(["webcam", "power"]);
      expect(r!.refused).toEqual([{ feature: "webcam", source: "host" }, { feature: "power", source: "policy" }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("protected only when the file and its directory are root-owned and not group/other-writable", () => {
    const stat = (owners: Record<string, { uid: number; mode: number; link?: boolean }>) => (p: string) => {
      const s = owners[p]!;
      return { uid: s.uid, mode: s.mode, isSymbolicLink: () => !!s.link };
    };
    const file = "/etc/fleet/policy.json";
    const dir = { uid: 0, mode: 0o40755 };
    expect(policyProtection(file, stat({ [file]: { uid: 0, mode: 0o100644 }, "/etc/fleet": dir }))).toEqual({ protected: true });
    expect(policyProtection(file, stat({ [file]: { uid: 501, mode: 0o100644 }, "/etc/fleet": dir })))
      .toEqual({ protected: false, reason: `${file} is owned by uid 501, not root` });
    expect(policyProtection(file, stat({ [file]: { uid: 0, mode: 0o100664 }, "/etc/fleet": dir })))
      .toEqual({ protected: false, reason: `${file} is group-writable` });
    expect(policyProtection(file, stat({ [file]: { uid: 0, mode: 0o100644 }, "/etc/fleet": { uid: 0, mode: 0o40757 } })))
      .toEqual({ protected: false, reason: "/etc/fleet is writable by everyone" });
    expect(policyProtection(file, stat({ [file]: { uid: 0, mode: 0o120777, link: true }, "/etc/fleet": dir })))
      .toEqual({ protected: false, reason: `${file} is a symlink` });
  });

  test("a user-owned policy is still honoured, but reported unprotected", async () => {
    await withConfig({ hosts: { box: { ssh: "box.invalid", os: "linux" } } }, JSON.stringify({ disable: ["exec"] }), async (paths) => {
      const cfg = await loadConfig(paths.policy);
      const view = configView(cfg);
      expect(view.policy.protected).toBe(false);
      expect(view.policy.reason).toContain("not root");
      expect(() => assertFeature([cfg.hosts.box!], "exec", cfg)).toThrow("by the fleet policy file");
      expect((await loadPolicy(paths.policy, { platform: "win32" }))!.protection).toBeUndefined();
    });
  });

  test("an entry keyed by ssh destination refuses a renamed host pointing at the same box", () => {
    const cfg: FleetConfig = {
      hosts: {
        office: host("office", { ssh: "admin@192.0.2.7" }),
        office2: host("office2", { ssh: "admin@192.0.2.7", enable: ["exec"] }),
        otheruser: host("otheruser", { ssh: "admin@192.0.2.7" }),
        elsewhere: host("elsewhere", { ssh: "admin@192.0.2.8" }),
      },
    };
    const byDest = policy({ hosts: { "admin@192.0.2.7": { disable: ["exec"] } } });
    expect(featureRefusal(cfg.hosts.office2!, "exec", cfg, byDest)).toBe("policy");
    expect(featureRefusal(cfg.hosts.elsewhere!, "exec", cfg, byDest)).toBeNull();
    expect(() => assertFeature([cfg.hosts.office2!], "exec", cfg, byDest)).toThrow("exec is disabled on office2 by the fleet policy file");
    // Keyed by the bare address, a changed login user does not escape either.
    const byAddr = policy({ hosts: { "192.0.2.7": { disable: ["exec"] } } });
    expect(featureRefusal(cfg.hosts.otheruser!, "exec", cfg, byAddr)).toBe("policy");
    expect(featureRefusal(cfg.hosts.elsewhere!, "exec", cfg, byAddr)).toBeNull();
  });

  test("an entry keyed by hostKeyAlias refuses a renamed host that pins the same key", () => {
    const cfg: FleetConfig = {
      hosts: {
        renamed: host("renamed", { ssh: "box.lan", hostKeyAlias: "box-win" }),
        linuxboot: host("linuxboot", { ssh: "box.lan", hostKeyAlias: "box-linux" }),
      },
    };
    const p = policy({ hosts: { "box-win": { disable: ["exec"] } } });
    expect(featureRefusal(cfg.hosts.renamed!, "exec", cfg, p)).toBe("policy");
    expect(featureRefusal(cfg.hosts.linuxboot!, "exec", cfg, p)).toBeNull();
    // Keys that match a destination or alias are not reported as unknown hosts.
    expect(configView(cfg, undefined, {}, policy({ hosts: { "box-win": { disable: ["exec"] }, "box.lan": { disable: ["kill"] }, gone: { disable: ["cu"] } } }))
      .policy.unknownHosts).toEqual(["gone"]);
  });
});

describe("ai follows shot", () => {
  test("a host that refuses shot refuses ai unless its enable lists ai; policy refusals still win", () => {
    const cfg: FleetConfig = {
      hosts: {
        noshot: host("noshot", { disable: ["shot"] }),
        allowed: host("allowed", { disable: ["shot"], enable: ["ai"] }),
        inherits: host("inherits"),
        reshot: host("reshot", { enable: ["shot"] }),
      },
      disable: ["shot"],
    };
    expect(featureRefusal(cfg.hosts.noshot!, "ai", cfg, null)).toBe("host disable shot");
    expect(featureRefusal(cfg.hosts.allowed!, "ai", cfg, null)).toBeNull();
    expect(featureRefusal(cfg.hosts.inherits!, "ai", cfg, null)).toBe("top-level disable shot");
    expect(featureRefusal(cfg.hosts.reshot!, "ai", cfg, null)).toBeNull();
    expect(featureRefusal(cfg.hosts.allowed!, "ai", cfg, policy({ disable: ["ai"] }))).toBe("policy");
    expect(featureRefusal(cfg.hosts.allowed!, "ai", cfg, policy({ hosts: { allowed: { disable: ["shot"] } } }))).toBe("policy disable shot");
    expect(() => assertFeature([cfg.hosts.noshot!], "ai", cfg, null))
      .toThrow("ai is disabled on noshot by the fleet config, which refuses shot there (ai follows shot unless hosts.<host>.enable lists ai)");
  });

  test("a route whose transports differ only in ai fails validation", () => {
    const cfg: FleetConfig = {
      hosts: { lan: host("lan", { disable: ["shot"], enable: ["ai"] }), ts: host("ts", { disable: ["shot"] }) },
      routes: { box: { prefer: ["lan", "ts"] } },
    };
    expect(() => validateConfig(cfg, "t")).toThrow(/routes\.box: every transport must allow the same features/);
    cfg.hosts.ts!.enable = ["ai"];
    expect(() => validateConfig(cfg, "t")).not.toThrow();
  });
});
