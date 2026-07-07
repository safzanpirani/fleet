# Plan 004: Reuse SSH connections via ControlMaster/ControlPersist

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat b6eab9b..HEAD -- src/ssh.ts test/ssh.test.ts README.md`
> If any changed since this plan was written, compare the "Current state" excerpts
> against the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (control-socket lifecycle; an escape hatch mitigates it)
- **Depends on**: 001 (updates `buildArgs` assertions that 001 writes in `test/ssh.test.ts`)
- **Category**: perf
- **Planned at**: commit `b6eab9b`, 2026-06-26

## Why this matters

Every `fleet` operation spawns a brand-new `ssh`/`scp` process with no connection
reuse. A `fleet exec all "uptime"` opens N independent SSH connections, each paying
a full TCP + key-exchange + auth handshake. Worse, the polling loops re-handshake
on every interval: `fleet wait` and `fleet jobs wait` call `exec`/`probeOnce` every
3 seconds for the entire wait, so a 2-minute wait is ~40 fresh SSH logins to the
same box. OpenSSH solves exactly this with connection multiplexing
(`ControlMaster`/`ControlPersist`): the first connection to a host becomes a master
and subsequent connections ride the existing channel, cutting per-call latency from
a full handshake to near-zero. This plan adds those options to every `ssh`/`scp`
invocation, with an env escape hatch for debugging.

## Current state

`src/ssh.ts` builds ssh/scp argv in several places, each starting with the same
base options and **no** multiplexing:

- `resolveWinBin` probe (line 64): `["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host.ssh, "powershell", …]`
- `buildArgs` (line 79): `const ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host.ssh];`
- `probe` (line 138): `["ssh", "-o", "BatchMode=yes", "-o", \`ConnectTimeout=${connectTimeout}\`, host.ssh, "echo ok"]`
- `execStream` (line 155): `["ssh", "-tt", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host.ssh, "bash", "-lc", command]`
- `sshInteractive` (line 163): `["ssh", host.ssh]`
- `scp` (line 172): `["scp", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", local, \`${host.ssh}:${remote}\`]`
- `scpPull` (line 186): `["scp", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", \`${host.ssh}:${remote}\`, local]`

The CLI is `darwin` (macOS) — see the environment; the local `ssh` client supports
ControlMaster. The control socket must live in a directory that exists (ssh won't
create it) and whose path stays short (macOS unix-socket paths are limited to ~104
chars). Using `~/.fleet/ssh/cm-%C` keeps it short: `%C` is a hash of
`(local_host, remote_host, port, user)`, so it's a fixed-length, filesystem-safe
token and never collides across hosts.

There is an existing convention for env-driven config at the top of the file:
`const PROBE_CAP_MS = Number(process.env.FLEET_PROBE_TIMEOUT_MS ?? 4000);` (line 135).

Plan 001's `test/ssh.test.ts` asserts the exact ssh argv for `buildArgs` (e.g.
`expect(args.slice(-2)).toEqual(["bash", "-ls"])` and that the command is not on the
command line). Those assertions still hold after this change (we insert options
near the front, not at the end), but you will add a new assertion that the control
options are present, and a test for the `FLEET_NO_SSH_MUX` escape hatch.

## Commands you will need

| Purpose       | Command                          | Expected             |
|---------------|----------------------------------|----------------------|
| Typecheck     | `bun run typecheck`              | exit 0, no output    |
| Unit tests    | `bun test test/ssh.test.ts`      | all pass             |
| Full suite    | `bun test`                       | all pass             |
| Manual timing | (see Step 5 — optional, needs a reachable host) | 2nd call faster |

## Scope

**In scope**:
- `src/ssh.ts` — add a `sshControlOpts()` helper + a one-time control-dir
  creation, and insert the control options into every ssh/scp argv listed above.
- `test/ssh.test.ts` — assert the control options appear in `buildArgs` output and
  that `FLEET_NO_SSH_MUX=1` removes them.
- `README.md` — one line documenting `FLEET_NO_SSH_MUX`.

