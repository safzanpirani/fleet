import { test, expect, describe } from "bun:test";
import { bashPathAssignment, buildArgs, scpRemotePath } from "../src/ssh.ts";
import type { Host } from "../src/config.ts";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const linux: Host = { name: "vps", ssh: "vps", os: "linux" };
const win: Host = { name: "maints", ssh: "maints", os: "windows" };

const decodeUtf16le = (b64: string) => Buffer.from(b64, "base64").toString("utf16le");
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
    expect(script).toContain("fleet_cwd='/srv/app'");
    expect(script).toContain('cd -- "$fleet_cwd"');
    expect(script).toContain("exit 127");                     // missing dir fails fast
    expect(script.endsWith("ls\n")).toBe(true);
    expect(args.join(" ")).not.toContain("/srv/app");
  });

  test("--cwd expands a leading home shorthand after safe assignment", () => {
    const built = buildArgs(linux, "pwd", "auto", "powershell", "~/app");
    const script = new TextDecoder().decode(built.stdin!);
    expect(script).toContain(`fleet_cwd='~/app'`);
    expect(script).toContain('fleet_cwd="$HOME/${fleet_cwd#\\~/}"');
    expect(script).toContain('cd -- "$fleet_cwd"');
  });

  test("single quotes in cwd are escaped", () => {
    const { stdin } = buildArgs(linux, "ls", "bash", "powershell", "/srv/o'brien");
    expect(new TextDecoder().decode(stdin!)).toContain(`fleet_cwd='/srv/o'\\''brien'`);
  });
});

describe("bashPathAssignment", () => {
  test("expands only a leading tilde and preserves quoted path bytes", () => {
    const script = bashPathAssignment("p", "~/a b/'c");
    expect(script).toContain(`p='~/a b/'\\''c'`);
    expect(script).toContain('p="$HOME/${p#\\~/}"');
  });

  test("the generated shell expands home shorthand", async () => {
    const proc = Bun.spawn(["bash"], {
      env: { ...process.env, HOME: "/tmp/fleet-home" },
      stdin: new TextEncoder().encode(bashPathAssignment("p", "~/app") + '\nprintf "%s\\n" "$p"\n'),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout).toBe("/tmp/fleet-home/app\n");
  });
});

describe("buildArgs — windows (program over stdin)", () => {
  test("native PowerShell command stays out of argv", () => {
    const { args, stdin } = buildArgs(win, NASTY, "powershell");
    expect(args.slice(-2)).toEqual(["-Command", "-"]);
    expect(args).toContain("-NonInteractive");
    expect(args.join(" ")).not.toContain("rm -rf");
    expect(new TextDecoder().decode(stdin!)).toBe(NASTY + "\n");
  });

  test("large scripts and secrets stay entirely in stdin", () => {
    const secret = "SECRET_SENTINEL_" + "x".repeat(40_000);
    const { args, stdin } = buildArgs(win, `Write-Output '${secret}'`, "powershell");
    expect(args.join(" ")).not.toContain("SECRET_SENTINEL");
    expect(new TextDecoder().decode(stdin!)).toContain(secret);
  });

  test("uses the chosen winBin", () =>
    expect(buildArgs(win, "x", "powershell", "pwsh").args).toContain("pwsh"));

  test("a configured pwsh host executes without Windows PowerShell discovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-ssh-test-"));
    try {
      const fakeSsh = join(dir, "ssh");
      writeFileSync(fakeSsh, `#!/bin/sh
case "$*" in
  *powershell*) exit 127 ;;
  *pwsh*) printf ok; exit 0 ;;
  *) exit 2 ;;
esac
`);
      chmodSync(fakeSsh, 0o755);
      const snippet = `
        import { exec } from "${import.meta.dir}/../src/ssh.ts";
        const result = await exec(
          { name: "win", ssh: "win", os: "windows", winShell: "pwsh" },
          "Write-Output ok",
        );
        console.log(JSON.stringify(result));
        process.exit(result.ok ? 0 : 1);
      `;
      const proc = Bun.spawn(["bun", "-e", snippet], {
        env: { ...process.env, PATH: dir + delimiter + (process.env.PATH ?? "") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout).stdout).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--cwd wraps with Set-Location -LiteralPath, quotes doubled", () => {
    const built = buildArgs(win, "dir", "powershell", "powershell", `C:\\o'brien`);
    const script = new TextDecoder().decode(built.stdin!);
    expect(script).toContain(`Set-Location -LiteralPath 'C:\\o''brien' -ErrorAction Stop`);
    expect(script).toContain("dir");
  });
});

