import { test, expect, describe } from "bun:test";
import { interpreterFor, buildScriptCommand, diffLines, extensionFromShebang, readScriptSource, runScript } from "../src/core.ts";
import type { FleetConfig } from "../src/config.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("interpreterFor", () => {
  test("shell scripts are native on unix, need bash on windows", () => {
    expect(interpreterFor(".sh", "linux")).toBeNull();
    expect(interpreterFor("", "mac")).toBeNull();
    expect(interpreterFor(".sh", "windows")).toBe("bash");
  });

  test("ps1 is native on windows only", () => {
    expect(interpreterFor(".ps1", "windows")).toBeNull();
    expect(interpreterFor(".ps1", "linux")).toBe("pwsh");
  });

  test("python picks the platform's binary name", () => {
    expect(interpreterFor(".py", "linux")).toBe("python3");
    expect(interpreterFor(".py", "windows")).toBe("python");
  });

  test("extension match is case-insensitive", () => {
    expect(interpreterFor(".PY", "linux")).toBe("python3");
  });

  test("unknown extensions fall through to the shell", () => {
    expect(interpreterFor(".conf", "linux")).toBeNull();
  });
});

describe("buildScriptCommand", () => {
  test("a native script is passed through verbatim — no wrapping", () => {
    const src = "echo 'hi';\nls -la\n";
    expect(buildScriptCommand(src, null, "linux", "auto")).toBe(src);
  });

  test("unix + interpreter: source is base64'd, never quoted into the command", () => {
    const src = `print("he said 'hi' \\"there\\"")\n`;
    const cmd = buildScriptCommand(src, "python3", "linux", "auto");
    expect(cmd).toContain("| base64 -d | python3 -");
    // the payload is base64 only — no fragment of the source can reach a parser
    const b64 = cmd.match(/'([A-Za-z0-9+/=]+)'/)![1]!;
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(src);
    expect(cmd).not.toContain("he said");
  });

  test("windows + interpreter: decoded in-process and piped to stdin", () => {
    const src = "import sys; print(sys.argv)\n";
    const cmd = buildScriptCommand(src, "python", "windows", "auto");
    expect(cmd).toContain("FromBase64String");
    expect(cmd).toContain("| & python -");
  });

  test("a wsl target uses the bash form even though the host is windows", () => {
    const cmd = buildScriptCommand("x=1\n", "python3", "linux", "wsl");
    expect(cmd).toContain("base64 -d | python3 -");
    expect(cmd).not.toContain("FromBase64String");
  });

  test("quotes and newlines in the source cannot escape the wrapper", () => {
    const nasty = `'; rm -rf /; echo '\n"$(whoami)"\n`;
    const cmd = buildScriptCommand(nasty, "python3", "linux", "auto");
    expect(cmd).not.toContain("rm -rf");
    expect(cmd).not.toContain("whoami");
  });
});

describe("readScriptSource", () => {
  test("derives the extension from the path, not from a dot in a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-script-"));
    const p = join(dir, "run.py");
    writeFileSync(p, "print(1)\n");
    return readScriptSource(p).then((s) => {
      expect(s.ext).toBe(".py");
      expect(s.source).toBe("print(1)\n");
      expect(s.label).toBe(p);
    });
  });

  test("an extensionless file reports no extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet.d-"));   // dot in the DIRECTORY name
    const p = join(dir, "runme");
    writeFileSync(p, "echo hi\n");
    return readScriptSource(p).then((s) => expect(s.ext).toBe(""));
  });

  test("a missing file fails fast", async () => {
    await expect(readScriptSource("/nope/does-not-exist.sh")).rejects.toThrow(/script not found/);
  });
});

describe("stdin script language", () => {
  test("infers common env and direct shebangs", () => {
    expect(extensionFromShebang("#!/usr/bin/env python3\nprint(1)\n")).toBe(".py");
    expect(extensionFromShebang("#!/usr/bin/env -S bun run\nconsole.log(1)\n")).toBe(".ts");
    expect(extensionFromShebang("#!/bin/bash\necho ok\n")).toBe(".sh");
  });

  test("requires an interpreter for untyped stdin before contacting a host", async () => {
    const cfg = { hosts: { local: { name: "local", ssh: "local", os: "linux" } } } as FleetConfig;
    await expect(runScript(cfg, "local", { source: "print(1)\n", ext: "", label: "<stdin>" }))
      .rejects.toThrow("needs --interp");
  });
});