**Out of scope** (do NOT touch):
- `BatchMode=yes` / `ConnectTimeout` options — keep them exactly as-is; only
  **add** control options alongside.
- Any change to what command runs or how stdin is fed — this plan only changes
  connection management, never the payload.
- `src/core.ts`, `src/cli.ts`, `src/server.ts`, the job/dashboard logic — untouched.

## Git workflow

- Branch `advisor/004-ssh-multiplexing` if asked; else commit on the current
  branch. Message e.g. `perf(ssh): multiplex connections via ControlMaster/ControlPersist`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add the control-options helper to `src/ssh.ts`

Near the top of the file (after the imports, before `b64utf8`), add:

```ts
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// ── SSH connection multiplexing ──────────────────────────────────────────────
// Reuse one master connection per host instead of re-handshaking on every exec/
// probe/scp/poll. The control socket lives under ~/.fleet/ssh/ (created once);
// `%C` is a short fixed-length hash of (localhost, remotehost, port, user), so the
// path stays well under the macOS unix-socket length limit. Disable with
// FLEET_NO_SSH_MUX=1 (useful when debugging a wedged socket).
const SSH_MUX = process.env.FLEET_NO_SSH_MUX !== "1";
let _muxDir: string | null = null;
function controlOpts(): string[] {
  if (!SSH_MUX) return [];
  if (_muxDir === null) {
    _muxDir = join(homedir(), ".fleet", "ssh");
    try { mkdirSync(_muxDir, { recursive: true }); } catch { /* best-effort; ssh falls back to no-mux if the socket can't be made */ }
  }
  return ["-o", "ControlMaster=auto", "-o", `ControlPath=${join(_muxDir, "cm-%C")}`, "-o", "ControlPersist=60s"];
}
```

> Note: `tsconfig.json` has `verbatimModuleSyntax: true`; `homedir`, `mkdirSync`,
> and `join` are value imports (not types), so plain `import { … }` is correct.
> `join` may already be conceptually used elsewhere, but it is NOT currently
> imported in `ssh.ts` — add the import as shown.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Insert the control options into every ssh/scp argv

In each location, splice `...controlOpts()` immediately after the `"ssh"` (or
`"scp"`) token, before the existing `-o BatchMode=yes`. Apply to all of these:

1. `resolveWinBin` probe (line 64) — `["ssh", ...controlOpts(), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host.ssh, "powershell", …]`
2. `buildArgs` (line 79) — `const ssh = ["ssh", ...controlOpts(), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host.ssh];`
3. `probe` (line 138) — `["ssh", ...controlOpts(), "-o", "BatchMode=yes", "-o", \`ConnectTimeout=${connectTimeout}\`, host.ssh, "echo ok"]`
4. `execStream` (line 155) — `["ssh", "-tt", ...controlOpts(), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host.ssh, "bash", "-lc", command]`
5. `sshInteractive` (line 163) — `["ssh", ...controlOpts(), host.ssh]`
6. `scp` (line 172) — `["scp", ...controlOpts(), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", local, \`${host.ssh}:${remote}\`]`
7. `scpPull` (line 186) — `["scp", ...controlOpts(), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", \`${host.ssh}:${remote}\`, local]`

`scp` accepts `-o ControlPath=…` and reuses an existing master, so the same options
are valid for both `ssh` and `scp`.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Update the `buildArgs` assertions in `test/ssh.test.ts`

The existing 001 assertions that check the **tail** of `args` (e.g.
`args.slice(-2)` is `["bash", "-ls"]`) and that the command isn't on the command
line still hold — keep them. Add a new test in the linux describe block:

```ts
test("ssh argv enables connection multiplexing by default", () => {
  const { args } = buildArgs(linux, "true", "bash");
  expect(args).toContain("ControlMaster=auto");
  expect(args.some((a) => a.startsWith("ControlPath="))).toBe(true);
  expect(args).toContain("ControlPersist=60s");
  // control options come before the host/command, never replacing them
  expect(args.slice(-2)).toEqual(["bash", "-ls"]);
});
```

