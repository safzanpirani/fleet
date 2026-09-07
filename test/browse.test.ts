import { describe, expect, test } from "bun:test";
import { browseHost } from "../src/core.ts";
import type { FleetConfig } from "../src/config.ts";

const cfg: FleetConfig = {
  hosts: {
    linuxbox: {
      name: "linuxbox",
      ssh: "linuxbox",
      os: "linux",
      cdp: "http://browser.test:9223/",
    },
    plain: { name: "plain", ssh: "plain", os: "linux" },
  },
};

describe("browseHost", () => {
  test("verifies CDP, opens a URL with PUT, then lists targets", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const result = await browseHost(cfg, "linuxbox", "https://example.com/a?b=c", {
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? "GET" });
        if (url.endsWith("/json/version")) return Response.json({ Browser: "Chrome/151" });
        if (url.includes("/json/new?")) return Response.json({ id: "new" });
        return Response.json([{ id: "new", type: "page", url: "https://example.com/a?b=c" }]);
      },
    });

    expect(requests).toEqual([
      { url: "http://browser.test:9223/json/version", method: "GET" },
      { url: "http://browser.test:9223/json/new?https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc", method: "PUT" },
      { url: "http://browser.test:9223/json/list", method: "GET" },
    ]);
    expect(result.endpoint).toBe("http://browser.test:9223");
    expect(result.targets[0]?.id).toBe("new");
  });

  test("a host without cdp config gets an actionable hint", async () => {
    expect(browseHost(cfg, "plain")).rejects.toThrow(/add "cdp".*hosts\.plain.*fleet\.config\.json/);
  });

  test("a CDP request has a bounded deadline", async () => {
    const started = performance.now();
    await expect(browseHost(cfg, "linuxbox", undefined, {
      timeoutMs: 20,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    })).rejects.toThrow(/did not answer/);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
