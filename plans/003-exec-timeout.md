# Plan 003: Give `exec` a wall-clock timeout so a hung command can't hang the MCP server

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat b6eab9b..HEAD -- src/ssh.ts src/core.ts src/server.ts README.md`
> If any changed since this plan was written, compare the "Current state" excerpts
> against the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: 001 (adds a test to `test/core.test.ts` / `test/ssh.test.ts`)
- **Category**: bug
- **Planned at**: commit `b6eab9b`, 2026-06-26

## Why this matters

`exec` in `src/ssh.ts` awaits the SSH child process with **no wall-clock bound**.
The only timeout is `ConnectTimeout=15`, which covers the TCP/auth handshake only —
once connected, a command that blocks (waits on stdin, `tail -f`, a hung process,
an interactive prompt) keeps the call pending forever. From the CLI that's
survivable (ctrl-c). But `runExec` also backs the `fleet_exec` MCP tool, and the
HTTP server (`src/http.ts`) is a stateless request/response service with **no way
to ctrl-c**: a single hung command pins that request indefinitely and the agent
that called it never gets a response. This plan adds an optional `timeoutMs` to
`exec`, threads it through `runExec`, and makes the MCP `fleet_exec` tool apply a
sane default (overridable via env). CLI behavior is unchanged by default.

## Current state

`src/ssh.ts`, `exec` (lines 102-127):

```ts
export async function exec(
  host: Host,
  command: string,
  shell: Shell = "auto",
  opts: { cwd?: string } = {},
): Promise<ExecResult> {
  const resolved: Shell = shell === "auto"
    ? (host.os === "windows" ? "powershell" : "bash")
    : shell;
  const winBin = host.os === "windows" && resolved !== "bash"
    ? await resolveWinBin(host) : "powershell";
  const { args, stdin } = buildArgs(host, command, resolved, winBin, opts.cwd);

  const proc = Bun.spawn(args, {
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { host: host.name, ok: code === 0, code, stdout: stdout.trimEnd(),
    stderr: stderr.trimEnd() };
}
```

`src/core.ts`, `runExec` (lines 80-86):

```ts
export async function runExec(
  cfg: FleetConfig, sel: string, cmd: string, opts: { wsl?: boolean; cwd?: string } = {},
): Promise<ExecResult[]> {
  const hosts = resolveHosts(cfg, sel);
  const shell: Shell = opts.wsl ? "wsl" : "auto";
  return Promise.all(hosts.map((h) => exec(h, cmd, shell, { cwd: opts.cwd })));
}
```

`src/server.ts`, the `fleet_exec` tool handler (lines 164-167):

```ts
  }, async ({ selector, command, wsl }) => {
    const results = await runExec(cfg, selector, command, { wsl });
    return text(renderExec(results), results.some((r) => !r.ok));
  });
