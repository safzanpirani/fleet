#!/usr/bin/env bun
/**
 * fleet — drive the whole fleet without ssh/PowerShell/WSL quoting pain.
 *
 *   fleet ls                          reachability of every host
 *   fleet exec [--cwd d] [--wsl] [--raw] [--json] <sel> <cmd…>   run a command (blocking; flags BEFORE <sel>)
 *   fleet spawn [--cwd d] [--label n] <sel> <cmd…>   launch a detached job that outlives ssh
 *   fleet jobs [<sel>] | log|tail|kill|wait|prune …   track detached jobs
 *   fleet cp <local…> <sel>:<remote>  push file(s) (fan-out across a group)
 *   fleet browse <host> [url]         verify configured CDP and list browser targets
 *   fleet restart <host> <svc>        restart a configured service
 *   fleet reboot <sel> [--yes]        reboot the whole machine(s)
 *   fleet gpu [--json]                every GPU: util / free VRAM / temp / loaded model
 *   fleet disk [sel] [--json]         every volume: free space / % used (live, not the dashboard)
 *   fleet status [host] [--json]      live CPU/mem/disk from dash.example.com
 *   fleet top <host>                  live terminal btop for one host
 *   fleet logs <host> <svc> [-n N]    recent logs / status for a service
 *   fleet tools status [tool] [sel]   which boxes run a stale CLI tool / skill
 *   fleet run <recipe>                run a saved playbook from config
 *   fleet ssh <host>                  interactive shell
 *
 *   selectors: hostnames, @linux @windows @mac @gpu, custom @groups, "all",
 *              comma-mixed (e.g. vps,@gpu)
 *
 * This is the ANSI presentation frontend; all real work lives in `core.ts`
 * (shared with the MCP server in `mcp.ts`).
 */
import { readFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import { processList, processKill } from "./procs.ts";
import type { KillResult } from "./procs.ts";
import { format } from "node:util";
import { loadConfig, resolveHosts } from "./config.ts";
import { runWinSessionBroker } from "./winsession.ts";
import { focusElements } from "./focus.ts";
import { sessionStates, formatIdle } from "./session.ts";
import type { FleetConfig, Host } from "./config.ts";
import { helpText } from "./help.ts";
import { sshInteractive } from "./ssh.ts";
import { proxyConnectMain } from "./proxy.ts";
import type { ExecResult } from "./ssh.ts";
import {
  spawnJob, listJobs, jobLog, jobTail, jobFollow, killJob, waitJob, pruneJobs,
} from "./jobs.ts";
import type { JobRow } from "./jobs.ts";
import {
  pullFlag, pullVal, parseFlags, parseLeadingFlags, lsHosts, runExec, runScript, rebootRefusal, droppedStdinCheck, readScriptSource, editRemoteFile, parseEditList,
  pushFile, pullFile, parseRemoteSpec, restartService, serviceLogs, svcStatus,
  gpuRows, diskRows, sudoWrap, fetchDashboard, hostStatus, runRecipe, captureScreenshot, rebootHosts,
  cuInstall, cuRun, cuTools, cuDescribe, cuRecordStart, cuRecordStop, cuRecordStatus, cuRegions, cuPerception, bootMismatchNote,
  cuApps, cuShotWindow, browseHost, preferredImageExt, overlayGrid,
  cuSnapshot, cuResolveTargetFrom, cuResolvePoint, cuAct, cuBatch, cuBlockerNote, cuElements, cuOpen, sameRole, cuVerify,
  cuGridCaption, cuElementSupport, compactCuOutput, briefDescribe,
  bootState, switchMachine, firmwareEntries, hostKey, findHost, listMonitors, waitFor, routeSelector, deployHosts, diagnose, firmwareRebootHosts,
  proxyRows, proxyChecks, dropMasters,
} from "./core.ts";
import {
  fingerprint,
  fingerprintTools,
  serializeToolSyncResults,
  toolsStatus,
  syncTool,
  syncTools,
  toolSyncParallelism,
  stampSkill,
} from "./tools.ts";
import type { ServiceAction, CuTarget, GridOptions, CuElementLocator, EditSpec } from "./core.ts";
import type { CuRegionLocator } from "./perception.ts";
import {
  isAndroidHost, androidState, androidDoctor, androidElementsOf, androidShot, androidAct, androidOpen, androidApps,
  androidBootstrap, androidBatch, androidFlow, androidWait, androidRelease, androidNotifications,
  androidRecordStart, androidRecordStatus, androidRecordStop, androidRevive, androidWatch,
} from "./android.ts";
import type { AndroidAction, AndroidBatchStep, AndroidDeps, AndroidElement, AndroidFlowStep, AndroidLocator, AndroidState } from "./android.ts";
import {
  gameStart, gameStop, gameStatus, gameWindows, gameFocus, gameFrame, gameDo, gameRelease, gameShorthand,
  parseGameArgv, parseGameMacro, gameIntFlag, prepareGameDo,
} from "./game.ts";
import type { GameDoResult, GameFrame, GameRun, GameWindow } from "./game.ts";

/** Colour only for a person at a terminal. Output piped to an agent or a file
 *  is data, and escape codes inside it are noise every reader has to strip.
 *  NO_COLOR always wins; FORCE_COLOR restores colour for a pipe. */
export function useColor(env: NodeJS.ProcessEnv = process.env, tty = Boolean(process.stdout.isTTY)): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return tty;
}
const COLOR = useColor();
const paint = (code: string) => (s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const A = {
  g: paint("32"), r: paint("31"), y: paint("33"), d: paint("90"), c: paint("36"), b: paint("1"),
};

// A reader that stops early (`fleet ls | head -1`) closes the pipe. That is a
// normal way to consume output, not a failure worth a Bun stack trace.
for (const stream of [process.stdout, process.stderr])
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
function ageText(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function renderKill(r: KillResult): void {
  if (!r.ok && !r.targets.length) { console.log(`${A.r("✗")} ${A.b(r.host)} ${r.error ?? ""}`); return; }
  const mark: Record<string, string> = { exited: A.g("✓ exited"), killed: A.g("✓ killed"), gone: A.d("○ gone"),
    planned: A.c("→ would stop"), running: A.r("✗ running"), denied: A.r("✗ denied"), changed: A.y("? changed") };
  console.log(A.b(r.host));
  for (const t of r.targets) {
    const extra = t.cmd ? A.d(` ${t.job ? `job:${t.job} ` : ""}${t.cmd.slice(0, 80)}`) : "";
    console.log(`  ${mark[t.outcome] ?? t.outcome} ${String(t.pid).padStart(7)} ${t.name}${t.detail ? A.d(` — ${t.detail}`) : ""}${extra}`);
  }
  if (r.error && r.targets.length) console.log(`  ${A.d(r.error)}`);
}

function die(m: string): never { console.error(A.r("✗ " + m)); process.exit(1); }
/** Pull a numeric flag value, failing LOUDLY on garbage instead of letting a
 *  NaN leak into a remote command (`tail -n NaN`) or a 0ms poll loop. */
function numVal(rest: string[], flag: string, def: number, min = 1): number {
  const v = pullVal(rest, flag);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min) die(`${flag} needs an integer ≥ ${min} (got '${v}')`);
  return n;
}
/** A fleet flag written after the command — as its last token, or as the
 *  second-to-last token when the flag takes a value — was almost certainly meant
 *  for fleet, not the remote shell. Return it so the caller can refuse. */
export function trailingFleetFlag(pos: string[], bools: string[], valued: string[]): string | undefined {
  if (pos.length < 2) return undefined;
  const last = pos[pos.length - 1]!;
  if (bools.includes(last) || valued.includes(last)) return last;
  const beforeLast = pos.length >= 3 ? pos[pos.length - 2]! : "";
  if (valued.includes(beforeLast) && !last.startsWith("--")) return beforeLast;
  return undefined;
}

/** Same strictness as numVal, but over a parseLeadingFlags result. */
function numFlag(flags: Record<string, string | true>, flag: string, def: number, min = 1): number {
  const v = flags[flag];
  if (v === undefined) return def;
  const n = Number(v);
  if (v === true || !Number.isSafeInteger(n) || n < min) die(`${flag} needs an integer ≥ ${min} (got '${v}')`);
  return n;
}
/** Interactive y/N gate for destructive actions. Returns true to proceed. With
 *  --yes it's a no-op; with no TTY (and no --yes) it refuses rather than hang. */
async function confirm(prompt: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) { console.error(A.r(`✗ refusing ${prompt} non-interactively — pass --yes`)); return false; }
  process.stdout.write(A.y(`${prompt}? [y/N] `));
  const answer = await new Promise<string>((res) =>
    process.stdin.once("data", (d) => res(d.toString().trim().toLowerCase())));
  if (answer === "y" || answer === "yes") return true;
  console.log(A.d("aborted"));
  return false;
}
const heat = (p: number | null | undefined, t: string) =>
  p == null ? A.d(t) : p < 60 ? A.g(t) : p < 85 ? A.y(t) : A.r(t);
const BLK = " ▁▂▃▄▅▆▇█";
const blk = (p: number | null | undefined): string =>
  p == null ? " " : (BLK[Math.max(1, Math.min(8, Math.round(p / 100 * 8)))] ?? " ");

const ANDROID_USAGE = `usage (Android host):
  fleet cu <phone> doctor | state | release | apps [FILTER] [--all] | bootstrap [PAIR-PORT PAIR-CODE]
  fleet cu <phone> notifications [PACKAGE] [--max N] | revive [--restart] | watch [--view-only]
  fleet cu <phone> record start [--out FILE.mp4] [--limit S] [--bit-rate MBPS] | record stop | record status
  fleet cu <phone> elements [FILTER] [--role R] [--all] [--json]
  fleet cu <phone> shot [--out FILE] [--width N] [--grid]
  fleet cu <phone> open <PACKAGE|URL> [--in PACKAGE] [--wait MS]
  fleet cu <phone> tap|long-press <TARGET> <X> <Y> | --label TEXT [--role R] [--nth N]
  fleet cu <phone> swipe <TARGET> <X1> <Y1> <X2> <Y2> [--duration MS]
  fleet cu <phone> swipe2 <TARGET> <X1> <Y1> <X2> <Y2> <DX> <DY> [--duration MS]
  fleet cu <phone> zoom <TARGET> <in|out> [X Y | --label TEXT] [--scale F] [--duration MS]
  fleet cu <phone> gesture <TARGET> <X1,Y1,X2,Y2> [X1,Y1,X2,Y2 …] [--duration MS]
  fleet cu <phone> scroll <TARGET> <up|down|left|right> [AMOUNT] [--label TEXT]
  fleet cu <phone> key <TARGET> <KEY> | type <TARGET> <TEXT> [--label TEXT]
  fleet cu <phone> batch <TARGET> <JSON-array|-> | batch <TARGET> --file FILE [--gap MS]
  fleet cu <phone> wait --label TEXT [--role R] [--gone] | wait --focus PACKAGE [--gone] [--timeout MS]
  fleet cu <phone> flow <JSON-array|-> | flow --file FILE [--target PACKAGE] [--read FILTER | --no-read]
    open and input verbs accept trailing --read FILTER (or '*') after their operands; --json includes the read
    TARGET is the package that must hold focus (a word in it matches), or "any".
    input flags: [--settle MS] [--shot] [--out FILE] [--json]`;

const androidStateLine = (s: AndroidState) =>
  `${s.pkg || "nothing"} focused` + (s.width ? ` · ${s.width}x${s.height}` : "")
  + (s.awake && s.awake !== "Awake" ? ` · screen ${s.awake}` : "") + (s.locked ? " · locked" : "");

/** `fleet cu` on a host with an "android" block: the phone's own verbs, with the
 *  desktop contracts — explicit target, refusal before input, effect from pixels. */
