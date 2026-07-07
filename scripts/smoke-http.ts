#!/usr/bin/env bun
/**
 * Smoke-test the fleet HTTP MCP server end-to-end: spawn it on a test port with
 * a token, then check /health, the 401 path (no token), and a full authed
 * Streamable-HTTP MCP session (tools/list + fleet_status).
 *
 *   bun run scripts/smoke-http.ts            # full control
 *   FLEET_MCP_READONLY=1 bun run scripts/smoke-http.ts   # expect 4 read tools only
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 8799;
const TOKEN = "smoke-test-token-0123456789";   // ≥16 chars
const BASE = `http://127.0.0.1:${PORT}`;
const READONLY = process.env.FLEET_MCP_READONLY === "1";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const proc = Bun.spawn(["bun", "run", join(repo, "src/http.ts")], {
  env: { ...process.env, FLEET_MCP_TOKEN: TOKEN, FLEET_MCP_PORT: String(PORT), FLEET_MCP_HOST: "127.0.0.1" },
  stdout: "inherit", stderr: "inherit",
});

try {
  // wait for readiness
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    try { ready = (await fetch(`${BASE}/health`)).ok; } catch { /* not up yet */ }
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error("server did not become ready on /health");

  // 1. health
  const health = await (await fetch(`${BASE}/health`)).json();
  check("GET /health ok", health.ok === true && health.hosts > 0, JSON.stringify(health));

  // 2. 401 without a token
  const noAuth = await fetch(`${BASE}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  check("POST /mcp without token → 401", noAuth.status === 401, "got " + noAuth.status);

  // 3. 401 with a wrong token
  const badAuth = await fetch(`${BASE}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer wrong-token-1234567890" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  check("POST /mcp with wrong token → 401", badAuth.status === 401, "got " + badAuth.status);

  // 4. full authed MCP session over Streamable HTTP
  const client = new Client({ name: "fleet-http-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log("  tools:", names.join(", "));
  check("tools/list non-empty", tools.length > 0);
  const hasMutating = names.includes("fleet_exec");
  if (READONLY) check("read-only: no fleet_exec", !hasMutating, names.length + " tools");
  else check("full: fleet_exec present", hasMutating, names.length + " tools");

  const res = await client.callTool({ name: "fleet_status", arguments: {} });
  const t = (res.content as any[]).map((c) => c.text ?? "").join("\n");
  check("fleet_status returns text", t.length > 0);
  console.log("\n--- fleet_status ---\n" + t.split("\n").slice(0, 6).join("\n"));

  await client.close();
} catch (e) {
  check("smoke run", false, (e as Error).message);
} finally {
  proc.kill();
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL (" + failures + ")"}`);
process.exit(failures === 0 ? 0 : 1);
