#!/usr/bin/env bun
/**
 * fleet — drive the whole fleet without ssh/PowerShell/WSL quoting pain.
 *
 *   fleet ls                          reachability of every host
 *   fleet exec [--cwd d] [--wsl] [--raw] [--json] <sel> <cmd…>   run a command (blocking; flags BEFORE <sel>)
 *   fleet spawn [--cwd d] [--label n] <sel> <cmd…>   launch a detached job that outlives ssh
 *   fleet jobs [<sel>] | log|tail|kill|wait|prune …   track detached jobs
 *   fleet cp <local> <sel>:<remote>   push a file (fan-out across a group)
 *   fleet restart <host> <svc>        restart a configured service
 *   fleet reboot <sel> [--yes]        reboot the whole machine(s)
 *   fleet gpu [--json]                every GPU: util / free VRAM / temp / loaded model
 *   fleet disk [sel] [--json]         every volume: free space / % used (live, not the dashboard)
 *   fleet status [host] [--json]      live CPU/mem/disk from the configured dashboard
 *   fleet top <host>                  live terminal btop for one host
 *   fleet logs <host> <svc> [-n N]    recent logs / status for a service
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
import { sshInteractive } from "./ssh.ts";
import type { ExecResult } from "./ssh.ts";
import {
  spawnJob, listJobs, jobLog, jobTail, jobFollow, killJob, waitJob, pruneJobs,
} from "./jobs.ts";
import type { JobRow } from "./jobs.ts";
import {
  pullFlag, pullVal, parseLeadingFlags, lsHosts, runExec, pushFile, pullFile, parseRemoteSpec, restartService, serviceLogs, svcStatus,
  gpuRows, diskRows, fetchDashboard, hostStatus, runRecipe, captureScreenshot, rebootHosts,
  cuInstall, cuRun, cuApps, cuWindows, cuResolvePid, cuShotWindow, preferredImageExt, overlayGrid,
  bootState, switchMachine, waitFor, routeSelector, deployHosts, diagnose, firmwareRebootHosts,
} from "./core.ts";
import type { ServiceAction } from "./core.ts";

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
  if (!Number.isFinite(n) || n < min) die(`${flag} needs a number ≥ ${min} (got '${v}')`);
  return Math.floor(n);
}
/** Same strictness as numVal, but over a parseLeadingFlags result. */
function numFlag(flags: Record<string, string | true>, flag: string, def: number, min = 1): number {
  const v = flags[flag];
  if (v === undefined) return def;
  const n = Number(v);
  if (v === true || !Number.isFinite(n) || n < min) die(`${flag} needs a number ≥ ${min} (got '${v}')`);
  return Math.floor(n);
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
  if (r.stdout) console.log(r.stdout.split("\n").map((l) => "  " + l).join("\n"));
  if (r.stderr) console.log(A.d(r.stderr.split("\n").map((l) => "  " + l).join("\n")));
}

const SUBCOMMANDS = [
  "ls", "dt", "exec", "spawn", "jobs", "cp", "restart", "reboot", "bios", "boot", "switch", "wait",
  "gpu", "disk", "status", "top", "logs", "svc", "shot", "cu", "run", "deploy", "doctor", "completion", "ssh", "help",
];
/** Emit a bash/zsh completion script with this config's hosts/groups/recipes/
 *  services baked in. Source it: `eval "$(fleet completion zsh)"`. */