> The escape-hatch (`FLEET_NO_SSH_MUX`) is read **once** at module load, so it
> can't be toggled mid-test by setting `process.env` after import. Verify it via a
> separate child process instead (Step 4) — do **not** try to flip it inside this
> test file.

**Verify**: `bun test test/ssh.test.ts` → all pass.

### Step 4: Verify the escape hatch with a subprocess test

Add a test that spawns a tiny Bun snippet with `FLEET_NO_SSH_MUX=1` and confirms
`buildArgs` omits the control options. Append to `test/ssh.test.ts`:

```ts
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
```

> `import.meta.dir` is the test file's directory (Bun); the snippet imports the
> source by absolute path. If `bun -e` import resolution fails in your environment,
> see STOP conditions — don't paper over it.

**Verify**: `bun test test/ssh.test.ts` → all pass, including this case.

### Step 5: (Optional) manual timing sanity — only if you have a reachable host

If the config has a host you can SSH to without a password, confirm the win:

```sh
# first call primes the master; second should be visibly faster
bun run src/cli.ts exec <host> "echo one"
time bun run src/cli.ts exec <host> "echo two"
# a multiplexed second connection typically returns in well under a second
ls ~/.fleet/ssh/    # should show a cm-… control socket
```

This is a sanity check, not a gate — skip it if you have no reachable host.

### Step 6: Document the escape hatch in `README.md`

In the Config or Stack section, add:

> - **SSH multiplexing:** fleet reuses one SSH master connection per host
>   (`ControlMaster=auto`, `ControlPersist=60s`, socket under `~/.fleet/ssh/`) so
>   fan-outs and poll loops don't re-handshake. Set `FLEET_NO_SSH_MUX=1` to disable
>   (e.g. if a control socket wedges).

### Step 7: Full verification

**Verify**:
- `bun test` → all pass.
- `bun run typecheck` → exit 0.

## Test plan

- Extend `test/ssh.test.ts`: assert control options present by default (in-process);
  assert absent under `FLEET_NO_SSH_MUX=1` (subprocess, since the flag is read once
  at import).
- Model after the existing `buildArgs` describe block from plan 001.
- Verification: `bun test` → all pass.

## Done criteria

ALL must hold:

- [ ] `bun test` exits 0; the new multiplexing + escape-hatch tests pass.
- [ ] `bun run typecheck` exits 0.
- [ ] `grep -c "controlOpts()" src/ssh.ts` returns 7 (one per ssh/scp argv site).
- [ ] `grep -n "BatchMode=yes" src/ssh.ts` still shows the original options intact
      (control options were **added**, not replaced).
- [ ] `README.md` documents `FLEET_NO_SSH_MUX`.
- [ ] `git status` shows only in-scope files changed.
- [ ] `plans/README.md` status row for 004 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- Any ssh/scp argv site in `src/ssh.ts` doesn't match the "Current state" lines
  (drift) — line numbers may have shifted if plan 003 landed first (it edits the
  `exec` body); locate each site by its surrounding code, not the line number, and
  if a site is missing or differs structurally, STOP.
- The `bun -e` subprocess test (Step 4) can't resolve the source import in your
  environment — report it; an alternative is to write the snippet to a temp file
  under the OS temp dir and run that, but confirm with the operator first.
- A manual `fleet exec` after the change **fails to connect** when it worked before
  (e.g. the control socket path is rejected) — that's a real regression; STOP and
  report. As a first diagnostic, retry with `FLEET_NO_SSH_MUX=1` to confirm the
  control socket is the cause.

## Maintenance notes

- ControlPersist keeps a master alive 60s after the last use; sockets self-reap.
  If a host's SSH config already sets `ControlMaster`/`ControlPath`, fleet's
  command-line `-o` options take precedence (last wins on the command line) — note
  for reviewers who use `~/.ssh/config` multiplexing.
- A wedged control socket manifests as hangs to one specific host; the documented
  fix is `FLEET_NO_SSH_MUX=1` or `rm ~/.fleet/ssh/cm-*`. Consider surfacing that in
  an error hint as a follow-up.
- This interacts with plan 003 (exec timeout): a timed-out `proc.kill()` kills the
  client process but the master may persist; that's fine and intended.
