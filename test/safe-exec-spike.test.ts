import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { status, submit } from "../src/spikes/safe-exec.ts";
import type { Outcome, Request } from "../src/spikes/safe-exec.ts";

const worker = join(import.meta.dir, "fixtures", "safe-exec-worker.ts");

async function waitForFile(path: string) {
  if (existsSync(path)) return;
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (existsSync(path)) { clearTimeout(deadline); watcher.close(); resolve(); }
    });
    // A real-process failure deadline, not a scheduling delay or guessed race window.
    const deadline = setTimeout(() => { watcher.close(); reject(new Error(`timed out waiting for fixture ${path}`)); }, 5000);
    if (existsSync(path)) { clearTimeout(deadline); watcher.close(); resolve(); }
  });
}

function launch(spool: string, request: Request, fault = "none", marker = "") {
  return Bun.spawn([process.execPath, worker, spool, JSON.stringify(request), fault, marker], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
}

async function run(spool: string, request: Request): Promise<Outcome> {
  const broker = launch(spool, request);
  const [code, output, error] = await Promise.all([
    broker.exited, new Response(broker.stdout).text(), new Response(broker.stderr).text(),
  ]);
  if (code !== 0) throw new Error(error || `broker exited ${code}`);
  return JSON.parse(output) as Outcome;
}

test("durable dispatch failure matrix uses real independent brokers and child processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-safe-exec-"));
  const results: Array<{ point: string; state: string; effects: number; elapsedMs: number }> = [];
  const effects = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").length : 0;
  const requestFor = (id: string): Request => ({
    id, cwd: root,
    argv: [process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1], 'effect\\n')", join(root, `${id}.effects`)],
  });
  try {
    for (const point of ["before-admit", "admitted", "dispatching", "spawned", "exited", "completed"] as const) {
      const request = requestFor(point);
      const marker = join(root, `${point}.phase`);
      const effectFile = request.argv[3]!;
      const start = performance.now();
      const broker = launch(join(root, point), request, point, marker);
      try {
        await waitForFile(marker);
        if (point === "spawned") await waitForFile(effectFile);
        broker.kill("SIGKILL");
        await broker.exited;
      } finally {
        if (broker.exitCode === null) { broker.kill("SIGKILL"); await broker.exited; }
      }
      const before = status(join(root, point), request.id);
      expect(before.state).toBe(point === "before-admit" ? "absent" : point === "admitted" ? "prepared" :
        point === "completed" ? "completed" : "indeterminate");
      for (let retry = 0; retry < 3; retry++) await run(join(root, point), request);
      const receipt = status(join(root, point), request.id);
      const expected = ["dispatching", "spawned", "exited"].includes(point) ? "indeterminate" : "completed";
      expect(receipt.state).toBe(expected);
      expect(effects(effectFile)).toBe(point === "dispatching" ? 0 : 1);
      if (receipt.state === "indeterminate") expect(receipt.retry).toBe("never");
      results.push({ point, state: receipt.state, effects: effects(effectFile), elapsedMs: Math.round(performance.now() - start) });
    }

    const concurrent = requestFor("concurrent");
    const start = performance.now();
    const responses = await Promise.all(Array.from({ length: 12 }, () => run(join(root, "concurrent"), concurrent)));
    expect(responses.every((reply) => ["completed", "indeterminate"].includes(reply.state))).toBe(true);
    expect(status(join(root, "concurrent"), concurrent.id).state).toBe("completed");
    expect(effects(concurrent.argv[3]!)).toBe(1);
    results.push({ point: "12-concurrent-brokers", state: "completed", effects: 1, elapsedMs: Math.round(performance.now() - start) });

    const collision = launch(join(root, "concurrent"), { ...concurrent, argv: [process.execPath, "-e", "process.exit(0)"] });
    const [collisionCode, collisionError] = await Promise.all([collision.exited, new Response(collision.stderr).text()]);
    expect(collisionCode).toBe(1);
    expect(collisionError).toContain("different command");
    expect(effects(concurrent.argv[3]!)).toBe(1);
    results.push({ point: "request-key-collision", state: "rejected", effects: 1, elapsedMs: 0 });

    const late = join(root, "grandchild.finished");
    const release = join(root, "grandchild.release");
    const ready = join(root, "grandchild.ready");
    const grandchild = `
      const fs = require('node:fs');
      const watcher = fs.watch(process.cwd(), () => {
        if (!fs.existsSync(process.argv[2])) return;
        console.log('late output'); fs.writeFileSync(process.argv[1], 'done'); watcher.close();
      });
      fs.writeFileSync(process.argv[3], 'ready');
    `;
    const pipeRequest: Request = {
      id: "inherited-handles", cwd: root,
      argv: [process.execPath, "-e", `
        const child = Bun.spawn([process.execPath, '-e', process.argv[1], ...process.argv.slice(2)],
          { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', detached: true });
        child.unref(); console.log('leader output');
      `, grandchild, late, release, ready],
    };
    const pipeStart = performance.now();
    let pipeReceipt: Outcome;
    let leaderMs: number;
    try {
      pipeReceipt = await run(join(root, "pipes"), pipeRequest);
      expect(pipeReceipt.state).toBe("completed");
      expect(existsSync(late)).toBe(false); // Grandchild is still gated and holding the inherited output.
      leaderMs = Math.round(performance.now() - pipeStart);
    } finally {
      await waitForFile(ready);
      writeFileSync(release, "release");
      await waitForFile(late); // Always let our own detached child finish before cleanup.
    }
    if (pipeReceipt.state !== "completed") throw new Error("missing leader receipt");
    expect(readFileSync(pipeReceipt.stdout, "utf8")).toContain("late output");
    results.push({ point: "child-retains-output", state: pipeReceipt.state, effects: 1, elapsedMs: leaderMs });

    const missing: Request = { id: "missing", cwd: root, argv: [join(root, "no-such-executable")] };
    const missingReceipt = await run(join(root, "missing"), missing);
    expect(missingReceipt.state).toBe("not-started");
    expect(await run(join(root, "missing"), missing)).toEqual(missingReceipt);
    results.push({ point: "spawn-rejected", state: missingReceipt.state, effects: 0, elapsedMs: 0 });

    const failed: Request = { id: "nonzero", cwd: root, argv: [process.execPath, "-e", "console.error('failed'); process.exit(23)"] };
    const failedReceipt = await run(join(root, "nonzero"), failed);
    expect(failedReceipt).toMatchObject({ state: "completed", code: 23 });
    expect(await submit(join(root, "nonzero"), failed)).toEqual(failedReceipt);
    results.push({ point: "nonzero-receipt", state: failedReceipt.state, effects: 0, elapsedMs: 0 });
    console.log(JSON.stringify({ platform: process.platform, bun: Bun.version, matrix: results }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
