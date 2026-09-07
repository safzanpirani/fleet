import { test, expect, describe } from "bun:test";
import { parseRemoteSpec } from "../src/core.ts";
import type { FleetConfig, Host } from "../src/config.ts";

const host = (name: string, os: Host["os"]): Host => ({ name, ssh: name, os });
const cfg: FleetConfig = {
  hosts: { web: host("web", "linux"), winbox: host("winbox", "windows") },
  routes: { "web-auto": { prefer: ["web"] } },
  groups: { cloud: ["web"] },
  machines: { dualboot: { boots: { linux: { host: "web" } } } },
};

describe("parseRemoteSpec (cp direction detection)", () => {
  test("host:path splits at the first colon", () =>
    expect(parseRemoteSpec(cfg, "web:/tmp/x")).toEqual({ sel: "web", path: "/tmp/x" }));

  test("@group / all / comma-list prefixes are recognised", () => {
    expect(parseRemoteSpec(cfg, "@cloud:~/x")?.sel).toBe("@cloud");
    expect(parseRemoteSpec(cfg, "@linux:~/x")?.sel).toBe("@linux");
    expect(parseRemoteSpec(cfg, "all:/x")?.sel).toBe("all");
    expect(parseRemoteSpec(cfg, "web,winbox:/x")?.sel).toBe("web,winbox");
  });

  test("a dual-boot machine name is a valid prefix", () =>
    expect(parseRemoteSpec(cfg, "dualboot:/x")?.sel).toBe("dualboot"));

  test("a logical route name is a valid prefix", () =>
    expect(parseRemoteSpec(cfg, "web-auto:/x")?.sel).toBe("web-auto"));

  test("a plain local path (no colon) is not a remote spec", () =>
    expect(parseRemoteSpec(cfg, "./dir/file.txt")).toBeNull());

  test("a Windows drive path is NOT mistaken for a remote spec", () =>
    expect(parseRemoteSpec(cfg, "C:\\Users\\me\\file.txt")).toBeNull());

  test("a Windows REMOTE path keeps its drive colon in the path half", () =>
    expect(parseRemoteSpec(cfg, "winbox:C:\\Users\\Admin\\out.png"))
      .toEqual({ sel: "winbox", path: "C:\\Users\\Admin\\out.png" }));

  test("an unknown prefix is treated as a local path, not a host", () =>
    expect(parseRemoteSpec(cfg, "notahost:/x")).toBeNull());

  test("dt:<sandbox>:<path> splits at the SECOND colon", () =>
    expect(parseRemoteSpec(cfg, "dt:spore-abc:/home/daytona/x.txt"))
      .toEqual({ sel: "dt:spore-abc", path: "/home/daytona/x.txt" }));

  test("dt: with no path colon is not a remote spec", () =>
    expect(parseRemoteSpec(cfg, "dt:spore-abc")).toBeNull());
});
