import { test, expect, describe } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootNextCommand, checkEntries, parseBcdeditFirmware, parseEfibootmgr, parseEspList, pickFirmwareEntry,
} from "../src/firmware.ts";
import {
  asRoot, normalizeMac, parseArp, rebootRisk, subnetAddrs, switchCommandFor, switchMachine,
} from "../src/core.ts";
import { hostKeyOpts, validateConfig } from "../src/config.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import type { ExecResult } from "../src/ssh.ts";

// A trimmed `bcdedit /enum firmware` from a dual-boot box with a stale second
// disk: two entries share the Windows Boot Manager label.
const BCD = `
Firmware Boot Manager
---------------------
identifier              {fwbootmgr}
displayorder            {bootmgr}
                        {aaaaaaa1-0000-11f1-8000-000000000001}
                        {aaaaaaa2-0000-11f1-8000-000000000002}
                        {aaaaaaa3-0000-11f1-8000-000000000003}
timeout                 2

Windows Boot Manager
--------------------
identifier              {bootmgr}
device                  partition=\\Device\\HarddiskVolume3
path                    \\EFI\\Microsoft\\Boot\\bootmgfw.efi
description             Windows Boot Manager
locale                  en-US

Firmware Application (101fffff)
-------------------------------
identifier              {aaaaaaa3-0000-11f1-8000-000000000003}
device                  partition=\\Device\\HarddiskVolume9
path                    \\EFI\\Microsoft\\Boot\\bootmgfw.efi
description             Windows Boot Manager

Firmware Application (101fffff)
-------------------------------
identifier              {aaaaaaa2-0000-11f1-8000-000000000002}
device                  partition=\\Device\\HarddiskVolume3
path                    \\EFI\\ubuntu\\shimx64.efi
description             Arcadia

Firmware Application (101fffff)
-------------------------------
identifier              {aaaaaaa1-0000-11f1-8000-000000000001}
device                  partition=\\Device\\HarddiskVolume6
path                    \\EFI\\otheros\\grubx64.efi
description             otheros
`.replace(/\n/g, "\r\n");

const EFI_TAB = [
  "BootCurrent: 0001",
  "Timeout: 1 seconds",
  "BootOrder: 0001,0000,0003",
  "Boot0000* Windows Boot Manager\tHD(1,GPT,0e5f0000-0000-4000-8000-000000000001,0x800,0x32000)/\\EFI\\Microsoft\\Boot\\bootmgfw.efi",
  "Boot0001* Arcadia\tHD(1,GPT,0E5F0000-0000-4000-8000-000000000001,0x800,0x32000)/File(\\EFI\\ubuntu\\shimx64.efi)",
  "Boot0003* otheros\tHD(2,GPT,0e5f0000-0000-4000-8000-000000000002,0x800,0x32000)/File(\\EFI\\otheros\\grubx64.efi)",
  "Boot0004  UEFI OS\tPciRoot(0x0)/Pci(0x1d,0x0)",
].join("\n");

