import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { didYouMean, editDistance, suggest, suggestionThreshold } from "../src/suggest.ts";
import { resolveHosts } from "../src/config.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import { parseFlags, runRecipe } from "../src/core.ts";
import { resolveTool } from "../src/tools.ts";

describe("suggest", () => {
  test("counts adjacent transposition as one edit", () => {
    expect(editDistance("exce", "exec")).toBe(1);
    expect(editDistance("wnibox", "winbox")).toBe(1);
    expect(editDistance("ca", "abc")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
  });
  test("scales the threshold with input length", () => {
    expect(suggestionThreshold("abcde")).toBe(1);
    expect(suggestionThreshold("abcdefgh")).toBe(2);
    expect(suggestionThreshold("abcdefghi")).toBe(3);
    expect(suggest("dsik", ["disk"])).toEqual(["disk"]);
    expect(suggest("ab", ["xy"])).toEqual([]);
  });
  test("suggests near names, nearest first, at most three", () => {
    expect(suggest("exce", ["exec", "edit", "ls"])).toEqual(["exec"]);
    expect(suggest("--jsno", ["--json", "--raw"])).toEqual(["--json"]);
    expect(suggest("EXEC", ["exec"])).toEqual(["exec"]);
    expect(suggest("xyz", ["exec", "edit"])).toEqual([]);
    expect(suggest("ab", ["aa", "ac", "ad", "ae"])).toEqual(["aa", "ac", "ad"]);
    expect(suggest("stauts", ["stats", "status"])).toEqual(["stats", "status"]);
    expect(suggest("exec", ["exec"])).toEqual([]);
  });
  test("formats an appendable hint", () => {
    expect(didYouMean("winbx", ["winbox", "web"])).toBe(" — did you mean: winbox?");
    expect(didYouMean("zzzz", ["winbox"])).toBe("");
  });
});

const host = (name: string, os: Host["os"]): Host => ({ name, ssh: name, os });
const cfg: FleetConfig = {
  hosts: { webbox: host("webbox", "linux"), winbox: host("winbox", "windows") },
  groups: { cloud: ["webbox"] },
  recipes: { deploy: ["exec webbox true"] },
  tools: { widget: { root: "/tmp/widget" } } as unknown as FleetConfig["tools"],
};

describe("did-you-mean wiring", () => {
  test("selector expansion suggests hosts and groups", () => {
    expect(() => resolveHosts(cfg, "webbxo")).toThrow(/unknown host: webbxo \(have: webbox, winbox\) — did you mean: webbox\?/);
    expect(() => resolveHosts(cfg, "@clodu")).toThrow(/unknown group @clodu .* — did you mean: @cloud\?/);
    expect(() => resolveHosts(cfg, "@zzzzzz")).toThrow(/custom: cloud\)$/);
  });
  test("option, recipe and tool errors suggest near names", async () => {
    expect(() => parseFlags(["--jsno"], ["--json"], ["--cwd"])).toThrow("unknown option: --jsno (try fleet help) — did you mean: --json?");
    await expect(runRecipe(cfg, "delpoy")).rejects.toThrow("unknown recipe 'delpoy' (have: deploy) — did you mean: deploy?");
    expect(() => resolveTool(cfg, "widgte")).toThrow("unknown tool 'widgte' (have: widget) — did you mean: widget?");
  });
  test("an unrelated name gets no hint", () => {
    expect(() => resolveHosts(cfg, "qqqqqq")).toThrow(/^unknown host: qqqqqq \(have: webbox, winbox\)$/);
  });
});

describe("did-you-mean CLI", () => {
  const cli = join(import.meta.dir, "../src/cli.ts");
  async function run(args: string[], config: string) {
    const proc = Bun.spawn(["bun", cli, ...args], {
      env: { ...process.env, FLEET_CONFIG: config, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }
  test("unknown command and host keep exit 1 and the fixed JSON envelope", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-dym-"));
    const config = join(root, "fleet.config.json");
    writeFileSync(config, JSON.stringify({ hosts: { local: { ssh: "local", os: "linux" } } }));
    try {
      const command = await run(["exce", "local", "true"], config);
      expect(command.code).toBe(1);
      expect(command.stderr).toContain("unknown command: exce (try: fleet help) — did you mean: exec?");

      const human = await run(["exec", "lcoal", "true"], config);
      expect(human.code).toBe(1);
      expect(human.stderr).toContain("unknown host: lcoal (have: local) — did you mean: local?");

      const json = await run(["exec", "--json", "lcoal", "true"], config);
      expect(json.code).toBe(1);
      expect(JSON.parse(json.stdout)).toEqual({
        ok: false, command: "exec",
        error: { code: "UNKNOWN_SELECTOR", message: "The selector does not resolve to configured hosts." },
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
