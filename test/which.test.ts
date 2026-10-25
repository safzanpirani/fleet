import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertProgramName, parseWhich, whichCmd, whichRows } from "../src/core.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import type { ExecResult } from "../src/ssh.ts";

const win: Host = { name: "winbox", ssh: "winbox", os: "windows" };
const lin: Host = { name: "vps", ssh: "vps", os: "linux" };
const mac: Host = { name: "mac", ssh: "mac", os: "mac" };
const S = "__FLEET_WHICH__";

describe("assertProgramName", () => {
  test("accepts plain program names", () => {
    for (const n of ["git", "python3.11", "g++", "node_modules", "7z", "x86_64-linux-gnu-gcc", ".hidden"])
      expect(() => assertProgramName(n)).not.toThrow();
  });
  test("rejects anything a shell could read as more than a name", () => {
    for (const n of ["", "-v", "--version", "a b", "a;b", "$(id)", "`id`", "a'b", "a\"b", "a/b", "a\\b", "*", "a?", "[a]", "a\nb", "a|b", "x".repeat(129)])
      expect(() => assertProgramName(n)).toThrow(/plain program name/);
  });
  test("whichCmd validates before building a program", () => {
    expect(() => whichCmd(lin, "a'; rm -rf ~; '", false)).toThrow();
    expect(() => whichCmd(win, "a'; Remove-Item C:\\ -Recurse; '", true)).toThrow();
  });
});

describe("whichCmd", () => {
  test("windows resolves through Get-Command and follows aliases", () => {
    const { cmd, shell } = whichCmd(win, "git", false);
    expect(shell).toBe("powershell");
    expect(cmd).toContain("$c = 'git'");
    expect(cmd).toContain("Get-Command -Name $c");
    expect(cmd).toContain("ResolvedCommand");
    expect(cmd).not.toContain("--version");
  });
  test("windows version probe is bounded and runs .cmd/.ps1 through their hosts", () => {
    const { cmd } = whichCmd(win, "npm", true);
    expect(cmd).toContain("WaitForExit(5000)");
    expect(cmd).toContain("$env:ComSpec");
    expect(cmd).toContain("-File");
    expect(cmd).toContain("ReadToEndAsync");
    expect(cmd).toContain("StandardInput.Close()");
  });
  test("unix uses command -v and only probes with --version", () => {
    expect(whichCmd(lin, "git", false).cmd).not.toContain("--version");
    const { cmd, shell } = whichCmd(mac, "git", true);
    expect(shell).toBe("bash");
    expect(cmd).toContain("command -v");
    expect(cmd).toContain("--version </dev/null");
    expect(cmd).not.toMatch(/\btimeout \d/); // macOS has no timeout(1)
  });
});