describe("firmware tables", () => {
  test("bcdedit: entries, continuation lines and boot order", () => {
    const t = parseBcdeditFirmware(BCD);
    expect(t.order).toEqual(["{bootmgr}", "{aaaaaaa1-0000-11f1-8000-000000000001}",
      "{aaaaaaa2-0000-11f1-8000-000000000002}", "{aaaaaaa3-0000-11f1-8000-000000000003}"]);
    expect(t.entries.map((e) => e.label)).toEqual(["Windows Boot Manager", "Windows Boot Manager", "Arcadia", "otheros"]);
    expect(t.entries.find((e) => e.label === "Arcadia")).toMatchObject({
      id: "{aaaaaaa2-0000-11f1-8000-000000000002}", partition: "\\Device\\HarddiskVolume3", path: "\\EFI\\ubuntu\\shimx64.efi" });
  });

  test("efibootmgr: tab-separated labels, partition UUIDs and paths", () => {
    const t = parseEfibootmgr(EFI_TAB);
    expect(t.order).toEqual(["0001", "0000", "0003"]);
    expect(t.entries.map((e) => [e.id, e.label])).toEqual([
      ["0000", "Windows Boot Manager"], ["0001", "Arcadia"], ["0003", "otheros"], ["0004", "UEFI OS"]]);
    expect(t.entries[1]).toMatchObject({ partition: "0e5f0000-0000-4000-8000-000000000001", path: "\\EFI\\ubuntu\\shimx64.efi" });
    expect(t.entries[0]!.path).toBe("\\EFI\\Microsoft\\Boot\\bootmgfw.efi");
  });

  test("efibootmgr: old space-separated format", () => {
    const t = parseEfibootmgr("BootOrder: 0002\nBoot0002* Arcadia Linux  HD(1,GPT,0e5f0000-0000-4000-8000-000000000001,0x800,0x32000)/File(\\EFI\\x.efi)");
    expect(t.entries[0]).toMatchObject({ id: "0002", label: "Arcadia Linux", path: "\\EFI\\x.efi" });
  });

  test("a unique label resolves; case does not matter", () => {
    expect(pickFirmwareEntry(parseBcdeditFirmware(BCD), "arcadia").entry.id).toBe("{aaaaaaa2-0000-11f1-8000-000000000002}");
  });

  test("a shared label resolves to the earliest entry in boot order, with a note", () => {
    const r = pickFirmwareEntry(parseBcdeditFirmware(BCD), "Windows Boot Manager");
    expect(r.entry.id).toBe("{bootmgr}");
    expect(r.note).toMatch(/2 entries/);
  });

  test("a missing label refuses and lists what exists", () => {
    expect(() => pickFirmwareEntry(parseBcdeditFirmware(BCD), "ubuntu")).toThrow(/no firmware entry labelled 'ubuntu'.*Arcadia/);
  });

  test("a shared label outside the boot order refuses", () => {
    const t = parseEfibootmgr("BootOrder: 0001\nBoot0005* Dup\tHD(1,GPT,0e5f0000-0000-4000-8000-000000000001,1,1)\nBoot0006* Dup\tHD(1,GPT,0e5f0000-0000-4000-8000-000000000001,1,1)");
    expect(() => pickFirmwareEntry(t, "Dup")).toThrow(/boot order does not pick one/);
  });

  test("entries off the first EFI partition are flagged", () => {
    const t = parseBcdeditFirmware(BCD);
    const esps = parseEspList("windows", "ESP\t0e5f0001\t\\Device\\HarddiskVolume3\r\nESP\t0e5f0002\t\\Device\\HarddiskVolume6\r\n");
    const checked = checkEntries(t, esps);
    const arcadia = checked.find((e) => e.label === "Arcadia")!;
    expect(arcadia.esp).toBe(0);
    expect(arcadia.warning).toBeUndefined();
    expect(checked.find((e) => e.label === "otheros")!.warning).toMatch(/partition #2/);
    expect(checked.find((e) => e.id.startsWith("{aaaaaaa3"))!.warning).toMatch(/not an EFI system partition/);
  });

  test("boot-next commands validate ids and never reboot after a failed set", () => {
    const win = bootNextCommand("windows", { id: "{aaaaaaa2-0000-11f1-8000-000000000002}", label: "Arcadia" }, "arcadia");
    expect(win).toContain("bootsequence '{aaaaaaa2-0000-11f1-8000-000000000002}'");
    expect(win.indexOf("exit 3")).toBeLessThan(win.indexOf("shutdown /r"));
    const lin = bootNextCommand("linux", { id: "0003", label: "otheros" }, "otheros");
    expect(lin).toContain("efibootmgr --bootnext 0003");
    expect(lin.indexOf("not rebooting")).toBeLessThan(lin.indexOf("systemctl reboot"));
    expect(() => bootNextCommand("windows", { id: "{x}; shutdown", label: "x" }, "x")).toThrow();
    expect(() => bootNextCommand("linux", { id: "3; reboot", label: "x" }, "x")).toThrow();
  });
});

describe("switch configuration", () => {
  const base = (): FleetConfig => ({
    hosts: {
      win: { name: "win", ssh: "win", os: "windows" },
      lin: { name: "lin", ssh: "lin", os: "linux" },
      other: { name: "other", ssh: "other", os: "linux" },
    },
    machines: { box: { boots: { windows: { host: "win" }, linux: { host: "lin" }, other: { host: "other" } } } },
  });

  test("switch commands may be keyed by source boot", () => {
    const c = base();
    c.machines!.box!.switch = { linux: { windows: "cmd /c x.cmd", other: "sudo x" } };
    expect(() => validateConfig(c, "t")).not.toThrow();
    expect(switchCommandFor(c.machines!.box!, "linux", "windows")).toBe("cmd /c x.cmd");
    expect(switchCommandFor(c.machines!.box!, "linux", "linux")).toBeUndefined();
    c.machines!.box!.switch = { linux: "one for all" };
    expect(switchCommandFor(c.machines!.box!, "linux", "other")).toBe("one for all");
  });

  test("a keyed switch rejects unknown or self source boots", () => {
    const c = base();
    c.machines!.box!.switch = { linux: { nope: "x" } };
    expect(() => validateConfig(c, "t")).toThrow(/no such source boot/);
    c.machines!.box!.switch = { linux: { linux: "x" } };
    expect(() => validateConfig(c, "t")).toThrow(/cannot switch to itself/);
  });

  test("firmware labels, mac, hostKeyAlias and sudo validate", () => {
    const c = base();
    c.machines!.box!.boots.linux!.firmware = "Arcadia";
    c.machines!.box!.mac = "02:00:00:aa:bb:cc";
    c.hosts.lin!.hostKeyAlias = "box-linux";
    c.hosts.lin!.sudo = { passwordFile: "~/.config/fleet/sudo-lin" };
    expect(() => validateConfig(c, "t")).not.toThrow();
    c.machines!.box!.boots.linux!.firmware = "a'b";
    expect(() => validateConfig(c, "t")).toThrow(/firmware/);
    c.machines!.box!.boots.linux!.firmware = "Arcadia";
    c.machines!.box!.mac = "02:00";
    expect(() => validateConfig(c, "t")).toThrow(/mac/);
    delete c.machines!.box!.mac;
    c.hosts.lin!.hostKeyAlias = "bad alias";
    expect(() => validateConfig(c, "t")).toThrow(/hostKeyAlias/);
    c.hosts.lin!.hostKeyAlias = "ok";
    c.hosts.lin!.sudo = {};
    expect(() => validateConfig(c, "t")).toThrow(/exactly one/);
    c.hosts.win!.sudo = { passwordEnv: "X" };
    c.hosts.lin!.sudo = { passwordEnv: "X" };
    expect(() => validateConfig(c, "t")).toThrow(/POSIX/);
  });

  test("a host key alias forces strict checking in the default store", () => {
    const opts = hostKeyOpts({ name: "lin", ssh: "lin", os: "linux", hostKeyAlias: "box-linux" });
    expect(opts).toContain("HostKeyAlias=box-linux");
    expect(opts).toContain("StrictHostKeyChecking=yes");
    expect(opts.some((o) => o.startsWith("UserKnownHostsFile="))).toBe(true);
    expect(hostKeyOpts({ name: "x", ssh: "x", os: "linux" })).toEqual([]);
  });
});

describe("switchMachine", () => {
  const cfg: FleetConfig = {
    hosts: {
      win: { name: "win", ssh: "win", os: "windows" },
      lin: { name: "lin", ssh: "lin", os: "linux" },
    },
    machines: { box: {
      boots: { windows: { host: "win" }, linux: { host: "lin", firmware: "Arcadia" } },
      switch: { windows: { linux: "sudo boot-windows" } },
    } },
  };
  const ok = (stdout = ""): ExecResult => ({ host: "win", ok: true, code: 0, stdout, stderr: "" });

  /** A box whose live boot flips after `downAfter` probes of the source. */
  function box(opts: { trigger?: ExecResult; flips?: boolean }) {
    let live = "win", sourceProbes = 0, triggered = false;
    const execs: string[] = [];
    const exec = async (h: Host, cmd: string): Promise<ExecResult> => {
      execs.push(cmd);
      if (cmd === "bcdedit /enum firmware") return ok(BCD);
      if (cmd.includes("Get-Partition")) return ok("ESP\t0e5f0001\t\\Device\\HarddiskVolume3\n");
      triggered = true;
      return opts.trigger ?? ok("fleet: one-time boot set");
    };
    const probe = async (h: Host) => {
      if (h.name === "win" && triggered && opts.flips !== false && ++sourceProbes >= 2) live = "lin";
      return h.name === live;
    };
    return { exec: exec as any, probe, execs };
  }

  test("a firmware switch reports every phase and arrives", async () => {
    const b = box({});
    const phases: string[] = [];
    const r = await switchMachine(cfg, "box", "linux", {
      intervalMs: 1, timeoutMs: 60_000, deps: { exec: b.exec, probe: b.probe },
      onProgress: (p) => phases.push(p.phase),
    });
    expect(r.arrived).toBe(true);
    expect(r.wentDown).toBe(true);
    expect(r.landedIn).toBe("linux");
    expect(r.plan).toMatchObject({ kind: "firmware", label: "Arcadia" });
    expect(b.execs.some((c) => c.includes("bootsequence '{aaaaaaa2-0000-11f1-8000-000000000002}'"))).toBe(true);
    expect([...new Set(phases)]).toEqual(["probe", "plan", "trigger", "reboot", "wait", "done"]);
  });

  test("a dry run resolves the entry and runs nothing that reboots", async () => {
    const b = box({});
    const r = await switchMachine(cfg, "box", "linux", { dryRun: true, deps: { exec: b.exec, probe: b.probe } });
    expect(r.triggered).toBeNull();
    expect(b.execs.every((c) => !c.includes("bootsequence '"))).toBe(true);
  });

  test("a failed trigger refuses to wait", async () => {
    const b = box({ trigger: { host: "win", ok: false, code: 3, stdout: "", stderr: "fleet: bcdedit refused" } });
    await expect(switchMachine(cfg, "box", "linux", { deps: { exec: b.exec, probe: b.probe } }))
      .rejects.toThrow(/failed \(exit 3\).*still be in windows.*bcdedit refused/);
  });

  test("a trigger that never reboots is reported, not waited out", async () => {
    const b = box({ flips: false });
    const r = await switchMachine(cfg, "box", "linux", { intervalMs: 1, timeoutMs: 50, deps: { exec: b.exec, probe: b.probe } });
    expect(r.wentDown).toBe(false);
    expect(r.arrived).toBe(false);
    expect(r.landedIn).toBe("windows");
  });

  test("a missing firmware label refuses before any reboot", async () => {
    const c = structuredClone(cfg);
    c.machines!.box!.boots.linux!.firmware = "Nope";
    const b = box({});
    await expect(switchMachine(c, "box", "linux", { deps: { exec: b.exec, probe: b.probe } })).rejects.toThrow(/no firmware entry labelled 'Nope'/);
    expect(b.execs.every((x) => !x.includes("shutdown"))).toBe(true);
  });
});

describe("reboot guard", () => {
  test.each([
    "boot-windows --help", "sudo boot-arcadia", "cmd /c C:\\tools\\boot-arcadia.cmd", "/usr/local/bin/boot-windows",
    "shutdown /r /t 0", "shutdown -r now", "sudo reboot", "echo x; reboot", "systemctl reboot",
    "sudo systemctl --no-block poweroff", "Restart-Computer -Force", "sudo init 6",
  ])("flags %s", (cmd) => expect(rebootRisk(cmd)).not.toBeNull());
  test.each([
    "echo hi", "grep reboot file", "cat /usr/local/bin/boot-windows", "ls ~/boot-scripts", "shutdown -c",
    "systemctl status reboot.target", "journalctl --list-boots", "rg -n boot-arcadia .", "efibootmgr -v",
  ])("passes %s", (cmd) => expect(rebootRisk(cmd)).toBeNull());
});

describe("asRoot", () => {
  /** Run the wrapper with fake `id` and `sudo` on PATH. The fake sudo reads
   *  its password one byte at a time, as the real one does. */
  function runWrapped(script: string, opts: { password?: string; nopasswd?: boolean; real?: string }) {
    const dir = mkdtempSync(join(tmpdir(), "fleet-asroot-"));
    try {
      writeFileSync(join(dir, "id"), "#!/bin/sh\necho 1000\n");
      writeFileSync(join(dir, "sudo"), `#!/bin/bash
args=("$@")
if [ "\${args[0]}" = -n ]; then ${opts.nopasswd ? 'shift; exec "$@"' : "exit 1"}; fi
# -k -S -p '' CMD...
shift 4
pw=""
while IFS= read -r -n1 c; do [ -z "$c" ] && break; pw="$pw$c"; done
[ "$pw" = '${opts.real ?? "s3cret pass"}' ] || { echo "sudo: wrong" >&2; exit 1; }
exec "$@"
`);
      chmodSync(join(dir, "id"), 0o755); chmodSync(join(dir, "sudo"), 0o755);
      const wrapped = asRoot(script, { password: opts.password, host: "box" });
      const r = Bun.spawnSync(["bash", "-c", wrapped], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdin: "ignore" });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), wrapped };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("a password reaches sudo and the body runs with an empty stdin", () => {
    const r = runWrapped(`echo start; cat; echo "after cat"; exit 5`, { password: "s3cret pass" });
    expect(r.out).toBe("start\nafter cat\n");
    expect(r.code).toBe(5);
    expect(r.wrapped).not.toContain("s3cret");
  });

  test("a wrong password fails before the script runs", () => {
    const r = runWrapped(`echo ran`, { password: "nope" });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/rejected the configured password/);
  });

  test("passwordless sudo never sees the password line", () => {
    const r = runWrapped(`echo ran`, { password: "s3cret pass", nopasswd: true });
    expect(r.out).toBe("ran\n");
    expect(r.code).toBe(0);
  });

  test("without a password it says where to configure one", () => {
    const r = runWrapped(`echo ran`, {});
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/hosts\.box\.sudo\.passwordFile/);
  });
});