export async function androidCu(
  cfg: FleetConfig, target: string, sel: string, rest: string[],
  o: { grid: boolean; gridStep: number; out?: string; noOpen: boolean; settle: number; wantShot: boolean;
       label?: string; role?: string; nth?: string },
  deps: AndroidDeps = {},
): Promise<number> {
  const json = pullFlag(rest, "--json");
  const all = pullFlag(rest, "--all");
  const wait = pullVal(rest, "--wait");
  const widthArg = pullVal(rest, "--width");
  const durationArg = pullVal(rest, "--duration");
  const scaleArg = pullVal(rest, "--scale");
  const inPackage = pullVal(rest, "--in");
  const fileArg = pullVal(rest, "--file");
  const gapArg = pullVal(rest, "--gap");
  const timeoutArg = pullVal(rest, "--timeout");
  const focusArg = pullVal(rest, "--focus");
  const gone = pullFlag(rest, "--gone");
  const maxArg = pullVal(rest, "--max");
  const verb = rest[0];
  const inputVerbs = ["tap", "click", "long-press", "swipe", "swipe2", "zoom", "gesture", "scroll", "key", "type"];
  // New options follow the operands. Preserve option-looking literal text and
  // filters, and leave other verbs' arguments untouched.
  const operandCount = verb === "flow" ? (fileArg ? 0 : 1) : verb === "open" ? 1
    : verb === "type" || verb === "key" ? 2
    : ["tap", "click", "long-press"].includes(verb ?? "") ? (o.label !== undefined || o.role !== undefined ? 1 : 3)
    : verb === "swipe" ? 5 : verb === "swipe2" ? 7
    : verb === "zoom" ? (rest[3] && !rest[3].startsWith("--") ? 4 : 2)
    : verb === "scroll" ? (rest[3] && !rest[3].startsWith("--") ? 3 : 2)
    : verb === "gesture" ? rest.findIndex((v, i) => i > 1 && v.startsWith("--")) - 1 : 0;
  const takesRead = verb === "flow" || verb === "open" || inputVerbs.includes(verb ?? "");
  const optionStart = verb === "gesture" && operandCount < 0 ? rest.length : 1 + operandCount;
  const readOptions = takesRead ? rest.slice(optionStart) : [];
  const readArg = pullVal(readOptions, "--read");
  const noRead = pullFlag(readOptions, "--no-read");
  const targetArg = verb === "flow" ? pullVal(readOptions, "--target") : undefined;
  if (takesRead) rest.splice(optionStart, rest.length - optionStart, ...readOptions);
  if (readArg !== undefined && noRead) die("--read and --no-read cannot be combined");
  const args = rest.slice(1);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const open = (p?: string) => {
    if (p && !o.noOpen && !json && process.platform === "darwin") Bun.spawn(["open", p], { stdout: "ignore", stderr: "ignore" });
  };
  const posInt = (v: string | undefined, name: string, max: number) => {
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > max) die(`${name} must be an integer from 1 to ${max} (got '${v}')`);
    return Number(v);
  };
  if (o.nth !== undefined) posInt(o.nth, "--nth", 1000);
  const locator: AndroidLocator | undefined = [o.label, o.role, o.nth].some((v) => v !== undefined)
    ? { label: o.label, role: o.role, nth: o.nth === undefined ? undefined : Number(o.nth) } : undefined;
  const need = (n: number, usage: string) => { if (args.length !== n) die(`usage: fleet cu ${sel} ${usage}`); };
  const num = (v: string | undefined, what: string) => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n)) die(`${what} must be a number (got '${v}')`);
    return n;
  };

  const printElements = (elements: AndroidElement[], hideWithin: boolean) => {
    for (const e of elements) {
      const indent = "  ".repeat(Math.min(6, Math.max(0, e.depth - 1)));
      console.log(`${A.d(`@${e.center.x},${e.center.y}`.padEnd(11))} ${indent}${A.b(e.role)} ${JSON.stringify(e.label)}`
        + (e.derived ? A.d(" (from children)") : "")
        + (e.id ? A.d(` #${e.id}`) : "")
        + (e.actions.length ? A.g(` [${e.actions.join(",")}]`) : "")
        + (e.checked !== undefined ? (e.checked ? A.g(" checked") : A.d(" unchecked")) : "")
        + (e.enabled ? "" : A.y(" disabled"))
        + (e.focused ? A.c(" focused") : "")
        + (e.selected ? A.g(" selected") : "")
        + (e.within && !hideWithin ? A.d(` in ${e.within}`) : ""));
    }
  };
  /** --read FILTER: print the screen after an action, in the same call. */
  const readAfter = async () => {
    if (readArg === undefined || noRead) return {};
    try {
      const r = await androidElementsOf(cfg, target, { filter: readArg === "*" ? undefined : readArg }, deps);
      if (!r.result.ok) return { readError: r.result.stderr || "the read after the action failed" };
      return { read: { state: r.state, elements: r.elements, total: r.total } };
    } catch (error) { return { readError: error instanceof Error ? error.message : String(error) }; }
  };
  const printRead = (r: Awaited<ReturnType<typeof readAfter>>) => {
    if (r.readError) console.error(A.y(`▲ read failed: ${r.readError}`));
    if (r.read) {
      console.log(A.d(`${androidStateLine(r.read.state)} · ${r.read.elements.length} of ${r.read.total} element(s)`));
      printElements(r.read.elements, readArg === "*");
    }
  };

  if (verb === "doctor") {
    need(0, "doctor");
    const r = await androidDoctor(cfg, target);
    if (json) { console.log(JSON.stringify(r)); return r.ok ? 0 : 1; }
    for (const c of r.checks) console.log(`${c.ok ? A.g("●") : A.r("✗")} ${c.check.padEnd(22)} ${A.d(c.detail)}`);
    if (r.state.pkg !== undefined) console.log(A.d(androidStateLine(r.state)));
    return r.ok ? 0 : 1;
  }
  if (verb === "bootstrap") {
    if (args.length !== 0 && args.length !== 2) die(`usage: fleet cu ${sel} bootstrap [PAIR-PORT PAIR-CODE]`);
    const pair = args.length === 2 ? { port: num(args[0], "pairing port"), code: args[1]! } : undefined;
    let r;
    try { r = await androidBootstrap(cfg, target, { pair }); }
    catch (error) { die(error instanceof Error ? error.message : String(error)); }
    if (json) { console.log(JSON.stringify(r)); return r.outcome === "failed" ? 1 : 0; }
    console.log(`${r.outcome === "failed" ? A.r("✗") : A.g("●")} ${r.outcome} ${A.d(r.detail)}`);
    return r.outcome === "failed" ? 1 : 0;
  }
  if (verb === "notifications") {
    if (args.length > 1) die(`usage: fleet cu ${sel} notifications [PACKAGE] [--max N] [--json]`);
    const r = await androidNotifications(cfg, target, { pkg: args[0], limit: posInt(maxArg, "--max", 1000) });
    if (json) { console.log(JSON.stringify(r)); return r.result.ok ? 0 : 1; }
    if (!r.result.ok) { printResult(r.result); return 1; }
    const ago = (ms?: number) => {
      if (!ms) return "";
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
    };
    for (const n of r.notifications)
      console.log(`${A.d(ago(n.when).padStart(4))} ${A.b(n.pkg)} ${JSON.stringify(n.title)}`
        + (n.text ? ` ${n.text.length > 120 ? n.text.slice(0, 117) + "…" : n.text}` : "")
        + (n.subText ? A.d(` (${n.subText})`) : ""));
    console.log(A.d(`${r.notifications.length} notification(s)`));
    return 0;
  }
  if (verb === "release") {
    need(0, "release");
    const r = await androidRelease(cfg, target);
    if (json) { console.log(JSON.stringify(r)); return r.result.ok ? 0 : 1; }
    console.log(`${r.result.ok ? A.g("●") : A.r("✗")} ${r.detail}`);
    return r.result.ok ? 0 : 1;
  }
  if (verb === "state" || verb === "windows") {
    need(0, "state");
    const r = await androidState(cfg, target);
    if (json) { console.log(JSON.stringify(r)); return r.result.ok ? 0 : 1; }
    if (!r.result.ok) { printResult(r.result); return 1; }
    console.log(`${r.state.awake === "Awake" && !r.state.locked ? A.g("●") : A.y("▲")} ${androidStateLine(r.state)}`);
    if (r.state.focus) console.log(A.d(`  ${r.state.focus}`));
    return 0;
  }
  if (verb === "apps") {
    if (args.length > 1) die(`usage: fleet cu ${sel} apps [FILTER] [--all]`);
    const r = await androidApps(cfg, target, { filter: args[0], all });
    if (json) { console.log(JSON.stringify(r)); return r.result.ok ? 0 : 1; }
    if (!r.result.ok) { printResult(r.result); return 1; }
    for (const p of r.packages) console.log(p);
    console.log(A.d(`${r.packages.length} ${all ? "" : "user-installed "}package(s)`));
    return 0;
  }
  if (verb === "elements") {
    if (args.length > 1) die(`usage: fleet cu ${sel} elements [FILTER] [--role R] [--all] [--json]`);
    const r = await androidElementsOf(cfg, target, { all, filter: args[0] ?? o.label, role: o.role }, deps);
    if (json) { console.log(JSON.stringify(r)); return r.result.ok ? 0 : 1; }
    if (!r.result.ok) { printResult(r.result); return 1; }
    console.log(A.d(`${androidStateLine(r.state)} · ${r.elements.length} of ${r.total} element(s)` + (r.via ? ` · via ${r.via}` : "")));
    if (r.state.locked || (r.state.awake && r.state.awake !== "Awake"))
      console.error(A.y("▲ the phone is locked or its screen is off; this is the lock screen, and input is refused"));
    printElements(r.elements, o.label === undefined && args[0] === undefined);
    if (!r.total) console.error(A.y("▲ uiautomator found no elements; this screen needs pixels (shot)"));
    return 0;
  }
  if (verb === "shot" || verb === "screenshot" || verb === "shot-window") {
    if (args.length > (verb === "shot-window" ? 1 : 0)) die(`usage: fleet cu ${sel} shot [--out FILE] [--width N] [--grid]`);
    // A grid labels image pixels, so it needs the full-size frame to label device pixels.
    const width = o.grid ? 100000 : posInt(widthArg, "--width", 100000);
    const local = o.out ?? `${sel}-screen-${stamp}.webp`;
    const r = await androidShot(cfg, target, local, { width });
    if (json) { console.log(JSON.stringify(r)); return r.result.ok ? 0 : 1; }
    if (!r.localImage || !r.image) { printResult(r.result); return 1; }
    if (o.grid && !await overlayGrid(r.localImage, { step: o.gridStep,
      caption: `${sel} · device pixels ${r.image.deviceWidth}x${r.image.deviceHeight} · ${r.state.pkg || "nothing"} focused` }))
      console.error(A.y("grid overlay skipped (need python3 + Pillow)"));
    const scale = r.image.deviceWidth / r.image.width;
    console.log(`${A.g("●")} ${A.d(androidStateLine(r.state) + " →")} ${r.localImage}`);
    console.log(A.d(`  image ${r.image.width}x${r.image.height} ${r.image.format}`
      + (scale !== 1 ? ` · multiply by ${+scale.toFixed(3)} for device pixels (tap takes device pixels)` : " · device pixels")));
    if (r.state.locked || (r.state.awake && r.state.awake !== "Awake"))
      console.error(A.y("▲ the phone is locked or its screen is off"));
    open(r.localImage);
    return 0;
  }
  if (verb === "open") {
    need(1, "open <PACKAGE|URL> [--in PACKAGE] [--wait MS]");
    let r;
    try {
      r = await androidOpen(cfg, target, args[0]!, { waitMs: wait === undefined ? undefined : posInt(wait, "--wait", 60000), inPackage }, deps);
    } catch (error) { die(error instanceof Error ? error.message : String(error)); }
    const reading = r.result.ok && !r.refusal ? await readAfter() : {};
    if (json) { console.log(JSON.stringify({ ...r, ...reading })); return r.result.ok ? 0 : 1; }
    if (r.refusal) { console.log(`${A.r("✗ refused")} ${A.d(r.refusal)}`); return 1; }
    if (!r.result.ok) { printResult(r.result); return 1; }
    console.log(`${A.g("●")} opened ${r.what}: ${A.b(r.state.pkg || "nothing")} ${A.d("focused")}`);
    printRead(reading);
    return 0;
  }

  if (verb === "wait") {
    if (args.length) die(`usage: fleet cu ${sel} wait --label TEXT [--role R] [--gone] | --focus PACKAGE [--gone] [--timeout MS]`);
    let r;
    try {
      r = await androidWait(cfg, target, { label: o.label, role: o.role, gone, focus: focusArg,
        timeoutMs: timeoutArg === undefined ? undefined : posInt(timeoutArg, "--timeout", 120000) }, deps);
    } catch (error) { die(error instanceof Error ? error.message : String(error)); }
    if (json) { console.log(JSON.stringify(r)); return r.satisfied ? 0 : 1; }
    const what = focusArg !== undefined ? `focus ${gone ? "left" : "on"} ${focusArg}`
      : `${[o.role, o.label !== undefined && JSON.stringify(o.label)].filter(Boolean).join(" ")} ${gone ? "gone" : "present"}`;
    console.log(`${r.satisfied ? A.g("● satisfied") : A.r("✗ unsatisfied")} ${what}`
      + A.d(` · ${r.elapsedMs} ms`) + (r.element ? A.d(` · @${r.element.center.x},${r.element.center.y}`) : ""));
    if (r.reason) console.log(A.d(`  ${r.reason}`));
    return r.satisfied ? 0 : 1;
  }
  if (verb === "flow") {
    if (fileArg ? args.length !== 0 : args.length !== 1)
      die(`usage: fleet cu ${sel} flow <JSON-array|-> | flow --file FILE [--target PACKAGE] [--read FILTER | --no-read]`);
    const source = fileArg ? await readFile(fileArg, "utf8") : args[0] === "-" ? await Bun.stdin.text() : args[0]!;
    let steps: AndroidFlowStep[];
    try { steps = JSON.parse(source); } catch { die("flow needs a valid JSON array of steps"); }
    let r;
    try {
      r = await androidFlow(cfg, target, steps!, { target: targetArg, settleMs: o.settle,
        read: noRead ? false : readArg }, deps);
    } catch (error) { die(error instanceof Error ? error.message : String(error)); }
    if (json) { console.log(JSON.stringify(r)); return r.ok ? 0 : 1; }
    const ran = r.steps.filter((s) => s.status === "done").length;
    console.log(`${r.ok ? A.g("● done") : A.r("✗ stopped")} ${A.b(r.state?.pkg || "nothing")} ${A.d("·")} flow ${ran}/${r.steps.length} steps`);
    for (const s of r.steps)
      console.log(`  ${s.index + 1}. ${s.status === "done" ? A.g("done   ") : s.status === "failed" ? A.r("failed ") : A.d("not run")} ${s.summary}`
        + (s.detail ? (s.status === "failed" ? A.r(` — ${s.detail}`) : A.d(` — ${s.detail}`)) : ""));
    if (r.elements) {
      console.log(A.d(`${r.state ? androidStateLine(r.state) + " · " : ""}${r.elements.length} of ${r.total} element(s)`));
      printElements(r.elements, readArg === undefined || readArg === "*");
    }
    if (r.readError) console.error(A.y(`▲ read failed: ${r.readError}`));
    return r.ok ? 0 : 1;
  }
  if (verb === "batch") {
    const app = args[0];
    if (!app || (fileArg ? args.length !== 1 : args.length !== 2))
      die(`usage: fleet cu ${sel} batch <TARGET> <JSON-array|-> | batch <TARGET> --file FILE [--gap MS]`);
    const source = fileArg ? await readFile(fileArg, "utf8") : args[1] === "-" ? await Bun.stdin.text() : args[1]!;
    let steps: AndroidBatchStep[];
    try { steps = JSON.parse(source); } catch { die("batch needs a valid JSON array of steps"); }
    const shotPath = o.wantShot || o.out ? (o.out ?? `${sel}-after-${stamp}.webp`) : undefined;
    let r;
    try {
      r = await androidBatch(cfg, target, app, steps!, { settleMs: o.settle, imageOut: shotPath,
        gapMs: gapArg === undefined ? undefined : Number(gapArg === "0" ? 0 : posInt(gapArg, "--gap", 10000)) });
    } catch (error) { die(error instanceof Error ? error.message : String(error)); }
    if (json) { console.log(JSON.stringify(r)); return r.result.ok ? 0 : 1; }
    const ran = r.steps.filter((s) => s.status === "done").length;
    const badge = r.refusal ? A.r("✗ refused") : !r.result.ok ? A.r(`✗ stopped (${r.effect})`)
      : r.effect === "changed" ? A.g("● changed") : r.effect === "no_change" ? A.y("○ no_change") : A.d("? indeterminate");
    console.log(`${badge} ${A.b(r.state.pkg || "nothing")} ${A.d("·")} batch ${ran}/${r.steps.length} steps`);
    for (const s of r.steps)
      console.log(`  ${s.index + 1}. ${s.status === "done" ? A.g("done   ") : s.status === "failed" ? A.r("failed ") : A.d("not run")} ${s.summary}`
        + (s.detail ? A.r(` — ${s.detail}`) : ""));
    if (r.reason) console.log(A.d(`  ${r.reason}`));
    if (r.localImage) { console.log(`after → ${r.localImage}`); open(r.localImage); }
    return r.result.ok ? 0 : 1;
  }

  const INPUT = inputVerbs;
  if (!verb || !INPUT.includes(verb)) die(verb ? `'${verb}' is not an Android verb\n${ANDROID_USAGE}` : ANDROID_USAGE);
  const app = args[0] ?? die(`usage: fleet cu ${sel} ${verb} <TARGET> …  (TARGET: a package, a word in one, or "any")`);
  const p = args.slice(1);
  const duration = posInt(durationArg, "--duration", 10000);
  let action: AndroidAction;
  if (verb === "tap" || verb === "click" || verb === "long-press") {
    const kind = verb === "long-press" ? "long_press" : "tap";
    if (locator) { if (p.length) die(`give x y or --label, not both`); action = { kind } as AndroidAction; }
    else {
      if (p.length !== 2) die(`usage: fleet cu ${sel} ${verb} <TARGET> <X> <Y> | --label TEXT [--role R] [--nth N]`);
      action = { kind, x: num(p[0], "x"), y: num(p[1], "y") } as AndroidAction;
    }
    if (kind === "long_press" && duration) (action as { ms?: number }).ms = duration;
  } else if (verb === "swipe") {
    if (p.length !== 4) die(`usage: fleet cu ${sel} swipe <TARGET> <X1> <Y1> <X2> <Y2> [--duration MS]`);
    action = { kind: "swipe", x1: num(p[0], "x1"), y1: num(p[1], "y1"), x2: num(p[2], "x2"), y2: num(p[3], "y2"), ms: duration };
  } else if (verb === "swipe2") {
    if (p.length !== 6) die(`usage: fleet cu ${sel} swipe2 <TARGET> <X1> <Y1> <X2> <Y2> <DX> <DY> [--duration MS]`);
    action = { kind: "swipe2", x1: num(p[0], "x1"), y1: num(p[1], "y1"), x2: num(p[2], "x2"), y2: num(p[3], "y2"),
      dx: num(p[4], "dx"), dy: num(p[5], "dy"), ms: duration };
  } else if (verb === "zoom") {
    if ((p.length !== 1 && p.length !== 3) || !["in", "out"].includes(p[0]!))
      die(`usage: fleet cu ${sel} zoom <TARGET> <in|out> [X Y | --label TEXT] [--scale F] [--duration MS]`);
    action = { kind: "zoom", direction: p[0] as "in", ...(p.length === 3 ? { x: num(p[1], "x"), y: num(p[2], "y") } : {}),
      ...(scaleArg !== undefined ? { scale: num(scaleArg, "--scale") } : {}), ms: duration };
  } else if (verb === "gesture") {
    if (!p.length) die(`usage: fleet cu ${sel} gesture <TARGET> <X1,Y1,X2,Y2> [X1,Y1,X2,Y2 …] [--duration MS]  (one stroke per finger)`);
    action = { kind: "gesture", ms: duration, strokes: p.map((v) => {
      const n = v.split(",").map(Number);
      if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) die(`a stroke is X1,Y1,X2,Y2 (got '${v}')`);
      return n as [number, number, number, number];
    }) };
  } else if (verb === "scroll") {
    if (p.length < 1 || p.length > 2 || !["up", "down", "left", "right"].includes(p[0]!))
      die(`usage: fleet cu ${sel} scroll <TARGET> <up|down|left|right> [AMOUNT] [--label TEXT]`);
    action = { kind: "scroll", direction: p[0] as "up", amount: p[1] === undefined ? 1 : posInt(p[1], "amount", 10) };
  } else if (verb === "key") {
    if (p.length !== 1) die(`usage: fleet cu ${sel} key <TARGET> <KEY>   (back, home, enter, recents, … or KEYCODE_*)`);
    action = { kind: "key", key: p[0]! };
  } else {
    if (p.length !== 1) die(`usage: fleet cu ${sel} type <TARGET> <TEXT> [--label TEXT]`);
    action = { kind: "type", text: p[0]! };
  }
  const shotPath = o.wantShot || o.out ? (o.out ?? `${sel}-after-${stamp}.webp`) : undefined;
  let r;
  try {
    r = await androidAct(cfg, target, app, action, { settleMs: o.settle, imageOut: shotPath, element: locator }, deps);
  } catch (error) { die(error instanceof Error ? error.message : String(error)); }
  const reading = r.result.ok && !r.refusal ? await readAfter() : {};
  if (json) { console.log(JSON.stringify({ ...r, ...reading })); return r.result.ok ? 0 : 1; }
  const badge = r.refusal ? A.r("✗ refused")
    : !r.result.ok ? A.r(`✗ failed (${r.effect})`)
    : r.effect === "changed" ? A.g("● changed")
    : r.effect === "no_change" ? A.y("○ no_change") : A.d("? indeterminate");
  const el = r.element ? ` → ${r.element.role} ${JSON.stringify(r.element.label)}${r.element.id ? A.d(` #${r.element.id}`) : ""}`
    + (r.element.within ? A.d(` in ${r.element.within}`) : "") : "";
  console.log(`${badge} ${A.b(r.state.pkg || "nothing")} ${A.d("·")} ${r.summary}${el}`);
  if (r.reason) console.log(A.d(`  ${r.reason}`));
  if (!r.refusal && r.result.stderr) console.error(A.d(r.result.stderr.split("\n").map((l) => "  " + l).join("\n")));
  if (r.localImage) { console.log(`after → ${r.localImage}`); open(r.localImage); }
  printRead(reading);
  return r.result.ok ? 0 : 1;
}

function printResult(r: ExecResult) {
  console.log(`${r.ok ? A.g("●") : A.r("●")} ${A.b(r.host)} ${A.d("· exit " + r.code)}`);
  const stdout = r.stdout.trimEnd();
  if (stdout) console.log(stdout.split("\n").map((l) => "  " + l).join("\n"));
  if (r.stderr) console.error(A.d(r.stderr.split("\n").map((l) => "  " + l).join("\n")));
}

/** A failed connection to one boot of a multi-boot machine says which boot is live. */
async function printBootMismatch(cfg: FleetConfig, results: ExecResult[]): Promise<void> {
  for (const r of results) {
    const note = await bootMismatchNote(cfg, r);
    if (note) console.error(A.y(`▲ ${note}`));
  }
}

function printRaw(r: ExecResult): void {
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : r.stderr + "\n");
}

const SUBCOMMANDS = [
  "ls", "hosts", "dt", "exec", "spawn", "jobs", "cp", "edit", "restart", "reboot", "bios", "boot", "switch", "wait",
  "gpu", "disk", "ps", "kill", "status", "top", "logs", "svc", "shot", "cu", "game", "browse", "run", "deploy", "tools", "proxy", "doctor", "hostkey", "find", "session", "drop", "completion", "ssh", "help",
];
/** Emit a bash/zsh completion script with this config's hosts/groups/recipes/
 *  services baked in. Source it: `eval "$(fleet completion zsh)"`. */
const shellSingle = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const shellArray = (values: string[]): string => `( ${values.map(shellSingle).join(" ")} )`;
export function completionScript(cfg: FleetConfig, shell: string): string {
  const hosts = Object.keys(cfg.hosts);
  const routes = Object.keys(cfg.routes ?? {});
  const machines = Object.keys(cfg.machines ?? {});
  const groups = ["@linux", "@windows", "@mac", "@gpu", ...Object.keys(cfg.groups ?? {}).map((g) => "@" + g)];
  const recipes = Object.keys(cfg.recipes ?? {});
  const services = [...new Set(Object.values(cfg.hosts).flatMap((h) => Object.keys(h.services ?? {})))];
  const sels = ["all", ...groups, ...hosts, ...routes, ...machines];
  const svcCmds = "restart logs svc";   // commands whose args include service names
  if (shell === "zsh") return `#compdef fleet
_fleet() {
  local -a cmds=${shellArray(SUBCOMMANDS)}
  local -a sels=${shellArray(sels)}
  local -a svcs=${shellArray(services)}
  local -a recipes=${shellArray(recipes)}
  if (( CURRENT == 2 )); then compadd -- "\${cmds[@]}"; return; fi
  case $words[2] in
    run) compadd -- "\${recipes[@]}";;
    ${svcCmds.split(" ").join("|")}) compadd -- "\${sels[@]}" "\${svcs[@]}";;
    boot|switch|wait|exec|spawn|cp|edit|reboot|bios|top|shot|cu|ssh|doctor|status|deploy|proxy) compadd -- "\${sels[@]}";;
  esac
}
compdef _fleet fleet`;
  // default: bash
  return `_fleet_matches() {
  local prefix="$1" candidate
  shift
  COMPREPLY=()
  for candidate in "$@"; do
    [[ "$candidate" == "$prefix"* ]] && COMPREPLY+=("$candidate")
  done
}
_fleet() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local -a cmds=${shellArray(SUBCOMMANDS)}
  local -a sels=${shellArray(sels)}
  local -a svcs=${shellArray(services)}
  local -a recipes=${shellArray(recipes)}
  if [ "\$COMP_CWORD" -eq 1 ]; then _fleet_matches "$cur" "\${cmds[@]}"; return; fi
  case "\${COMP_WORDS[1]}" in
    run) _fleet_matches "$cur" "\${recipes[@]}";;
    ${svcCmds.split(" ").join("|")}) _fleet_matches "$cur" "\${sels[@]}" "\${svcs[@]}";;
    boot|switch|wait|exec|spawn|cp|edit|reboot|bios|top|shot|cu|ssh|doctor|status|deploy|proxy) _fleet_matches "$cur" "\${sels[@]}";;
  esac
}
complete -F _fleet fleet`;
}

/**
 * Pull `--proxy NAME|URL` / `--no-proxy` out of the LEADING flag run — the same
 * position every other fleet flag takes — and publish the choice through the
 * environment, which is also how it reaches `fleet __proxy-connect`.
 *
 * `--proxy` uses its own variable rather than FLEET_PROXY so it still wins when
 * FLEET_NO_PROXY=1 is exported in the shell.
 */
export function applyProxyFlags(rest: string[], env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  let explicit: string | undefined;
  let off = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith("-")) { out.push(...rest.slice(i)); break; }
    if (token === "--") { out.push(...rest.slice(i)); break; }
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    if (name === "--no-proxy") { off = true; continue; }
    if (name === "--proxy") {
      const value = eq > 0 ? token.slice(eq + 1) : rest[++i];
      if (!value || value.startsWith("--")) die("--proxy needs a proxy name or URL (or use --no-proxy)");
      explicit = value; continue;
    }
    out.push(token);
  }
  if (explicit && off) die("--proxy and --no-proxy cannot be combined");
  if (explicit) { env.FLEET_PROXY_OVERRIDE = explicit; delete env.FLEET_NO_PROXY; }
  if (off) { env.FLEET_NO_PROXY = "1"; delete env.FLEET_PROXY_OVERRIDE; delete env.FLEET_PROXY; }
  return out;
}

