import { describe, expect, test } from "bun:test";
import { completionScript, trailingFleetFlag } from "../src/cli.ts";
import type { FleetConfig } from "../src/config.ts";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { cuaFixture } from "./helpers/cua-driver.ts";

const cli = join(import.meta.dir, "../src/cli.ts");

function fixture(): { root: string; bin: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), "fleet-cli-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const config = join(root, "fleet.config.json");
  writeFileSync(config, JSON.stringify({
    hosts: { local: { ssh: "local", os: "linux" } },
  }));
  return { root, bin, config };
}

function executable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

async function runCli(
  args: string[],
  config: string,
  bin?: string,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bun", cli, ...args], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      FLEET_CONFIG: config,
      ...(bin ? { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` } : {}),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const deadline = setTimeout(() => proc.kill("SIGKILL"), 5000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(deadline);
  return { stdout, stderr, code };
}

describe("machine-readable CLI output", () => {
  test("named pointer and keyboard controls and file batches work through the CLI", async () => {
    const fixture = await cuaFixture();
    const env = { CUA_FIXTURE_ROOT: fixture.root, TMPDIR: fixture.root };
    try {
      const commands = [
        ["drag", "Fixture", "120", "240", "300", "400", "--space", "screen", "--duration", "50"],
        ["right-click", "Fixture", "10", "20"], ["double-click", "Fixture", "10", "20"],
        ["scroll", "Fixture", "down", "2", "--by", "page"],
        ["hotkey", "Fixture", "ctrl", "a"],
      ];
      for (const args of commands) {
        const result = await runCli(["cu", "local", ...args, "--settle", "0", "--json"], fixture.config, fixture.bin, env);
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).result.ok).toBe(true);
      }
      const events = await fixture.read("events");
      expect(events.map((e: any) => e.tool)).toEqual(["drag", "right_click", "double_click", "scroll", "hotkey"]);
      expect(events[0].payload).toMatchObject({ from_x: 10, from_y: 20, to_x: 100, to_y: 100, duration_ms: 50 });
      expect(events[3].payload).toMatchObject({ direction: "down", amount: 2, by: "page" });
      expect(events[4].payload.keys).toEqual(["ctrl", "a"]);
      const batchFile = join(fixture.root, "batch.json");
      writeFileSync(batchFile, JSON.stringify([{ tool: "type_text", args: { text: "fixture text" } }, { tool: "press_key", args: { key: "Tab" } }]));
      const batch = await runCli(["cu", "local", "batch", "Fixture", "--file", batchFile, "--settle", "0", "--json"], fixture.config, fixture.bin, env);
      expect(batch.code, batch.stderr).toBe(0);
      expect(JSON.parse(batch.stdout).actions.map((a: any) => a.status)).toEqual(["completed", "completed"]);
      const raw = await runCli(["cu", "local", "drag", '{"pid":42,"window_id":7,"from_x":1,"from_y":2,"to_x":3,"to_y":4}'], fixture.config, fixture.bin, env);
      expect(raw.code, raw.stderr).toBe(0);
      expect(raw.stdout).toContain("reply drag");
      expect((await fixture.read("events")).at(-1).payload.to_x).toBe(3);
    } finally { await fixture.cleanup(); }
  }, 15_000);

  test("exec and spawn accept a separator after the selector and preserve remote flags", async () => {
    const { root, bin, config } = fixture();
    writeFileSync(config, JSON.stringify({ hosts: { local: { ssh: "local", os: "mac" } } }));
    executable(join(bin, "ssh"), "#!/bin/sh\nexec /bin/bash -s\n");
    try {
      const result = await runCli(["exec", "--raw", "local", "--", "printf", "'%s\\n'", "--json"], config, bin);
      expect(result).toEqual({ code: 0, stdout: "--json\n", stderr: "" });
      const nested = await runCli(["exec", "--raw", "local", "--", "printf '%s\\n' --help --"], config, bin);
      expect(nested).toEqual({ code: 0, stdout: "--help\n--\n", stderr: "" });
      const spawned = await runCli(["spawn", "--json", "local", "--", "printf", "'%s\\n'", "--json"], config, bin, { HOME: root });
      expect(spawned.code, spawned.stderr).toBe(0);
      const [{ id }] = JSON.parse(spawned.stdout);
      const waited = await runCli(["jobs", "wait", `local:${id}`, "--timeout", "5", "--json"], config, bin, { HOME: root });
      expect(waited.code, waited.stderr).toBe(0);
      expect(await Bun.file(join(root, ".fleet/jobs", id, "out")).text()).toBe("--json\n");
      for (const command of ["exec", "spawn"]) {
        const empty = await runCli([command, "local", "--"], config, bin);
        expect(empty.code).toBe(1);
        expect(empty.stderr).toContain("usage:");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("raw cu click JSON remains a driver passthrough", async () => {
    const { root, bin, config } = fixture();
    executable(join(bin, "ssh"), "#!/bin/sh\ncat\n");
    try {
      const args = '{"pid":42,"window_id":7,"x":12,"y":34}';
      const result = await runCli(["cu", "local", "click", args], config, bin);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(args);
      expect(result.stdout).not.toContain("list_apps");
      expect(result.stdout).not.toContain("__FLEET_HASH__");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("help works without config and never starts SSH", async () => {
    const { root, bin } = fixture();
    try {
      const marker = join(root, "ssh-called");
      executable(join(bin, "ssh"), `#!/bin/sh\ntouch '${marker}'\nexit 99\n`);
      for (const args of [["--help"], ["exec", "--help"], ["spawn", "--help"], ["jobs", "--help"],
        ["jobs", "wait", "--help"], ["tools", "sync", "--help"], ["help", "jobs", "tail"]]) {
        const r = await runCli(args, join(root, "absent-config"), bin);
        expect(r.code, r.stderr).toBe(0);
        expect(r.stdout).toContain("fleet");
        expect(r.stderr).toBe("");
      }
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("exec payload help remains a remote argument", async () => {
    const { root, bin, config } = fixture();
    try {
      executable(join(bin, "ssh"), "#!/bin/sh\ncat\n");
      const r = await runCli(["exec", "--raw", "local", "demo", "--help"], config, bin);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain("demo --help");
      expect(r.stdout).not.toContain("Usage:");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("raw command and script failures expose stderr without contaminating stdout", async () => {
    const { root, bin, config } = fixture();
    try {
      executable(join(bin, "ssh"), "#!/bin/sh\ncat >/dev/null\nprintf 'partial  \\n'\nprintf 'permission denied\\n' >&2\nexit 7\n");
      const script = join(root, "task.sh");
      writeFileSync(script, "true\n");
      for (const args of [["exec", "--raw", "local", "ignored"], ["exec", "--raw", "--script", script, "local"]]) {
        const r = await runCli(args, config, bin);
        expect(r.code).toBe(1);
        expect(r.stdout).toBe("partial  \n");
        expect(r.stderr).toBe("permission denied\n");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("jobs list and tail aliases produce JSON", async () => {
    const { root, bin, config } = fixture();
    try {
      executable(join(bin, "ssh"), "#!/bin/sh\ncat >/dev/null\nprintf 'sample\\texited\\t7\\t123\\t100\\techo demo\\n'\n");
      const list = await runCli(["jobs", "list", "local", "--json"], config, bin);
      expect(list.code, list.stderr).toBe(0);
      expect(JSON.parse(list.stdout)[0]).toMatchObject({ host: "local", id: "sample", code: 7 });
      executable(join(bin, "ssh"), "#!/bin/sh\ncat >/dev/null\nprintf 'last line\\n'\n");
      for (const ref of [["local:sample"], ["local", "sample"]]) {
        const tail = await runCli(["jobs", "tail", ...ref, "--lines", "1", "--json"], config, bin);
        expect(tail.code, tail.stderr).toBe(0);
        expect(JSON.parse(tail.stdout)).toEqual({ host: "local", output: "last line\n" });
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("invalid job and tool options fail before SSH", async () => {
    const { root, bin, config } = fixture();
    try {
      const marker = join(root, "ssh-called");
      executable(join(bin, "ssh"), `#!/bin/sh\ntouch '${marker}'\nexit 99\n`);
      const cases = [
        ["jobs", "tail", "local:sample", "--line", "1"],
        ["jobs", "tail", "local:sample", "--lines"],
        ["jobs", "tail", "local:sample", "--lines", "1", "-n", "2"],
        ["jobs", "tail", "local:sample", "--follow", "--json"],
        ["jobs", "wait", "local:sample", "--timeout"],
        ["jobs", "wait", "local:sample", "--timeout", "--json"],
        ["jobs", "wait", "local:sample", "--timeout", "NaN"],
        ["jobs", "wait", "local:sample", "--timeout", "0.5"],
        ["jobs", "log", "local:sample", "extra"],
        ["jobs", "list", "local", "extra"],
        ["jobs", "kill", "local:sample", "--all"],
        ["tools", "status", "--typo"],
        ["tools", "sync", "--max-parallel"],
        ["exec", "--raw", "--json", "local", "true"],
        ["exec", "--timeout", "0.1", "local", "true"],
      ];
      for (const args of cases) {
        const r = await runCli(args, config, bin);
        expect(r.code, args.join(" ")).toBe(1);
        expect(r.stderr).not.toBe("");
        expect(r.stdout).toBe("");
      }
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("invalid non-passthrough options fail before SSH or copying", async () => {
    const { root, bin, config } = fixture();
    try {
      const marker = join(root, "remote-called");
      for (const command of ["ssh", "scp"])
        executable(join(bin, command), `#!/bin/sh\ntouch '${marker}'\nexit 99\n`);
      const cases = [
        ["edit", "local:/fixture", "--old", "before", "--new"],
        ["edit", "local:/fixture", "--old", "before", "--new", "after", "--dryrun"],
        ["edit", "local:/fixture", "--old", "before", "--new", "--json"],
        ["edit", "local:/fixture", "extra", "--old", "before"],
        ["deploy", "local", "--no-restartt"],
        ["deploy", "local", "--restart"],
        ["deploy", "local", "--no-restart", "extra"],
        ["restart", "local", "demo", "--dry-run"],
        ["reboot", "local", "--yes", "--dry-run"],
        ["bios", "local", "--yes", "extra"],
        ["switch", "local", "--to", "linux", "--yes", "--nowait"],
        ["switch", "local", "--to", "linux", "--yes", "--timeout"],
        ["switch", "local", "--to", "linux", "--yes", "--timeout", "0.5"],
        ["switch", "local", "--to", "linux", "--yes", "extra"],
        ["wait", "local", "--timout", "1"],
        ["wait", "local", "--timeout", "1", "--timeout", "2"],
        ["wait", "local", "--timeout", "0.5"],
        ["wait", "local", "--port", "0"],
        ["wait", "local", "--port", "65536"],
        ["wait", "local", "extra"],
        ["shot", "local", "--out"],
        ["shot", "local", "--grid-step", "0.5"],
        ["shot", "local", "--noopen"],
        ["screenshot", "local", "extra"],
        ["cu", "local", "shot-window", "1", "--out"],
        ["cp", "local:/fixture", "./fixture", "--recusive"],
        ["logs", "local", "demo", "-n"],
        ["logs", "local", "demo", "extra"],
        ["svc", "demo", "local", "--jso"],
        ["ls", "--json", "extra"],
        ["dt", "extra"],
        ["gpu", "--jso"],
        ["disk", "local", "extra"],
        ["status", "local", "--jso"],
        ["top", "local", "extra"],
        ["boot", "local", "--jso"],
        ["browse", "local", "--url", "http://fixture.invalid"],
        ["doctor", "local", "extra"],
        ["ssh", "local", "extra"],
        ["run", "fixture", "extra"],
        ["completion", "bash", "extra"],
      ];
      for (const args of cases) {
        const result = await runCli(args, config, bin);
        expect(result.code, args.join(" ")).toBe(1);
        expect(result.stderr, args.join(" ")).not.toBe("");
        expect(result.stdout, args.join(" ")).toBe("");
      }
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  test("edit distinguishes missing replacement values and preserves literal replacement bytes", async () => {
    const { root, bin, config } = fixture();
    try {
      executable(join(bin, "ssh"), "#!/bin/sh\nexec /bin/bash -s\n");
      const target = join(root, "target.txt");
      await Bun.write(target, "before\n");
      const missing = await runCli(["edit", `local:${target}`, "--old", "before", "--new"], config, bin);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("--new requires a value");
      expect(await Bun.file(target).text()).toBe("before\n");
      const cases: { before: string; args: string[]; after: string }[] = [
        { before: "before\n", args: ["--old", "before", "--new", "$&"], after: "$&\n" },
        { before: "before before\n", args: ["--all", "--old", "before", "--new", "$&"], after: "$& $&\n" },
        { before: "before\n", args: ["--old", "before"], after: "\n" },
        { before: "before\n", args: ["--old", "before", "--new", ""], after: "\n" },
        { before: "before\n", args: ["--old", "before", "--new="], after: "\n" },
        { before: "before\n", args: ["--old", "before", "--new=--json"], after: "--json\n" },
        { before: "--json\n", args: ["--old=--json", "--new", "after"], after: "after\n" },
      ];
      for (const { before, args, after } of cases) {
        await Bun.write(target, before);
        const result = await runCli(["edit", `local:${target}`, ...args, "--json"], config, bin);
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)[0].ok).toBe(true);
        expect(await Bun.file(target).text()).toBe(after);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("tools sync validates equals-form concurrency instead of dropping it", async () => {
    const { root, bin, config } = fixture();
    try {
      const marker = join(root, "ssh-called");
      executable(join(bin, "ssh"), `#!/bin/sh\ntouch '${marker}'\nexit 99\n`);
      writeFileSync(config, JSON.stringify({
        hosts: { local: { ssh: "local", os: "linux" } },
        tools: { demo: { root, hosts: "local" } },
      }));
      const result = await runCli(["tools", "sync", "demo", "local", "--max-parallel=2", "--json"], config, bin);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--max-parallel");
      const missingSelector = await runCli(["tools", "sync", "--all", "--json"], config, bin);
      expect(missingSelector.code).toBe(1);
      expect(missingSelector.stderr).toContain("needs a selector");
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("Windows image commands fail when SSH succeeds without producing an artifact", async () => {
    const { root, bin, config } = fixture();
    try {
      writeFileSync(config, JSON.stringify({
        hosts: { local: { ssh: "local", os: "windows", winShell: "powershell" } },
      }));
      // shot-window resolves the target first, so the stub answers the snapshot
      // round trip and then produces no capture — the case the assertion is about.
      const snapshot = '{"apps":[{"name":"Demo","pid":1,"active":true}]}\\n__FLEET_SEP__\\n'
        + '{"windows":[{"window_id":7,"pid":1,"title":"Demo","app_name":"demo.exe",'
        + '"bounds":{"x":0,"y":0,"width":800,"height":600},"is_on_screen":true,'
        + '"minimized":false,"z_index":3}]}\\n__FLEET_SEP__\\n{"max_image_dimension":1568}\\n';
      // Windows programs travel base64-encoded inside fleet's wrapper; the stub
      // decodes them the way pwsh does before deciding what to answer.
      executable(join(bin, "ssh"),
        "#!/bin/sh\nraw=$(cat)\n"
        + "b64=$(printf '%s' \"$raw\" | sed -n \"s/.*FromBase64String('\\([^']*\\)').*/\\1/p\" | head -n 1)\n"
        + "script=$(printf '%s' \"$b64\" | base64 -d 2>/dev/null)\n"
        + "case \"$script\" in\n"
        + `  *list_apps*) printf '${snapshot}' ;;\n`
        + "  *) printf 'driver completed without output\\n' ;;\nesac\n");
      const copied = join(root, "scp-called");
      executable(join(bin, "scp"), `#!/bin/sh\ntouch '${copied}'\nexit 0\n`);
      const image = join(root, "capture.png");
      for (const args of [["shot-window", "1"], ["get_window_state", '{"pid":1,"window_id":1}']]) {
        const result = await runCli(["cu", "local", ...args, "--out", image, "--no-open"], config, bin);
        expect(result.code, result.stdout).toBe(1);
        expect(result.stderr).toContain("produced no requested");
        expect(await Bun.file(image).exists()).toBe(false);
      }
      expect(await Bun.file(copied).exists()).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("tools status fails for missing and unreachable installations", async () => {
    const { root, bin, config } = fixture();
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));
      writeFileSync(config, JSON.stringify({ hosts: { local: { ssh: "local", os: "linux" } }, tools: { demo: { root, hosts: "local" } } }));
      for (const [script, state] of [
        ["#!/bin/sh\ncat >/dev/null\nexit 0\n", "missing"],
        ["#!/bin/sh\ncat >/dev/null\necho unavailable >&2\nexit 255\n", "unreachable"],
      ]) {
        executable(join(bin, "ssh"), script!);
        const r = await runCli(["tools", "status", "demo", "local", "--json"], config, bin);
        expect(r.code, r.stderr).toBe(1);
        expect(JSON.parse(r.stdout)[0].state).toBe(state);
      }
      const list = await runCli(["tools", "list", "--json"], config, bin);
      expect(list.code, list.stderr).toBe(0);
      expect(JSON.parse(list.stdout)[0].name).toBe("demo");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("jobs wait bounds a real SSH subprocess that ignores SIGTERM", async () => {
    const { root, bin, config } = fixture();
    try {
      executable(join(bin, "ssh"), `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`);
      const start = Date.now();
      const r = await runCli(["jobs", "wait", "local:sample", "--timeout", "1", "--json"], config, bin);
      expect(r.code, r.stderr).toBe(124);
      expect(JSON.parse(r.stdout).outcome).toBe("timeout");
      expect(Date.now() - start).toBeLessThan(3000);
      expect(r.stdout).not.toContain("\u001b[");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("an explicit zero exec timeout overrides the environment default", async () => {
    const { root, bin, config } = fixture();
    try {
      executable(join(bin, "ssh"), `#!${process.execPath}\nawait Bun.sleep(150);\nconsole.log('done');\n`);
      const env = { FLEET_EXEC_TIMEOUT: "0.05" };
      const capped = await runCli(["exec", "--raw", "local", "ignored"], config, bin, env);
      expect(capped.code).toBe(1);
      expect(capped.stderr).toContain("timed out");
      const uncapped = await runCli(["exec", "--timeout", "0", "--raw", "local", "ignored"], config, bin, env);
      expect(uncapped.code, uncapped.stderr).toBe(0);
      expect(uncapped.stdout).toBe("done\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("interrupting the CLI observer leaves a detached job available for a new wait", async () => {
    const { root, bin, config } = fixture();
    let observer: ReturnType<typeof Bun.spawn> | undefined;
    let id: string | undefined;
    try {
      writeFileSync(config, JSON.stringify({ hosts: { local: { ssh: "local", os: "mac" } } }));
      executable(join(bin, "ssh"), `#!/bin/sh\nexport HOME='${root}'\nscript=$(cat)\ncase "$script" in *'echo DEAD'*) touch "$HOME/polled";; esac\nprintf '%s' "$script" | /bin/bash -s\n`);
      const launched = await runCli(["spawn", "--json", "local",
        'for i in {1..100}; do [ -f "$HOME/release" ] && break; sleep 0.05; done; printf done; exit 7'], config, bin);
      expect(launched.code, launched.stderr).toBe(0);
      id = JSON.parse(launched.stdout)[0].id;
      observer = Bun.spawn([process.execPath, cli, "jobs", "wait", `local:${id}`, "--timeout", "10", "--json"], {
        env: { ...process.env, FLEET_CONFIG: config, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
        stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      for (let i = 0; i < 100 && !await Bun.file(join(root, "polled")).exists(); i++) await Bun.sleep(10);
      expect(await Bun.file(join(root, "polled")).exists()).toBe(true);
      observer.kill("SIGINT");
      await observer.exited;
      expect(await Bun.file(join(root, ".fleet", "jobs", id!, "exit")).exists()).toBe(false);
      writeFileSync(join(root, "release"), "");
      const resumed = await runCli(["jobs", "wait", `local:${id}`, "--timeout", "4", "--json"], config, bin);
      expect(resumed.code, resumed.stderr).toBe(7);
      expect(JSON.parse(resumed.stdout)).toMatchObject({ outcome: "exited", code: 7 });
    } finally {
      observer?.kill("SIGKILL");
      if (observer) await observer.exited;
      writeFileSync(join(root, "release"), "");
      if (id) for (let i = 0; i < 100 && !Bun.file(join(root, ".fleet", "jobs", id, "exit")).size; i++) await Bun.sleep(10);
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("exec --raw preserves trailing spaces and newlines exactly", async () => {
    const { root, bin, config } = fixture();
    try {
      executable(join(bin, "ssh"), "#!/bin/sh\ncat >/dev/null\nprintf 'a  \\n\\n'\n");
      const result = await runCli(["exec", "--raw", "local", "ignored"], config, bin);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("a  \n\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exec --raw flushes output larger than the process pipe buffer", async () => {
    const { root, bin, config } = fixture();
    try {
      executable(join(bin, "ssh"), "#!/bin/sh\ncat >/dev/null\ndd if=/dev/zero bs=1000000 count=1 2>/dev/null | tr '\\000' x\n");
      const result = await runCli(["exec", "--raw", "local", "ignored"], config, bin);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.length).toBe(1_000_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exec rejects --interp without --script", async () => {
    const { root, config } = fixture();
    try {
      const result = await runCli(["exec", "--interp", "bash", "local", "echo ok"], config);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--interp requires --script");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("spawn rejects Fleet flags after the selector", async () => {
    const { root, config } = fixture();
    try {
      const result = await runCli(["spawn", "local", "--cwd", "/tmp", "echo ok"], config);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("must come BEFORE the host selector");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tools status rejects an unknown tool when a selector follows it", async () => {
    const { root, config } = fixture();
    try {
      writeFileSync(config, JSON.stringify({
        hosts: { local: { ssh: "local", os: "linux" } },
        tools: { demo: { root } },
      }));
      const result = await runCli(["tools", "status", "deja", "local"], config);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("unknown tool 'deja'");
      expect(result.stderr).toContain("demo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("wait --json keeps progress off stdout", async () => {
    const { root, config } = fixture();
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const result = await runCli([
        "wait", "probe", "--http", `http://127.0.0.1:${server.port}`,
        "--timeout", "1", "--interval", "1", "--json",
      ], config);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).ok).toBe(true);
      expect(result.stdout).not.toContain("◎");
      expect(result.stdout).not.toContain("\u001b[");
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("jobs wait --json keeps terminal clearing off stdout", async () => {
    const { root, bin, config } = fixture();
    try {
      executable(join(bin, "ssh"), "#!/bin/sh\ncat >/dev/null\nprintf 'EXIT:0\\n'\n");
      const result = await runCli(["jobs", "wait", "local:done-job", "--json"], config, bin);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "exited", code: 0 });
      expect(result.stdout).not.toContain("\u001b[");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("deploy --json emits one JSON value", async () => {
    const { root, bin, config } = fixture();
    try {
      executable(join(bin, "scp"), "#!/bin/sh\nexit 0\n");
      executable(join(bin, "ssh"), "#!/bin/sh\ncat >/dev/null\nprintf 'deployed\\n'\n");
      const result = await runCli(["deploy", "local", "--no-restart", "--json"], config, bin);
      expect(result.code, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout) as Array<{ ok: boolean }>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.ok).toBe(true);
      expect(result.stdout).not.toContain("◎");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("svc --json exits nonzero when a service is down", async () => {
    const { root, bin, config } = fixture();
    try {
      writeFileSync(config, JSON.stringify({
        hosts: {
          local: {
            ssh: "local", os: "linux",
            services: { demo: { type: "systemd", name: "demo" } },
          },
        },
      }));
      executable(join(bin, "ssh"), "#!/bin/sh\ncat >/dev/null\nprintf inactive\n");
      const result = await runCli(["svc", "demo", "local", "--json"], config, bin);
      expect(result.code, result.stderr).toBe(1);
      expect(JSON.parse(result.stdout)[0]).toMatchObject({ service: "demo", up: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("wait rejects conflicting conditions and status without HTTP", async () => {
    const { root, config } = fixture();
    try {
      const conflict = await runCli(["wait", "local", "--http", "http://example.test", "--port", "80"], config);
      expect(conflict.code).toBe(1);
      expect(conflict.stderr).toContain("accepts one condition");
      const orphanStatus = await runCli(["wait", "local", "--status", "204"], config);
      expect(orphanStatus.code).toBe(1);
      expect(orphanStatus.stderr).toContain("--status requires --http");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("completion data cannot execute config-key command substitutions", async () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-completion-"));
  try {
    const marker = join(root, "executed");
    const cfg = {
      hosts: {
        [`host$(touch ${marker})`]: { name: "unsafe", ssh: "safe", os: "linux" },
      },
    } as FleetConfig;
    const script = completionScript(cfg, "bash")
      + "\nCOMP_WORDS=(fleet exec); COMP_CWORD=2; _fleet >/dev/null\n";
    const proc = Bun.spawn(["bash", "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(script);
    proc.stdin.end();
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("trailingFleetFlag", () => {
  const bools = ["--json", "--wsl", "--raw"];
  const valued = ["--cwd", "--timeout"];
  test("catches a fleet flag written after the command", () => {
    expect(trailingFleetFlag(["echo x", "--json"], bools, valued)).toBe("--json");
    expect(trailingFleetFlag(["echo", "hi", "--timeout", "5"], bools, valued)).toBe("--timeout");
    expect(trailingFleetFlag(["echo", "hi", "--cwd"], bools, valued)).toBe("--cwd");
  });
  test("leaves a quoted command and remote flags alone", () => {
    expect(trailingFleetFlag(["gh pr list --json number"], bools, valued)).toBeUndefined();
    expect(trailingFleetFlag(["gh", "pr", "list", "--json", "number"], bools, valued)).toBeUndefined();
    expect(trailingFleetFlag(["--json"], bools, valued)).toBeUndefined();
    expect(trailingFleetFlag(["curl", "--retry", "3"], bools, valued)).toBeUndefined();
  });
});
