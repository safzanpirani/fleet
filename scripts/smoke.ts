#!/usr/bin/env bun
/** Smoke-test the fleet MCP server over a real stdio JSON-RPC session. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const transport = new StdioClientTransport({
  command: "bun", args: ["run", join(repo, "src/mcp.ts")],
});
const client = new Client({ name: "fleet-smoke", version: "1.0.0" });

function show(title: string, res: any) {
  const t = (res.content ?? []).map((c: any) => c.text ?? "").join("\n");
  console.log(`\n### ${title}${res.isError ? "  [isError]" : ""}\n${t}`);
}

await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
console.log("fleet_exec schema:", JSON.stringify(tools.find((t) => t.name === "fleet_exec")?.inputSchema));

show("fleet_status {}", await client.callTool({ name: "fleet_status", arguments: {} }));

show("fleet_restart (bogus → expect isError)",
  await client.callTool({ name: "fleet_restart", arguments: { host: "oracle", service: "does-not-exist" } }));

show("fleet_exec oracle 'echo + quotes round-trip'",
  await client.callTool({ name: "fleet_exec", arguments: {
    selector: "oracle",
    command: `echo 'fleet-mcp ok: "a & b | c" $HOME='"$HOME"`,
  } }));

await client.close();
console.log("\nsmoke: done");
