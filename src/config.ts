/** Fleet config — loads fleet.config.json next to the package root. */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
export interface FleetConfig {
  hosts: Record<string, Host>;
  machines?: Record<string, Machine>;    // dual-boot boxes: logical name -> its boots
  routes?: Record<string, Route>;         // one logical host with ordered LAN/TS/etc transports
  groups?: Record<string, string[]>;     // custom named groups
  recipes?: Record<string, string[]>;    // saved playbooks (fleet subcommand strings)
  dashboard?: string;
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** The fleet repo root on the controller — the source `fleet deploy` ships. */
export const REPO_ROOT = ROOT;

const OSES = new Set<string>(["linux", "windows", "mac"]);
const SVC_TYPES = new Set<string>(["systemd", "systemd-user", "nssm", "winservice", "schtask"]);
const WIN_SHELLS = new Set<string>(["pwsh", "powershell"]);

/** Structural validation — fails fast at load with a precise message instead of
 *  a confusing mid-command error (or worse, a silently-shrunk fan-out). */
export function validateConfig(cfg: FleetConfig, path: string): void {
  const fail = (m: string): never => { throw new Error(`invalid config ${path}: ${m}`); };
  if (!cfg.hosts || typeof cfg.hosts !== "object" || !Object.keys(cfg.hosts).length)
    fail("`hosts` must be a non-empty object");
  for (const [name, h] of Object.entries(cfg.hosts)) {
    if (!h.ssh || typeof h.ssh !== "string") fail(`hosts.${name}: missing/invalid \`ssh\``);
    if (!OSES.has(h.os)) fail(`hosts.${name}: os must be one of ${[...OSES].join("|")} (got '${h.os}')`);
    if (h.winShell && !WIN_SHELLS.has(h.winShell))
      fail(`hosts.${name}: winShell must be one of ${[...WIN_SHELLS].join("|")} (got '${h.winShell}')`);
    if (h.winShell && h.os !== "windows")
      fail(`hosts.${name}: winShell is only valid for windows hosts`);
    for (const [sn, svc] of Object.entries(h.services ?? {})) {
      if (!svc?.name || typeof svc.name !== "string") fail(`hosts.${name}.services.${sn}: missing \`name\``);
      if (!SVC_TYPES.has(svc.type)) fail(`hosts.${name}.services.${sn}: type must be one of ${[...SVC_TYPES].join("|")} (got '${svc.type}')`);
    }
  }
  for (const [g, members] of Object.entries(cfg.groups ?? {})) {
    if (!Array.isArray(members)) fail(`groups.${g} must be an array of host names`);
    for (const m of members) if (!cfg.hosts[m])
      fail(`groups.${g}: unknown host '${m}' (have: ${Object.keys(cfg.hosts).join(", ")})`);
  }
  for (const [mn, m] of Object.entries(cfg.machines ?? {})) {
    if (!m.boots || !Object.keys(m.boots).length) fail(`machines.${mn}: needs at least one boot`);
    for (const [os, b] of Object.entries(m.boots)) {
      if (!cfg.hosts[b.host]) fail(`machines.${mn}.boots.${os}: unknown host '${b.host}'`);
      if (b.lan && !cfg.hosts[b.lan]) fail(`machines.${mn}.boots.${os}: unknown lan host '${b.lan}'`);
    }
    for (const t of Object.keys(m.switch ?? {})) if (!m.boots[t])
      fail(`machines.${mn}.switch.${t}: no such boot (have: ${Object.keys(m.boots).join(", ")})`);
  }
  for (const [rn, route] of Object.entries(cfg.routes ?? {})) {
    if (cfg.hosts[rn]) fail(`routes.${rn}: name conflicts with host '${rn}'`);
    if (cfg.machines?.[rn]) fail(`routes.${rn}: name conflicts with machine '${rn}'`);
    if (!Array.isArray(route.prefer) || !route.prefer.length)
      fail(`routes.${rn}.prefer must be a non-empty array of host names`);
    for (const name of route.prefer) if (!cfg.hosts[name])
      fail(`routes.${rn}: unknown host '${name}' (have: ${Object.keys(cfg.hosts).join(", ")})`);
    const oses = new Set(route.prefer.map((name) => cfg.hosts[name]!.os));
    if (oses.size !== 1) fail(`routes.${rn}: all transports must target the same OS`);
  }
  for (const [rn, steps] of Object.entries(cfg.recipes ?? {}))
    if (!Array.isArray(steps) || steps.some((s) => typeof s !== "string"))
      fail(`recipes.${rn} must be an array of step strings`);
}

export async function loadConfig(): Promise<FleetConfig> {
  // FLEET_CONFIG wins; otherwise use a private local config when present and
  // fall back to the shipped, sanitized example for a fresh public clone.
  let path = process.env.FLEET_CONFIG ?? join(ROOT, "fleet.config.json");
  if (!process.env.FLEET_CONFIG && !(await Bun.file(path).exists()))
    path = join(ROOT, "fleet.config.example.json");
  const raw = await Bun.file(path).json() as FleetConfig;
  for (const [name, h] of Object.entries(raw.hosts ?? {})) h.name = name;
  validateConfig(raw, path);
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
      if (!h) throw new Error(`unknown host: ${t} (have: ${Object.keys(cfg.hosts).join(", ")})`);
      set.set(t, h);
    }
  }
  if (set.size === 0) throw new Error(`no hosts matched: ${sel}`);
  return [...set.values()];
}