function completionScript(cfg: FleetConfig, shell: string): string {
  const hosts = Object.keys(cfg.hosts);
  const routes = Object.keys(cfg.routes ?? {});
  const machines = Object.keys(cfg.machines ?? {});
  const groups = ["@linux", "@windows", "@mac", "@gpu", ...Object.keys(cfg.groups ?? {}).map((g) => "@" + g)];
  const recipes = Object.keys(cfg.recipes ?? {});
  const services = [...new Set(Object.values(cfg.hosts).flatMap((h) => Object.keys(h.services ?? {})))];
  const sels = ["all", ...groups, ...hosts, ...routes, ...machines].join(" ");
  const svcCmds = "restart logs svc";   // commands whose args include service names
  if (shell === "zsh") return `#compdef fleet
_fleet() {
  local cmds="${SUBCOMMANDS.join(" ")}"
  local sels="${sels}"; local svcs="${services.join(" ")}"; local recipes="${recipes.join(" ")}"
  if (( CURRENT == 2 )); then compadd -- \${=cmds}; return; fi
  case $words[2] in
    run) compadd -- \${=recipes};;
    ${svcCmds.split(" ").join("|")}) compadd -- \${=sels} \${=svcs};;
    boot|switch|wait|exec|spawn|cp|reboot|bios|top|shot|cu|ssh|doctor|status|deploy) compadd -- \${=sels};;
  esac
}
compdef _fleet fleet`;
  // default: bash
  return `_fleet() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local cmds="${SUBCOMMANDS.join(" ")}"
  local sels="${sels}"; local svcs="${services.join(" ")}"; local recipes="${recipes.join(" ")}"
  if [ "\$COMP_CWORD" -eq 1 ]; then COMPREPLY=( \$(compgen -W "\$cmds" -- "\$cur") ); return; fi
  case "\${COMP_WORDS[1]}" in
    run) COMPREPLY=( \$(compgen -W "\$recipes" -- "\$cur") );;
    ${svcCmds.split(" ").join("|")}) COMPREPLY=( \$(compgen -W "\$sels \$svcs" -- "\$cur") );;
    boot|switch|wait|exec|spawn|cp|reboot|bios|top|shot|cu|ssh|doctor|status|deploy) COMPREPLY=( \$(compgen -W "\$sels" -- "\$cur") );;
  esac
}
complete -F _fleet fleet`;
}

