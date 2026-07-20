#!/usr/bin/env bun
/**
 * fleet-mcp-http — the fleet MCP server over HTTP, for remote clients (Poke,
 * etc.) reached through a reverse proxy or tunnel at https://fleet.example.com.
 *
 * ⚠ This endpoint can run arbitrary commands across the whole fleet. The bearer
 *   token is effectively a root credential for every box — treat it that way.
 *
 * Auth:      Authorization: Bearer <FLEET_MCP_TOKEN>  (fallback: X-API-Key header)
 * Transports: POST /mcp           — Streamable HTTP (modern, stateless)
 *             GET  /sse + POST /messages?sessionId=… — legacy SSE
 * Health:    GET /health          — unauthenticated, leaks only host count + flag
 * Kill-switch: FLEET_MCP_READONLY=1 drops the mutating tools (exec/cp/restart/run).
 *
 * Binds 127.0.0.1 by default: only cloudflared (same host) should reach it; the
 * token is the public gate.
 *
 * Run: FLEET_MCP_TOKEN=… bun run src/http.ts   (config via FLEET_CONFIG too)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";

const TOKEN = process.env.FLEET_MCP_TOKEN ?? "";
const HOST = process.env.FLEET_MCP_HOST ?? "127.0.0.1";
const PORT = parseInt(process.env.FLEET_MCP_PORT ?? "8787", 10);
const READONLY = process.env.FLEET_MCP_READONLY === "1";

/** Constant-time bearer / X-API-Key check against FLEET_MCP_TOKEN. */
function authed(req: IncomingMessage): boolean {
  if (!TOKEN) return false;
  const auth = req.headers["authorization"];
  const xkey = req.headers["x-api-key"];
  let presented = "";
  if (typeof auth === "string" && auth.startsWith("Bearer ")) presented = auth.slice(7).trim();
  else if (typeof xkey === "string") presented = xkey;
  if (!presented) return false;
  const a = Buffer.from(presented), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Read + JSON-parse a request body (the SDK transports accept a pre-parsed body). */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}

function sendJson(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function main() {
  if (TOKEN.length < 16) {
    console.error("fleet-mcp-http: FLEET_MCP_TOKEN missing or too short (need ≥16 chars). Refusing to start.");
    process.exit(1);
  }
  const cfg = await loadConfig();
  const hostCount = Object.keys(cfg.hosts).length;
  const sseTransports = new Map<string, SSEServerTransport>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    // health — unauthenticated, minimal
    if (path === "/health" || (path === "/" && method === "GET")) {
      return sendJson(res, 200, { ok: true, server: "fleet-mcp", hosts: hostCount, readOnly: READONLY });
    }

    // everything below requires the bearer token
    if (!authed(req)) {
      return sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    }

    try {
      // ── modern: Streamable HTTP (stateless — new transport+server per request) ──
      if (path === "/mcp") {
        if (method !== "POST") {
          return sendJson(res, 405, { error: "method not allowed; POST to /mcp" }, { allow: "POST" });
        }
        const body = await readBody(req);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,   // stateless
          enableJsonResponse: true,
        });
        res.on("close", () => { void transport.close(); });
        const server = buildServer(cfg, { readOnly: READONLY });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      // ── legacy: SSE (stateful — one transport per open stream) ──
      if (path === "/sse" && method === "GET") {
        const transport = new SSEServerTransport("/messages", res);
        sseTransports.set(transport.sessionId, transport);
        res.on("close", () => sseTransports.delete(transport.sessionId));
        const server = buildServer(cfg, { readOnly: READONLY });
        await server.connect(transport);   // sends the endpoint event over SSE
        return;
      }
      if (path === "/messages" && method === "POST") {
        const sid = url.searchParams.get("sessionId") ?? "";
        const transport = sseTransports.get(sid);
        if (!transport) return sendJson(res, 404, { error: "no such SSE session" });
        await transport.handlePostMessage(req, res, await readBody(req));
        return;
      }

      return sendJson(res, 404, { error: "not found", paths: ["/health", "/mcp", "/sse", "/messages"] });
    } catch (e) {
      console.error("fleet-mcp-http request error:", e);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    }
  });

  httpServer.listen(PORT, HOST, () => {
    console.error(`fleet-mcp-http listening on http://${HOST}:${PORT} · ${hostCount} hosts · `
      + `${READONLY ? "read-only" : "full control"} · routes: /mcp /sse /health`);
  });
}

main().catch((e) => { console.error("fleet-mcp-http fatal:", e); process.exit(1); });
