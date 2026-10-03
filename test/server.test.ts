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
import * as android from "../src/android.ts";
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
  "fleet_game_status",
  "fleet_gpu",
  "fleet_job_log",
  "fleet_job_wait",
  "fleet_ps",
  "fleet_jobs",
  "fleet_logs",
  "fleet_ls",
  "fleet_session",
  "fleet_status",
  "fleet_svc",
  "fleet_tools_status",
  "fleet_wait",
].sort();

const MUTATING_TOOLS = [
  "fleet_android_act",
  "fleet_android_apps",
  "fleet_android_batch",
  "fleet_android_bootstrap",
  "fleet_android_elements",
  "fleet_android_flow",
  "fleet_android_notifications",
  "fleet_android_open",
  "fleet_android_record",
  "fleet_android_release",
  "fleet_android_screenshot",
  "fleet_android_state",
  "fleet_android_wait",
  "fleet_bios",
  "fleet_browse",
  "fleet_cp",
  "fleet_cu",
  "fleet_cu_act",
  "fleet_cu_batch",
  "fleet_cu_apps",
  "fleet_cu_elements",
  "fleet_cu_open",
  "fleet_cu_regions",
  "fleet_cu_verify",
  "fleet_cu_screenshot_window",
  "fleet_cu_windows",
  "fleet_cu_record",
  "fleet_deploy",
  "fleet_drop",
  "fleet_edit",
  "fleet_exec",
  "fleet_game_control",
  "fleet_game_do",
  "fleet_game_frame",
  "fleet_game_windows",
  "fleet_job_kill",
  "fleet_jobs_prune",
  "fleet_kill",
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
  test("game input advertises mutation and validates before host routing", async () => {
    const route = spyOn(core, "routeSelector");
    try {
      await withClient(false, async (client) => {
        const { tools } = await client.listTools();
        expect(toolByName(tools, "fleet_game_do").annotations).toMatchObject({
          readOnlyHint: false, destructiveHint: true, idempotentHint: false,
        });
        for (const args of [
          { target: "game", steps: [{ tap: "w", ms: -1 }] },
          { steps: [{ tap: "w" }] },
          { steps: [{ wait: 3_600_000 }], repeat: 1000 },
        ]) {
          const result = await client.callTool({ name: "fleet_game_do", arguments: { host: "local", ...args } });
          expect(result.isError).toBe(true);
        }
      });
      expect(route).not.toHaveBeenCalled();
    } finally { route.mockRestore(); }
  });

  test("Android flow is registered as mutating and disappears in read-only mode", async () => {
    const flow = spyOn(android, "androidFlow");
    try {
      await withClient(false, async (client) => {
        const { tools } = await client.listTools();
        const tool = toolByName(tools, "fleet_android_flow");
        expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
        expect(tool.inputSchema.required).toEqual(["host", "steps"]);
        expect(tool.inputSchema.properties).toHaveProperty("target");
        expect(tool.inputSchema.properties).toHaveProperty("read");
        expect(tool.inputSchema.properties).toHaveProperty("noRead");
        expect(tool.inputSchema.properties).toHaveProperty("settleMs");
        const steps = tool.inputSchema.properties!.steps as { minItems: number; maxItems: number; items: { oneOf?: any[]; anyOf?: any[] } };
        expect(steps.minItems).toBe(1);
        expect(steps.maxItems).toBe(30);
        const variants = steps.items.oneOf ?? steps.items.anyOf;
        expect(variants).toHaveLength(9);
        expect(variants!.every((v) => v.additionalProperties === false)).toBe(true);
        expect(tool.description).toContain("default any");
        expect(tool.description).toContain("fail early");
      });
      await withClient(true, async (client) => {
        const { tools } = await client.listTools();
        expect(tools.some((tool) => tool.name === "fleet_android_flow")).toBe(false);
        const denied = await client.callTool({ name: "fleet_android_flow", arguments: { host: "local", steps: [{ action: "key", key: "back" }] } });
        expect(denied.isError).toBe(true);
      });
      expect(flow).not.toHaveBeenCalled();
    } finally { flow.mockRestore(); }
  });

  test("Android flow rejects malformed steps and flags before routing or input", async () => {
    const flow = spyOn(android, "androidFlow");
    const route = spyOn(core, "routeSelector");
    try {
      await withClient(false, async (client) => {
        const invalid = [
          { steps: [] }, { steps: Array.from({ length: 31 }, () => ({ action: "sleep", ms: 0 })) },
          ...[
            null, { action: "tap" }, { action: "tap", label: "Save", unknown: true },
            { action: "tap", label: "Save", what: "com.example" }, { action: "tap", label: " " },
            { action: "tap", label: "Save", nth: 0 }, { action: "tap", label: "Save", nth: 1.5 },
            { action: "open" }, { action: "open", what: "bad" },
            { action: "open", what: "com.example", in: "com.other" },
            { action: "open", what: "https://example.com", in: "bad" },
            { action: "wait", label: "Save", focus: "example" }, { action: "wait", focus: "example", nth: 1 },
            { action: "wait", label: "Save", timeoutMs: 120001 },
            { action: "expect", label: "Save", gone: true, text: "saved" },
            { action: "expect", label: "Save", gone: "false" },
            { action: "type", label: "search" }, { action: "type", label: "search", text: "héllo" },
            { action: "type", label: "search", text: "100%s" },
            { action: "scroll", label: "list", direction: "diagonal" },
            { action: "scroll", label: "list", direction: "down", amount: 11 },
            { action: "long_press", label: "Save", ms: 0 },
            { action: "key", key: "KEYCODE_SLEEP" }, { action: "sleep", ms: 10001 },
          ].map((step) => ({ steps: [{ action: "key", key: "back" }, step] })),
          { steps: [{ action: "sleep", ms: 0 }], read: "*", noRead: true },
          { steps: [{ action: "sleep", ms: 0 }], target: "x;bad" },
          { steps: [{ action: "sleep", ms: 0 }], settleMs: -1 },
        ];
        for (const args of invalid) {
          const result = await client.callTool({ name: "fleet_android_flow", arguments: { host: "local", ...args } });
          expect(result.isError).toBe(true);
        }
      });
      expect(route).not.toHaveBeenCalled();
      expect(flow).not.toHaveBeenCalled();
    } finally { flow.mockRestore(); route.mockRestore(); }
  });

  test("Android flow routes the host, forwards every action, and shares element rows", async () => {
    const elements = android.androidElements(android.parseUiDump('<hierarchy><node text="Save" class="android.widget.Button" '
      + 'package="com.example" clickable="true" enabled="true" bounds="[0,0][100,100]" /></hierarchy>'));
    const state = { pkg: "com.example", width: 100, height: 100, awake: "Awake", locked: false };
    const route = spyOn(core, "routeSelector").mockResolvedValue("resolved-phone");
    const flow = spyOn(android, "androidFlow").mockResolvedValue({ host: "resolved-phone", ok: true, state,
      steps: [{ index: 0, status: "done", summary: "tap Save", detail: "changed" }], elements, total: 1 });
    const listed = spyOn(android, "androidElementsOf").mockResolvedValue({ host: "resolved-phone", state, elements, total: 1,
      result: { host: "resolved-phone", ok: true, code: 0, stdout: "", stderr: "" } });
    const steps: android.AndroidFlowStep[] = [
      { action: "open", what: "https://example.com", in: "com.example" },
      { action: "wait", label: "Save", nth: 1, timeoutMs: 1000 },
      { action: "expect", label: "Save", text: "Save" }, { action: "tap", label: "Save" },
      { action: "long_press", role: "Button", ms: 800 }, { action: "type", label: "search", text: "hi" },
      { action: "scroll", label: "list", direction: "down", amount: 2 },
      { action: "key", key: "back" }, { action: "sleep", ms: 0 },
    ];
    try {
      await withClient(false, async (client) => {
        const result = await client.callTool({ name: "fleet_android_flow", arguments: {
          host: "phone-route", steps, target: "example", read: "*", settleMs: 0,
        } });
        expect(result.isError).toBe(false);
        expect(route.mock.calls[0]).toEqual([cfg, "phone-route"]);
        expect(flow.mock.calls[0]).toEqual([cfg, "resolved-phone", steps, { target: "example", read: "*", settleMs: 0 }]);
        const body = (result.content as { type: string; text: string }[])[0]!.text;
        expect(body).toContain("1. done tap Save — changed");
        expect(body).toContain("com.example focused · 100x100");
        const rows = body.split("\n").filter((s) => s.startsWith("{")).map((s) => JSON.parse(s));
        const existing = await client.callTool({ name: "fleet_android_elements", arguments: { host: "phone-route" } });
        const existingBody = JSON.parse((existing.content as { text: string }[])[0]!.text);
        expect(rows).toEqual(existingBody.elements);
        expect(rows[0]).toHaveProperty("center", { x: 50, y: 50 });
        expect(rows[0]).not.toHaveProperty("bounds");
        expect(rows[0]).not.toHaveProperty("ancestors");
        expect(rows[0]).not.toHaveProperty("index");
        for (const args of [{ noRead: true }, { read: "Save", noRead: false }, {}]) {
          await client.callTool({ name: "fleet_android_flow", arguments: { host: "phone-route", steps: [{ action: "sleep", ms: 0 }], ...args } });
          expect(flow.mock.calls.at(-1)![3]!.read).toBe("noRead" in args && args.noRead ? false : "read" in args ? args.read : undefined);
        }
      });
    } finally { flow.mockRestore(); listed.mockRestore(); route.mockRestore(); }
  });

  test("Android flow reports failures, not_run steps, and readError without changing outcomes", async () => {
    const route = spyOn(core, "routeSelector").mockResolvedValue("resolved-phone");
    const flow = spyOn(android, "androidFlow");
    try {
      await withClient(false, async (client) => {
        for (const ok of [true, false]) {
          flow.mockResolvedValue({ host: "resolved-phone", ok, state: { pkg: "com.example", awake: "Asleep", locked: true },
            steps: ok ? [{ index: 0, status: "done", summary: "expect Save" }] : [
              { index: 0, status: "failed", summary: "expect Save", detail: "no element with label Save" },
              { index: 1, status: "not_run", summary: "tap Next" },
            ], readError: "final read disconnected" });
          const result = await client.callTool({ name: "fleet_android_flow", arguments: { host: "phone-route", steps: [{ action: "expect", label: "Save" }] } });
          expect(result.isError).toBe(!ok);
          const body = (result.content as { text: string }[])[0]!.text;
          expect(body).toContain("readError: final read disconnected");
          expect(body).toContain("com.example focused · screen Asleep · locked");
          if (!ok) {
            expect(body).toContain("1. failed expect Save — no element with label Save");
            expect(body).toContain("2. not_run tap Next");
          }
        }
        flow.mockRejectedValue(new Error("connection lost after send"));
        const failed = await client.callTool({ name: "fleet_android_flow", arguments: { host: "phone-route", steps: [{ action: "key", key: "back" }] } });
        expect(failed.isError).toBe(true);
        expect(JSON.stringify(failed.content)).toContain("connection lost after send");
        expect(flow.mock.calls).toHaveLength(3);
      });
    } finally { flow.mockRestore(); route.mockRestore(); }
  });

  test("MCP batches forward ordered input and expose partial failure as an error", async () => {
    const batch = spyOn(core, "cuBatch").mockImplementation(async (_cfg, host, app, actions, opts) => {
      expect(host).toBe("local");
      expect(app).toBe("Fixture");
      expect(actions.map((action) => action.tool)).toEqual(["drag", "scroll"]);
      expect(opts?.space).toBe("screen");
      expect(opts?.imageOut).toBeUndefined();
      return { host, target: { name: "Fixture", pid: 42, window: { window_id: 7 }, blockers: [], siblings: [] },
        effect: "indeterminate", hashes: [], actions: [{ index: 0, status: "failed", code: 17 }, { index: 1, status: "not_run", code: null }],
        result: { host, ok: false, code: 17, stdout: "", stderr: "driver refused" } } as any;
    });
    try {
      await withClient(false, async (client) => {
        const result = await client.callTool({ name: "fleet_cu_batch", arguments: {
          host: "local", app: "Fixture", space: "screen", screenshot: false,
          actions: [{ tool: "drag", args: { from_x: 1, from_y: 2, to_x: 3, to_y: 4 } }, { tool: "scroll", args: { direction: "down" } }],
        } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("not_run");
        expect(batch.mock.calls).toHaveLength(1);
      });
    } finally { batch.mockRestore(); }
  });

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
    const fixtureWindow = {
      window_id: 1, pid: 1, title: "fixture", app_name: "fixture.exe",
      x: 0, y: 0, width: 800, height: 600, on_screen: true, minimized: false, z_index: 1,
    };
    const window = spyOn(core, "cuShotWindow").mockImplementation(async (_cfg, host, _app, local) => ({
      host, result: result(host), localImage: await capture(host, local),
      app: { pid: 1, name: "fixture" }, window: { pid: 1, window_id: 1, title: "fixture" },
      target: {
        pid: 1, name: "fixture", matched: "app" as const, window: fixtureWindow,
        siblings: [], blockers: [], capture: { width: 800, height: 600, scale: 1 },
      },
      composited: [],
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
      // `old` or `edits` supplies the change, so neither is required on its own.
      expect(edit.inputSchema.properties).toHaveProperty("edits");
      expect(edit.inputSchema.required).toEqual(["selector", "path"]);
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


describe("fleet_edit input contracts", () => {
  test("rejects unknown fields and mode clashes before routing; accepts existing old callers and edit lists", async () => {
    const route = spyOn(core, "routeSelector").mockResolvedValue("local");
    const edit = spyOn(core, "editRemoteFile").mockResolvedValue([{
      host: "local", path: "f", ok: true, replacements: 1, diff: "", lineEndings: "crlf",
    }]);
    try {
      await withClient(false, async (client) => {
        const base = { selector: "local", path: "f" };
        for (const args of [
          {}, { new: "x" }, { old: "a", edits: [{ old: "a" }] },
          { new: "x", edits: [{ old: "a" }] }, { all: false, edits: [{ old: "a" }] },
          { old: "a", replacement: "x" }, { edits: [{ old: "a", replacement: "x" }] },
          { edits: [] }, { edits: [{ old: "" }] }, { edits: [{ old: "a", all: "true" }] },
        ]) {
          const result = await client.callTool({ name: "fleet_edit", arguments: { ...base, ...args } });
          expect(result.isError).toBe(true);
        }
        expect(route).not.toHaveBeenCalled();
        expect(edit).not.toHaveBeenCalled();
        const legacy = await client.callTool({ name: "fleet_edit", arguments: { ...base, old: "a", new: "$&", all: true } });
        expect(legacy.isError).not.toBe(true);
        expect(edit.mock.calls[0]![3]).toEqual([{ old: "a", new: "$&", all: true }]);
        const edits = [{ old: "a", new: "b" }, { old: "b" }];
        const listed = await client.callTool({ name: "fleet_edit", arguments: { ...base, edits, dryRun: true } });
        expect(listed.isError).not.toBe(true);
        expect(JSON.stringify(listed.content)).toContain("CRLF");
        expect(edit.mock.calls[1]![3]).toEqual(edits);
        expect(edit.mock.calls[1]![4]).toMatchObject({ dryRun: true });
      });
    } finally { route.mockRestore(); edit.mockRestore(); }
  });
});
