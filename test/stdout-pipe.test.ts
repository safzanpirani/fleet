import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
// Bun.spawn's own pipe hides the bug; only a shell pipe shows it.
const piped = (body: string) => {
  const script = `import { installSyncStdout } from "./src/cli.ts"; ${body}`;
  const r = Bun.spawnSync(["sh", "-c", `bun -e '${script}' | cat`], { cwd: root, env: { ...process.env, FLEET_CONFIG: "/nonexistent" } });
  return r.stdout.toString();
};

describe("stdout through a shell pipe", () => {
  test("console.log after process.stdout was touched arrives whole", () => {
    const out = piped(`installSyncStdout(); void process.stdout.isTTY; console.log("y".repeat(200000));`);
    expect(out.length).toBe(200001);
  });

  test("write and log calls keep their order past the pipe buffer", () => {
    const out = piped(`installSyncStdout(); process.stdout.write("x".repeat(100000)); console.log("y".repeat(100000)); process.stdout.write("z");`);
    expect(out.replace(/x+/, "x").replace(/y+/, "y")).toBe("xy\nz");
  });
});

test("json error survives a shell pipe and contains no ANSI escapes", () => {
  const r = Bun.spawnSync(["bash", "-o", "pipefail", "-c", "bun src/cli.ts exec --json unknown true | cat"], {
    cwd: root, env: { ...process.env, FLEET_CONFIG: "/nonexistent/fleet-json-fixture.json", FORCE_COLOR: "1" },
  });
  expect(r.exitCode).toBe(1);
  expect(JSON.parse(r.stdout.toString())).toMatchObject({ ok: false, command: "exec" });
  expect(r.stdout.toString() + r.stderr.toString()).not.toContain("\x1b");
});
