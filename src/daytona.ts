/**
 * Daytona transport — drives ephemeral cloud sandboxes over Daytona's REST
 * toolbox API instead of SSH. Sandboxes are addressed as `dt:<id|name|prefix>`
 * selectors; the token resolves lazily (against the live sandbox list) on the
 * first API call, because sandboxes are ephemeral and never live in
 * fleet.config.json. API shapes mirror the verified adapter in
 * spore/.flue/lib/daytona-sandbox.ts (exec timeout is SECONDS, combined
 * output comes back in `result`, deadline = HTTP 408 → exit 124).
 */
import type { Host } from "./config.ts";
import type { ExecResult } from "./ssh.ts";
import { rename, unlink } from "node:fs/promises";

const DEFAULT_BASE_URL = "https://app.daytona.io/api";
const DEFAULT_EXEC_TIMEOUT_S = 300;
const DEFAULT_API_TIMEOUT_MS = Math.max(1, Number(process.env.DAYTONA_API_TIMEOUT_MS ?? 300_000) || 300_000);
const DEFAULT_CWD = "/home/daytona";

export const DT_PREFIX = "dt:";

export function isDaytonaHost(h: Host): boolean {
  return h.transport === "daytona";
}

/** Synthesize a Host for a `dt:<token>` selector — no API round-trip here;
 *  the token is resolved to a concrete sandbox id lazily. */
export function daytonaHost(token: string): Host {
  return { name: `dt:${token}`, ssh: token, os: "linux", transport: "daytona" };
}

function baseUrl(): string {
  return process.env.DAYTONA_API_URL || DEFAULT_BASE_URL;
}

function apiKey(): string {
  const k = process.env.DAYTONA_API_KEY;
  if (!k) throw new Error("DAYTONA_API_KEY is not set (needed for dt: hosts)");
  return k;
}

async function api(op: string, path: string, init?: RequestInit, timeoutMs = DEFAULT_API_TIMEOUT_MS): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(Math.max(1, timeoutMs)),
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        ...(init?.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError" || name === "TimeoutError")
      throw new DaytonaTimeoutError(op, timeoutMs);
    throw err;
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new DaytonaHttpError(op, res.status, body);
  }
  return res;
}

export class DaytonaHttpError extends Error {
  constructor(op: string, readonly status: number, body: string) {
    super(`daytona ${op} failed: HTTP ${status} ${body}`);
  }
}

export class DaytonaTimeoutError extends Error {
  constructor(op: string, readonly timeoutMs: number) {
    super(`daytona ${op} timed out after ${Math.ceil(timeoutMs / 1000)}s`);
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DaytonaTimeoutError("exec", timeoutMs)), Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface Sandbox {
  id: string;
  name?: string;
  state: string;
  labels?: Record<string, string>;
  createdAt?: string;
  autoStopInterval?: number;
}

export async function listSandboxes(timeoutMs = DEFAULT_API_TIMEOUT_MS): Promise<Sandbox[]> {
  const res = await api("list", "/sandbox", undefined, timeoutMs);
  const body = (await res.json()) as Sandbox[] | { items?: Sandbox[]; sandboxes?: Sandbox[] };
  if (Array.isArray(body)) return body;
  return body.items ?? body.sandboxes ?? [];
}

// token → sandbox id, cached per process (fan-outs / poll loops shouldn't
// re-list). A token matches by exact id, exact name, or unique prefix of
// either. Ambiguity and no-match are loud errors — never guess.
const idCache = new Map<string, string>();

export async function resolveSandboxId(token: string, timeoutMs = DEFAULT_API_TIMEOUT_MS): Promise<string> {
  const cached = idCache.get(token);
  if (cached) return cached;
  const boxes = await listSandboxes(timeoutMs);
  const exact = boxes.find((s) => s.id === token || s.name === token);
  if (exact) {
    idCache.set(token, exact.id);
    return exact.id;
  }
  const pre = boxes.filter((s) => s.id.startsWith(token) || (s.name ?? "").startsWith(token));
  if (pre.length === 1) {
    idCache.set(token, pre[0]!.id);
    return pre[0]!.id;
  }
  if (pre.length > 1)
    throw new Error(`dt:${token} is ambiguous — matches ${pre.map((s) => s.name ?? s.id).join(", ")}`);
  throw new Error(
    `dt:${token} matches no sandbox (live: ${boxes.map((s) => s.name ?? s.id).join(", ") || "none"})`,
  );
}

/** Run one toolbox operation against a resolved id. A named/prefix selector can
 * outlive the sandbox it first resolved to, so one 404 evicts that exact cache
 * entry, re-lists the live sandboxes, and retries against the replacement. */
async function withSandboxId<T>(
  token: string,
  run: (id: string) => Promise<T>,
  timeoutMs: number | (() => number) = DEFAULT_API_TIMEOUT_MS,
): Promise<T> {
  const remaining = typeof timeoutMs === "function" ? timeoutMs : () => timeoutMs;
  const id = await resolveSandboxId(token, remaining());
  try {
    return await run(id);
  } catch (err) {
    if (!(err instanceof DaytonaHttpError) || err.status !== 404) throw err;
    // Do not delete a replacement cached by another concurrent retry.
    if (idCache.get(token) === id) idCache.delete(token);
    const replacement = await resolveSandboxId(token, remaining());
    return run(replacement);
  }
}

function parseExecResponse(body: unknown): { exitCode: number; result: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)
    || !Number.isSafeInteger((body as { exitCode?: unknown }).exitCode)
    || typeof (body as { result?: unknown }).result !== "string")
    throw new Error("daytona exec returned an invalid response (expected integer exitCode and string result)");
  return body as { exitCode: number; result: string };
}

