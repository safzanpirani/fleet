/** `fleet watch`: rerun one remote command on an interval, like watch(1).
 *  The loop takes its exec, clock and renderer as dependencies so tests drive it
 *  without ssh or real time. It never prints; the CLI renders each run. */
import type { ExecResult } from "./ssh.ts";

export const WATCH_MIN_INTERVAL_S = 0.5;
export const WATCH_DEFAULT_INTERVAL_S = 2;

export interface WatchRun {
  /** 1-based run count. */
  n: number;
  /** Clock value (ms) when the run started. */
  at: number;
  result: ExecResult;
  /** Indices of stdout lines that differ from the previous run (empty on the first). */
  changed: number[];
  /** True when --until matched this run's stdout or stderr. */
  matched: boolean;
}

export interface WatchOptions {
  intervalMs: number;
  until?: RegExp;
  /** Give up after this long without an --until match. */
  timeoutMs?: number;
}

export interface WatchDeps {
  /** Run the command once; `timeoutMs` is the time left before --timeout, if any. */
  exec(timeoutMs?: number): Promise<ExecResult>;
  now(): number;
  /** Sleep, resolving early when the watch is stopped. */
  sleep(ms: number): Promise<void>;
  render(run: WatchRun): void;
  stopped(): boolean;
}

export interface WatchOutcome {
  reason: "matched" | "timeout" | "stopped";
  runs: number;
  last?: WatchRun;
}

/** Parse -n: seconds, fractional allowed, at least 0.5. Returns an error message on failure. */
export function parseWatchInterval(v: string | true | undefined): number | string {
  if (v === undefined) return WATCH_DEFAULT_INTERVAL_S;
  const n = Number(v);
  if (v === true || v.trim() === "" || !Number.isFinite(n) || n < WATCH_MIN_INTERVAL_S)
    return `-n needs a number of seconds ≥ ${WATCH_MIN_INTERVAL_S} (got '${v}')`;
  return n;
}

/** Indices of `next` lines that are new or differ from the same line of `prev`. */
export function changedLines(prev: string | undefined, next: string): number[] {
  if (prev === undefined) return [];
  const a = prev.replace(/\n$/, "").split("\n");
  const b = next.replace(/\n$/, "").split("\n");
  const out: number[] = [];
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

export async function watchLoop(opts: WatchOptions, deps: WatchDeps): Promise<WatchOutcome> {
  const start = deps.now();
  const left = () => (opts.timeoutMs === undefined ? undefined : opts.timeoutMs - (deps.now() - start));
  let prev: string | undefined;
  let last: WatchRun | undefined;
  let n = 0;
  while (!deps.stopped()) {
    const at = deps.now();
    const remaining = left();
    const result = await deps.exec(remaining === undefined ? undefined : Math.max(1, remaining));
    if (deps.stopped()) return { reason: "stopped", runs: n, last };
    n++;
    const matched = opts.until ? opts.until.test(result.stdout) || opts.until.test(result.stderr) : false;
    last = { n, at, result, changed: changedLines(prev, result.stdout), matched };
    prev = result.stdout;
    deps.render(last);
    if (matched) return { reason: "matched", runs: n, last };
    const after = left();
    if (after !== undefined && after <= 0) return { reason: "timeout", runs: n, last };
    const wait = Math.max(0, opts.intervalMs - (deps.now() - at));
    await deps.sleep(after === undefined ? wait : Math.min(wait, after));
    const final = left();
    if (final !== undefined && final <= 0 && !deps.stopped()) return { reason: "timeout", runs: n, last };
  }
  return { reason: "stopped", runs: n, last };
}
