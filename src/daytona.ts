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

const DEFAULT_BASE_URL = "https://app.daytona.io/api";
const DEFAULT_EXEC_TIMEOUT_S = 300;
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

async function api(op: string, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      ...(init?.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
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

export interface Sandbox {
  id: string;
  name?: string;
  state: string;
  labels?: Record<string, string>;
  createdAt?: string;
  autoStopInterval?: number;
}

export async function listSandboxes(): Promise<Sandbox[]> {
  const res = await api("list", "/sandbox");
  const body = (await res.json()) as Sandbox[] | { items?: Sandbox[]; sandboxes?: Sandbox[] };
  if (Array.isArray(body)) return body;
  return body.items ?? body.sandboxes ?? [];
}

// token → sandbox id, cached per process (fan-outs / poll loops shouldn't
// re-list). A token matches by exact id, exact name, or unique prefix of
// either. Ambiguity and no-match are loud errors — never guess.
const idCache = new Map<string, Promise<string>>();

export function resolveSandboxId(token: string): Promise<string> {
  const cached = idCache.get(token);
  if (cached) return cached;
  const p = (async () => {
    const boxes = await listSandboxes();
    const exact = boxes.find((s) => s.id === token || s.name === token);
    if (exact) return exact.id;
    const pre = boxes.filter((s) => s.id.startsWith(token) || (s.name ?? "").startsWith(token));
    if (pre.length === 1) return pre[0]!.id;
    if (pre.length > 1)
      throw new Error(`dt:${token} is ambiguous — matches ${pre.map((s) => s.name ?? s.id).join(", ")}`);
    throw new Error(
      `dt:${token} matches no sandbox (live: ${boxes.map((s) => s.name ?? s.id).join(", ") || "none"})`,
    );
  })();
  p.catch(() => idCache.delete(token));
  idCache.set(token, p);
  return p;
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
  const timeoutS = opts.timeoutMs ? Math.ceil(opts.timeoutMs / 1000) : DEFAULT_EXEC_TIMEOUT_S;
  try {
    const id = await resolveSandboxId(host.ssh);
    const res = await api("exec", toolboxPath(id, "/process/execute"), {
      method: "POST",
      body: JSON.stringify({ command, cwd: opts.cwd ?? DEFAULT_CWD, timeout: timeoutS }),
    });
    const body = (await res.json()) as { exitCode: number; result: string };
    return {
      host: host.name,
      ok: (body.exitCode ?? 0) === 0,
      code: body.exitCode ?? 0,
      stdout: (body.result ?? "").trimEnd(),
      stderr: "",
    };
  } catch (err) {
    if (err instanceof DaytonaHttpError && err.status === 408)
      return { host: host.name, ok: false, code: 124, stdout: "",
        stderr: `fleet: command timed out after ${timeoutS}s (daytona deadline)` };
    return { host: host.name, ok: false, code: 1, stdout: "",
      stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** Reachability = the sandbox exists and is `started`. */
export async function dtProbe(host: Host): Promise<boolean> {
  try {
    const id = await resolveSandboxId(host.ssh);
    const res = await api("get", `/sandbox/${id}`);
    const sb = (await res.json()) as Sandbox;
    return sb.state === "started";
  } catch {
    return false;
  }
}

export async function dtPush(host: Host, local: string, remote: string): Promise<ExecResult> {
  try {
    const id = await resolveSandboxId(host.ssh);
    const bytes = new Uint8Array(await Bun.file(local).arrayBuffer());
    const parent = remote.replace(/\/[^/]+$/, "");
    if (parent && parent !== remote)
      await api("mkdir", toolboxPath(id, "/files/folder", { path: parent, mode: "0755" }), { method: "POST" });
    const form = new FormData();
    form.append("file", new Blob([bytes]), remote.split("/").pop() ?? "file");
    await api("upload", toolboxPath(id, "/files/upload", { path: remote }), { method: "POST", body: form });
    return { host: host.name, ok: true, code: 0, stdout: `${local} -> ${host.name}:${remote}`, stderr: "" };
  } catch (err) {
    return { host: host.name, ok: false, code: 1, stdout: "",
      stderr: err instanceof Error ? err.message : String(err) };
  }
}

export async function dtPull(host: Host, remote: string, local: string): Promise<ExecResult> {
  try {
    const id = await resolveSandboxId(host.ssh);
    const res = await api("download", toolboxPath(id, "/files/download", { path: remote }));
    await Bun.write(local, await res.arrayBuffer());
    return { host: host.name, ok: true, code: 0, stdout: `${host.name}:${remote} -> ${local}`, stderr: "" };
  } catch (err) {
    return { host: host.name, ok: false, code: 1, stdout: "",
      stderr: err instanceof Error ? err.message : String(err) };
  }
}
