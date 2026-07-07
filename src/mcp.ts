#!/usr/bin/env bun
/**
 * fleet-mcp — the fleet CLI, exposed as a Model Context Protocol server over
 * stdio. Same quoting-proof exec, same config, same selectors/recipes — just
 * callable by an agent as tools instead of from a shell.
 *
 * Tools live in `server.ts` (shared with the remote HTTP server `http.ts`).
 * The interactive `top`/`ssh` commands are intentionally not exposed — they
 * need a live TTY, which MCP has no notion of.
 *
 * Run:   bun run src/mcp.ts        (config via FLEET_CONFIG or ./fleet.config.json)
 * Register with Claude Code:
 *        claude mcp add fleet -- bun run /path/to/fleet/src/mcp.ts
 *
 * stdio rule: nothing but JSON-RPC may touch stdout. All diagnostics go to
 * stderr (console.error); the action layer in core.ts never prints.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";

async function main() {
  const cfg = await loadConfig();
  const readOnly = process.env.FLEET_MCP_READONLY === "1";
  const server = buildServer(cfg, { readOnly });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`fleet-mcp (stdio) ready · ${Object.keys(cfg.hosts).length} hosts · `
    + `${Object.keys(cfg.recipes ?? {}).length} recipes${readOnly ? " · read-only" : ""}`);
}

main().catch((e) => { console.error("fleet-mcp fatal:", e); process.exit(1); });
