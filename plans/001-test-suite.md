# Plan 001: Add a `bun test` suite covering the quoting-proof core

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat b6eab9b..HEAD -- src/ssh.ts src/config.ts src/jobs.ts src/core.ts package.json tsconfig.json`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `b6eab9b`, 2026-06-26

## Why this matters

`fleet`'s entire reason to exist is that **any** command round-trips verbatim
over SSH/PowerShell/WSL without quoting pain (see `README.md:1-7`). That promise
lives in a handful of pure functions — `buildArgs` and the escaping helpers in
`src/ssh.ts`, selector expansion in `src/config.ts`, job-ref/id handling in
`src/jobs.ts`, and the arg/command builders in `src/core.ts`. **None of them have
a single automated test.** The only existing "tests" (`scripts/smoke.ts`,
`scripts/smoke-http.ts`) require a live fleet and a running dashboard, so there is
no way to know the quoting logic still works after a refactor without SSHing into
real machines. This plan adds a zero-infrastructure `bun test` suite over those
pure functions, so any future change (including the fixes in plans 002–004) has a
fast correctness gate.

## Current state

- `bun test` is available (Bun 1.3.11) but finds **0 test files**:
  `error: 0 test files matching … in --cwd=…`.
- `package.json` has no `test` script (only `fleet`, `mcp`, `serve`, `typecheck`).
- `tsconfig.json` `include` is `["src"]` only.
- The functions to test are mostly **module-private** (not `export`ed). You will
  add `export` to the specific symbols listed in Step 2 so tests can import them.

Key facts about the runner and config:
- `package.json` (lines 11-16):
  ```json
  "scripts": {
    "fleet": "bun run src/cli.ts",
    "mcp": "bun run src/mcp.ts",
    "serve": "bun run src/http.ts",
    "typecheck": "tsgo --noEmit"
  },
  ```
- `tsconfig.json` is strict with `"noUncheckedIndexedAccess": true`,
  `"allowImportingTsExtensions": true`, `"types": ["bun"]`. Tests import source
  with explicit `.ts` extensions (e.g. `import { buildArgs } from "../src/ssh.ts"`).
- `bun:test` provides `describe`, `test`, `expect` (types come from `@types/bun`,
  already a devDependency).

The functions under test (read these in the live files to confirm signatures):

- `src/ssh.ts`:
  - `bashEsc` (line 39): `s.replace(/'/g, "'\\''")` — single-quote escape for bash.
  - `psEsc` (line 40): `s.replace(/'/g, "''")` — single-quote doubling for PowerShell.
  - `withCwdBash` (lines 41-44): prepends `cd -- '<esc>' || { echo …; exit 127; }\n`.
  - `withCwdPwsh` (lines 45-47): prepends `Set-Location -LiteralPath '<esc>' -ErrorAction Stop\n`.
  - `buildArgs` (lines 75-100): the central command-construction function.
    Signature: `buildArgs(host: Host, command: string, shell: Shell, winBin: WinBin = "powershell", cwd?: string): { args: string[]; stdin?: Uint8Array }`.
    - linux/mac: returns `args` ending in `["bash", "-ls"]` and `stdin` = UTF-8 of `command + "\n"` (or the cwd-wrapped script + "\n").
    - windows + `shell === "powershell"`: `args` contains `"-EncodedCommand"` followed by base64-of-UTF-16LE of the script; **no stdin**.
    - windows + `shell === "wsl"`: the EncodedCommand decodes to a string containing `wsl -d <distro> bash -lc "echo <b64> | base64 -d | bash"`.
- `src/config.ts`:
  - `resolveHosts(cfg, sel)` (lines 56-71): expands `"all"`/`"*"`, `@group`,
    comma-mixed selectors; dedupes preserving order; throws on unknown host/group
    and on an empty match.
- `src/jobs.ts`:
  - `ID_RE` / `assertId` (lines 33-39): ids must match `/^[a-z0-9-]+$/`.
  - `newId` (lines 34-36): `${Date.now().toString(36)}-${Math.random()…}` — always
    matches `ID_RE`.
  - `parseRows(host, stdout)` (lines 138-150): parses tab-separated job rows into
    `JobRow[]`.
  - `resolveJobRef(cfg, a, b?)` (lines 62-70): accepts `host id` or collapsed
    `host:id`; validates the id; requires the host selector to resolve to exactly one.
- `src/core.ts`:
  - `splitArgs(s)` (lines 28-37): tokenizes honoring `"double quotes"` (quotes dropped).
  - `pullFlag(rest, flag)` (lines 14-19) / `pullVal(rest, flag)` (lines 20-26):
    array-mutating flag extractors.
  - `restartCmd(svc)` (lines 40-49) / `logsCmd(svc, n)` (lines 50-56): per
    service-type command + shell.
  - `rebootCmd(host)` (lines 623-630): per-OS reboot command + shell.
  - `shellQuote(arg, os)` (lines 387-391): barewords pass through; otherwise single-quote.

## Commands you will need

| Purpose         | Command                          | Expected on success     |
|-----------------|----------------------------------|-------------------------|
| Typecheck       | `bun run typecheck`              | exit 0, no output       |
| Run all tests   | `bun test`                       | all pass, exit 0        |
| Run one file    | `bun test test/ssh.test.ts`      | that file's tests pass  |
| Run via script  | `bun run test`                   | all pass (after Step 1) |

## Scope

**In scope** (the only files you should modify or create):
- `package.json` — add a `test` script.
- `tsconfig.json` — add `"test"` to `include` so tests are typechecked too.
- `src/ssh.ts` — add `export` to `bashEsc`, `psEsc`, `withCwdBash`, `withCwdPwsh`, `buildArgs` (no logic changes).
- `src/jobs.ts` — add `export` to `assertId`, `newId`, `parseRows` (no logic changes).
- `src/core.ts` — add `export` to `shellQuote` (no logic changes).
- `test/ssh.test.ts` (create)
- `test/config.test.ts` (create)
- `test/jobs.test.ts` (create)
- `test/core.test.ts` (create)

**Out of scope** (do NOT touch):
- Any **behavioral** change to the functions under test. This plan only adds
  `export` keywords and tests. If a test reveals a bug, **write the test to assert
  the current behavior**, leave a `// NOTE: …` comment describing the surprise, and
  report it — fixing it belongs to plans 002–004, not here.
- `src/cli.ts`, `src/server.ts`, `src/http.ts`, `src/mcp.ts` — no test coverage in
  this plan (they need a live fleet or a transport).
- `scripts/smoke.ts`, `scripts/smoke-http.ts` — leave as-is.

## Git workflow

- Branch: the repo uses short topic branches (`feat/exec-cwd-and-jobs`). Create
  `advisor/001-test-suite` off the current branch if you are asked to branch;
  otherwise commit on the current branch.
- Commit message style is conventional-ish (`feat:`, `perf+feat:`, `docs:` — see
  `git log`). Use e.g. `test: add bun unit suite for quoting/selector/job core`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the test script and widen the typecheck include

In `package.json`, add a `test` script to the `scripts` block:

```json
  "scripts": {
    "fleet": "bun run src/cli.ts",
    "mcp": "bun run src/mcp.ts",
    "serve": "bun run src/http.ts",
    "typecheck": "tsgo --noEmit",
    "test": "bun test"
  },
```

In `tsconfig.json`, change `"include": ["src"]` to `"include": ["src", "test"]`.

**Verify**: `bun run typecheck` → exit 0, no output. (No tests yet; this just
confirms the config edits are valid.)

### Step 2: Export the symbols the tests need

Add the `export` keyword (and nothing else) to these declarations:

- `src/ssh.ts`: `bashEsc`, `psEsc`, `withCwdBash`, `withCwdPwsh`, `buildArgs`.
  Example: `const bashEsc = …` → `export const bashEsc = …`; `function buildArgs(` → `export function buildArgs(`.
- `src/jobs.ts`: `assertId`, `newId`, `parseRows`.
  Example: `function assertId(` → `export function assertId(`.
- `src/core.ts`: `shellQuote`.
  Example: `function shellQuote(` → `export function shellQuote(`.

**Verify**: `bun run typecheck` → exit 0. (`verbatimModuleSyntax` is on, but these
are value exports, so no `import type` issues arise.)

### Step 3: `test/ssh.test.ts` — the quoting-proof construction

This is the most important file. Create `test/ssh.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { bashEsc, psEsc, withCwdBash, withCwdPwsh, buildArgs } from "../src/ssh.ts";
import type { Host } from "../src/config.ts";

const linux: Host = { name: "oracle", ssh: "oracle", os: "linux" };
const win: Host = { name: "winbox", ssh: "winbox", os: "windows", wsl: "Ubuntu" };

const decodeUtf16 = (b64: string) => Buffer.from(b64, "base64").toString("utf16le");
const decodeUtf8 = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

describe("escaping helpers", () => {
  test("bashEsc closes/escapes/reopens single quotes", () => {
    expect(bashEsc("it's")).toBe("it'\\''s");
  });
  test("psEsc doubles single quotes", () => {
    expect(psEsc("it's")).toBe("it''s");
  });
  test("withCwdBash fails fast on a missing dir and preserves the command", () => {
    const s = withCwdBash("echo hi", "/srv/app");
    expect(s).toContain("cd -- '/srv/app'");
    expect(s).toContain("exit 127");
    expect(s.endsWith("echo hi")).toBe(true);
  });
  test("withCwdPwsh uses Set-Location -LiteralPath with -ErrorAction Stop", () => {
    const s = withCwdPwsh("Get-Date", "C:\\srv");
    expect(s).toContain("Set-Location -LiteralPath 'C:\\srv' -ErrorAction Stop");
    expect(s.endsWith("Get-Date")).toBe(true);
  });
});

describe("buildArgs — linux/mac feed the script over stdin (zero interpolation)", () => {
  const tricky = `echo 'a & b | c' "$HOME" $(whoami) {json:1}`;
  test("ssh argv ends in bash -ls and the command is NOT on the command line", () => {
    const { args, stdin } = buildArgs(linux, tricky, "bash");
    expect(args.slice(-2)).toEqual(["bash", "-ls"]);
    expect(args.join(" ")).not.toContain("whoami"); // command rides stdin only
    expect(new TextDecoder().decode(stdin!)).toBe(tricky + "\n");
  });
  test("--cwd is embedded in the stdin script, not the command line", () => {
    const { args, stdin } = buildArgs(linux, "make", "bash", "powershell", "/srv/app");
    const script = new TextDecoder().decode(stdin!);
    expect(script).toContain("cd -- '/srv/app'");
    expect(script.trimEnd().endsWith("make")).toBe(true);
    expect(args.join(" ")).not.toContain("/srv/app");
  });
});

describe("buildArgs — windows uses EncodedCommand (the shell never parses our quotes)", () => {
  test("powershell: base64-utf16le round-trips the script verbatim, no stdin", () => {
    const cmd = `Write-Output 'a & b'`;
    const { args, stdin } = buildArgs(win, cmd, "powershell");
    expect(stdin).toBeUndefined();
    const i = args.indexOf("-EncodedCommand");
    expect(i).toBeGreaterThan(-1);
    expect(decodeUtf16(args[i + 1]!)).toBe(cmd);
  });
  test("wsl: the encoded script wraps a base64'd bash payload", () => {
    const cmd = `uname -a`;
    const { args } = buildArgs(win, cmd, "wsl");
    const i = args.indexOf("-EncodedCommand");
    const inner = decodeUtf16(args[i + 1]!);
    expect(inner).toContain("wsl -d Ubuntu bash -lc");
    const m = inner.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/);
    expect(m).not.toBeNull();
    expect(decodeUtf8(m![1]!)).toBe(cmd);
  });
});
```

**Verify**: `bun test test/ssh.test.ts` → all tests pass.

### Step 4: `test/config.test.ts` — selector expansion

Create `test/config.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { resolveHosts } from "../src/config.ts";
import type { FleetConfig } from "../src/config.ts";

const cfg: FleetConfig = {
  hosts: {
    a: { name: "a", ssh: "a", os: "linux", gpu: true },
    b: { name: "b", ssh: "b", os: "windows" },
    c: { name: "c", ssh: "c", os: "mac" },
  },
  groups: { home: ["a", "c"] },
};

const names = (sel: string) => resolveHosts(cfg, sel).map((h) => h.name);

describe("resolveHosts", () => {
  test("a single host name", () => expect(names("b")).toEqual(["b"]));
  test('"all" and "*" expand to every host', () => {
    expect(names("all").sort()).toEqual(["a", "b", "c"]);
    expect(names("*").sort()).toEqual(["a", "b", "c"]);
  });
  test("built-in @os groups", () => {
    expect(names("@linux")).toEqual(["a"]);
    expect(names("@windows")).toEqual(["b"]);
    expect(names("@mac")).toEqual(["c"]);
  });
  test("@gpu selects gpu-flagged hosts", () => expect(names("@gpu")).toEqual(["a"]));
  test("custom @group", () => expect(names("@home").sort()).toEqual(["a", "c"]));
  test("comma-mix dedupes and preserves first-seen order", () => {
    expect(names("b,@home,a")).toEqual(["b", "a", "c"]);
  });
  test("unknown host throws", () => expect(() => resolveHosts(cfg, "nope")).toThrow(/unknown host/));
  test("unknown group throws", () => expect(() => resolveHosts(cfg, "@nope")).toThrow(/unknown group/));
  test("empty selector throws", () => expect(() => resolveHosts(cfg, " , ")).toThrow(/no hosts matched/));
});
```

**Verify**: `bun test test/config.test.ts` → all pass.

### Step 5: `test/jobs.test.ts` — ids and ref parsing

Create `test/jobs.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { assertId, newId, parseRows, resolveJobRef } from "../src/jobs.ts";
import type { FleetConfig } from "../src/config.ts";

const cfg: FleetConfig = {
  hosts: {
    oracle: { name: "oracle", ssh: "oracle", os: "linux" },
    a: { name: "a", ssh: "a", os: "linux" },
    b: { name: "b", ssh: "b", os: "linux" },
  },
  groups: { two: ["a", "b"] },
};

describe("assertId / newId", () => {
  test("newId always matches the id regex", () => {
    for (let i = 0; i < 200; i++) expect(() => assertId(newId())).not.toThrow();
  });
  test("assertId rejects path-traversal / shell metacharacters", () => {
    for (const bad of ["../etc", "a b", "a;rm", "a/b", "A1", "a$b"]) {
      expect(() => assertId(bad)).toThrow(/bad job id/);
    }
  });
});

describe("resolveJobRef", () => {
  test('collapsed "host:id" form', () => {
    const r = resolveJobRef(cfg, "oracle:abc-123");
    expect(r.host.name).toBe("oracle");
    expect(r.id).toBe("abc-123");
  });
  test('separate "host id" form', () => {
    expect(resolveJobRef(cfg, "oracle", "abc-123").id).toBe("abc-123");
  });
  test("a bad id is rejected", () => expect(() => resolveJobRef(cfg, "oracle:../x")).toThrow(/bad job id/));
  test("a multi-host selector is rejected", () => expect(() => resolveJobRef(cfg, "@two:abc")).toThrow(/exactly one host/));
  test("a missing id is rejected", () => expect(() => resolveJobRef(cfg, "oracle")).toThrow(/usage/));
});

describe("parseRows", () => {
  test("parses an exited and a running row", () => {
    const out = [
      "mqtn19-9px\texited\t0\t4242\t1700000000\tmy command",
      "abc-1\trunning\t-\t77\t1700000100\ttail -f /var/log/x",
    ].join("\n");
    const rows = parseRows("oracle", out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ host: "oracle", id: "mqtn19-9px", status: "exited", code: 0, pid: 4242, started: 1700000000 });
    expect(rows[1]).toMatchObject({ id: "abc-1", status: "running", code: null, pid: 77 });
    expect(rows[0]!.cmd).toBe("my command");
  });
  test('"-" placeholders become null', () => {
    const rows = parseRows("oracle", "dead-1\tdead\t-\t-\t-\t");
    expect(rows[0]).toMatchObject({ status: "dead", code: null, pid: null, started: null, cmd: "" });
  });
});
```

**Verify**: `bun test test/jobs.test.ts` → all pass.

### Step 6: `test/core.test.ts` — arg parsing and command builders

Create `test/core.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { splitArgs, pullFlag, pullVal, restartCmd, logsCmd, rebootCmd, shellQuote } from "../src/core.ts";
import type { Host } from "../src/config.ts";

describe("splitArgs", () => {
  test("splits on spaces", () => expect(splitArgs("a b c")).toEqual(["a", "b", "c"]));
  test("keeps double-quoted groups together and drops the quotes", () => {
    expect(splitArgs(`echo "hello world" x`)).toEqual(["echo", "hello world", "x"]);
  });
});

describe("pullFlag / pullVal (array-mutating)", () => {
  test("pullFlag removes the flag and returns true", () => {
    const a = ["x", "--json", "y"];
    expect(pullFlag(a, "--json")).toBe(true);
    expect(a).toEqual(["x", "y"]);
  });
  test("pullFlag returns false and leaves the array when absent", () => {
    const a = ["x", "y"];
    expect(pullFlag(a, "--json")).toBe(false);
    expect(a).toEqual(["x", "y"]);
  });
  test("pullVal removes the flag and its value and returns the value", () => {
    const a = ["x", "--cwd", "/srv", "y"];
    expect(pullVal(a, "--cwd")).toBe("/srv");
    expect(a).toEqual(["x", "y"]);
  });
  // NOTE: pullFlag/pullVal scan the WHOLE array. cli.ts calls them before
  // selecting the command, which is the bug plan 002 fixes. These tests pin the
  // primitive's own behavior, which 002 keeps.
});

describe("service + reboot command builders", () => {
  test("systemd restart/logs use bash", () => {
    expect(restartCmd({ type: "systemd", name: "x" })).toEqual({ cmd: "sudo systemctl restart x", shell: "bash" });
    expect(logsCmd({ type: "systemd", name: "x" }, 5)).toEqual({ cmd: "journalctl -u x -n 5 --no-pager", shell: "bash" });
  });
  test("winservice/nssm restart uses powershell Restart-Service", () => {
    expect(restartCmd({ type: "winservice", name: "x" })).toMatchObject({ shell: "powershell" });
    expect(restartCmd({ type: "nssm", name: "x" }).cmd).toContain("Restart-Service");
  });
  test("schtask restart ends then runs", () => {
    expect(restartCmd({ type: "schtask", name: "x" }).cmd).toContain("schtasks /End /TN x");
  });
  test("rebootCmd is per-OS", () => {
    const win: Host = { name: "w", ssh: "w", os: "windows" };
    const lin: Host = { name: "l", ssh: "l", os: "linux" };
    expect(rebootCmd(win)).toMatchObject({ shell: "powershell" });
    expect(rebootCmd(win).cmd).toContain("shutdown /r");
    expect(rebootCmd(lin)).toMatchObject({ shell: "bash" });
    expect(rebootCmd(lin).cmd).toContain("shutdown -r now");
  });
});

describe("shellQuote", () => {
  test("safe barewords pass through unquoted", () => {
    expect(shellQuote("list_apps", "linux")).toBe("list_apps");
    expect(shellQuote("a/b-c_1.2", "linux")).toBe("a/b-c_1.2");
  });
  test("unsafe args are single-quoted, per-OS", () => {
    expect(shellQuote("a b", "linux")).toBe("'a b'");
    expect(shellQuote("it's", "linux")).toBe("'it'\\''s'");
    expect(shellQuote("it's", "windows")).toBe("'it''s'");
  });
});
```

**Verify**: `bun test test/core.test.ts` → all pass.

### Step 7: Full suite + typecheck

**Verify**:
- `bun test` → all four files pass, exit 0. Note the total test count in your
  status update.
- `bun run typecheck` → exit 0, no output (tests are now in `include`).
- `bun run test` → same as `bun test` (script wiring works).

## Test plan

- New files: `test/ssh.test.ts`, `test/config.test.ts`, `test/jobs.test.ts`,
  `test/core.test.ts`, covering the cases enumerated in Steps 3–6.
- There is no existing test to model after (this is the first suite); the
  structure above (top-level `describe` per unit, `test` per case) is the target
  pattern for future tests.
- Verification: `bun test` → all pass.

## Done criteria

ALL must hold:

- [ ] `bun test` exits 0 and reports the new tests passing (4 files).
- [ ] `bun run typecheck` exits 0 with no output.
- [ ] `bun run test` exists and runs the suite.
- [ ] `git status` shows only the in-scope files changed (the 4 test files, plus
      `package.json`, `tsconfig.json`, and `export`-only edits to `src/ssh.ts`,
      `src/jobs.ts`, `src/core.ts`).
- [ ] `git diff src/ssh.ts src/jobs.ts src/core.ts` shows **only added `export`
      keywords**, no logic changes.
- [ ] `plans/README.md` status row for 001 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The code in any "Current state" excerpt doesn't match the live file (drift since
  this plan was written) — especially if a function was renamed or its signature
  changed.
- A test you wrote to assert **current** behavior fails — that means the function
  behaves differently than this plan describes. Report the discrepancy; do not
  "fix" the source to make the test pass (that's a different plan's job).
- `bun:test` types don't resolve (typecheck errors on the `import … from "bun:test"`
  line) — report it rather than adding `// @ts-ignore`.

## Maintenance notes

- Plans 002, 003, and 004 extend `test/core.test.ts` and `test/ssh.test.ts`. Keep
  those files importing from `../src/*.ts` so later plans can add cases without
  restructuring.
- A reviewer should confirm the `src/*.ts` diffs are export-only (no behavior
  change snuck in).
- Deferred: coverage for `cli.ts`/`server.ts` dispatch and the MCP transports —
  those need a fake exec layer or a live host and are out of scope here. A natural
  follow-up is a `bun test` gate in CI (finding DX-2, deferred this round).
