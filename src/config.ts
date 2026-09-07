/** Fleet config — loads fleet.config.json next to the package root. */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type OS = "linux" | "windows" | "mac";
export type ServiceType = "systemd" | "systemd-user" | "nssm" | "winservice" | "schtask";
export type WindowsShell = "pwsh" | "powershell";

export interface Service {
  type: ServiceType;
  name: string;
}
export interface Host {
  name: string;
  ssh: string;        // ssh alias / host (for daytona transport: the sandbox id/name token)
  os: OS;
  transport?: "ssh" | "daytona";  // default ssh; daytona hosts exec over the REST toolbox API
  gpu?: boolean;      // has an nvidia GPU → @gpu group
  wsl?: string;       // WSL distro for windows boxes
  winShell?: WindowsShell; // configured shell skips per-process auto-detection
  python?: string;
  services?: Record<string, Service>;
  health?: string;    // HTTP URL probed as a liveness fallback when ssh is down (ls/doctor)
  cdp?: string;       // Chrome DevTools Protocol endpoint used by `fleet browse`
  deploy?: DeployTarget;   // where `fleet deploy` ships the fleet source on this host
}
export interface DeployTarget {
  dir?: string;       // install dir (default: ~/fleet | %USERPROFILE%\fleet)
  bun?: string;       // bun binary path (default: bun on PATH, else ~/.bun/bin/bun)
  service?: string;   // configured service to restart after deploy (default: fleet-mcp if present)
}
export interface Boot {
  host: string;        // host-entry name (Tailscale-reachable)
  lan?: string;        // host-entry name for LAN fallback
}
export interface Machine {
  boots: Record<string, Boot>;       // keyed by OS label: "cachyos" | "windows" | …
  switch?: Record<string, string>;   // target-OS label -> command run on the LIVE boot
}
export interface Route {
  prefer: string[];                  // ordered host-entry names: preferred transport first
}
/** A CLI tool this fleet distributes to its boxes (`fleet tools`). The registry
 *  is deliberately about *shipping*, not about how the tool is built: a source
 *  root on the controller, an optional paired Agent Skill, and where it lands. */