```

`ExecResult` (`src/ssh.ts:16-22`) is `{ host, ok, code, stdout, stderr }`. The
convention for a timed-out process exit code is **124** (the `timeout(1)` /
GNU convention; `cli.ts` already uses 124 for `jobs wait` timeouts, line 171).

Existing patterns to match:
- `src/ssh.ts:135-147` (`probe`) already does a wall-clock race with
  `Bun.sleep(capMs).then(() => { proc.kill(); … })` and reads a `FLEET_*_MS` env.
- Env-var defaults are read at module top (`PROBE_CAP_MS = Number(process.env.FLEET_PROBE_TIMEOUT_MS ?? 4000)`, line 135).

## Commands you will need

| Purpose     | Command                                              | Expected            |
|-------------|-----------------------------------------------------|---------------------|
| Typecheck   | `bun run typecheck`                                  | exit 0, no output   |
| Unit tests  | `bun test test/core.test.ts`                         | all pass            |
| Full suite  | `bun test`                                           | all pass            |
| Integration | `FLEET_TEST_SSH_HOST=<reachable-host> bun test test/ssh.test.ts` | timeout case passes (only if you set a host) |

## Scope

**In scope**:
- `src/ssh.ts` — add `timeoutMs` to `exec`'s `opts`, implement the race + kill,
  and add an exported pure helper `timedOutResult` (for unit testing the synthesized result).
- `src/core.ts` — add optional `timeoutMs` to `runExec`'s `opts` and pass it through.
- `src/server.ts` — make `fleet_exec` apply a default timeout (env-overridable).
- `README.md` — document `FLEET_EXEC_TIMEOUT_MS` in the MCP / env section.
- `test/core.test.ts` and `test/ssh.test.ts` — add unit + (guarded) integration tests.

**Out of scope** (do NOT touch):
- The CLI `exec`/`spawn` handlers — they keep the current no-timeout behavior so
  long interactive/build commands aren't surprise-killed. (A CLI `--timeout` flag
  is a deferred follow-up, noted below; do not add it here — it would also collide
  with plan 002's flag parsing.)
- `probe`/`execStream`/`scp` — they already have their own handling or are
  streaming/interactive; leave them.
- `waitJob`'s poll loop — its `exec` calls are short and self-bounded by the wait
  timeout; don't add per-poll timeouts here.

## Git workflow

- Branch `advisor/003-exec-timeout` if asked; else commit on the current branch.
  Message e.g. `fix(exec): add optional wall-clock timeout; default it for the MCP exec tool`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add the timeout to `exec` in `src/ssh.ts`

Change the `opts` type and add the race. Replace the `exec` body (lines 102-127)
with:

```ts
export async function exec(
  host: Host,
  command: string,
  shell: Shell = "auto",
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const resolved: Shell = shell === "auto"
    ? (host.os === "windows" ? "powershell" : "bash")
    : shell;
  const winBin = host.os === "windows" && resolved !== "bash"
    ? await resolveWinBin(host) : "powershell";
  const { args, stdin } = buildArgs(host, command, resolved, winBin, opts.cwd);

  const proc = Bun.spawn(args, {
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Read stdout/stderr eagerly so killing the proc still yields whatever it
  // produced before it hung. ConnectTimeout only bounds the handshake, so a
  // command that blocks after connecting needs this wall-clock kill.
  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();
  let timedOut = false;
  const timeoutMs = opts.timeoutMs ?? 0;
  if (timeoutMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timed = new Promise<boolean>((res) => { timer = setTimeout(() => res(true), timeoutMs); });
    const fired = await Promise.race([proc.exited.then(() => false), timed]);
    if (timer) clearTimeout(timer);
    if (fired) { timedOut = true; proc.kill(); }
  }
  const [stdout, stderr, code] = await Promise.all([stdoutP, stderrP, proc.exited]);
  if (timedOut) return timedOutResult(host.name, stdout, stderr, timeoutMs);
  return { host: host.name, ok: code === 0, code, stdout: stdout.trimEnd(),
    stderr: stderr.trimEnd() };
}

/** The ExecResult returned when a command is killed for exceeding its time budget.
 *  Code 124 follows the timeout(1) convention (matches `jobs wait` timeouts). */
export function timedOutResult(
  hostName: string, stdout: string, stderr: string, timeoutMs: number,
): ExecResult {
  const note = `fleet: exec timed out after ${Math.round(timeoutMs / 1000)}s`;
  return {
    host: hostName, ok: false, code: 124,
    stdout: stdout.trimEnd(),
    stderr: [stderr.trimEnd(), note].filter(Boolean).join("\n"),
  };
}
```

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Thread `timeoutMs` through `runExec` in `src/core.ts`

Replace `runExec` (lines 80-86) with:

```ts
export async function runExec(
  cfg: FleetConfig, sel: string, cmd: string,
  opts: { wsl?: boolean; cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult[]> {
  const hosts = resolveHosts(cfg, sel);
  const shell: Shell = opts.wsl ? "wsl" : "auto";
  return Promise.all(hosts.map((h) => exec(h, cmd, shell, { cwd: opts.cwd, timeoutMs: opts.timeoutMs })));
}
```

The CLI's `exec` handler calls `runExec(cfg, target, cmd, { wsl, cwd })` (no
`timeoutMs`), so CLI behavior is unchanged (defaults to no timeout). Do not modify
the CLI call.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Default a timeout for the MCP `fleet_exec` tool in `src/server.ts`

Near the top of `buildServer` (after line 50, where `recipeNames` is computed),
add a module-level or in-function default read from env:

```ts
  // The HTTP MCP server is a stateless request/response service with no ctrl-c;
  // bound exec so a hung remote command can't pin a request forever. 0 disables.
  const execTimeoutMs = Number(process.env.FLEET_EXEC_TIMEOUT_MS ?? 120_000);
```

Then in the `fleet_exec` handler (lines 164-167) pass it through:

```ts
  }, async ({ selector, command, wsl }) => {
    const results = await runExec(cfg, selector, command, { wsl, timeoutMs: execTimeoutMs });
    return text(renderExec(results), results.some((r) => !r.ok));
  });
```

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Document the env var in `README.md`

In the "Remote MCP endpoint (HTTP)" section (around lines 110-121) or the MCP
server section, add a bullet:

> - **Exec timeout:** `FLEET_EXEC_TIMEOUT_MS` (default `120000`) bounds each
>   `fleet_exec` command so a hung remote process can't pin an MCP request. Set
>   `0` to disable. (The CLI `fleet exec` is unbounded — ctrl-c to abort.)

**Verify**: the bullet renders in the relevant section (visual check).

### Step 5: Unit-test `timedOutResult` and (guarded) the real timeout

In `test/ssh.test.ts`, add the import and a describe block:

```ts
import { timedOutResult } from "../src/ssh.ts"; // add to the existing import line

describe("timedOutResult", () => {
  test("synthesizes a 124 result with a timeout note appended to stderr", () => {
    const r = timedOutResult("oracle", "partial out\n", "warn\n", 1500);
    expect(r).toMatchObject({ host: "oracle", ok: false, code: 124, stdout: "partial out" });
    expect(r.stderr).toBe("warn\nfleet: exec timed out after 2s");
  });
  test("omits a blank stderr line when there was no stderr", () => {
    expect(timedOutResult("oracle", "", "", 3000).stderr).toBe("fleet: exec timed out after 3s");
  });
});
```

Add a guarded integration test (skipped unless `FLEET_TEST_SSH_HOST` is set to a
reachable host name — its ssh alias must work without a password):

```ts
import { exec } from "../src/ssh.ts"; // add to the existing import line

const sshHost = process.env.FLEET_TEST_SSH_HOST;
describe.skipIf(!sshHost)("exec timeout (integration; needs FLEET_TEST_SSH_HOST)", () => {
  test("kills a blocking command at the budget and returns code 124", async () => {
    const host = { name: sshHost!, ssh: sshHost!, os: "linux" as const };
    const start = Date.now();
    const r = await exec(host, "sleep 30", "bash", { timeoutMs: 1500 });
    expect(r.code).toBe(124);
    expect(r.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(8000);
  });
});
```

**Verify**:
- `bun test test/ssh.test.ts` → unit tests pass; the integration block is skipped
  (you'll see it reported as skipped) unless you set `FLEET_TEST_SSH_HOST`.
- If you have a reachable host: `FLEET_TEST_SSH_HOST=<host> bun test test/ssh.test.ts`
  → the timeout test passes in under ~8s.

### Step 6: Full verification

**Verify**:
- `bun test` → all pass (integration block skipped without the env var).
- `bun run typecheck` → exit 0.

## Test plan

- `timedOutResult` unit tests in `test/ssh.test.ts` (deterministic, no SSH).
- A `describe.skipIf` integration test that exercises the real race against a
  reachable host, gated on `FLEET_TEST_SSH_HOST` so default `bun test` stays
  infrastructure-free.
- Model after the existing `describe` blocks in `test/ssh.test.ts`.
- Verification: `bun test` → all pass.

## Done criteria

ALL must hold:

- [ ] `bun test` exits 0; `timedOutResult` unit tests pass; integration block is
      present and skipped by default.
- [ ] `bun run typecheck` exits 0.
- [ ] `grep -n "timeoutMs" src/ssh.ts src/core.ts src/server.ts` shows the param
      threaded through `exec` → `runExec` → `fleet_exec`.
- [ ] `README.md` documents `FLEET_EXEC_TIMEOUT_MS`.
- [ ] The CLI `exec` handler in `src/cli.ts` is unchanged (still calls
      `runExec(cfg, target, cmd, { wsl, cwd })`).
- [ ] `git status` shows only in-scope files changed.
- [ ] `plans/README.md` status row for 003 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The `exec` body in `src/ssh.ts` doesn't match the "Current state" excerpt (drift).
- Killing the proc does not cause `new Response(proc.stdout).text()` to resolve in
  your Bun version (the `await Promise.all` after kill hangs) — report the Bun
  version; do not add an arbitrary second timer to force-resolve the reads.
- `test/ssh.test.ts` does not exist (plan 001 hasn't landed) — run 001 first or
  create the file per 001's Step 3, and note it in your status row.

## Maintenance notes

- Default timeout is **MCP-only**; the CLI stays unbounded on purpose (long builds).
  A reviewer should confirm the CLI path didn't gain a surprise timeout.
- If `fleet_spawn`/job tools are exposed over MCP later (plan 006), decide whether
  their underlying `exec` calls (spawn launch, list, log) also want this default —
  they are short, so probably yes with the same env var.
- Deferred: a CLI `fleet exec --timeout S` flag. It would route through
  `parseLeadingFlags` (plan 002's `valFlags`) and pass `timeoutMs` to `runExec`.
  Left out to keep this plan small and avoid coupling with plan 002.
