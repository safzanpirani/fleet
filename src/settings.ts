/**
 * Per-host knobs the transport layer reads on every call. Precedence, first
 * match wins: the environment variable, hosts.<h>.settings, the top-level
 * `defaults`, then the built-in value. Each resolver also reports where its
 * value came from, so `fleet config` can show it.
 */
import { activeConfig } from "./config.ts";
import type { FleetConfig, Host, HostSettings } from "./config.ts";

export type SettingSource = "env" | "host" | "defaults" | "built-in";
export interface Effective<T> {
  value: T;
  source: SettingSource;
  /** The environment variable that set the value, when source is "env". */
  env?: string;
}
type Env = Record<string, string | undefined>;
/** The scalar knobs that have one environment variable each. */
export type Knob = "execTimeoutS" | "probeTimeoutMs" | "doneGraceMs" | "winSessionIdleS" | "sshPersist";
type KnobValue<K extends Knob> = NonNullable<HostSettings[K]>;

/** The environment variable, its parse and the built-in value of each knob, in
 *  the knob's config unit. An empty variable counts as unset. */
const KNOBS: { [K in Knob]: { env: string; builtin: KnobValue<K>; parse: (raw: string) => KnobValue<K> } } = {
  execTimeoutS: { env: "FLEET_EXEC_TIMEOUT", builtin: 0, parse: (raw) => Math.max(0, Number(raw) || 0) },
  probeTimeoutMs: { env: "FLEET_PROBE_TIMEOUT_MS", builtin: 4000, parse: (raw) => Math.max(0, Number(raw) || 0) },
  doneGraceMs: { env: "FLEET_DONE_GRACE_MS", builtin: 1500, parse: (raw) => Math.max(0, Number(raw) || 0) },
  winSessionIdleS: { env: "FLEET_WIN_SESSION_IDLE_S", builtin: 600, parse: (raw) => Number(raw) || 600 },
  sshPersist: { env: "FLEET_SSH_PERSIST", builtin: "60s", parse: (raw) => raw },
};

/** A knob's value from hosts.<h>.settings, then defaults; undefined when neither sets it. */
function fromConfig<K extends keyof HostSettings>(
  host: Pick<Host, "settings"> | undefined, key: K, cfg: FleetConfig | null,
): Effective<NonNullable<HostSettings[K]>> | undefined {
  const own = host?.settings?.[key];
  if (own !== undefined) return { value: own as NonNullable<HostSettings[K]>, source: "host" };
  const shared = cfg?.defaults?.[key];
  if (shared !== undefined) return { value: shared as NonNullable<HostSettings[K]>, source: "defaults" };
  return undefined;
}

/** One knob's effective value for `host`, in its config unit. */
export function knob<K extends Knob>(
  host: Pick<Host, "settings"> | undefined, key: K,
  env: Env = process.env, cfg: FleetConfig | null = activeConfig(),
): Effective<KnobValue<K>> {
  const spec = KNOBS[key];
  const raw = env[spec.env];
  if (raw !== undefined && raw !== "") return { value: spec.parse(raw), source: "env", env: spec.env };
  return fromConfig(host, key, cfg) as Effective<KnobValue<K>> | undefined ?? { value: spec.builtin, source: "built-in" };
}

/** Wall-clock cap of one exec in ms; 0 means none. */
export function execTimeoutMs(host: Pick<Host, "settings">, env: Env = process.env, cfg: FleetConfig | null = activeConfig()): number {
  return knob(host, "execTimeoutS", env, cfg).value * 1000;
}

/** How long exec waits for the pipes to close after the completion marker. */
export function doneGraceMs(host: Pick<Host, "settings">, env: Env = process.env, cfg: FleetConfig | null = activeConfig()): number {
  return knob(host, "doneGraceMs", env, cfg).value;
}

/** The reachability probe's cap. `pinned` is true when the environment or the
 *  config set it: a pinned cap gets no proxy bonus and no short `ls` cap. */
export function probeTimeout(host: Pick<Host, "settings">, env: Env = process.env, cfg: FleetConfig | null = activeConfig()): { ms: number; pinned: boolean } {
  const k = knob(host, "probeTimeoutMs", env, cfg);
  return { ms: k.value, pinned: k.source !== "built-in" };
}

/** How long an idle Windows session broker lives, in ms; never under 10 s. */
export function winSessionIdleMs(host: Pick<Host, "settings">, env: Env = process.env, cfg: FleetConfig | null = activeConfig()): number {
  return Math.max(10, knob(host, "winSessionIdleS", env, cfg).value) * 1000;
}

/** The ssh ControlPersist value of fleet's own control masters. */
export function sshPersist(host: Pick<Host, "settings">, env: Env = process.env, cfg: FleetConfig | null = activeConfig()): string {
  return knob(host, "sshPersist", env, cfg).value;
}

/** Connection multiplexing: `on` uses fleet's own control socket, `off` none,
 *  `config` defers to ~/.ssh/config. FLEET_NO_SSH_MUX=1 beats FLEET_SSH_MUX=config. */
export function sshMux(
  host: Pick<Host, "settings"> | undefined, env: Env = process.env, cfg: FleetConfig | null = activeConfig(),
): Effective<NonNullable<HostSettings["sshMux"]>> {
  if (env.FLEET_NO_SSH_MUX === "1") return { value: "off", source: "env", env: "FLEET_NO_SSH_MUX" };
  if (env.FLEET_SSH_MUX === "config") return { value: "config", source: "env", env: "FLEET_SSH_MUX" };
  return fromConfig(host, "sshMux", cfg) ?? { value: "on", source: "built-in" };
}

/** How many hosts one exec, script or spawn fan-out runs at once:
 *  defaults.parallel.exec, else every host. */
export function execParallelism(cfg: Pick<FleetConfig, "defaults">, hosts: number): number {
  return Math.max(1, Math.min(cfg.defaults?.parallel?.exec ?? hosts, hosts));
}
