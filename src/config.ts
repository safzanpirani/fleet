/** Fleet config — loads fleet.config.json next to the package root. */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { didYouMean } from "./suggest.ts";

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
  android?: AndroidSpec;   // `fleet cu` drives an Android phone through adb inside Termux on this host
  hostKeyAlias?: string;   // known_hosts name for this host's key; required when boots share an address
  sudo?: SudoSpec;         // where `--sudo` finds the password when sudo asks for one
  disable?: HostFeature[]; // fleet commands refused on this host (on top of the top-level `disable`)
  enable?: HostFeature[];  // features re-allowed on this host although the top-level `disable` lists them
  settings?: HostSettings; // per-host overrides of the top-level `defaults`
}
/** Command families a host can refuse. Each names the fleet commands it covers;
 *  internal ssh use by other commands is not gated. */
export const HOST_FEATURES = [
  "webcam",   // fleet webcam
  "cu",       // fleet cu (desktop and Android, perception, record)
  "shot",     // fleet shot, MCP screenshot
  "browse",   // fleet browse
  "exec",     // fleet exec, spawn, watch, ssh, exec --script, MCP exec
  "files",    // fleet cp/push/pull, edit, diff
  "power",    // fleet reboot, bios, switch
  "kill",     // fleet kill
  "restart",  // fleet restart
  "deploy",   // fleet deploy, tools sync, skills sync
] as const;
export type HostFeature = (typeof HOST_FEATURES)[number];
/** Capture defaults for `fleet shot` and the MCP screenshot tool. */
export interface CaptureSettings {
  output?: string;          // default --output (connector, main, focused, or 1-based index)
  region?: string;          // default --region
  format?: "webp" | "png";  // local image format
  gridStep?: number;        // default --grid-step
}
/** Knobs that may differ per host. Precedence: env var > hosts.<h>.settings > defaults > built-in. */
export interface HostSettings {
  execTimeoutS?: number;    // FLEET_EXEC_TIMEOUT; 0 = no deadline
  probeTimeoutMs?: number;  // FLEET_PROBE_TIMEOUT_MS
  doneGraceMs?: number;     // FLEET_DONE_GRACE_MS
  winSessionIdleS?: number; // FLEET_WIN_SESSION_IDLE_S (Windows hosts only)
  sshMux?: "on" | "off" | "config"; // FLEET_NO_SSH_MUX=1 → off, FLEET_SSH_MUX=config → config
  sshPersist?: string;      // FLEET_SSH_PERSIST, an ssh ControlPersist value
  shot?: CaptureSettings;
  webcam?: { device?: string };
}
/** Global knobs. Host-level `settings` override every HostSettings field. */
export interface FleetDefaults extends HostSettings {
  routeGraceMs?: number;    // ROUTE_GRACE_MS: head start of one route transport before the next probe starts
  parallel?: {
    exec?: number;          // max hosts one exec/spawn fan-out runs at once (default: all)
    toolSync?: number;      // tools sync --all pool (default 2)
    toolStatusHosts?: number; // tools/skills status host reads at once (default 8)
  };
}
/** One named skill set `fleet skills sync` pushes from the controller. */
export interface SkillSetSpec {
  hosts: string;            // selector the set ships to
  include: string[];        // skill directory names or globs under root ("*" = all)
  exclude?: string[];       // names or globs removed after include
  root?: string;            // controller skill root (default ~/.agents/skills)
}
/** The sudo password for `--sudo`, read on the controller and sent over ssh
 *  stdin. It never reaches an argv or a log. */
export interface SudoSpec {
  passwordEnv?: string;   // env var holding the password
  passwordFile?: string;  // ~-expanded file holding the password (first line)
}
/** A phone reached over SSH into Termux, whose own adb client drives the phone's
 *  adbd (legacy `adb tcpip` mode, so it keeps listening off Wi-Fi). */
