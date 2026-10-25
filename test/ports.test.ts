import { describe, expect, test } from "bun:test";
import type { FleetConfig, Host } from "../src/config.ts";
import type { ExecResult } from "../src/ssh.ts";
import { matchesPortFilter, parseLsof, parseSs, parseWindowsPorts, portList, portsScript } from "../src/ports.ts";

const S = "__FLEET_PORTS__";
const lin: Host = { name: "lin", ssh: "lin", os: "linux" };
const mac: Host = { name: "mac", ssh: "mac", os: "mac" };
const win: Host = { name: "win", ssh: "win", os: "windows" };
const cfg: FleetConfig = { hosts: { lin, mac, win } };
const ok = (stdout: string): ExecResult => ({ host: "x", ok: true, code: 0, stdout, stderr: "" });

// ss -Hltnp: State Recv-Q Send-Q Local Peer Process
const ssOut = [
  `${S}ss`,
  `LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*    users:(("systemd-resolve",pid=612,fd=14))`,
  `LISTEN 0      511          0.0.0.0:80         0.0.0.0:*    users:(("nginx",pid=901,fd=6),("nginx",pid=900,fd=6))`,
  `LISTEN 0      128             [::]:22            [::]:*`,
  `LISTEN 0      4096               *:3000             *:*    users:(("node",pid=1200,fd=21))`,
  `LISTEN 0      128          0.0.0.0:22         0.0.0.0:*`,
].join("\n");

// lsof -nP +c 0 -iTCP -sTCP:LISTEN -F pcn
const lsofOut = [
  `${S}lsof`,
  "p501", "cControlCenter", "f9", "n*:7000", "f10", "n*:7000",
  "p8120", "cpostgres", "f7", "n[::1]:5432", "f8", "n127.0.0.1:5432",
  "p9001", "cnode", "f22", "n*:3000",
].join("\n");

describe("parsing", () => {
  test("ss rows keep the first owner and tolerate missing -p data", () => {
    const rows = parseSs(lin, "tcp", ssOut);
    expect(rows).toEqual([
      { host: "lin", proto: "tcp", addr: "127.0.0.53%lo", port: 53, pid: 612, name: "systemd-resolve" },
      { host: "lin", proto: "tcp", addr: "0.0.0.0", port: 80, pid: 901, name: "nginx" },
      { host: "lin", proto: "tcp", addr: "::", port: 22, pid: null, name: null },
      { host: "lin", proto: "tcp", addr: "*", port: 3000, pid: 1200, name: "node" },
      { host: "lin", proto: "tcp", addr: "0.0.0.0", port: 22, pid: null, name: null },
    ]);
  });

  test("ss UDP rows (UNCONN state) parse the same way", () => {
    const rows = parseSs(lin, "udp", `UNCONN 0 0 0.0.0.0%eth0:68 0.0.0.0:* users:(("dhclient",pid=77,fd=6))\n`);
    expect(rows).toEqual([{ host: "lin", proto: "udp", addr: "0.0.0.0%eth0", port: 68, pid: 77, name: "dhclient" }]);
  });

  test("lsof field output pairs each socket with its process", () => {
    const rows = parseLsof(mac, "tcp", lsofOut);
    expect(rows.map((r) => [r.addr, r.port, r.pid, r.name])).toEqual([
      ["*", 7000, 501, "ControlCenter"], ["*", 7000, 501, "ControlCenter"],
      ["::1", 5432, 8120, "postgres"], ["127.0.0.1", 5432, 8120, "postgres"],
      ["*", 3000, 9001, "node"],
    ]);
  });

  test("lsof UDP skips connected sockets", () => {
    const rows = parseLsof(mac, "udp", ["p10", "cmDNSResponder", "n*:5353", "n192.0.2.2:5000->1.1.1.1:53"].join("\n"));
    expect(rows).toEqual([{ host: "mac", proto: "udp", addr: "*", port: 5353, pid: 10, name: "mDNSResponder" }]);
  });

  test("Windows JSON: arrays, a lone object, and an empty list", () => {
    const many = `noise\n${S}json|[{"addr":"0.0.0.0","port":445,"pid":4,"name":"System"},{"addr":"::","port":3389,"pid":1100,"name":null}]\r\n`;
    expect(parseWindowsPorts(win, "tcp", many)).toEqual([
      { host: "win", proto: "tcp", addr: "0.0.0.0", port: 445, pid: 4, name: "System" },
      { host: "win", proto: "tcp", addr: "::", port: 3389, pid: 1100, name: null },
    ]);
    expect(parseWindowsPorts(win, "udp", `${S}json|{"addr":"0.0.0.0","port":5353,"pid":2,"name":"svchost"}`)).toHaveLength(1);
    expect(parseWindowsPorts(win, "tcp", `${S}json|[]`)).toEqual([]);
    expect(() => parseWindowsPorts(win, "tcp", "nothing")).toThrow("did not report");
  });
});

