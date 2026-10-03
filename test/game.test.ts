import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  GAME_HELPER_VERSION, gameCallScript, gameDo, gameRelease, gameRequest, gameShorthand, gameStartScript, gameStatus,
  gameStepsMs, gameStepsUseDesktop, parseGameArgv, parseGameMacro, parseGameReply, validateGameSteps, gameStop, prepareGameDo,
} from "../src/game.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import type { ExecResult } from "../src/ssh.ts";

const host = (name: string, os: Host["os"]): Host => ({ name, ssh: name, os });
const cfg: FleetConfig = { hosts: { win: host("win", "windows"), lin: host("lin", "linux") } };
const ok = (stdout: string): ExecResult => ({ host: "win", ok: true, code: 0, stdout, stderr: "" });
const reply = (body: Record<string, unknown>) => ok(`FLEETGAME ${JSON.stringify(body)}\n`);
/** The request a call script carries, decoded from its base64 literal. */
const sentRequest = (script: string) => {
  const m = script.match(/FromBase64String\('([^']+)'\)\)\n\$reply/);
  return m ? JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8")) : undefined;
};

describe("validateGameSteps", () => {
  test("accepts every action in its documented shape", () => {
    expect(() => validateGameSteps([
      { tap: "space" }, { tap: ["ctrl", "s"], ms: 60 }, { hold: "w", ms: 1500 }, { down: "shift" }, { up: "shift" },
      { type: "gg" }, { look: [-300, 40], ms: 200 }, { move: [10, 20] }, { click: "left", at: [5, 5], count: 2 },
      { click: true }, { wheel: -3 }, { stick: "left", xy: [0, 1], ms: 500 }, { trigger: "rt", value: 0.5, ms: 100 },
      { wait: 250 }, { wait_pixel: [100, 50], rgb: [255, 0, 0], tol: 20, timeout: 3000, gone: true }, { shot: true },
      { focus: true }, { repeat: 3, steps: [{ tap: "pad.a" }, { wait: 100 }] },
    ])).not.toThrow();
  });

  test("names the failing step, nested steps included", () => {
    expect(() => validateGameSteps([{ tap: "a" }, { hold: "w" }])).toThrow("step 2: hold needs ms");
    expect(() => validateGameSteps([{ repeat: 2, steps: [{ wait: 1 }, { look: [1] }] }])).toThrow("step 1.2: look must be a [x, y] pair");
  });

  test("refuses two actions in one step, unknown fields and empty lists", () => {
    expect(() => validateGameSteps([{ tap: "a", hold: "b", ms: 5 }])).toThrow("one action per step");
    expect(() => validateGameSteps([{ tap: "a", at: [1, 2] }])).toThrow("tap does not take at");
    expect(() => validateGameSteps([{ press: "a" }])).toThrow("no action");
    expect(() => validateGameSteps([])).toThrow("non-empty array");
  });

  test("bounds numbers that reach the host", () => {
    expect(() => validateGameSteps([{ stick: "left", xy: [0, 2] }])).toThrow("xy[1] must be a number from -1 to 1");
    expect(() => validateGameSteps([{ wheel: 0 }])).toThrow("wheel must not be 0");
    expect(() => validateGameSteps([{ wait_pixel: [1, 1], rgb: [0, 0, 0] }])).toThrow("timeout");
    expect(() => validateGameSteps([{ tap: "a", ms: 1.5 }])).toThrow("ms must be an integer");
    expect(() => validateGameSteps([{ click: "side" }])).toThrow("click takes a button");
  });

  test("limits repeat nesting to four levels", () => {
    const nest = (n: number): object => (n ? { repeat: 1, steps: [nest(n - 1)] } : { wait: 1 });
    expect(() => validateGameSteps([nest(4)])).not.toThrow();
    expect(() => validateGameSteps([nest(5)])).toThrow("repeat nests at most 4 deep");
  });
});

