import { describe, expect, spyOn, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Tool } from "@modelcontextprotocol/client";
import type { FleetConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";
import * as jobs from "../src/jobs.ts";
import * as core from "../src/core.ts";
import * as ssh from "../src/ssh.ts";
import * as procs from "../src/procs.ts";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const cfg: FleetConfig = {
  hosts: {
    local: { name: "local", ssh: "127.0.0.1", os: "linux" },
  },
  recipes: { health: ["exec local true"] },
};

const READ_TOOLS = [
  "fleet_job_log",
  "fleet_jobs",
  "fleet_logs",
  "fleet_ls",
  "fleet_ps",
  "fleet_status",
].sort();

const MUTATING_TOOLS = [
  "fleet_exec",
  "fleet_screenshot",
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

describe("Fleet MCP", () => {
  test("process listings expose host failures through isError", async () => {
    const list = spyOn(procs, "processList");
    try {
      await withClient(true, async (client) => {
        for (const failed of [false, true]) {
          const rows: procs.ProcList[] = [{ host: "local", ok: true, rows: [] }];
          if (failed) rows.push({ host: "other", ok: false, error: "SSH unavailable", rows: [] });
          list.mockResolvedValue(rows);
          const result = await client.callTool({ name: "fleet_ps", arguments: { selector: "local" } });
          expect(result.isError).toBe(failed);
          expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(rows);
        }
      });
    } finally { list.mockRestore(); }
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
    const now = spyOn(Date, "now").mockReturnValue(1000);
    try {
      await withClient(false, async (client) => {
        for (const [name, extra] of [
          ["fleet_screenshot", {}],
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
      shot.mockRestore(); now.mockRestore();
    }
  });

  test("full server exposes only the shell-less essentials", async () => {
    await withClient(false, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [...READ_TOOLS, ...MUTATING_TOOLS].sort(),
      );

      const exec = toolByName(tools, "fleet_exec");
      expect(exec.inputSchema.properties).toHaveProperty("cwd");
      const screenshot = toolByName(tools, "fleet_screenshot");
      expect(screenshot.inputSchema.properties).toHaveProperty("grid");
    });
  });

  test("read-only mode retains probes but hides remote execution and capture", async () => {
    await withClient(true, async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual(READ_TOOLS);
      expect(names.some((name) => MUTATING_TOOLS.includes(name))).toBe(false);
      for (const tool of tools)
        expect(tool.annotations?.readOnlyHint).toBe(true);
    });
  });
});

test("fleet_job_log forwards filters in readonly mode and reports inspection failure", async () => {
  const tail = spyOn(jobs, "jobTail").mockResolvedValue({ host: "local", output: "selected\n", truncated: true });
  try {
    await withClient(true, async (client) => {
      const r = await client.callTool({ name: "fleet_job_log", arguments: { ref: "local:sample", tail: 2, include: "READY", exclude: "skip" } });
      expect(tail.mock.calls[0]).toEqual([cfg, "local:sample", undefined, 2, { include: "READY", exclude: "skip" }]);
      expect(JSON.stringify(r.content)).toContain("truncated");
      tail.mockRejectedValue(new Error("fixture inspection failed"));
      expect((await client.callTool({ name: "fleet_job_log", arguments: { ref: "local:sample", include: "READY" } })).isError).toBe(true);
    });
  } finally { tail.mockRestore(); }
});

test("fleet_exec forwards literal argv and rejects mixed execution modes", async () => {
  const execute = spyOn(core, "runExec").mockResolvedValue([{ host: "local", ok: true, code: 0, stdout: "ok", stderr: "" }]);
  try {
    await withClient(false, async (client) => {
      const argv = ["program", "", "two words", "$HOME"];
      expect((await client.callTool({ name: "fleet_exec", arguments: { selector: "local", argv } })).isError).not.toBe(true);
      expect(execute.mock.calls[0]![2]).toEqual(argv);
      expect((await client.callTool({ name: "fleet_exec", arguments: { selector: "local", argv, command: "true" } })).isError).toBe(true);
      expect(execute.mock.calls).toHaveLength(1);
    });
  } finally { execute.mockRestore(); }
});

test("native service logs remain readonly and report failures", async () => {
  const execute = spyOn(ssh, "exec").mockResolvedValue({ host: "local", ok: false, code: 7, stdout: "", stderr: "fixture service failure" });
  try {
    await withClient(true, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.find((t) => t.name === "fleet_logs")!.annotations!.readOnlyHint).toBe(true);
      const r = await client.callTool({ name: "fleet_logs", arguments: { host: "local", unit: "fixture.service", type: "systemd" } });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toContain("fixture service failure");
    });
  } finally { execute.mockRestore(); }
});