describe("scripts", () => {
  test("each OS uses its own listing and the UDP variant", () => {
    expect(portsScript("linux", "tcp")).toContain("ss -Hltnp 2>/dev/null || ss -Hltn");
    expect(portsScript("linux", "udp")).toContain("ss -Hlunp");
    expect(portsScript("mac", "tcp")).toContain("-iTCP -sTCP:LISTEN");
    expect(portsScript("mac", "udp")).toContain("-iUDP");
    expect(portsScript("windows", "tcp")).toContain("Get-NetTCPConnection -State Listen");
    expect(portsScript("windows", "udp")).toContain("Get-NetUDPEndpoint");
    // Windows PowerShell 5.1 unrolls a piped empty array to nothing; -InputObject keeps "[]".
    expect(portsScript("windows", "tcp")).toContain("ConvertTo-Json -InputObject $rows");
  });
});

describe("ports", () => {
  test("rows are deduplicated and sorted by port, then address", async () => {
    const [l] = await portList(cfg, "mac", {}, { exec: async () => ok(lsofOut) });
    expect(l!.ok).toBe(true);
    expect(l!.rows.map((r) => `${r.port} ${r.addr}`)).toEqual(["3000 *", "5432 127.0.0.1", "5432 ::1", "7000 *"]);
  });

  test("the filter matches a port exactly or a name substring, case-insensitively", async () => {
    const run = async (filter: string) =>
      (await portList(cfg, "lin", { filter }, { exec: async () => ok(ssOut) }))[0]!.rows.map((r) => r.port);
    expect(await run("22")).toEqual([22, 22]);
    expect(await run("2")).toEqual([]);
    expect(await run("NGI")).toEqual([80]);
    expect(await run("systemd")).toEqual([53]);
    expect(matchesPortFilter({ host: "w", proto: "tcp", addr: "::", port: 1, pid: 3, name: "sshd" }, "sshd.exe")).toBe(true);
  });

  test("routes each OS to its shell and keeps failed hosts in the result", async () => {
    const seen: string[] = [];
    const lists = await portList(cfg, "all", { udp: true }, {
      exec: async (h, cmd, shell) => {
        seen.push(`${h.name}:${shell}`);
        if (h.os === "windows") return { host: h.name, ok: false, code: 255, stdout: "", stderr: "ssh: connect timed out\n" };
        expect(cmd).toContain(h.os === "mac" ? "-iUDP" : "ss -Hlunp");
        return ok(h.os === "mac" ? "" : `UNCONN 0 0 0.0.0.0:68 0.0.0.0:*\n`);
      },
    });
    expect(seen.sort()).toEqual(["lin:bash", "mac:bash", "win:powershell"]);
    expect(lists).toEqual([
      { host: "lin", ok: true, rows: [{ host: "lin", proto: "udp", addr: "0.0.0.0", port: 68, pid: null, name: null }] },
      { host: "mac", ok: true, rows: [] },
      { host: "win", ok: false, error: "ssh: connect timed out", rows: [] },
    ]);
    expect(JSON.parse(JSON.stringify(lists))).toEqual(lists);
  });

  test("a blank filter is refused before any host is contacted", async () => {
    let called = false;
    await expect(portList(cfg, "lin", { filter: "  " }, { exec: async () => { called = true; return ok(""); } })).rejects.toThrow("filter");
    expect(called).toBe(false);
  });
});