/** Runs the real POSIX program in a local bash, the shape it takes on Linux and macOS. */
async function runLocal(name: string, version: boolean, path: string): Promise<string> {
  const { cmd } = whichCmd(lin, name, version);
  const p = Bun.spawn(["bash", "-c", cmd], { env: { ...process.env, PATH: path }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

describe("posix program (local bash)", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-which-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const tool = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  tool("fakever", "printf '\\n  fakever 1.2.3 (build 9)\\r\\nsecond line\\n'");
  tool("errver", "echo 'errver 4.5' >&2; exit 2");
  tool("slowver", "sleep 30; echo late");
  tool("readsin", "cat; echo 'readsin 0.1'");
  const PATH = `${bin}:/usr/bin:/bin`;

  test("found file with first version line, CR stripped", async () => {
    const out = await runLocal("fakever", true, PATH);
    expect(parseWhich(lin, "fakever", out, true)).toEqual({
      host: "vps", os: "linux", ok: true, cmd: "fakever", path: join(bin, "fakever"), kind: "file", version: "fakever 1.2.3 (build 9)",
    });
  });
  test("version printed on stderr still counts", async () => {
    const row = parseWhich(lin, "errver", await runLocal("errver", true, PATH), true);
    expect(row.version).toBe("errver 4.5");
  });
  test("a probe reading stdin gets EOF instead of hanging", async () => {
    const row = parseWhich(lin, "readsin", await runLocal("readsin", true, PATH), true);
    expect(row.version).toBe("readsin 0.1");
  });
  test("missing program", async () => {
    const row = parseWhich(lin, "no-such-tool-xyz", await runLocal("no-such-tool-xyz", true, PATH), true);
    expect(row).toEqual({ host: "vps", os: "linux", ok: true, cmd: "no-such-tool-xyz", path: null, version: null });
  });
  test("builtin is reported by kind and never probed", async () => {
    const row = parseWhich(lin, "echo", await runLocal("echo", true, PATH), true);
    expect(row.path).toBe("echo");
    expect(row.kind).toBe("builtin");
    expect(row.version).toBeNull();
  });
  test("a hung --version is killed after the timeout", async () => {
    const t0 = Date.now();
    const row = parseWhich(lin, "slowver", await runLocal("slowver", true, PATH), true);
    expect(Date.now() - t0).toBeLessThan(12_000);
    expect(row.path).toBe(join(bin, "slowver"));
    expect(row.version).toBeNull();
    expect(row.version_timeout).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }, 20_000);
});

describe("parseWhich — windows output", () => {
  test("application path with spaces and a version", () => {
    const out = `${S}\tfound\tfile\tC:\\Program Files\\Git\\cmd\\git.exe\r\n${S}\tversion\tgit version 2.47.0.windows.1\r\n`;
    expect(parseWhich(win, "git", out, true)).toEqual({
      host: "winbox", os: "windows", ok: true, cmd: "git", path: "C:\\Program Files\\Git\\cmd\\git.exe", kind: "file", version: "git version 2.47.0.windows.1",
    });
  });
  test("cmdlet, missing, timeout and stray output", () => {
    expect(parseWhich(win, "Get-Item", `${S}\tfound\tcmdlet\tGet-Item\r\n`, false))
      .toEqual({ host: "winbox", os: "windows", ok: true, cmd: "Get-Item", path: "Get-Item", kind: "cmdlet" });
    expect(parseWhich(win, "nope", `banner noise\r\n${S}\tmissing\r\n`, false).path).toBeNull();
    const t = parseWhich(win, "slow", `${S}\tfound\tfile\tC:\\t\\slow.cmd\r\n${S}\tversion-timeout\r\n`, true);
    expect(t.version).toBeNull();
    expect(t.version_timeout).toBe(true);
  });
  test("ANSI colour in a version line is stripped", () => {
    const row = parseWhich(win, "x", `${S}\tfound\tfile\tC:\\x.exe\n${S}\tversion\t\x1b[32mx 1.0\x1b[0m\n`, true);
    expect(row.version).toBe("x 1.0");
  });
  test("no sentinel means no answer, not missing", () => {
    expect(parseWhich(win, "git", "", false)).toMatchObject({ ok: false, path: null, error: "no lookup result" });
  });
});

describe("whichRows", () => {
  const cfg = { hosts: { winbox: win, vps: lin, mac } } as unknown as FleetConfig; // fixture: only hosts are read
  const fake = (by: Record<string, Partial<ExecResult>>) => async (h: Host): Promise<ExecResult> =>
    ({ host: h.name, ok: true, code: 0, stdout: "", stderr: "", ...by[h.name] });

  test("one row per host; a failed host keeps an error row; JSON shape", async () => {
    const exec = fake({
      winbox: { stdout: `${S}\tfound\tfile\tC:\\bin\\rg.exe\r\n` },
      vps: { stdout: `${S}\tmissing\n` },
      mac: { ok: false, code: 255, stderr: "ssh: connect to host mac port 22: Connection refused\n" },
    });
    const { rows, skipped } = await whichRows(cfg, "all", "rg", {}, { exec });
    expect(skipped).toEqual([]);
    expect(JSON.parse(JSON.stringify(rows))).toEqual([
      { host: "winbox", os: "windows", ok: true, cmd: "rg", path: "C:\\bin\\rg.exe", kind: "file" },
      { host: "vps", os: "linux", ok: true, cmd: "rg", path: null },
      { host: "mac", os: "mac", ok: false, cmd: "rg", path: null, error: "ssh: connect to host mac port 22: Connection refused" },
    ]);
  });
  test("reachableOnly skips hosts that fail the probe and never execs them", async () => {
    const ran: string[] = [];
    const exec = async (h: Host): Promise<ExecResult> => { ran.push(h.name); return { host: h.name, ok: true, code: 0, stdout: `${S}\tmissing\n`, stderr: "" }; };
    const { rows, skipped } = await whichRows(cfg, "all", "rg", { reachableOnly: true }, { exec, probe: async (h) => h.name !== "mac" });
    expect(skipped).toEqual(["mac"]);
    expect(ran.sort()).toEqual(["vps", "winbox"]);
    expect(rows.map((r) => r.host)).toEqual(["winbox", "vps"]);
  });
  test("an invalid name is refused before any host is touched", async () => {
    let calls = 0;
    const exec = async (h: Host): Promise<ExecResult> => { calls++; return { host: h.name, ok: true, code: 0, stdout: "", stderr: "" }; };
    await expect(whichRows(cfg, "all", "a;b", {}, { exec })).rejects.toThrow(/plain program name/);
    expect(calls).toBe(0);
  });
});

describe("fleet which CLI", () => {
  const cli = join(import.meta.dir, "../src/cli.ts");
  async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const root = mkdtempSync(join(tmpdir(), "fleet-which-cli-"));
    const config = join(root, "fleet.config.json");
    // A host that cannot be reached: validation must fail before any route or ssh.
    writeFileSync(config, JSON.stringify({ hosts: { ghost: { ssh: "ghost.invalid", os: "linux" } } }));
    const p = Bun.spawn(["bun", cli, ...args], { env: { ...process.env, FLEET_CONFIG: config }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    rmSync(root, { recursive: true, force: true });
    return { code, stdout, stderr };
  }
  test("rejects a non-plain name before resolving targets", async () => {
    const r = await run(["which", "a;b", "ghost"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("plain program name");
  }, 20_000);
  test("rejects unknown options and missing <cmd>", async () => {
    const bad = await run(["which", "git", "--bogus"]);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toMatch(/--bogus/);
    const none = await run(["which"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("usage: fleet which <cmd>");
  }, 20_000);
  test("help is static", async () => {
    const r = await run(["help", "which"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: fleet which <cmd> [<sel>] [--version] [--json]");
    expect(r.stdout).toContain("Get-Command");
  }, 20_000);
});
