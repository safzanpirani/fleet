import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureScreenshot, cuRun, cuShotWindow, deliverImage, validateImageArtifact } from "../src/core.ts";
import type { FleetConfig, Host } from "../src/config.ts";
import type { ExecResult } from "../src/ssh.ts";

const host: Host = { name: "win", ssh: "unused", os: "windows" };
const cfg: FleetConfig = { hosts: { win: host } };
const success = (stdout = ""): ExecResult => ({ host: host.name, ok: true, code: 0, stdout, stderr: "" });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

describe("capture artifacts", () => {
  test("exit zero without a capture path fails every requested-image action", async () => {
    const deps = { exec: async () => success() };
    await expect(captureScreenshot(cfg, "win", "unused.png", deps)).rejects.toThrow("no output path");
    const raw = await cuRun(cfg, "win", ["get_window_state"], "unused.png", deps);
    expect(raw.result.ok).toBe(false);
    expect(raw.result.code).not.toBe(0);
    const window = await cuShotWindow(cfg, "win", "123", "unused.png", deps);
    expect(window.result.ok).toBe(false);
    expect(window.result.code).not.toBe(0);
    expect(window.localImage).toBeUndefined();
  });

  test("a missing or truncated transfer preserves the previous local image", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-image-test-"));
    const output = join(root, "result.png");
    try {
      await writeFile(output, png);
      for (const bytes of [undefined, Buffer.alloc(0), png.subarray(0, 32)]) {
        const result = await deliverImage(host, "C:\\Temp\\capture.png", output, {
          pull: async (_host, _remote, path) => {
            if (bytes !== undefined) await writeFile(path, bytes);
            return success();
          },
        });
        expect(result.result.ok).toBe(false);
        expect(result.result.code).not.toBe(0);
        expect(await readFile(output)).toEqual(png);
        expect(await readdir(root)).toEqual(["result.png"]);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("valid capture transfer installs verified bytes and removes staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-image-test-"));
    const output = join(root, "result.png");
    try {
      const result = await deliverImage(host, "C:\\Temp\\capture.png", output, {
        pull: async (_host, remote, path) => {
          expect(remote).toBe("C:/Temp/capture.png");
          await writeFile(path, png);
          return success();
        },
      });
      expect(result.result.ok).toBe(true);
      await validateImageArtifact(output);
      expect(await readFile(output)).toEqual(png);
      expect(await readdir(root)).toEqual(["result.png"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("failed capture delivery still removes the remote capture", async () => {
    const calls: string[] = [];
    await expect(captureScreenshot(cfg, "win", "unused.png", {
      exec: async (_host, command) => { calls.push(command); return success("C:\\Temp\\capture.png"); },
      deliver: async () => { throw new Error("transfer failed"); },
    })).rejects.toThrow("transfer failed");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("Remove-Item");
    expect(calls[1]).toContain("capture.png");
  });

  test("window capture requires a real local artifact even after successful transfer", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-window-test-"));
    const output = join(root, "missing.png");
    const calls: string[] = [];
    try {
      const result = await cuShotWindow(cfg, "win", "123", output, {
        exec: async (_host, command) => {
          calls.push(command);
          return success("__FLEET_IMG__C:\\Temp\\window.png|123|456|Demo|Window");
        },
        deliver: async () => ({ result: success(), path: output }),
      });
      expect(result.result.ok).toBe(false);
      expect(result.result.code).not.toBe(0);
      expect(result.localImage).toBeUndefined();
      expect(calls.at(-1)).toContain("Remove-Item");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
