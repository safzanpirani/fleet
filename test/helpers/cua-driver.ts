import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A separate driver process with observable state, used through real shells. */
export async function cuaFixture() {
  const root = await mkdtemp(join(tmpdir(), "fleet-cu-fixture-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const driver = join(bin, "cua-driver");
  await writeFile(driver, `#!${process.execPath}
const root = process.env.CUA_FIXTURE_ROOT;
const tool = process.argv[2];
const payload = ['list_apps', 'list_windows', 'get_config', 'status', 'mcp'].includes(tool) ? {} : JSON.parse((await Bun.stdin.text()) || '{}');
const stateFile = Bun.file(root + '/events.json');
const events = await stateFile.exists() ? await stateFile.json() : [];
if (tool === 'status') {
  console.log('Cua Driver daemon is running');
  console.log('  socket: ' + root + '/driver.sock');
} else if (tool === 'mcp') {
  // One session with its own capture registry, like the real daemon's.
  const captures = new Map();
  let serial = 0;
  const log = async (event) => {
    const file = Bun.file(root + '/session.json');
    const all = await file.exists() ? await file.json() : [];
    all.push(event);
    await Bun.write(file, JSON.stringify(all));
  };
  await log({ argv: process.argv.slice(3) });
  const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
  const structured = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError } : {}) });
  for await (const line of console) {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') { reply(msg.id, { protocolVersion: '2025-06-18', capabilities: {} }); continue; }
    if (msg.method !== 'tools/call') continue;
    const { name, arguments: args } = msg.params;
    await log({ name, args });
    if (name === 'get_window_state') {
      const id = 'capture_fixture_' + (++serial);
      captures.set(id, { pid: args.pid, window_id: args.window_id });
      const all = await stateFile.exists() ? await stateFile.json() : [];
      if (args.screenshot_out_file) await Bun.write(args.screenshot_out_file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
      reply(msg.id, structured({ capture_id: id, screenshot_width: 800, screenshot_height: 600 }));
    } else if (name === 'parse_visual_regions') {
      if (process.env.CUA_FIXTURE_PERCEPTION === 'absent') { reply(msg.id, structured({ code: 'not_installed', message: 'the optional cua-perception extension is not installed', retryable: false }, true)); continue; }
      if (!captures.has(args.capture_id)) { reply(msg.id, structured({ code: 'capture_not_found', message: 'capture id is unknown', retryable: false }, true)); continue; }
      const regions = JSON.parse(process.env.CUA_FIXTURE_REGIONS ?? '[]');
      reply(msg.id, structured({ schema: 'cua.visual_regions_v1', regions, warnings: [], timing: { duration_ms: 12 },
        capture: { capture_id: args.capture_id, source: { kind: 'window', ...captures.get(args.capture_id) },
          screenshot: { width: 800, height: 600, mime_type: 'image/png', reference: 'x' }, action_coordinate_space: { kind: 'screenshot_pixels' } },
        parser: { extension_id: 'cua-perception', extension_version: '0.0.1', model_id: 'fixture', model_version: '1' } }));
    } else {
      if (!captures.has(args.capture_id)) { reply(msg.id, structured({ effect: 'refused', code: 'capture_not_found' })); continue; }
      captures.delete(args.capture_id);
      const all = await stateFile.exists() ? await stateFile.json() : [];
      all.push({ tool: name, payload: args });
      await Bun.write(stateFile, JSON.stringify(all));
      reply(msg.id, process.env.CUA_FIXTURE_CLICK_REPLY ? structured(JSON.parse(process.env.CUA_FIXTURE_CLICK_REPLY)) : structured({ effect: 'confirmed' }));
    }
  }
} else if (tool === 'list_apps') {
  console.log(JSON.stringify({ apps: [{ pid: 42, name: 'Fixture', process_name: 'fixture' }] }));
} else if (tool === 'list_windows') {
  console.log(JSON.stringify({ windows: [{ pid: 42, window_id: 7, title: 'Fixture',
    bounds: { x: 100, y: 200, width: 800, height: 600 }, is_on_screen: true, z_index: 1 }] }));
} else if (tool === 'get_config') {
  console.log(JSON.stringify({ max_image_dimension: 400 }));
} else if (tool === 'get_window_state') {
  if (process.env.CUA_FIXTURE_CAPTURE_FAIL === '1') process.exit(9);
  const captures = Bun.file(root + '/captures.json');
  const previous = await captures.exists() ? await captures.json() : [];
  previous.push({ payload, actions: events.length });
  await Bun.write(captures, JSON.stringify(previous));
  await Bun.write(payload.screenshot_out_file, 'pixels at revision ' + events.length);
} else {
  events.push({ tool, payload });
  await Bun.write(stateFile, JSON.stringify(events));
  if (payload.text === 'refuse') {
    process.stdout.write(process.env.CUA_FIXTURE_REPLY);
    process.exit(0);
  }
  process.stdout.write('reply ' + tool);
  if (payload.text === 'reject') process.exit(17);
}
`, { mode: 0o755 });
  await writeFile(join(bin, "ssh"), "#!/bin/sh\nexec /bin/bash -s\n", { mode: 0o755 });
  const config = join(root, "fleet.config.json");
  await writeFile(config, JSON.stringify({ hosts: { local: { ssh: "local", os: "linux" } } }));
  return {
    root, bin, driver, config,
    env: { ...process.env, CUA_FIXTURE_ROOT: root, TMPDIR: root, PATH: `${bin}:${process.env.PATH ?? ""}` },
    read: async (name: string) => JSON.parse(await readFile(join(root, name + ".json"), "utf8")),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