function toolboxPath(id: string, path: string, query?: Record<string, string>): string {
  const q = query ? `?${new URLSearchParams(query)}` : "";
  return `/toolbox/${id}/toolbox${path}${q}`;
}

export async function dtExec(
  host: Host,
  command: string,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_EXEC_TIMEOUT_S * 1000;
  const timeoutS = Math.max(1, Math.ceil(timeoutMs / 1000));
  try {
    return await withDeadline((async () => {
      const deadlineAt = Date.now() + timeoutMs;
      const remaining = () => Math.max(1, deadlineAt - Date.now());
      const res = await withSandboxId(host.ssh, (id) => api(
        "exec",
        toolboxPath(id, "/process/execute"),
        {
          method: "POST",
          body: JSON.stringify({ command, cwd: opts.cwd ?? DEFAULT_CWD, timeout: timeoutS }),
        },
        remaining(),
      ), remaining);
      const body = parseExecResponse(await res.json());
      return {
        host: host.name,
        ok: body.exitCode === 0,
        code: body.exitCode,
        stdout: body.result,
        stderr: "",
      };
    })(), timeoutMs);
  } catch (err) {
    if ((err instanceof DaytonaHttpError && err.status === 408) || err instanceof DaytonaTimeoutError)
      return { host: host.name, ok: false, code: 124, stdout: "",
        stderr: `fleet: command timed out after ${timeoutS}s (daytona deadline)` };
    return { host: host.name, ok: false, code: 1, stdout: "",
      stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** Reachability = the sandbox exists and is `started`. */
export async function dtProbe(host: Host, timeoutMs = DEFAULT_API_TIMEOUT_MS): Promise<boolean> {
  try {
    return await withDeadline((async () => {
      const deadlineAt = Date.now() + timeoutMs;
      const remaining = () => Math.max(1, deadlineAt - Date.now());
      const res = await withSandboxId(host.ssh,
        (id) => api("get", `/sandbox/${id}`, undefined, remaining()), remaining);
      const sb = (await res.json()) as Sandbox;
      return sb.state === "started";
    })(), timeoutMs);
  } catch {
    return false;
  }
}

export async function dtPush(host: Host, local: string, remote: string): Promise<ExecResult> {
  try {
    const file = Bun.file(local);
    if (!await file.exists()) throw new Error(`local file does not exist: ${local}`);
    await withSandboxId(host.ssh, async (id) => {
      const parent = remote.replace(/\/[^/]+$/, "");
      if (parent && parent !== remote)
        await api("mkdir", toolboxPath(id, "/files/folder", { path: parent, mode: "0755" }), { method: "POST" });
      const form = new FormData();
      form.append("file", file, remote.split("/").pop() ?? "file");
      await api("upload", toolboxPath(id, "/files/upload", { path: remote }), { method: "POST", body: form });
    });
    return { host: host.name, ok: true, code: 0, stdout: `${local} -> ${host.name}:${remote}`, stderr: "" };
  } catch (err) {
    return { host: host.name, ok: false, code: 1, stdout: "",
      stderr: err instanceof Error ? err.message : String(err) };
  }
}

export async function dtPull(host: Host, remote: string, local: string): Promise<ExecResult> {
  const partial = `${local}.fleet-part-${process.pid}-${Date.now()}`;
  try {
    const res = await withSandboxId(host.ssh,
      (id) => api("download", toolboxPath(id, "/files/download", { path: remote })));
    if (!res.body) throw new Error("daytona download returned no response body");
    const writer = Bun.file(partial).writer();
    try {
      for await (const chunk of res.body) writer.write(chunk);
      await writer.end();
    } catch (err) {
      writer.end();
      throw err;
    }
    await rename(partial, local);
    return { host: host.name, ok: true, code: 0, stdout: `${host.name}:${remote} -> ${local}`, stderr: "" };
  } catch (err) {
    await unlink(partial).catch(() => {});
    return { host: host.name, ok: false, code: 1, stdout: "",
      stderr: err instanceof Error ? err.message : String(err) };
  }
}
