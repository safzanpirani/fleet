import { afterEach, describe, expect, test } from "bun:test";
import { dtExec, dtPull, dtPush } from "../src/daytona.ts";
import type { Host } from "../src/config.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalUrl = process.env.DAYTONA_API_URL;
const originalKey = process.env.DAYTONA_API_KEY;

afterEach(() => {
  if (originalUrl === undefined) delete process.env.DAYTONA_API_URL;
  else process.env.DAYTONA_API_URL = originalUrl;
  if (originalKey === undefined) delete process.env.DAYTONA_API_KEY;
  else process.env.DAYTONA_API_KEY = originalKey;
});

function daytona(name: string): Host {
  return { name: `dt:${name}`, ssh: name, os: "linux", transport: "daytona" };
}

describe("Daytona transport", () => {
  test("an explicit unbounded timeout fails before making an API request", async () => {
    delete process.env.DAYTONA_API_KEY;
    const result = await dtExec(daytona("fixture"), "true", { timeoutMs: 0 });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("requires a finite timeout");
  });
  test("execute requires the documented response shape", async () => {
    const token = `shape-${Date.now()}`;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/sandbox")
          return Response.json([{ id: token, name: token, state: "started" }]);
        if (url.pathname.endsWith("/process/execute")) return Response.json({});
        return new Response("not found", { status: 404 });
      },
    });
    process.env.DAYTONA_API_URL = `http://127.0.0.1:${server.port}/api`;
    process.env.DAYTONA_API_KEY = "test-key";
    try {
      const result = await dtExec(daytona(token), "true");
      expect(result.ok).toBe(false);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("invalid response");
    } finally {
      server.stop(true);
    }
  });

  test("execute preserves exact stdout bytes", async () => {
    const token = `stdout-${Date.now()}`;
    const output = "line with spaces  \n\n";
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/sandbox")
          return Response.json([{ id: token, name: token, state: "started" }]);
        if (url.pathname.endsWith("/process/execute"))
          return Response.json({ exitCode: 0, result: output });
        return new Response("not found", { status: 404 });
      },
    });
    process.env.DAYTONA_API_URL = `http://127.0.0.1:${server.port}/api`;
    process.env.DAYTONA_API_KEY = "test-key";
    try {
      const result = await dtExec(daytona(token), "printf");
      expect(result.ok, result.stderr).toBe(true);
      expect(result.stdout).toBe(output);
    } finally {
      server.stop(true);
    }
  });

  test("a cached prefix recovers once after sandbox recreation", async () => {
    const token = `recreated-${Date.now()}`;
    let live: "old" | "new" = "old";
    let listCalls = 0;
    const execIds: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/sandbox") {
          listCalls++;
          return Response.json([{
            id: `${live}-id`, name: `${token}-${live}`, state: "started",
          }]);
        }
        if (url.pathname.endsWith("/process/execute")) {
          const id = url.pathname.split("/")[3]!;
          execIds.push(id);
          if (id !== `${live}-id`) return new Response("sandbox missing", { status: 404 });
          return Response.json({ exitCode: 0, result: `${live}\n` });
        }
        return new Response("not found", { status: 404 });
      },
    });
    process.env.DAYTONA_API_URL = `http://127.0.0.1:${server.port}/api`;
    process.env.DAYTONA_API_KEY = "test-key";
    try {
      const first = await dtExec(daytona(token), "echo first");
      expect(first.stdout).toBe("old\n");
      live = "new";
      const second = await dtExec(daytona(token), "echo second");
      expect(second.ok, second.stderr).toBe(true);
      expect(second.stdout).toBe("new\n");
      expect(listCalls).toBe(2);
      expect(execIds).toEqual(["old-id", "old-id", "new-id"]);
    } finally {
      server.stop(true);
    }
  });

  test("client deadline caps a slow execute request", async () => {
    const token = `slow-${Date.now()}`;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/sandbox")
          return Response.json([{ id: token, name: token, state: "started" }]);
        if (url.pathname.endsWith("/process/execute")) {
          await Bun.sleep(1000);
          return Response.json({ exitCode: 0, result: "too late" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    process.env.DAYTONA_API_URL = `http://127.0.0.1:${server.port}/api`;
    process.env.DAYTONA_API_KEY = "test-key";
    try {
      const started = performance.now();
      const result = await dtExec(daytona(token), "sleep", { timeoutMs: 60 });
      expect(result.code).toBe(124);
      expect(result.stderr).toContain("daytona deadline");
      expect(performance.now() - started).toBeLessThan(500);
    } finally {
      server.stop(true);
    }
  });

  test("upload and download stream through the toolbox endpoints", async () => {
    const token = `files-${Date.now()}`;
    const root = mkdtempSync(join(tmpdir(), "fleet-daytona-"));
    const source = join(root, "source.txt");
    const target = join(root, "target.txt");
    const payload = "streamed payload\n".repeat(1024);
    writeFileSync(source, payload);
    let uploaded = "";
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/sandbox")
          return Response.json([{ id: token, name: token, state: "started" }]);
        if (url.pathname.endsWith("/files/folder")) return Response.json({});
        if (url.pathname.endsWith("/files/upload")) {
          const form = await request.formData();
          uploaded = await (form.get("file") as File).text();
          return Response.json({});
        }
        if (url.pathname.endsWith("/files/download")) {
          const bytes = new TextEncoder().encode(payload);
          return new Response(new ReadableStream({
            start(controller) {
              for (let i = 0; i < bytes.length; i += 257)
                controller.enqueue(bytes.slice(i, i + 257));
              controller.close();
            },
          }));
        }
        return new Response("not found", { status: 404 });
      },
    });
    process.env.DAYTONA_API_URL = `http://127.0.0.1:${server.port}/api`;
    process.env.DAYTONA_API_KEY = "test-key";
    try {
      const pushed = await dtPush(daytona(token), source, "/tmp/source.txt");
      expect(pushed.ok, pushed.stderr).toBe(true);
      expect(uploaded).toBe(payload);
      const pulled = await dtPull(daytona(token), "/tmp/source.txt", target);
      expect(pulled.ok, pulled.stderr).toBe(true);
      expect(readFileSync(target, "utf8")).toBe(payload);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