async function dispatch(command: string | undefined, rest0: string[], cfg: FleetConfig): Promise<number> {
  let rest = applyProxyFlags(rest0);
  switch (command) {
    case undefined: case "help": case "-h": case "--help":
      console.log(helpText(["help", ...rest]));
      return 0;

    case "ls": case "hosts": {
      const { flags, rest: pos } = parseFlags(rest, ["--json"], []);
      if (pos.length) die(`usage: fleet ${command} [--json]`);
      const json = flags["--json"] === true;
      const anyProxy = Object.values(cfg.hosts).some((h) => h.proxy) || !!cfg.defaultProxy
        || !!process.env.FLEET_PROXY || !!process.env.FLEET_PROXY_OVERRIDE;
      const row = (h: { up: boolean; httpUp?: boolean; name: string; os: string; ssh: string; services: string[]; proxy: string | null; proxyDown?: boolean }) => {
        const dot = h.up ? A.g("●") : h.proxyDown ? A.y("◌") : h.httpUp ? A.y("◍") : A.r("○");
        // "proxy down" and "host down" are different facts. Conflating them sends
        // someone to power-cycle a box that was never contacted.
        const note = h.proxyDown ? A.y(`proxy down          `)
          : !h.up && h.httpUp ? A.y("ssh-down · http ok  ") : "";
        const via = anyProxy ? A.d((h.proxy ?? "-").padEnd(16)) + " " : "";
        return `${dot} ${A.b(h.name.padEnd(10))} ${A.d(h.os.padEnd(8))} ${A.d(h.ssh.padEnd(16))} ${via}${note}${A.d(h.services.join(", "))}`;
      };
      if (json) { console.log(JSON.stringify(await lsHosts(cfg), null, 2)); return 0; }
      // stream each host as it resolves (fastest first) — don't block on the slowest/dead host
      await lsHosts(cfg, (h) => console.log(row(h)));
      return 0;
    }

    case "dt": {
      const { flags, rest: pos } = parseFlags(rest, ["--json"], []);
      if (pos.length) die("usage: fleet dt [--json]");
      const json = flags["--json"] === true;
      const { listSandboxes } = await import("./daytona.ts");
      const boxes = await listSandboxes();
      if (json) { console.log(JSON.stringify(boxes, null, 2)); return 0; }
      if (!boxes.length) { console.log(A.d("no live sandboxes")); return 0; }
      for (const s of boxes) {
        const dot = s.state === "started" ? A.g("●") : s.state === "stopped" ? A.d("○") : A.y("◍");
        const labels = s.labels ? Object.entries(s.labels).map(([k, v]) => `${k}=${v}`).join(" ") : "";
        console.log(`${dot} ${A.b((s.name ?? s.id).padEnd(28))} ${A.d(s.state.padEnd(10))} ${A.d(s.id.padEnd(38))} ${A.d(labels)}`);
      }
      console.log(A.d(`\n  use:  fleet exec dt:<name|id|prefix> "<cmd>"   |   fleet cp <file> dt:<name>:<path>`));
      return 0;
    }

    case "exec": {
      // Flags are parsed from the LEADING tokens only, so a --wsl/--json/… inside
      // the remote command is passed through verbatim instead of being hijacked.
      const EXEC_BOOLS = ["--json", "--wsl", "--raw", "--sudo", "--confirm-reboot", "--fresh"];
      const EXEC_VALUES = ["--cwd", "--timeout", "--script", "--interp"];
      const { flags, rest: pos } = parseLeadingFlags(rest, EXEC_BOOLS, EXEC_VALUES);
      const json = flags["--json"] === true;
      const wsl = flags["--wsl"] === true;
      const sudo = flags["--sudo"] === true;          // run as root; a password comes from hosts.<h>.sudo
      const confirmReboot = flags["--confirm-reboot"] === true;
      const fresh = flags["--fresh"] === true;        // a new ssh login: no shared master, no kept-open session
      const raw = flags["--raw"] === true; // print ONLY remote stdout — no header, no indent (for piping/backup)
      if (raw && json) die("choose either --raw or --json");
      const cwd = typeof flags["--cwd"] === "string" && flags["--cwd"] ? flags["--cwd"] : undefined; // run in this dir (fails fast if missing)
      const timeout = numFlag(flags, "--timeout", 0, 0);  // wall-clock cap in seconds; 0 = none (FLEET_EXEC_TIMEOUT env also works)
      const timeoutMs = flags["--timeout"] === undefined ? undefined : timeout * 1000;
      // --script ships a LOCAL file (or stdin) as the program: no cp to /tmp, no
      // remote leftovers, and the source never touches a shell command line.
      const scriptPath = typeof flags["--script"] === "string" && flags["--script"] ? flags["--script"] : undefined;
      const interp = typeof flags["--interp"] === "string" && flags["--interp"] ? flags["--interp"] : undefined;
      const sel = pos.shift();
      const separated = pos[0] === "--";
      if (separated) pos.shift();
      const cmd = pos.join(" ");
      if (scriptPath) {
        if (!sel) die("usage: fleet exec --script <file|-> [--interp cmd] [--cwd dir] [--timeout S] [--wsl] [--sudo] [--raw] [--json] <sel>");
        if (cmd) die(`fleet exec --script takes no command after <sel> (got '${cmd}') — the script IS the command`);
        const script = await readScriptSource(scriptPath);
        const refusal = confirmReboot ? null : rebootRefusal(script.source, "--confirm-reboot");
        if (refusal) die(refusal);
        const results = await runScript(cfg, await routeSelector(cfg, sel!), script, { wsl, cwd, timeoutMs, interp, sudo, fresh });
        if (json) console.log(JSON.stringify(results, null, 2));
        else if (raw) results.forEach(printRaw);
        else { results.forEach(printResult); await printBootMismatch(cfg, results); }
        return results.some((r) => !r.ok) ? 1 : 0;
      }
      if (interp) die("--interp requires --script");
      if (!sel || !cmd) die("usage: fleet exec [--cwd dir] [--timeout S] [--wsl] [--sudo] [--fresh] [--confirm-reboot] [--raw] [--json] <sel> <cmd…>   |   fleet exec --script <file|-> <sel>");
      // A remote command starting with a fleet flag means the flag was written
      // AFTER <sel>, where it is treated as part of the command and shipped to
      // the remote shell verbatim — which fails far away from the real cause.
      // (`--shell wsl` is a common invention; the real flag is `--wsl`.)
      const strayFlag = !separated && pos[0]?.startsWith("--") ? pos[0] : undefined;
      if (strayFlag === "--shell")
        die(`there is no --shell flag; use --wsl, and put it BEFORE the host: fleet exec --wsl ${sel} <cmd…>`);
      if (strayFlag && [...EXEC_BOOLS, ...EXEC_VALUES].includes(strayFlag))
        die(`'${strayFlag}' must come BEFORE the host selector: fleet exec ${strayFlag} ${sel} <cmd…>`);
      const trailing = separated ? undefined : trailingFleetFlag(pos, EXEC_BOOLS, EXEC_VALUES);
      if (trailing)
        die(`'${trailing}' must come BEFORE the host selector: fleet exec ${trailing} ${sel} <cmd…>  (quote the whole command if it really ends in ${trailing})`);
      // a bare machine name (dual-boot box) auto-routes to whichever boot is live
      const refusal = confirmReboot ? null : rebootRefusal(cmd, "--confirm-reboot");
      if (refusal) die(refusal);
      const dropped = droppedStdinCheck(cmd);
      if (dropped.refuse) die(dropped.refuse);
      if (dropped.warn) console.error(A.y(dropped.warn));
      const target = await routeSelector(cfg, sel!);
      const results = await runExec(cfg, target, cmd, { wsl, cwd, timeoutMs, sudo, fresh });
      if (json) console.log(JSON.stringify(results, null, 2));
      else if (raw) results.forEach(printRaw);
      else { results.forEach(printResult); await printBootMismatch(cfg, results); }
      return results.some((r) => !r.ok) ? 1 : 0;
    }

    case "spawn": {
      const { flags, rest: pos } = parseLeadingFlags(rest, ["--json", "--wsl", "--elevated", "--confirm-reboot", "--fresh"], ["--cwd", "--label"]);
      const json = flags["--json"] === true;
      const wsl = flags["--wsl"] === true;
      const elevated = flags["--elevated"] === true;
      const cwd = typeof flags["--cwd"] === "string" && flags["--cwd"] ? flags["--cwd"] : undefined;
      const label = typeof flags["--label"] === "string" && flags["--label"] ? flags["--label"] : undefined;
      const sel = pos.shift();
      const separated = pos[0] === "--";
      if (separated) pos.shift();
      const cmd = pos.join(" ");
      if (!sel || !cmd) die("usage: fleet spawn [--wsl] [--elevated] [--fresh] [--cwd dir] [--label name] [--json] <sel> <cmd…>");
      const misplaced = separated ? undefined : ["--cwd", "--label", "--json", "--wsl", "--elevated", "--confirm-reboot", "--fresh", "--name"].includes(pos[0] ?? "") ? pos[0]
        : trailingFleetFlag(pos, ["--json", "--wsl", "--elevated", "--confirm-reboot", "--fresh"], ["--cwd", "--label", "--name"]);
      if (misplaced === "--name")
        die("there is no --name flag; use --label, and put it BEFORE the host: fleet spawn --label <name> " + sel + " <cmd…>");
      if (misplaced)
        die("'" + misplaced + "' must come BEFORE the host selector: fleet spawn " + misplaced + " <value> " + sel + " <cmd…>  (quote the whole command if it really ends in " + misplaced + ")");
      const refusal = flags["--confirm-reboot"] === true ? null : rebootRefusal(cmd, "--confirm-reboot");
      if (refusal) die(refusal);
      const dropped = droppedStdinCheck(cmd);
      if (dropped.refuse) die(dropped.refuse);
      if (dropped.warn) console.error(A.y(dropped.warn));
      const results = await spawnJob(cfg, await routeSelector(cfg, sel!), cmd, { cwd, label, wsl, elevated, fresh: flags["--fresh"] === true });
      if (json) { console.log(JSON.stringify(results, null, 2)); return results.some((r) => !r.ok) ? 1 : 0; }
      for (const r of results) {
        if (r.ok) console.log(`${A.g("●")} ${A.b(r.host)} ${A.d("job")} ${A.c(r.id!)} ${A.d("· pid " + r.pid)}  ${A.d("fleet jobs tail " + r.host + ":" + r.id)}`);
        else console.error(`${A.r("●")} ${A.b(r.host + ":" + r.id)} ${A.y(r.error ?? "spawn failed")}\nInspect with fleet jobs log ${r.host}:${r.id} before retrying.`);
      }
      return results.some((r) => !r.ok) ? 1 : 0;
    }

    case "jobs": {
      // Normalize only owned aliases, then validate before resolving any host.
      const parsed = parseFlags(rest, ["--json", "-f", "--follow", "--all"], ["-n", "--lines", "--until", "--timeout"]);
      rest = parsed.rest;
      const flags = parsed.flags;
      for (const [alias, canonical] of [["--lines", "-n"], ["--follow", "-f"]] as const) {
        if (flags[alias] === undefined) continue;
        if (flags[canonical] !== undefined) die(`duplicate option: ${canonical} and ${alias}`);
        flags[canonical] = flags[alias]!;
        delete flags[alias];
      }
      const json = flags["--json"] === true;
      const verb = rest[0];
      const allowed: Record<string, string[]> = {
        list: ["--json"], log: ["--json"], tail: ["--json", "-n", "-f"],
        kill: ["--json"], wait: ["--json", "--until", "--timeout"], prune: ["--json", "--all"],
      };
      const action = verb && Object.hasOwn(allowed, verb) ? verb : "list";
      for (const flag of Object.keys(flags))
        if (!allowed[action]!.includes(flag)) die(`${flag} is not valid for jobs ${action}`);
      const ADDRESSED = new Set(["log", "tail", "kill", "wait"]);
      if (verb && ADDRESSED.has(verb)) {
        rest.shift();
        if (rest.length < 1 || rest.length > 2 || (rest[0]!.includes(":") && rest.length > 1))
          die(`usage: fleet jobs ${verb} <host:id> (or <host> <id>); try fleet jobs ${verb} --help`);
        if (verb === "log") {
          const { host, output } = await jobLog(cfg, rest[0] ?? die("usage: fleet jobs log <host:id>"), rest[1]);
          if (json) console.log(JSON.stringify({ host, output }, null, 2));
          else process.stdout.write(output.endsWith("\n") || !output ? output : output + "\n");
          return 0;
        }
        if (verb === "tail") {
          const follow = flags["-f"] === true;
          if (follow && json) die("--json cannot be combined with --follow");
          const n = numFlag(flags, "-n", 40);
          const a = rest[0] ?? die("usage: fleet jobs tail <host:id> [-n N] [-f]");
          if (follow) return await jobFollow(cfg, a, rest[1], n);
          const result = await jobTail(cfg, a, rest[1], n);
          if (json) console.log(JSON.stringify(result, null, 2));
          else process.stdout.write(result.output.endsWith("\n") || !result.output ? result.output : result.output + "\n");
          return 0;
        }
        if (verb === "kill") {
          const r = await killJob(cfg, rest[0] ?? die("usage: fleet jobs kill <host:id>"), rest[1]);
          if (json) console.log(JSON.stringify(r, null, 2));
          else printResult(r);
          return r.ok ? 0 : 1;
        }
        if (verb === "wait") {
          const until = typeof flags["--until"] === "string" ? flags["--until"] : undefined;
          const timeout = numFlag(flags, "--timeout", 0, 0) * 1000;
          const a = rest[0] ?? die("usage: fleet jobs wait <host:id> [--until regex] [--timeout S]");
          const label = until ? `match /${until}/` : "exit";
          const progress = process.stderr;
          const r = await waitJob(cfg, a, rest[1], {
            until, timeoutMs: timeout,
            onTick: progress.isTTY ? (s, ms) => progress.write(A.d(`\r◎ ${a} ${label}: ${s} ${Math.round(ms / 1000)}s   `)) : undefined,
          });
          if (progress.isTTY) progress.write("\r\x1b[K");
          // exit code is scriptable: matched → 0, timeout → 124 (timeout(1) convention),
          // exited → the job's own code (so `fleet jobs wait X && deploy` works).
          const exitCode = r.outcome === "matched" ? 0 : r.outcome === "timeout" ? 124 : (r.code ?? 1);
          if (json) { console.log(JSON.stringify(r, null, 2)); return exitCode; }
          const tag = r.outcome === "matched" ? A.g("● matched") : r.outcome === "exited"
            ? (r.code === 0 ? A.g("● exit 0") : A.r("● exit " + r.code)) : A.y("○ " + r.outcome);
          console.log(`${tag} ${A.b(r.host + ":" + r.id)} ${A.d(`(${Math.round(r.elapsedMs / 1000)}s)`)}`);
          return exitCode;
        }
      }
      if (verb === "prune") {
        rest.shift();
        if (rest.length > 1) die("usage: fleet jobs prune [<sel>] [--all] [--json]");
        const all = flags["--all"] === true;
        const out = await pruneJobs(cfg, await routeSelector(cfg, rest[0] ?? "all"), all);
        if (json) { console.log(JSON.stringify(out, null, 2)); return out.some((o) => o.error) ? 1 : 0; }
        for (const o of out) {
          if (o.error) console.log(`${A.r("✗")} ${A.b(o.host)} ${A.y("prune failed: " + o.error)}`);
          else console.log(`${A.d("⌫")} ${A.b(o.host)} ${A.d("pruned " + o.removed + " job(s)")}`);
        }
        return out.some((o) => o.error) ? 1 : 0;
      }
      // bare list (optional selector)
      if (verb === "list") rest.shift();
      if (rest.length > 1) die("usage: fleet jobs [list] [<sel>] [--json]");
      const listErrors: string[] = [];
      const rows = await listJobs(cfg, await routeSelector(cfg, rest[0] ?? "all"),
        (h, e) => listErrors.push(`${h}: ${e}`));
      for (const e of listErrors) console.error(`${A.r("✗")} ${A.y("jobs list failed on " + e)}`);
      if (json) { console.log(JSON.stringify(rows, null, 2)); return listErrors.length ? 1 : 0; }
      if (!rows.length) { console.log(A.d(listErrors.length ? "no jobs (some hosts failed)" : "no jobs")); return listErrors.length ? 1 : 0; }
      const dot = (s: JobRow["status"]) => s === "running" ? A.g("●") : s === "exited" ? A.d("○") : A.r("✗");
      const ago = (t: number | null) => t == null ? "" : `${Math.max(0, Math.round((Date.now() / 1000 - t) / 60))}m`;
      for (const r of rows)
        console.log(`${dot(r.status)} ${A.b((r.host + ":" + r.id).padEnd(22))} ${A.d(r.status.padEnd(8))} ${A.d((r.status === "exited" ? "exit " + r.code : ago(r.started)).padEnd(8))} ${A.d("pid " + (r.pid ?? "—")).padEnd(14)} ${r.cmd}`);
      return listErrors.length ? 1 : 0;
    }

    case "cp": {
      const parsed = parseFlags(rest, ["--json", "-r", "--recursive", "--resume"], []);
      rest = parsed.rest;
      const json = parsed.flags["--json"] === true;
      const recursive = parsed.flags["-r"] === true || parsed.flags["--recursive"] === true;
      const resume = parsed.flags["--resume"] === true;
      const usage = "usage: fleet cp [-r] [--resume] <local...> <sel>:<remote-dir>   |   fleet cp [-r] [--resume] <sel>:<remote...> <local-dir>";
      // Everything but the last token is a source; the last token is the destination.
      // With >1 source the destination must be a directory (scp enforces that).
      const dest = rest[rest.length - 1];
      const srcs = rest.slice(0, -1);
      if (!dest || !srcs.length) die(usage);
      const push = parseRemoteSpec(cfg, dest!);          // local → remote (destination is remote)
      const srcSpecs = srcs.map((s) => parseRemoteSpec(cfg, s));
      if (push) {
        if (srcSpecs.some(Boolean)) die("remote → remote copy is not supported (pull to a local file first)");
        const sel = await routeSelector(cfg, push.sel);
        // One meter per terminal: parallel copies to several hosts would overwrite each other's line.
        const progress = !json && !!process.stdout.isTTY && resolveHosts(cfg, sel).length === 1;
        const results = await pushFile(cfg, srcs, sel, push.path, recursive, { resume, progress });
        if (json) console.log(JSON.stringify(results, null, 2));
        else for (const r of results)
          console.log(`${r.ok ? A.g("●") : A.r("●")} ${A.b(r.host)} ${A.d(srcs.join(" ") + " → " + push.path)}${r.stderr ? "\n  " + A.d(r.stderr) : ""}`);
        return results.some((r) => !r.ok) ? 1 : 0;
      }
      if (srcSpecs.every(Boolean)) {
        const specs = srcSpecs as { sel: string; path: string }[];
        // One local destination means one source host — a mixed-selector pull would
        // race two hosts into the same directory with no way to tell them apart.
        if (new Set(specs.map((s) => s.sel)).size > 1)
          die(`fleet cp pulls from one host at a time (got ${[...new Set(specs.map((s) => s.sel))].join(", ")})`);
        const r = await pullFile(cfg, await routeSelector(cfg, specs[0]!.sel), specs.map((s) => s.path), dest!, recursive,
          { resume, progress: !json && !!process.stdout.isTTY });
        if (json) console.log(JSON.stringify(r, null, 2));
        else console.log(`${r.ok ? A.g("●") : A.r("●")} ${A.b(r.host)} ${A.d(specs.map((s) => s.path).join(" ") + " → " + dest)}${r.stderr ? "\n  " + A.d(r.stderr) : ""}`);
        return r.ok ? 0 : 1;
      }
      if (srcSpecs.some(Boolean)) die("mix of local and remote sources — every source must be on the same side");
      return die(usage);
    }

    case "edit": {
      // Unlike exec there is no free-form remote command here, so flags are safe
      // to accept anywhere — `fleet edit host:/path --old X --new Y` reads best.
      const { flags, rest: pos } = parseFlags(rest,
        ["--json", "--wsl", "--all", "--dry-run", "--sudo"],
        ["--old", "--new", "--old-file", "--new-file", "--edits"], false, ["--new"]);
      const json = flags["--json"] === true;
      const wsl = flags["--wsl"] === true;
      const all = flags["--all"] === true;
      const dryRun = flags["--dry-run"] === true;
      const sudo = flags["--sudo"] === true;
      // Multi-line text is easiest from a file or stdin: the shell never gets a
      // chance to keep `\n` literal. Fleet never unescapes --old/--new itself.
      const fromFile = async (flag: "--old-file" | "--new-file", inline: "--old" | "--new") => {
        const src = flags[flag] as string | undefined;
        if (src === undefined) return flags[inline] as string | undefined;
        return src === "-" ? await Bun.stdin.text() : await readFile(src, "utf8");
      };
      const usage = "usage: fleet edit [--all] [--dry-run] [--sudo] [--wsl] [--json] <sel>:<path> --old <str>|--old-file <file|-> [--new <str>|--new-file <file|->]\n"
        + "       fleet edit [--dry-run] [--sudo] [--wsl] [--json] <sel>:<path> --edits <file|->";
      const [target] = pos;
      if (!target || pos.length !== 1) die(usage);
      for (const [inline, file] of [["--old", "--old-file"], ["--new", "--new-file"]] as const)
        if (flags[inline] !== undefined && flags[file] !== undefined)
          die(`fleet edit: pass ${inline} or ${file}, not both`);
      let edits: EditSpec[];
      if (flags["--edits"] !== undefined) {
        const clash = ["--old", "--new", "--old-file", "--new-file", "--all"].filter((f) => flags[f] !== undefined);
        if (clash.length) die(`fleet edit: --edits replaces ${clash.join(", ")}; put old, new and all inside each edit`);
        const src = flags["--edits"] as string;
        edits = parseEditList(src === "-" ? await Bun.stdin.text() : await readFile(src, "utf8"), src === "-" ? "stdin" : src);
      } else {
        if (flags["--old-file"] === "-" && flags["--new-file"] === "-") die("fleet edit: only one of --old-file/--new-file can read stdin");
        const old = await fromFile("--old-file", "--old");
        if (old === undefined) die(usage);
        if (!old) die("fleet edit: --old cannot be empty");
        edits = [{ old: old!, new: (await fromFile("--new-file", "--new")) ?? "", all }];
      }
      const spec = parseRemoteSpec(cfg, target!);
      if (!spec) die(`fleet edit needs a <sel>:<path> target (got '${target}')`);
      const results = await editRemoteFile(
        cfg, await routeSelector(cfg, spec!.sel), spec!.path, edits, { wsl, dryRun, sudo });
      if (json) { console.log(JSON.stringify(results, null, 2)); return results.some((r) => !r.ok) ? 1 : 0; }
      for (const r of results) {
        if (!r.ok) { console.log(`${A.r("●")} ${A.b(r.host)} ${A.d(r.path)}  ${A.y(r.error ?? "edit failed")}`); continue; }
        const what = `${r.replacements} replacement${r.replacements === 1 ? "" : "s"}`
          + (r.lineEndings ? A.d(` · newlines written as ${r.lineEndings.toUpperCase()} to match the file`) : "")
          + (dryRun ? A.y(" (dry run — nothing written)") : "");
        console.log(`${A.g("●")} ${A.b(r.host)} ${A.d(r.path)}  ${what}`);
        // always show what landed: a remote edit is the case you can least easily eyeball afterwards
        for (const line of r.diff.split("\n").filter(Boolean))
          console.log("  " + (line.startsWith("-") ? A.r(line) : line.startsWith("+") ? A.g(line) : A.d(line)));
      }
      return results.some((r) => !r.ok) ? 1 : 0;
    }

    case "restart": {
      const { rest: pos } = parseFlags(rest, [], []);
      const [sel, svcName] = pos;
      if (!sel || !svcName || pos.length !== 2) die("usage: fleet restart <sel> <service>");
      const actions = await restartService(cfg, await routeSelector(cfg, sel!), svcName!);
      for (const a of actions) {
        console.log(A.d(`↻ ${a.host} :: ${a.service} (${a.type})`));
        printResult(a.result);
      }
      return actions.some((a) => !a.result.ok) ? 1 : 0;
    }

    case "reboot": {
      const { flags, rest: pos } = parseFlags(rest, ["--yes", "-y"], []);
      const yes = flags["--yes"] === true || flags["-y"] === true;
      const [sel] = pos;
      if (!sel || pos.length !== 1) die("usage: fleet reboot <sel> [--yes]");
      const routed = await routeSelector(cfg, sel!);
      const hosts = resolveHosts(cfg, routed).map((h) => h.name);
      if (!await confirm(`reboot ${A.b(hosts.join(", "))} (this drops the connection)`, yes)) return 1;
      const actions = await rebootHosts(cfg, routed);
      for (const a of actions)
        console.log(`${a.result.ok ? A.g("↻") : A.r("✗")} ${A.b(a.host)} ${A.d("· " + a.os + (a.result.ok ? " · rebooting" : " · exit " + a.result.code))}${a.result.stderr ? "\n  " + A.d(a.result.stderr) : ""}`);
      return actions.some((a) => !a.result.ok) ? 1 : 0;
    }

    case "bios": {
      const { flags, rest: pos } = parseFlags(rest, ["--yes", "-y"], []);
      const yes = flags["--yes"] === true || flags["-y"] === true;
      const [sel] = pos;
      if (!sel || pos.length !== 1) die("usage: fleet bios <sel> [--yes]");
      const routed = await routeSelector(cfg, sel!);
      const hosts = resolveHosts(cfg, routed).map((h) => h.name);
      if (!await confirm(`reboot ${hosts.join(", ")} into BIOS/UEFI setup (drops the connection)`, yes)) return 1;
      const actions = await firmwareRebootHosts(cfg, routed);
      for (const a of actions)
        console.log(`${a.result.ok ? A.g("↻") : A.r("✗")} ${A.b(a.host)} ${A.d("· " + a.os + (a.result.ok ? " · entering firmware" : " · " + (a.result.stderr || "exit " + a.result.code)))}`);
      return actions.some((a) => !a.result.ok) ? 1 : 0;
    }

    case "logs": {
      const { flags, rest: pos } = parseFlags(rest, [], ["-n"]);
      const n = numFlag(flags, "-n", 30);
      const [sel, svcName] = pos;
      if (!sel || !svcName || pos.length !== 2) die("usage: fleet logs <sel> <service> [-n N]");
      const actions = await serviceLogs(cfg, await routeSelector(cfg, sel!), svcName!, n);
      for (const a of actions) {
        if (actions.length > 1) console.log(A.d(`— ${a.host} :: ${a.service}`));
        printResult(a.result);
      }
      return actions.some((a) => !a.result.ok) ? 1 : 0;
    }

    case "svc": case "service": {
      const { flags, rest: pos } = parseFlags(rest, ["--json"], []);
      const json = flags["--json"] === true;
      const name = pos[0];
      const sel = pos[1] ?? "all";
      if (!name || pos.length > 2) die("usage: fleet svc <service> [sel]   (status across every host that has it)");
      const rows = await svcStatus(cfg, await routeSelector(cfg, sel), name!);
      if (json) { console.log(JSON.stringify(rows, null, 2)); return rows.some((r) => !r.up) ? 1 : 0; }
      for (const r of rows)
        console.log(`${r.up ? A.g("●") : A.r("○")} ${A.b(r.host.padEnd(10))} ${A.d(r.service.padEnd(16))} ${r.up ? A.g(r.detail) : A.y(r.detail)} ${A.d("(" + r.type + ")")}`);
      return rows.some((r) => !r.up) ? 1 : 0;
    }

    case "gpu": {
      const { flags, rest: pos } = parseFlags(rest, ["--json"], []);
      if (pos.length) die("usage: fleet gpu [--json]");
      const json = flags["--json"] === true;
      const rows = await gpuRows(cfg);
      if (!rows.length) die("no GPUs reported by the dashboard");
      if (json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
      for (const r of rows)
        console.log(`${A.b(r.host.padEnd(9))} ${A.c(r.gpu.padEnd(22))} ${A.d("util")} ${heat(r.util, (((r.util ?? 0) | 0) + "%").padEnd(5))} ${A.d("free")} ${A.g((r.free_gb?.toFixed(1) ?? "—") + "g").padEnd(16)} ${A.d("temp")} ${((r.temp ?? 0) | 0)}°c   ${r.model ? A.y(r.model) : A.d("idle")}`);
      return 0;
    }

    case "disk": {
      const { flags, rest: pos } = parseFlags(rest, ["--json"], []);
      if (pos.length > 1) die("usage: fleet disk [<sel>] [--json]");
      const json = flags["--json"] === true;
      const sel = pos[0] ?? "all";
      const rows = await diskRows(cfg, await routeSelector(cfg, sel));
      if (!rows.length) die(`no volumes reported by ${sel}`);
      if (json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
      const w = Math.max(...rows.map((r) => r.mount.length));
      let last = "";
      for (const r of rows) {
        const head = r.host === last ? " ".repeat(9) : A.b(r.host.padEnd(9));
        last = r.host;
        const bar = heat(r.pct, (r.pct.toFixed(0) + "%").padStart(4));
        const size = A.d(`${r.free_gb.toFixed(1)}g free of ${r.total_gb.toFixed(0)}g`);
        console.log(`${head} ${A.c(r.mount.padEnd(w))} ${bar} used  ${size}${r.label ? "  " + A.d(r.label) : ""}`);
      }
      return 0;
    }

    case "ps": {
      const { flags, rest: pos } = parseFlags(rest, ["--json"], ["--sort", "-n"]);
      if (pos.length < 1 || pos.length > 2) die("usage: fleet ps <sel> [FILTER] [--sort cpu|mem] [-n N] [--json]");
      const [sel, filter] = pos as [string, string | undefined];
      const sort = flags["--sort"] as "cpu" | "mem" | undefined;
      const n = flags["-n"] === undefined ? (filter ? undefined : 20) : Number(flags["-n"]);
      const lists = await processList(cfg, await routeSelector(cfg, sel), { filter, sort, limit: n });
      if (flags["--json"] === true) { console.log(JSON.stringify(lists, null, 2)); return lists.some((l) => !l.ok) ? 1 : 0; }
      for (const l of lists) {
        if (!l.ok) { console.log(`${A.r("✗")} ${A.b(l.host)} ${A.d(l.error ?? "")}`); continue; }
        console.log(`${A.b(l.host)} ${A.d(`· ${l.rows.length} process${l.rows.length === 1 ? "" : "es"}`)}`);
        for (const r of l.rows) {
          const cpu = r.cpu === null ? "   —" : r.cpu.toFixed(1).padStart(5);
          const mem = r.mem_mb >= 1024 ? `${(r.mem_mb / 1024).toFixed(1)}g` : `${Math.round(r.mem_mb)}m`;
          const tags = [r.job ? A.c(`job:${r.job}`) : "", r.protected ? A.y("protected") : "",
            r.session === 0 ? A.d("session 0") : ""].filter(Boolean).join(" ");
          console.log(`  ${String(r.pid).padStart(7)} ${A.b(r.name.slice(0, 22).padEnd(22))} ${heat(r.cpu ?? 0, cpu + "%")} ${mem.padStart(6)} ${A.d(ageText(r.age_s).padStart(5))} ${A.d((r.user ?? "").slice(0, 10).padEnd(10))} ${tags ? tags + " " : ""}${A.d(r.cmd.slice(0, 90))}`);
        }
      }
      return lists.some((l) => !l.ok) ? 1 : 0;
    }

    case "kill": {
      const { flags, rest: pos } = parseFlags(rest,
        ["--tree", "--force", "--all", "--system", "--dry-run", "--sudo", "--yes", "-y", "--json"], ["--grace"]);
      if (pos.length !== 2) die("usage: fleet kill <sel> <PID[,PID…]|NAME> [--tree] [--force] [--all] [--system] [--grace S] [--dry-run] [--sudo] [--yes] [--json]");
      const [sel, spec] = pos as [string, string];
      const json = flags["--json"] === true;
      const opts = { tree: flags["--tree"] === true, force: flags["--force"] === true, all: flags["--all"] === true,
        system: flags["--system"] === true, graceS: flags["--grace"] === undefined ? undefined : Number(flags["--grace"]) };
      const routed = await routeSelector(cfg, sel);
      const wrap = flags["--sudo"] === true ? (h: Host, cmd: string) => sudoWrap(h, cmd, false) : undefined;
      // Plan first, show it, confirm, then kill exactly the planned pids.
      const plans = await processKill(cfg, routed, spec, { ...opts, dryRun: true });
      if (flags["--dry-run"] === true || plans.every((p) => !p.ok)) {
        if (json) console.log(JSON.stringify(plans, null, 2));
        else for (const p of plans) renderKill(p);
        return plans.some((p) => !p.ok) ? 1 : 0;
      }
      const foreign = plans.flatMap((p) => p.targets.filter((t) => !t.job));
      if (!json) for (const p of plans) renderKill(p);
      if (foreign.length && !await confirm(`kill ${foreign.length} process${foreign.length === 1 ? "" : "es"} no fleet job started`,
        flags["--yes"] === true || flags["-y"] === true)) return 1;
      const results = await Promise.all(plans.map(async (p) => {
        if (!p.ok) return p;
        const [r] = await processKill(cfg, p.host, p.targets.map((t) => t.pid).join(","), { ...opts, tree: false, all: true }, { wrap });
        return r!;
      }));
      if (json) console.log(JSON.stringify(results, null, 2));
      else for (const r of results) renderKill(r);
      return results.some((r) => !r.ok) ? 1 : 0;
    }

    case "status": {
      const { flags, rest: pos } = parseFlags(rest, ["--json"], []);
      if (pos.length > 1) die("usage: fleet status [<host>] [--json]");
      const json = flags["--json"] === true;
      const filter = pos[0];
      if (json) {
        // preserve the old `--json` shape: the full raw dashboard payload
        console.log(JSON.stringify(await fetchDashboard(cfg), null, 2));
        return 0;
      }
      const { nodes, uptime } = await hostStatus(cfg, filter);
      for (const [k, n] of Object.entries<any>(nodes)) {
        const mem = n.mem ?? {}, disk = (n.disks ?? [])[0] ?? {}, gpu = (n.gpu ?? [])[0];
        const g = gpu ? `  ${A.d("gpu")} ${heat(gpu.util, (gpu.util | 0) + "%")} ${(gpu.temp | 0)}°c` : "";
        console.log(`${n.stale ? A.y("●") : A.g("●")} ${A.b(k.padEnd(9))} ${A.d("cpu")} ${heat(n.cpu_pct, ((n.cpu_pct ?? "—") + "%").padEnd(5))} ${A.d("mem")} ${heat(mem.pct, ((mem.pct ?? "—") + "%").padEnd(5))} ${A.d("disk")} ${heat(disk.pct, ((disk.pct ?? "—") + "%").padEnd(5))}${g}`);
      }
      for (const e of uptime) {
        const up = e.code && e.code < 400;
        console.log(`${up ? A.g("●") : A.r("○")} ${A.b(e.label.padEnd(16))} ${A.d((e.ms ?? "—") + "ms")} ${A.d("code " + (e.code ?? "down"))}`);
      }
      return 0;
    }

    case "top": {
      const { rest: pos } = parseFlags(rest, [], []);
      const [sel] = pos;
      if (!sel || pos.length !== 1) die("usage: fleet top <host>");
      const host = resolveHosts(cfg, await routeSelector(cfg, sel))[0]!.name;
      return await topLoop(cfg, host);
    }

    case "shot": case "screenshot": {
      const { flags, rest: pos } = parseFlags(rest, ["--no-open", "--grid", "--list", "--json", "--wake"], ["--grid-step", "--out", "--output", "--monitor", "--region"]);
      const noOpen = flags["--no-open"] === true;
      const grid = flags["--grid"] === true;
      const gridStep = numFlag(flags, "--grid-step", 100);
      const out = flags["--out"] as string | undefined;
      if (flags["--output"] !== undefined && flags["--monitor"] !== undefined) die("--monitor is another name for --output; pass one");
      const output = (flags["--output"] ?? flags["--monitor"]) as string | undefined;
      const region = flags["--region"] as string | undefined;
      const [sel] = pos;
      if (!sel || pos.length !== 1)
        die("usage: fleet shot <host> [--output NAME|main|focused|N] [--region top-right|…|X,Y,W,H] [--wake] [--out file.png] [--grid [--grid-step N]] [--no-open]\n       fleet shot <host> --list [--json]");
      const routed = await routeSelector(cfg, sel);
      if (flags["--list"] === true) {
        const l = await listMonitors(cfg, routed);
        if (flags["--json"] === true) { console.log(JSON.stringify(l, null, 2)); return 0; }
        console.log(`${A.b(l.host)} ${A.d(`monitors from ${l.source}`)}`);
        l.monitors.forEach((m, i) => console.log(`  ${A.d(String(i + 1).padStart(2))} ${A.b(m.name.padEnd(10))} `
          + `${m.width}x${m.height}@${m.x},${m.y} ${A.d(`scale ${m.scale}`)}`
          + `${m.name === l.main ? A.g(" main") : ""}${m.focused ? A.c(" focused") : ""}${m.on === false ? A.y(" off") : ""}`
          + `${m.description ? A.d("  " + m.description) : ""}`));
        return 0;
      }
      const host = resolveHosts(cfg, routed)[0]!;
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const local = out ?? `${host.name}-${ts}.${await preferredImageExt()}`;
      process.stdout.write(A.d(`◎ capturing ${host.name}${output || region ? ` (${[output ?? "main", region].filter(Boolean).join(", ")})` : ""} …\r`));
      const r = await captureScreenshot(cfg, routed, local, {}, { output, region, wake: flags["--wake"] === true });
      if (grid && !await overlayGrid(r.localPath, gridStep)) console.error(A.y("grid overlay skipped (need python3 + Pillow)"));
      console.log(`${A.g("●")} ${A.b(r.host)} ${A.d("→")} ${r.localPath}${grid ? A.d(" (grid)") : ""}`);
      if (!noOpen && process.platform === "darwin")
        Bun.spawn(["open", r.localPath], { stdout: "ignore", stderr: "ignore" });
      return 0;
    }

    case "game": {
      let parsed: ReturnType<typeof parseGameArgv>;
      try { parsed = parseGameArgv(rest); } catch (error) { die((error as Error).message); }
      const { flags, pos } = parsed;
      const [sel, verb, ...ops] = pos;
      if (!sel || !verb) die("usage: fleet game <host> start|status|windows|focus|frame|do|tap|hold|look|click|type|pad|stick|trigger|release|stop (fleet help game)");
      const json = flags["--json"] === true;
      let target: string | undefined;
      let steps: unknown;
      let repeat: number | undefined;
      let doOpts: import("./game.ts").GameDoOptions = {};
      try {
        gameIntFlag(flags, "--repeat", undefined, 0, 1_000_000);
        gameIntFlag(flags, "--max", 1280, 0, 8192);
        gameIntFlag(flags, "--quality", 80, 10, 95);
        gameIntFlag(flags, "--ms", undefined, 0, 600_000);
        gameIntFlag(flags, "--count", undefined, 1, 3);
        gameIntFlag(flags, "--grid-step", 100, 10, 2000);
        if (["do", "tap", "hold", "look", "click", "type", "pad", "stick", "trigger"].includes(verb)) {
          const padVerb = ["pad", "stick", "trigger"].includes(verb);
          repeat = gameIntFlag(flags, "--repeat", undefined, 0, 1_000_000);
          if (verb === "do") {
            const file = flags["--file"] as string | undefined;
            const wantOps = file ? 1 : 2;
            if (ops.length > wantOps || (!file && ops.length < 2))
              die(`usage: fleet game ${sel} do <TARGET|-> <STEPS-JSON|-> | do [TARGET] --file MACRO.json  [--repeat N] [--detach] [--shot] [--max N] [--out FILE]`);
            const source = file ? await readFile(file, "utf8") : ops[1] === "-" ? await Bun.stdin.text() : ops[1]!;
            const macro = parseGameMacro(source, file ?? (ops[1] === "-" ? "stdin" : "steps"));
            steps = macro.steps;
            target = ops[0] && ops[0] !== "-" ? ops[0] : macro.target;
            repeat ??= macro.repeat;
          } else {
            if (!padVerb) { target = ops.shift(); if (!target) die(`usage: fleet game ${sel} ${verb} <TARGET> …`); }
            steps = gameShorthand(verb, ops, { ms: gameIntFlag(flags, "--ms", undefined, 0, 600_000),
              button: flags["--button"] as string | undefined, count: gameIntFlag(flags, "--count", undefined, 1, 3) });
          }
          doOpts = { target, repeat, detach: flags["--detach"] === true, shot: flags["--shot"] === true,
            max: gameIntFlag(flags, "--max", 1280, 0, 8192), quality: gameIntFlag(flags, "--quality", 80, 10, 95) };
          prepareGameDo(steps, doOpts);
        }
      } catch (error) { die(error instanceof Error ? error.message : String(error)); }
      const routed = await routeSelector(cfg, sel);
      const host = resolveHosts(cfg, routed)[0]!.name;
      const win = (w: Pick<GameWindow, "exe" | "title"> & { hwnd: number }) => `${w.exe} ${JSON.stringify(w.title.slice(0, 60))} ${A.d(`hwnd:${w.hwnd}`)}`;
      const runLine = (r: GameRun) => {
        const mark = r.state === "done" ? A.g("●") : r.state === "running" ? A.c("●") : A.r("✗");
        return `${mark} ${A.b(host)} run ${r.id} ${r.state} · ${r.steps} step${r.steps === 1 ? "" : "s"} · loop ${r.loop}${r.repeat ? `/${r.repeat}` : "/∞"} · ${r.seconds}s`
          + (r.target ? ` · ${win(r.target)}` : "");
      };
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const saveFrames = async (frames: GameFrame[]): Promise<string[]> => {
        const out = flags["--out"] as string | undefined;
        const paths: string[] = [];
        for (const [i, f] of frames.entries()) {
          const base = out ?? `${host}-game-${stamp}.jpg`;
          const path = frames.length === 1 ? base : base.replace(/(\.[a-z0-9]+)?$/i, `-${i + 1}$1`);
          await Bun.write(path, Buffer.from(f.jpeg, "base64"));
          if (flags["--grid"] === true && !await overlayGrid(path, {
            step: gameIntFlag(flags, "--grid-step", 100, 10, 2000), caption: `image pixels · ${f.width}x${f.height} · ×${f.scale} = client pixels`,
          })) console.error(A.y("grid overlay skipped (need python3 + Pillow)"));
          paths.push(path);
        }
        if (paths.length && flags["--no-open"] !== true && !json && process.platform === "darwin")
          Bun.spawn(["open", ...paths], { stdout: "ignore", stderr: "ignore" });
        return paths;
      };
      const frameNote = (f: GameFrame) => `${f.width}x${f.height}${f.scale !== 1 ? ` (client ${f.client[0]}x${f.client[1]}, ×${f.scale})` : ""} in ${f.ms} ms`
        + (f.black ? A.y(" · all black: switch the game to borderless windowed") : "");
      try {
        switch (verb) {
          case "start": {
            if (ops.length) die(`usage: fleet game ${sel} start [--force]`);
            if (!json) process.stderr.write(A.d(`◎ starting the game helper on ${host} (the first start installs pillow + vgamepad) …\n`));
            const r = await gameStart(cfg, routed, { force: flags["--force"] === true });
            if (json) { console.log(JSON.stringify(r)); return 0; }
            for (const l of r.log) console.log(A.d(l));
            console.log(`${A.g("●")} ${A.b(host)} game helper ${r.version} ${r.started ? "started" : "already running"} · pid ${r.pid}`);
            return 0;
          }
          case "stop": {
            const r = await gameStop(cfg, routed);
            if (json) { console.log(JSON.stringify(r)); return 0; }
            console.log(r.stopped ? `${A.g("●")} ${A.b(host)} game helper stopped (pid ${r.stopped}); everything held was released and the pad unplugged`
              : `${A.d("○")} ${A.b(host)} game helper was not running`);
            return 0;
          }
          case "status": {
            const r = await gameStatus(cfg, routed);
            if (json) { console.log(JSON.stringify(r)); return 0; }
            if (!r.running) { console.log(`${A.d("○")} ${A.b(host)} ${r.note}`); return 0; }
            console.log(`${A.g("●")} ${A.b(host)} game helper ${r.version} · pid ${r.pid}${r.pad ? " · virtual pad plugged in" : ""}`);
            if (r.note) console.log(A.y(`  ${r.note}`));
            if (r.foreground) console.log(`  foreground ${win(r.foreground)}`);
            console.log(`  held ${r.held.length ? r.held.join(", ") + (r.leaseS ? A.d(` (auto-release in ${r.leaseS}s)`) : "") : A.d("nothing")}`);
            if (r.run) console.log("  " + runLine(r.run) + (r.run.error ? `\n    ${A.r(r.run.error)}` : ""));
            return 0;
          }
          case "release": {
            const r = await gameRelease(cfg, routed, { unplug: flags["--unplug"] === true });
            if (json) { console.log(JSON.stringify(r)); return 0; }
            if (!r.running) { console.log(`${A.d("○")} ${A.b(host)} game helper is not running; nothing is held`); return 0; }
            console.log(`${A.g("●")} ${A.b(host)} released ${r.released.length ? r.released.join(", ") : "nothing held"}`
              + (r.halted ? ` · halted run ${r.halted}` : ""));
            return 0;
          }
          case "windows": {
            if (ops.length > 1) die(`usage: fleet game ${sel} windows [FILTER] [--json]`);
            const r = await gameWindows(cfg, routed, ops[0]);
            if (json) { console.log(JSON.stringify(r)); return 0; }
            for (const w of r) console.log(`${w.foreground ? A.g("●") : w.minimized ? A.d("○") : " "} ${String(w.hwnd).padStart(10)} ${String(w.pid).padStart(6)} ${A.b(w.exe.padEnd(22))} `
              + `${w.minimized ? A.d("minimized") : `${w.width}x${w.height}@${w.x},${w.y}`}  ${w.title.slice(0, 70)}`);
            if (!r.length) console.log(A.d("no windows match"));
            return 0;
          }
          case "focus": {
            if (ops.length !== 1) die(`usage: fleet game ${sel} focus <TARGET>`);
            const r = await gameFocus(cfg, routed, ops[0]!);
            if (json) { console.log(JSON.stringify(r)); return 0; }
            console.log(`${A.g("●")} ${A.b(host)} foreground ${win(r.target)}`);
            return 0;
          }
          case "frame": {
            if (ops.length > 1) die(`usage: fleet game ${sel} frame [TARGET] [--max N] [--quality Q] [--out FILE] [--grid] [--no-open]`);
            const r = await gameFrame(cfg, routed, ops[0], {
              max: gameIntFlag(flags, "--max", 1280, 0, 8192), quality: gameIntFlag(flags, "--quality", 80, 10, 95) });
            const [path] = await saveFrames([r.frame]);
            if (json) { console.log(JSON.stringify({ host, target: r.target, path, ...r.frame, jpeg: undefined })); return 0; }
            console.log(`${A.g("●")} ${A.b(host)} ${r.target ? win(r.target) : "whole primary display"} ${A.d("→")} ${path} ${A.d(frameNote(r.frame))}`);
            return 0;
          }
          case "do": case "tap": case "hold": case "look": case "click": case "type": case "pad": case "stick": case "trigger": {
            const r: GameDoResult = await gameDo(cfg, routed, steps, doOpts);
            const paths = await saveFrames(r.frames);
            if (json) { console.log(JSON.stringify({ ...r, frames: r.frames.map((f, i) => ({ ...f, jpeg: undefined, path: paths[i] })) })); return r.ok ? 0 : 1; }
            console.log(runLine(r.run));
            if (r.error) console.log(`  ${A.r(r.error)}`);
            if (r.run.detached) console.log(A.d(`  runs on ${host}; fleet game ${sel} status follows it, fleet game ${sel} release halts it`));
            if (r.held.length) console.log(`  held ${r.held.join(", ")} ${A.d(`(auto-release in ${r.leaseS}s unless the next call continues)`)}`);
            r.frames.forEach((f, i) => console.log(`  frame ${A.d("→")} ${paths[i]} ${A.d(frameNote(f))}`));
            return r.ok ? 0 : 1;
          }
          default:
            die(`unknown game verb: ${verb} (fleet help game)`);
        }
      } catch (error) { die(error instanceof Error ? error.message : String(error)); }
    }

    case "browse": {
      const { rest: pos } = parseFlags(rest, [], []);
      const [sel, url] = pos;
      if (!sel || pos.length > 2) die("usage: fleet browse <host> [url]");
      const result = await browseHost(cfg, await routeSelector(cfg, sel), url);
      console.log(result.endpoint);
      console.log(JSON.stringify(result.targets, null, 2));
      return 0;
    }

    case "cu": case "computer": {
      const noOpen = pullFlag(rest, "--no-open");
      const grid = pullFlag(rest, "--grid");
      const gridStep = numVal(rest, "--grid-step", 100);
      const gridMinor = numVal(rest, "--grid-minor", 0, 0);
      const noCross = pullFlag(rest, "--no-cross-labels");
      const noComposite = pullFlag(rest, "--no-composite");
      const full = pullFlag(rest, "--full");
      const brief = pullFlag(rest, "--brief");
      const forApp = pullVal(rest, "--for");
      const probeArg = pullVal(rest, "--probe");
      const spaceArg = pullVal(rest, "--space");
      const button = pullVal(rest, "--button");
      const clickCount = numVal(rest, "--count", 1);
      const settle = numVal(rest, "--settle", 400, 0);
      const foreground = pullFlag(rest, "--foreground");
      const wantShot = pullFlag(rest, "--shot");
      const out = pullVal(rest, "--out");
      const elementToken = pullVal(rest, "--element");
      const elementLabel = pullVal(rest, "--label");
      const elementRole = pullVal(rest, "--role");
      const elementNth = pullVal(rest, "--nth");
      const regionText = pullVal(rest, "--region");
      const regionAt = pullVal(rest, "--region-at");
      const regionKind = pullVal(rest, "--kind");
      const sel = rest.shift();
      if (!sel) die("usage: fleet cu <host> <cua-driver args…> [--out f.png] [--grid]  |  fleet cu <sel> install");
      // watch, record and revive run on this machine through its own adb, and
      // revive runs precisely when SSH to the phone is down, so none of them
      // probes the route first.
      if (["revive", "watch", "record"].includes(rest[0] ?? "")) {
        const names = cfg.routes?.[sel]?.prefer ?? [sel];
        const hosts = names.map((n) => cfg.hosts[n]).filter((h): h is NonNullable<typeof h> => !!h?.android);
        if (!hosts.length) die(`${sel} is not an Android host or a route of Android hosts`);
        const json = pullFlag(rest, "--json");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        if (rest[0] === "revive") {
          const restart = pullFlag(rest, "--restart");
          if (rest.length !== 1) die(`usage: fleet cu ${sel} revive [--restart]`);
          const r = await androidRevive(hosts, { restart });
          if (json) { console.log(JSON.stringify(r)); return r.ok ? 0 : 1; }
          for (const s of r.steps) console.log(A.d(`  ${s}`));
          console.log(`${r.ok ? A.g("●") : A.r("✗")} ${r.detail}`);
          return r.ok ? 0 : 1;
        }
        if (rest[0] === "watch") {
          const viewOnly = pullFlag(rest, "--view-only");
          if (rest.length !== 1) die(`usage: fleet cu ${sel} watch [--view-only]`);
          const r = await androidWatch(hosts, { viewOnly });
          if (json) { console.log(JSON.stringify(r)); return r.ok ? 0 : 1; }
          console.log(`${r.ok ? A.g("●") : A.r("✗")} ${r.detail}`);
          return r.ok ? 0 : 1;
        }
        const limitArg = pullVal(rest, "--limit");
        const rateArg = pullVal(rest, "--bit-rate");
        const action = rest[1];
        if (rest.length !== 2 || !["start", "stop", "status"].includes(action ?? ""))
          die(`usage: fleet cu ${sel} record start [--out FILE.mp4] [--limit S] [--bit-rate MBPS] | record stop | record status`);
        if (limitArg !== undefined && (!/^\d+$/.test(limitArg) || Number(limitArg) < 1)) die(`--limit must be a positive integer (got '${limitArg}')`);
        if (rateArg !== undefined && !Number.isFinite(Number(rateArg))) die(`--bit-rate must be a number (got '${rateArg}')`);
        let r;
        try {
          r = action === "start"
            ? await androidRecordStart(hosts, out ?? `${sel}-rec-${stamp}.mp4`,
                { limitS: limitArg === undefined ? undefined : Number(limitArg), bitRateMbps: rateArg === undefined ? undefined : Number(rateArg) })
            : action === "status" ? await androidRecordStatus(hosts) : await androidRecordStop(hosts);
        } catch (error) { die(error instanceof Error ? error.message : String(error)); }
        if (json) { console.log(JSON.stringify(r)); return r.ok ? 0 : 1; }
        console.log(`${!r.ok ? A.r("✗") : r.recording ? A.g("● recording") : A.d("○")} ${r.detail}`);
        if (action === "stop" && r.ok && r.localVideo && !noOpen && process.platform === "darwin")
          Bun.spawn(["open", r.localVideo], { stdout: "ignore", stderr: "ignore" });
        return r.ok ? 0 : 1;
      }
      let target: string;
      try { target = await routeSelector(cfg, sel); }
      catch (error) {
        const names = cfg.routes?.[sel]?.prefer ?? [];
        const phone = names.length > 0 && names.every((n) => cfg.hosts[n]?.android);
        die((error instanceof Error ? error.message : String(error))
          + (phone ? `\nif Termux's SSH server died, try: fleet cu ${sel} revive` : ""));
      }
      if (isAndroidHost(cfg, target)) {
        const desktopOnly = [["--space", spaceArg], ["--button", button], ["--probe", probeArg], ["--element", elementToken],
          ["--region", regionText], ["--region-at", regionAt], ["--kind", regionKind],
          ["--for", forApp], ["--foreground", foreground || undefined], ["--count", clickCount !== 1 || undefined],
          ["--no-composite", noComposite || undefined], ["--full", full || undefined], ["--brief", brief || undefined]]
          .filter(([, v]) => v !== undefined).map(([f]) => f);
        if (desktopOnly.length) die(`${desktopOnly.join(", ")} ${desktopOnly.length === 1 ? "does" : "do"} not apply to an Android host`);
        return androidCu(cfg, target, sel, rest, {
          grid, gridStep, out, noOpen, settle, wantShot, label: elementLabel, role: elementRole, nth: elementNth,
        });
      }

      if (spaceArg && spaceArg !== "window" && spaceArg !== "screen")
        die(`--space must be window or screen (got '${spaceArg}')`);
      const space = (spaceArg ?? "window") as "window" | "screen";
      const probe = (() => {
        if (!probeArg) return undefined;
        const m = probeArg.match(/^\s*(-?\d+)\s*[, ]\s*(-?\d+)\s*$/);
        if (!m) die(`--probe needs X,Y (got '${probeArg}')`);
        return { x: Number(m![1]), y: Number(m![2]) };
      })();

      const autoName = (q: string) =>
        `${sel}-${q.replace(/[^a-z0-9]+/gi, "_")}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
      const openImg = (p?: string) => {
        if (p && !noOpen && process.platform === "darwin")
          Bun.spawn(["open", p], { stdout: "ignore", stderr: "ignore" });
      };
      /** Grid options carrying the frame the numbers are in, plus whatever is
       *  sitting above the window — the two things a bare capture never said. */
      const gridOpts = (t?: CuTarget, banner?: string, mark?: { x: number; y: number }): GridOptions => ({
        step: gridStep,
        minorStep: gridMinor || undefined,
        crossLabels: !noCross,
        caption: t ? cuGridCaption(t) : undefined,
        banner,
        probe: mark ? { ...mark, label: `probe -> ${mark.x},${mark.y}` } : undefined,
      });
      const applyGrid = async (p: string | undefined, opts: GridOptions) => {
        if (!p || !grid) return;
        if (!await overlayGrid(p, opts)) console.error(A.y("grid overlay skipped (need python3 + Pillow)"));
      };
      const verb = rest[0];

      if (verb === "install") {
        console.log(A.d(`◎ installing cua-driver on ${target} …`));
        const actions = await cuInstall(cfg, target);
        actions.forEach((a) => printResult(a.result));
        const failed = actions.filter((a) => !a.result.ok);
        if (actions.length > 1)
          console.log(A.d(`${actions.length - failed.length}/${actions.length} host(s) installed`));
        return failed.length ? 1 : 0;
      }
      if (verb === "perception") {
        const json = pullFlag(rest, "--json");
        const version = pullVal(rest, "--version");
        const action = rest[1] ?? "status";
        if (rest.length > 2 || !["status", "install", "remove"].includes(action))
          die("usage: fleet cu <sel> perception [status] | perception install [--version V] | perception remove");
        if (version !== undefined && action !== "install") die("--version applies to perception install");
        if (action === "install" && !json)
          console.log(A.d(`◎ installing cua-perception on ${target} (≈420 MB download on the host; `
            + "includes the AGPL-3.0 OmniParser detector) …"));
        let actions;
        try { actions = await cuPerception(cfg, target, action as "install" | "status" | "remove", { version }); }
        catch (error) { die(error instanceof Error ? error.message : String(error)); }
        if (json) { console.log(JSON.stringify(actions)); return actions.every((a) => a.result.ok) ? 0 : 1; }
        actions.forEach((a) => printResult(a.result));
        return actions.every((a) => a.result.ok) ? 0 : 1;
      }
      if (verb === "regions") {
        const json = pullFlag(rest, "--json");
        const max = pullVal(rest, "--max");
        const minConf = pullVal(rest, "--min-confidence");
        const q = rest[1];
        const usage = "usage: fleet cu <host> regions <target> [filter] [--kind text|icon] [--min-confidence F] [--max N] [--out FILE] [--json]";
        if (!q || rest.length > 3) die(usage);
        if (regionText !== undefined || regionAt !== undefined) die("--region/--region-at address a click; filter regions with a positional filter");
        if (regionKind !== undefined && regionKind !== "text" && regionKind !== "icon") die(`--kind must be text or icon (got '${regionKind}')`);
        if (max !== undefined && (!/^\d+$/.test(max) || Number(max) < 1)) die(`--max must be a positive integer (got '${max}')`);
        if (minConf !== undefined && !(Number(minConf) >= 0 && Number(minConf) <= 1)) die(`--min-confidence must be from 0 to 1 (got '${minConf}')`);
        const imageOut = out ?? (wantShot ? `${autoName(q)}-regions.${await preferredImageExt()}` : undefined);
        let r;
        try {
          r = await cuRegions(cfg, target, q, {
            filter: rest[2], kinds: regionKind ? [regionKind as "text" | "icon"] : undefined,
            minConfidence: minConf === undefined ? undefined : Number(minConf), maxRegions: max ? Number(max) : undefined, imageOut,
          });
        } catch (error) { die(error instanceof Error ? error.message : String(error)); }
        if (json) { console.log(JSON.stringify(r)); return r.result.ok ? 0 : 1; }
        const w = r.target.window;
        if (!r.result.ok) {
          console.error(A.r(`✗ ${r.target.name} w${w.window_id}: ${r.error ? `${r.error.code}: ${r.error.message}` : "regions failed"}`));
          if (r.hint) console.error(A.y(`▲ ${r.hint}`));
          else if (r.result.stderr) console.error(A.d(r.result.stderr));
          return 1;
        }
        console.log(A.d(`${r.target.name} · pid ${r.target.pid} · w${w.window_id} · ${w.title || "(untitled)"} · capture ${r.width}x${r.height}`
          + ` · ${r.regions.length} of ${r.total} region(s)` + (r.durationMs !== undefined ? ` · parsed in ${(r.durationMs / 1000).toFixed(1)}s` : "")));
        for (const g of r.regions) {
          const name = g.kind === "text" ? JSON.stringify(g.text ?? "") : A.d(g.label ?? "icon");
          console.log(`${A.d(g.id.padEnd(9))} ${g.kind === "text" ? A.b("text") : A.c("icon")} ${name}`
            + A.d(` ${g.bounds.width}x${g.bounds.height}@${g.bounds.x},${g.bounds.y} @${g.center.x},${g.center.y} conf ${g.confidence.toFixed(2)}`));
        }
        for (const warning of r.warnings) console.error(A.y(`▲ ${warning}`));
        console.log(A.d(`click one with: fleet cu ${target} click ${JSON.stringify(q)} --region TEXT | --region-at X,Y (re-parses a fresh capture; ids and OCR text can change between parses)`));
        if (r.localImage) { console.log(`${A.g("●")} ${A.d("capture →")} ${r.localImage}`); openImg(r.localImage); }
        return 0;
      }
      if (verb === "tools") {
        if (rest.length > 2) die("usage: fleet cu <host> tools [filter]");
        const r = await cuTools(cfg, target, rest[1]);
        printResult(r.result);
        return r.result.ok ? 0 : 1;
      }
      if (verb === "describe") {
        const tool = rest[1] ?? die("usage: fleet cu <host> describe <tool> [--brief] [--for <app>]");
        if (rest.length > 2) die("usage: fleet cu <host> describe <tool> [--brief] [--for <app>]");
        // --for grounds the advice in the window actually in front of the caller:
        // "prefer element_index" is wrong guidance for a window with no UIA tree.
        let elementsAvailable: boolean | undefined;
        if (forApp) {
          const support = await cuElementSupport(cfg, target, forApp);
          elementsAvailable = support.available;
          console.log(`${support.available ? A.g("●") : A.y("▲")} ${support.note}`);
        }
        const r = await cuDescribe(cfg, target, tool!);
        if (!r.result.ok) { printResult(r.result); return 1; }
        if (brief) console.log(briefDescribe(r.result.stdout, { elementsAvailable }));
        else printResult(r.result);
        return 0;
      }
      if (verb === "record") {
        const action = rest[1];
        if (!action || rest.length > 2)
          die("usage: fleet cu <host> record start|stop|status [--out dir]");
        if (action === "start") {
          const r = await cuRecordStart(cfg, target, out);
          printResult(r.result);
          return r.result.ok ? 0 : 1;
        }
        if (action === "status") {
          if (out) die("--out is only valid with record start or record stop");
          const r = await cuRecordStatus(cfg, target);
          printResult(r.result);
          return r.result.ok ? 0 : 1;
        }
        if (action === "stop") {
          const r = await cuRecordStop(cfg, target, out);
          printResult(r.result);
          for (const path of r.localPaths) console.log(path);
          return r.result.ok ? 0 : 1;
        }
        die("usage: fleet cu <host> record start|stop|status [--out dir]");
      }
      // convenience verbs — cut the list→list→build-JSON loop
      if (verb === "apps") {
        const all = rest.includes("--all");
        const words = rest.slice(1).filter((w) => w !== "--all");
        if (words.length > 1) die("usage: fleet cu <host> apps [filter] [--all]");
        const { apps, result, hidden } = await cuApps(cfg, target, words[0], { all });
        if (!result.ok) { printResult(result); return 1; }
        for (const a of apps)
          console.log(`${A.d((a.pid + "").padStart(7))}  ${A.b(a.name)}${a.active ? A.g(" •active") : ""}`);
        console.log(A.d(`${apps.length} app(s)${hidden ? ` · ${hidden} windowless process(es) hidden; --all shows them` : ""}`));
        return 0;
      }
      if (verb === "windows") {
        if (rest.length > 2) die("usage: fleet cu <host> windows [pid|process|app|title]");
        const snapshot = await cuSnapshot(cfg, target);
        if (!snapshot.result.ok) { printResult(snapshot.result); return 1; }
        const q = rest[1];
        if (!q) {
          for (const w of [...snapshot.windows].sort((a, b) => b.z_index - a.z_index))
            console.log(`${A.d((w.window_id + "").padStart(9))} ${A.d((w.pid + "").padStart(7))}  `
              + `${A.b((w.app_name ?? "?").padEnd(24))} ${w.title || A.d("(untitled)")}`
              + A.d(`  ${w.width}x${w.height}@${w.x},${w.y}${w.minimized ? " min" : ""}${w.on_screen ? "" : " offscreen"}`));
          console.log(A.d(`${snapshot.windows.length} top-level window(s)`));
          return 0;
        }
        const t = cuResolveTargetFrom(snapshot, q);
        const mark = (w: { window_id: number }) => w.window_id === t.window.window_id
          ? A.g("→ target")
          : t.blockers.some((b) => b.window_id === w.window_id) ? A.r("▲ above target") : A.d("  sibling");
        for (const w of snapshot.windows.filter((w) => w.pid === t.pid).sort((a, b) => b.z_index - a.z_index))
          console.log(`${mark(w)} ${A.d((w.window_id + "").padStart(9))}  ${w.title || A.d("(untitled)")}`
            + A.d(`  ${w.width}x${w.height}@${w.x},${w.y} z${w.z_index}`));
        console.log(A.d(`${t.name} · pid ${t.pid} · matched on ${t.matched}`
          + ` · click space ${t.capture.width}x${t.capture.height}`));
        const note = cuBlockerNote(t);
        if (note) console.error(A.r(`▲ ${note}`));
        return 0;
      }
      if (verb === "open") {
        // fleet cu <host> open <app> [url] | open browser <url> | open <url>
        const json = pullFlag(rest, "--json");
        const wait = pullVal(rest, "--wait");
        const [, first, second] = rest;
        if (!first || rest.length > 3) die("usage: fleet cu <host> open <app> [url] | open <url> [--wait MS] [--json]");
        const looksUrl = (v: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(v);
        const [app, url] = second !== undefined ? [first, second] : looksUrl(first!) ? [undefined, first] : [first, undefined];
        if (wait !== undefined && !/^\d+$/.test(wait)) die(`--wait must be milliseconds (got '${wait}')`);
        const r = await cuOpen(cfg, target, app, url, { waitMs: wait ? Number(wait) : undefined });
        if (json) { console.log(JSON.stringify(r)); return r.result.ok ? 0 : 1; }
        if (!r.result.ok) { printResult(r.result); return 1; }
        if (!r.window) { console.log(`${A.y("●")} opened ${r.what}; no window appeared yet (fleet cu ${target} windows lists them)`); return 0; }
        const w = r.window;
        console.log(`${A.g("●")} opened ${r.what}: ${A.b(w.title || "(untitled)")} ${A.d(`pid ${w.pid} · w${w.window_id} · ${w.width}x${w.height}@${w.x},${w.y}`)}`);
        console.log(A.d(`address it as: fleet cu ${target} elements ${JSON.stringify(r.targetName)}`));
        return 0;
      }
      if (verb === "elements") {
        const json = pullFlag(rest, "--json");
        const max = pullVal(rest, "--max");
        const task = pullVal(rest, "--task");
        const q = rest[1];
        if (!q || rest.length > 3) die("usage: fleet cu <host> elements <target> [filter] [--role R] [--max N] [--task TEXT] [--json]");
        if (max !== undefined && (!/^\d+$/.test(max) || Number(max) < 1)) die(`--max must be a positive integer (got '${max}')`);
        const r = await cuElements(cfg, target, q, { filter: rest[2] ?? elementLabel, maxElements: max ? Number(max) : undefined });
        if (!r.result.ok) { printResult(r.result); return 1; }
        let shown = elementRole ? r.elements.filter((e) => sameRole(e.role, elementRole)) : r.elements;
        let focusNote: string | undefined;
        let hiddenCount = 0;
        if (task && r.available) {
          const f = await focusElements(shown, task, `${r.target.name} · ${r.target.window.title || "(untitled)"}`);
          shown = f.elements; focusNote = f.note; hiddenCount = f.hidden.length;
        }
        if (json) { console.log(JSON.stringify({ ...r, elements: shown, ...(task ? { hidden: hiddenCount, focus: focusNote } : {}) })); return r.available ? 0 : 1; }
        const w = r.target.window;
        console.log(A.d(`${r.target.name} · pid ${r.target.pid} · w${w.window_id} · ${w.title || "(untitled)"}`
          + (r.snapshotId ? ` · snapshot ${r.snapshotId}` : "") + ` · ${shown.length} of ${r.total} element(s)`));
        if (!r.available) {
          console.error(A.y(r.bounded
            ? `▲ --max ${max} stopped the walk before it reached a control (cua-driver counts every node, containers included) — raise --max or drop it`
            : "▲ the accessibility walk found nothing here — address this window with pixels (shot-window --grid)"));
          return 1;
        }
        for (const e of shown) {
          const indent = "  ".repeat(Math.min(6, Math.max(0, (e.depth ?? 0))));
          console.log(`${A.d((e.token ?? `#${e.index}`).padEnd(13))} ${indent}${A.b(e.role)} ${JSON.stringify(e.label)}`
            + (e.value !== undefined && e.value !== null && e.value !== e.label ? A.d(` = ${JSON.stringify(e.value.slice(0, 60))}`) : "")
            + (e.actions.length ? A.g(` [${e.actions.join(",")}]`) : "")
            + (e.enabled === false ? A.y(" disabled") : "")
            + (e.selected ? A.g(" selected") : "")
            + (e.center ? A.d(` @${e.center.x},${e.center.y}`) : ""));
        }
        if (focusNote) console.log(A.d(`(${focusNote})`));
        return 0;
      }
      if (verb === "verify") {
        const json = pullFlag(rest, "--json");
        const value = pullVal(rest, "--value");
        const timeout = pullVal(rest, "--timeout");
        const samples = pullVal(rest, "--samples");
        const q = rest[1];
        const usage = "usage: fleet cu <host> verify <target> <JSON-predicates> | verify <target> --label L [--role R] [--value V] [--timeout MS] [--samples N] [--json]";
        if (!q || rest.length > 3) die(usage);
        let predicates: unknown[];
        if (rest[2] !== undefined) {
          if (elementLabel !== undefined || elementRole !== undefined || value !== undefined)
            die("pass predicates as JSON or as --label/--role/--value, not both");
          try { const parsed = JSON.parse(rest[2]!); predicates = Array.isArray(parsed) ? parsed : [parsed]; }
          catch { die("verify needs a JSON predicate or array of predicates"); }
        } else {
          if (elementLabel === undefined && elementRole === undefined) die(usage);
          const selector: Record<string, string> = {};
          if (elementLabel !== undefined) selector.label_contains = elementLabel;
          if (elementRole !== undefined) selector.role = elementRole;
          predicates = [{ element: { selector, exists: true, ...(value !== undefined ? { value_equals: value } : {}) } }];
        }
        const int = (v: string | undefined, name: string) => {
          if (v === undefined) return undefined;
          if (!/^\d+$/.test(v)) die(`${name} must be a non-negative integer (got '${v}')`);
          return Number(v);
        };
        const r = await cuVerify(cfg, target, q, predicates!, { timeoutMs: int(timeout, "--timeout"), stableSamples: int(samples, "--samples") });
        if (json) { console.log(JSON.stringify(r)); return r.result.ok ? 0 : 1; }
        const badge = r.status === "satisfied" ? A.g("● satisfied") : r.status === "unsatisfied" ? A.r("✗ unsatisfied") : A.y("? unknown");
        console.log(`${badge} ${A.b(r.target.name)} ${A.d(`pid ${r.target.pid} w${r.target.window.window_id}`)}`
          + (r.elapsedMs !== undefined ? A.d(` · ${r.elapsedMs} ms`) : ""));
        for (const p of r.predicates)
          console.log(`  ${p.index}: ${p.status}${p.reason ? A.d(` (${p.reason})`) : ""}`
            + (p.observed !== undefined ? A.d(` observed ${JSON.stringify(p.observed)}`) : ""));
        if (r.result.stderr) console.error(A.d(r.result.stderr));
        return r.result.ok ? 0 : 1;
      }
      if (verb === "shot-window" || verb === "win") {
        const q = rest[1] ?? die("usage: fleet cu <host> shot-window <pid|process|app|title> [--out f.png]");
        if (rest.length > 2) die("usage: fleet cu <host> shot-window <pid|process|app|title> [--out f.png]");
        const local = out ?? `${autoName(q!)}.${await preferredImageExt()}`;
        const r = await cuShotWindow(cfg, target, q!, local, {}, { composite: !noComposite });
        if (!r.localImage) {
          printResult(r.result);
          if (r.result.ok) console.error(A.r("capture did not produce a local image"));
          return 1;
        }
        if (r.result.stderr) console.error(A.d(r.result.stderr));
        const mark = probe ? cuResolvePoint(r.target, probe.x, probe.y, space) : undefined;
        await applyGrid(r.localImage, gridOpts(r.target, r.warning, mark));
        console.log(`${A.g("●")} ${A.d(`${r.target.name} pid ${r.target.pid} w${r.target.window.window_id} →`)}`
          + ` ${r.localImage}${grid ? A.d(" (grid)") : ""}`);
        if (r.composited.length)
          console.error(A.y(`▲ composited ${r.composited.length} owned window(s) onto the capture: `
            + r.composited.map((w) => w.title || `w${w.window_id}`).join(", ")));
        if (r.warning) console.error(A.r(`▲ ${r.warning}`));
        if (mark) console.log(A.d(`  probe ${probe!.x},${probe!.y} (${space}) → window-local ${mark.x},${mark.y}`));
        openImg(r.localImage);
        return 0;
      }

      if (verb === "batch") {
        const json = pullFlag(rest, "--json");
        const file = pullVal(rest, "--file");
        const q = rest[1];
        if (!q || (file ? rest.length !== 2 : rest.length !== 3))
          die("usage: fleet cu <host> batch <target> <JSON-array|-> [--json] [--shot] | batch <target> --file FILE");
        const source = file ? await readFile(file, "utf8") : rest[2] === "-" ? await Bun.stdin.text() : rest[2]!;
        let actions;
        try { actions = JSON.parse(source); }
        catch { die("batch needs a valid JSON array"); }
        if (foreground && Array.isArray(actions)) actions = actions.map((step) => ({
          ...step, args: { ...step.args, delivery_mode: "foreground" },
        }));
        const imageOut = wantShot || out ? (out ?? `${autoName(q)}.${await preferredImageExt()}`) : undefined;
        const r = await cuBatch(cfg, target, q, actions, { settleMs: settle, imageOut, space });
        const note = cuBlockerNote(r.target);
        if (r.localImage) await applyGrid(r.localImage, gridOpts(r.target, note));
        if (json) console.log(JSON.stringify(r));
        else {
          console.log(`${r.result.ok ? A.g("●") : A.r("✗")} ${A.b(r.target.name)} · batch effect: ${r.effect}`);
          for (const step of r.actions) {
            console.log(`  ${step.index + 1}. ${step.tool}: ${step.status}${step.code === null ? "" : ` (exit ${step.code})`}`);
            if (step.driverOutput) console.log(step.driverOutput.split("\n").map((line) => "     " + line).join("\n"));
          }
          if (r.reason) console.log(A.d(r.reason));
          if (r.result.stderr) console.error(r.result.stderr);
          if (note) console.error(A.r(note));
          if (r.localImage) { console.log(`after → ${r.localImage}`); openImg(r.localImage); }
        }
        return r.result.ok ? 0 : 1;
      }

      // ── verified input: resolve → act → prove the pixels moved ─────────────
      const ACT_VERBS = ["click", "right-click", "double-click", "drag", "scroll", "hotkey", "key", "type", "set", "menu", "act"] as const;
      const rawInput = ["click", "drag", "scroll", "hotkey"].includes(verb ?? "") && /^\s*\{/.test(rest[1] ?? "");
      const isAct = !rawInput && ACT_VERBS.includes(verb as typeof ACT_VERBS[number]);
      const regionLocating = regionText !== undefined || regionAt !== undefined;
      if (regionKind !== undefined && !regionLocating && verb !== "regions") die("--kind narrows --region or --region-at, or filters fleet cu <host> regions");
      if (regionLocating && !["click", "right-click", "double-click"].includes(verb ?? ""))
        die("--region/--region-at address click, right-click, and double-click; list regions with: fleet cu <host> regions <target>");
      const regionPoint = (() => {
        if (regionAt === undefined) return undefined;
        const m = regionAt.match(/^\s*(\d+)\s*[, ]\s*(\d+)\s*$/);
        if (!m) die(`--region-at needs X,Y in the capture's pixels (got '${regionAt}')`);
        return { x: Number(m![1]), y: Number(m![2]) };
      })();
      if (regionLocating && (elementToken !== undefined || elementLabel !== undefined || elementRole !== undefined))
        die("address the click by --region or by --label/--element, not both");
      if (regionKind !== undefined && regionKind !== "text" && regionKind !== "icon") die(`--kind must be text or icon (got '${regionKind}')`);
      const regionLoc: CuRegionLocator | undefined = regionLocating ? {
        ...(regionText !== undefined ? { text: regionText } : {}), ...(regionPoint ? { at: regionPoint } : {}),
        ...(regionKind ? { kind: regionKind as "text" | "icon" } : {}),
        ...(elementNth !== undefined ? { nth: Number(elementNth) } : {}),
      } : undefined;
      const locating = !regionLocating && [elementToken, elementLabel, elementRole, elementNth].some((v) => v !== undefined);
      if (locating && (!isAct || verb === "drag" || verb === "menu"))
        die("--element/--label/--role/--nth address a control for click, right-click, double-click, type, set, key, hotkey, scroll, and act; list them with: fleet cu <host> elements <target>");
      if (elementNth !== undefined && (!/^\d+$/.test(elementNth) || Number(elementNth) < 1)) die(`--nth must be a positive integer (got '${elementNth}')`);
      const element: CuElementLocator | undefined = locating
        ? { token: elementToken, label: elementLabel, role: elementRole, nth: elementNth === undefined ? undefined : Number(elementNth) }
        : undefined;
      if (isAct) {
        const json = pullFlag(rest, "--json");
        const q = rest[1] ?? die(`usage: fleet cu <host> ${verb} <pid|process|app|title> …`);
        const shotPath = wantShot || out ? (out ?? `${autoName(q)}.${await preferredImageExt()}`) : undefined;

        let tool = verb!;
        let payload: Record<string, unknown> = {};
        let point: { x: number; y: number; space: "window" | "screen" } | undefined;
        let summary = "";
        if (["click", "right-click", "double-click"].includes(verb!)) {
          if (button && !["left", "right", "middle"].includes(button))
            die(`--button must be left, right, or middle (got '${button}')`);
          if (clickCount > 3) die("--count must be 1, 2, or 3");
          tool = verb === "right-click" ? "right_click" : verb === "double-click" ? "double_click" : "click";
          payload = tool === "click" ? { count: clickCount, ...(button ? { button } : {}) } : {};
          if (regionLoc) {
            if (rest.length !== 2) die(`usage: fleet cu <host> ${verb} <app> --region TEXT | --region-at X,Y [--kind text|icon] [--nth N]`);
            summary = tool;
          } else if (element) {
            if (rest.length !== 2) die(`usage: fleet cu <host> ${verb} <app> --label TEXT [--role R] [--nth N] | --element TOKEN`);
            summary = tool;
          } else {
            const [xs, ys] = [rest[2], rest[3]];
            if (rest.length !== 4) die(`usage: fleet cu <host> ${verb} <app> <x> <y> [--space window|screen]  |  ${verb} <app> --label TEXT`);
            const [x, y] = [Number(xs), Number(ys)];
            if (!Number.isFinite(x) || !Number.isFinite(y)) die(`click needs numeric x y (got '${xs} ${ys}')`);
            point = { x, y, space };
            summary = `${tool} ${x},${y}`;
          }
        } else if (verb === "drag") {
          const duration = numVal(rest, "--duration", 500, 0);
          if (duration > 10000) die("--duration must be at most 10000 ms");
          if (rest.length !== 6) die("usage: fleet cu <host> drag <app> <from-x> <from-y> <to-x> <to-y> [--duration MS]");
          const coords = rest.slice(2).map(Number);
          if (coords.some((n) => !Number.isFinite(n))) die("drag needs four finite coordinates");
          if (button && !["left", "right", "middle"].includes(button)) die("--button must be left, right, or middle");
          payload = { from_x: coords[0], from_y: coords[1], to_x: coords[2], to_y: coords[3], duration_ms: duration,
            ...(button ? { button } : {}) };
          summary = `drag ${coords[0]},${coords[1]} → ${coords[2]},${coords[3]}`;
        } else if (verb === "scroll") {
          const by = pullVal(rest, "--by") ?? "line";
          if (by !== "line" && by !== "page") die("--by must be line or page");
          if (rest.length < 3 || rest.length > 4 || !["up", "down", "left", "right"].includes(rest[2]!))
            die("usage: fleet cu <host> scroll <app> <up|down|left|right> [amount] [--by line|page]");
          const amount = rest[3] === undefined ? 3 : Number(rest[3]);
          if (!Number.isInteger(amount) || amount < 1 || amount > 50) die("scroll amount must be an integer from 1 to 50");
          payload = { direction: rest[2], amount, by };
          summary = `scroll ${rest[2]} ${amount} ${by}`;
        } else if (verb === "hotkey") {
          if (rest.length < 4) die("usage: fleet cu <host> hotkey <app> <modifier> <key> [key…]");
          payload = { keys: rest.slice(2) };
          summary = `hotkey ${rest.slice(2).join("+")}`;
        } else if (verb === "key") {
          if (rest.length !== 3) die("usage: fleet cu <host> key <app> <key>");
          tool = "press_key";
          payload = { key: rest[2] };
          summary = `press_key ${rest[2]}`;
        } else if (verb === "type") {
          if (rest.length !== 3) die("usage: fleet cu <host> type <app> <text>");
          tool = "type_text";
          payload = { text: rest[2] };
          summary = `type_text ${JSON.stringify(rest[2]!.slice(0, 40))}`;
        } else if (verb === "set") {
          if (rest.length !== 3 || !element) die("usage: fleet cu <host> set <app> <value> --label TEXT [--role R] [--nth N] | --element TOKEN");
          tool = "set_value";
          payload = { value: rest[2] };
          summary = `set_value ${JSON.stringify(rest[2]!.slice(0, 40))}`;
        } else if (verb === "menu") {
          if (rest.length < 3) die("usage: fleet cu <host> menu <app> <item> [item…]   e.g. menu notepad File \"Save As...\"");
          tool = "invoke_menu";
          payload = { path: rest.slice(2) };
          summary = `invoke_menu ${rest.slice(2).join(" › ")}`;
        } else {
          if (rest.length < 3 || rest.length > 4) die("usage: fleet cu <host> act <app> <tool> [JSON]");
          tool = rest[2]!;
          if (rest[3]) {
            try { payload = JSON.parse(rest[3]!); }
            catch { die(`act needs valid JSON for ${tool} (got '${rest[3]}')`); }
          }
          summary = tool;
        }
        if (foreground) payload.delivery_mode = "foreground";

        let r;
        try {
          r = await cuAct(cfg, target, q, tool, payload,
            { settleMs: settle, imageOut: shotPath, point, space, element, region: regionLoc });
        } catch (error) {
          if (!regionLoc) throw error;
          die(error instanceof Error ? error.message : String(error));
        }
        if (json) {
          if (r.localImage) await applyGrid(r.localImage, gridOpts(r.target, cuBlockerNote(r.target)));
          console.log(JSON.stringify(r));
          return r.result.ok ? 0 : 1;
        }
        if (point && typeof r.payload.x === "number")
          summary = `${tool} ${r.payload.x},${r.payload.y}`
            + (space === "screen" ? A.d(` (from screen ${point.x},${point.y})`) : "")
            + (clickCount > 1 ? ` x${clickCount}` : "");
        if (r.region)
          summary += ` → ${r.region.kind} ${r.region.kind === "text" ? JSON.stringify(r.region.text ?? "") : r.region.label ?? ""}`
            + A.d(` ${r.region.id} @${r.region.center.x},${r.region.center.y} (capture-bound)`);
        if (element)
          summary += r.element ? ` → ${r.element.role} ${JSON.stringify(r.element.label)} ${A.d(r.element.token ?? "")}`
            : ` → ${A.d(String(r.payload.element_token))}`;
        // A refusal exits 1, so it leads the line; the pixel effect alone read as a soft pass.
        const badge = r.refusal ? A.r(`✗ refused (${r.effect})`)
          : r.effect === "changed" ? A.g("● changed")
          : r.effect === "no_change" ? A.y("○ no_change") : A.d("? indeterminate");
        console.log(`${badge} ${A.b(r.target.name)} ${A.d(`pid ${r.target.pid} w${r.target.window.window_id}`)} `
          + `${A.d("·")} ${summary}`);
        if (r.reason) console.log(A.d(`  ${r.reason}`));
        if (r.driverOutput) console.log(r.driverOutput.split("\n").map((l) => "  " + l).join("\n"));
        if (r.result.stderr) console.error(A.d(r.result.stderr.split("\n").map((l) => "  " + l).join("\n")));
        const note = cuBlockerNote(r.target);
        if (note) console.error(A.r(`▲ ${note}`));
        if (r.localImage) {
          await applyGrid(r.localImage, gridOpts(r.target, note));
          console.log(`${A.g("●")} ${A.d("after →")} ${r.localImage}${grid ? A.d(" (grid)") : ""}`);
          openImg(r.localImage);
        }
        return r.result.ok ? 0 : 1;
      }

      const r = await cuRun(cfg, target, rest, out);   // pull an image only when --out is given
      // get_window_state ships its whole envelope even when the UIA walk found
      // nothing; --full opts back into the raw body.
      const shaped = full ? { result: r.result } : compactCuOutput(rest, r.result);
      printResult(shaped.result);
      if (out && !r.localImage) {
        if (r.result.ok) console.error(A.r("capture did not produce a local image"));
        return 1;
      }
      if (r.localImage) {
        await applyGrid(r.localImage, gridOpts());
        console.log(`${A.g("●")} ${A.d("image →")} ${r.localImage}${grid ? A.d(" (grid)") : ""}`);
        openImg(r.localImage);
      }
      return r.result.ok ? 0 : 1;
    }

    case "boot": {
      const { flags, rest: pos } = parseFlags(rest, ["--json", "--entries"], []);
      const json = flags["--json"] === true;
      const [sel] = pos;
      if (!sel || pos.length !== 1) die("usage: fleet boot <machine> [--entries] [--json]");
      if (flags["--entries"] === true) {
        const r = await firmwareEntries(cfg, sel);
        if (json) { console.log(JSON.stringify(r, null, 2)); return 0; }
        console.log(`${A.b(r.machine)}  ${A.d(`firmware entries read from ${r.live} (${r.host})`)}`);
        r.esps.forEach((p, i) => console.log(A.d(`  EFI partition #${i + 1}: ${p.path ?? p.device ?? ""} ${p.uuid}`)));
        const pos = (id: string) => { const i = r.order.findIndex((o) => o.toLowerCase() === id.toLowerCase()); return i < 0 ? "-" : String(i + 1); };
        for (const e of r.entries) {
          const tag = e.boots.length ? A.g(` ← ${e.boots.join(", ")}`) : "";
          console.log(`  ${A.d(pos(e.id).padStart(2))} ${e.label.padEnd(22)} ${A.d(e.id.padEnd(40))} ${A.d(e.path ?? "")}${tag}`);
          if (e.warning) console.log(`     ${A.y("⚠ " + e.warning)}`);
        }
        for (const miss of r.missing) console.log(`  ${A.r("✗")} no entry matches boot ${miss}`);
        return r.missing.length || r.entries.some((e) => e.warning && e.boots.length) ? 1 : 0;
      }
      const st = await bootState(cfg, sel);
      if (json) { console.log(JSON.stringify(st, null, 2)); return st.live ? 0 : 1; }
      const tag = st.live
        ? `${A.g("● " + st.live)} ${A.d("via " + st.transport + " (" + st.liveHost + ")")}`
        : A.r("○ powered off / unreachable");
      console.log(`${A.b(st.machine)}  ${tag}`);
      for (const b of st.boots)
        console.log(`  ${b.reachable ? A.g("●") : A.d("○")} ${b.os.padEnd(10)} ${A.d(b.host)}${b.via ? A.d(" · " + b.via) : ""}`);
      return st.live ? 0 : 1;
    }

    case "switch": {
      const { flags, rest: pos } = parseFlags(rest, ["--yes", "-y", "--no-wait", "--dry-run", "--json"], ["--to", "--timeout"]);
      const to = flags["--to"] as string | undefined;
      const yes = flags["--yes"] === true || flags["-y"] === true;
      const noWait = flags["--no-wait"] === true;
      const dryRun = flags["--dry-run"] === true;
      const json = flags["--json"] === true;
      const timeout = numFlag(flags, "--timeout", 300) * 1000;
      const [sel] = pos;
      if (!sel || !to || pos.length !== 1) die("usage: fleet switch <machine> --to <os> [--yes] [--dry-run] [--no-wait] [--timeout S] [--json]");
      // switch reboots the box into another OS — same destructive gate as reboot
      if (!dryRun && !await confirm(`switch ${A.b(sel)} → ${A.b(to)} (reboots into the other OS)`, yes)) return 1;
      const icon: Record<string, string> = { probe: "◎", plan: "▸", trigger: "⚡", reboot: "↻", wait: "…", done: "■" };
      // Progress goes to stderr so --json keeps stdout to one value.
      const onProgress = (p: { phase: string; detail: string; elapsedMs: number }) =>
        console.error(`${A.d(String(Math.round(p.elapsedMs / 1000)).padStart(4) + "s")} ${icon[p.phase] ?? "·"} ${A.d(p.phase.padEnd(8))} ${p.detail}`);
      const r = await switchMachine(cfg, sel, to!, { timeoutMs: timeout, wait: !noWait, dryRun, onProgress });
      if (json) console.log(JSON.stringify(r, null, 2));
      if (dryRun || noWait) return 0;
      if (!json) {
        if (r.arrived) console.log(`${A.g("●")} ${A.b(sel)} ${A.d("now in")} ${A.b(to!)} ${A.d(`(${Math.round(r.waitedMs / 1000)}s)`)}`);
        else if (!r.wentDown) console.log(`${A.r("✗")} ${sel} never went down; the switch did not reboot it${r.landedIn ? ` (still in ${r.landedIn})` : ""}`);
        else console.log(`${A.r("✗")} ${sel} did not reach ${to} within ${timeout / 1000}s; `
          + (r.landedIn ? `it is in ${A.b(r.landedIn)} now` : "it answers in no boot yet"));
      }
      return r.arrived ? 0 : 1;
    }

    case "wait": {
      const { flags, rest: pos } = parseFlags(rest, ["--json", "--ssh"],
        ["--port", "--http", "--status", "--boot", "--timeout", "--interval"]);
      const primaryFlags = ["--ssh", "--port", "--http", "--boot"];
      const requestedConditions = primaryFlags.filter((flag) => flags[flag] !== undefined);
      if (requestedConditions.length > 1)
        die(`fleet wait accepts one condition, got ${requestedConditions.join(", ")}`);
      if (flags["--status"] !== undefined && flags["--http"] === undefined) die("--status requires --http");
      const json = flags["--json"] === true;
      const port = numFlag(flags, "--port", 0);
      if (port > 65535) die("--port needs a TCP port from 1 to 65535");
      const http = flags["--http"] as string | undefined;
      const status = numFlag(flags, "--status", 0, 100);
      if (status > 599) die(`--status needs an HTTP status from 100 to 599 (got '${status}')`);
      const boot = flags["--boot"] as string | undefined;
      const timeout = numFlag(flags, "--timeout", 120) * 1000;
      const interval = numFlag(flags, "--interval", 3) * 1000;
      const [sel] = pos;
      if (!sel || pos.length !== 1) die("usage: fleet wait <host|machine> [--ssh | --port N | --http URL [--status N] | --boot OS] [--timeout S] [--interval S]");
      const cond: Parameters<typeof waitFor>[2] = { timeoutMs: timeout, intervalMs: interval };
      if (boot) cond.boot = boot;
      else if (http) { cond.http = http; if (status) cond.status = status; }
      else if (port) cond.port = port;
      else cond.ssh = true;
      const label = boot ? `boot=${boot}` : http ? `http ${http}` : port ? `:${port}` : "ssh";
      const progress = json ? process.stderr : process.stdout;
      progress.write(A.d(`◎ waiting for ${sel} ${label} (≤${timeout / 1000}s) …`));
      const r = await waitFor(cfg, sel, { ...cond, onTick: (d, ms) => progress.write(A.d(`\r◎ ${sel} ${label}: ${d} ${Math.round(ms / 1000)}s   `)) });
      progress.write("\r\x1b[K");
      if (json) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
      if (r.ok) console.log(`${A.g("●")} ${A.b(sel)} ${A.d(label + " ready")} ${A.d(`(${Math.round(r.elapsedMs / 1000)}s, ${r.attempts} tries)`)}`);
      else console.log(`${A.r("✗")} ${A.b(sel)} ${A.d(label + " not ready")} ${A.d(`after ${Math.round(r.elapsedMs / 1000)}s — last: ${r.lastDetail}`)}`);
      return r.ok ? 0 : 1;
    }

    case "run": {
      const { rest: pos } = parseFlags(rest, [], []);
      const [name] = pos;
      if (!name || pos.length !== 1) {
        // `fleet run <host> <script>` is the commonest wrong guess: say where it lives.
        const looksLikeScript = pos.some((p) => /\.(sh|bash|py|ps1|js|ts|rb|pl)$/i.test(p) || p.includes("/"));
        die("usage: fleet run <recipe>" + (looksLikeScript
          ? "\n  run executes a named recipe. To run a local script on a host: fleet exec --script <file> <host>" : ""));
      }
      const steps = cfg.recipes?.[name!];
      if (!steps) die(`unknown recipe '${name}' (have: ${Object.keys(cfg.recipes ?? {}).join(", ") || "none"})`);
      console.log(A.c(`▶ recipe ${name} (${steps!.length} steps)`));
      const run = await runRecipe(cfg, name!, {
        onStepStart: (i, total, step) => console.log(A.d(`\n[${i + 1}/${total}] fleet ${step}`)),
        onStepDone: (sr) => sr.results.forEach(printResult),
      });
      if (!run.ok) { console.error(A.r(`step failed — stopping`)); return 1; }
      console.log(A.g(`\n✓ ${name} complete`));
      return 0;
    }

    case "deploy": {
      const { flags, rest: pos } = parseFlags(rest, ["--json", "--no-restart"], ["--restart"]);
      const json = flags["--json"] === true;
      const restartSvc = flags["--restart"] as string | undefined;
      const noRestart = flags["--no-restart"] === true;
      if (restartSvc && noRestart)
        die("choose either --restart <svc> or --no-restart, not both");
      const [sel] = pos;
      if (!sel || pos.length !== 1) die("usage: fleet deploy <sel> [--restart <svc> | --no-restart]");
      const restart = noRestart ? false : (restartSvc ?? true);
      (json ? console.error : console.log)(A.d(`◎ building + shipping fleet → ${sel} …`));
      const results = await deployHosts(cfg, await routeSelector(cfg, sel!), { restart });
      if (json) { console.log(JSON.stringify(results, null, 2)); return results.some((r) => !r.ok) ? 1 : 0; }
      for (const r of results) {
        if (r.ok) console.log(`${A.g("●")} ${A.b(r.host)} ${A.d("→ " + r.result.stdout.trimEnd().split("\n").pop())}`);
        else { console.log(`${A.r("✗")} ${A.b(r.host)} ${A.d("deploy failed")}`); printResult(r.result); }
        for (const a of r.restarted ?? [])
          console.log(`  ${a.result.ok ? A.g("↻") : A.r("✗")} ${A.d("restarted " + a.service + " (" + a.type + ")")}`);
      }
      return results.some((r) => !r.ok) ? 1 : 0;
    }

    case "tools": {
      const options = parseFlags(rest, ["--json", "--no-skill", "--all"], ["--max-parallel"]);
      const json = options.flags["--json"] === true;
      const sub = options.rest.shift() ?? "status";
      if (!["list", "status", "sync", "stamp"].includes(sub)) die("usage: fleet tools [status|sync|list|stamp] …");
      for (const flag of Object.keys(options.flags))
        if (flag !== "--json" && sub !== "sync") die(`${flag} is only valid with tools sync`);
      const maxArgs = sub === "list" ? 0 : sub === "stamp" || (sub === "sync" && options.flags["--all"]) ? 1 : 2;
      if (options.rest.length > maxArgs) die(`too many arguments for tools ${sub}; try fleet tools --help`);
      const known = Object.keys(cfg.tools ?? {});
      if (!known.length) die("no `tools` block in fleet.config.json — nothing to track");

      if (sub === "list") {
        const fingerprints = await fingerprintTools(cfg, known);
        if (json) {
          console.log(JSON.stringify(fingerprints.map((fp, index) => fp instanceof Error
            ? { name: known[index], error: fp.message } : fp), null, 2));
          return fingerprints.some((fp) => fp instanceof Error) ? 1 : 0;
        }
        let failed = 0;
        for (let index = 0; index < known.length; index++) {
          const name = known[index]!;
          const fp = fingerprints[index]!;
          if (fp instanceof Error) { failed++; console.log(`${A.r("✗")} ${A.b(name.padEnd(12))} ${A.d(fp.message)}`); continue; }
          console.log(`${A.g("●")} ${A.b(name.padEnd(12))} ${A.c(fp.version.padEnd(9))} ${A.d(fp.hash)} ${A.d(`${fp.files} files · ${fp.root}${fp.skillPath ? " · skill" : ""}`)}`);
        }
        return failed ? 1 : 0;
      }

      if (sub === "status") {
        // `fleet tools status [tool] [sel]` — both optional. A leading arg that
        // names a registered tool selects that tool; anything else is a selector.
        const args = options.rest;
        if (args.length > 1 && !known.includes(args[0]!))
          die("unknown tool '" + args[0] + "' in 'fleet tools status <tool> <sel>' (tools: " + known.join(", ") + ")");
        const tools = args[0] && known.includes(args[0]) ? [args.shift()!] : known;
        // No selector → each tool checks its own configured hosts (see toolsStatus).
        const rows = await toolsStatus(cfg, tools, args[0] ? await routeSelector(cfg, args[0]) : undefined);
        if (json) { console.log(JSON.stringify(rows, null, 2)); return rows.some((r) => r.state !== "current") ? 1 : 0; }
        for (const tool of tools) {
          const mine = rows.filter((r) => r.tool === tool);
          const local = mine[0]?.local;
          if (!local) continue;
          console.log(`${A.b(tool.padEnd(12))} ${A.c(local.version.padEnd(9))} ${A.d(local.hash)}`);
          for (const r of mine) {
            const mark = r.state === "current" ? A.g("✓") : r.state === "stale" ? A.y("✗") : r.state === "missing" ? A.d("·") : A.r("?");
            const detail = r.state === "current" ? A.d("in sync" + (r.remote?.syncedAt ? ` · ${r.remote.syncedAt.slice(0, 10)}` : ""))
              : r.state === "stale" ? A.y(`stale — has ${r.remote!.version}/${r.remote!.hash}${r.remote!.syncedAt ? ` from ${r.remote!.syncedAt.slice(0, 10)}` : ""}`)
              : r.state === "missing" ? A.d("not installed")
              : A.r(`unreachable — ${(r.error ?? "").split("\n")[0]}`);
            console.log(`  ${mark} ${A.b(r.host.padEnd(14))} ${detail}`);
          }
        }
        return rows.some((r) => r.state !== "current") ? 1 : 0;
      }

      if (sub === "sync") {
        const noSkill = options.flags["--no-skill"] === true;
        const all = options.flags["--all"] === true;
        const requestedMaxParallel = options.flags["--max-parallel"] as string | undefined;
        const args = options.rest;
        const tools = all ? known : (args[0] && known.includes(args[0]) ? [args.shift()!] : null);
        if (!tools) die(`usage: fleet tools sync <tool|--all> <sel> [--no-skill] [--max-parallel N]   (tools: ${known.join(", ")})`);
        const sel = args[0] ?? (!all && tools.length === 1 ? cfg.tools?.[tools[0]!]?.hosts : undefined);
        if (!sel) die("fleet tools sync needs a selector (or a `hosts` default on the tool)");
        const maxParallel = toolSyncParallelism(tools.length, requestedMaxParallel);
        const routed = await routeSelector(cfg, sel);
        const blocks = tools.length > 1
          ? await syncTools(cfg, tools, routed, { skill: !noSkill, maxParallel })
          : [{ tool: tools[0]!, results: await syncTool(cfg, tools[0]!, routed, { skill: !noSkill }) }];
        const bad = blocks.reduce(
          (count, block) => count + (block.error ? 1 : block.results.filter((result) => !result.ok).length),
          0,
        );
        if (json) {
          console.log(serializeToolSyncResults(blocks, all));
          return bad ? 1 : 0;
        }
        for (const block of blocks) {
          console.log(A.d(`◎ ${block.tool} → ${sel} …`));
          if (block.error) {
            console.log(`${A.r("✗")} ${A.b(block.tool.padEnd(14))} ${A.d(block.error.split("\n")[0] ?? "failed")}`);
            continue;
          }
          for (const result of block.results) {
            if (result.ok) console.log(`${A.g("●")} ${A.b(result.host.padEnd(14))} ${A.d(`${result.version}/${result.hash} → ${result.dir}${result.skill ? " + skill" : ""}`)}`);
            else console.log(`${A.r("✗")} ${A.b(result.host.padEnd(14))} ${A.d((result.error ?? "failed").split("\n")[0] ?? "failed")}`);
          }
        }
        return bad ? 1 : 0;
      }

      if (sub === "stamp") {
        // Write the current version + today's date into each skill's frontmatter.
        const args = options.rest;
        if (args[0] && !known.includes(args[0])) die(`unknown tool '${args[0]}'`);
        const tools = args[0] && known.includes(args[0]) ? [args[0]!] : known;
        const today = new Date().toISOString().slice(0, 10);
        let failed = 0;
        const rows: { tool: string; changed?: boolean; version?: string; date?: string; error?: string; skipped?: string }[] = [];
        for (const tool of tools) {
          let fp;
          try { fp = await fingerprint(cfg, tool); }
          catch (error) {
            failed++;
            const message = error instanceof Error ? error.message : String(error);
            rows.push({ tool, error: message });
            if (!json) console.error(`${A.r("✗")} ${A.b(tool.padEnd(12))} ${A.d(message)}`);
            continue;
          }
          if (!fp.skillPath) {
            rows.push({ tool, skipped: "no skill" });
            if (!json) console.log(`${A.d("·")} ${A.b(tool.padEnd(12))} ${A.d("no skill")}`);
            continue;
          }
          const changed = await stampSkill(fp.skillPath, fp.version, today);
          rows.push({ tool, changed, version: fp.version, date: today });
          if (!json) console.log(`${changed ? A.g("●") : A.d("·")} ${A.b(tool.padEnd(12))} ${A.d(`v${fp.version} · ${today}${changed ? "" : " (unchanged)"}`)}`);
        }
        if (json) console.log(JSON.stringify(rows, null, 2));
        return failed ? 1 : 0;
      }

      return die("usage: fleet tools [status|sync|list|stamp] …");
    }

    case "completion": {
      const { rest: pos } = parseFlags(rest, [], []);
      const shell = pos[0] ?? "bash";
      if (pos.length > 1 || (shell !== "bash" && shell !== "zsh")) die("usage: fleet completion [bash|zsh]");
      console.log(completionScript(cfg, shell));
      return 0;
    }

    case "__win-session": {
      // The kept-open PowerShell broker that exec starts for a Windows host.
      const [name] = rest;
      const host = name ? cfg.hosts[name] : undefined;
      if (!host) return 2;
      if (!await runWinSessionBroker(host)) return 0;
      return await new Promise<number>(() => {});   // serves until idle
    }

    case "__proxy-connect":
      // ssh's ProxyCommand child. stdout IS the tunnel — nothing may be printed
      // to it, ever. Diagnostics go to stderr and the exit code names the leg.
      return await proxyConnectMain(rest);

    case "proxy": {
      const [sub = "list", ...subRest] = rest;
      if (sub === "drop") {
        const { rest: pos } = parseFlags(subRest, [], []);
        const [sel] = pos;
        if (!sel || pos.length !== 1) die("usage: fleet proxy drop <sel>");
        const dropped = await dropMasters(cfg, await routeSelector(cfg, sel));
        for (const d of dropped) console.log(`${d.dropped ? A.g("●") : A.d("○")} ${A.b(d.host.padEnd(10))} ${A.d(d.detail)}`);
        return 0;
      }
      const { flags, rest: pos } = parseFlags(subRest, ["--json"], []);
      const json = flags["--json"] === true;
      if (sub === "check") {
        for (const name of pos) if (!cfg.proxies?.[name] && !name.includes("://"))
          die(`unknown proxy: ${name} (have: ${Object.keys(cfg.proxies ?? {}).join(", ") || "none"})`);
        const checks = await proxyChecks(cfg, pos);
        if (json) { console.log(JSON.stringify(checks, null, 2)); return checks.every((c) => c.reachable && (c.verify?.ok ?? true)) ? 0 : 1; }
        if (!checks.length) { console.log(A.d("no proxies configured")); return 0; }
        for (const c of checks) {
          console.log(`${c.reachable ? A.g("●") : A.r("○")} ${A.b(c.name.padEnd(18))} ${A.d(c.endpoint.padEnd(24))} ${c.reachable ? A.d("reachable") : A.r("unreachable")}`);
          if (c.verify) console.log(`    ${c.verify.ok ? A.g("✓") : A.r("✗")} ${A.d(c.verify.url)} → ${c.verify.observed ?? A.r(c.verify.error ?? "no response")}`
            + (c.verify.expect ? A.d(` (expect ${c.verify.expect})`) : ""));
        }
        return checks.every((c) => c.reachable && (c.verify?.ok ?? true)) ? 0 : 1;
      }
      if (sub !== "list" || pos.length) die("usage: fleet proxy [list] [--json] | check [name…] [--json] | drop <sel>");
      const rows = proxyRows(cfg);
      if (json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
      if (!rows.length) { console.log(A.d("no proxies configured — add a `proxies` entry to fleet.config.json")); return 0; }
      for (const r of rows)
        console.log(`${A.b(r.name.padEnd(18))} ${A.d(`${r.type}/${r.dns}`.padEnd(14))} ${A.d(r.endpoint.padEnd(24))}`
          + `${r.auth ? A.y("auth ") : A.d("     ")}${r.isDefault ? A.c("default ") : ""}${A.d(r.hosts.join(", ") || "no hosts")}`);
      return 0;
    }

    case "doctor": {
      const { flags, rest: pos } = parseFlags(rest, ["--json"], []);
      const json = flags["--json"] === true;
      const [sel] = pos;
      if (!sel || pos.length !== 1) die("usage: fleet doctor <host>");
      const d = await diagnose(cfg, await routeSelector(cfg, sel!));
      if (json) { console.log(JSON.stringify(d, null, 2)); return d.sshUp ? 0 : 1; }
      const head = d.sshUp ? A.g(`● ${d.host} reachable`) : A.r(`○ ${d.host} unreachable`);
      console.log(`${head} ${A.d(`· ${d.os} · ssh ${d.ssh} · ${d.ms}ms`)}`);
      if (d.proxy) {
        const c = d.proxyCheck;
        const dot = c?.reachable ? A.g("●") : A.r("○");
        console.log(`  ${dot} proxy ${A.b(d.proxy)} ${A.d(c ? c.endpoint : "")} ${c?.reachable ? A.d("reachable") : A.r("unreachable")}`);
        if (c?.verify) console.log(`    ${c.verify.ok ? A.g("✓") : A.r("✗")} ${A.d(c.verify.url)} → ${c.verify.observed ?? A.r(c.verify.error ?? "no response")}`
          + (c.verify.expect ? A.d(` (expect ${c.verify.expect})`) : ""));
        if (d.proxyCommand) console.log(`    ${A.d("ProxyCommand: " + d.proxyCommand)}`);
      }
      if (d.health) console.log(`  ${d.httpUp ? A.g("● health ok") : A.r("○ health down")} ${A.d(d.health)}`);
      if (d.services.length) console.log(`  ${A.d("services: " + d.services.join(", "))}`);
      for (const w of d.identity) console.log(`  ${A.y("⚠ " + w)}`);
      if (!d.sshUp) {
        console.log(`  ${A.y("reason:")} ${d.reason}`);
        for (const h of d.hints) console.log(`    ${A.d("→ " + h)}`);
      }
      return d.sshUp ? 0 : 1;
    }

    case "find": {
      const { flags, rest: pos } = parseFlags(rest, ["--json"], ["--from"]);
      const [query] = pos;
      if (!query || pos.length !== 1) die("usage: fleet find <machine|mac> [--from <linux host on the LAN>] [--json]");
      const r = await findHost(cfg, query, { from: typeof flags["--from"] === "string" ? flags["--from"] : undefined });
      if (flags["--json"] === true) { console.log(JSON.stringify(r, null, 2)); return r.hits.length ? 0 : 1; }
      if (r.swept.length) console.error(A.d(`not in ${r.from ? r.from + "'s" : "the"} ARP table; swept ${r.swept.join(", ")}`));
      if (!r.hits.length) { console.log(`${A.r("○")} ${r.mac} is not on ${r.swept.join(", ") || "any local subnet"}`); return 1; }
      for (const h of r.hits) console.log(`${A.g("●")} ${A.b(h.ip)} ${A.d(h.mac)}`);
      for (const st of r.stale) console.log(`  ${A.y("⚠")} hosts.${st.host} reaches ${st.address}, not ${r.hits.map((h) => h.ip).join(" or ")}; update its ssh HostName`);
      return 0;
    }

    case "drop": {
      const { rest: pos } = parseFlags(rest, [], []);
      const [sel] = pos;
      if (!sel || pos.length !== 1) die("usage: fleet drop <sel>");
      for (const d of await dropMasters(cfg, await routeSelector(cfg, sel)))
        console.log(`${d.dropped ? A.g("●") : A.d("○")} ${A.b(d.host.padEnd(10))} ${A.d(d.detail)}`);
      return 0;
    }

    case "session": {
      const { flags, rest: pos } = parseFlags(rest, ["--json"], []);
      const [sel] = pos;
      if (!sel || pos.length !== 1) die("usage: fleet session <sel> [--json]");
      const states = await sessionStates(cfg, await routeSelector(cfg, sel));
      if (flags["--json"] === true) { console.log(JSON.stringify(states, null, 2)); return states.some((s) => s.error) ? 1 : 0; }
      for (const s of states) {
        if (s.error) { console.log(`${A.r("○")} ${A.b(s.host)} ${A.r(s.error)}`); continue; }
        const dot = s.state === "logged-in" ? A.g("●") : s.state === "locked" ? A.y("▲") : A.d("○");
        const parts = [s.state, s.user && `user ${s.user}`, `idle ${formatIdle(s.idleSeconds)}`];
        if (s.displays?.length) {
          const off = s.displays.filter((d) => d.on === false).map((d) => d.name);
          parts.push(off.length === s.displays.length ? "displays off" : off.length ? `off: ${off.join(", ")}` : "displays on");
        }
        console.log(`${dot} ${A.b(s.host)} ${parts.filter(Boolean).join(A.d(" · "))}${s.lock ? A.d(` (${s.lock})`) : ""}`);
        for (const n of s.notes) console.log(A.d(`    ${n}`));
      }
      return states.some((s) => s.error) ? 1 : 0;
    }

    case "hostkey": {
      const { flags, rest: pos } = parseFlags(rest, ["--pin", "--json"], []);
      const [name] = pos;
      if (!name || pos.length !== 1) die("usage: fleet hostkey <host> [--pin] [--json]");
      const r = await hostKey(cfg, name, { pin: flags["--pin"] === true });
      if (flags["--json"] === true) { console.log(JSON.stringify(r, null, 2)); return r.matches ? 0 : 1; }
      const fp = (k: string) => k.split(" ")[0] + " …" + k.split(" ")[1]!.slice(-12);
      console.log(`${A.b(r.host)} ${A.d(`alias ${r.alias} · ${r.address}${r.banner ? " · " + r.banner : ""}`)}`);
      for (const k of r.presented) console.log(`  ${r.pinned.includes(k) ? A.g("✓") : A.y("·")} ${A.d("presented")} ${fp(k)}`);
      for (const k of r.pinned.filter((k) => !r.presented.includes(k))) console.log(`  ${A.d("· pinned   ")} ${fp(k)}`);
      for (const o of r.owners) console.log(`  ${A.r("✗")} ${fp(o.key)} ${A.r("already belongs to " + o.name)}`);
      if (r.pinnedNow) console.log(`${A.g("●")} pinned ${r.presented.length} key(s) under ${r.alias}`);
      else if (r.matches) console.log(`${A.g("●")} the pinned key matches`);
      else console.log(`${A.y("○")} not pinned; ${r.owners.length ? "a different boot is up" : `run fleet hostkey ${r.host} --pin while this boot is live`}`);
      return r.matches ? 0 : 1;
    }

    case "ssh": {
      const { rest: pos } = parseFlags(rest, [], []);
      const [sel] = pos;
      if (!sel || pos.length !== 1) die("usage: fleet ssh <host>");
      return await sshInteractive(resolveHosts(cfg, await routeSelector(cfg, sel))[0]!);
    }

    default: return die(`unknown command: ${command} (try: fleet help)`);
  }
}

async function topLoop(cfg: FleetConfig, host: string): Promise<number> {
  process.stdout.write("\x1b[?25l");                       // hide cursor
  const restore = () => { process.stdout.write("\x1b[?25h\x1b[0m\n"); };
  process.on("SIGINT", () => { restore(); process.exit(0); });
  const draw = async () => {
    let out = "\x1b[2J\x1b[H";
    let n: any;
    try { n = (await fetchDashboard(cfg)).nodes?.[host]; }
    catch (e) { process.stdout.write(out + A.r((e as Error).message)); return; }
    if (!n) { out += A.r(`no data for ${host}`); process.stdout.write(out); return; }
    const mem = n.mem ?? {}, disk = (n.disks ?? [])[0] ?? {}, gpu = (n.gpu ?? [])[0];
    out += `${A.b(host)} ${A.d(`${n.os_short ?? ""} · ${n.ncpu ?? "?"} cores · ↑ ${Math.floor((n.uptime_s ?? 0) / 3600)}h`)}  ${A.d(new Date().toLocaleTimeString())}\n\n`;
    const cores = (n.cpu_cores ?? []).map((c: number) => heat(c, blk(c))).join("");
    out += `${A.d("cpu")} ${heat(n.cpu_pct, ((n.cpu_pct ?? "—") + "%").padEnd(6))} ${cores}\n`;
    out += `${A.d("mem")} ${heat(mem.pct, ((mem.pct ?? "—") + "%").padEnd(6))} ${A.d(((mem.used_mb / 1024) || 0).toFixed(1) + "/" + ((mem.total_mb / 1024) || 0).toFixed(0) + "g")}\n`;
    out += `${A.d("dsk")} ${heat(disk.pct, ((disk.pct ?? "—") + "%").padEnd(6))} ${A.d((disk.used_gb ?? 0).toFixed(0) + "/" + (disk.total_gb ?? 0).toFixed(0) + "g")}\n`;
    if (gpu) out += `${A.d("gpu")} ${heat(gpu.util, ((gpu.util | 0) + "%").padEnd(6))} ${A.c(gpu.name)} ${A.d((gpu.temp | 0) + "°c · " + (gpu.power | 0) + "w · " + (gpu.mem_used_mb / 1024).toFixed(1) + "/" + (gpu.mem_total_mb / 1024).toFixed(0) + "g")}\n`;
    out += `\n${A.d("  cpu    mem   pid    process")}\n`;
    for (const p of (n.procs ?? []).slice(0, 14)) {
      const m = p.mem_mb >= 1024 ? (p.mem_mb / 1024).toFixed(1) + "g" : Math.round(p.mem_mb ?? 0) + "m";
      out += `  ${heat(p.cpu, ((p.cpu == null ? "—" : p.cpu + "%")).padEnd(6))} ${(m).padEnd(6)} ${A.d((p.pid + "").padEnd(6))} ${p.name}\n`;
    }
    out += A.d("\n  ctrl-c to exit");
    process.stdout.write(out);
  };
  // sequential loop (not setInterval): a slow dashboard fetch can't pile up
  // overlapping draws that interleave escape sequences
  for (;;) {
    await draw();
    await Bun.sleep(2000);
  }
}

/** Bun 1.4 cuts piped `console.log` output at 64 KiB once anything has touched
 *  `process.stdout` (reading `isTTY`, adding an error listener), and a buffered
 *  `process.stdout.write` can land after a later sync write. Send both through
 *  one blocking writer on fd 1 so piped `--json` arrives whole and in order. */
export function installSyncStdout(): void {
  const out = (chunk: string | Uint8Array): void => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    for (let off = 0; off < buf.length;) {
      try { off += writeSync(1, buf, off); }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EAGAIN") { Bun.sleepSync(1); continue; }
        if (code === "EPIPE") process.exit(0);
        throw e;
      }
    }
  };
  console.log = (...args: unknown[]) => out(format(...args) + "\n");
  process.stdout.write = ((chunk: string | Uint8Array, enc?: unknown, cb?: unknown) => {
    out(chunk);
    const done = typeof enc === "function" ? enc : cb;
    if (typeof done === "function") done();
    return true;
  }) as typeof process.stdout.write;
}

if (import.meta.main) {
  const [, , command, ...rest] = process.argv;
  // Internal byte pipes (ssh ProxyCommand, the Windows session broker) keep the stream.
  if (!command?.startsWith("__")) installSyncStdout();
  Promise.resolve().then(async () => {
    const help = helpText(command ? [command, ...rest] : []);
    if (help !== undefined) { console.log(help); return 0; }
    return dispatch(command, rest, await loadConfig());
  })
    .then((code) => { process.exitCode = code; })
    .catch((e) => die(e.message));
}