describe("step analysis", () => {
  test("keyboard, mouse and pixel steps need a target; pad steps do not", () => {
    expect(gameStepsUseDesktop([{ tap: "pad.a" }, { stick: "left", xy: [1, 0] }, { wait: 5 }])).toBe(false);
    expect(gameStepsUseDesktop([{ tap: ["pad.a", "w"] }])).toBe(true);
    expect(gameStepsUseDesktop([{ repeat: 2, steps: [{ look: [1, 1] }] }])).toBe(true);
    expect(gameStepsUseDesktop([{ wait_pixel: [1, 1], rgb: [0, 0, 0], timeout: 5 }])).toBe(true);
  });

  test("the time estimate covers holds, waits, repeats and the default tap", () => {
    expect(gameStepsMs([{ tap: "a" }, { hold: "w", ms: 1000 }, { wait: 500 }])).toBe(1540);
    expect(gameStepsMs([{ repeat: 3, steps: [{ wait: 100 }] }])).toBe(300);
    expect(gameStepsMs([{ wait_pixel: [0, 0], rgb: [0, 0, 0], timeout: 2000 }])).toBe(2000);
  });
});

describe("parseGameMacro", () => {
  test("takes a bare array or {target, repeat, steps}", () => {
    expect(parseGameMacro('[{"tap":"e"}]')).toEqual({ steps: [{ tap: "e" }] });
    expect(parseGameMacro('{"target":"game","repeat":0,"steps":[{"tap":"e"}]}'))
      .toEqual({ target: "game", repeat: 0, steps: [{ tap: "e" }] });
  });

  test("refuses unknown fields and bad JSON", () => {
    expect(() => parseGameMacro('{"steps":[{"tap":"e"}],"loop":3}', "farm.json")).toThrow("farm.json has unknown field(s) loop");
    expect(() => parseGameMacro("[{tap}]", "farm.json")).toThrow("farm.json is not JSON");
  });
});

describe("parseGameArgv", () => {
  test("keeps negative numbers and a bare dash as operands", () => {
    expect(parseGameArgv(["main", "look", "game", "-300", "-20", "--ms", "200"]))
      .toEqual({ flags: { "--ms": "200" }, pos: ["main", "look", "game", "-300", "-20"] });
    expect(parseGameArgv(["main", "do", "-", "-", "--shot"]).pos).toEqual(["main", "do", "-", "-"]);
  });

  test("rejects unknown options and missing values", () => {
    expect(() => parseGameArgv(["main", "frame", "--bogus"])).toThrow("unknown option: --bogus");
    expect(() => parseGameArgv(["main", "frame", "--max"])).toThrow("--max requires a value");
    expect(() => parseGameArgv(["main", "frame", "--max", "--json"])).toThrow("--max requires a value");
  });
});

describe("gameShorthand", () => {
  test("maps each verb to its steps", () => {
    expect(gameShorthand("tap", ["e"])).toEqual([{ tap: "e" }]);
    expect(gameShorthand("tap", ["ctrl", "s"], { ms: 60 })).toEqual([{ tap: ["ctrl", "s"], ms: 60 }]);
    expect(gameShorthand("hold", ["w", "shift", "2000"])).toEqual([{ hold: ["w", "shift"], ms: 2000 }]);
    expect(gameShorthand("look", ["-300", "0"], { ms: 150 })).toEqual([{ look: [-300, 0], ms: 150 }]);
    expect(gameShorthand("click", ["10", "20"], { button: "right" })).toEqual([{ click: "right", at: [10, 20] }]);
    expect(gameShorthand("pad", ["a"])).toEqual([{ tap: "pad.a", ms: 80 }]);
    expect(gameShorthand("stick", ["left", "0", "1"], { ms: 900 })).toEqual([{ stick: "left", xy: [0, 1], ms: 900 }]);
    expect(gameShorthand("trigger", ["rt"])).toEqual([{ trigger: "rt", value: 1 }]);
  });

  test("refuses missing or non-numeric operands", () => {
    expect(() => gameShorthand("hold", ["w"])).toThrow("usage: hold");
    expect(() => gameShorthand("look", ["left", "0"])).toThrow("dx must be a number");
  });
});

