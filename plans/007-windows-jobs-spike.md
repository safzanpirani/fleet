# Plan 007: Design + spike the Windows detached-jobs backend

> **Executor instructions**: This is a **design/spike** plan, not a
> build-everything plan. Your deliverable is a design document plus a validated
> prototype script — NOT production wiring into `jobs.ts`. Follow the steps, run
> the verifications, and honor the STOP conditions. When done, update the status
> row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat b6eab9b..HEAD -- src/jobs.ts src/core.ts`
> If `jobs.ts` changed materially (e.g. someone started the Windows backend),
> reconcile with that work before proceeding; on conflict, STOP and report.

## Status

- **Priority**: P3
- **Effort**: M–L
- **Risk**: LOW (spike — investigation + prototype, no production code path changes)
- **Depends on**: none
- **Category**: direction (spike)
- **Planned at**: commit `b6eab9b`, 2026-06-26

## Why this matters

`fleet spawn` launches detached jobs that outlive the SSH session on Linux/mac via
`setsid` (`src/jobs.ts:78-104`). The Windows backend is **stubbed** — `spawnJob`
returns a clear "not implemented" error for Windows hosts (`jobs.ts:72-76, 112`),
and `listJobs`/`pruneJobs` filter Windows hosts out entirely (`jobs.ts:155, 245`).
The blocker is real and documented: a Windows job must launch with an *interactive*
token so it can see the GPU/OpenCL — session-0 non-interactive tasks can't (README
`:62-65`, `jobs.ts:18-22`). The good news: fleet **already solves this exact
problem** for screenshots — `core.ts captureCmd` (the Windows branch, lines 306-333)
uses `schtasks /Create … /IT /F` + `/Run` to run code in the logged-in interactive
session. This spike mines that precedent to design the Windows job backend: resolve
the open questions, prototype the runner, and hand back a concrete design + working
PowerShell repro so the production wiring becomes a straightforward follow-up.

## Current state

The Linux spool contract the Windows backend must mirror (`src/jobs.ts:1-23`):

```
$HOME/.fleet/jobs/<id>/
  cmd      — the command, verbatim
  cwd      — resolved working directory
  started  — epoch seconds at launch
  pid      — pid of the setsid session leader (== process-group id)
  out      — combined stdout+stderr
  exit     — exit code (written only on completion → presence = "done")
  run      — the generated runner script (cd → run → record exit)
