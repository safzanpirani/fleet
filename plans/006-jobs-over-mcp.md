# Plan 006: Expose the detached-jobs surface over MCP

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat b6eab9b..HEAD -- src/server.ts src/jobs.ts README.md`
> If any changed since this plan was written, compare the "Current state" excerpts
> against the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (new tool surface; a blocking `wait` tool must be bounded)
- **Depends on**: 001 (soft — better covered with `test/jobs.test.ts`)
- **Category**: direction (feature)
- **Planned at**: commit `b6eab9b`, 2026-06-26

## Why this matters

The CLI gained a full detached-jobs system — `spawn`, `jobs` (list), `jobs log`,
`jobs tail`, `jobs wait`, `jobs kill`, `jobs prune` (see `src/jobs.ts` and
`README.md:41-66`). But the MCP server (`src/server.ts`) exposes none of it: an
agent driving fleet can run a **blocking** `fleet_exec`, but cannot launch a job
that outlives the call, nor list/inspect/kill jobs others started. That's a sharp
capability asymmetry — and the hard part is already done: the job-core functions in
`jobs.ts` return plain data and throw on error (same contract `server.ts` tools
expect). This plan registers the job verbs as MCP tools so agents reach parity with
the CLI for fire-and-track work.

Design decisions are **pre-made below** so you don't have to judge — follow them.

## Design decisions (made for you)

- **Tools to add**: `fleet_spawn`, `fleet_jobs`, `fleet_job_log`, `fleet_job_tail`,
  `fleet_job_wait`, `fleet_job_kill`, `fleet_jobs_prune`.
- **NOT exposed**: live follow (`tail -f` / `jobFollow`) — it streams to a TTY,
  which MCP has no notion of (same reason `top`/`ssh` are CLI-only; see
  `mcp.ts:8-9`). `fleet_job_tail` returns the last N lines (no follow).
- **readOnly gating** (the `FLEET_MCP_READONLY=1` kill-switch): the read tools
  `fleet_jobs`, `fleet_job_log`, `fleet_job_tail` are registered **always**. The
  mutating tools `fleet_spawn`, `fleet_job_kill`, `fleet_jobs_prune`, and the
  blocking `fleet_job_wait` are registered **only when `!opts.readOnly`** (same as
  `fleet_exec` et al — they go after the `if (opts.readOnly) return server;` line).
- **Addressing**: job tools take a single `ref` string (`"host:id"` or you may also
  accept separate `host`+`id`); reuse `resolveJobRef`'s parsing by passing the ref
  as the first arg. The core functions already accept `(cfg, a, b?)`.
- **`fleet_job_wait` must be bounded**: MCP requests can't be ctrl-c'd, so require a
  timeout and cap it. Default 60s, hard max 600s. Pass `timeoutMs` into `waitJob`.
- **Annotations**: `fleet_jobs`/`fleet_job_log`/`fleet_job_tail` →
  `readOnlyHint: true`. `fleet_job_kill`/`fleet_jobs_prune` → `destructiveHint: true`.
  `fleet_spawn` → neither readOnly nor destructive (it launches work).
  All → `openWorldHint: true` (they hit remote hosts), matching the existing tools.

## Current state

`src/server.ts` registers (in order): `fleet_ls`, `fleet_logs`, `fleet_gpu`,
`fleet_status`, `fleet_screenshot` (all read-only, always), then after
`if (opts.readOnly) return server;` (line 149): `fleet_exec`, `fleet_cp`,
`fleet_restart`, `fleet_cu`, `fleet_run`. Tools delegate to `core.ts` and render
with the `text(...)` / `renderExec(...)` helpers (lines 22-36). Import block at
lines 14-17 pulls core actions.

`src/jobs.ts` exports the functions to wire up (read them to confirm signatures):
- `spawnJob(cfg, sel, cmd, opts?: { cwd? }) → Promise<SpawnResult[]>` (lines 107-119)
- `listJobs(cfg, sel = "all") → Promise<JobRow[]>` (lines 154-161)
- `jobLog(cfg, a, b?) → Promise<{ host; output }>` (lines 164-169)
- `jobTail(cfg, a, b?, n) → Promise<{ host; output }>` (lines 171-175)
- `waitJob(cfg, a, b?, opts: WaitOpts) → Promise<JobWaitResult>` (lines 214-239)
  - `WaitOpts = { until?; timeoutMs?; intervalMs?; onTick? }`; `JobWaitResult =
    { host; id; outcome: "exited"|"matched"|"timeout"; code; elapsedMs }`.
- `killJob(cfg, a, b?) → Promise<ExecResult>` (lines 185-195)
- `pruneJobs(cfg, sel = "all", all = false) → Promise<{ host; removed }[]>` (lines 244-264)

`SpawnResult` (lines 50-56) = `{ host, ok, id, pid, error? }`.
`JobRow` (lines 41-49) = `{ host, id, status, code, pid, started, cmd }`.

The CLI renders these in `cli.ts` (lines 124-194) — use those as the model for the
plain-text MCP renderers (strip ANSI).

`README.md:89-92` lists the current MCP tools; you'll extend that list.

## Commands you will need

| Purpose      | Command                                            | Expected            |
|--------------|----------------------------------------------------|---------------------|
| Typecheck    | `bun run typecheck`                                | exit 0, no output   |
| Full suite   | `bun test`                                         | all pass            |
| Smoke (stdio)| `bun run scripts/smoke.ts`                         | tools list includes the new job tools (needs a reachable host for the exec calls) |
| List tools   | see Step 4 (a tiny stdio listTools check)          | new tools present   |

## Scope

**In scope**:
- `src/server.ts` — register the 7 new tools; add the needed imports from `./jobs.ts`.
- `README.md` — add the new tools to the MCP tool list (lines ~89-92) and note that
  live-follow is intentionally not exposed.
- (Optional) `scripts/smoke.ts` — add a `tools/list` assertion that the job tools
  appear; do **not** add calls that require a live job unless you have a host.

**Out of scope** (do NOT touch):
- `src/jobs.ts` — its functions are reused as-is; no signature changes.
- The CLI (`cli.ts`) — already has these verbs.
- `fleet_job_follow` / any streaming tool — explicitly not part of this plan.
- The Windows spawn path — `spawnJob` already returns a clear "not implemented"
  error for Windows hosts (`jobs.ts:112`); the MCP tool surfaces that as-is. (Real
  Windows support is plan 007.)

## Git workflow

- Branch `advisor/006-jobs-over-mcp` if asked; else commit on the current branch.
  Message e.g. `feat(mcp): expose detached jobs (spawn/jobs/log/tail/wait/kill/prune)`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Import the job functions in `src/server.ts`

Add to the imports (near lines 14-17). Add a `jobs.ts` import:

```ts
import {
  spawnJob, listJobs, jobLog, jobTail, waitJob, killJob, pruneJobs,
} from "./jobs.ts";
```

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Register the always-on read tools

Add these **before** the `if (opts.readOnly) return server;` line (after
`fleet_screenshot`, around line 147). Use the `text(...)` helper for output.

```ts
  server.registerTool("fleet_jobs", {
    title: "List detached jobs",
    description: "List background jobs (running ● / exited ○ / dead ✗) across the fleet, launched "
      + "via fleet_spawn and surviving the SSH session. " + sel,
    inputSchema: {
      selector: z.string().optional().describe("Host selector to scope the list (default: all)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ selector }) => {
    const rows = await listJobs(cfg, selector ?? "all");
    if (!rows.length) return text("no jobs");
    const out = rows.map((r) =>
      `${r.status === "running" ? "●" : r.status === "exited" ? "○" : "✗"} ${(r.host + ":" + r.id).padEnd(22)} `
      + `${r.status.padEnd(8)} ${(r.status === "exited" ? "exit " + r.code : "pid " + (r.pid ?? "—")).padEnd(12)} ${r.cmd}`,
    ).join("\n");
    return text(out);
  });

  server.registerTool("fleet_job_log", {
    title: "Read a job's full output",
    description: "Return the complete combined stdout+stderr of one detached job. Address it as "
      + "\"host:id\" (e.g. \"oracle:mqtn19-9px\").",
    inputSchema: { ref: z.string().describe("Job address \"host:id\".") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ ref }) => {
    const { output } = await jobLog(cfg, ref);
    return text(output);
  });

  server.registerTool("fleet_job_tail", {
    title: "Tail a job's recent output",
    description: "Return the last N lines of one detached job's output (no live follow — MCP has "
      + "no stream). Address it as \"host:id\".",
    inputSchema: {
      ref: z.string().describe("Job address \"host:id\"."),
      lines: z.number().int().positive().optional().describe("How many trailing lines (default 40)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ ref, lines }) => {
    const { output } = await jobTail(cfg, ref, undefined, lines ?? 40);
    return text(output);
  });
```

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Register the mutating + blocking tools (gated by readOnly)

Add these **after** the `if (opts.readOnly) return server;` line (alongside
`fleet_exec` etc.):

```ts
  server.registerTool("fleet_spawn", {
    title: "Launch a detached job",
    description: "Launch a command as a background job that OUTLIVES this call and the SSH session, "
      + "returning a job id (address it later as \"host:id\"). Use fleet_jobs/fleet_job_log/"
      + "fleet_job_wait to track it. Linux/mac only (Windows spawn is not yet implemented). " + sel,
    inputSchema: {
      selector: z.string().describe("Host selector (each matched host launches its own job)."),
      command: z.string().describe("Command to run, verbatim."),
      cwd: z.string().optional().describe("Working directory; fails fast if missing."),
    },
    annotations: { openWorldHint: true },
  }, async ({ selector, command, cwd }) => {
    const results = await spawnJob(cfg, selector, command, { cwd });
    const out = results.map((r) =>
      r.ok ? `● ${r.host} job ${r.id} · pid ${r.pid}` : `✗ ${r.host} · ${r.error ?? "spawn failed"}`,
    ).join("\n");
    return text(out, results.some((r) => !r.ok));
  });

  server.registerTool("fleet_job_wait", {
    title: "Wait for a job to finish (bounded)",
    description: "Block until a detached job exits, or (with `until`) its output matches a regex, or "
      + "the timeout elapses. Always bounded — MCP requests can't be cancelled. Address it as \"host:id\".",
    inputSchema: {
      ref: z.string().describe("Job address \"host:id\"."),
      until: z.string().optional().describe("Regex; resolve as soon as the job's output matches."),
      timeoutSeconds: z.number().int().positive().max(600).optional().describe("Max wait (default 60, hard max 600)."),
    },
    annotations: { openWorldHint: true },
  }, async ({ ref, until, timeoutSeconds }) => {
    const timeoutMs = Math.min(600, timeoutSeconds ?? 60) * 1000;
    const r = await waitJob(cfg, ref, undefined, { until, timeoutMs });
    return text(`${r.outcome} ${r.host}:${r.id}`
      + `${r.code != null ? " · exit " + r.code : ""} · ${Math.round(r.elapsedMs / 1000)}s`,
      r.outcome === "timeout");
  });

  server.registerTool("fleet_job_kill", {
    title: "Kill a detached job",
    description: "Send TERM to a job's whole process-group (the job + anything it spawned). "
      + "Address it as \"host:id\".",
    inputSchema: { ref: z.string().describe("Job address \"host:id\".") },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({ ref }) => {
    const r = await killJob(cfg, ref);
    return text(renderExec([r]), !r.ok);
  });

  server.registerTool("fleet_jobs_prune", {
    title: "Remove finished job spools",
    description: "Garbage-collect finished job spools (exited by default; set all:true to also drop "
      + "dead ones). Never touches a running job. " + sel,
    inputSchema: {
      selector: z.string().optional().describe("Host selector (default: all)."),
      all: z.boolean().optional().describe("Also remove dead (not just exited) jobs."),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({ selector, all }) => {
    const out = await pruneJobs(cfg, selector ?? "all", all ?? false);
    return text(out.map((o) => `⌫ ${o.host} pruned ${o.removed} job(s)`).join("\n"));
  });
```

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Verify the tool list (no live host required)

`tools/list` does not execute any job action, so you can verify registration
offline. Run this one-off check:

```sh
bun -e '
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({ command: "bun", args: ["run", "src/mcp.ts"] });
const c = new Client({ name: "x", version: "1" });
await c.connect(t);
const { tools } = await c.listTools();
console.log(tools.map(t => t.name).sort().join("\n"));
await c.close();
'
```

Expected: the list includes `fleet_jobs`, `fleet_job_log`, `fleet_job_tail`,
`fleet_spawn`, `fleet_job_wait`, `fleet_job_kill`, `fleet_jobs_prune` (plus the
existing tools). Then confirm the kill-switch hides the mutating ones:

```sh
FLEET_MCP_READONLY=1 bun -e '<same snippet as above>'
```

Expected: `fleet_jobs`, `fleet_job_log`, `fleet_job_tail` present;
`fleet_spawn`, `fleet_job_wait`, `fleet_job_kill`, `fleet_jobs_prune` **absent**.

### Step 5: Update `README.md`

In the MCP server section (lines ~89-92), extend the tools list to include the new
job tools, and add a sentence: live-follow (`tail -f`) is intentionally not exposed
over MCP (no TTY), matching `top`/`ssh`.

**Verify**: visual check that the tool list and note are present.

### Step 6: Full verification

**Verify**:
- `bun run typecheck` → exit 0.
- `bun test` → all pass (existing suite unaffected).
- Step 4 tool-list checks pass (full and read-only).
- If you have a reachable Linux host in the config: spawn a tiny job and round-trip
  it, e.g. via the smoke client — `fleet_spawn {selector, command:"echo hi; sleep 2"}`
  → `fleet_jobs` shows it → `fleet_job_log {ref}` returns `hi`. Skip if no host.

## Test plan

- Primary verification is the `tools/list` registration check (Step 4), which needs
  no live host and exercises both the full and read-only paths.
- If `test/jobs.test.ts` exists (plan 001), it already covers the underlying
  `resolveJobRef`/`parseRows` the tools depend on — no new unit tests are required
  for the tool wiring itself (it's thin delegation). Optionally extend
  `scripts/smoke.ts` with the tools/list assertion.

## Done criteria

ALL must hold:

- [ ] `bun run typecheck` exits 0.
- [ ] `bun test` exits 0.
- [ ] Step 4 (full): all 7 new tools appear in `tools/list`.
- [ ] Step 4 (read-only): `fleet_spawn`/`fleet_job_wait`/`fleet_job_kill`/
      `fleet_jobs_prune` are **absent** under `FLEET_MCP_READONLY=1`;
      `fleet_jobs`/`fleet_job_log`/`fleet_job_tail` are present.
- [ ] `README.md` lists the new tools and notes follow is not exposed.
- [ ] `git status` shows only in-scope files changed.
- [ ] `plans/README.md` status row for 006 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- `src/server.ts`'s structure (the `if (opts.readOnly) return server;` boundary at
  line 149) isn't where the excerpt says — placement of the read vs mutating tools
  depends on it.
- A job-core function signature in `src/jobs.ts` differs from the "Current state"
  list (drift) — don't guess the call shape.
- You're tempted to expose live-follow or to make `fleet_job_wait` unbounded — both
  are explicitly out of scope; report the desire instead of implementing it.

## Maintenance notes

- If plan 003 (exec timeout) landed, consider whether `fleet_spawn`'s underlying
  launch `exec` should also carry the MCP exec-timeout default — the spawn launch
  is short, so it's low-risk either way.
- When Windows spawn lands (plan 007), `fleet_spawn` will start succeeding on
  Windows hosts automatically (it already calls `spawnJob`); revisit the
  description's "Linux/mac only" note then.
- A reviewer should scrutinize the `fleet_job_wait` cap (≤600s) — it's the only
  blocking tool and the main DoS-shaped risk if uncapped.
