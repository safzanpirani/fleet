#!/usr/bin/env bun
/**
 * fleet-mcp-http — the fleet MCP server over HTTP, for remote clients (Poke,
 * etc.) reached via a Cloudflare tunnel at https://fleet.example.com.
 *
 * ⚠ This endpoint can run arbitrary commands across the whole fleet. The bearer
 *   token is effectively a root credential for every box — treat it that way.
 *
 * Auth:      Authorization: Bearer <FLEET_MCP_TOKEN>  (fallback: X-API-Key header)
 * Transport: POST /mcp           — Streamable HTTP, stateless (no session id)
 * Health:    GET /health          — unauthenticated, leaks only host count + flag
 *
 * There is deliberately no HTTP+SSE transport. It is Deprecated as of MCP
 * 2026-07-28, and it was the only stateful thing in this process — a session
 * map keyed by connection. Stateless is now the protocol's core assumption
 * Each request owns its transport and server.
 * Kill-switch: FLEET_MCP_READONLY=1 drops every execute/write/destructive tool.
 *
 * Binds 127.0.0.1 by default: only cloudflared (same host) should reach it; the
 * token is the public gate.
 *
 * Run: FLEET_MCP_TOKEN=… bun run src/http.ts   (config via FLEET_CONFIG too)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, type FleetConfig } from "./config.ts";
import { buildServer } from "./server.ts";

/** Inline scripts are supported, but request buffering must remain bounded. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Constant-time bearer / X-API-Key check against FLEET_MCP_TOKEN. */
function authed(req: IncomingMessage, token: string): boolean {
  const auth = req.headers["authorization"];
  const xkey = req.headers["x-api-key"];
  let presented = "";
  if (typeof auth === "string" && auth.startsWith("Bearer ")) presented = auth.slice(7).trim();
  else if (typeof xkey === "string") presented = xkey;
  if (!presented) return false;
  const a = Buffer.from(presented), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

class BodyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Stop buffering at the limit, including requests without Content-Length. */
async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const tooLarge = () => new BodyError(413, `request body exceeds ${limit} bytes`);
  if (Number(req.headers["content-length"]) > limit) throw tooLarge();
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onAborted = () => onError(new Error("request aborted"));
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Leave the socket alive long enough to send 413 with Connection: close.
        cleanup();
        req.resume();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
  try { return JSON.parse(body.toString("utf8")); }
  catch { throw new BodyError(400, "Parse error: invalid JSON"); }
}

function sendJson(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export function createFleetHttpServer(
  cfg: FleetConfig,
  opts: { token: string; readOnly?: boolean; maxBodyBytes?: number },
) {
  if (opts.token.length < 16)
    throw new Error("fleet-mcp-http: FLEET_MCP_TOKEN missing or too short (need ≥16 chars). Refusing to start.");
  const limit = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("maxBodyBytes must be a positive integer");
  const hostCount = Object.keys(cfg.hosts).length;
  const readOnly = opts.readOnly ?? false;

  return createServer(async (req, res) => {
    let path: string;
    try { path = new URL(req.url ?? "/", "http://localhost").pathname; }
    catch { return sendJson(res, 400, { error: "invalid request URL" }); }
    const method = req.method ?? "GET";

    // health — unauthenticated, minimal
    if (path === "/health" || (path === "/" && method === "GET")) {
      return sendJson(res, 200, { ok: true, server: "fleet-mcp", hosts: hostCount, readOnly });
    }

    // everything below requires the bearer token
    if (!authed(req, opts.token)) {
      return sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    }

    try {
      // ── Streamable HTTP (stateless — new transport+server per request) ──
      if (path === "/mcp") {
        if (method !== "POST") {
          return sendJson(res, 405, { error: "method not allowed; POST to /mcp" }, { allow: "POST" });
        }
        const body = await readBody(req, limit);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,   // stateless
          enableJsonResponse: true,
        });
        const server = buildServer(cfg, { readOnly });
        res.on("close", () => { void server.close().catch(() => {}); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      // Removed transport — answer clearly rather than 404ing a client that
      // still has the old URL cached.
      if (path === "/sse" || path === "/messages") {
        return sendJson(res, 410, {
          error: "the SSE transport was removed; use Streamable HTTP at POST /mcp",
        });
      }

      return sendJson(res, 404, { error: "not found", paths: ["/health", "/mcp"] });
    } catch (e) {
      if (e instanceof BodyError) {
        return sendJson(res, e.status,
          e.status === 400 ? { jsonrpc: "2.0", id: null, error: { code: -32700, message: e.message } } : { error: e.message },
          e.status === 413 ? { connection: "close" } : {});
      }
      console.error("fleet-mcp-http request error:", e);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    }
  });
}

async function main() {
  const token = process.env.FLEET_MCP_TOKEN ?? "";
  if (token.length < 16)
    throw new Error("fleet-mcp-http: FLEET_MCP_TOKEN missing or too short (need ≥16 chars). Refusing to start.");
  const host = process.env.FLEET_MCP_HOST ?? "127.0.0.1";
  const port = Number(process.env.FLEET_MCP_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("FLEET_MCP_PORT must be an integer from 1 to 65535");
  const readOnly = process.env.FLEET_MCP_READONLY === "1";
  const cfg = await loadConfig();
  const httpServer = createFleetHttpServer(cfg, { token, readOnly });
  httpServer.listen(port, host, () => {
    console.error(`fleet-mcp-http listening on http://${host}:${port} · ${Object.keys(cfg.hosts).length} hosts · `
      + `${readOnly ? "read-only" : "full control"} · routes: /mcp /health`);
  });
}

if (import.meta.main)
  main().catch((e) => { console.error("fleet-mcp-http fatal:", e); process.exit(1); });
