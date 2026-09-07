import { describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { FleetConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";
import * as jobs from "../src/jobs.ts";
import * as tools from "../src/tools.ts";
import * as core from "../src/core.ts";
import * as ssh from "../src/ssh.ts";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

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
  config: FleetConfig = cfg,
): Promise<T> {
  const server = buildServer(config, { readOnly });
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
  test("service restart describes and executes every matching service host", async () => {
    const execute = spyOn(ssh, "exec").mockImplementation(async (host) => ({
      host: host.name, ok: true, code: 0, stdout: "restarted", stderr: "",
    }));
    const service = { demo: { type: "systemd" as const, name: "demo" } };
    try {
      await withClient(false, async (client) => {
        const { tools } = await client.listTools();
        expect(JSON.stringify(toolByName(tools, "fleet_restart").inputSchema)).toContain("every matched host");
        const result = await client.callTool({ name: "fleet_restart", arguments: { host: "all", service: "demo" } });
        expect(result.isError).not.toBe(true);
        expect(execute.mock.calls.map(([host]) => host.name).sort()).toEqual(["first", "second"]);
        expect(JSON.stringify(result.content)).toContain("first");
        expect(JSON.stringify(result.content)).toContain("second");
      }, { hosts: {
        first: { name: "first", ssh: "fixture-first", os: "linux", services: service },
        second: { name: "second", ssh: "fixture-second", os: "linux", services: service },
        other: { name: "other", ssh: "fixture-other", os: "linux" },
      } });
    } finally { execute.mockRestore(); }
  });

  test("image requests own unique artifacts and clean up successful and failed captures", async () => {
    const paths: string[] = [];
    let fail = false;
    let release: () => void = () => {};
    let barrier = Promise.resolve();
    let pending = 0;
    const capture = async (host: string, path?: string) => {
      if (!path) throw new Error("expected an image destination");
      paths.push(path);
      if (++pending === 2) release();
      if (!fail) await barrier;
      await Bun.write(path, `image of ${host}`);
      if (fail) throw new Error("capture failed after creating a partial image");
      return path;
    };
    const result = (host: string) => ({ host, ok: true, code: 0, stdout: "", stderr: "" });
    const shot = spyOn(core, "captureScreenshot").mockImplementation(async (_cfg, host, local) => ({
      host, localPath: await capture(host, local), remotePath: "/fixture/image.png", capture: result(host), pull: result(host),
    }));
    const cu = spyOn(core, "cuRun").mockImplementation(async (_cfg, host, _args, local) => ({
      host, result: result(host), localImage: await capture(host, local),
    }));
    const window = spyOn(core, "cuShotWindow").mockImplementation(async (_cfg, host, _app, local) => ({
      host, result: result(host), localImage: await capture(host, local),
      app: { pid: 1, name: "fixture" }, window: { pid: 1, window_id: 1, title: "fixture" },
    }));
    const now = spyOn(Date, "now").mockReturnValue(1000);
    try {
      await withClient(false, async (client) => {
        for (const [name, extra] of [
          ["fleet_screenshot", {}],
          ["fleet_cu", { args: ["capture"], image: true }],
          ["fleet_cu_screenshot_window", { app: "fixture" }],
        ] as const) {
          pending = 0;
          barrier = new Promise<void>((resolve) => { release = resolve; });
          const responses = await Promise.all(["first", "second"].map((host) =>
            client.callTool({ name, arguments: { host, ...extra } })));
          for (const [index, response] of responses.entries()) {
            expect(response.isError).not.toBe(true);
            const image = (response.content as { type: string; data?: string }[]).find((item) => item.type === "image");
            expect(Buffer.from(image!.data!, "base64").toString()).toBe(`image of ${index ? "second" : "first"}`);
          }
          fail = true;
          const failed = await client.callTool({ name, arguments: { host: "first", ...extra } });
          expect(failed.isError).toBe(true);
          fail = false;
        }
      }, { hosts: {
        first: { name: "first", ssh: "fixture-first", os: "linux" },
        second: { name: "second", ssh: "fixture-second", os: "linux" },
      } });
      expect(new Set(paths).size).toBe(paths.length);
      for (const path of paths) expect(existsSync(dirname(path))).toBe(false);
    } finally {
      shot.mockRestore(); cu.mockRestore(); window.mockRestore(); now.mockRestore();
    }
  });

  test("unconfirmed spawn exposes the recovery reference as an error", async () => {
    const spawn = spyOn(jobs, "spawnJob").mockResolvedValue([
      { host: "local", id: "attempt-id", pid: null, ok: false, error: "launch unconfirmed" },
    ]);
    try {
      await withClient(false, async (client) => {
        const result = await client.callTool({ name: "fleet_spawn", arguments: { selector: "local", command: "true" } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("local:attempt-id");
        expect(JSON.stringify(result.content)).toContain("before retrying");
      });
    } finally { spawn.mockRestore(); }
  });

  test("dead jobs and unverified tool installations are MCP errors", async () => {
    const wait = spyOn(jobs, "waitJob").mockResolvedValue({ host: "local", id: "dead-id", outcome: "dead", code: null, elapsedMs: 6 });
    const status = spyOn(tools, "toolsStatus").mockResolvedValue([{
      tool: "demo", host: "local", state: "missing",
      local: { name: "demo", version: "1", hash: "fixture", files: 1, root: "/fixture" },
    }]);
    try {
      await withClient(true, async (client) => {
        const job = await client.callTool({ name: "fleet_job_wait", arguments: { ref: "local:dead-id", timeout: 10 } });
        expect(job.isError).toBe(true);
        expect(JSON.stringify(job.content)).toContain("dead; inspect logs");
        const tool = await client.callTool({ name: "fleet_tools_status", arguments: { tool: "demo" } });
        expect(tool.isError).toBe(true);
        expect(JSON.stringify(tool.content)).toContain("missing");
      }, { ...cfg, tools: { demo: { root: "/fixture" } } });
    } finally { wait.mockRestore(); status.mockRestore(); }
  });
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
