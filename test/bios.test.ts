import { describe, expect, test } from "bun:test";
import { firmwareRebootCmd, firmwareRebootHosts } from "../src/core.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const host = (name: string, os: Host["os"]): Host => ({ name, ssh: name, os });

describe("firmwareRebootCmd", () => {
  test("Windows requests the firmware UI on the next reboot", () => {
    const action = firmwareRebootCmd(host("win", "windows"));
    expect(action.shell).toBe("powershell");
    expect(action.cmd).toContain("shutdown /r /fw");
  });

  test("Linux requests systemd firmware setup on the next reboot", () => {
    const action = firmwareRebootCmd(host("linux", "linux"));
    expect(action.shell).toBe("bash");
    expect(action.cmd).toContain("systemctl reboot --firmware-setup");
  });

  test("a mixed fan-out reports macOS as unsupported without blocking Linux", async () => {
    const cfg: FleetConfig = {
      hosts: {
        linux: host("linux", "linux"),
        mac: host("mac", "mac"),
      },
    };
    const actions = await firmwareRebootHosts(cfg, "all", {
      exec: async (target) => ({
        host: target.name, ok: true, code: 0, stdout: "scheduled", stderr: "",
      }),
    });

    expect(actions.map((action) => [action.host, action.result.ok])).toEqual([
      ["linux", true],
      ["mac", false],
    ]);
    expect(actions[1]!.result.stderr).toContain("no firmware setup");
  });

  test("CLI refuses a firmware reboot without confirmation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-bios-test-"));
    try {
      const config = join(dir, "fleet.config.json");
      writeFileSync(config, JSON.stringify({
        hosts: { win: { ssh: "win", os: "windows", winShell: "pwsh" } },
      }));
      const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "bios", "win"], {
        env: { ...process.env, FLEET_CONFIG: config },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr, code] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain("refusing reboot win into BIOS/UEFI setup");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
