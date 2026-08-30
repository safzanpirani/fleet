import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { FleetConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";

const cfg: FleetConfig = {
  hosts: {
    local: { name: "local", ssh: "127.0.0.1", os: "linux" },
  },
  recipes: { health: ["exec local true"] },
};

const READ_TOOLS = [
  "fleet_boot",
  "fleet_cu_describe",
  "fleet_cu_tools",
  "fleet_disk",
  "fleet_doctor",
  "fleet_dt",
  "fleet_gpu",
  "fleet_job_log",
  "fleet_job_wait",
  "fleet_jobs",
  "fleet_logs",
  "fleet_ls",
  "fleet_status",
  "fleet_svc",
  "fleet_tools_status",
  "fleet_wait",
].sort();

const MUTATING_TOOLS = [
  "fleet_bios",
  "fleet_browse",
  "fleet_cp",
  "fleet_cu",
  "fleet_cu_apps",
  "fleet_cu_screenshot_window",
  "fleet_cu_windows",
  "fleet_cu_record",
  "fleet_deploy",
  "fleet_edit",
  "fleet_exec",
  "fleet_job_kill",
  "fleet_jobs_prune",
  "fleet_pull",
  "fleet_reboot",
  "fleet_script",
  "fleet_restart",
  "fleet_run",
  "fleet_screenshot",
  "fleet_spawn",
  "fleet_switch",
].sort();

async function withClient<T>(
  readOnly: boolean,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const server = buildServer(cfg, { readOnly });
  const client = new Client({ name: "fleet-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function toolByName(tools: Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("Fleet MCP parity", () => {
  test("full server exposes every non-interactive CLI operation", async () => {
    await withClient(false, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [...READ_TOOLS, ...MUTATING_TOOLS].sort(),
      );

      const exec = toolByName(tools, "fleet_exec");
      expect(exec.inputSchema.properties).toHaveProperty("cwd");
      const cp = toolByName(tools, "fleet_cp");
      expect(cp.inputSchema.properties).toHaveProperty("recursive");
      const screenshot = toolByName(tools, "fleet_screenshot");
      expect(screenshot.inputSchema.properties).toHaveProperty("grid");
      const switchTool = toolByName(tools, "fleet_switch");
      expect(switchTool.inputSchema.properties).toHaveProperty("timeout");
      // The guardrails are the point of fleet_edit — a caller must be able to
      // ask for a diff without writing, and to opt into a multi-match replace.
      const edit = toolByName(tools, "fleet_edit");
      expect(edit.inputSchema.properties).toHaveProperty("dryRun");
      expect(edit.inputSchema.properties).toHaveProperty("all");
      expect(edit.inputSchema.required).toEqual(["selector", "path", "old"]);
      // fleet_script takes a local file OR inline text; neither may be required.
      const script = toolByName(tools, "fleet_script");
      expect(script.inputSchema.properties).toHaveProperty("path");
      expect(script.inputSchema.properties).toHaveProperty("source");
      expect(script.inputSchema.required).toEqual(["selector"]);
      const browse = toolByName(tools, "fleet_browse");
      expect(browse.inputSchema.properties).toHaveProperty("url");
      const record = toolByName(tools, "fleet_cu_record");
      expect(record.inputSchema.properties).toHaveProperty("action");
      expect(record.inputSchema.properties).toHaveProperty("out");
    });
  });

  test("read-only mode retains probes and bounded waits but hides all remote execution", async () => {
    await withClient(true, async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual(READ_TOOLS);
      expect(names.some((name) => MUTATING_TOOLS.includes(name))).toBe(false);
      for (const tool of tools)
        expect(tool.annotations?.readOnlyHint).toBe(true);
    });
  });

  test("MCP wait contracts require finite timeouts", async () => {
    await withClient(true, async (client) => {
      const { tools } = await client.listTools();
      const wait = toolByName(tools, "fleet_wait");
      expect(wait.inputSchema.required).toEqual(expect.arrayContaining(["target", "timeout"]));
      const jobWait = toolByName(tools, "fleet_job_wait");
      expect(jobWait.inputSchema.required).toEqual(expect.arrayContaining(["ref", "timeout"]));
    });
  });

  test("fleet_wait completes through the real MCP handler and rejects ambiguous conditions", async () => {
    const httpServer = Bun.serve({
      port: 0,
      fetch: () => new Response("ok"),
    });
    try {
      await withClient(true, async (client) => {
        const ready = await client.callTool({
          name: "fleet_wait",
          arguments: {
            target: "local-test",
            http: `http://127.0.0.1:${httpServer.port}`,
            timeout: 1,
          },
        });
        expect(ready.isError).not.toBe(true);

        const invalid = await client.callTool({
          name: "fleet_wait",
          arguments: {
            target: "local-test",
            http: `http://127.0.0.1:${httpServer.port}`,
            port: httpServer.port,
            timeout: 1,
          },
        });
        expect(invalid.isError).toBe(true);
      });
    } finally {
      httpServer.stop(true);
    }
  });
});