describe("find", () => {
  test("ARP output from three platforms", () => {
    expect(parseArp("? (10.9.8.94) at 02:00:00:aa:bb:cc on en0 ifscope [ethernet]\n? (10.9.8.2) at (incomplete) on en0")).toEqual([
      { ip: "10.9.8.94", mac: "02:00:00:aa:bb:cc" }]);
    expect(parseArp("10.9.8.94 dev enp4s0 lladdr 02:00:00:aa:bb:cc STALE")).toEqual([{ ip: "10.9.8.94", mac: "02:00:00:aa:bb:cc" }]);
    expect(parseArp("  10.9.8.94          02-00-00-aa-bb-cc     dynamic\n  10.9.8.255  ff-ff-ff-ff-ff-ff  static")).toEqual([
      { ip: "10.9.8.94", mac: "02:00:00:aa:bb:cc" }]);
    expect(normalizeMac("0:1b:2:aa:B:c")).toBe("00:1b:02:aa:0b:0c");
  });

  test("subnets are private and small", () => {
    const n = subnetAddrs("10.9.8.95", 24)!;
    expect(n.cidr).toBe("10.9.8.0/24");
    expect(n.addrs).toHaveLength(253);
    expect(n.addrs).not.toContain("10.9.8.95");
    expect(subnetAddrs("100.64.0.9", 24)).toBeNull();
    expect(subnetAddrs("10.0.0.1", 16)).toBeNull();
  });
});
