/**
 * ports — listening sockets across Linux, macOS, and Windows, one row shape.
 *
 * Linux reads `ss`, macOS `lsof`, Windows Get-NetTCPConnection/Get-NetUDPEndpoint
 * joined with Get-Process. Each listing reports address, port, pid and process
 * name; where the OS hides the owner (Linux `ss -p` without root shows only the
 * caller's own sockets) pid and name are null rather than the row disappearing.
 *
 * Like core.ts, nothing here prints; functions return data and throw.
 */
import { resolveHosts } from "./config.ts";
import type { FleetConfig, Host } from "./config.ts";
import { exec } from "./ssh.ts";

export type PortProto = "tcp" | "udp";

export interface PortRow {
  host: string;
  proto: PortProto;
  addr: string;
  port: number;
  /** null when the OS will not name the owner without elevation. */
  pid: number | null;
  name: string | null;
}

export interface PortList { host: string; ok: boolean; error?: string; rows: PortRow[] }

export interface PortsOptions { filter?: string; udp?: boolean }

const SENT = "__FLEET_PORTS__";

/** The listing program for one host. Nothing caller-provided goes into it. */
export function portsScript(os: Host["os"], proto: PortProto): string {
  if (os === "windows") {
    const list = proto === "udp"
      ? `Get-NetUDPEndpoint -EA SilentlyContinue`
      : `Get-NetTCPConnection -State Listen -EA SilentlyContinue`;
    return [
      `$names = @{}; foreach ($p in Get-Process) { $names[[int]$p.Id] = [string]$p.ProcessName }`,
      `$rows = @(${list} | ForEach-Object { $o = [int]$_.OwningProcess; @{ addr = [string]$_.LocalAddress; port = [int]$_.LocalPort; pid = $o; name = $names[$o] } })`,
      `'${SENT}json|' + (ConvertTo-Json -InputObject $rows -Compress -Depth 3)`,
    ].join("\n");
  }
  if (os === "mac") {
    const sel = proto === "udp" ? `-iUDP` : `-iTCP -sTCP:LISTEN`;
    // -F: one field per line (p pid, c command, n name), so wide names never shift columns.
    // lsof exits 1 when nothing matches; that is an empty list, not a failure.
    return [
      `command -v lsof >/dev/null 2>&1 || { echo "lsof not found" >&2; exit 1; }`,
      `echo "${SENT}lsof"`,
      `lsof -nP +c 0 ${sel} -F pcn 2>/dev/null || true`,
    ].join("\n");
  }
  const f = proto === "udp" ? "u" : "t";
  // -p needs root to see other users' sockets; ss still lists them, without owners.
  // An ss that refuses -p entirely falls back to the bare listing.
  return [
    `command -v ss >/dev/null 2>&1 || { echo "ss not found (install iproute2)" >&2; exit 1; }`,
    `echo "${SENT}ss"`,
    `ss -Hl${f}np 2>/dev/null || ss -Hl${f}n`,
  ].join("\n");
}

/** Split `addr:port` (ss/lsof forms: `*:22`, `[::]:22`, `0.0.0.0%eth0:68`). */
function splitAddr(s: string): { addr: string; port: number } | null {
  const i = s.lastIndexOf(":");
  if (i < 0) return null;
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port)) return null;
  let addr = s.slice(0, i);
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);
  return { addr, port };
}

/** `ss -Hl[t|u]np` lines: State Recv-Q Send-Q Local Peer [users:(("name",pid=N,fd=M),…)]. */
export function parseSs(host: Host, proto: PortProto, out: string): PortRow[] {
  const rows: PortRow[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith(SENT)) continue;
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || !/^\d+$/.test(f[1]!)) continue;
    const a = splitAddr(f[3]!);
    if (!a) continue;
    const owner = /users:\(\("((?:[^"\\]|\\.)*)",pid=(\d+)/.exec(line);
    rows.push({ host: host.name, proto, ...a, pid: owner ? Number(owner[2]) : null, name: owner ? owner[1]! : null });
  }
  return rows;
}

/** `lsof -F pcn` records: a `p` line starts a process, `c` names it, each `n` is a socket. */
export function parseLsof(host: Host, proto: PortProto, out: string): PortRow[] {
  const rows: PortRow[] = [];
  let pid: number | null = null, name: string | null = null;
  for (const line of out.split("\n")) {
    const tag = line[0], v = line.slice(1).trim();
    if (tag === "p") { pid = /^\d+$/.test(v) ? Number(v) : null; name = null; }
    else if (tag === "c") name = v;
    else if (tag === "n") {
      if (v.includes("->")) continue; // a connected UDP socket, not a listener
      const a = splitAddr(v);
      if (a) rows.push({ host: host.name, proto, ...a, pid, name });
    }
  }
  return rows;
}

export function parseWindowsPorts(host: Host, proto: PortProto, out: string): PortRow[] {
  const line = out.split("\n").find((l) => l.startsWith(`${SENT}json|`));
  if (!line) throw new Error("the port listing did not report");
  const data: unknown = JSON.parse(line.slice(SENT.length + 5).trim());
  const list: unknown[] = data == null ? [] : Array.isArray(data) ? data : [data];
  const rows: PortRow[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const port = Number(o.port);
    if (!Number.isInteger(port)) continue;
    rows.push({
      host: host.name, proto, addr: String(o.addr ?? ""), port,
      pid: Number.isInteger(o.pid) ? (o.pid as number) : null, name: typeof o.name === "string" ? o.name : null,
    });
  }
  return rows;
}

/** A row matches a filter by exact port when the filter is a number, else by
 *  process name substring, case-insensitive. Owner-less rows match only by port. */
export function matchesPortFilter(r: PortRow, filter: string): boolean {
  if (/^\d+$/.test(filter)) return r.port === Number(filter);
  return r.name !== null && r.name.toLowerCase().includes(filter.toLowerCase().replace(/\.exe$/, ""));
}

function tidy(rows: PortRow[]): PortRow[] {
  const seen = new Set<string>();
  const out = rows.filter((r) => {
    const k = `${r.addr}|${r.port}|${r.pid}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return out.sort((a, b) => a.port - b.port || (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0) || (a.pid ?? -1) - (b.pid ?? -1));
}

export function validatePortsOptions(opts: PortsOptions): void {
  if (opts.filter !== undefined && !opts.filter.trim()) throw new Error("filter must be a port number or a process name");
}

export async function portList(
  cfg: FleetConfig, sel: string, opts: PortsOptions = {}, deps: { exec?: typeof exec } = {},
): Promise<PortList[]> {
  validatePortsOptions(opts);
  const proto: PortProto = opts.udp ? "udp" : "tcp";
  const run = deps.exec ?? exec;
  return Promise.all(resolveHosts(cfg, sel).map(async (h): Promise<PortList> => {
    const win = h.os === "windows";
    const r = await run(h, portsScript(h.os, proto), win ? "powershell" : "bash");
    if (!r.ok) return { host: h.name, ok: false, error: r.stderr.trim() || `exit ${r.code}`, rows: [] };
    try {
      const parsed = win ? parseWindowsPorts(h, proto, r.stdout)
        : h.os === "mac" ? parseLsof(h, proto, r.stdout) : parseSs(h, proto, r.stdout);
      const rows = opts.filter ? parsed.filter((p) => matchesPortFilter(p, opts.filter!.trim())) : parsed;
      return { host: h.name, ok: true, rows: tidy(rows) };
    } catch (e) {
      return { host: h.name, ok: false, error: (e as Error).message, rows: [] };
    }
  }));
}
