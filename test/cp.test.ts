import { test, expect, describe } from "bun:test";
import { parseRemoteSpec, pushFile } from "../src/core.ts";
import { rsyncRemotePath } from "../src/ssh.ts";
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

describe("pushFile creates a trailing-slash destination", () => {
  const ok = (h: string) => ({ host: h, ok: true, code: 0, stdout: "", stderr: "" });
  const capture = () => {
    const mkdirs: { host: string; cmd: string }[] = [];
    const copies: string[] = [];
    return {
      mkdirs, copies,
      deps: {
        exec: async (h: Host, cmd: string) => { mkdirs.push({ host: h.name, cmd }); return ok(h.name); },
        scp: async (h: Host, _l: string | string[], remote: string) => { copies.push(`${h.name}:${remote}`); return ok(h.name); },
      } as any,
    };
  };

  test("Windows never uses New-Item -LiteralPath, which does not exist on it", async () => {
    // The bug: `New-Item` has no -LiteralPath parameter in any PowerShell
    // version, so EVERY Windows trailing-slash destination failed with
    // "A parameter cannot be found that matches parameter name 'LiteralPath'"
    // — tilde and absolute paths alike, not just `~/dir/` as first reported.
    const c = capture();
    await pushFile(cfg, "/tmp/a.txt", "winbox", "~/out/", false, c.deps);
    expect(c.mkdirs).toHaveLength(1);
    expect(c.mkdirs[0]!.cmd).not.toContain("-LiteralPath");
    expect(c.mkdirs[0]!.cmd).not.toContain("New-Item");
  });

  test("Windows resolves the path literally, so brackets are not globbed", async () => {
    const c = capture();
    await pushFile(cfg, "/tmp/a.txt", "winbox", "C:/Users/Admin/a[1]/", false, c.deps);
    const cmd = c.mkdirs[0]!.cmd;
    // -Path would treat [1] as a wildcard and match nothing; the session's
    // unresolved-provider-path resolver handles ~ and relatives without globbing.
    expect(cmd).toContain("GetUnresolvedProviderPathFromPSPath");
    expect(cmd).toContain("System.IO.Directory]::CreateDirectory");
    expect(cmd).toContain("a[1]/");
  });

  test("a single quote in the destination cannot break out of the literal", async () => {
    const c = capture();
    await pushFile(cfg, "/tmp/a.txt", "winbox", "C:/tmp/it's/", false, c.deps);
    expect(c.mkdirs[0]!.cmd).toContain("it''s");
  });

  test("posix hosts still get mkdir -p through the quoting-proof assignment", async () => {
    const c = capture();
    await pushFile(cfg, "/tmp/a.txt", "web", "~/out/", false, c.deps);
    expect(c.mkdirs[0]!.cmd).toContain("mkdir -p --");
  });

  test("no trailing slash means no directory is created", async () => {
    const c = capture();
    await pushFile(cfg, "/tmp/a.txt", "winbox", "C:/Users/Admin/a.txt", false, c.deps);
    expect(c.mkdirs).toEqual([]);
    expect(c.copies).toEqual(["winbox:C:/Users/Admin/a.txt"]);
  });

  test("a bare root is not treated as a directory to create", async () => {
    const c = capture();
    await pushFile(cfg, "/tmp/a.txt", "web", "/", false, c.deps);
    expect(c.mkdirs).toEqual([]);
  });

  test("a failed mkdir names the directory and skips the copy", async () => {
    const copies: string[] = [];
    const [r] = await pushFile(cfg, "/tmp/a.txt", "winbox", "~/out/", false, {
      exec: async (h: Host) => ({ host: h.name, ok: false, code: 1, stdout: "", stderr: "denied" }),
      scp: async (h: Host, _l: unknown, remote: string) => { copies.push(remote); return ok(h.name); },
    } as any);
    expect(r!.ok).toBe(false);
    expect(r!.stderr).toContain("could not create destination directory ~/out/");
    expect(r!.stderr).toContain("denied");
    expect(copies).toEqual([]);
  });
});

describe("cp --resume", () => {
  test("remote rsync paths drop ~/ and quote only for openrsync's shell parsing", () => {
    expect(rsyncRemotePath("~/a b/it's", "gnu")).toBe("a b/it's");
    expect(rsyncRemotePath("~/a b/it's", "openrsync")).toBe(`'a b/it'\\''s'`);
    expect(rsyncRemotePath("~", "gnu")).toBe(".");
    expect(rsyncRemotePath("/srv/x", "openrsync")).toBe("'/srv/x'");
  });

  test("pushFile hands resume to the copier and skips the Windows mkdir it will refuse", async () => {
    const seen: unknown[] = [];
    const mkdirs: string[] = [];
    const deps = {
      exec: async (h: Host) => { mkdirs.push(h.name); return { host: h.name, ok: true, code: 0, stdout: "", stderr: "" }; },
      scp: async (h: Host, _l: string | string[], _r: string, _rec: boolean, opts: unknown) => {
        seen.push(opts); return { host: h.name, ok: true, code: 0, stdout: "", stderr: "" };
      },
      resume: true,
    } as any;
    await pushFile(cfg, "/tmp/a", "web,winbox", "~/out/", false, deps);
    expect(seen).toEqual([{ resume: true, progress: undefined }, { resume: true, progress: undefined }]);
    expect(mkdirs).toEqual(["web"]);
  });
});