async function dispatch(command: string | undefined, rest: string[], cfg: FleetConfig): Promise<number> {
  switch (command) {
    case undefined: case "help": case "-h": case "--help": {
      console.log(`${A.b("fleet")} — drive your fleet without quoting pain\n
  fleet ls                        reachability of every host
  fleet dt                        list live Daytona sandboxes (needs DAYTONA_API_KEY)
  fleet exec [flags] <sel> <cmd…>  run a command, blocking   (flags BEFORE <sel>: --cwd dir --timeout S --wsl --raw --json)
  fleet spawn [flags] <sel> <cmd…> launch a detached job (outlives ssh)   (flags BEFORE <sel>: --cwd dir --label name --json)
  fleet jobs [<sel>]              list detached jobs across the fleet
  fleet jobs tail <host:id> [-f]  stream a job's output   (log | kill | wait | prune)
  fleet jobs wait <host:id>       block on exit   (--until <regex>, --timeout S)
  fleet cp <local> <sel>:<remote> push a file (fan-out ok)
  fleet restart <host> <svc>      restart a configured service
  fleet reboot <sel> [--yes]      reboot the whole machine(s)
  fleet bios <sel> [--yes]        reboot into UEFI/BIOS firmware setup
  fleet boot <machine>            which OS is live on a dual-boot box
  fleet switch <machine> --to OS  reboot into the other OS, wait for it   (--yes)
  fleet wait <host|machine> …     block until ssh/port/http/boot is ready
  fleet gpu                       util / free VRAM / temp / loaded model
  fleet disk [sel]                free space on every volume (live, all drives)
  fleet status [host]             live stats from the dashboard   (--json)
  fleet top <host>                live terminal btop for one host
  fleet logs <host> <svc> [-n N]  recent logs for a service
  fleet svc <svc> [sel]           status of a service across every host that has it
  fleet shot <host> [--out f]     screenshot the remote desktop → local PNG
  fleet cu <host> <args…>         computer-use via cua-driver (install | click/type/…)
  fleet deploy <sel>              ship fleet source → host(s), bun install, restart   (--no-restart)
  fleet run <recipe>              run a saved playbook
  fleet doctor <host>             diagnose why a host is unreachable (ssh -vv + health)
  fleet completion [bash|zsh]     shell completion (eval "$(fleet completion zsh)")
  fleet ssh <host>                interactive shell\n
  selectors: host | logical route | @linux @windows @mac @gpu | @<custom> | all | a,b,@gpu | dt:<sandbox id|name|prefix>
  daytona:   exec/cp work on dt: sandboxes over the REST API — e.g. fleet exec dt:spore- "ls" (prefix must be unique)
  hosts: ${Object.keys(cfg.hosts).join(", ")}
  routes: ${Object.keys(cfg.routes ?? {}).join(", ") || "none"}
  machines: ${Object.keys(cfg.machines ?? {}).join(", ") || "none"}
  recipes: ${Object.keys(cfg.recipes ?? {}).join(", ") || "none"}`);
      return 0;
    }

    case "ls": {
      const json = pullFlag(rest, "--json");
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
      const json = pullFlag(rest, "--json");
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
      const { flags, rest: pos } = parseLeadingFlags(rest, ["--json", "--wsl", "--raw"], ["--cwd", "--timeout"]);
      const json = flags["--json"] === true;
      const wsl = flags["--wsl"] === true;
      const raw = flags["--raw"] === true; // print ONLY remote stdout — no header, no indent (for piping/backup)
      const cwd = typeof flags["--cwd"] === "string" && flags["--cwd"] ? flags["--cwd"] : undefined; // run in this dir (fails fast if missing)
      const timeout = numFlag(flags, "--timeout", 0, 0);  // wall-clock cap in seconds; 0 = none (FLEET_EXEC_TIMEOUT env also works)
      const sel = pos.shift();
      const cmd = pos.join(" ");
      if (!sel || !cmd) die("usage: fleet exec [--cwd dir] [--timeout S] [--wsl] [--raw] [--json] <sel> <cmd…>");
      // a bare machine name (dual-boot box) auto-routes to whichever boot is live
      const target = await routeSelector(cfg, sel!);
      const results = await runExec(cfg, target, cmd, { wsl, cwd, timeoutMs: timeout * 1000 || undefined });
      if (json) console.log(JSON.stringify(results, null, 2));
      else if (raw) results.forEach((r) => process.stdout.write(r.stdout));
      else results.forEach(printResult);
      return results.some((r) => !r.ok) ? 1 : 0;
    }

    case "spawn": {
      const { flags, rest: pos } = parseLeadingFlags(rest, ["--json"], ["--cwd", "--label"]);
      const json = flags["--json"] === true;
      const cwd = typeof flags["--cwd"] === "string" && flags["--cwd"] ? flags["--cwd"] : undefined;
      const label = typeof flags["--label"] === "string" && flags["--label"] ? flags["--label"] : undefined;
      const sel = pos.shift();
      const cmd = pos.join(" ");
      if (!sel || !cmd) die("usage: fleet spawn [--cwd dir] [--label name] [--json] <sel> <cmd…>");
      const results = await spawnJob(cfg, await routeSelector(cfg, sel!), cmd, { cwd, label });
      if (json) { console.log(JSON.stringify(results, null, 2)); return results.some((r) => !r.ok) ? 1 : 0; }
      for (const r of results) {
        if (r.ok) console.log(`${A.g("●")} ${A.b(r.host)} ${A.d("job")} ${A.c(r.id!)} ${A.d("· pid " + r.pid)}  ${A.d("fleet jobs tail " + r.host + ":" + r.id)}`);
        else console.log(`${A.r("●")} ${A.b(r.host)} ${A.d("·")} ${A.y(r.error ?? "spawn failed")}`);
      }
      return results.some((r) => !r.ok) ? 1 : 0;
    }

    case "jobs": {
      const json = pullFlag(rest, "--json");
      const verb = rest[0];
      const ADDRESSED = new Set(["log", "tail", "kill", "wait"]);
      if (verb && ADDRESSED.has(verb)) {
        rest.shift();
        if (verb === "log") {
          const { host, output } = await jobLog(cfg, rest[0] ?? die("usage: fleet jobs log <host:id>"), rest[1]);
          if (json) console.log(JSON.stringify({ host, output }, null, 2));
          else process.stdout.write(output.endsWith("\n") || !output ? output : output + "\n");
          return 0;
        }
        if (verb === "tail") {
          const follow = pullFlag(rest, "-f") || pullFlag(rest, "--follow");
          const n = numVal(rest, "-n", 40);
          const a = rest[0] ?? die("usage: fleet jobs tail <host:id> [-n N] [-f]");
          if (follow) return await jobFollow(cfg, a, rest[1], n);
          const { output } = await jobTail(cfg, a, rest[1], n);
          process.stdout.write(output.endsWith("\n") || !output ? output : output + "\n");
          return 0;
        }
        if (verb === "kill") {
          const r = await killJob(cfg, rest[0] ?? die("usage: fleet jobs kill <host:id>"), rest[1]);
          printResult(r);
          return r.ok ? 0 : 1;
        }
        if (verb === "wait") {
          const until = pullVal(rest, "--until");
          const timeout = numVal(rest, "--timeout", 0, 0) * 1000;
          const a = rest[0] ?? die("usage: fleet jobs wait <host:id> [--until regex] [--timeout S]");
          const label = until ? `match /${until}/` : "exit";
          const r = await waitJob(cfg, a, rest[1], {
            until, timeoutMs: timeout,
            onTick: (s, ms) => process.stdout.write(A.d(`\r◎ ${a} ${label}: ${s} ${Math.round(ms / 1000)}s   `)),
          });
          process.stdout.write("\r\x1b[K");
          // exit code is scriptable: matched → 0, timeout → 124 (timeout(1) convention),
          // exited → the job's own code (so `fleet jobs wait X && deploy` works).
          const exitCode = r.outcome === "matched" ? 0 : r.outcome === "timeout" ? 124 : (r.code ?? 0);
          if (json) { console.log(JSON.stringify(r, null, 2)); return exitCode; }
          const tag = r.outcome === "matched" ? A.g("● matched") : r.outcome === "exited"
            ? (r.code === 0 ? A.g("● exit 0") : A.r("● exit " + r.code)) : A.y("○ timeout");
          console.log(`${tag} ${A.b(r.host + ":" + r.id)} ${A.d(`(${Math.round(r.elapsedMs / 1000)}s)`)}`);
          return exitCode;
        }
      }
      if (verb === "prune") {
        rest.shift();
        const all = pullFlag(rest, "--all");
        const out = await pruneJobs(cfg, await routeSelector(cfg, rest[0] ?? "all"), all);
        for (const o of out) {
          if (o.error) console.log(`${A.r("✗")} ${A.b(o.host)} ${A.y("prune failed: " + o.error)}`);
          else console.log(`${A.d("⌫")} ${A.b(o.host)} ${A.d("pruned " + o.removed + " job(s)")}`);
        }
        return out.some((o) => o.error) ? 1 : 0;
      }
      // bare list (optional selector)
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
      const json = pullFlag(rest, "--json");
      const recursive = pullFlag(rest, "-r") || pullFlag(rest, "--recursive");
      const [a, b] = rest;
      if (!a || !b) die("usage: fleet cp [-r] <local> <sel>:<remote>   |   fleet cp [-r] <sel>:<remote> <local>");
      const push = parseRemoteSpec(cfg, b!);   // local → remote  (destination is remote)
      const pull = parseRemoteSpec(cfg, a!);   // remote → local  (source is remote)
      if (push && pull) die("remote → remote copy is not supported (pull to a local file first)");
      if (push) {
        const results = await pushFile(cfg, a!, await routeSelector(cfg, push.sel), push.path, recursive);
        if (json) console.log(JSON.stringify(results, null, 2));
        else for (const r of results)
          console.log(`${r.ok ? A.g("●") : A.r("●")} ${A.b(r.host)} ${A.d(a + " → " + push.path)}${r.stderr ? "\n  " + A.d(r.stderr) : ""}`);
        return results.some((r) => !r.ok) ? 1 : 0;
      }
      if (pull) {
        const r = await pullFile(cfg, await routeSelector(cfg, pull.sel), pull.path, b!, recursive);
        if (json) console.log(JSON.stringify(r, null, 2));
        else console.log(`${r.ok ? A.g("●") : A.r("●")} ${A.b(r.host)} ${A.d(pull.path + " → " + b)}${r.stderr ? "\n  " + A.d(r.stderr) : ""}`);
        return r.ok ? 0 : 1;
      }
      return die("usage: fleet cp [-r] <local> <sel>:<remote>   |   fleet cp [-r] <sel>:<remote> <local>");
    }

    case "restart": {
      const [sel, svcName] = rest;
      if (!sel || !svcName) die("usage: fleet restart <sel> <service>");
      const actions = await restartService(cfg, await routeSelector(cfg, sel!), svcName!);
      for (const a of actions) {
        console.log(A.d(`↻ ${a.host} :: ${a.service} (${a.type})`));
        printResult(a.result);
      }
      return actions.some((a) => !a.result.ok) ? 1 : 0;
    }

    case "reboot": {
      const yes = pullFlag(rest, "--yes") || pullFlag(rest, "-y");
      const sel = rest[0];
      if (!sel) die("usage: fleet reboot <sel> [--yes]");
      const routed = await routeSelector(cfg, sel!);
      const hosts = resolveHosts(cfg, routed).map((h) => h.name);
      if (!await confirm(`reboot ${A.b(hosts.join(", "))} (this drops the connection)`, yes)) return 1;
      const actions = await rebootHosts(cfg, routed);
      for (const a of actions)
        console.log(`${a.result.ok ? A.g("↻") : A.r("✗")} ${A.b(a.host)} ${A.d("· " + a.os + (a.result.ok ? " · rebooting" : " · exit " + a.result.code))}${a.result.stderr ? "\n  " + A.d(a.result.stderr) : ""}`);
      return actions.some((a) => !a.result.ok) ? 1 : 0;
    }

    case "bios": {
      const yes = pullFlag(rest, "--yes") || pullFlag(rest, "-y");
      const sel = rest[0];
      if (!sel) die("usage: fleet bios <sel> [--yes]");
      const routed = await routeSelector(cfg, sel!);
      const hosts = resolveHosts(cfg, routed).map((h) => h.name);
      if (!await confirm(`reboot ${hosts.join(", ")} into BIOS/UEFI setup (drops the connection)`, yes)) return 1;
      const actions = await firmwareRebootHosts(cfg, routed);
      for (const a of actions)
        console.log(`${a.result.ok ? A.g("↻") : A.r("✗")} ${A.b(a.host)} ${A.d("· " + a.os + (a.result.ok ? " · entering firmware" : " · " + (a.result.stderr || "exit " + a.result.code)))}`);
      return actions.some((a) => !a.result.ok) ? 1 : 0;
    }

    case "logs": {
      const n = numVal(rest, "-n", 30);
      const [sel, svcName] = rest;
      if (!sel || !svcName) die("usage: fleet logs <sel> <service> [-n N]");
      const actions = await serviceLogs(cfg, await routeSelector(cfg, sel!), svcName!, n);
      for (const a of actions) {
        if (actions.length > 1) console.log(A.d(`— ${a.host} :: ${a.service}`));
        printResult(a.result);
      }
      return actions.some((a) => !a.result.ok) ? 1 : 0;
    }

    case "svc": case "service": {
      const json = pullFlag(rest, "--json");
      const name = rest[0];
      const sel = rest[1] ?? "all";
      if (!name) die("usage: fleet svc <service> [sel]   (status across every host that has it)");
      const rows = await svcStatus(cfg, await routeSelector(cfg, sel), name!);
      if (json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
      for (const r of rows)
        console.log(`${r.up ? A.g("●") : A.r("○")} ${A.b(r.host.padEnd(10))} ${A.d(r.service.padEnd(16))} ${r.up ? A.g(r.detail) : A.y(r.detail)} ${A.d("(" + r.type + ")")}`);
      return rows.some((r) => !r.up) ? 1 : 0;
    }

    case "gpu": {
      const json = pullFlag(rest, "--json");
      const rows = await gpuRows(cfg);
      if (!rows.length) die("no GPUs reported by the dashboard");
      if (json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
      for (const r of rows)
        console.log(`${A.b(r.host.padEnd(9))} ${A.c(r.gpu.padEnd(22))} ${A.d("util")} ${heat(r.util, (((r.util ?? 0) | 0) + "%").padEnd(5))} ${A.d("free")} ${A.g((r.free_gb?.toFixed(1) ?? "—") + "g").padEnd(16)} ${A.d("temp")} ${((r.temp ?? 0) | 0)}°c   ${r.model ? A.y(r.model) : A.d("idle")}`);
      return 0;
    }

    case "disk": {
      const json = pullFlag(rest, "--json");
      const sel = rest[0] ?? "all";
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
      const json = pullFlag(rest, "--json");
      const filter = rest[0];
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
      const sel = rest[0];
      if (!sel) die("usage: fleet top <host>");
      const host = resolveHosts(cfg, await routeSelector(cfg, sel))[0]!.name;
      return await topLoop(cfg, host);
    }

    case "shot": case "screenshot": {
      const noOpen = pullFlag(rest, "--no-open");
      const grid = pullFlag(rest, "--grid");
      const gridStep = numVal(rest, "--grid-step", 100);
      const out = pullVal(rest, "--out");
      const sel = rest[0];
      if (!sel) die("usage: fleet shot <host> [--out file.png] [--grid [--grid-step N]] [--no-open]");
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

    case "cu": case "computer": {
      const noOpen = pullFlag(rest, "--no-open");
      const grid = pullFlag(rest, "--grid");
      const gridStep = numVal(rest, "--grid-step", 100);
      const out = pullVal(rest, "--out");
      const sel = rest.shift();
      if (!sel) die("usage: fleet cu <host> install | <cua-driver args…> [--out f.png] [--grid]");
      const target = await routeSelector(cfg, sel);
      const applyGrid = async (p?: string) => {
        if (p && grid && !await overlayGrid(p, gridStep))
          console.error(A.y("grid overlay skipped (need python3 + Pillow)"));
      };
      const openImg = (p?: string) => {
        if (p && !noOpen && process.platform === "darwin")
          Bun.spawn(["open", p], { stdout: "ignore", stderr: "ignore" });
      };
      const verb = rest[0];

      if (verb === "install") {
        console.log(A.d(`◎ installing cua-driver on ${target} …`));
        const r = await cuInstall(cfg, target);
        printResult(r);
        return r.ok ? 0 : 1;
      }
      // convenience verbs (item 3) — cut the list→list→build-JSON loop
      if (verb === "apps") {
        const { apps, result } = await cuApps(cfg, target, rest[1]);
        if (!result.ok) { printResult(result); return 1; }
        for (const a of apps)
          console.log(`${A.d((a.pid + "").padStart(7))}  ${A.b(a.name)}${a.active ? A.g(" •active") : ""}`);
        console.log(A.d(`${apps.length} app(s)`));
        return 0;
      }
      if (verb === "windows") {
        const q = rest[1] ?? die("usage: fleet cu <host> windows <pid|app-name>");
        const { pid } = await cuResolvePid(cfg, target, q!);
        const { windows, result } = await cuWindows(cfg, target, pid);
        if (!result.ok) { printResult(result); return 1; }
        for (const w of windows)
          console.log(`${A.d((w.window_id + "").padStart(8))}  ${w.title || A.d("(untitled)")}`);
        console.log(A.d(`${windows.length} window(s) for pid ${pid}`));
        return 0;
      }
      if (verb === "shot-window" || verb === "win") {
        const q = rest[1] ?? die("usage: fleet cu <host> shot-window <pid|app-name> [--out f.png]");
        const local = out ?? `${sel}-${q!.replace(/[^a-z0-9]+/gi, "_")}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${await preferredImageExt()}`;
        const r = await cuShotWindow(cfg, target, q!, local);
        printResult(r.result);
        if (r.localImage) {
          await applyGrid(r.localImage);
          console.log(`${A.g("●")} ${A.d(`${r.app.name} w${r.window.window_id} →`)} ${r.localImage}${grid ? A.d(" (grid)") : ""}`);
          openImg(r.localImage);
        }
        return r.result.ok ? 0 : 1;
      }

      const r = await cuRun(cfg, target, rest, out);   // pull an image only when --out is given
      printResult(r.result);
      if (r.localImage) {
        await applyGrid(r.localImage);
        console.log(`${A.g("●")} ${A.d("image →")} ${r.localImage}${grid ? A.d(" (grid)") : ""}`);
        openImg(r.localImage);
      }
      return r.result.ok ? 0 : 1;
    }

    case "boot": {
      const json = pullFlag(rest, "--json");
      const sel = rest[0];
      if (!sel) die("usage: fleet boot <machine> [--json]");
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
      const to = pullVal(rest, "--to");
      const yes = pullFlag(rest, "--yes") || pullFlag(rest, "-y");
      const noWait = pullFlag(rest, "--no-wait");
      const timeout = numVal(rest, "--timeout", 180) * 1000;
      const sel = rest[0];
      if (!sel || !to) die("usage: fleet switch <machine> --to <os> [--yes] [--no-wait] [--timeout S]");
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
      const json = pullFlag(rest, "--json");
      pullFlag(rest, "--ssh");
      const port = numVal(rest, "--port", 0, 0);        // 0 = flag absent
      const http = pullVal(rest, "--http");
      const status = numVal(rest, "--status", 0, 0);    // 0 = flag absent
      const boot = pullVal(rest, "--boot");
      const timeout = numVal(rest, "--timeout", 120) * 1000;
      const interval = numVal(rest, "--interval", 3) * 1000;
      const sel = rest[0];
      if (!sel) die("usage: fleet wait <host|machine> [--ssh | --port N | --http URL [--status N] | --boot OS] [--timeout S] [--interval S]");
      const cond: Parameters<typeof waitFor>[2] = { timeoutMs: timeout, intervalMs: interval };
      if (boot) cond.boot = boot;
      else if (http) { cond.http = http; if (status) cond.status = status; }
      else if (port) cond.port = port;
      else cond.ssh = true;
      const label = boot ? `boot=${boot}` : http ? `http ${http}` : port ? `:${port}` : "ssh";
      process.stdout.write(A.d(`◎ waiting for ${sel} ${label} (≤${timeout / 1000}s) …`));
      const r = await waitFor(cfg, sel, { ...cond, onTick: (d, ms) => process.stdout.write(A.d(`\r◎ ${sel} ${label}: ${d} ${Math.round(ms / 1000)}s   `)) });
      process.stdout.write("\r\x1b[K");
      if (json) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
      if (r.ok) console.log(`${A.g("●")} ${A.b(sel)} ${A.d(label + " ready")} ${A.d(`(${Math.round(r.elapsedMs / 1000)}s, ${r.attempts} tries)`)}`);
      else console.log(`${A.r("✗")} ${A.b(sel)} ${A.d(label + " not ready")} ${A.d(`after ${Math.round(r.elapsedMs / 1000)}s — last: ${r.lastDetail}`)}`);
      return r.ok ? 0 : 1;
    }

    case "run": {
      const name = rest[0] ?? die("usage: fleet run <recipe>");
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
      const json = pullFlag(rest, "--json");
      const noRestart = pullFlag(rest, "--no-restart");
      const restartSvc = pullVal(rest, "--restart");
      const sel = rest[0];
      if (!sel) die("usage: fleet deploy <sel> [--restart <svc> | --no-restart]");
      const restart = noRestart ? false : (restartSvc ?? true);
      console.log(A.d(`◎ building + shipping fleet → ${sel} …`));
      const results = await deployHosts(cfg, await routeSelector(cfg, sel!), { restart });
      if (json) { console.log(JSON.stringify(results, null, 2)); return results.some((r) => !r.ok) ? 1 : 0; }
      for (const r of results) {
        if (r.ok) console.log(`${A.g("●")} ${A.b(r.host)} ${A.d("→ " + r.result.stdout.split("\n").pop())}`);
        else { console.log(`${A.r("✗")} ${A.b(r.host)} ${A.d("deploy failed")}`); printResult(r.result); }
        for (const a of r.restarted ?? [])
          console.log(`  ${a.result.ok ? A.g("↻") : A.r("✗")} ${A.d("restarted " + a.service + " (" + a.type + ")")}`);
      }
      return results.some((r) => !r.ok) ? 1 : 0;
    }

    case "completion": {
      const shell = rest[0] ?? "bash";
      if (shell !== "bash" && shell !== "zsh") die("usage: fleet completion [bash|zsh]");
      console.log(completionScript(cfg, shell));
      return 0;
    }

    case "doctor": {
      const json = pullFlag(rest, "--json");
      const sel = rest[0];
      if (!sel) die("usage: fleet doctor <host>");
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
      const sel = rest[0];
      if (!sel) die("usage: fleet ssh <host>");
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

const [, , command, ...rest] = process.argv;
loadConfig()
  .then((cfg) => dispatch(command, rest, cfg))
  .then((code) => process.exit(code))
  .catch((e) => die(e.message));
