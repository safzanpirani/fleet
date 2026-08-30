import { describe, expect, test } from "bun:test";
import { completionScript } from "../src/cli.ts";
import type { FleetConfig } from "../src/config.ts";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

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
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bun", cli, ...args], {
    env: {
      ...process.env,
      FLEET_CONFIG: config,
      ...(bin ? { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("machine-readable CLI output", () => {
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
