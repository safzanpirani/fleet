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
  proxy?: string;     // `proxies` entry name, or an inline URL (socks5h://user:pass@host:1080)
}
/** How `fleet doctor` proves a proxy actually changes the egress IP. */
export interface ProxyVerify {
  url: string;        // http(s) URL fetched THROUGH the proxy
  expect?: string;    // the exit IP the response body must contain
}
/** A proxy every transport to a host is routed through. Credentials never live
 *  in the ssh command line: the `ProxyCommand` carries only the proxy NAME and
 *  `fleet __proxy-connect` reads the secret from passwordEnv/passwordFile. */
export interface ProxySpec {
  type?: ProxyType;   // default socks5
  host: string;
  port: number;
  user?: string;
  passwordEnv?: string;   // env var holding the password
  passwordFile?: string;  // ~-expanded file holding the password (first line)
  password?: string;      // inline-URL only; never a config field (validation rejects it)
  dns?: "local" | "remote";  // default remote — the proxy resolves the target, no local leak
  verify?: ProxyVerify;
}
export type ProxyType = "socks5" | "socks5h" | "http";

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
/** A CLI tool this fleet distributes to its boxes (`fleet tools`). */
export interface ToolSpec {
  root: string;         // source dir on the controller (~ expanded), e.g. ~/Development/tg
  skill?: string;       // SKILL.md path, relative to root (default: skills/<name>/SKILL.md if it exists)
  bin?: string;         // launcher name on PATH (default: the tool name)
  entry?: string;       // entrypoint the launcher runs, relative to the install dir (default: src/cli.ts)
  compile?: boolean;    // build a native Bun executable on Linux/macOS before replacing the launcher
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
  proxies?: Record<string, ProxySpec>;   // named proxies hosts can be routed through
  defaultProxy?: string;                 // applies to every host with no `proxy` of its own
  dashboard?: string;
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** The fleet repo root on the controller — the source `fleet deploy` ships. */
export const REPO_ROOT = ROOT;

const OSES = new Set<string>(["linux", "windows", "mac"]);
const SVC_TYPES = new Set<string>(["systemd", "systemd-user", "nssm", "winservice", "schtask"]);
const WIN_SHELLS = new Set<string>(["pwsh", "powershell"]);
const TRANSPORTS = new Set<string>(["ssh", "daytona"]);
const PROXY_TYPES = new Set<string>(["socks5", "socks5h", "http"]);
const PROXY_DNS = new Set<string>(["local", "remote"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


// ── proxies ──────────────────────────────────────────────────────────────────
// A host with a `proxy` is reachable ONLY through that proxy: every transport
// (exec, spawn, cp, edit, interactive ssh, probe, doctor) gets the same
// `-o ProxyCommand=…`. Resolution is deliberately overridable at three levels so
// a wedged proxy never locks you out of your own fleet.

/** A proxy plus the label it is reported under. `name` is a `proxies` key, or
 *  the redacted URL for an inline spec. */
export interface ResolvedProxy {
  name: string;   // display label: the `proxies` key, or the REDACTED inline URL
  ref: string;    // the literal reference to hand a child process (name or URL)
  spec: ProxySpec;
}

/** Hide `user:pass@` in anything that may reach a log, an error, or --json. */
export function redactProxy(text: string): string {
  return text.replace(/(\b[a-z0-9+.-]+:\/\/)([^/@\s]*:)[^/@\s]*@/gi, "$1$2***@");
}

/** Parse the convenience inline form, e.g. `socks5h://user:pass@host:1080`.
 *  Documented as convenience only — the password lands in fleet.config.json. */
export function parseProxyUrl(url: string): ProxySpec {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`not a valid proxy URL: ${redactProxy(url)}`); }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (!PROXY_TYPES.has(scheme))
    throw new Error(`proxy URL scheme must be one of ${[...PROXY_TYPES].join("|")} (got '${scheme}')`);
  if (!u.hostname) throw new Error(`proxy URL has no host: ${redactProxy(url)}`);
  const port = u.port ? Number(u.port) : (scheme === "http" ? 8080 : 1080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`proxy URL port must be 1-65535 (got '${u.port}')`);
  const spec: ProxySpec = { type: scheme as ProxyType, host: u.hostname, port };
  if (u.username) spec.user = decodeURIComponent(u.username);
  if (u.password) spec.password = decodeURIComponent(u.password);
  // `#passwordEnv=NAME` is how fleet hands an inline URL's password to its own
  // ProxyCommand without writing it into argv (see proxyOpts).
  const fromEnv = /^#passwordEnv=([A-Z0-9_]+)$/.exec(u.hash)?.[1];
  if (fromEnv && !u.password) spec.passwordEnv = fromEnv;
  return spec;
}

/** `socks5h` is shorthand for socks5 + remote DNS; normalise it away so the
 *  transport only ever sees `socks5` | `http` plus an explicit `dns`. */
export function normalizeProxy(spec: ProxySpec): Required<Pick<ProxySpec, "type" | "dns">> & ProxySpec {
  const socks5h = spec.type === "socks5h";
  return {
    ...spec,
    type: socks5h ? "socks5" : (spec.type ?? "socks5"),
    dns: spec.dns ?? "remote",
  };
}

/** Stable identity of a route — what makes two proxies "the same connection" for
 *  ControlPath purposes. Credentials are excluded deliberately: they change the
 *  auth, not the path, and must never reach a socket name. */
export function proxyIdentity(spec: ProxySpec): string {
  const n = normalizeProxy(spec);
  return `${n.type}://${n.user ?? ""}@${n.host}:${n.port}/${n.dns}`;
}

/** The config the running process resolves proxies against. Set once by
 *  `loadConfig`, so the transport layer can stay a pure `Host`-in function. */
let _activeConfig: FleetConfig | null = null;
export function setActiveConfig(cfg: FleetConfig | null): void { _activeConfig = cfg; }
export function activeConfig(): FleetConfig | null { return _activeConfig; }

/** Look up a proxy reference (a `proxies` key or an inline URL). */
export function lookupProxy(ref: string, cfg: FleetConfig | null = _activeConfig): ResolvedProxy {
  if (ref.includes("://")) return { name: redactProxy(ref), ref, spec: parseProxyUrl(ref) };
  const spec = cfg?.proxies?.[ref];
  if (!spec) throw new Error(`unknown proxy '${ref}' (have: ${Object.keys(cfg?.proxies ?? {}).join(", ") || "none"})`);
  return { name: ref, ref, spec };
}

/**
 * Which proxy (if any) a connection to `host` goes through. First match wins:
 *   1. FLEET_PROXY_OVERRIDE — set by `--proxy` (beats the kill switch on purpose)
 *   2. FLEET_NO_PROXY=1     — global kill switch, also set by `--no-proxy`
 *   3. FLEET_PROXY          — env default
 *   4. hosts.<h>.proxy
 *   5. defaultProxy
 *   6. none — exactly today's behaviour
 */
export function resolveProxy(
  host: Pick<Host, "proxy" | "transport">,
  cfg: FleetConfig | null = _activeConfig,
  env: Record<string, string | undefined> = process.env,
): ResolvedProxy | null {
  if (host.transport === "daytona") return null;   // HTTP transport; §5 says warn-and-ignore
  const override = env.FLEET_PROXY_OVERRIDE;
  if (override) return lookupProxy(override, cfg);
  if (env.FLEET_NO_PROXY === "1") return null;
  const ref = env.FLEET_PROXY || host.proxy || cfg?.defaultProxy;
  return ref ? lookupProxy(ref, cfg) : null;
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
  knownKeys(root, ["$comment", "hosts", "machines", "routes", "groups", "recipes", "tools", "proxies", "defaultProxy", "dashboard"], "`config`");
  stringIfPresent(root["$comment"], "`config`.$comment");
  if (!isRecord(cfg.hosts) || !Object.keys(cfg.hosts).length)
    fail("`hosts` must be a non-empty object");
  httpUrlIfPresent(cfg.dashboard, "dashboard");
  for (const [pn, rawProxy] of Object.entries(optionalRecord(cfg.proxies, "proxies"))) {
    const px = record(rawProxy, `proxies.${pn}`) as unknown as ProxySpec;
    knownKeys(px as unknown as Record<string, unknown>,
      ["type", "host", "port", "user", "passwordEnv", "passwordFile", "dns", "verify"], `proxies.${pn}`);
    if (px.type !== undefined && !PROXY_TYPES.has(px.type))
      fail(`proxies.${pn}: type must be one of ${[...PROXY_TYPES].join("|")} (got '${px.type}')`);
    if (!px.host || typeof px.host !== "string") fail(`proxies.${pn}: missing/invalid \`host\``);
    if (!Number.isInteger(px.port) || px.port < 1 || px.port > 65535)
      fail(`proxies.${pn}.port must be an integer 1-65535 (got '${px.port}')`);
    stringIfPresent(px.user, `proxies.${pn}.user`);
    stringIfPresent(px.passwordEnv, `proxies.${pn}.passwordEnv`);
    stringIfPresent(px.passwordFile, `proxies.${pn}.passwordFile`);
    if (px.passwordEnv && px.passwordFile)
      fail(`proxies.${pn}: set at most one of passwordEnv / passwordFile`);
    if (px.dns !== undefined && !PROXY_DNS.has(px.dns))
      fail(`proxies.${pn}.dns must be one of ${[...PROXY_DNS].join("|")} (got '${px.dns}')`);
    if (px.verify !== undefined) {
      const v = record(px.verify, `proxies.${pn}.verify`) as unknown as ProxyVerify;
      knownKeys(v as unknown as Record<string, unknown>, ["url", "expect"], `proxies.${pn}.verify`);
      if (!v.url) fail(`proxies.${pn}.verify: missing \`url\``);
      httpUrlIfPresent(v.url, `proxies.${pn}.verify.url`);
      stringIfPresent(v.expect, `proxies.${pn}.verify.expect`);
    }
  }
  const proxyNames = Object.keys(cfg.proxies ?? {});
  /** A bare word must name a `proxies` entry; anything with a scheme is an inline URL. */
  const checkProxyRef = (ref: unknown, at: string): void => {
    stringIfPresent(ref, at);
    if (ref === undefined) return;
    const value = ref as string;
    if (value.includes("://")) {
      try { parseProxyUrl(value); }
      catch (e) { fail(`${at}: ${redactProxy((e as Error).message)}`); }
      return;
    }
    if (!proxyNames.includes(value))
      fail(`${at} references unknown proxy '${value}' (have: ${proxyNames.join(", ") || "none"})`);
  };
  checkProxyRef(cfg.defaultProxy, "defaultProxy");
  for (const [name, rawHost] of Object.entries(cfg.hosts)) {
    const h = record(rawHost, `hosts.${name}`) as unknown as Host;
    knownKeys(h as unknown as Record<string, unknown>,
      ["name", "ssh", "os", "transport", "gpu", "wsl", "winShell", "python", "services", "health", "cdp", "deploy", "proxy"],
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
    checkProxyRef(h.proxy, `hosts.${name}.proxy`);
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
      ["root", "skill", "bin", "entry", "compile", "dir", "hosts", "exclude"], `tools.${tn}`);
    if (!tool.root || typeof tool.root !== "string") fail(`tools.${tn}: missing/invalid \`root\``);
    for (const key of ["skill", "bin", "entry", "dir", "hosts"] as const)
      stringIfPresent(tool[key], `tools.${tn}.${key}`);
    if (tool.compile !== undefined && typeof tool.compile !== "boolean")
      fail(`tools.${tn}.compile must be a boolean`);
    if (tool.exclude !== undefined
      && (!Array.isArray(tool.exclude) || tool.exclude.some((e) => typeof e !== "string" || !e)))
      fail(`tools.${tn}.exclude must be an array of non-empty strings`);
  }
}

/** Bun's embedded filesystem prefix. `import.meta.url` resolves inside it in a
 *  `bun build --compile` binary, so ROOT becomes `/$bunfs` there — a path that
 *  exists only inside the executable and can never be created by a user. */
const BUNFS = "/$bunfs";

/**
 * Every place fleet looks for a config, in order. `FLEET_CONFIG` wins over all
 * of them.
 *
 * When running from source, ROOT is the repo and the config sits next to it.
 * In a compiled binary ROOT is inside `BUNFS` and unreachable — hence the
 * fallbacks. Exported so a not-found error can say where it actually searched.
 */
export function configSearchPaths(): string[] {
  if (process.env.FLEET_CONFIG) return [process.env.FLEET_CONFIG];
  return [
    join(ROOT, "fleet.config.json"),                            // source checkout
    join(ROOT, "fleet.config.example.json"),                    // safe public-clone fallback
    join(dirname(process.execPath), "fleet.config.json"),       // beside the binary
    join(homedir(), ".config", "fleet", "fleet.config.json"),   // XDG-ish
    join(homedir(), "fleet", "fleet.config.json"),              // deployed source tree
  ];
}

export async function resolveConfigPath(): Promise<string> {
  const candidates = configSearchPaths();
  for (const c of candidates) if (await Bun.file(c).exists()) return c;
  return candidates[0]!; // not found — loadConfig turns this into a real message
}

/** What to tell someone who has no config. The bare ENOENT this replaces named
 *  `/$bunfs/fleet.config.json` for a compiled binary: a path inside the
 *  executable that the reader cannot inspect, create, or act on at all. */
export function configNotFoundMessage(paths = configSearchPaths()): string {
  if (process.env.FLEET_CONFIG)
    return `FLEET_CONFIG points at ${paths[0]}, which does not exist`;
  // A BUNFS path is not somewhere anyone can put a file, so offering it as a
  // location would be worse than saying nothing.
  const usable = paths.filter((p) => !p.startsWith(BUNFS));
  return [
    "no fleet config found — set FLEET_CONFIG=/path/to/fleet.config.json,"
      + ` or create one at${usable.length > 1 ? " any of" : ""}:`,
    ...usable.map((p) => `  ${p}`),
  ].join("\n");
}

export async function loadConfig(): Promise<FleetConfig> {
  const path = await resolveConfigPath();
  if (!await Bun.file(path).exists()) throw new Error(configNotFoundMessage());
  const raw = await Bun.file(path).json() as FleetConfig;
  validateConfig(raw, path);
  for (const [name, h] of Object.entries(raw.hosts)) h.name = name;
  setActiveConfig(raw);
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