```

Linux launcher (`jobs.ts:78-104`, `linuxSpawnScript`) for reference:
- materializes a `run` script that `cd`s to cwd, runs `bash "$dir/cmd" > out 2>&1`,
  then `echo $? > exit`;
- `setsid "$dir/run" < /dev/null > /dev/null 2>&1 &`; records `$!` as the pid;
- prints `OK <id> <pid>`.

The Windows interactive-launch precedent (`core.ts:306-333`, `captureCmd` windows):
- writes a `.ps1` to `$env:TEMP`;
- `schtasks /Create /TN $tn /TR "powershell … -File \"$ps1\"" /SC ONCE /ST 00:00 /IT /F`
  (`/IT` = interactive token → runs in the logged-in session, can see the desktop/GPU);
- `schtasks /Run /TN $tn`; polls for the output file; `schtasks /Delete /TN $tn /F`.

The cross-OS read functions that currently skip Windows:
- `listJobs` (`jobs.ts:154-161`): `.filter((h) => h.os !== "windows")` + `LIST_SCRIPT` (bash).
- `pruneJobs` (`jobs.ts:244-264`): same filter + a bash prune script.
- `jobLog`/`jobTail`/`waitJob`/`killJob` (`jobs.ts:164-239`): all build **bash**
  commands (`cat`/`tail`/`grep`/`kill`) against `$HOME/.fleet/jobs/<id>/…`.

So a Windows backend needs PowerShell equivalents of: the launcher, the list script,
the prune script, log (`Get-Content`), tail (`Get-Content -Tail`), wait
(poll `exit` file + optional `Select-String` on `out`), and kill
(`taskkill /T` / `Stop-Process`).

The job id is `[a-z0-9-]` (`jobs.ts:33`), safe to interpolate into a Windows path
like `$env:USERPROFILE\.fleet\jobs\<id>`.

Reachable Windows hosts in config (for hands-on validation): the config has Windows
hosts (`winbox`, `gpu-box`) — confirm reachability with `fleet ls` before relying
on them. **A Windows host with an interactive logged-in session is required for the
validation step** (Step 5); if none is available, produce the design + prototype and
mark validation as pending (see STOP conditions).

## Commands you will need

| Purpose             | Command                                            | Expected               |
|---------------------|----------------------------------------------------|------------------------|
| Confirm Win hosts   | `bun run src/cli.ts ls`                            | shows windows hosts + reachability |
| Run a probe on Win  | `bun run src/cli.ts exec <winhost> "<powershell>"` | runs PowerShell on the host |
| Typecheck (sanity)  | `bun run typecheck`                                | exit 0 (spike adds no `src/` code) |

## Scope

**In scope** (create these — design + prototype only):
- `docs/design/windows-jobs.md` (create; make the `docs/design/` dir) — the design
  document: chosen approach, the spool contract on Windows, answers to the open
  questions, the PowerShell snippets for each verb, and a phased production plan.
- `scripts/win-job-spike.ps1` (create) — a self-contained PowerShell prototype of
  the launcher + runner that an operator can run on one Windows host to validate the
  approach end-to-end (launch → see `out`/`exit`/`pid` populate → kill).
- `plans/README.md` — status row update.

**Out of scope** (do NOT do in this spike):
- **No edits to `src/jobs.ts` or any `src/` file.** Production wiring (replacing the
  `WINDOWS_TODO` stub, lifting the `h.os !== "windows"` filters, adding PowerShell
  branches to log/tail/wait/kill/list/prune) is the **follow-up** that this spike
  enables, written as its own plan once the design is validated.
- No changes to the Linux path.

## Open questions to resolve (the heart of the spike)

Answer each in `docs/design/windows-jobs.md` with evidence from your prototype:

1. **PID capture.** `schtasks /Run` does not return the child PID. How does the
   runner record its own PID for later `kill`/liveness? (Hypothesis: the runner
   `.ps1`, once running in the interactive session, writes `$PID` — or the PID of
   the process it starts — to `…\<id>\pid`. Decide whether `pid` should be the
   runner's PID or the launched command's PID, and how kill should walk the tree.)
2. **Exit-code capture.** Mirror Linux: the runner runs the command, redirects
   output to `out`, then writes `$LASTEXITCODE` (or `$proc.ExitCode`) to `exit`.
   Confirm the redirection captures both stdout and stderr (`*> "$out"` or
   `2>&1 | Tee-Object`), and that `exit` is written exactly once on completion.
3. **Liveness check** (the `kill -0` equivalent). `Get-Process -Id <pid>
   -ErrorAction SilentlyContinue` → running iff it returns. Confirm it distinguishes
   running / exited / dead the way `listJobs` needs (running ● / exited ○ / dead ✗).
4. **Kill** (the process-group equivalent of `kill -- -pid`). `taskkill /T /F /PID
   <pid>` kills the tree; or `Stop-Process`. Decide which, and whether a graceful
   TERM-equivalent exists (Windows has no SIGTERM for console apps reliably — note
   the tradeoff).
5. **Interactive token reliability.** `/IT` requires a logged-in interactive
   session. What happens when nobody is logged in? (Likely the task can't start
   interactively — match the screenshot path's failure message: "is a user logged
   in interactively?", `core.ts:331`.) Document the failure mode and the error text.
6. **Task self-cleanup.** The screenshot path deletes the schtask after the file
   appears. A long-running job can't wait synchronously. Decide: does the launcher
   `schtasks /Delete` immediately after `/Run` (the runner keeps going in its
   session), or does the task linger? (Hypothesis: delete right after `/Run` — the
   spawned process is detached from the task once started. Validate this.)
7. **Spool location + quoting.** Use `$env:USERPROFILE\.fleet\jobs\<id>\` to mirror
   `$HOME/.fleet/jobs/<id>/`. Confirm the path round-trips and that `<id>`
   (`[a-z0-9-]`) needs no quoting. Note any `$HOME` vs `$env:USERPROFILE` mismatch
   that the cross-OS read functions must account for.

## Steps

### Step 1: Read the precedents and confirm the contract

Read `src/jobs.ts:1-119` (the Linux launcher + spool contract) and
`src/core.ts:306-333` (the `/IT` interactive-task precedent). Note exactly which
fields the cross-OS readers (`listJobs`, `jobLog`, `jobTail`, `waitJob`, `killJob`,
`pruneJobs`) expect, so the Windows spool matches byte-for-byte where it matters
(especially: `exit` present ⇒ done; `out` is combined stdout+stderr; `started` is
epoch seconds; `pid` is what liveness checks against).

**Verify**: you can list, for each reader, the spool file it touches and the format
it expects.

### Step 2: Draft the Windows runner + launcher in `scripts/win-job-spike.ps1`

Write a self-contained PowerShell prototype. Shape (adapt as the open questions
resolve):

- Accept an `<id>`, a `<command>` (base64'd to dodge quoting, decoded on host — mirror
  `linuxSpawnScript`'s `printf … | base64 -d` with PowerShell `[Convert]::FromBase64String`),
  and an optional `<cwd>`.
- Compute `$dir = "$env:USERPROFILE\.fleet\jobs\$id"`; `New-Item -ItemType Directory`.
- Write `cmd`, `cwd`, `started` (epoch via `[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()`).
- Generate a runner `.ps1` that: `Set-Location $cwd`; runs the command with output
  redirected to `out` (`*>`); writes `$LASTEXITCODE` to `exit`.
- Launch the runner via `schtasks /Create … /IT /F` + `/Run`; record the PID per the
  Q1 decision; `schtasks /Delete` per the Q6 decision.
- Print `OK <id> <pid>` (so a future `spawnJob` Windows branch can parse it exactly
  like the Linux branch parses `/OK\s+(\S+)\s+(\d+)/`, `jobs.ts:115`).

Keep it runnable directly on a Windows host: `powershell -File scripts\win-job-spike.ps1 <args>`.

**Verify**: `bun run typecheck` → exit 0 (you added no `.ts`; this just confirms you
didn't accidentally touch `src/`).

### Step 3: Draft the PowerShell read/kill/list snippets

In the design doc, include working PowerShell equivalents (validated in Step 5 where
possible) for each verb the production follow-up will need:
- **log**: `Get-Content -LiteralPath "$dir\out"`
- **tail**: `Get-Content -LiteralPath "$dir\out" -Tail N`
- **wait**: poll for `$dir\exit`; with `until`, `Select-String -Pattern <rx> -Path "$dir\out"`
- **kill**: `taskkill /T /F /PID <pid>` (or `Stop-Process -Id <pid>`)
- **list**: enumerate `$base\*`, derive status from `exit` presence + `Get-Process`
- **prune**: remove dirs with `exit` (and `dead` when `--all`), never a running one

### Step 4: Write `docs/design/windows-jobs.md`

Structure:
1. **Problem & constraint** (interactive token / session-0 limitation).
2. **Chosen approach** (schtasks `/IT` runner, mirroring the screenshot precedent).
3. **Windows spool contract** (the same 7 files, `$env:USERPROFILE\.fleet\jobs\<id>\`).
4. **Answers to the 7 open questions**, each with the evidence from your prototype.
5. **PowerShell snippets** for launcher + every read/kill verb (from Steps 2–3).
6. **Production follow-up plan** — the concrete `src/jobs.ts` changes a later plan
   will make: replace the `WINDOWS_TODO` stub with a `windowsSpawnScript`; lift the
   `h.os !== "windows"` filters in `listJobs`/`pruneJobs` and branch by `h.os`; add
   PowerShell branches to `jobLog`/`jobTail`/`waitJob`/`killJob` (note `jobFollow`
   needs a Windows `Get-Content -Wait` equivalent or stays Linux-only).
7. **Risks & non-goals** (no-one-logged-in failure mode; no true SIGTERM; follow
   `tail -f` deferred).

**Verify**: `docs/design/windows-jobs.md` exists and answers all 7 open questions.

### Step 5: Validate on a real Windows host (if one is reachable)

If `fleet ls` shows a reachable Windows host with an interactive session:

1. Push the spike script: `bun run src/cli.ts cp scripts/win-job-spike.ps1 <winhost>:C:/Users/<you>/win-job-spike.ps1`
   (or run it inline via `fleet exec <winhost> --wsl`? no — it's PowerShell; use a
   direct `fleet exec <winhost> "<the script contents>"` or `cp` then invoke).
2. Launch a test job (e.g. a command that writes a line, sleeps 10s, exits 3):
   `bun run src/cli.ts exec <winhost> "powershell -File C:\Users\<you>\win-job-spike.ps1 spiketest <b64cmd>"`.
3. Confirm, by reading the spool over `fleet exec`:
   - `…\.fleet\jobs\spiketest\out` fills with the command's output;
   - `pid` is present and `Get-Process -Id <pid>` shows it running mid-job;
   - after ~10s, `exit` contains `3`;
   - `taskkill /T /F /PID <pid>` during the job stops it and no `exit` (or a
     nonzero) is recorded — matching `dead` semantics.

Record the actual outputs in the design doc.

**Verify**: the spool fields populate as designed, or — if no Windows host is
reachable — the doc clearly marks Step 5 as "NOT YET VALIDATED — needs a logged-in
Windows host" and lists the exact manual steps above for whoever has one.

## Test plan

- This is a spike; there is no unit-test deliverable. Validation is the hands-on
  run in Step 5 against a real Windows host (or a clearly-marked "pending validation"
  if none is available).
- The production follow-up plan (in the design doc) is where automated tests for the
  Windows launcher/parse path get specified — out of scope here.

## Done criteria

ALL must hold:

- [ ] `docs/design/windows-jobs.md` exists and answers all 7 open questions, with
      the Windows spool contract and PowerShell snippets for every verb.
- [ ] `scripts/win-job-spike.ps1` exists and is self-contained (runnable on a
      Windows host with one command).
- [ ] Step 5 is either completed with recorded real outputs, OR explicitly marked
      "pending validation — needs a logged-in Windows host" with the manual steps.
- [ ] No `src/` file is modified (`git diff --stat -- src/` is empty);
      `bun run typecheck` exits 0.
- [ ] `git status` shows only the new doc, the new script, and `plans/README.md`.
- [ ] `plans/README.md` status row for 007 updated (DONE if validated; BLOCKED with
      "needs Windows host for validation" if Step 5 couldn't run).

## STOP conditions

Stop and report back (do not improvise) if:

- No Windows host is reachable AND you cannot otherwise validate the `/IT` runner —
  deliver the design + prototype and set the status to BLOCKED with the reason; do
  not fabricate validation results.
- The `/IT` approach fails in a way the screenshot precedent doesn't hit (e.g. the
  runner starts but can't see the GPU) — document the failure and STOP; that's a
  finding for the design doc, not something to code around.
- You find yourself editing `src/jobs.ts` — that's the follow-up plan, not this
  spike. Stop and move the work into the design doc's "production follow-up" section.

## Maintenance notes

- The production follow-up (wiring `src/jobs.ts`) should be a separate plan, scoped
  from this doc's section 6. It will need to lift the `h.os !== "windows"` filters
  and branch every job verb by OS — a reviewer should check no Linux behavior
  regresses.
- `jobFollow` (live `tail -f`) has no clean MCP analogue and an awkward Windows one
  (`Get-Content -Wait`); the design doc should explicitly mark it Linux-only for now.
- Once Windows spawn works, plan 006's `fleet_spawn` MCP tool starts succeeding on
  Windows hosts with no change (it already calls `spawnJob`); update that tool's
  "Linux/mac only" description then.
