import { test, expect, describe } from "bun:test";
import { parseRemoteSpec } from "../src/core.ts";
import type { FleetConfig, Host } from "../src/config.ts";

const host = (name: string, os: Host["os"]): Host => ({ name, ssh: name, os });
const cfg: FleetConfig = {
  hosts: { oracle: host("oracle", "linux"), "win-box": host("win-box", "windows") },
  routes: { "oracle-auto": { prefer: ["oracle"] } },
  groups: { cloud: ["oracle"] },
  machines: { cachy: { boots: { linux: { host: "oracle" } } } },
};

describe("parseRemoteSpec (cp direction detection)", () => {
  test("host:path splits at the first colon", () =>
    expect(parseRemoteSpec(cfg, "oracle:/tmp/x")).toEqual({ sel: "oracle", path: "/tmp/x" }));

  test("@group / all / comma-list prefixes are recognised", () => {
    expect(parseRemoteSpec(cfg, "@cloud:~/x")?.sel).toBe("@cloud");
    expect(parseRemoteSpec(cfg, "@linux:~/x")?.sel).toBe("@linux");
    expect(parseRemoteSpec(cfg, "all:/x")?.sel).toBe("all");
    expect(parseRemoteSpec(cfg, "oracle,win-box:/x")?.sel).toBe("oracle,win-box");
  });

  test("a dual-boot machine name is a valid prefix", () =>
    expect(parseRemoteSpec(cfg, "cachy:/x")?.sel).toBe("cachy"));

  test("a logical route name is a valid prefix", () =>
    expect(parseRemoteSpec(cfg, "oracle-auto:/x")?.sel).toBe("oracle-auto"));

  test("a plain local path (no colon) is not a remote spec", () =>
    expect(parseRemoteSpec(cfg, "./dir/file.txt")).toBeNull());

  test("a Windows drive path is NOT mistaken for a remote spec", () =>
    expect(parseRemoteSpec(cfg, "C:\\Users\\me\\file.txt")).toBeNull());

  test("a Windows REMOTE path keeps its drive colon in the path half", () =>
    expect(parseRemoteSpec(cfg, "win-box:C:\\Users\\Admin\\out.png"))
      .toEqual({ sel: "win-box", path: "C:\\Users\\Admin\\out.png" }));

  test("an unknown prefix is treated as a local path, not a host", () =>
    expect(parseRemoteSpec(cfg, "notahost:/x")).toBeNull());

  test("dt:<sandbox>:<path> splits at the SECOND colon", () =>
    expect(parseRemoteSpec(cfg, "dt:spore-abc:/home/daytona/x.txt"))
      .toEqual({ sel: "dt:spore-abc", path: "/home/daytona/x.txt" }));

  test("dt: with no path colon is not a remote spec", () =>
    expect(parseRemoteSpec(cfg, "dt:spore-abc")).toBeNull());
});
