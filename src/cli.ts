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
import { loadConfig, resolveHosts } from "./config.ts";
import type { FleetConfig } from "./config.ts";
import { helpText } from "./help.ts";
import { sshInteractive } from "./ssh.ts";
import type { ExecResult } from "./ssh.ts";
import {
  spawnJob, listJobs, jobLog, jobTail, jobFollow, killJob, waitJob, pruneJobs,
} from "./jobs.ts";
import type { JobRow } from "./jobs.ts";
import {
  pullFlag, pullVal, parseFlags, parseLeadingFlags, lsHosts, runExec, runScript, readScriptSource, editRemoteFile,
  pushFile, pullFile, parseRemoteSpec, restartService, serviceLogs, svcStatus,
  gpuRows, diskRows, fetchDashboard, hostStatus, runRecipe, captureScreenshot, rebootHosts,
  cuInstall, cuRun, cuTools, cuDescribe, cuRecordStart, cuRecordStop, cuRecordStatus,
  cuApps, cuShotWindow, browseHost, preferredImageExt, overlayGrid,
  cuSnapshot, cuResolveTargetFrom, cuResolvePoint, cuAct, cuBatch, cuBlockerNote,
  cuGridCaption, cuElementSupport, compactCuOutput, briefDescribe,
  bootState, switchMachine, waitFor, routeSelector, deployHosts, diagnose, firmwareRebootHosts,
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
import type { ServiceAction, CuTarget, GridOptions } from "./core.ts";

const A = {
  g: (s: string) => `\x1b[32m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`, d: (s: string) => `\x1b[90m${s}\x1b[0m`,
  c: (s: string) => `\x1b[36m${s}\x1b[0m`, b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
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

function printResult(r: ExecResult) {
  console.log(`${r.ok ? A.g("●") : A.r("●")} ${A.b(r.host)} ${A.d("· exit " + r.code)}`);
  const stdout = r.stdout.trimEnd();
  if (stdout) console.log(stdout.split("\n").map((l) => "  " + l).join("\n"));
  if (r.stderr) console.error(A.d(r.stderr.split("\n").map((l) => "  " + l).join("\n")));
}

function printRaw(r: ExecResult): void {
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : r.stderr + "\n");
}

const SUBCOMMANDS = [
  "ls", "hosts", "dt", "exec", "spawn", "jobs", "cp", "edit", "restart", "reboot", "bios", "boot", "switch", "wait",
  "gpu", "disk", "status", "top", "logs", "svc", "shot", "cu", "browse", "run", "deploy", "tools", "doctor", "completion", "ssh", "help",
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
    boot|switch|wait|exec|spawn|cp|edit|reboot|bios|top|shot|cu|ssh|doctor|status|deploy) compadd -- "\${sels[@]}";;
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
    boot|switch|wait|exec|spawn|cp|edit|reboot|bios|top|shot|cu|ssh|doctor|status|deploy) _fleet_matches "$cur" "\${sels[@]}";;
  esac
}
complete -F _fleet fleet`;
}

async function dispatch(command: string | undefined, rest: string[], cfg: FleetConfig): Promise<number> {
  switch (command) {
    case undefined: case "help": case "-h": case "--help":
      console.log(helpText(["help", ...rest]));
      return 0;

    case "ls": case "hosts": {
      const { flags, rest: pos } = parseFlags(rest, ["--json"], []);
      if (pos.length) die(`usage: fleet ${command} [--json]`);
      const json = flags["--json"] === true;
      const row = (h: { up: boolean; httpUp?: boolean; name: string; os: string; ssh: string; services: string[] }) => {
        const dot = h.up ? A.g("●") : h.httpUp ? A.y("◍") : A.r("○");
        const note = !h.up && h.httpUp ? A.y("ssh-down · http ok  ") : "";
        return `${dot} ${A.b(h.name.padEnd(10))} ${A.d(h.os.padEnd(8))} ${A.d(h.ssh.padEnd(16))} ${note}${A.d(h.services.join(", "))}`;
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
      const { flags, rest: pos } = parseLeadingFlags(rest, ["--json", "--wsl", "--raw"], ["--cwd", "--timeout", "--script", "--interp"]);
      const json = flags["--json"] === true;
      const wsl = flags["--wsl"] === true;
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
        if (!sel) die("usage: fleet exec --script <file|-> [--interp cmd] [--cwd dir] [--timeout S] [--wsl] [--raw] [--json] <sel>");
        if (cmd) die(`fleet exec --script takes no command after <sel> (got '${cmd}') — the script IS the command`);
        const script = await readScriptSource(scriptPath);
        const results = await runScript(cfg, await routeSelector(cfg, sel!), script, { wsl, cwd, timeoutMs, interp });
        if (json) console.log(JSON.stringify(results, null, 2));
        else if (raw) results.forEach(printRaw);
        else results.forEach(printResult);
        return results.some((r) => !r.ok) ? 1 : 0;
      }
      if (interp) die("--interp requires --script");
      if (!sel || !cmd) die("usage: fleet exec [--cwd dir] [--timeout S] [--wsl] [--raw] [--json] <sel> <cmd…>   |   fleet exec --script <file|-> <sel>");
      // A remote command starting with a fleet flag means the flag was written
      // AFTER <sel>, where it is treated as part of the command and shipped to
      // the remote shell verbatim — which fails far away from the real cause.
      // (`--shell wsl` is a common invention; the real flag is `--wsl`.)
      const strayFlag = !separated && pos[0]?.startsWith("--") ? pos[0] : undefined;
      if (strayFlag === "--shell")
        die(`there is no --shell flag; use --wsl, and put it BEFORE the host: fleet exec --wsl ${sel} <cmd…>`);
      if (strayFlag && ["--json", "--wsl", "--raw", "--cwd", "--timeout", "--script", "--interp"].includes(strayFlag))
        die(`'${strayFlag}' must come BEFORE the host selector: fleet exec ${strayFlag} ${sel} <cmd…>`);
      const trailing = separated ? undefined : trailingFleetFlag(pos, ["--json", "--wsl", "--raw"], ["--cwd", "--timeout", "--script", "--interp"]);
      if (trailing)
        die(`'${trailing}' must come BEFORE the host selector: fleet exec ${trailing} ${sel} <cmd…>  (quote the whole command if it really ends in ${trailing})`);
      // a bare machine name (dual-boot box) auto-routes to whichever boot is live
      const target = await routeSelector(cfg, sel!);
      const results = await runExec(cfg, target, cmd, { wsl, cwd, timeoutMs });
      if (json) console.log(JSON.stringify(results, null, 2));
      else if (raw) results.forEach(printRaw);
      else results.forEach(printResult);
      return results.some((r) => !r.ok) ? 1 : 0;
    }

    case "spawn": {
      const { flags, rest: pos } = parseLeadingFlags(rest, ["--json"], ["--cwd", "--label"]);
      const json = flags["--json"] === true;
      const cwd = typeof flags["--cwd"] === "string" && flags["--cwd"] ? flags["--cwd"] : undefined;
      const label = typeof flags["--label"] === "string" && flags["--label"] ? flags["--label"] : undefined;
      const sel = pos.shift();
      const separated = pos[0] === "--";
      if (separated) pos.shift();
      const cmd = pos.join(" ");
      if (!sel || !cmd) die("usage: fleet spawn [--cwd dir] [--label name] [--json] <sel> <cmd…>");
      const misplaced = separated ? undefined : ["--cwd", "--label", "--json", "--name"].includes(pos[0] ?? "") ? pos[0]
        : trailingFleetFlag(pos, ["--json"], ["--cwd", "--label", "--name"]);
      if (misplaced === "--name")
        die("there is no --name flag; use --label, and put it BEFORE the host: fleet spawn --label <name> " + sel + " <cmd…>");
      if (misplaced)
        die("'" + misplaced + "' must come BEFORE the host selector: fleet spawn " + misplaced + " <value> " + sel + " <cmd…>  (quote the whole command if it really ends in " + misplaced + ")");
      const results = await spawnJob(cfg, await routeSelector(cfg, sel!), cmd, { cwd, label });
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
      const parsed = parseFlags(rest, ["--json", "-r", "--recursive"], []);
      rest = parsed.rest;
      const json = parsed.flags["--json"] === true;
      const recursive = parsed.flags["-r"] === true || parsed.flags["--recursive"] === true;
      const usage = "usage: fleet cp [-r] <local...> <sel>:<remote-dir>   |   fleet cp [-r] <sel>:<remote...> <local-dir>";
      // Everything but the last token is a source; the last token is the destination.
      // With >1 source the destination must be a directory (scp enforces that).
      const dest = rest[rest.length - 1];
      const srcs = rest.slice(0, -1);
      if (!dest || !srcs.length) die(usage);
      const push = parseRemoteSpec(cfg, dest!);          // local → remote (destination is remote)
      const srcSpecs = srcs.map((s) => parseRemoteSpec(cfg, s));
      if (push) {
        if (srcSpecs.some(Boolean)) die("remote → remote copy is not supported (pull to a local file first)");
        const results = await pushFile(cfg, srcs, await routeSelector(cfg, push.sel), push.path, recursive);
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
        const r = await pullFile(cfg, await routeSelector(cfg, specs[0]!.sel), specs.map((s) => s.path), dest!, recursive);
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
        ["--json", "--wsl", "--all", "--dry-run"], ["--old", "--new"], false, ["--new"]);
      const json = flags["--json"] === true;
      const wsl = flags["--wsl"] === true;
      const all = flags["--all"] === true;
      const dryRun = flags["--dry-run"] === true;
      const old = flags["--old"] as string | undefined;
      const neu = (flags["--new"] as string | undefined) ?? "";
      const [target] = pos;
      if (!target || old === undefined || pos.length !== 1)
        die("usage: fleet edit [--all] [--dry-run] [--wsl] [--json] <sel>:<path> --old <str> --new <str>");
      const spec = parseRemoteSpec(cfg, target!);
      if (!spec) die(`fleet edit needs a <sel>:<path> target (got '${target}')`);
      const results = await editRemoteFile(
        cfg, await routeSelector(cfg, spec!.sel), spec!.path, old!, neu, { wsl, all, dryRun });
      if (json) { console.log(JSON.stringify(results, null, 2)); return results.some((r) => !r.ok) ? 1 : 0; }
      for (const r of results) {
        if (!r.ok) { console.log(`${A.r("●")} ${A.b(r.host)} ${A.d(r.path)}  ${A.y(r.error ?? "edit failed")}`); continue; }
        const what = `${r.replacements} replacement${r.replacements === 1 ? "" : "s"}${dryRun ? A.y(" (dry run — nothing written)") : ""}`;
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
      const { flags, rest: pos } = parseFlags(rest, ["--no-open", "--grid"], ["--grid-step", "--out"]);
      const noOpen = flags["--no-open"] === true;
      const grid = flags["--grid"] === true;
      const gridStep = numFlag(flags, "--grid-step", 100);
      const out = flags["--out"] as string | undefined;
      const [sel] = pos;
      if (!sel || pos.length !== 1) die("usage: fleet shot <host> [--out file.png] [--grid [--grid-step N]] [--no-open]");
      const routed = await routeSelector(cfg, sel);
      const host = resolveHosts(cfg, routed)[0]!;
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const local = out ?? `${host.name}-${ts}.${await preferredImageExt()}`;
      process.stdout.write(A.d(`◎ capturing ${host.name} …\r`));
      const r = await captureScreenshot(cfg, routed, local);
      if (grid && !await overlayGrid(r.localPath, gridStep)) console.error(A.y("grid overlay skipped (need python3 + Pillow)"));
      console.log(`${A.g("●")} ${A.b(r.host)} ${A.d("→")} ${r.localPath}${grid ? A.d(" (grid)") : ""}`);
      if (!noOpen && process.platform === "darwin")
        Bun.spawn(["open", r.localPath], { stdout: "ignore", stderr: "ignore" });
      return 0;
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
      const sel = rest.shift();
      if (!sel) die("usage: fleet cu <host> <cua-driver args…> [--out f.png] [--grid]  |  fleet cu <sel> install");
      const target = await routeSelector(cfg, sel);

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
        const { apps, result } = await cuApps(cfg, target, rest[1]);
        if (!result.ok) { printResult(result); return 1; }
        for (const a of apps)
          console.log(`${A.d((a.pid + "").padStart(7))}  ${A.b(a.name)}${a.active ? A.g(" •active") : ""}`);
        console.log(A.d(`${apps.length} app(s)`));
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
        const source = file ? await Bun.file(file).text() : rest[2] === "-" ? await Bun.stdin.text() : rest[2]!;
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
      const ACT_VERBS = ["click", "right-click", "double-click", "drag", "scroll", "hotkey", "key", "type", "act"] as const;
      const rawInput = ["click", "drag", "scroll", "hotkey"].includes(verb ?? "") && /^\s*\{/.test(rest[1] ?? "");
      if (!rawInput && ACT_VERBS.includes(verb as typeof ACT_VERBS[number])) {
        const json = pullFlag(rest, "--json");
        const q = rest[1] ?? die(`usage: fleet cu <host> ${verb} <pid|process|app|title> …`);
        const shotPath = wantShot || out ? (out ?? `${autoName(q)}.${await preferredImageExt()}`) : undefined;

        let tool = verb!;
        let payload: Record<string, unknown> = {};
        let point: { x: number; y: number; space: "window" | "screen" } | undefined;
        let summary = "";
        if (["click", "right-click", "double-click"].includes(verb!)) {
          const [xs, ys] = [rest[2], rest[3]];
          if (rest.length !== 4) die(`usage: fleet cu <host> ${verb} <app> <x> <y> [--space window|screen]`);
          const [x, y] = [Number(xs), Number(ys)];
          if (!Number.isFinite(x) || !Number.isFinite(y)) die(`click needs numeric x y (got '${xs} ${ys}')`);
          if (button && !["left", "right", "middle"].includes(button))
            die(`--button must be left, right, or middle (got '${button}')`);
          if (clickCount > 3) die("--count must be 1, 2, or 3");
          point = { x, y, space };
          tool = verb === "right-click" ? "right_click" : verb === "double-click" ? "double_click" : "click";
          payload = tool === "click" ? { count: clickCount, ...(button ? { button } : {}) } : {};
          summary = `${tool} ${x},${y}`;
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

        const r = await cuAct(cfg, target, q, tool, payload,
          { settleMs: settle, imageOut: shotPath, point, space });
        if (json) {
          if (r.localImage) await applyGrid(r.localImage, gridOpts(r.target, cuBlockerNote(r.target)));
          console.log(JSON.stringify(r));
          return r.result.ok ? 0 : 1;
        }
        if (point && typeof r.payload.x === "number")
          summary = `${tool} ${r.payload.x},${r.payload.y}`
            + (space === "screen" ? A.d(` (from screen ${point.x},${point.y})`) : "")
            + (clickCount > 1 ? ` x${clickCount}` : "");
        const badge = r.effect === "changed" ? A.g("● changed")
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
      const { flags, rest: pos } = parseFlags(rest, ["--json"], []);
      const json = flags["--json"] === true;
      const [sel] = pos;
      if (!sel || pos.length !== 1) die("usage: fleet boot <machine> [--json]");
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
      const { flags, rest: pos } = parseFlags(rest, ["--yes", "-y", "--no-wait"], ["--to", "--timeout"]);
      const to = flags["--to"] as string | undefined;
      const yes = flags["--yes"] === true || flags["-y"] === true;
      const noWait = flags["--no-wait"] === true;
      const timeout = numFlag(flags, "--timeout", 180) * 1000;
      const [sel] = pos;
      if (!sel || !to || pos.length !== 1) die("usage: fleet switch <machine> --to <os> [--yes] [--no-wait] [--timeout S]");
      // switch reboots the box into another OS — same destructive gate as reboot
      if (!await confirm(`switch ${A.b(sel)} → ${A.b(to)} (reboots into the other OS)`, yes)) return 1;
      console.log(A.d(`◎ switching ${sel} → ${to} …`));
      const r = await switchMachine(cfg, sel, to!, { timeoutMs: timeout, wait: !noWait });
      console.log(A.d(`↻ from ${r.from ?? "?"} · trigger exit ${r.triggered.code}`));
      if (noWait) { console.log(A.y("switch issued; not waiting")); return 0; }
      if (r.arrived) console.log(`${A.g("●")} ${A.b(sel)} ${A.d("now in")} ${A.b(to!)} ${A.d(`(${Math.round(r.waitedMs / 1000)}s)`)}`);
      else console.log(`${A.r("✗")} ${sel} did not reach ${to} within ${timeout / 1000}s`);
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
      if (!name || pos.length !== 1) die("usage: fleet run <recipe>");
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

    case "doctor": {
      const { flags, rest: pos } = parseFlags(rest, ["--json"], []);
      const json = flags["--json"] === true;
      const [sel] = pos;
      if (!sel || pos.length !== 1) die("usage: fleet doctor <host>");
      const d = await diagnose(cfg, await routeSelector(cfg, sel!));
      if (json) { console.log(JSON.stringify(d, null, 2)); return d.sshUp ? 0 : 1; }
      const head = d.sshUp ? A.g(`● ${d.host} reachable`) : A.r(`○ ${d.host} unreachable`);
      console.log(`${head} ${A.d(`· ${d.os} · ssh ${d.ssh} · ${d.ms}ms`)}`);
      if (d.health) console.log(`  ${d.httpUp ? A.g("● health ok") : A.r("○ health down")} ${A.d(d.health)}`);
      if (d.services.length) console.log(`  ${A.d("services: " + d.services.join(", "))}`);
      if (!d.sshUp) {
        console.log(`  ${A.y("reason:")} ${d.reason}`);
        for (const h of d.hints) console.log(`    ${A.d("→ " + h)}`);
      }
      return d.sshUp ? 0 : 1;
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

if (import.meta.main) {
  const [, , command, ...rest] = process.argv;
  Promise.resolve().then(async () => {
    const help = helpText(command ? [command, ...rest] : []);
    if (help !== undefined) { console.log(help); return 0; }
    return dispatch(command, rest, await loadConfig());
  })
    .then((code) => { process.exitCode = code; })
    .catch((e) => die(e.message));
}
