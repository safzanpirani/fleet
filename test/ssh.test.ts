import { test, expect, describe } from "bun:test";
import { buildArgs } from "../src/ssh.ts";
import type { Host } from "../src/config.ts";

const linux: Host = { name: "vps", ssh: "vps", os: "linux" };
const win: Host = { name: "winbox", ssh: "winbox", os: "windows" };

const decodeUtf16le = (b64: string) => Buffer.from(b64, "base64").toString("utf16le");
const decodeUtf8 = (b64: string) => Buffer.from(b64, "base64").toString("utf8");
// pull the value passed to a flag in an argv array
const valAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;

// The whole point of fleet: nasty characters must NEVER appear unescaped on the
// ssh command line — they ride inside a base64 blob (windows) or stdin (linux).
const NASTY = `echo "a & b | c"; rm -rf $HOME && printf '%q\\n' 'x'`;

describe("buildArgs — linux (bash over stdin)", () => {
  test("command goes to stdin, not the argv", () => {
    const { args, stdin } = buildArgs(linux, NASTY, "bash");
    expect(args[0]).toBe("ssh");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ConnectTimeout=15");
    expect(args.slice(-3)).toEqual(["vps", "bash", "-ls"]);
    expect(args.join(" ")).not.toContain("rm -rf");          // nothing leaks onto the command line
    expect(new TextDecoder().decode(stdin!)).toBe(NASTY + "\n");
  });

  test("ssh argv enables connection multiplexing by default", () => {
    const { args } = buildArgs(linux, "true", "bash");
    expect(args).toContain("ControlMaster=auto");
    expect(args.some((a) => a.startsWith("ControlPath="))).toBe(true);
    expect(args).toContain("ControlPersist=60s");
    // control options come before the host/command, never replacing them
    expect(args.slice(-2)).toEqual(["bash", "-ls"]);
  });

  // FLEET_NO_SSH_MUX is read once at module load, so verify via a subprocess.
  test("FLEET_NO_SSH_MUX=1 disables multiplexing", async () => {
    const snippet = `
      import { buildArgs } from "${import.meta.dir}/../src/ssh.ts";
      const { args } = buildArgs({ name: "h", ssh: "h", os: "linux" }, "true", "bash");
      console.log(args.includes("ControlMaster=auto") ? "MUX" : "NOMUX");
    `;
    const proc = Bun.spawn(["bun", "-e", snippet], {
      env: { ...process.env, FLEET_NO_SSH_MUX: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(out).toBe("NOMUX");
  });

  test("--cwd prepends a fail-fast cd, still only via stdin", () => {
    const { args, stdin } = buildArgs(linux, "ls", "bash", "powershell", "/srv/app");
    const script = new TextDecoder().decode(stdin!);
    expect(script).toContain("cd -- '/srv/app'");
    expect(script).toContain("exit 127");                     // missing dir fails fast
    expect(script.endsWith("ls\n")).toBe(true);
    expect(args.join(" ")).not.toContain("/srv/app");
  });

  test("single quotes in cwd are escaped", () => {
    const { stdin } = buildArgs(linux, "ls", "bash", "powershell", "/srv/o'brien");
    expect(new TextDecoder().decode(stdin!)).toContain(`cd -- '/srv/o'\\''brien'`);
  });
});

describe("buildArgs — windows (PowerShell EncodedCommand)", () => {
  test("command is base64'd UTF-16LE, no stdin", () => {
    const { args, stdin } = buildArgs(win, NASTY, "powershell");
    expect(stdin).toBeUndefined();
    expect(args).toContain("-EncodedCommand");
    expect(args).toContain("-NonInteractive");
    expect(decodeUtf16le(valAfter(args, "-EncodedCommand"))).toBe(NASTY);
    expect(args.join(" ")).not.toContain("rm -rf");
  });

  test("uses the chosen winBin", () =>
    expect(buildArgs(win, "x", "powershell", "pwsh").args).toContain("pwsh"));

  test("--cwd wraps with Set-Location -LiteralPath, quotes doubled", () => {
    const enc = decodeUtf16le(valAfter(buildArgs(win, "dir", "powershell", "powershell", `C:\\o'brien`).args, "-EncodedCommand"));
    expect(enc).toContain(`Set-Location -LiteralPath 'C:\\o''brien' -ErrorAction Stop`);
    expect(enc).toContain("dir");
  });
});

describe("buildArgs — wsl (bash inside windows)", () => {
  test("wraps the bash script base64'd inside a wsl invocation", () => {
    const inner = decodeUtf16le(valAfter(buildArgs(win, "uname -a", "wsl").args, "-EncodedCommand"));
    expect(inner).toContain("wsl -d 'Ubuntu'");
    const m = inner.match(/echo (\S+) \| base64 -d \| bash/);
    expect(m).not.toBeNull();
    expect(decodeUtf8(m![1]!)).toBe("uname -a");
  });

  test("honors a custom wsl distro", () =>
    expect(decodeUtf16le(valAfter(buildArgs({ ...win, wsl: "Debian" }, "x", "wsl").args, "-EncodedCommand")))
      .toContain("wsl -d 'Debian'"));

  test("a hostile distro name is quoted for PowerShell", () =>
    expect(decodeUtf16le(valAfter(buildArgs({ ...win, wsl: "U'b; rm -rf /" }, "x", "wsl").args, "-EncodedCommand")))
      .toContain(`wsl -d 'U''b; rm -rf /'`));
});
