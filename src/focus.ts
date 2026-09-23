/**
 * Task focus for `fleet cu elements --task`. A big window lists hundreds of
 * controls, and every row is input the calling agent must read. Each row is
 * judged on its own by TypeSafe's Jev (one Noul question per row), and only
 * rows Jev is confident the task does not need are hidden. Everything fails
 * open: no key, a timeout, or a bad answer shows every row.
 */
import { readFileSync } from "node:fs";
import type { CuElement } from "./core.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const SHARD = 50;
/** Below this many rows the list is already cheap to read; focus is skipped. */
export const FOCUS_MIN_ROWS = Number(process.env.FLEET_FOCUS_MIN_ROWS) || 30;
/** A row is hidden only when Jev's probability that it is needed is below this. */
export const FOCUS_FLOOR = Number(process.env.FLEET_FOCUS_FLOOR) || 0.15;

export interface JevKey { apiKey: string; model: string; endpoint: string; timeoutMs: number }

/** TYPESAFE_API_KEY, else the `apiKey` in the JSON file FLEET_JEV_CONFIG names. */
export function loadJevKey(env: NodeJS.ProcessEnv = process.env): JevKey | undefined {
  let file: Record<string, unknown> = {};
  const path = env.FLEET_JEV_CONFIG?.trim();
  if (path) try { file = JSON.parse(readFileSync(path, "utf8")); } catch { /* no file config */ }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const apiKey = str(env.TYPESAFE_API_KEY) ?? str(file.apiKey);
  if (!apiKey) return undefined;
  return {
    apiKey,
    model: str(env.FLEET_JEV_MODEL) ?? str(file.model) ?? "jev-latest",
    endpoint: str(env.FLEET_JEV_ENDPOINT) ?? str(file.endpoint) ?? ENDPOINT,
    timeoutMs: Number(env.FLEET_JEV_TIMEOUT_MS) || 15_000,
  };
}

/** One line per control, as the judge sees it. */
export function elementLine(e: CuElement): string {
  return `${e.role} ${JSON.stringify(e.label)}`
    + (e.value !== undefined && e.value !== null && e.value !== e.label ? ` = ${JSON.stringify(String(e.value).slice(0, 60))}` : "")
    + (e.actions.length ? ` [${e.actions.join(",")}]` : "")
    + (e.enabled === false ? " disabled" : "")
    + (e.selected ? " selected" : "");
}

export function focusRequest(model: string, task: string, window: string, rows: CuElement[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const [i, e] of rows.entries()) {
    questions[`r${i}`] = {
      type: "noul",
      instructions: {
        judgement: "The agent needs this one row to do the task: it is a control the task acts on, text the task reads, or the way to reach them. Generic scrolling, window chrome, view switches, column headers and unrelated items are not needed unless the task is about them. Judge only this row; the others are judged separately.",
        row: elementLine(e),
      },
    };
  }
  return { model, state: { task, window }, questions };
}

/** Keep a row unless Jev answered for it AND is confident it is unneeded. */
export function decideFocus(count: number, answers: Record<string, { noul?: number } | undefined>, floor = FOCUS_FLOOR): boolean[] {
  return Array.from({ length: count }, (_v, i) => {
    const p = answers[`r${i}`]?.noul;
    return typeof p !== "number" || !Number.isFinite(p) || p >= floor;
  });
}

export interface Focused { elements: CuElement[]; hidden: CuElement[]; note?: string }

/** Hide the rows the task does not need. Never throws. */
export async function focusElements(
  elements: CuElement[], task: string, window: string,
  deps: { key?: JevKey | null; fetch?: typeof fetch } = {},
): Promise<Focused> {
  const key = deps.key === undefined ? loadJevKey() : deps.key ?? undefined;
  if (!key) return { elements, hidden: [], note: "no TypeSafe key (TYPESAFE_API_KEY), so nothing was hidden" };
  if (elements.length <= FOCUS_MIN_ROWS) return { elements, hidden: [] };
  const shards: CuElement[][] = [];
  for (let i = 0; i < elements.length; i += SHARD) shards.push(elements.slice(i, i + SHARD));
  try {
    const answers = await Promise.all(shards.map(async (shard) => {
      const res = await (deps.fetch ?? fetch)(key.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${key.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(focusRequest(key.model, task, window, shard)),
        signal: AbortSignal.timeout(key.timeoutMs),
      });
      // Never surface the server body: it can echo the request.
      if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`TypeSafe returned ${res.status}`); }
      return ((await res.json()) as { answers?: Record<string, { noul?: number }> }).answers ?? {};
    }));
    const keep = shards.flatMap((shard, i) => decideFocus(shard.length, answers[i]!));
    const hidden = elements.filter((_e, i) => !keep[i]);
    if (!hidden.length || hidden.length === elements.length) return { elements, hidden: [] };
    return { elements: elements.filter((_e, i) => keep[i]), hidden, note: hiddenNote(hidden) };
  } catch (error) {
    return { elements, hidden: [], note: `focus skipped (${error instanceof Error ? error.message : String(error)}); showing every row` };
  }
}

export function hiddenNote(hidden: CuElement[]): string {
  const byRole = new Map<string, number>();
  for (const e of hidden) byRole.set(e.role || "control", (byRole.get(e.role || "control") ?? 0) + 1);
  const roles = [...byRole.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, n]) => `${n} ${r}`).join(", ");
  return `hid ${hidden.length} controls judged unrelated to the task (${roles}); drop --task to see them`;
}