describe("buildArgs — wsl (bash inside windows)", () => {
  test("keeps only a fixed WSL wrapper in argv and sends bash over stdin", () => {
    const built = buildArgs(win, "uname -a", "wsl");
    const inner = decodeUtf16le(valAfter(built.args, "-EncodedCommand"));
    expect(inner).toContain("wsl -d 'Ubuntu' -- bash -s");
    expect(built.args.join(" ")).not.toContain("uname -a");
    expect(new TextDecoder().decode(built.stdin!)).toBe("uname -a\n");
  });

  test("honors a custom wsl distro", () =>
    expect(decodeUtf16le(valAfter(buildArgs({ ...win, wsl: "Debian" }, "x", "wsl").args, "-EncodedCommand")))
      .toContain("wsl -d 'Debian'"));

  test("a hostile distro name is quoted for PowerShell", () =>
    expect(decodeUtf16le(valAfter(buildArgs({ ...win, wsl: "U'b; rm -rf /" }, "x", "wsl").args, "-EncodedCommand")))
      .toContain(`wsl -d 'U''b; rm -rf /'`));
});

describe("Windows scp paths", () => {
  test("normalizes only the remote side of Windows copies", () => {
    expect(scpRemotePath(win, "D:\\Downloads\\clip.mp4")).toBe("D:/Downloads/clip.mp4");
    expect(scpRemotePath(win, "C:/Windows/win.ini")).toBe("C:/Windows/win.ini");
    expect(scpRemotePath(linux, String.raw`dir\literal`)).toBe(String.raw`dir\literal`);
  });
});

describe("stripClixml", () => {
  const { stripClixml } = require("../src/ssh.ts");
  const blob = `#< CLIXML
<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj><S S="Error">boom : oops_x000D__x000A_</S><S S="Error">    + CategoryInfo &lt;none&gt;_x000D__x000A_</S></Objs>`;
  test("decodes Error stream, drops progress records", () => {
    const out = stripClixml(blob);
    expect(out).toContain("boom : oops");
    expect(out).toContain("<none>");
    expect(out).not.toContain("CLIXML");
    expect(out).not.toContain("Preparing modules");
  });
  test("passes non-CLIXML stderr through untouched", () => {
    expect(stripClixml("plain error text")).toBe("plain error text");
  });
});

describe("probe deadline cleanup", () => {
  test("a successful fast probe clears its long timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-probe-test-"));
    try {
      const fakeSsh = join(dir, "ssh");
      writeFileSync(fakeSsh, "#!/bin/sh\nprintf ok\n");
      chmodSync(fakeSsh, 0o755);
      const snippet = `
        import { probe } from "${import.meta.dir}/../src/ssh.ts";
        const start = performance.now();
        const ok = await probe({ name: "h", ssh: "h", os: "linux" }, 1500);
        console.log(JSON.stringify({ ok, elapsed: performance.now() - start }));
      `;
      const started = performance.now();
      const proc = Bun.spawn(["bun", "-e", snippet], {
        env: { ...process.env, PATH: dir + delimiter + (process.env.PATH ?? "") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout).ok).toBe(true);
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed ssh process cannot claim reachability by printing 'not ok'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-probe-fail-"));
    try {
      const fakeSsh = join(dir, "ssh");
      writeFileSync(fakeSsh, "#!/bin/sh\nprintf 'not ok\\n'\nexit 255\n");
      chmodSync(fakeSsh, 0o755);
      const snippet = `
        import { probe } from "${import.meta.dir}/../src/ssh.ts";
        console.log(await probe({ name: "h", ssh: "h", os: "linux" }, 1000));
      `;
      const proc = Bun.spawn(["bun", "-e", snippet], {
        env: { ...process.env, PATH: dir + delimiter + (process.env.PATH ?? "") },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exec timeout includes Windows shell discovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-win-deadline-"));
    try {
      const fakeSsh = join(dir, "ssh");
      writeFileSync(fakeSsh, "#!/bin/sh\nexec sleep 2\n");
      chmodSync(fakeSsh, 0o755);
      const snippet = `
        import { exec } from "${import.meta.dir}/../src/ssh.ts";
        const result = await exec(
          { name: "win", ssh: "win", os: "windows" },
          "Write-Output late",
          "auto",
          { timeoutMs: 60 },
        );
        console.log(JSON.stringify(result));
      `;
      const started = performance.now();
      const proc = Bun.spawn(["bun", "-e", snippet], {
        env: { ...process.env, PATH: dir + delimiter + (process.env.PATH ?? "") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout).code).toBe(124);
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
