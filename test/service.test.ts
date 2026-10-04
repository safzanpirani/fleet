import { expect, spyOn, test } from "bun:test";
import { restartService, serviceLogs, svcStatus } from "../src/core.ts";
import * as ssh from "../src/ssh.ts";
import type { FleetConfig } from "../src/config.ts";

const cfg: FleetConfig = { hosts: {
  unix: { name: "unix", ssh: "fixture-unix", os: "linux" },
  win: { name: "win", ssh: "fixture-win", os: "windows" },
  mac: { name: "mac", ssh: "fixture-mac", os: "mac" },
} };

test("explicit unit addressing works without a services map", async () => {
  const execute = spyOn(ssh, "exec").mockImplementation(async (host, cmd) => ({ host: host.name, ok: true, code: 0, stdout: cmd.includes("is-active") ? "active\n" : "Running\n", stderr: "" }));
  try {
    for (const type of ["systemd", "systemd-user", "winservice", "nssm", "schtask"] as const) {
      const host = type.startsWith("systemd") ? "unix" : "win";
      const unit = { unit: "fixture'$;unit", type };
      expect((await restartService(cfg, host, unit))[0]!.result.ok).toBe(true);
      expect((await serviceLogs(cfg, host, unit, 4))[0]!.result.ok).toBe(true);
      expect((await svcStatus(cfg, host, unit))[0]!.up).toBe(true);
      for (const [, cmd] of execute.mock.calls.slice(-3)) expect(cmd).toContain(type.startsWith("systemd") ? "fixture'\\''$;unit" : "fixture''$;unit");
    }
  } finally { execute.mockRestore(); }
});

test("explicit units reject wildcard names and incompatible host backends before execution", async () => {
  const execute = spyOn(ssh, "exec").mockResolvedValue({ host: "unix", ok: true, code: 0, stdout: "", stderr: "" });
  try {
    for (const unit of ["wild*", "wild?", "wild[ab]", "", "-option", "nul\0name", "line\nname"]) {
      await expect(restartService(cfg, "win", { unit, type: "winservice" })).rejects.toThrow();
    }
    expect(execute.mock.calls).toHaveLength(0);
    const r = await restartService(cfg, "all", { unit: "fixture.service", type: "systemd" });
    expect(r).toHaveLength(3);
    expect(r.filter((a) => !a.result.ok).map((a) => a.host).sort()).toEqual(["mac", "win"]);
    expect(execute.mock.calls).toHaveLength(1);
    expect((await svcStatus(cfg, "win", { unit: "fixture", type: "systemd" }))[0]).toMatchObject({ up: false });
  } finally { execute.mockRestore(); }
});
