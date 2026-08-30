/**
 * fleet tools — ship the fleet's own CLI tools (and their paired Agent Skills)
 * to every box, and say which boxes are stale.
 *
 * The problem this exists for: a house-style CLI (`fleet`, `tg`, `qb`, `see`…)
 * lives in ~10 places at once — a source tree per box, a launcher on each PATH,
 * a `SKILL.md` under each ~/.claude/skills — and nothing announces when one of
 * them falls behind. Drift is discovered the hard way, mid-task, on the box
 * where it matters. So: fingerprint the tool on the controller, stamp a manifest
 * on every host at sync time, and let `fleet tools status` diff the two.
 *
 * Version identity is deliberately two-part:
 *   - `hash`    content fingerprint of exactly the files that get shipped. It
 *               needs no discipline and cannot be forgotten, so it is what the
 *               in-sync/stale verdict is computed from.
 *   - `version` package.json semver. Human-facing label only — it says *what*
 *               changed, never whether a box is current (a forgotten bump would
 *               otherwise report "in sync" while shipping different bytes).
 */
import { join, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { lstat, readlink, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { FleetConfig, Host, ToolSpec } from "./config.ts";
import { resolveHosts } from "./config.ts";
import { exec, scp } from "./ssh.ts";
import type { ExecResult } from "./ssh.ts";

/** Where every host records what it has: one small JSON file per tool, all in
 *  one directory so a single `cat` reads the whole inventory in one round-trip. */
const MANIFEST_DIR_POSIX = "$HOME/.fleet-tools";
const MANIFEST_DIR_WIN = "$env:USERPROFILE\\.fleet-tools";

/** Files never shipped, on top of a tool's own `exclude`. */
const ALWAYS_EXCLUDE = ["node_modules", ".git", "dist", ".DS_Store"];
const FILE_IO_PARALLELISM = 16;
const TRAVERSAL_PARALLELISM = 8;
const TOOL_FINGERPRINT_PARALLELISM = 4;
const TOOL_STATUS_HOST_PARALLELISM = 8;
const DEFAULT_TOOL_SYNC_PARALLELISM = 2;

/** Run independent work with a fixed ceiling while preserving input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  maxParallel: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(maxParallel) || maxParallel < 1)
    throw new Error(`maxParallel must be an integer ≥ 1 (got ${maxParallel})`);
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxParallel, items.length) }, worker));
  return results;
}

export interface ToolFingerprint {
  name: string;
  version: string;         // package.json version, or "0.0.0" when there isn't one
  hash: string;            // sha256 over the shipped file set (12 hex chars)
  files: number;
  root: string;
  skillPath?: string;      // absolute path to SKILL.md on the controller
}
export interface ToolManifest {
  tool: string;
  version: string;
  hash: string;
  syncedAt: string;        // ISO date, stamped by the controller at sync time
  dir: string;
  skill?: string;          // hash of the SKILL.md that was pushed alongside
}
export type ToolState = "current" | "stale" | "missing" | "unreachable";
export interface ToolStatusRow {
  tool: string;
  host: string;
  state: ToolState;
  local: ToolFingerprint;
  remote?: ToolManifest;
  error?: string;
}

const expandHome = (p: string): string =>
  p.startsWith("~/") || p === "~" ? join(homedir(), p.slice(1)) : p;

/** The tool's registry entry, with every default filled in. Throws with the
 *  known names rather than returning undefined — a typo'd tool name must not
 *  quietly resolve to "nothing to do". */
export function resolveTool(cfg: FleetConfig, name: string): ToolSpec & { name: string; root: string } {
  const spec = cfg.tools?.[name];
  if (!spec) {
    const known = Object.keys(cfg.tools ?? {});
    throw new Error(`unknown tool '${name}'${known.length ? ` (have: ${known.join(", ")})` : " — no `tools` block in config"}`);
  }
  return { ...spec, name, root: expandHome(spec.root) };
}

/** Install dir on a host: explicit > ~/<name> (posix) | %USERPROFILE%\<name>. */
export function toolDir(spec: { name: string; dir?: string }, h: Host): string {
  if (spec.dir) return spec.dir;
  return h.os === "windows" ? `$env:USERPROFILE\\${spec.name}` : `$HOME/${spec.name}`;
}

/** Walk the tool's source tree, honouring excludes, in a stable order. Directory
 * reads run concurrently by level, with a fixed ceiling to avoid descriptor and
 * metadata storms on large trees. */
export async function shippedFiles(
  root: string,
  exclude: string[],
  options: {
    maxParallel?: number;
    readDirectory?: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
  } = {},
): Promise<string[]> {
  const skip = new Set([...ALWAYS_EXCLUDE, ...exclude]);
  const readDirectory = options.readDirectory ?? readdir;
  const out: string[] = [];
  let directories = [{ path: root, rel: "" }];

  while (directories.length) {
    const levels = await mapPool(
      directories,
      options.maxParallel ?? TRAVERSAL_PARALLELISM,
      async ({ path, rel }) => {
        const entries = await readDirectory(path, { withFileTypes: true });
        return { rel, entries: entries.sort((a, b) => a.name.localeCompare(b.name)) };
      },
    );
    const nextDirectories: { path: string; rel: string }[] = [];
    for (const { rel, entries } of levels) {
      const directory = rel ? join(root, rel) : root;
      for (const entry of entries) {
        if (skip.has(entry.name)) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) nextDirectories.push({ path: join(directory, entry.name), rel: childRel });
        else if (entry.isFile() || entry.isSymbolicLink()) out.push(childRel);
      }
    }
    directories = nextDirectories;
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** sha256 over (path, content) pairs — path included so a rename is a change.
 * Reads happen concurrently with a fixed ceiling. Hash updates then follow the
 * stable logical-path order, so completion timing cannot alter the digest.
 * `extra` folds in a file from outside the tree under a stable logical name. */
export async function hashFiles(
  root: string,
  rels: string[],
  extra?: { as: string; path: string },
  options: {
    maxParallel?: number;
    readFile?: (path: string) => Promise<Uint8Array>;
    inspectSymlink?: (path: string) => Promise<string | null>;
  } = {},
): Promise<string> {
  const inputs = [
    ...rels.map((rel) => ({ logical: rel, path: join(root, rel), preserveSymlink: true })),
    ...(extra ? [{ logical: extra.as, path: extra.path, preserveSymlink: false }] : []),
  ];
  const readFile = options.readFile ?? (async (path: string) =>
    new Uint8Array(await Bun.file(path).arrayBuffer()));
  // A source-tree symlink is archived as a symlink, so hash its target text and
  // type instead of following it. An external SKILL.md is copied as file bytes.
  // Tests that inject readFile may inject inspectSymlink when they need link
  // semantics; otherwise their virtual paths are treated as regular files.
  const inspectSymlink = options.inspectSymlink ?? (options.readFile
    ? async () => null
    : async (path: string) => (await lstat(path)).isSymbolicLink() ? readlink(path) : null);
  const contents = await mapPool(
    inputs,
    options.maxParallel ?? FILE_IO_PARALLELISM,
    async ({ path, preserveSymlink }) => {
      const target = preserveSymlink ? await inspectSymlink(path) : null;
      return target === null
        ? { kind: 0, bytes: await readFile(path) }
        : { kind: 1, bytes: new TextEncoder().encode(target) };
    },
  );
  const h = new Bun.CryptoHasher("sha256");
  h.update("fleet-tools-fingerprint-v2\0");
  const updateFrame = (bytes: Uint8Array): void => {
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    h.update(length);
    h.update(bytes);
  };
  for (let index = 0; index < inputs.length; index++) {
    const content = contents[index]!;
    h.update(new Uint8Array([content.kind]));
    updateFrame(new TextEncoder().encode(inputs[index]!.logical));
    updateFrame(content.bytes);
  }
  return h.digest("hex").slice(0, 12);
}

async function fileHash(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(new Uint8Array(await Bun.file(path).arrayBuffer()));
  return h.digest("hex").slice(0, 12);
}

/** Where the tool's SKILL.md lives on the controller: explicit `skill`, else the
 *  house convention `<root>/skills/<name>/SKILL.md`, else the installed copy
 *  under ~/.claude/skills — several tools keep the skill only there, never
 *  having vendored it back into their repo. None is fine; not every tool has one. */
async function findSkill(spec: { name: string; root: string; skill?: string }): Promise<string | undefined> {
  const candidates = spec.skill
    ? [join(spec.root, spec.skill)]
    : [
      join(spec.root, "skills", spec.name, "SKILL.md"),
      join(spec.root, "SKILL.md"),
      join(homedir(), ".claude", "skills", spec.name, "SKILL.md"),
    ];
  for (const c of candidates) if (await Bun.file(c).exists()) return c;
  if (spec.skill) throw new Error(`tools.${spec.name}.skill points at a missing file: ${candidates[0]}`);
  return undefined;
}

/** Fingerprint the tool as it exists on the controller — the reference every
 *  host is compared against. */
export async function fingerprint(cfg: FleetConfig, name: string): Promise<ToolFingerprint> {
  const spec = resolveTool(cfg, name);
  const st = await stat(spec.root).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`tools.${name}.root is not a directory: ${spec.root}`);
  const files = await shippedFiles(spec.root, spec.exclude ?? []);
  if (!files.length) throw new Error(`tools.${name}: nothing to ship from ${spec.root}`);
  let version = "0.0.0";
  const pkg = join(spec.root, "package.json");
  if (await Bun.file(pkg).exists())
    version = ((await Bun.file(pkg).json()) as { version?: string }).version ?? "0.0.0";
  const skillPath = await findSkill(spec);
  // A skill kept outside the source tree (the common case — most tools only ever
  // had one under ~/.claude/skills) is still part of what gets shipped, so it
  // must be part of the fingerprint. Otherwise editing only the SKILL.md leaves
  // every box reporting "current" while running yesterday's instructions.
  const external = skillPath && !skillPath.startsWith(spec.root + "/")
    ? { as: "SKILL.md", path: skillPath } : undefined;
  return {
    name, version, files: files.length, root: spec.root, skillPath,
    hash: await hashFiles(spec.root, files, external),
  };
}

/** Fingerprint registry entries through a bounded pool and retain per-tool
 * failures so `tools list` can report every entry in registry order. */
export async function fingerprintTools(
  cfg: FleetConfig,
  names: string[],
  dependencies: { fingerprint?: typeof fingerprint } = {},
): Promise<Array<ToolFingerprint | Error>> {
  const fingerprintTool = dependencies.fingerprint ?? fingerprint;
  return mapPool(names, TOOL_FINGERPRINT_PARALLELISM, async (name) => {
    try {
      return await fingerprintTool(cfg, name);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  });
}

/** Read every manifest a host has, in one round-trip. Hosts with no manifests
 *  (never synced) return an empty list rather than an error. */
export async function readManifests(h: Host): Promise<{ manifests: ToolManifest[]; error?: string }> {
  const cmd = h.os === "windows"
    ? `$d="${MANIFEST_DIR_WIN}"; if (Test-Path $d) { Get-ChildItem $d -Filter *.json | ForEach-Object { Get-Content $_.FullName -Raw } } `
    : `for f in ${MANIFEST_DIR_POSIX}/*.json; do [ -e "$f" ] && cat "$f"; done 2>/dev/null; true`;
  const r = await exec(h, cmd, h.os === "windows" ? "powershell" : "bash");
  if (!r.ok) return { manifests: [], error: r.stderr || `exit ${r.code}` };
  const manifests: ToolManifest[] = [];
  // Manifests are concatenated, not a JSON array — scan object by object so one
  // corrupt file can't blind us to the rest of the inventory.
  for (const chunk of r.stdout.split(/\n(?=\{)/)) {
    const t = chunk.trim();
    if (!t.startsWith("{")) continue;
    try { manifests.push(JSON.parse(t) as ToolManifest); } catch { /* skip corrupt */ }
  }
  return { manifests };
}

function verdict(local: ToolFingerprint, remote: ToolManifest | undefined): ToolState {
  if (!remote) return "missing";
  return remote.hash === local.hash ? "current" : "stale";
}

/** Tools × hosts. Each host is read exactly once no matter how many tools are
 *  being checked — one `cat` returns that box's whole inventory.
 *
 *  With no explicit selector each tool falls back to its own `hosts` (then
 *  `all`), because "every tool on every box" is mostly noise: a box that was
 *  never meant to have `bhav` isn't drift, it's just not a target. */
export async function toolsStatus(
  cfg: FleetConfig,
  tools: string[],
  sel?: string,
  dependencies: {
    fingerprint?: typeof fingerprint;
    readManifests?: typeof readManifests;
  } = {},
): Promise<ToolStatusRow[]> {
  const fingerprintTool = dependencies.fingerprint ?? fingerprint;
  const readHostManifests = dependencies.readManifests ?? readManifests;
  const locals = await mapPool(
    tools,
    TOOL_FINGERPRINT_PARALLELISM,
    (tool) => fingerprintTool(cfg, tool),
  );
  const targets = new Map<string, Host[]>();
  for (const tool of tools)
    targets.set(tool, resolveHosts(cfg, sel ?? cfg.tools?.[tool]?.hosts ?? "all"));

  const hosts: Host[] = [];
  const seenHosts = new Set<string>();
  for (const tool of tools) {
    for (const host of targets.get(tool) ?? []) {
      if (seenHosts.has(host.name)) continue;
      seenHosts.add(host.name);
      hosts.push(host);
    }
  }
  const hostResults = await mapPool(
    hosts,
    TOOL_STATUS_HOST_PARALLELISM,
    (host) => readHostManifests(host),
  );
  const manifestsByHost = new Map(hosts.map((host, index) => [host.name, hostResults[index]!]));

  return locals.flatMap((local) =>
    (targets.get(local.name) ?? []).map((host) => {
      const { manifests, error } = manifestsByHost.get(host.name)!;
      const remote = manifests.find((manifest) => manifest.tool === local.name);
      return {
        tool: local.name,
        host: host.name,
        local,
        remote,
        state: error ? "unreachable" : verdict(local, remote),
        ...(error ? { error } : {}),
      } satisfies ToolStatusRow;
    }),
  );
}

export interface ToolSyncResult {
  tool: string; host: string; ok: boolean; dir: string;
  version: string; hash: string;
  skill?: boolean;          // whether a SKILL.md was pushed
  result: ExecResult;
  error?: string;
}

export function installScript(
  h: Host, spec: { name: string; entry?: string }, dir: string, manifest: ToolManifest, bin: string,
): { cmd: string; shell: "bash" | "powershell" } {
  const entry = spec.entry ?? "src/cli.ts";
  // `dir` is a shell expression ($HOME/tg) until the host expands it, so the
  // manifest is written with a placeholder the remote shell substitutes — a
  // stored "$HOME/tg" would be useless to anyone reading the inventory later.
  const json = JSON.stringify({ ...manifest, dir: "__DIR__" });
  if (h.os === "windows") {
    const winEntry = entry.replace(/\//g, "\\");
    return { shell: "powershell", cmd: [
      `$ErrorActionPreference='Stop'`,
      `$bun=(Get-Command bun -EA SilentlyContinue).Source; if(-not $bun){$bun="$env:USERPROFILE\\.bun\\bin\\bun.exe"}`,
      `$dir="${dir}"`,
      `New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
      `tar -xzf "$env:USERPROFILE\\${spec.name}-sync.tgz" -C $dir`,
      `$installCode=0`,
      `Push-Location $dir`,
      `try { & $bun install 2>&1 | Out-Null; $installCode=$LASTEXITCODE } finally { Pop-Location }`,
      `if ($installCode -ne 0) { throw "bun install failed with exit $installCode" }`,
      `Remove-Item "$env:USERPROFILE\\${spec.name}-sync.tgz" -Force -EA SilentlyContinue`,
      // A .cmd shim on PATH is the Windows equivalent of the posix launcher.
      `$shim="$env:USERPROFILE\\.local\\bin"`,
      `New-Item -ItemType Directory -Force -Path $shim | Out-Null`,
      `$shimText = "@echo off\`r\`n""$bun"" ""$dir\\${winEntry}"" %*"`,
      `Set-Content -Path "$shim\\${bin}.cmd" -Value $shimText -Encoding ascii`,
      `New-Item -ItemType Directory -Force -Path "${MANIFEST_DIR_WIN}" | Out-Null`,
      `Set-Content -Path "${MANIFEST_DIR_WIN}\\${spec.name}.json" -Value (${psSingle(json)} -replace '__DIR__', $dir.Replace('\\','\\\\')) -Encoding utf8`,
      `"installed ${spec.name} -> $dir"`,
    ].join("\n") };
  }
  return { shell: "bash", cmd: [
    `set -e`,
    `bun="$(command -v bun || echo "$HOME/.bun/bin/bun")"`,
    `dir="${dir}"`,
    `mkdir -p "$dir" "$HOME/.local/bin" "${MANIFEST_DIR_POSIX}"`,
    `tar -xzf "$HOME/${spec.name}-sync.tgz" -C "$dir"`,
    `(cd "$dir" && "$bun" install >/dev/null 2>&1)`,
    `rm -f "$HOME/${spec.name}-sync.tgz"`,
    // Unquoted heredoc: $bun/$dir expand as the launcher is written, \$@ does not.
    // A symlink into src/cli.ts with a `#!/usr/bin/env bun` shebang would look
    // equivalent and isn't — ~/.bun/bin is absent from a non-interactive ssh
    // PATH, so every `fleet exec host '<tool> …'` dies with `env: 'bun': No such
    // file or directory`. Absolute bun path, always.
    `cat > "$HOME/.local/bin/${bin}" <<LAUNCHER\n#!/bin/sh\nexec "$bun" "$dir/${entry}" "\\$@"\nLAUNCHER`,
    `chmod 755 "$HOME/.local/bin/${bin}"`,
    `sed "s|__DIR__|$dir|" > "${MANIFEST_DIR_POSIX}/${spec.name}.json" <<'MANIFEST'\n${json}\nMANIFEST`,
    `echo "installed ${spec.name} -> $dir"`,
  ].join("\n") };
}

/** A PowerShell single-quoted literal — the only quoting that survives JSON's
 *  double quotes intact. Internal `'` doubles. */
function psSingle(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Ship one tool to one host: tarball → extract → `bun install` → launcher →
 *  SKILL.md → manifest. The manifest is written last and only on success, so a
 *  half-finished sync reports stale rather than falsely claiming to be current. */
async function syncOne(
  cfg: FleetConfig, spec: ReturnType<typeof resolveTool>, fp: ToolFingerprint,
  h: Host, tarLocal: string, opts: { skill?: boolean } = {},
): Promise<ToolSyncResult> {
  const dir = toolDir(spec, h);
  const base = { tool: spec.name, host: h.name, dir, version: fp.version, hash: fp.hash };
  const pushed = await scp(h, tarLocal, `${spec.name}-sync.tgz`);
  if (!pushed.ok) return { ...base, ok: false, result: pushed, error: pushed.stderr || "scp failed" };

  let skillPushed = false;
  if (opts.skill !== false && fp.skillPath) {
    const dest = h.os === "windows"
      ? `C:/Users/${await winUser(h)}/.claude/skills/${spec.name}/SKILL.md`
      : `.claude/skills/${spec.name}/SKILL.md`;
    // scp will not create the intermediate skill dir; make it first.
    const mk = h.os === "windows"
      ? await exec(h, `New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\\.claude\\skills\\${spec.name}" | Out-Null`, "powershell")
      : await exec(h, `mkdir -p "$HOME/.claude/skills/${spec.name}"`, "bash");
    if (!mk.ok) return { ...base, ok: false, result: mk, error: `skill dir: ${mk.stderr}` };
    const sk = await scp(h, fp.skillPath, dest);
    if (!sk.ok) return { ...base, ok: false, result: sk, error: `skill push: ${sk.stderr}` };
    skillPushed = true;
  }

  const manifest: ToolManifest = {
    tool: spec.name, version: fp.version, hash: fp.hash, dir,
    syncedAt: new Date().toISOString().slice(0, 19) + "Z",
    ...(fp.skillPath ? { skill: await fileHash(fp.skillPath) } : {}),
  };
  const { cmd, shell } = installScript(h, spec, dir, manifest, spec.bin ?? spec.name);
  const result = await exec(h, cmd, shell);
  return { ...base, ok: result.ok, result, skill: skillPushed, ...(result.ok ? {} : { error: result.stderr }) };
}

/** Windows home dir owner — scp needs a literal path for the skill push. */
async function winUser(h: Host): Promise<string> {
  const r = await exec(h, `$env:USERNAME`, "powershell");
  return r.ok ? r.stdout.trim() : "Admin";
}

export async function syncTool(
  cfg: FleetConfig, name: string, sel: string, opts: { skill?: boolean } = {},
): Promise<ToolSyncResult[]> {
  const spec = resolveTool(cfg, name);
  const fp = await fingerprint(cfg, name);
  const hosts = resolveHosts(cfg, sel);
  const tar = join(tmpdir(), `${name}-sync-${process.pid}.tgz`);
  const excludes = [...ALWAYS_EXCLUDE, ...(spec.exclude ?? [])].flatMap((e) => ["--exclude", e]);
  const build = Bun.spawn(["tar", "czf", tar, "-C", spec.root, ...excludes, "."],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdout: "ignore", stderr: "pipe" });
  if (await build.exited !== 0)
    throw new Error(`tarball build failed for ${name}: ${(await new Response(build.stderr).text()).trim()}`);
  try {
    return await Promise.all(hosts.map((h) => syncOne(cfg, spec, fp, h, tar, opts)));
  } finally {
    await Bun.spawn(["rm", "-f", tar]).exited;
  }
}

export interface MultiToolSyncResult {
  tool: string;
  results: ToolSyncResult[];
  error?: string;
}

/** Produce the exact structured stdout payload for tool sync. Multi-tool sync
 * keeps tool blocks so failures and registry order remain explicit. */
export function serializeToolSyncResults(blocks: MultiToolSyncResult[], grouped: boolean): string {
  return JSON.stringify(grouped ? blocks : (blocks[0]?.results ?? []), null, 2);
}

/** Sync tools concurrently without interleaving their presentation. The returned
 * blocks always follow registry/input order, even when tools finish in reverse. */
export async function syncTools(
  cfg: FleetConfig,
  names: string[],
  sel: string,
  opts: {
    skill?: boolean;
    maxParallel?: number;
    sync?: typeof syncTool;
  } = {},
): Promise<MultiToolSyncResult[]> {
  const sync = opts.sync ?? syncTool;
  return mapPool(names, opts.maxParallel ?? DEFAULT_TOOL_SYNC_PARALLELISM, async (tool) => {
    try {
      return { tool, results: await sync(cfg, tool, sel, { skill: opts.skill }) };
    } catch (error) {
      return { tool, results: [], error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** Validate the CLI-only multi-tool pool flag. */
export function toolSyncParallelism(toolCount: number, requested?: string): number {
  if (requested !== undefined && toolCount < 2)
    throw new Error("--max-parallel is only valid with multi-tool sync (`fleet tools sync --all`)");
  if (requested === undefined) return DEFAULT_TOOL_SYNC_PARALLELISM;
  const parsed = Number(requested);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`--max-parallel needs an integer ≥ 1 (got '${requested}')`);
  return parsed;
}

/** Stamp `version:`/`updated:` into a SKILL.md's YAML frontmatter, so a skill
 *  carries its own provenance wherever it ends up. Idempotent: re-stamping the
 *  same version rewrites nothing. Returns true when the file changed. */
export async function stampSkill(path: string, version: string, date: string): Promise<boolean> {
  const src = await Bun.file(path).text();
  const m = /^---\n([\s\S]*?)\n---\n/.exec(src);
  if (!m) throw new Error(`${basename(path)} has no YAML frontmatter to stamp`);
  let fm = m[1]!;
  const set = (key: string, value: string): void => {
    const re = new RegExp(`^${key}:.*$`, "m");
    if (re.test(fm)) fm = fm.replace(re, `${key}: ${value}`);
    // Insert after `name:` so the header reads name → version → updated → description.
    else if (/^name:.*$/m.test(fm)) fm = fm.replace(/^(name:.*)$/m, `$1\n${key}: ${value}`);
    else fm = `${key}: ${value}\n${fm}`;
  };
  // `updated` first so the later `version` insert lands above it: name → version → updated.
  set("updated", date);
  set("version", version);
  const out = `---\n${fm}\n---\n` + src.slice(m[0].length);
  if (out === src) return false;
  await Bun.write(path, out);
  return true;
}
