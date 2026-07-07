# Plan 005: Author `CLAUDE.md` capturing architecture + load-bearing invariants

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat b6eab9b..HEAD -- src/ README.md`
> If the source layout changed materially since this plan was written, re-derive
> the facts below from the live files before writing them into `CLAUDE.md`.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `b6eab9b`, 2026-06-26

## Why this matters

This repo is unusual: its primary consumer is an AI agent (it ships an MCP server
so agents can drive a fleet as tools), and it's developed with Claude Code. Yet the
load-bearing invariants live only in terse file-header comments that each new
session must rediscover — and they're easy to violate destructively. Example: a
single stray `console.log` in `core.ts` corrupts the stdio MCP server's JSON-RPC
stream (`mcp.ts:15-16` warns "nothing but JSON-RPC may touch stdout"); an agent that
doesn't know that will break the server while "adding a debug line." A `CLAUDE.md`
at the repo root makes the architecture and the non-obvious rules explicit, so every
agent (and human) starts with the same map. This is a docs-only change — no source
is touched.

## Current state

- There is **no** `CLAUDE.md` or `AGENTS.md` at the repo root.
- `README.md` is thorough but user-facing (install/usage/MCP setup), not a
  contributor/agent orientation map.
- The architecture and invariants you will capture are stated, scattered, in these
  file headers — **read each to confirm before writing**:
  - `src/core.ts:1-7` — "the structured action layer … Everything here RETURNS data
    and THROWS on failure (never `process.exit` / `console.log`) … safe to call from
    a long-lived stdio MCP process. Presentation … lives in the frontends."
  - `src/ssh.ts:1-13` — the quoting-proof primitive: linux/mac pipe to `bash -ls`
    over stdin (zero interpolation), windows uses PowerShell `-EncodedCommand`,
    wsl uses a base64'd bash payload. "the SSH command line only ever carries a
    base64 blob or a fixed wrapper."
  - `src/mcp.ts:15-16` — "stdio rule: nothing but JSON-RPC may touch stdout. All
    diagnostics go to stderr (`console.error`); the action layer in core.ts never
    prints."
  - `src/server.ts:1-9` — one `buildServer` defines the tools, shared by `mcp.ts`
    (stdio) and `http.ts` (remote); read tools always registered, mutating tools
    gated by `readOnly`.
  - `src/http.ts:1-19` — the bearer token "is effectively a root credential for
    every box"; auth mandatory except `/health`; `FLEET_MCP_READONLY=1` kill-switch;
    binds `127.0.0.1` by default.
  - `src/jobs.ts:1-23, 31-39` — stateless controller; all state lives in the remote
    spool `~/.fleet/jobs/<id>/`; job ids are `[a-z0-9-]` "so they're safe to
    interpolate into remote paths without quoting."
  - `src/config.ts:5-44` — config shape, `resolveHosts` selector grammar
    (hostnames, `@linux/@windows/@mac/@gpu`, custom `@groups`, `all`/`*`, comma-mix),
    `FLEET_CONFIG` override.
- Commands (verified during recon): `bun run typecheck` (runs `tsgo --noEmit`,
  exits 0); `bun test` exists (Bun 1.3.11) — **0 tests today**, but plan 001 adds a
  suite, so reference `bun test` as the test command; smoke scripts
  `bun run scripts/smoke.ts` (stdio MCP) and `bun run scripts/smoke-http.ts` (HTTP).
- Conventions: strict TypeScript with `noUncheckedIndexedAccess`; ESM with explicit
  `.ts` import extensions (`allowImportingTsExtensions`); the CLI core has **zero**
  runtime deps (only the MCP server pulls `@modelcontextprotocol/sdk` + `zod`);
  conventional-ish commit messages (`feat:`, `perf+feat:`, `docs:` — see `git log`).
- Env vars in use (grep to confirm the full set before writing): `FLEET_CONFIG`,
  `FLEET_MCP_TOKEN`, `FLEET_MCP_READONLY`, `FLEET_MCP_HOST`, `FLEET_MCP_PORT`,
  `FLEET_WIN_SHELL`, `FLEET_PROBE_TIMEOUT_MS` (plus `FLEET_EXEC_TIMEOUT_MS` and
  `FLEET_NO_SSH_MUX` if plans 003/004 have landed — include only what exists).

## Commands you will need

| Purpose      | Command                                  | Expected            |
|--------------|------------------------------------------|---------------------|
| Confirm env  | `grep -rho "process.env.FLEET_[A-Z_]*" src/ \| sort -u` | the env-var list to document |
| Typecheck    | `bun run typecheck`                       | exit 0 (sanity; CLAUDE.md doesn't affect it) |
| Verify file  | `test -f CLAUDE.md && echo ok`           | `ok`                |

## Scope

**In scope**:
- `CLAUDE.md` (create, repo root) — the only file this plan writes.

**Out of scope** (do NOT touch):
- Any source file, `README.md`, `package.json` — this is documentation only. If you
  notice a code issue while reading, note it in your report; do not fix it here.
- Do not invent invariants. Every claim in `CLAUDE.md` must trace to a file you
  read. If you can't confirm something, leave it out.

## Git workflow

- Branch `advisor/005-claude-md` if asked; else commit on the current branch.
  Message e.g. `docs: add CLAUDE.md (architecture + invariants for agents)`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Confirm the facts from the live source

Read the file headers listed in "Current state" and run the env-var grep. Confirm:
the core/frontend split, the quoting-proof mechanism, the stdout/JSON-RPC rule, the
readOnly kill-switch, the job-spool model, and the exact env-var set. Adjust any
detail below that has drifted.

**Verify**: you can point to a file:line for each invariant you'll write.

### Step 2: Write `CLAUDE.md`

Create `CLAUDE.md` at the repo root with the following structure (fill from the
confirmed facts; keep it tight — this is a map, not a manual):

```markdown
# CLAUDE.md

