import { test, expect, describe } from "bun:test";
import { parseLeadingFlags } from "../src/core.ts";

// Plan 002: fleet's own flags must only be consumed from the LEADING tokens —
// a --wsl/--json/--cwd appearing inside the remote command is payload, not a flag.
describe("parseLeadingFlags", () => {
  const BOOLS = ["--json", "--wsl", "--raw"] as const;
  const VALS = ["--cwd", "--timeout"] as const;

  test("leading flags are consumed, selector + command left verbatim", () => {
    const { flags, rest } = parseLeadingFlags(
      ["--wsl", "--cwd", "/srv", "winbox", "uname", "-a"], BOOLS, VALS);
    expect(flags["--wsl"]).toBe(true);
    expect(flags["--cwd"]).toBe("/srv");
    expect(rest).toEqual(["winbox", "uname", "-a"]);
  });

  test("flags INSIDE the command are never hijacked", () => {
    const { flags, rest } = parseLeadingFlags(
      ["oracle", "echo", "keep", "--wsl", "these", "--json", "flags", "--cwd", "/x"], BOOLS, VALS);
    expect(flags).toEqual({});
    expect(rest.join(" ")).toBe("echo keep --wsl these --json flags --cwd /x".replace("echo ", "oracle echo "));
  });

  test("a flag-valued token stops nothing: value is taken verbatim", () => {
    const { flags, rest } = parseLeadingFlags(["--cwd", "--json", "vps", "ls"], BOOLS, VALS);
    expect(flags["--cwd"]).toBe("--json"); // consumed as the value, garbage in → visible out
    expect(rest).toEqual(["vps", "ls"]);
  });

  test("no flags at all", () => {
    const { flags, rest } = parseLeadingFlags(["vps", "uptime"], BOOLS, VALS);
    expect(flags).toEqual({});
    expect(rest).toEqual(["vps", "uptime"]);
  });

  test("value flag at end of argv yields empty string, not crash", () => {
    const { flags, rest } = parseLeadingFlags(["--cwd"], BOOLS, VALS);
    expect(flags["--cwd"]).toBe("");
    expect(rest).toEqual([]);
  });
});
