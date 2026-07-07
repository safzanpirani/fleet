import { test, expect, describe } from "bun:test";
import { parseRemoteSpec } from "../src/core.ts";
import type { FleetConfig, Host } from "../src/config.ts";

const host = (name: string, os: Host["os"]): Host => ({ name, ssh: name, os });
const cfg: FleetConfig = {
  hosts: { oracle: host("oracle", "linux"), winbox: host("winbox", "windows") },
  groups: { cloud: ["oracle"] },
  machines: { gpubox: { boots: { linux: { host: "oracle" } } } },
};

describe("parseRemoteSpec (cp direction detection)", () => {
  test("host:path splits at the first colon", () =>
    expect(parseRemoteSpec(cfg, "oracle:/tmp/x")).toEqual({ sel: "oracle", path: "/tmp/x" }));

  test("@group / all / comma-list prefixes are recognised", () => {
    expect(parseRemoteSpec(cfg, "@cloud:~/x")?.sel).toBe("@cloud");
    expect(parseRemoteSpec(cfg, "@linux:~/x")?.sel).toBe("@linux");
    expect(parseRemoteSpec(cfg, "all:/x")?.sel).toBe("all");
    expect(parseRemoteSpec(cfg, "oracle,winbox:/x")?.sel).toBe("oracle,winbox");
  });

  test("a dual-boot machine name is a valid prefix", () =>
    expect(parseRemoteSpec(cfg, "gpubox:/x")?.sel).toBe("gpubox"));

  test("a plain local path (no colon) is not a remote spec", () =>
    expect(parseRemoteSpec(cfg, "./dir/file.txt")).toBeNull());

  test("a Windows drive path is NOT mistaken for a remote spec", () =>
    expect(parseRemoteSpec(cfg, "C:\\Users\\me\\file.txt")).toBeNull());

  test("a Windows REMOTE path keeps its drive colon in the path half", () =>
    expect(parseRemoteSpec(cfg, "winbox:C:\\Users\\Admin\\out.png"))
      .toEqual({ sel: "winbox", path: "C:\\Users\\Admin\\out.png" }));

  test("an unknown prefix is treated as a local path, not a host", () =>
    expect(parseRemoteSpec(cfg, "notahost:/x")).toBeNull());
});