describe("remote scripts", () => {
  test("the helper version is the sha256 prefix of the helper source the host runs", async () => {
    const source = await readFile(new URL("../src/game-helper.py", import.meta.url));
    expect(GAME_HELPER_VERSION).toBe(createHash("sha256").update(source).digest("hex").slice(0, 12));
  });

  test("a call carries the request base64-encoded and never as script text", () => {
    const script = gameCallScript({ op: "do", steps: [{ type: "'; Remove-Item C:\\ -Recurse; '" }] });
    expect(script).not.toContain("Remove-Item");
    expect(sentRequest(script)).toEqual({ op: "do", steps: [{ type: "'; Remove-Item C:\\ -Recurse; '" }] });
  });

  test("a call refuses an older helper before sending, unless any version will do", () => {
    expect(gameCallScript({ op: "do" })).toContain("stale = $true");
    expect(gameCallScript({ op: "release" }, true)).not.toContain("stale = $true");
  });

  test("start installs only when asked, and runs the helper elevated in the console session", () => {
    const script = gameStartScript({ install: false });
    expect(script).toContain("$install = $false");
    expect(script).toContain("-LogonType Interactive -RunLevel Highest");
    expect(script).toContain("ExecutionTimeLimit ([TimeSpan]::Zero)");
    expect(gameStartScript({ install: true, force: true })).toContain("$install = $true; $force = $true");
  });

  test("parseGameReply takes the last marker line and keeps the progress lines", () => {
    const r = parseGameReply(ok('installing\r\n  done\nFLEETGAME {"ok":true,"pid":4}\n'));
    expect(r.reply).toEqual({ ok: true, pid: 4 });
    expect(r.log).toEqual(["installing", "  done"]);
    expect(() => parseGameReply({ host: "win", ok: false, code: 1, stdout: "", stderr: "boom" }))
      .toThrow("game helper call on win failed (exit 1): boom");
  });
});

describe("gameRequest", () => {
  test("starts a stopped helper, then sends the request exactly once", async () => {
    const scripts: string[] = [];
    let calls = 0;
    const r = await gameRequest(cfg, "win", { op: "windows" }, {}, {
      exec: async (_h, cmd) => {
        scripts.push(cmd);
        if (cmd.includes("Register-ScheduledTask")) return reply({ ok: true, started: true, pid: 7, port: 1, version: GAME_HELPER_VERSION });
        return ++calls === 1 ? reply({ ok: false, down: true }) : reply({ ok: true, windows: [] });
      },
    });
    expect(r).toEqual({ ok: true, windows: [] });
    expect(scripts.filter((s) => s.includes("Register-ScheduledTask"))).toHaveLength(1);
    expect(scripts.filter((s) => s.includes("$install = $false"))).toHaveLength(1);
    expect(scripts.filter((s) => sentRequest(s)?.op === "windows")).toHaveLength(2);
  });

  test("an uninstalled helper is not installed as a side effect", async () => {
    await expect(gameRequest(cfg, "win", { op: "frame" }, {}, {
      exec: async (_h, cmd) => cmd.includes("Register-ScheduledTask")
        ? reply({ ok: false, notInstalled: true }) : reply({ ok: false, down: true }),
    })).rejects.toThrow("not installed on win; run: fleet game win start");
  });

  test("refuses non-Windows hosts before any ssh", async () => {
    await expect(gameRequest(cfg, "lin", { op: "status" }, {}, {
      exec: async () => { throw new Error("must not run"); },
    })).rejects.toThrow("fleet game runs on Windows hosts; lin is linux");
  });
});

