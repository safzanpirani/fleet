import { describe, expect, test } from "bun:test";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createFleetHttpServer } from "../src/http.ts";
import type { FleetConfig } from "../src/config.ts";

const cfg: FleetConfig = {
  hosts: { fixture: { name: "fixture", ssh: "unused-fixture", os: "linux" } },
};
const listRequest = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

async function withServer(
  options: { readOnly?: boolean; maxBodyBytes?: number },
  run: (base: string, headers: Record<string, string>, token: string) => Promise<void>,
) {
  const token = crypto.randomUUID();
  const server = createFleetHttpServer(cfg, { token, ...options });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    }, token);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}

describe("Fleet HTTP transport", () => {
  test("requires a startup credential and authenticates every non-health route", async () => {
    expect(() => createFleetHttpServer(cfg, { token: "" })).toThrow("missing or too short");
    await withServer({}, async (base, headers, token) => {
      const health = await (await fetch(`${base}/health`)).json();
      expect(health).toEqual({ ok: true, server: "fleet-mcp", hosts: 1, readOnly: false });
      for (const path of ["/mcp", "/sse", "/messages", "/unknown"]) {
        const response = await fetch(base + path);
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe("Bearer");
        await response.text();
      }
      for (const auth of [
        { ...headers, authorization: `Bearer ${token}wrong` },
        { ...headers, authorization: `Bearer ${token}wrong`, "x-api-key": token },
      ]) {
        const response = await fetch(`${base}/mcp`, { method: "POST", headers: auth, body: listRequest });
        expect(response.status).toBe(401);
        await response.text();
      }
      const { authorization: _authorization, ...withoutBearer } = headers;
      const fallback = await fetch(`${base}/mcp`, {
        method: "POST", headers: { ...withoutBearer, "x-api-key": token }, body: listRequest,
      });
      expect(fallback.status).toBe(200);
      expect((await fallback.json() as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
    });
  });

  test("rejects malformed and oversized bodies without breaking subsequent requests", async () => {
    const limit = 1024;
    await withServer({ maxBodyBytes: limit }, async (base, headers) => {
      for (const body of ["", "{invalid"]) {
        const response = await fetch(`${base}/mcp`, { method: "POST", headers, body });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
      }
      const oversized = await fetch(`${base}/mcp`, {
        method: "POST", headers, body: " ".repeat(limit + 1),
      });
      expect(oversized.status).toBe(413);
      await oversized.text();
      const chunked = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(`${base}/mcp`, { method: "POST", headers }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => resolve({ status: res.statusCode!, body }));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.write(" ".repeat(limit));
        req.end(" ");
      });
      expect(chunked.status).toBe(413);
      expect(JSON.parse(chunked.body)).toHaveProperty("error");
      const exact = await fetch(`${base}/mcp`, {
        method: "POST", headers, body: listRequest.padEnd(limit),
      });
      expect(exact.status).toBe(200);
      expect(await exact.json()).toHaveProperty("result.tools");
    });
  });

  test("real HTTP clients observe read-only registration and cannot call hidden execution tools", async () => {
    for (const readOnly of [false, true]) {
      await withServer({ readOnly }, async (base, headers) => {
        const client = new Client({ name: "http-test", version: "1" });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
            requestInit: { headers },
          }));
          const { tools } = await client.listTools();
          expect(tools.some((tool) => tool.name === "fleet_exec")).toBe(!readOnly);
          expect(tools.some((tool) => tool.name === "fleet_wait")).toBe(true);
          if (readOnly) {
            const denied = await client.callTool({ name: "fleet_exec", arguments: { selector: "fixture", command: "true" } });
            expect(denied.isError).toBe(true);
            expect(JSON.stringify(denied.content)).toContain("not found");
          }
        } finally { await client.close(); }
      });
    }
  });
});
