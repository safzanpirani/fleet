import { test, expect, describe, spyOn } from "bun:test";
import { interpreterFor, buildScriptCommand, diffLines, extensionFromShebang, readScriptSource, runScript, planEdits, lineStyle, parseEditList, editRemoteFile } from "../src/core.ts";
import type { FleetConfig } from "../src/config.ts";
import * as ssh from "../src/ssh.ts";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

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

  test("PowerShell interpreters get a temp .ps1 and -File, never stdin", () => {
    // `pwsh -` echoed every line of a piped script, a secret included.
    const src = "$secret = 'hunter2'\nWrite-Output ok\n";
    for (const [interp, os] of [["pwsh", "windows"], ["powershell.exe", "windows"], ["C:\\pw\\pwsh.exe", "windows"], ["pwsh", "linux"]] as const) {
      const cmd = buildScriptCommand(src, interp, os, "auto");
      expect(cmd).toContain(`${interp} -NoProfile -NonInteractive -File`);
      expect(cmd).not.toMatch(/\| *&? *\S*pwsh\S* -$/m);
      expect(cmd).not.toContain("hunter2");
      const b64 = cmd.match(/'([A-Za-z0-9+/=]{20,})'/)![1]!;
      expect(Buffer.from(b64, "base64").toString("utf8")).toBe(src);
    }
    expect(buildScriptCommand(src, "pwsh", "windows", "auto")).toContain("finally { Remove-Item");
    expect(buildScriptCommand(src, "pwsh", "linux", "auto")).toContain(`trap 'rm -rf "$fleet_ps_dir"' EXIT`);
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

describe("buildScriptCommand arguments", () => {
  const args = ["a", "b c", "it's", "$HOME"];
  const run = async (cmd: string) => {
    const p = Bun.spawn(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, err).toBe(0);
    return out.trim();
  };

  test("a native shell script sees them as $1… byte for byte", async () => {
    const cmd = buildScriptCommand(`printf '[%s]' "$@"`, null, "linux", "auto", args);
    expect(await run(cmd)).toBe("[a][b c][it's][$HOME]");
  });

  test("stdin interpreters get them after their stdin marker", async () => {
    expect(await run(buildScriptCommand("import sys; print(sys.argv[1:])", "python3", "linux", "auto", args)))
      .toBe(`['a', 'b c', "it's", '$HOME']`);
    expect(await run(buildScriptCommand("console.log(JSON.stringify(process.argv.slice(2)))", "bun", "linux", "auto", args)))
      .toBe(JSON.stringify(args));
    expect(await run(buildScriptCommand(`printf '[%s]' "$@"`, "bash", "linux", "auto", args))).toBe("[a][b c][it's][$HOME]");
  });

  test("PowerShell targets quote each one for PowerShell", () => {
    const native = buildScriptCommand("param($x) $x", null, "windows", "auto", args);
    expect(native).toContain(`try { & $fleetPs 'a' 'b c' 'it''s' '$HOME'; $fleetPsCode = $LASTEXITCODE }`);
    expect(buildScriptCommand("print(1)", "python", "windows", "auto", ["it's"])).toContain(`| & python - 'it''s'`);
    expect(buildScriptCommand("echo $1", "bash", "windows", "auto", ["x"])).toContain(`| & bash -s 'x'`);
    expect(buildScriptCommand("$args", "pwsh", "linux", "auto", ["x"])).toContain(`-File "$fleet_ps_dir/script.ps1" 'x'`);
  });

  test("no arguments keeps every form unchanged", () => {
    expect(buildScriptCommand("echo hi\n", null, "linux", "auto", [])).toBe("echo hi\n");
    expect(buildScriptCommand("$x = 1\n", null, "windows", "auto")).toBe("$x = 1\n");
    expect(buildScriptCommand("x", "bun", "linux", "auto")).toContain("| bun -");
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

describe("diffLines line endings", () => {
  test("a CRLF file renders without carriage returns", () => {
    expect(diffLines("a\r\nb\r\n", "a\r\nc\r\n", 0)).toBe("- 2 b\n+ 2 c");
  });

  test("a stray CR in an LF file stays visible", () => {
    expect(diffLines("a\nb\n", "a\nb\r\n", 0)).toBe("- 2 b\n+ 2 b␍");
  });
});

describe("planEdits", () => {
  const ok = (text: string, edits: Parameters<typeof planEdits>[1]) => {
    const plan = planEdits(text, edits, "f");
    if (!plan.ok) throw new Error(plan.error);
    return plan;
  };
  const err = (text: string, edits: Parameters<typeof planEdits>[1]) => {
    const plan = planEdits(text, edits, "f");
    if (plan.ok) throw new Error("expected a failure");
    return plan.error;
  };

  test("lineStyle tells uniform files from mixed ones", () => {
    expect(lineStyle("a\r\nb\r\n")).toBe("crlf");
    expect(lineStyle("a\nb\n")).toBe("lf");
    expect(lineStyle("a\r\nb\n")).toBe("mixed");
    expect(lineStyle("\nb")).toBe("lf");
    expect(lineStyle("one line")).toBe("none");
  });

  test("a multi-line --old typed with LF matches a CRLF file, and --new keeps CRLF", () => {
    const plan = ok("class A {\r\n  get x() { return 1; }\r\n}\r\n",
      [{ old: "  get x() { return 1; }\n}", new: "  get x() { return 2; }\n  get y() { return 3; }\n}" }]);
    expect(plan.next).toBe("class A {\r\n  get x() { return 2; }\r\n  get y() { return 3; }\r\n}\r\n");
    expect(plan.lineEndings).toBe("crlf");
    expect(lineStyle(plan.next)).toBe("crlf");
  });

  test("a single-line --old with a multi-line --new does not leave bare LF in a CRLF file", () => {
    const plan = ok("var a := 1\r\nvar b := 2\r\n", [{ old: "var a := 1", new: "var a := 1\nvar c := 3" }]);
    expect(plan.next).toBe("var a := 1\r\nvar c := 3\r\nvar b := 2\r\n");
  });

  test("CRLF text in --old matches an LF file", () => {
    const plan = ok("a\nb\nc\n", [{ old: "a\r\nb", new: "x\r\ny" }]);
    expect(plan.next).toBe("x\ny\nc\n");
    expect(plan.lineEndings).toBe("lf");
  });

  test("single-line edits report no line-ending conversion", () => {
    expect(ok("a\r\nb\r\n", [{ old: "a", new: "z" }]).lineEndings).toBeUndefined();
  });

  test("a mixed file is matched exactly and the miss names the line-ending cause", () => {
    expect(err("a\r\nb\nc\r\n", [{ old: "a\nb", new: "x" }])).toContain("matches at line 1 once line endings are ignored");
  });

  test("a whitespace miss names the match location without quoting file content", () => {
    const e = err("if x:\n\treturn 1\n", [{ old: "if x:\n    return 1", new: "" }]);
    expect(e).toContain("--old not found in f");
    expect(e).toContain('matches at line 1 once whitespace is ignored');
    expect(e).not.toContain("return 1");
  });

  test("trailing whitespace in the file is explained", () => {
    expect(err("key = 1  \nnext\n", [{ old: "key = 1\nnext" }])).toContain("once whitespace is ignored");
  });

  test("a letter-case miss is explained", () => {
    expect(err("A\nModel = 1\n", [{ old: "model = 1" }])).toContain("matches at line 2 once whitespace and letter case are ignored");
  });

  test("a multi-line miss names the first line that diverges", () => {
    const e = err("get {\n  return a;\n}\nend\n", [{ old: "get {\n  return b;\n}" }]);
    expect(e).toContain('--old line 1 matches line 1, then --old line 2 differs at file line 2');
  });

  test("a multi-line miss whose first line is absent says so", () => {
    expect(err("a\nb\n", [{ old: "zzz\nb" }])).toContain("its first line does not appear in the file either");
  });

  test("an ambiguous match lists the lines", () => {
    expect(err("x\ny\nx\n", [{ old: "x" }])).toContain("matches 2 times in f (lines 1, 3) — pass --all");
  });

  test("edits apply in order and all of them count", () => {
    const plan = ok("a b a\n", [{ old: "a", new: "c", all: true }, { old: "b", new: "d" }, { old: "c d", new: "e" }]);
    expect(plan.next).toBe("e c\n");
    expect(plan.replacements).toBe(4);
  });

  test("one failing edit fails the list and names its position", () => {
    const e = err("a\nb\n", [{ old: "a", new: "x" }, { old: "missing" }]);
    expect(e.startsWith("edit 2 of 2: --old not found in f")).toBe(true);
  });

  test("an ambiguous edit in a list points at the per-edit all", () => {
    expect(err("x x\ny\n", [{ old: "y", new: "z" }, { old: "x" }])).toContain('set "all": true on this edit');
  });

  test("a miss caused by an earlier edit says so", () => {
    expect(err("a\n", [{ old: "a", new: "b" }, { old: "a", new: "c" }])).toContain("an earlier edit in this list changed that text");
  });
});

describe("parseEditList", () => {
  test("parses old/new/all and defaults nothing", () => {
    expect(parseEditList('[{"old":"a","new":"b"},{"old":"c","all":true}]', "stdin"))
      .toEqual([{ old: "a", new: "b" }, { old: "c", all: true }]);
  });

  test("refuses unknown keys, empty old, and non-arrays", () => {
    expect(() => parseEditList('[{"old":"a","replace":"b"}]', "e.json")).toThrow('unknown key "replace"');
    expect(() => parseEditList('[{"old":""}]', "e.json")).toThrow('item 1 needs a non-empty string "old"');
    expect(() => parseEditList('{"old":"a"}', "e.json")).toThrow("non-empty JSON array");
    expect(() => parseEditList("[]", "e.json")).toThrow("non-empty JSON array");
    expect(() => parseEditList("[", "e.json")).toThrow("not valid JSON");
    expect(() => parseEditList('[{"old":"a","all":"yes"}]', "e.json")).toThrow('non-boolean "all"');
  });
});


describe("edit review regressions", () => {
  test("divergent lines and substring neighbours never enter miss diagnostics", () => {
    for (const [text, old] of [
      ["prefix get {\r\nSECRET=PRIVATE_PLACEHOLDER\r\n}\r\n", "get {\nreturn b;\n}"],
      ["key =  1 PRIVATE_PLACEHOLDER\n", "key = 1"],
    ]) {
      const plan = planEdits(text!, [{ old: old! }], "f");
      expect(plan.ok).toBe(false);
      expect(JSON.stringify(plan)).not.toContain("PRIVATE_PLACEHOLDER");
    }
    expect(planEdits("prefix a\r\nb\r\n", [{ old: "a\nc" }], "f"))
      .toMatchObject({ ok: false, error: expect.stringContaining("file line 2") });
  });

  test("diagnostics bound whitespace and repeated-prefix work and treat regex symbols literally", () => {
    for (const [text, old] of [
      [" ".repeat(500_000), " missing"],
      ["a\n".repeat(20_000), "a\n".repeat(10_000) + "missing"],
      ["a\n", "x".repeat(100_000)],
      ["a".repeat(500_000), ".*[not](here)?$"],
    ]) expect(planEdits(text!, [{ old: old! }], "f").ok).toBe(false);
    expect(planEdits("[a].* =  1\n", [{ old: "[a].* = 1" }], "f"))
      .toMatchObject({ ok: false, error: expect.stringContaining("whitespace is ignored") });
  }, 2000);

  test("BOM, CRLF input, lone CR and missing final newline survive adaptation", () => {
    expect(planEdits("\uFEFFa\r\nb", [{ old: "a\r\nb", new: "c\r\nd" }], "f"))
      .toEqual({ ok: true, next: "\uFEFFc\r\nd", replacements: 1 });
    expect(planEdits("a\rb\r\nc", [{ old: "a\rb\nc", new: "x\ry\nz" }], "f"))
      .toEqual({ ok: true, next: "x\ry\r\nz", replacements: 1, lineEndings: "crlf" });
    expect(planEdits("a\rb", [{ old: "a\rb", new: "c\nd" }], "f"))
      .toEqual({ ok: true, next: "c\nd", replacements: 1 });
    expect(planEdits("a", [{ old: "a", new: "b\r\nc" }], "f"))
      .toEqual({ ok: true, next: "b\r\nc", replacements: 1 });
  });

  test("mixed files stay exact and all replacements use converted literal text", () => {
    expect(planEdits("a\r\nb\nc", [{ old: "a\r\nb", new: "x\ny" }], "f"))
      .toEqual({ ok: true, next: "x\ny\nc", replacements: 1 });
    expect(planEdits("a\r\nb\r\na\r\nb", [{ old: "a\nb", new: "$&\nx", all: true }], "f"))
      .toEqual({ ok: true, next: "$&\r\nx\r\n$&\r\nx", replacements: 2, lineEndings: "crlf" });
  });

  test("style is recalculated after each edit, and the earlier-edit hint uses original style", () => {
    expect(planEdits("a", [{ old: "a", new: "b\r\nc" }, { old: "b\nc", new: "d\ne" }], "f"))
      .toEqual({ ok: true, next: "d\r\ne", replacements: 2, lineEndings: "crlf" });
    expect(planEdits("a\r\nb", [{ old: "a\nb", new: "x" }, { old: "a\nb" }], "f"))
      .toMatchObject({ ok: false, error: expect.stringContaining("an earlier edit") });
    expect(planEdits("a", [{ old: "a", new: "b\r\nc" }, { old: "missing\nc" }], "f"))
      .toMatchObject({ ok: false, error: expect.not.stringContaining("an earlier edit") });
  });

  test("ambiguity locations agree with non-overlapping replacement count", () => {
    expect(planEdits("a\na\na\na\na", [{ old: "a\na" }], "f"))
      .toMatchObject({ ok: false, error: expect.stringContaining("matches 2 times in f (lines 1, 3)") });
    expect(planEdits("x\r\nx\r\nx\r\nx\r\nx\r\nx", [{ old: "x" }], "f"))
      .toMatchObject({ ok: false, error: expect.stringContaining("lines 1, 2, 3, 4, 5, …") });
  });

  test("diffs display lone CR bytes even in otherwise uniform CRLF files", () => {
    expect(diffLines("head\r\ntail\r", "head\r\ntail", 0)).toBe("- 2 tail␍\n+ 2 tail");
    expect(diffLines("a\rb\r\n", "ab\r\n", 0)).toBe("- 1 a␍b\n+ 1 ab");
    expect(diffLines("tail", "tail\r\n", 0)).toContain("+ 1 tail␍");
  });

  test("a failed or dry-run list makes no write; success makes one checked write", async () => {
    const cfg = { hosts: { local: { name: "local", ssh: "unused", os: "linux" } } } as FleetConfig;
    const text = "\uFEFFa\r\nb\r\n";
    const b64 = Buffer.from(text).toString("base64");
    const execute = spyOn(ssh, "exec").mockImplementation(async (host, command) => ({
      host: host.name, ok: true, code: 0, stderr: "", ms: 0,
      stdout: command.includes("base64 <") && !command.includes("fleet-tmp") ? b64 : "",
    }));
    try {
      for (const last of ["missing", "\n"]) {
        execute.mockClear();
        const [result] = await editRemoteFile(cfg, "local", "f", [{ old: "a", new: "x" }, { old: last }]);
        expect(result!.ok).toBe(false);
        expect(result!.error).toContain("edit 2 of 2");
        expect(execute).toHaveBeenCalledTimes(1);
      }
      const edits = [{ old: "a", new: "x" }, { old: "b", new: "y\nz" }];
      execute.mockClear();
      const [preview] = await editRemoteFile(cfg, "local", "f", edits, { dryRun: true });
      expect(preview).toMatchObject({ ok: true, replacements: 2, lineEndings: "crlf" });
      expect(execute).toHaveBeenCalledTimes(1);
      execute.mockClear();
      const [written] = await editRemoteFile(cfg, "local", "f", edits);
      expect(written).toEqual(preview);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[1]![1]).toContain(`[ "$cur" = '${b64}' ]`);
      expect(execute.mock.calls[1]![1]).toContain(Buffer.from("\uFEFFx\r\ny\r\nz\r\n").toString("base64"));
    } finally { execute.mockRestore(); }
  });

  test("edit-list validation rejects invalid items and nullable fields", () => {
    for (const json of ['[null]', '[[]]', '[1]', '[{}]', '[{"old":1}]', '[{"old":"a","new":null}]', '[{"old":"a","all":null}]'])
      expect(() => parseEditList(json, "fixture")).toThrow();
  });
});

// The fake ssh runs only a local shell. No configured host receives a command.
describe("edit CLI lists", () => {
  test("stdin and local lists preserve JSON output and fail before reading invalid stdin", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-edit-cli-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const fakeSsh = join(bin, "ssh");
    writeFileSync(fakeSsh, "#!/bin/sh\nexec /bin/bash -s\n");
    chmodSync(fakeSsh, 0o755);
    const config = join(root, "config.json"), target = join(root, "target"), list = join(root, "edits.json");
    writeFileSync(config, JSON.stringify({ hosts: { local: { ssh: "unused", os: "mac" } } }));
    const run = (args: string[]) => Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "edit", ...args], {
      env: { ...process.env, FLEET_CONFIG: config, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
      stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 10_000, killSignal: "SIGKILL",
    });
    const finish = async (proc: ReturnType<typeof run>) => {
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code };
    };
    try {
      const data = JSON.stringify([{ old: "a", new: "x" }, { old: "b", new: "y\nz" }]);
      writeFileSync(list, data);
      for (const src of [list, "-"]) {
        writeFileSync(target, "a\r\nb");
        const proc = run([`local:${target}`, "--edits", src, "--json"]);
        if (src === "-") proc.stdin.write(data);
        proc.stdin.end();
        const result = await finish(proc);
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject([{ ok: true, replacements: 2, lineEndings: "crlf" }]);
        expect(await Bun.file(target).text()).toBe("x\r\ny\r\nz");
      }
      const empty = join(root, "empty-old");
      writeFileSync(empty, "");
      const cases = [
        ["--edits", "-"],
        [`local:${target}`, "--old-file", empty, "--new-file", "-"],
        [`local:${target}`, "--old-file", "-", "--new", "x", "--new-file", "unused"],
        [`local:${target}`, "--old", "", "--new-file", "-"],
        ...["--old=x", "--new=x", "--old-file=unused", "--new-file=unused", "--all"].map((clash) => [`local:${target}`, "--edits", "-", clash]),
      ];
      for (const args of cases) {
        const proc = run(args); // Keep stdin open: validation must finish without EOF.
        const result = await finish(proc);
        proc.stdin.end();
        expect(result.code, result.stderr).toBe(1);
        expect(result.stderr).toMatch(/usage:|not both|cannot be empty|requires a value|--edits replaces/);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
    // Eleven cold CLI starts in sequence; a loaded machine needs the headroom.
  }, 60_000);
});

test("ordinary shell commands still support pipelines and redirection", async () => {
  const { runExec } = await import("../src/core.ts");
  const root = mkdtempSync(join(tmpdir(), "fleet-shell-mode-"));
  const cfg: FleetConfig = { hosts: { local: { name: "local", ssh: "fixture-local", os: "linux" } } };
  const execute = spyOn(ssh, "exec").mockImplementation(async (h, command) => {
    const p = Bun.spawn(["bash", "-c", command], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { host: h.name, ok: code === 0, code, stdout, stderr };
  });
  try {
    const [r] = await runExec(cfg, "local", "printf 'one\\ntwo\\n' | tail -n 1 > result; cat result");
    expect(r).toMatchObject({ ok: true, stdout: "two\n" });
    expect(await Bun.file(join(root, "result")).text()).toBe("two\n");
  } finally { execute.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
