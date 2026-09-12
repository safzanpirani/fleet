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
const payload = ['list_apps', 'list_windows', 'get_config'].includes(tool) ? {} : JSON.parse((await Bun.stdin.text()) || '{}');
const stateFile = Bun.file(root + '/events.json');
const events = await stateFile.exists() ? await stateFile.json() : [];
if (tool === 'list_apps') {
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
