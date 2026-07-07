# Plan 002: Stop `exec`/`spawn` from hijacking flags that appear inside the command

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat b6eab9b..HEAD -- src/cli.ts src/core.ts README.md`
> If any of those changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (must preserve the documented flags; changes where flags may appear)
- **Depends on**: 001 (this plan adds tests to `test/core.test.ts`, created by 001)
- **Category**: bug
- **Planned at**: commit `b6eab9b`, 2026-06-26

## Why this matters

`fleet`'s headline promise is "pass the command verbatim, never pre-escape it"
(`server.ts:152-157`, `README.md:1-7`). But the CLI breaks that promise for any
command containing `--json`, `--raw`, `--wsl`, or `--cwd`. In `src/cli.ts`, the
`exec` and `spawn` handlers call `pullFlag`/`pullVal` over the **entire** argument
list *before* picking out the selector, so those tokens are consumed wherever they
appear — including in the middle of the remote command. Concretely:

- `fleet exec oracle "npm run build --json"` → `--json` is stripped from the
  remote command (npm runs without it) **and** fleet silently switches to JSON
  output.
- `fleet exec oracle "rsync --cwd /data /bak"` → `--cwd` plus the **next token**
  (`/data`) are eaten: the remote command becomes `rsync /bak` and fleet runs it
  in `/data`.

These fail silently — no error, wrong command. This plan makes flag parsing stop
at the selector: everything from the selector onward is the verbatim command.

## Current state

`src/cli.ts`, `exec` handler (lines 99-116):

```ts
    case "exec": {
      const json = pullFlag(rest, "--json");
      const wsl = pullFlag(rest, "--wsl");
      const raw = pullFlag(rest, "--raw"); // print ONLY remote stdout …
      const cwd = pullVal(rest, "--cwd");  // run in this dir …
      const sel = rest.shift();
      const cmd = rest.join(" ");
      if (!sel || !cmd) die("usage: fleet exec <sel> <cmd…> [--cwd dir] [--wsl] [--raw] [--json]");
      // a bare machine name (dual-boot box) auto-routes to whichever boot is live
      let target = sel!;
      if (!sel!.includes(",") && !sel!.startsWith("@") && !cfg.hosts[sel!] && cfg.machines?.[sel!])
        target = await resolveLiveHost(cfg, sel!);
      const results = await runExec(cfg, target, cmd, { wsl, cwd });
      …
```

`src/cli.ts`, `spawn` handler (lines 118-131):

```ts
    case "spawn": {
      const json = pullFlag(rest, "--json");
      const cwd = pullVal(rest, "--cwd");
      const sel = rest.shift();
      const cmd = rest.join(" ");
      if (!sel || !cmd) die("usage: fleet spawn <sel> <cmd…> [--cwd dir] [--json]");
      const results = await spawnJob(cfg, sel!, cmd, { cwd });
      …
```

The `pullFlag`/`pullVal` helpers (in `src/core.ts:14-26`) are correct primitives —
they just scan the whole array. The bug is **where** they are applied. The fix is a
small dedicated parser that consumes fleet flags only from the **prefix** (before
the selector) and treats the selector and everything after it as positional.

Existing convention to match: `pullFlag`/`pullVal` live in `src/core.ts` under the
"tiny arg helpers" comment (lines 13-37); add the new helper next to them and
export it (so plan 001's `test/core.test.ts` can cover it).

The help text in `src/cli.ts` (lines 62-64) currently advertises flags *after* the
command:

```
  fleet exec <sel> <cmd…>         run a command, blocking   (--cwd, --wsl, --raw, --json)
  fleet spawn <sel> <cmd…>        launch a detached job (outlives ssh)   (--cwd)
```

`README.md` shows the same ordering (lines 23-24, 50):

```
fleet exec oracle "./build.sh" --cwd /srv/app   # run in a dir; fails fast if missing
fleet spawn oracle "./train.sh" --cwd /srv/app  # detached job that outlives ssh -> job id
```

After this change, **fleet flags must precede the selector**; the help/README
must be updated to reflect that (Step 4).

## Commands you will need

| Purpose         | Command                                     | Expected               |
|-----------------|---------------------------------------------|------------------------|
| Typecheck       | `bun run typecheck`                         | exit 0, no output      |
| Unit tests      | `bun test test/core.test.ts`                | all pass               |
| Full suite      | `bun test`                                  | all pass               |
| Manual sanity   | `bun run src/cli.ts exec --help` (or `help`)| prints updated usage   |

## Scope

**In scope**:
- `src/core.ts` — add and export a `parseLeadingFlags` helper.
- `src/cli.ts` — rewrite the flag-parsing prologue of `exec` and `spawn` to use it; update the inline help block and the two `die("usage: …")` strings.
- `README.md` — move the example flags before the selector; add one line noting flags precede the selector.
- `test/core.test.ts` — add tests for `parseLeadingFlags` (file exists once plan 001 lands).

**Out of scope** (do NOT touch):
- The `runExec`/`spawnJob` core functions — their signatures don't change.
- Other subcommands (`jobs`, `cp`, `restart`, `logs`, `shot`, `cu`, `wait`, …).
  They take structured positionals, not a free-form remote command, so flag-anywhere
  parsing is acceptable there. Changing them is scope creep and risks regressions.
- The MCP tools (`server.ts`) — they receive `selector`/`command` as separate
  typed fields, so they were never affected by this bug.

## Git workflow

- Branch `advisor/002-exec-flag-parsing` if asked to branch; else commit on the
  current branch. Message e.g. `fix(exec): parse fleet flags before the selector, not inside the command`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add `parseLeadingFlags` to `src/core.ts`

Add this next to `pullVal` (after line 26), in the "tiny arg helpers" section:

```ts
/** Parse fleet's own flags from the LEADING run of tokens, stopping at the first
 *  non-flag token (the selector). Everything from the selector onward is returned
 *  verbatim as `rest` — so flags that appear *inside* a remote command are never
 *  consumed. Boolean flags set `true`; value flags consume the next token.
 *  Usage: `fleet exec [--flags] <selector> <command…>`. */
export function parseLeadingFlags(
  argv: string[], boolFlags: readonly string[], valFlags: readonly string[],
): { flags: Record<string, string | true>; rest: string[] } {
  const flags: Record<string, string | true> = {};
  let i = 0;
  for (; i < argv.length; i++) {
    const t = argv[i]!;
    if (boolFlags.includes(t)) { flags[t] = true; continue; }
    if (valFlags.includes(t)) { flags[t] = argv[i + 1] ?? ""; i++; continue; }
    break; // first non-flag token = the selector
  }
  return { flags, rest: argv.slice(i) };
}
```

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Rewrite the `exec` handler prologue in `src/cli.ts`

Replace lines 100-106 (from `const json = pullFlag(rest, "--json");` through the
`if (!sel || !cmd) die(…)` line) with:

```ts
      const { flags, rest: pos } = parseLeadingFlags(rest, ["--json", "--wsl", "--raw"], ["--cwd"]);
      const json = flags["--json"] === true;
      const wsl = flags["--wsl"] === true;
      const raw = flags["--raw"] === true; // print ONLY remote stdout — no header/indent (for piping/backup)
      const cwd = typeof flags["--cwd"] === "string" && flags["--cwd"] ? flags["--cwd"] : undefined;
      const sel = pos.shift();
      const cmd = pos.join(" ");
      if (!sel || !cmd) die("usage: fleet exec [--cwd dir] [--wsl] [--raw] [--json] <sel> <cmd…>");
```

Leave the rest of the `exec` case (the `let target = sel!` dual-boot routing and
the `runExec` call) unchanged — it already reads `sel`/`cmd`/`wsl`/`cwd`/`json`/`raw`.

Add `parseLeadingFlags` to the import from `./core.ts` at the top of `cli.ts`
(line 33-38 import block — it already imports `pullFlag, pullVal`).

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Rewrite the `spawn` handler prologue in `src/cli.ts`

Replace lines 119-123 (from `const json = pullFlag(rest, "--json");` through the
`if (!sel || !cmd) die(…)` line) with:

```ts
      const { flags, rest: pos } = parseLeadingFlags(rest, ["--json"], ["--cwd"]);
      const json = flags["--json"] === true;
      const cwd = typeof flags["--cwd"] === "string" && flags["--cwd"] ? flags["--cwd"] : undefined;
      const sel = pos.shift();
      const cmd = pos.join(" ");
      if (!sel || !cmd) die("usage: fleet spawn [--cwd dir] [--json] <sel> <cmd…>");
```

Leave the rest of the `spawn` case unchanged.

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Update help text and README to put flags before the selector

In `src/cli.ts`, in the help block (lines 62-64), change the `exec` and `spawn`
lines so the flag ordering reads naturally as a prefix. Replace:

```
  fleet exec <sel> <cmd…>         run a command, blocking   (--cwd, --wsl, --raw, --json)
  fleet spawn <sel> <cmd…>        launch a detached job (outlives ssh)   (--cwd)
```

with:

```
  fleet exec [flags] <sel> <cmd…>  run a command, blocking   (flags: --cwd dir --wsl --raw --json, before <sel>)
  fleet spawn [flags] <sel> <cmd…> launch a detached job (outlives ssh)   (flags: --cwd dir --json, before <sel>)
```

In `README.md`, update the Usage examples (lines 23-24) and the Detached-jobs
example (line 50) to put flags before the selector, e.g.:

```
fleet exec --cwd /srv/app oracle "./build.sh"   # run in a dir; fails fast if missing
fleet spawn --cwd /srv/app oracle "./train.sh"  # detached job that outlives ssh -> job id
```

and (line 50):

```
fleet spawn --cwd /srv/app oracle "long-running-thing"   # -> host:id, then detaches
```

Add one clarifying line near the Usage block (after line 39 or in the Detached
jobs section), e.g.:

> Fleet's own flags (`--cwd`, `--wsl`, `--raw`, `--json`) go **before** the
> selector; everything after the selector is the command, passed through verbatim.

**Verify**: `bun run src/cli.ts help` prints the updated `exec`/`spawn` lines.

### Step 5: Add tests to `test/core.test.ts`

Append a `describe` block to `test/core.test.ts` (created by plan 001). First add
`parseLeadingFlags` to the import line at the top of that file.

```ts
describe("parseLeadingFlags (flags precede the selector)", () => {
  const parse = (s: string) => parseLeadingFlags(s.split(" "), ["--json", "--wsl", "--raw"], ["--cwd"]);

  test("leading boolean + value flags are consumed; selector starts the rest", () => {
    const { flags, rest } = parse("--json --cwd /srv oracle echo hi");
    expect(flags["--json"]).toBe(true);
    expect(flags["--cwd"]).toBe("/srv");
    expect(rest).toEqual(["oracle", "echo", "hi"]);
  });

  test("flags INSIDE the command are NOT consumed (the bug this fixes)", () => {
    const { flags, rest } = parse("oracle npm run build --json");
    expect(flags["--json"]).toBeUndefined();
    expect(rest).toEqual(["oracle", "npm", "run", "build", "--json"]);
  });

  test("--cwd inside the command does not eat the following token", () => {
    const { flags, rest } = parse("oracle rsync --cwd /data /bak");
    expect(flags["--cwd"]).toBeUndefined();
    expect(rest.join(" ")).toBe("oracle rsync --cwd /data /bak");
  });

  test("no flags at all", () => {
    const { flags, rest } = parse("all uptime");
    expect(Object.keys(flags)).toHaveLength(0);
    expect(rest).toEqual(["all", "uptime"]);
  });
});
```

**Verify**: `bun test test/core.test.ts` → all pass, including the 4 new cases.

### Step 6: Full verification

**Verify**:
- `bun test` → all pass.
- `bun run typecheck` → exit 0.
- Optional live sanity (only if you have a reachable host in the config — skip if
  not): `bun run src/cli.ts exec <host> 'echo done --json'` should print a normal
  (non-JSON) result whose stdout contains `done --json`, proving `--json` stayed in
  the command.

## Test plan

- Add the `parseLeadingFlags` describe block above to `test/core.test.ts`.
- Cases: leading flags consumed; flag inside command preserved; `--cwd` inside
  command doesn't eat the next token; no-flags passthrough.
- Model after the existing blocks in `test/core.test.ts`.
- Verification: `bun test` → all pass.

## Done criteria

ALL must hold:

- [ ] `bun test` exits 0; the 4 new `parseLeadingFlags` cases pass.
- [ ] `bun run typecheck` exits 0.
- [ ] `grep -n "pullFlag(rest" src/cli.ts` shows the `exec` and `spawn` handlers no
      longer use `pullFlag`/`pullVal` for `--json/--wsl/--raw/--cwd` (other
      subcommands may still legitimately use them).
- [ ] `bun run src/cli.ts help` shows flags listed before `<sel>` for exec/spawn.
- [ ] `README.md` examples put flags before the selector and include the
      clarifying note.
- [ ] `git status` shows only in-scope files changed.
- [ ] `plans/README.md` status row for 002 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The `exec`/`spawn` handlers in `src/cli.ts` don't match the "Current state"
  excerpts (drift) — e.g. someone already changed flag parsing.
- `test/core.test.ts` does not exist (plan 001 hasn't landed). Either run plan 001
  first, or create the file following 001's Step 6 structure and note it in your
  status row — but do not skip the tests.
- You find another subcommand that takes a free-form remote command and is also
  affected (you believe the bug is wider than `exec`/`spawn`). Report it; don't
  expand scope unilaterally.

## Maintenance notes

- This is a deliberate UX change: fleet flags now go **before** the selector.
  A reviewer should confirm the help text and README reflect that and that no
  other subcommand regressed.
- If a future flag is added to `exec`/`spawn`, add it to the appropriate
  `boolFlags`/`valFlags` array passed to `parseLeadingFlags` — not to a separate
  `pullFlag` call.
- Deferred: a `--` end-of-flags separator (e.g. `fleet exec oracle -- <cmd>`) was
  considered and not done; the prefix rule is simpler and sufficient. Revisit only
  if users want flags after the selector back.