describe("gameDo", () => {
  test("refuses keyboard steps without a target before contacting the host", async () => {
    await expect(gameDo(cfg, "win", [{ tap: "w" }], {}, { exec: async () => { throw new Error("must not run"); } }))
      .rejects.toThrow("need a target window");
  });

  test("refuses an endless repeat that is not detached", async () => {
    await expect(gameDo(cfg, "win", [{ tap: "pad.a" }], { repeat: 0 }, { exec: async () => { throw new Error("must not run"); } }))
      .rejects.toThrow("needs --detach");
  });

  test("appends a frame step for shot and passes the run back", async () => {
    let sent: any;
    const run = { id: "abc", state: "done", loop: 1, repeat: 1, steps: 2, seconds: 0.1, detached: false };
    const r = await gameDo(cfg, "win", [{ tap: "e" }], { target: "game", shot: true }, {
      exec: async (_h, cmd) => { sent = sentRequest(cmd); return reply({ ok: true, run, frames: [], held: [] }); },
    });
    expect(sent).toMatchObject({ op: "do", target: "game", steps: [{ tap: "e" }, { shot: true }], repeat: 1, detach: false, max: 1280 });
    expect(r).toMatchObject({ host: "win", ok: true, run });
  });

  test("a failed run is data, not an exception", async () => {
    const run = { id: "abc", state: "aborted", loop: 0, repeat: 1, steps: 0, seconds: 0.2, detached: false, error: "lost focus" };
    const r = await gameDo(cfg, "win", [{ hold: "w", ms: 500 }], { target: "game" }, {
      exec: async () => reply({ ok: false, run, error: "lost focus", held: [] }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("lost focus");
  });
});

describe("status and release", () => {
  test("status reports a stopped helper without starting it", async () => {
    const seen: string[] = [];
    const r = await gameStatus(cfg, "win", { exec: async (_h, cmd) => { seen.push(cmd); return reply({ ok: false, down: true }); } });
    expect(r.running).toBe(false);
    expect(seen.some((s) => s.includes("Register-ScheduledTask"))).toBe(false);
  });

  test("status flags an older helper", async () => {
    const r = await gameStatus(cfg, "win", { exec: async () => reply({ ok: true, version: "000000000000", pid: 3, held: [] }) });
    expect(r.current).toBe(false);
    expect(r.note).toContain("older than this fleet");
  });

  test("release works against an older helper and never starts one", async () => {
    let script = "";
    const r = await gameRelease(cfg, "win", {}, { exec: async (_h, cmd) => { script = cmd; return reply({ ok: true, released: ["w"], halted: null }); } });
    expect(script).not.toContain("stale = $true");
    expect(r).toEqual({ host: "win", released: ["w"], halted: null, running: true });
  });
});


describe("game safety regressions", () => {
  test("runs the helper safety suite with mocked Win32 APIs", async () => {
    const python = Bun.which(process.platform === "win32" ? "python" : "python3");
    expect(python, "Python is required for the game helper safety tests").not.toBeNull();
    const proc = Bun.spawn([python!, "-u", fileURLToPath(new URL("./game-helper.test.py", import.meta.url))], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(code, stdout + stderr).toBe(0);
  });

  test("never retries a sent request after a lost, malformed or failed reply", async () => {
    for (const response of [reply({ ok: false, lost: true }), ok("FLEETGAME broken\n"),
      { ...ok(""), ok: false, code: 124, stderr: "timed out" }]) {
      let calls = 0;
      await expect(gameRequest(cfg, "win", { op: "do" }, {}, {
        exec: async () => { calls++; return response; },
      })).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });

  test("a stale reply permits exactly one send after startup", async () => {
    const scripts: string[] = [];
    let attempts = 0;
    await gameRequest(cfg, "win", { op: "do", steps: [{ wait: 0 }] }, {}, {
      exec: async (_h, cmd) => {
        scripts.push(cmd);
        if (cmd.includes("Register-ScheduledTask")) return reply({ ok: true });
        return ++attempts === 1 ? reply({ ok: false, stale: true }) : reply({ ok: true });
      },
    });
    expect(attempts).toBe(2);
    expect(scripts.filter(s => s.includes("Register-ScheduledTask"))).toHaveLength(1);
  });

  test("stop refuses a helper failure instead of claiming it stopped", async () => {
    await expect(gameStop(cfg, "win", { exec: async () => reply({ ok: false, error: "cleanup failed" }) }))
      .rejects.toThrow("cleanup failed");
  });

  test("refuses timer overflow and invalid capture bounds before exec", async () => {
    const exec = async () => { throw new Error("must not run"); };
    await expect(gameDo(cfg, "win", [{ wait: 3_600_000 }], { repeat: 1000 }, { exec }))
      .rejects.toThrow("timer limit");
    expect(() => prepareGameDo([{ wait: 3_600_000 }], { repeat: 1000, detach: true })).not.toThrow();
    await expect(gameDo(cfg, "win", [{ wait: 0 }], { max: -1 }, { exec })).rejects.toThrow("max must be");
    await expect(gameDo(cfg, "win", [{ wait: 0 }], { quality: 101 }, { exec })).rejects.toThrow("quality must be");
  });

  test("inherited action names are refused", () => {
    for (const key of ["constructor", "toString", "__proto__"])
      expect(() => validateGameSteps([JSON.parse(`{"${key}":true}`)])).toThrow("no action");
  });

  test("helper replacement uses bounded probes and refuses unknown idle status", () => {
    const script = gameStartScript({ install: false });
    expect(script).toContain("$s.ReadTimeout = $timeout");
    expect(script).toContain("$connect.Wait(3000)");
    expect(script).toContain("cannot verify the older helper is idle");
    expect(script).toContain("'{\"op\":\"status\"}' 3000");
    expect(script).toContain("'{\"op\":\"stop\"}' 3000");
  });
});