Guidance for agents working in this repo. `fleet` drives a machine fleet over SSH
without quoting pain, and exposes the same actions as an MCP server for agents.

## Architecture

`src/core.ts` is the action layer: every function RETURNS data and THROWS on
failure — it must never `console.log` or `process.exit`, because it runs inside a
long-lived stdio MCP process. Three thin frontends sit on top:

- `src/cli.ts` — the ANSI terminal frontend (`fleet <cmd>`).
- `src/mcp.ts` — the stdio MCP server (agents as tools).
- `src/http.ts` — the remote MCP server (Streamable HTTP + legacy SSE).

`src/server.ts` defines the MCP tool set once (`buildServer`), shared by `mcp.ts`
and `http.ts`. `src/ssh.ts` is the quoting-proof exec primitive; `src/jobs.ts` is
the detached-jobs layer; `src/config.ts` loads config and expands selectors.

Frontend → core → ssh. The quoting-proof shell construction lives in exactly one
place (`ssh.ts` + the `--cwd`/service builders in `core.ts`).

## Load-bearing invariants (don't break these)

- **core.ts never writes stdout / never exits.** No `console.log`, no
  `process.exit`. Diagnostics in the MCP servers go to `console.error` (stderr).
  A stray stdout write corrupts the stdio JSON-RPC stream.
- **Never interpolate a command into the ssh command line.** Linux/mac pipe the
  script to `bash -ls` over stdin; Windows uses PowerShell `-EncodedCommand`
  (base64 UTF-16LE); WSL uses a base64'd bash payload. The ssh argv carries only a
  base64 blob or a fixed wrapper. This is the whole point of fleet.
- **Job ids are `[a-z0-9-]` only** so they're safe to interpolate into remote
  spool paths. Validate with `assertId` before building any path.
- **Config is trusted; the MCP exec surface is RCE by design.** `fleet_exec` runs
  arbitrary commands across the fleet. It's gated by a mandatory bearer token
  (`http.ts`) and the `FLEET_MCP_READONLY=1` kill-switch, which drops all mutating
  tools. The token is a root credential for every box — never log it, never commit it.