describe("diffLines", () => {
  test("identical input produces no diff", () => {
    expect(diffLines("a\nb\n", "a\nb\n")).toBe("");
  });

  test("shows the changed line with surrounding context", () => {
    const before = "one\ntwo\nthree\nfour\nfive\n";
    const after = "one\ntwo\nTHREE\nfour\nfive\n";
    const d = diffLines(before, after);
    expect(d).toContain("- 3 three");
    expect(d).toContain("+ 3 THREE");
    expect(d).toContain("  2 two");     // context before
    expect(d).toContain("  4 four");    // context after
  });

  test("context is bounded — distant lines are not included", () => {
    const before = ["a", "b", "c", "TARGET", "d", "e", "f"].join("\n");
    const after = before.replace("TARGET", "CHANGED");
    const d = diffLines(before, after, 1);
    expect(d).toContain("- 4 TARGET");
    expect(d).toContain("  3 c");
    expect(d).toContain("  5 d");
    expect(d).not.toContain("a");       // 3 lines away, outside ctx=1
    expect(d).not.toContain("f");
  });

  test("handles added lines (after is longer)", () => {
    const d = diffLines("a\nb\n", "a\nx\ny\nb\n");
    expect(d).toContain("+ 2 x");
    expect(d).toContain("+ 3 y");
  });

  test("separated edits never print the unchanged middle with zero context", () => {
    const before = "old\nPRIVATE_PLACEHOLDER\nold\n";
    const after = "new\nPRIVATE_PLACEHOLDER\nnew\n";
    const d = diffLines(before, after, 0);
    expect(d).toContain("- 1 old");
    expect(d).toContain("+ 3 new");
    expect(d).not.toContain("PRIVATE_PLACEHOLDER");
  });

  test("separated edits align unchanged lines after inserted lines", () => {
    const d = diffLines("old\nPRIVATE_PLACEHOLDER\nold\n", "new\nextra\nPRIVATE_PLACEHOLDER\nnew\nextra\n", 0);
    expect(d).toContain("+ 2 extra");
    expect(d).toContain("+ 5 extra");
    expect(d).not.toContain("PRIVATE_PLACEHOLDER");
  });

  test("a repeated later line cannot pull an unchanged neighbor into a unique replacement", () => {
    const before = "old\nPRIVATE_PLACEHOLDER\nold";
    const after = before.replace("old\n", "new\n");
    expect(diffLines(before, after, 0)).toBe("- 1 old\n+ 1 new");
  });

  test("separated edits preserve repeated unchanged lines inside the changed region", () => {
    const before = "old\nrepeat\nPRIVATE_PLACEHOLDER\nrepeat\nold";
    const after = "new\nrepeat\nPRIVATE_PLACEHOLDER\nrepeat\nnew";
    expect(diffLines(before, after, 0)).toBe("- 1 old\n+ 1 new\n- 5 old\n+ 5 new");
  });

  test("a small edit in a large file trims unchanged prefix and suffix before alignment", () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `unchanged ${i}`);
    const before = lines.join("\n");
    lines[10_000] = "replacement";
    expect(diffLines(before, lines.join("\n"), 0)).toBe("- 10001 unchanged 10000\n+ 10001 replacement");
  });

  test("oversized alignment returns a bounded summary without source contents", () => {
    const middle = Array.from({ length: 2000 }, (_, i) => `PRIVATE_PLACEHOLDER ${i}`).join("\n");
    const d = diffLines(`old\n${middle}\nold`, `new\n${middle}\nnew`, 0);
    expect(d).toContain("Diff omitted:");
    expect(d).not.toContain("PRIVATE_PLACEHOLDER");
    expect(d.length).toBeLessThan(150);
  });
});
