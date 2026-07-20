import { test, expect, describe } from "bun:test";
import { diskCmd, parseDisk } from "../src/core.ts";
import type { Host } from "../src/config.ts";

const win: Host = { name: "main", ssh: "main", os: "windows" };
const lin: Host = { name: "vps", ssh: "vps", os: "linux" };
const mac: Host = { name: "mac", ssh: "mac", os: "mac" };

describe("diskCmd", () => {
  test("windows uses Get-Volume, never the removed `wmic`", () => {
    const { cmd, shell } = diskCmd(win);
    expect(shell).toBe("powershell");
    expect(cmd).toContain("Get-Volume");
    expect(cmd).not.toContain("wmic");
  });

  test("windows filters to fixed volumes and emits one-line json", () => {
    const { cmd } = diskCmd(win);
    expect(cmd).toContain("'Fixed'");
    expect(cmd).toContain("ConvertTo-Json -Compress");
  });

  test("unix uses POSIX df and keeps only real block devices", () => {
    const { cmd, shell } = diskCmd(lin);
    expect(shell).toBe("bash");
    expect(cmd).toContain("df -kP");
    expect(cmd).toContain("\\/dev\\/");   // awk-escaped: /^\/dev\//
  });
});

describe("parseDisk — windows", () => {
  const GB = 1024 ** 3;
  const json = JSON.stringify([
    { mount: "C:", label: "Windows X-Lite", total: 1318.3 * GB, free: 8.9 * GB },
    { mount: "D:", label: "2TB", total: 1863 * GB, free: 33.8 * GB },
  ]);

  test("reads every volume, not just the boot drive", () => {
    const rows = parseDisk(win, json);
    expect(rows.map((r) => r.mount)).toEqual(["C:", "D:"]);
  });

  test("computes free space and percent used", () => {
    const d = parseDisk(win, json).find((r) => r.mount === "D:")!;
    expect(d.free_gb).toBe(33.8);
    expect(d.total_gb).toBe(1863);
    expect(d.label).toBe("2TB");
    expect(d.pct).toBeCloseTo(98.2, 0);
  });

  test("a single volume still parses (ConvertTo-Json emits a bare object)", () => {
    const rows = parseDisk(win, JSON.stringify({ mount: "C:", label: "OS", total: 100 * GB, free: 25 * GB }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pct).toBe(75);
  });

  test("empty / non-json output yields no rows rather than throwing", () => {
    expect(parseDisk(win, "")).toEqual([]);
    expect(parseDisk(win, "Access is denied.")).toEqual([]);
  });

  test("a zero-size volume is skipped (no divide-by-zero)", () => {
    const rows = parseDisk(win, JSON.stringify([{ mount: "X:", label: "", total: 0, free: 0 }]));
    expect(rows).toEqual([]);
  });
});

describe("parseDisk — unix", () => {
  test("parses df columns into free/total/pct", () => {
    //          device    1k-blocks     used     avail  cap  mount
    const rows = parseDisk(lin, "/dev/vda1 34320764 20971520 13349244 61% /");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mount).toBe("/");
    expect(rows[0]!.label).toBe("/dev/vda1");
    expect(rows[0]!.total_gb).toBeCloseTo(32.7, 0);
    expect(rows[0]!.free_gb).toBeCloseTo(12.7, 0);
    expect(rows[0]!.pct).toBeCloseTo(61, 0);   // (total - avail) / total
  });

  test("btrfs subvolumes on one device collapse to a single row", () => {
    // A Linux host can report /, /home, /var/log … all as one block device.
    const out = [
      "/dev/sda5 108505600 79267840 27676672 75% /",
      "/dev/sda5 108505600 79267840 27676672 75% /home",
      "/dev/sda5 108505600 79267840 27676672 75% /var/log",
      "/dev/sda6 1048576 4096 1044480 1% /boot/efi",
    ].join("\n");
    const rows = parseDisk(lin, out);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.label)).toEqual(["/dev/sda5", "/dev/sda6"]);
  });

  test("the shortest mountpoint represents a deduped device", () => {
    const out = [
      "/dev/sda5 100 50 50 50% /var/cache",
      "/dev/sda5 100 50 50 50% /",
    ].join("\n");
    expect(parseDisk(lin, out)[0]!.mount).toBe("/");
  });

  test("APFS volumes sharing a container collapse to one row", () => {
    // mac gives each APFS volume its own device but one shared capacity.
    const out = [
      "/dev/disk3s1s1 239362496 238500000 862496 100% /",
      "/dev/disk3s5 239362496 238500000 862496 100% /System/Volumes/Data",
      "/dev/disk3s6 239362496 238500000 862496 100% /System/Volumes/VM",
      "/dev/disk1s2 1048576 40000 1008576 4% /System/Volumes/xarts",
    ].join("\n");
    const rows = parseDisk(mac, out);
    expect(rows).toHaveLength(2);            // disk3 container + disk1 container
    expect(rows[0]!.mount).toBe("/");
    expect(rows[1]!.mount).toBe("/System/Volumes/xarts");
  });

  test("linux partitions on one physical disk stay SEPARATE (not APFS-folded)", () => {
    // sda5 and sda6 have independent free space — collapsing them would be a lie.
    const out = [
      "/dev/sda5 108505600 79267840 27676672 75% /",
      "/dev/sda6 1048576 4096 1044480 1% /boot/efi",
    ].join("\n");
    expect(parseDisk(lin, out)).toHaveLength(2);
  });

  test("mountpoints containing spaces survive the split", () => {
    const rows = parseDisk(mac, "/dev/disk3s1 100 50 50 50% /Volumes/My Disk");
    expect(rows[0]!.mount).toBe("/Volumes/My Disk");
  });

  test("blank output yields no rows", () => {
    expect(parseDisk(lin, "")).toEqual([]);
  });
});