export interface ToolSpec {
  root: string;         // source dir on the controller (~ expanded), e.g. ~/Development/tg
  skill?: string;       // SKILL.md path, relative to root (default: skills/<name>/SKILL.md if it exists)
  bin?: string;         // launcher name on PATH (default: the tool name)
  entry?: string;       // entrypoint the launcher runs, relative to the install dir (default: src/cli.ts)
  dir?: string;         // install dir on hosts (default: ~/<name> | %USERPROFILE%\<name>)
  hosts?: string;       // default selector for `fleet tools sync <name>` (default: none — must be explicit)
  exclude?: string[];   // portable glob exclusions on top of node_modules/.git/dist
}
export interface FleetConfig {
  $comment?: string;
  hosts: Record<string, Host>;
  machines?: Record<string, Machine>;    // dual-boot boxes: logical name -> its boots
  routes?: Record<string, Route>;         // one logical host with ordered LAN/TS/etc transports
  groups?: Record<string, string[]>;     // custom named groups
  recipes?: Record<string, string[]>;    // saved playbooks (fleet subcommand strings)
  tools?: Record<string, ToolSpec>;      // CLI tools this fleet ships to its boxes
  dashboard?: string;
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** The fleet repo root on the controller — the source `fleet deploy` ships. */
export const REPO_ROOT = ROOT;

const OSES = new Set<string>(["linux", "windows", "mac"]);
const SVC_TYPES = new Set<string>(["systemd", "systemd-user", "nssm", "winservice", "schtask"]);
const WIN_SHELLS = new Set<string>(["pwsh", "powershell"]);
const TRANSPORTS = new Set<string>(["ssh", "daytona"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural validation — fails fast at load with a precise message instead of
 *  a confusing mid-command error (or worse, a silently-shrunk fan-out). */
export function validateConfig(cfg: FleetConfig, path: string): void {
  const fail = (m: string): never => { throw new Error(`invalid config ${path}: ${m}`); };
  const record = (value: unknown, at: string): Record<string, unknown> => {
    if (!isRecord(value)) fail(`${at} must be an object`);
    return value as Record<string, unknown>;
  };
  const optionalRecord = (value: unknown, at: string): Record<string, unknown> =>
    value === undefined ? {} : record(value, at);
  const knownKeys = (value: Record<string, unknown>, allowed: readonly string[], at: string): void => {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length) fail(`${at}: unknown field${unknown.length === 1 ? "" : "s"} ${unknown.map((key) => `'${key}'`).join(", ")}`);
  };
  const stringIfPresent = (value: unknown, at: string): void => {
    if (value !== undefined && (typeof value !== "string" || !value))
      fail(`${at} must be a non-empty string`);
  };
  const boolIfPresent = (value: unknown, at: string): void => {
    if (value !== undefined && typeof value !== "boolean") fail(`${at} must be a boolean`);
  };
  const httpUrlIfPresent = (value: unknown, at: string): void => {
    stringIfPresent(value, at);
    if (value === undefined) return;
    let endpoint: URL;
    try { endpoint = new URL(value as string); }
    catch { fail(`${at} must be an absolute http(s) URL`); }
    if (endpoint!.protocol !== "http:" && endpoint!.protocol !== "https:")
      fail(`${at} must be an absolute http(s) URL`);
  };

  const root = record(cfg, "`config`");
  knownKeys(root, ["$comment", "hosts", "machines", "routes", "groups", "recipes", "tools", "dashboard"], "`config`");
  stringIfPresent(root["$comment"], "`config`.$comment");
  if (!isRecord(cfg.hosts) || !Object.keys(cfg.hosts).length)
    fail("`hosts` must be a non-empty object");
  httpUrlIfPresent(cfg.dashboard, "dashboard");
  for (const [name, rawHost] of Object.entries(cfg.hosts)) {
    const h = record(rawHost, `hosts.${name}`) as unknown as Host;
    knownKeys(h as unknown as Record<string, unknown>,
      ["name", "ssh", "os", "transport", "gpu", "wsl", "winShell", "python", "services", "health", "cdp", "deploy"],
      `hosts.${name}`);
    if (!h.ssh || typeof h.ssh !== "string") fail(`hosts.${name}: missing/invalid \`ssh\``);
    if (h.ssh.startsWith("-")) fail(`hosts.${name}.ssh must not begin with '-' (ssh would parse it as an option)`);
    if (!OSES.has(h.os)) fail(`hosts.${name}: os must be one of ${[...OSES].join("|")} (got '${h.os}')`);
    if (h.transport && !TRANSPORTS.has(h.transport))
      fail(`hosts.${name}: transport must be one of ${[...TRANSPORTS].join("|")} (got '${h.transport}')`);
    boolIfPresent(h.gpu, `hosts.${name}.gpu`);
    stringIfPresent(h.wsl, `hosts.${name}.wsl`);
    stringIfPresent(h.python, `hosts.${name}.python`);
    httpUrlIfPresent(h.health, `hosts.${name}.health`);
    httpUrlIfPresent(h.cdp, `hosts.${name}.cdp`);
    if (h.winShell && !WIN_SHELLS.has(h.winShell))
      fail(`hosts.${name}: winShell must be one of ${[...WIN_SHELLS].join("|")} (got '${h.winShell}')`);
    if (h.winShell && h.os !== "windows")
      fail(`hosts.${name}: winShell is only valid for windows hosts`);
    for (const [sn, rawService] of Object.entries(optionalRecord(h.services, `hosts.${name}.services`))) {
      const svc = record(rawService, `hosts.${name}.services.${sn}`) as unknown as Service;
      knownKeys(svc as unknown as Record<string, unknown>, ["type", "name"], `hosts.${name}.services.${sn}`);
      if (!svc?.name || typeof svc.name !== "string") fail(`hosts.${name}.services.${sn}: missing \`name\``);
      if (!SVC_TYPES.has(svc.type)) fail(`hosts.${name}.services.${sn}: type must be one of ${[...SVC_TYPES].join("|")} (got '${svc.type}')`);
      if ((svc.type === "systemd" || svc.type === "systemd-user") && h.os !== "linux")
        fail(`hosts.${name}.services.${sn}: ${svc.type} requires a linux host`);
      if ((svc.type === "nssm" || svc.type === "winservice" || svc.type === "schtask") && h.os !== "windows")
        fail(`hosts.${name}.services.${sn}: ${svc.type} requires a windows host`);
    }
    if (h.deploy !== undefined) {
      const deploy = record(h.deploy, `hosts.${name}.deploy`) as unknown as DeployTarget;
      knownKeys(deploy as unknown as Record<string, unknown>, ["dir", "bun", "service"], `hosts.${name}.deploy`);
      stringIfPresent(deploy.dir, `hosts.${name}.deploy.dir`);
      stringIfPresent(deploy.bun, `hosts.${name}.deploy.bun`);
      stringIfPresent(deploy.service, `hosts.${name}.deploy.service`);
      if (deploy.service && !h.services?.[deploy.service])
        fail(`hosts.${name}.deploy.service: unknown service '${deploy.service}' (have: ${Object.keys(h.services ?? {}).join(", ") || "none"})`);
    }
  }
  for (const [g, members] of Object.entries(optionalRecord(cfg.groups, "groups"))) {
    if (!Array.isArray(members)) fail(`groups.${g} must be an array of host names`);
    for (const m of members as unknown[]) {
      if (typeof m !== "string" || !m) fail(`groups.${g} must contain non-empty host names`);
      const member = m as string;
      if (!cfg.hosts[member])
        fail(`groups.${g}: unknown host '${member}' (have: ${Object.keys(cfg.hosts).join(", ")})`);
    }
  }
  for (const [mn, rawMachine] of Object.entries(optionalRecord(cfg.machines, "machines"))) {
    const m = record(rawMachine, `machines.${mn}`) as unknown as Machine;
    knownKeys(m as unknown as Record<string, unknown>, ["boots", "switch"], `machines.${mn}`);
    if (!isRecord(m.boots) || !Object.keys(m.boots).length) fail(`machines.${mn}: needs at least one boot`);
    for (const [os, rawBoot] of Object.entries(m.boots)) {
      const b = record(rawBoot, `machines.${mn}.boots.${os}`) as unknown as Boot;
      knownKeys(b as unknown as Record<string, unknown>, ["host", "lan"], `machines.${mn}.boots.${os}`);
      stringIfPresent(b.host, `machines.${mn}.boots.${os}.host`);
      if (!b.host) fail(`machines.${mn}.boots.${os}: missing host`);
      stringIfPresent(b.lan, `machines.${mn}.boots.${os}.lan`);
      if (!cfg.hosts[b.host]) fail(`machines.${mn}.boots.${os}: unknown host '${b.host}'`);
      if (b.lan && !cfg.hosts[b.lan]) fail(`machines.${mn}.boots.${os}: unknown lan host '${b.lan}'`);
    }
    for (const [target, command] of Object.entries(optionalRecord(m.switch, `machines.${mn}.switch`))) {
      if (!m.boots[target])
        fail(`machines.${mn}.switch.${target}: no such boot (have: ${Object.keys(m.boots).join(", ")})`);
      stringIfPresent(command, `machines.${mn}.switch.${target}`);
    }
  }
  for (const [rn, rawRoute] of Object.entries(optionalRecord(cfg.routes, "routes"))) {
    const route = record(rawRoute, `routes.${rn}`) as unknown as Route;
    knownKeys(route as unknown as Record<string, unknown>, ["prefer"], `routes.${rn}`);
    if (cfg.hosts[rn]) fail(`routes.${rn}: name conflicts with host '${rn}'`);
    if (cfg.machines?.[rn]) fail(`routes.${rn}: name conflicts with machine '${rn}'`);
    if (!Array.isArray(route.prefer) || !route.prefer.length)
      fail(`routes.${rn}.prefer must be a non-empty array of host names`);
    for (const name of route.prefer) if (!cfg.hosts[name])
      fail(`routes.${rn}: unknown host '${name}' (have: ${Object.keys(cfg.hosts).join(", ")})`);
    const oses = new Set(route.prefer.map((name) => cfg.hosts[name]!.os));
    if (oses.size !== 1) fail(`routes.${rn}: all transports must target the same OS`);
  }
  for (const [rn, steps] of Object.entries(optionalRecord(cfg.recipes, "recipes")))
    if (!Array.isArray(steps) || steps.some((s) => typeof s !== "string"))
      fail(`recipes.${rn} must be an array of step strings`);
  for (const [tn, rawTool] of Object.entries(optionalRecord(cfg.tools, "tools"))) {
    const tool = record(rawTool, `tools.${tn}`) as unknown as ToolSpec;
    knownKeys(tool as unknown as Record<string, unknown>,
      ["root", "skill", "bin", "entry", "dir", "hosts", "exclude"], `tools.${tn}`);
    if (!tool.root || typeof tool.root !== "string") fail(`tools.${tn}: missing/invalid \`root\``);
    for (const key of ["skill", "bin", "entry", "dir", "hosts"] as const)
      stringIfPresent(tool[key], `tools.${tn}.${key}`);
    if (tool.exclude !== undefined
      && (!Array.isArray(tool.exclude) || tool.exclude.some((e) => typeof e !== "string" || !e)))
      fail(`tools.${tn}.exclude must be an array of non-empty strings`);
  }
}

/**
 * Where to read fleet.config.json from.
 *
 * When running from source, ROOT is the repo and the config sits next to it.
 * In a `bun build --compile` binary, `import.meta.url` resolves inside the
 * embedded virtual filesystem, so ROOT becomes `/$bunfs` and the config is
 * unreachable — hence the fallbacks below. FLEET_CONFIG always wins.
 */
export async function resolveConfigPath(): Promise<string> {
  if (process.env.FLEET_CONFIG) return process.env.FLEET_CONFIG;
  const repoPath = join(ROOT, "fleet.config.json");
  const candidates = [
    repoPath,                                                   // source checkout
    join(ROOT, "fleet.config.example.json"),                    // safe public-clone fallback
    join(dirname(process.execPath), "fleet.config.json"),       // beside the binary
    join(homedir(), ".config", "fleet", "fleet.config.json"),   // XDG-ish
    join(homedir(), "fleet", "fleet.config.json"),              // deployed source tree
  ];
  for (const c of candidates) if (await Bun.file(c).exists()) return c;
  return repoPath; // keep the original not-found error message
}

export async function loadConfig(): Promise<FleetConfig> {
  const path = await resolveConfigPath();
  const raw = await Bun.file(path).json() as FleetConfig;
  validateConfig(raw, path);
  for (const [name, h] of Object.entries(raw.hosts)) h.name = name;
  return raw;
}

function groupHosts(cfg: FleetConfig, g: string): Host[] {
  if (g === "linux" || g === "windows" || g === "mac")
    return Object.values(cfg.hosts).filter((h) => h.os === g);
  if (g === "gpu") return Object.values(cfg.hosts).filter((h) => h.gpu);
  const named = cfg.groups?.[g];
  if (named) return named.map((n) => {
    const h = cfg.hosts[n];
    // loud, not silent: a typo'd member must not shrink a fan-out (reboot @group!)
    if (!h) throw new Error(`group @${g} references unknown host '${n}' (have: ${Object.keys(cfg.hosts).join(", ")})`);
    return h;
  });
  throw new Error(`unknown group @${g} (built-in: @linux @windows @mac @gpu; custom: ${Object.keys(cfg.groups ?? {}).join(", ") || "none"})`);
}

/** Expand a selector: comma list of hostnames | @groups | all | dt:<sandbox>.
 *  Dedupes, keeps order. `dt:` tokens synthesize an ephemeral Daytona host —
 *  no config entry, no API call here; the token resolves lazily at exec time. */
export function resolveHosts(cfg: FleetConfig, sel: string): Host[] {
  const set = new Map<string, Host>();
  for (const t of sel.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (t.startsWith("dt:")) {
      const token = t.slice(3);
      if (!token) throw new Error("dt: selector needs a sandbox id/name (try `fleet dt` to list)");
      set.set(t, { name: t, ssh: token, os: "linux", transport: "daytona" });
      continue;
    }
    if (t === "all" || t === "*") {
      Object.values(cfg.hosts).forEach((h) => set.set(h.name, h));
    } else if (t.startsWith("@")) {
      groupHosts(cfg, t.slice(1)).forEach((h) => set.set(h.name, h));
    } else {
      const h = cfg.hosts[t];
      // A selector starting with '-' is never a host name — it's a flag that
      // landed after <sel>. Flags are parsed from LEADING tokens only (so that
      // a --json inside the remote command is passed through verbatim), which
      // makes this a easy mistake with a previously baffling error.
      if (!h && t === "--shell")
        throw new Error(`there is no --shell flag; use --wsl for a bash command on a Windows host`);
      if (!h && t.startsWith("-"))
        throw new Error(`'${t}' looks like a flag, not a host — flags must come BEFORE the host selector (e.g. \`fleet exec ${t} <host> <cmd…>\`)`);
      if (!h) throw new Error(`unknown host: ${t} (have: ${Object.keys(cfg.hosts).join(", ")})`);
      set.set(t, h);
    }
  }
  if (set.size === 0) throw new Error(`no hosts matched: ${sel}`);
  return [...set.values()];
}