export interface AndroidSpec {
  serial?: string;    // adb serial Termux uses; default 127.0.0.1:5555
  shotWidth?: number; // default screenshot width in pixels (smaller for a slow route)
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
  firmware?: string;   // UEFI boot entry description; `switch` looks it up by this label at switch time
}
/** A switch command: one string for every source boot, or one per source boot. */
export type SwitchCommand = string | Record<string, string>;
export interface Machine {
  boots: Record<string, Boot>;       // keyed by OS label: "cachyos" | "windows" | …
  switch?: Record<string, SwitchCommand>;   // target-OS label -> command run on the LIVE boot
  mac?: string;                      // NIC MAC address; `fleet find` looks it up in the ARP table
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
  skills?: Record<string, SkillSetSpec>; // agent skill sets `fleet skills sync` ships to its boxes
  disable?: HostFeature[];               // features refused on every host unless a host `enable`s them
  defaults?: FleetDefaults;              // global knobs; hosts.<h>.settings override them
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

// ── features and settings ────────────────────────────────────────────────────

/** Whether fleet may run `feature` on `host`: the host's own `disable` refuses,
 *  its `enable` allows, and otherwise the top-level `disable` decides. */
export function featureEnabled(host: Pick<Host, "disable" | "enable">, feature: HostFeature, cfg: FleetConfig | null = _activeConfig): boolean {
  if (host.disable?.includes(feature)) return false;
  if (host.enable?.includes(feature)) return true;
  return !cfg?.disable?.includes(feature);
}

/** Refuse the whole call when any selected host disables `feature`, before
 *  anything reaches a host. Throws one error naming every refusing host. */
export function assertFeature(hosts: readonly Pick<Host, "name" | "disable" | "enable">[], feature: HostFeature, cfg: FleetConfig | null = _activeConfig): void {
  const refused = hosts.filter((host) => !featureEnabled(host, feature, cfg)).map((host) => host.name);
  if (!refused.length) return;
  throw new Error(`${feature} is disabled on ${refused.join(", ")} by the fleet config `
    + `(hosts.<host>.disable, or the top-level disable without a hosts.<host>.enable)`);
}

type ScalarSetting = Exclude<keyof HostSettings, "shot" | "webcam">;
/** A host's value for one knob: hosts.<h>.settings, then defaults. Env vars are
 *  checked by the caller first, because each knob has its own variable. */
export function hostSetting<K extends ScalarSetting>(host: Pick<Host, "settings"> | undefined, key: K, cfg: FleetConfig | null = _activeConfig): HostSettings[K] {
  return host?.settings?.[key] ?? cfg?.defaults?.[key];
}
/** One `fleet shot` capture default, merged field by field. */
export function captureSetting<K extends keyof CaptureSettings>(host: Pick<Host, "settings"> | undefined, key: K, cfg: FleetConfig | null = _activeConfig): CaptureSettings[K] {
  return host?.settings?.shot?.[key] ?? cfg?.defaults?.shot?.[key];
}
/** The default `fleet webcam` device for a host. */
export function webcamDevice(host: Pick<Host, "settings"> | undefined, cfg: FleetConfig | null = _activeConfig): string | undefined {
  return host?.settings?.webcam?.device ?? cfg?.defaults?.webcam?.device;
}

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
  knownKeys(root, ["$comment", "hosts", "machines", "routes", "groups", "recipes", "tools", "skills", "disable", "defaults", "proxies", "defaultProxy", "dashboard"], "`config`");
  stringIfPresent(root["$comment"], "`config`.$comment");
  if (!isRecord(cfg.hosts) || !Object.keys(cfg.hosts).length)
    fail("`hosts` must be a non-empty object");
  httpUrlIfPresent(cfg.dashboard, "dashboard");
  const featureList = (value: unknown, at: string): void => {
    if (value === undefined) return;
    if (!Array.isArray(value)) fail(`${at} must be an array of feature names (${HOST_FEATURES.join(", ")})`);
    const seen = new Set<string>();
    for (const f of value as unknown[]) {
      if (typeof f !== "string" || !(HOST_FEATURES as readonly string[]).includes(f))
        fail(`${at}: unknown feature '${String(f)}' (have: ${HOST_FEATURES.join(", ")})${typeof f === "string" ? didYouMean(f, [...HOST_FEATURES]) : ""}`);
      if (seen.has(f as string)) fail(`${at} lists '${f}' twice`);
      seen.add(f as string);
    }
  };
  const intIfPresent = (value: unknown, at: string, min: number, max = Number.MAX_SAFE_INTEGER): void => {
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < min || (value as number) > max))
      fail(`${at} must be an integer from ${min}${max === Number.MAX_SAFE_INTEGER ? " up" : ` to ${max}`} (got '${String(value)}')`);
  };
  const SETTING_KEYS = ["execTimeoutS", "probeTimeoutMs", "doneGraceMs", "winSessionIdleS", "sshMux", "sshPersist", "shot", "webcam"] as const;
  const checkSettings = (raw: Record<string, unknown>, at: string, extra: readonly string[] = []): void => {
    knownKeys(raw, [...SETTING_KEYS, ...extra], at);
    const s = raw as HostSettings;
    intIfPresent(s.execTimeoutS, `${at}.execTimeoutS`, 0);
    intIfPresent(s.probeTimeoutMs, `${at}.probeTimeoutMs`, 100);
    intIfPresent(s.doneGraceMs, `${at}.doneGraceMs`, 0);
    intIfPresent(s.winSessionIdleS, `${at}.winSessionIdleS`, 10);
    if (s.sshMux !== undefined && !["on", "off", "config"].includes(s.sshMux))
      fail(`${at}.sshMux must be one of on|off|config (got '${String(s.sshMux)}')`);
    stringIfPresent(s.sshPersist, `${at}.sshPersist`);
    if (s.sshPersist !== undefined && !/^(?:yes|no|\d+[smhdw]?)$/i.test(s.sshPersist))
      fail(`${at}.sshPersist must be an ssh ControlPersist value like 60s, 30m or no (got '${s.sshPersist}')`);
    if (s.shot !== undefined) {
      const shot = record(s.shot, `${at}.shot`) as CaptureSettings;
      knownKeys(shot as Record<string, unknown>, ["output", "region", "format", "gridStep"], `${at}.shot`);
      stringIfPresent(shot.output, `${at}.shot.output`);
      stringIfPresent(shot.region, `${at}.shot.region`);
      if (shot.format !== undefined && shot.format !== "webp" && shot.format !== "png")
        fail(`${at}.shot.format must be webp or png (got '${String(shot.format)}')`);
      intIfPresent(shot.gridStep, `${at}.shot.gridStep`, 10, 10000);
    }
    if (s.webcam !== undefined) {
      const webcam = record(s.webcam, `${at}.webcam`);
      knownKeys(webcam, ["device"], `${at}.webcam`);
      stringIfPresent(webcam.device, `${at}.webcam.device`);
    }
  };
  featureList(cfg.disable, "disable");
  if (cfg.defaults !== undefined) {
    const d = record(cfg.defaults, "defaults");
    checkSettings(d, "defaults", ["routeGraceMs", "parallel"]);
    intIfPresent(d.routeGraceMs, "defaults.routeGraceMs", 0);
    if (d.parallel !== undefined) {
      const p = record(d.parallel, "defaults.parallel");
      knownKeys(p, ["exec", "toolSync", "toolStatusHosts"], "defaults.parallel");
      for (const key of ["exec", "toolSync", "toolStatusHosts"] as const) intIfPresent(p[key], `defaults.parallel.${key}`, 1);
    }
  }
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
      ["name", "ssh", "os", "transport", "gpu", "wsl", "winShell", "python", "services", "health", "cdp", "deploy", "proxy", "android",
        "hostKeyAlias", "sudo", "disable", "enable", "settings"],
      `hosts.${name}`);
    featureList(h.disable, `hosts.${name}.disable`);
    featureList(h.enable, `hosts.${name}.enable`);
    for (const f of h.disable ?? []) if (h.enable?.includes(f))
      fail(`hosts.${name}: '${f}' is in both disable and enable`);
    if (h.settings !== undefined) checkSettings(record(h.settings, `hosts.${name}.settings`), `hosts.${name}.settings`);
    if (h.settings?.winSessionIdleS !== undefined && h.os !== "windows")
      fail(`hosts.${name}.settings.winSessionIdleS is only valid for windows hosts`);
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
    if (h.android !== undefined) {
      const a = record(h.android, `hosts.${name}.android`) as unknown as AndroidSpec;
      knownKeys(a as unknown as Record<string, unknown>, ["serial", "shotWidth"], `hosts.${name}.android`);
      if (a.shotWidth !== undefined && (!Number.isInteger(a.shotWidth) || a.shotWidth < 100 || a.shotWidth > 10000))
        fail(`hosts.${name}.android.shotWidth must be an integer from 100 to 10000 (got '${a.shotWidth}')`);
      stringIfPresent(a.serial, `hosts.${name}.android.serial`);
      if (a.serial !== undefined && !/^[A-Za-z0-9._:-]+$/.test(a.serial))
        fail(`hosts.${name}.android.serial must be an adb serial like 127.0.0.1:5555 (got '${a.serial}')`);
      if (h.os !== "linux") fail(`hosts.${name}: android needs os linux (Termux runs the host's bash)`);
    }
    stringIfPresent(h.hostKeyAlias, `hosts.${name}.hostKeyAlias`);
    if (h.hostKeyAlias !== undefined && !/^[A-Za-z0-9._-]+$/.test(h.hostKeyAlias))
      fail(`hosts.${name}.hostKeyAlias must be a plain name like box-linux (got '${h.hostKeyAlias}')`);
    if (h.sudo !== undefined) {
      const su = record(h.sudo, `hosts.${name}.sudo`) as unknown as SudoSpec;
      knownKeys(su as unknown as Record<string, unknown>, ["passwordEnv", "passwordFile"], `hosts.${name}.sudo`);
      stringIfPresent(su.passwordEnv, `hosts.${name}.sudo.passwordEnv`);
      stringIfPresent(su.passwordFile, `hosts.${name}.sudo.passwordFile`);
      if (!!su.passwordEnv === !!su.passwordFile)
        fail(`hosts.${name}.sudo: set exactly one of passwordEnv / passwordFile`);
      if (h.os === "windows") fail(`hosts.${name}.sudo: sudo needs a POSIX host`);
    }
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
    knownKeys(m as unknown as Record<string, unknown>, ["boots", "switch", "mac"], `machines.${mn}`);
    stringIfPresent(m.mac, `machines.${mn}.mac`);
    if (m.mac !== undefined && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(m.mac))
      fail(`machines.${mn}.mac must look like aa:bb:cc:dd:ee:ff (got '${m.mac}')`);
    if (!isRecord(m.boots) || !Object.keys(m.boots).length) fail(`machines.${mn}: needs at least one boot`);
    for (const [os, rawBoot] of Object.entries(m.boots)) {
      const b = record(rawBoot, `machines.${mn}.boots.${os}`) as unknown as Boot;
      knownKeys(b as unknown as Record<string, unknown>, ["host", "lan", "firmware"], `machines.${mn}.boots.${os}`);
      stringIfPresent(b.firmware, `machines.${mn}.boots.${os}.firmware`);
      if (b.firmware !== undefined && (!b.firmware.trim() || /[\r\n'"`$]/.test(b.firmware)))
        fail(`machines.${mn}.boots.${os}.firmware must be a UEFI entry label without quotes or newlines (got '${b.firmware}')`);
      stringIfPresent(b.host, `machines.${mn}.boots.${os}.host`);
      if (!b.host) fail(`machines.${mn}.boots.${os}: missing host`);
      stringIfPresent(b.lan, `machines.${mn}.boots.${os}.lan`);
      if (!cfg.hosts[b.host]) fail(`machines.${mn}.boots.${os}: unknown host '${b.host}'`);
      if (b.lan && !cfg.hosts[b.lan]) fail(`machines.${mn}.boots.${os}: unknown lan host '${b.lan}'`);
    }
    for (const [target, command] of Object.entries(optionalRecord(m.switch, `machines.${mn}.switch`))) {
      if (!m.boots[target])
        fail(`machines.${mn}.switch.${target}: no such boot (have: ${Object.keys(m.boots).join(", ")})`);
      if (isRecord(command)) {
        for (const [source, sourceCommand] of Object.entries(command)) {
          if (!m.boots[source])
            fail(`machines.${mn}.switch.${target}.${source}: no such source boot (have: ${Object.keys(m.boots).join(", ")})`);
          if (source === target) fail(`machines.${mn}.switch.${target}.${source}: a boot cannot switch to itself`);
          if (typeof sourceCommand !== "string" || !sourceCommand.trim())
            fail(`machines.${mn}.switch.${target}.${source} must be a non-empty command string`);
        }
      } else if (typeof command !== "string" || !command.trim()) {
        fail(`machines.${mn}.switch.${target} must be a command string or an object keyed by source boot`);
      }
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
    // A route picks its transport at run time, so a feature allowed on one
    // transport and refused on another would depend on which link is up.
    const allowed = (name: string) => HOST_FEATURES.filter((f) => featureEnabled(cfg.hosts[name]!, f, cfg)).join(",");
    if (new Set(route.prefer.map(allowed)).size !== 1)
      fail(`routes.${rn}: every transport must allow the same features (check disable/enable on ${route.prefer.join(", ")})`);
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
  for (const [sn, rawSet] of Object.entries(optionalRecord(cfg.skills, "skills"))) {
    const set = record(rawSet, `skills.${sn}`) as unknown as SkillSetSpec;
    knownKeys(set as unknown as Record<string, unknown>, ["hosts", "include", "exclude", "root"], `skills.${sn}`);
    if (!set.hosts || typeof set.hosts !== "string") fail(`skills.${sn}: missing/invalid \`hosts\` selector`);
    stringIfPresent(set.root, `skills.${sn}.root`);
    for (const key of ["include", "exclude"] as const) {
      const list = set[key];
      if (list === undefined && key === "exclude") continue;
      if (!Array.isArray(list) || !list.length || list.some((e) => typeof e !== "string" || !e || e.includes("/")))
        fail(`skills.${sn}.${key} must be a non-empty array of skill names or globs without '/'`);
    }
  }
}

/** Host key options. Boots of one machine share an address, so only the host
 *  key tells them apart. With an alias, a key mismatch must fail the connection
 *  rather than reach the wrong OS: StrictHostKeyChecking=no still logs in with
 *  a public key when the key has changed. */
export function hostKeyOpts(host: Host): string[] {
  if (!host.hostKeyAlias) return [];
  // An alias exists to be checked, so an ssh config line that points
  // UserKnownHostsFile at /dev/null must not win. Aliases share the default store.
  return ["-o", `HostKeyAlias=${host.hostKeyAlias}`, "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${join(homedir(), ".ssh", "known_hosts")}`];
}

/** Compiled Bun binaries resolve import.meta.url inside an embedded filesystem.
 *  POSIX uses /$bunfs; Windows uses B:/~BUN or B:\\~BUN. Users cannot create
 *  config files there. Match whole directory names to preserve real paths. */
const EMBEDDED_CONFIG_PATH = /^(?:\/\$bunfs(?:\/|$)|[bB]:[\\/]~BUN(?:[\\/]|$))/;

/**
 * Every place fleet looks for a config, in order. `FLEET_CONFIG` wins over all
 * of them.
 *
 * When running from source, ROOT is the repo and the config sits next to it.
 * In a compiled binary ROOT is inside Bun's embedded filesystem.
 * Exported so a not-found error can say where it actually searched.
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
  const usable = paths.filter((p) => !EMBEDDED_CONFIG_PATH.test(p));
  const override = "no fleet config found — set FLEET_CONFIG=/path/to/fleet.config.json";
  if (!usable.length) return override;
  return [
    `${override}, or create one at${usable.length > 1 ? " any of" : ""}:`,
    ...usable.map((p) => `  ${p}`),
  ].join("\n");
}

/** An unknown config field may be one a newer source checkout accepts, which
 *  means this fleet is simply older than its config. The checkout is found
 *  through the config's real path, because an installed config is usually a
 *  symlink into it. Nothing is said when that checkout is the running source:
 *  the field is then genuinely unknown. */
export async function staleBinaryHint(message: string, configPath: string, root = ROOT): Promise<string | undefined> {
  const listed = message.match(/unknown fields? ((?:'[^']+'(?:, )?)+)/)?.[1];
  if (!listed) return undefined;
  const fields = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  let dir: string;
  try { dir = dirname(realpathSync(configPath)); } catch { return undefined; }
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  if (real(dir) === real(root)) return undefined;
  const source = Bun.file(join(dir, "src", "config.ts"));
  if (!await source.exists()) return undefined;
  const text = await source.text();
  if (!fields.every((f) => text.includes(`"${f}"`))) return undefined;
  return `this fleet is older than the source at ${dir}, which accepts ${fields.map((f) => `'${f}'`).join(", ")}; `
    + `rebuild it there with: bun run build:local`;
}

export async function loadConfig(): Promise<FleetConfig> {
  const path = await resolveConfigPath();
  if (!await Bun.file(path).exists()) throw new Error(configNotFoundMessage());
  const raw = await Bun.file(path).json() as FleetConfig;
  try { validateConfig(raw, path); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = await staleBinaryHint(message, path);
    throw new Error(hint ? `${message}\n${hint}` : message);
  }
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
  const groups = ["linux", "windows", "mac", "gpu", ...Object.keys(cfg.groups ?? {})].map((name) => `@${name}`);
  throw new Error(`unknown group @${g} (built-in: @linux @windows @mac @gpu; custom: ${Object.keys(cfg.groups ?? {}).join(", ") || "none"})${didYouMean(`@${g}`, groups)}`);
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
      if (!h) throw new Error(`unknown host: ${t} (have: ${Object.keys(cfg.hosts).join(", ")})${didYouMean(t, Object.keys(cfg.hosts))}`);
      set.set(t, h);
    }
  }
  if (set.size === 0) throw new Error(`no hosts matched: ${sel}`);
  return [...set.values()];
}
