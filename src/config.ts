/** Fleet config — loads fleet.config.json next to the package root. */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type OS = "linux" | "windows" | "mac";
export type ServiceType = "systemd" | "nssm" | "winservice" | "schtask";

export interface Service {
  type: ServiceType;
  name: string;
}
export interface Host {
  name: string;
  ssh: string;        // ssh alias / host
  os: OS;
  gpu?: boolean;      // has an nvidia GPU → @gpu group
  wsl?: string;       // WSL distro for windows boxes
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
export interface FleetConfig {
  hosts: Record<string, Host>;
  machines?: Record<string, Machine>;    // dual-boot boxes: logical name -> its boots
  groups?: Record<string, string[]>;     // custom named groups
  recipes?: Record<string, string[]>;    // saved playbooks (fleet subcommand strings)
  dashboard?: string;
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** The fleet repo root on the controller — the source `fleet deploy` ships. */
export const REPO_ROOT = ROOT;

const OSES = new Set<string>(["linux", "windows", "mac"]);
const SVC_TYPES = new Set<string>(["systemd", "nssm", "winservice", "schtask"]);

/** Structural validation — fails fast at load with a precise message instead of
 *  a confusing mid-command error (or worse, a silently-shrunk fan-out). */
export function validateConfig(cfg: FleetConfig, path: string): void {
  const fail = (m: string): never => { throw new Error(`invalid config ${path}: ${m}`); };
  if (!cfg.hosts || typeof cfg.hosts !== "object" || !Object.keys(cfg.hosts).length)
    fail("`hosts` must be a non-empty object");
  for (const [name, h] of Object.entries(cfg.hosts)) {
    if (!h.ssh || typeof h.ssh !== "string") fail(`hosts.${name}: missing/invalid \`ssh\``);
    if (!OSES.has(h.os)) fail(`hosts.${name}: os must be one of ${[...OSES].join("|")} (got '${h.os}')`);
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
  for (const [rn, steps] of Object.entries(cfg.recipes ?? {}))
    if (!Array.isArray(steps) || steps.some((s) => typeof s !== "string"))
      fail(`recipes.${rn} must be an array of step strings`);
}

export async function loadConfig(): Promise<FleetConfig> {
  // FLEET_CONFIG wins; else fleet.config.json; else fall back to the shipped
  // example so a fresh clone runs (copy the example to fleet.config.json to edit).
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

/** Expand a selector: comma list of hostnames | @groups | all. Dedupes, keeps order. */
export function resolveHosts(cfg: FleetConfig, sel: string): Host[] {
  const set = new Map<string, Host>();
  for (const t of sel.split(",").map((s) => s.trim()).filter(Boolean)) {
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