- **No secrets in git.** Hosts live in `fleet.config.json` (SSH aliases only);
  personal/sensitive host lists go in the git-ignored `fleet.config.local.json`.

## Commands

- Typecheck: `bun run typecheck`  (runs `tsgo --noEmit`)
- Tests: `bun test`  (unit suite under `test/`)
- Smoke (stdio MCP): `bun run scripts/smoke.ts`  (needs a reachable host)
- Smoke (HTTP MCP): `bun run scripts/smoke-http.ts`  (and with `FLEET_MCP_READONLY=1`)

## Conventions

- Strict TypeScript, `noUncheckedIndexedAccess`. ESM with explicit `.ts` import
  extensions. The CLI core has zero runtime deps; only the MCP server adds
  `@modelcontextprotocol/sdk` + `zod`.
- Selectors: host name, `@linux`/`@windows`/`@mac`/`@gpu`, custom `@groups`,
  `all`/`*`, comma-mix (`vps,@gpu`). See `resolveHosts` in `config.ts`.
- Commit messages are conventional-ish (`feat:`, `fix:`, `perf:`, `docs:`).

## Environment variables

(List the confirmed set, one line each: FLEET_CONFIG, FLEET_MCP_TOKEN,
FLEET_MCP_READONLY, FLEET_MCP_HOST, FLEET_MCP_PORT, FLEET_WIN_SHELL,
FLEET_PROBE_TIMEOUT_MS, and any others the grep surfaced.)

## Where to add things

- A new fleet action → `core.ts` (return data, throw on error) + a unit test in
  `test/`. Surface it in the CLI (`cli.ts` dispatch switch) and/or as an MCP tool
  (`server.ts` `buildServer`, choosing `readOnlyHint`/`destructiveHint` and whether
  it's gated by `readOnly`).
- Anything interactive (TTY-dependent, like `top`/`ssh`) is CLI-only — MCP has no
  TTY.
```

**Verify**: `test -f CLAUDE.md && echo ok` → `ok`.

### Step 3: Sanity-check the claims

Re-read your `CLAUDE.md` against the source. Every invariant must be confirmable.
Remove anything you couldn't verify. Make sure the env-var list matches the grep
output exactly (no invented vars; no omissions).

**Verify**: `bun run typecheck` → exit 0 (confirms you didn't accidentally touch a
`.ts` file).

## Test plan

- No automated tests (documentation). Verification is the file existing, the
  typecheck still passing, and every invariant tracing to a `file:line`.

## Done criteria

ALL must hold:

- [ ] `CLAUDE.md` exists at the repo root and covers: architecture (core +
      3 frontends + server/ssh/jobs/config), the invariants list, commands,
      conventions, env vars, and "where to add things".
- [ ] Every invariant in `CLAUDE.md` traces to a real `file:line` (no invented rules).
- [ ] The env-var list matches `grep -rho "process.env.FLEET_[A-Z_]*" src/ | sort -u`.
- [ ] `bun run typecheck` exits 0 (no source touched).
- [ ] `git status` shows only `CLAUDE.md` (and `plans/README.md`) changed.
- [ ] `plans/README.md` status row for 005 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- A file header you're quoting doesn't match the "Current state" excerpt (the
  architecture drifted) — capture what's actually true and flag the discrepancy.
- You can't confirm an invariant from the code — leave it out and note it, rather
  than guessing.

## Maintenance notes

- Keep `CLAUDE.md` in sync when the architecture changes (e.g. a new frontend, a
  new invariant). A reviewer should check that any structural PR updates it.
- If plans 003/004 land, add `FLEET_EXEC_TIMEOUT_MS` and `FLEET_NO_SSH_MUX` to the
  env-var section.
- This file is also the natural home for a future "how to run the test suite in CI"
  note once DX-2 (deferred) is picked up.
