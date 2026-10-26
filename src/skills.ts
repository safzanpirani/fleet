/**
 * fleet skills — ship whole Agent Skill directories from the controller to
 * hosts, driven by the `skills` block of the config.
 *
 * `fleet tools` ships one SKILL.md beside each CLI tool; a name a tool ships is
 * excluded here and reported as owned by that tool, so two writers never fight
 * over one SKILL.md.
 *
 * Identity is a tree hash both sides can compute: sha256 of the sorted lines
 * `<file sha256>  <relative path>\n`, over regular files only (symlinks
 * followed), skipping node_modules, .git, .DS_Store and `._*` at any depth.
 * The controller computes it in TypeScript; hosts compute it in bash
 * (sha256sum or `shasum -a 256`) or PowerShell (Get-FileHash).
 *
 * Remote layout: the real copy lives in ~/.agents/skills/<name>. On Linux and
 * macOS ~/.claude/skills/<name> and ~/.openclaw/skills/<name> become relative
 * symlinks into it when missing; Windows gets copies there instead. An existing
 * symlink is left alone; an existing real directory is another managed copy.
 *
 * Each host keeps one manifest (~/.fleet-tools/skills/manifest.json) mapping
 * name → {hash, set, syncedAt}. It is read in the same round trip as the remote
 * tree hashes and written last by a sync. Sync never deletes a remote skill.
 */
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, copyFile } from "node:fs/promises";
import type { FleetConfig, Host, SkillSetSpec } from "./config.ts";
import { assertFeature, resolveHosts } from "./config.ts";
import { exec as sshExec, scp as sshScp } from "./ssh.ts";
import type { ExecResult } from "./ssh.ts";
import { didYouMean } from "./suggest.ts";
import { installLockScript } from "./install-lock.ts";
import { findSkill, mapPool, resolveTool } from "./tools.ts";

export const DEFAULT_SKILL_ROOT = "~/.agents/skills";
/** Remote agent roots, in the order a sync writes them. The first holds the real copy. */
export const SKILL_ROOTS = [".agents", ".claude", ".openclaw"] as const;
export type SkillRoot = (typeof SKILL_ROOTS)[number];
const FILE_IO_PARALLELISM = 16;
const SKILL_HASH_PARALLELISM = 4;
const DEFAULT_HOST_PARALLELISM = 8;
/** A skill name travels into remote shell code; keep it to this alphabet. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const expandHome = (p: string): string =>
  p.startsWith("~/") || p === "~" ? join(homedir(), p.slice(1)) : p;

/** Names never shipped or hashed, at any depth. */
export function skippedName(name: string): boolean {
  return name === "node_modules" || name === ".git" || name === ".DS_Store" || name.startsWith("._");
}

// ── controller side ──────────────────────────────────────────────────────────

/** Regular files under `dir`, following symlinks, skipping the fixed names.
 *  A directory that loops back to one of its ancestors is not entered again. */
export async function skillFiles(dir: string): Promise<{ rel: string; path: string }[]> {
  const out: { rel: string; path: string }[] = [];
  const visit = async (path: string, rel: string, ancestors: Set<string>): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (skippedName(entry.name)) continue;
      const child = join(path, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      let isDir = entry.isDirectory(), isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        const target = await stat(child).catch(() => null);
        if (!target) continue;   // broken link: nothing to ship
        isDir = target.isDirectory();
        isFile = target.isFile();
      }
      if (isDir) {
        const real = await realpath(child);
        if (ancestors.has(real)) continue;
        await visit(child, childRel, new Set([...ancestors, real]));
      } else if (isFile) out.push({ rel: childRel, path: child });
    }
  };
  await visit(dir, "", new Set([await realpath(dir)]));
  return out;
}

const sha256 = (bytes: Uint8Array | string): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** The tree hash of the header comment, computed on the controller. */
export async function treeHash(dir: string): Promise<{ hash: string; files: number }> {
  const files = await skillFiles(dir);
  const lines = await mapPool(files, FILE_IO_PARALLELISM, async ({ rel, path }) =>
    `${sha256(new Uint8Array(await Bun.file(path).arrayBuffer()))}  ${rel}\n`);
  // Byte order, as `LC_ALL=C sort` orders the remote lines.
  lines.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return { hash: sha256(lines.join("")), files: files.length };
}

export interface SkillSource {
  name: string;
  dir: string;      // controller directory (symlinks followed when shipped)
  hash: string;     // full sha256 tree hash
  files: number;
}
export interface SkillSelection {
  set: string;
  root: string;
  hosts: string;
  skills: SkillSource[];
  toolOwned: { name: string; tool: string }[];  // matched, but shipped by `fleet tools`
  invalid: string[];                           // matched, but the name is unsafe to ship
  unmatched: string[];                         // include patterns that matched no skill
}

export function resolveSkillSet(cfg: FleetConfig, set: string): SkillSetSpec {
  const spec = cfg.skills?.[set];
  if (spec) return spec;
  const known = Object.keys(cfg.skills ?? {});
  throw new Error(`unknown skill set '${set}'${known.length ? ` (have: ${known.join(", ")})${didYouMean(set, known)}` : " — no `skills` block in config"}`);
}

/** Skill names a `tools` entry ships: the tool's name, whenever the tool has a
 *  SKILL.md (a configured `skill` that is missing still claims the name). */
export async function toolOwnedSkills(cfg: FleetConfig): Promise<Map<string, string>> {
  const owned = new Map<string, string>();
  for (const name of Object.keys(cfg.tools ?? {})) {
    const spec = resolveTool(cfg, name);
    const path = await findSkill(spec).catch(() => "configured");
    if (path) owned.set(name, name);
  }
  return owned;
}

/** Resolve one set on the controller: skill dirs under root holding SKILL.md,
 *  kept by an include glob and not removed by an exclude glob, minus names a
 *  tool owns. Hashes each selected skill. */
export async function selectSkills(
  cfg: FleetConfig, set: string, deps: { toolOwned?: Map<string, string> } = {},
): Promise<SkillSelection> {
  const spec = resolveSkillSet(cfg, set);
  const root = expandHome(spec.root ?? DEFAULT_SKILL_ROOT);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error(`skills.${set}.root is not a directory: ${root}`);
  const owned = deps.toolOwned ?? await toolOwnedSkills(cfg);
  const include = spec.include.map((pattern) => ({ pattern, glob: new Bun.Glob(pattern), hit: false }));
  const exclude = (spec.exclude ?? []).map((pattern) => new Bun.Glob(pattern));
  const candidates: string[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (skippedName(entry.name)) continue;
    const dir = join(root, entry.name);
    // A symlinked skill dir is followed; its real contents are what ship.
    const target = entry.isSymbolicLink() ? await stat(dir).catch(() => null) : entry;
    if (!target?.isDirectory()) continue;
    if (!(await Bun.file(join(dir, "SKILL.md")).exists())) continue;
    candidates.push(entry.name);
  }
  const chosen: string[] = [], toolOwned: SkillSelection["toolOwned"] = [], invalid: string[] = [];
  for (const name of candidates) {
    const matched = include.filter((rule) => rule.glob.match(name));
    if (!matched.length) continue;
    for (const rule of matched) rule.hit = true;
    if (exclude.some((glob) => glob.match(name))) continue;
    const tool = owned.get(name);
    if (tool) { toolOwned.push({ name, tool }); continue; }
    if (!SKILL_NAME.test(name)) { invalid.push(name); continue; }
    chosen.push(name);
  }
  const skills = await mapPool(chosen, SKILL_HASH_PARALLELISM, async (name) => {
    const dir = join(root, name);
    return { name, dir, ...(await treeHash(dir)) };
  });
  return {
    set, root, hosts: spec.hosts, skills, toolOwned, invalid,
    unmatched: include.filter((rule) => !rule.hit).map((rule) => rule.pattern),
  };
}

// ── host side: inventory ─────────────────────────────────────────────────────

export interface SkillManifestEntry { hash: string; set: string; syncedAt: string }
export type SkillManifest = Record<string, SkillManifestEntry>;
export type CopyKind = "missing" | "dir" | "link" | "file";
export interface SkillCopy { root: SkillRoot; kind: CopyKind; hash?: string }
export interface HostInventory {
  manifest: SkillManifest;
  copies: Map<string, SkillCopy[]>;
  manifestError?: string;
}

const MANIFEST_POSIX = "$HOME/.fleet-tools/skills/manifest.json";
const MANIFEST_DIR_WIN = "$env:USERPROFILE\\.fleet-tools\\skills";

function shSingle(s: string): string { return `'${s.replace(/'/g, "'\\''")}'`; }
function psSingle(s: string): string { return `'${s.replace(/'/g, "''")}'`; }
function assertNames(names: readonly string[]): void {
  for (const name of names) if (!SKILL_NAME.test(name)) throw new Error(`invalid skill name '${name}'`);
}

/** POSIX tree hash: identical lines and order to `treeHash`. */
const POSIX_TREE_HASH = [
  `if command -v sha256sum >/dev/null 2>&1; then FLEET_SUM="sha256sum"; else FLEET_SUM="shasum -a 256"; fi`,
  `fleet_tree() { (cd "$1" 2>/dev/null && find -L . \\( -name node_modules -o -name .git -o -name '._*' -o -name .DS_Store \\) -prune -o -type f -exec $FLEET_SUM {} + | sed 's|  \\./|  |' | LC_ALL=C sort | $FLEET_SUM | cut -c1-64); }`,
].join("\n");

/** PowerShell tree hash. Lines sort ordinally (UTF-16 code units), which equals
 *  byte order for every path outside the astral planes. */
const PS_TREE_HASH = [
  `function Fleet-TreeLines([string]$dir, [string]$rel, $out) {`,
  `  foreach ($e in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {`,
  `    $n = $e.Name`,
  `    if ($n -eq 'node_modules' -or $n -eq '.git' -or $n -eq '.DS_Store' -or $n.StartsWith('._')) { continue }`,
  `    $r = if ($rel) { "$rel/$n" } else { $n }`,
  `    if ($e.PSIsContainer) { Fleet-TreeLines $e.FullName $r $out; continue }`,
  `    try { $h = (Get-FileHash -LiteralPath $e.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant(); $out.Add("$h  $r") } catch { }`,
  `  }`,
  `}`,
  `function Fleet-TreeHash([string]$dir) {`,
  `  $lines = New-Object System.Collections.Generic.List[string]`,
  `  Fleet-TreeLines $dir '' $lines`,
  `  $arr = $lines.ToArray()`,
  `  [Array]::Sort($arr, [StringComparer]::Ordinal)`,
  "  $text = -join ($arr | ForEach-Object { $_ + \"`n\" })",
  `  $sha = [System.Security.Cryptography.SHA256]::Create()`,
  `  $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]$text))`,
  `  -join ($bytes | ForEach-Object { $_.ToString('x2') })`,
  `}`,
].join("\n");

/** One round trip: every root's state and tree hash for `names`, then the
 *  manifest on one line. Output lines: `C\t<name>\t<root>\t<kind>\t<hash|->`
 *  and a final `M\t<manifest json>`. */
export function inventoryScript(h: Host, names: readonly string[]): { cmd: string; shell: "bash" | "powershell" } {
  assertNames(names);
  if (h.os === "windows") {
    return { shell: "powershell", cmd: [
      `# fleet-skills:read`,
      `$ErrorActionPreference='Continue'`,
      PS_TREE_HASH,
      `foreach ($name in @(${names.map(psSingle).join(", ")})) {`,
      `  foreach ($root in @(${SKILL_ROOTS.map(psSingle).join(", ")})) {`,
      `    $p = "$env:USERPROFILE\\$root\\skills\\$name"`,
      `    $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue`,
      `    $hash = '-'`,
      `    if (-not $item) { $kind = 'missing' }`,
      `    elseif ($item.LinkType) { $kind = 'link'; if ($root -eq '.agents' -and $item.PSIsContainer) { $hash = Fleet-TreeHash $p } }`,
      `    elseif ($item.PSIsContainer) { $kind = 'dir'; $hash = Fleet-TreeHash $p }`,
      `    else { $kind = 'file' }`,
      "    \"C`t$name`t$root`t$kind`t$hash\"",
      `  }`,
      `}`,
      `$mf = "${MANIFEST_DIR_WIN}\\manifest.json"`,
      `$m = ''`,
      `if (Test-Path -LiteralPath $mf) { $m = [System.IO.File]::ReadAllText($mf) -replace "[\`r\`n]", '' }`,
      "\"M`t$m\"",
    ].join("\n") };
  }
  return { shell: "bash", cmd: [
    `# fleet-skills:read`,
    `set +e`,
    POSIX_TREE_HASH,
    `for fleet_name in ${names.map(shSingle).join(" ")}; do`,
    `  for fleet_root in ${SKILL_ROOTS.join(" ")}; do`,
    `    p="$HOME/$fleet_root/skills/$fleet_name"; kind=missing; hash=-`,
    `    if [ -L "$p" ]; then kind=link; if [ "$fleet_root" = .agents ] && [ -d "$p" ]; then hash="$(fleet_tree "$p")"; fi`,
    `    elif [ -d "$p" ]; then kind=dir; hash="$(fleet_tree "$p")"`,
    `    elif [ -e "$p" ]; then kind=file; fi`,
    `    printf 'C\\t%s\\t%s\\t%s\\t%s\\n' "$fleet_name" "$fleet_root" "$kind" "\${hash:--}"`,
    `  done`,
    `done`,
    `printf 'M\\t'; [ -f "${MANIFEST_POSIX}" ] && tr -d '\\r\\n' < "${MANIFEST_POSIX}"; echo`,
  ].join("\n") };
}

export function parseInventory(stdout: string): HostInventory {
  const copies = new Map<string, SkillCopy[]>();
  let manifest: SkillManifest = {};
  let manifestError: string | undefined;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("C\t")) {
      const [, name, root, kind, hash] = line.split("\t");
      if (!name || !SKILL_ROOTS.includes(root as SkillRoot) || !["missing", "dir", "link", "file"].includes(kind!)) continue;
      const list = copies.get(name) ?? [];
      list.push({ root: root as SkillRoot, kind: kind as CopyKind, ...(hash && /^[0-9a-f]{64}$/.test(hash) ? { hash } : {}) });
      copies.set(name, list);
    } else if (line.startsWith("M\t")) {
      const text = line.slice(2).trim();
      if (!text) continue;
      try {
        const parsed = JSON.parse(text) as { skills?: unknown };
        if (!parsed || typeof parsed.skills !== "object" || parsed.skills === null) throw new Error("no skills object");
        manifest = parsed.skills as SkillManifest;
      } catch (error) {
        // An unreadable manifest is treated as empty: every differing copy then
        // counts as unmanaged and is refused without --force.
        manifestError = `unreadable skills manifest: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  return { manifest, copies, ...(manifestError ? { manifestError } : {}) };
}

// ── verdicts ─────────────────────────────────────────────────────────────────

export type SkillState = "current" | "stale" | "drifted" | "unmanaged" | "missing" | "orphan" | "unreachable";
/** The states one selected skill on a reachable host can take. */
export type SkillVerdict = Exclude<SkillState, "orphan" | "unreachable">;
const RANK: Record<SkillVerdict, number> = { current: 0, missing: 1, stale: 2, unmanaged: 3, drifted: 4 };

/** One skill on one host. Each managed copy (the ~/.agents copy, plus any real
 *  directory under the other roots) is judged on its own and the worst wins:
 *  equal to source → current; equal to the manifest → stale (safe to update);
 *  a manifest entry it differs from → drifted (edited there); no entry →
 *  unmanaged. A missing ~/.agents copy is missing; a missing link or copy under
 *  another root, beside a present ~/.agents copy, is stale. Symlinks under the
 *  other roots are left alone and not judged. */
export function judgeSkill(
  source: string, manifestHash: string | undefined, copies: readonly SkillCopy[],
): SkillVerdict {
  const agents = copies.find((copy) => copy.root === ".agents");
  const agentsPresent = !!agents && agents.kind !== "missing";
  let state: SkillVerdict = agentsPresent ? "current" : "missing";
  const worse = (next: SkillVerdict) => { if (RANK[next] > RANK[state]) state = next; };
  for (const root of SKILL_ROOTS) {
    const copy = copies.find((c) => c.root === root) ?? { root, kind: "missing" as const };
    if (copy.kind === "missing") { if (root !== ".agents") worse(agentsPresent ? "stale" : "missing"); continue; }
    if (copy.kind === "link" && root !== ".agents") continue;
    const remote = copy.kind === "file" ? undefined : copy.hash;
    worse(remote === source ? "current"
      : manifestHash !== undefined && remote === manifestHash ? "stale"
        : manifestHash !== undefined ? "drifted" : "unmanaged");
  }
  return state;
}

export interface SkillStatusRow {
  set: string;
  skill: string;
  host: string;
  state: SkillState;
  source?: string;              // controller tree hash
  manifest?: SkillManifestEntry;
  copies?: SkillCopy[];
  adopt?: boolean;              // current, but the manifest does not record it yet
  error?: string;
}

function hostParallelism(cfg: FleetConfig): number {
  return cfg.defaults?.parallel?.toolStatusHosts ?? DEFAULT_HOST_PARALLELISM;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SkillsDeps {
  exec?: typeof sshExec;
  scp?: typeof sshScp;
  /** Turn a selector into one resolveHosts accepts (the CLI resolves routes). */
  resolveSelector?: (sel: string) => Promise<string>;
  toolOwned?: Map<string, string>;
}

async function readInventory(
  h: Host, names: readonly string[], run: typeof sshExec,
): Promise<{ inventory?: HostInventory; error?: string }> {
  const { cmd, shell } = inventoryScript(h, names);
  try {
    const r = await run(h, cmd, shell);
    if (!r.ok) return { error: r.stderr.trim() || `exit ${r.code}` };
    return { inventory: parseInventory(r.stdout) };
  } catch (error) {
    return { error: errorText(error) };
  }
}

function rowsFor(set: string, host: string, skills: readonly SkillSource[], inv: HostInventory): SkillStatusRow[] {
  return skills.map((skill) => {
    const entry = inv.manifest[skill.name];
    const copies = inv.copies.get(skill.name) ?? [];
    const state = judgeSkill(skill.hash, entry?.hash, copies);
    const adopt = state === "current" && (entry?.hash !== skill.hash || entry.set !== set);
    return {
      set, skill: skill.name, host, state, source: skill.hash, copies,
      ...(entry ? { manifest: entry } : {}), ...(adopt ? { adopt } : {}),
      ...(inv.manifestError ? { error: inv.manifestError } : {}),
    };
  });
}

/** Manifest entries on a host that no set selects any more: their set is gone
 *  from the config, or it no longer selects the name. Reported, never deleted. */
function orphanRows(
  host: string, inv: HostInventory, selections: ReadonlyMap<string, SkillSelection>, includeUnknownSets: boolean,
): SkillStatusRow[] {
  const rows: SkillStatusRow[] = [];
  for (const [skill, entry] of Object.entries(inv.manifest)) {
    const selection = selections.get(entry.set);
    if (selection ? selection.skills.some((s) => s.name === skill) : !includeUnknownSets) continue;
    rows.push({ set: entry.set, skill, host, state: "orphan", manifest: entry });
  }
  return rows;
}

/** Sets × hosts × skills. Each host is read once, however many sets target it.
 *  With no selector each set checks its own `hosts`. */
export async function skillsStatus(
  cfg: FleetConfig, sets: string[], sel?: string, deps: SkillsDeps = {},
): Promise<SkillStatusRow[]> {
  const run = deps.exec ?? sshExec;
  const resolveSel = deps.resolveSelector ?? (async (s: string) => s);
  const toolOwned = deps.toolOwned ?? await toolOwnedSkills(cfg);
  const selections = await mapPool(sets, SKILL_HASH_PARALLELISM, (set) => selectSkills(cfg, set, { toolOwned }));
  const bySet = new Map(selections.map((s) => [s.set, s]));
  const targets = new Map<string, Host[]>();
  for (const set of sets) targets.set(set, resolveHosts(cfg, await resolveSel(sel ?? resolveSkillSet(cfg, set).hosts)));
  const hosts: Host[] = [];
  const names = new Map<string, Set<string>>();
  for (const selection of selections)
    for (const host of targets.get(selection.set) ?? []) {
      if (!names.has(host.name)) { names.set(host.name, new Set()); hosts.push(host); }
      for (const skill of selection.skills) names.get(host.name)!.add(skill.name);
    }
  const reads = await mapPool(hosts, hostParallelism(cfg), (host) => readInventory(host, [...names.get(host.name)!], run));
  const byHost = new Map(hosts.map((host, i) => [host.name, reads[i]!]));
  const allSets = Object.keys(cfg.skills ?? {}).every((set) => bySet.has(set));
  const rows: SkillStatusRow[] = [];
  for (const selection of selections)
    for (const host of targets.get(selection.set) ?? []) {
      const read = byHost.get(host.name)!;
      if (!read.inventory) {
        rows.push(...selection.skills.map((skill) => ({
          set: selection.set, skill: skill.name, host: host.name, state: "unreachable" as const, source: skill.hash, error: read.error,
        })));
        continue;
      }
      rows.push(...rowsFor(selection.set, host.name, selection.skills, read.inventory));
    }
  for (const host of hosts) {
    const inv = byHost.get(host.name)!.inventory;
    if (inv) rows.push(...orphanRows(host.name, inv, bySet, allSets));
  }
  return rows;
}

// ── sync ─────────────────────────────────────────────────────────────────────

export type SkillAction = "apply" | "keep" | "adopt" | "held";
export interface SkillSyncItem {
  skill: string;
  state: SkillState;
  action: SkillAction;
  ok?: boolean;        // set for applied skills once the host answered
  reason?: string;     // why a skill was held
  error?: string;
}
export interface SkillSyncHostResult {
  set: string;
  host: string;
  ok: boolean;
  dryRun: boolean;
  items: SkillSyncItem[];
  orphans: string[];
  error?: string;
}

const HOLD_REASON: Record<string, string> = {
  drifted: "edited on the host since the last sync (differs from both the manifest and the source); --force overwrites it",
  unmanaged: "exists on the host without a fleet manifest entry and differs from the source; --force overwrites it",
};

/** What a sync does with each selected skill on one host. */
export function planSkills(rows: readonly SkillStatusRow[], force: boolean): SkillSyncItem[] {
  return rows.map((row) => {
    if (row.state === "current") return { skill: row.skill, state: row.state, action: row.adopt ? "adopt" : "keep" };
    if ((row.state === "drifted" || row.state === "unmanaged") && !force)
      return { skill: row.skill, state: row.state, action: "held", reason: HOLD_REASON[row.state] };
    return { skill: row.skill, state: row.state, action: "apply" };
  });
}

export interface ApplyOp { name: string; roots: { root: SkillRoot; op: "copy" | "link" }[]; next: string; previous?: string }

/** The roots one applied skill writes: the ~/.agents copy always; another root
 *  gets a POSIX link (copy on Windows) when missing, a fresh copy when it holds
 *  a real directory or file, and nothing when it is a symlink. */
function applyRoots(h: Host, copies: readonly SkillCopy[]): ApplyOp["roots"] {
  return SKILL_ROOTS.flatMap((root): ApplyOp["roots"] => {
    if (root === ".agents") return [{ root, op: "copy" as const }];
    const kind = copies.find((c) => c.root === root)?.kind ?? "missing";
    if (kind === "link") return [];
    if (kind === "missing" && h.os !== "windows") return [{ root, op: "link" as const }];
    return [{ root, op: "copy" as const }];
  });
}

const entryJson = (name: string, entry: SkillManifestEntry): string =>
  `${JSON.stringify(name)}:${JSON.stringify({ hash: entry.hash, set: entry.set, syncedAt: entry.syncedAt })}`;

/** Extract the archive, swap each skill in (old aside, new in, old removed),
 *  then write the manifest last. A failed skill keeps its previous manifest
 *  entry and does not stop the others. Prints `OK\t<name>`, `FAIL\t<name>\t<why>`
 *  and finally `MANIFEST`. */
export function applyScript(
  h: Host, token: string, archive: string | undefined, ops: readonly ApplyOp[], kept: readonly string[],
): { cmd: string; shell: "bash" | "powershell" } {
  if (!/^[a-z0-9-]+$/.test(token)) throw new Error("invalid sync token");
  if (archive && !/^[a-z0-9.-]+$/.test(archive)) throw new Error("invalid sync archive");
  assertNames(ops.map((op) => op.name));
  if (h.os === "windows") {
    const lines = [
      `# fleet-skills:apply`,
      `$ErrorActionPreference='Stop'`,
      `$T='${token}'`,
      `$mfDir="${MANIFEST_DIR_WIN}"`,
      `$stage="$mfDir\\stage-$T"`,
      `New-Item -ItemType Directory -Force -Path $stage | Out-Null`,
      ...(archive ? [
        `tar -xzf "$env:USERPROFILE\\${archive}" -C $stage`,
        `if ($LASTEXITCODE -ne 0) { throw "tar extraction failed with exit $LASTEXITCODE" }`,
      ] : []),
      `function Fleet-Remove([string]$p) {`,
      `  $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue`,
      `  if (-not $i) { return }`,
      // Remove-Item -Recurse on a directory link deletes the target's files.
      `  if ($i.LinkType -and $i.PSIsContainer) { [System.IO.Directory]::Delete($p) }`,
      `  elseif ($i.PSIsContainer) { Remove-Item -LiteralPath $p -Recurse -Force }`,
      `  else { Remove-Item -LiteralPath $p -Force }`,
      `}`,
      `function Fleet-Swap([string]$root, [string]$name) {`,
      `  New-Item -ItemType Directory -Force -Path $root | Out-Null`,
      `  $d = Join-Path $root $name; $n = "$d.fleet-new-$T"; $o = "$d.fleet-old-$T"`,
      `  Fleet-Remove $n`,
      `  Copy-Item -LiteralPath (Join-Path $stage $name) -Destination $n -Recurse`,
      `  $had = [bool](Get-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue)`,
      `  if ($had) { Move-Item -LiteralPath $d -Destination $o }`,
      `  try { Move-Item -LiteralPath $n -Destination $d } catch { if ($had) { Move-Item -LiteralPath $o -Destination $d }; Fleet-Remove $n; throw }`,
      `  if ($had) { Fleet-Remove $o }`,
      `}`,
      `$entries = New-Object System.Collections.Generic.List[string]`,
      ...kept.map((entry) => `$entries.Add(${psSingle(entry)})`),
      ...ops.flatMap((op) => [
        `try {`,
        ...op.roots.map(({ root }) => `  Fleet-Swap "$env:USERPROFILE\\${root}\\skills" ${psSingle(op.name)}`),
        `  $entries.Add(${psSingle(op.next)})`,
        `  "OK\`t${op.name}"`,
        `} catch {`,
        "  $why = $_.Exception.Message -replace \"[`r`n`t]\", ' '",
        `  "FAIL\`t${op.name}\`t$why"`,
        ...(op.previous ? [`  $entries.Add(${psSingle(op.previous)})`] : []),
        `}`,
      ]),
      `$json = '{"version":1,"skills":{' + ($entries -join ',') + '}}'`,
      `$tmp = "$mfDir\\manifest.json.tmp-$T"`,
      `[System.IO.File]::WriteAllText($tmp, $json)`,
      `Move-Item -LiteralPath $tmp -Destination "$mfDir\\manifest.json" -Force`,
      `Fleet-Remove $stage`,
      `"MANIFEST"`,
    ];
    return { shell: "powershell", cmd: lines.join("\n") };
  }
  const lines = [
    `# fleet-skills:apply`,
    `T='${token}'`,
    `mf="${MANIFEST_POSIX}"`,
    `stage="$HOME/.fleet-tools/skills/stage-$T"`,
    `mkdir -p "$stage" || exit 1`,
    ...(archive ? [`tar -xzf "$HOME/${archive}" -C "$stage" || { echo "tar extraction failed" >&2; rm -rf "$stage"; exit 1; }`] : []),
    // No set -e: it is ignored inside an `if` condition, so every step chains.
    `fleet_swap() {`,
    `  d="$1/$2"; n="$d.fleet-new-$T"; o="$d.fleet-old-$T"; had=`,
    `  mkdir -p "$1" && rm -rf "$n" && cp -R "$stage/$2" "$n" || return 1`,
    `  if [ -e "$d" ] || [ -L "$d" ]; then mv "$d" "$o" || { rm -rf "$n"; return 1; }; had=1; fi`,
    `  if ! mv "$n" "$d"; then [ -z "$had" ] || mv "$o" "$d"; rm -rf "$n"; return 1; fi`,
    `  [ -z "$had" ] || rm -rf "$o"`,
    `}`,
    `fleet_link() { mkdir -p "$1" || return 1; [ -e "$1/$2" ] || [ -L "$1/$2" ] || ln -s "../../.agents/skills/$2" "$1/$2"; }`,
    `E=${shSingle(kept.join(","))}`,
    ...ops.flatMap((op) => [
      `if fleet_out=$( { ${op.roots.map(({ root, op: kind }) => `fleet_${kind === "copy" ? "swap" : "link"} "$HOME/${root}/skills" ${shSingle(op.name)}`).join(" && ")}; } 2>&1 ); then`,
      `  printf 'OK\\t%s\\n' ${shSingle(op.name)}; E="\${E:+$E,}"${shSingle(op.next)}`,
      `else`,
      `  printf 'FAIL\\t%s\\t%s\\n' ${shSingle(op.name)} "$(printf '%s' "$fleet_out" | tr '\\n\\t' '  ')"${op.previous ? `; E="\${E:+$E,}"${shSingle(op.previous)}` : ""}`,
      `fi`,
    ]),
    `printf '{"version":1,"skills":{%s}}\\n' "$E" > "$mf.tmp-$T" && mv "$mf.tmp-$T" "$mf" || { echo "skills manifest write failed" >&2; rm -rf "$stage"; exit 1; }`,
    `rm -rf "$stage"`,
    `echo MANIFEST`,
  ];
  return { shell: "bash", cmd: lines.join("\n") };
}

function parseApply(stdout: string): { ok: Set<string>; failed: Map<string, string>; manifest: boolean } {
  const ok = new Set<string>(), failed = new Map<string, string>();
  let manifest = false;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("OK\t")) ok.add(line.slice(3));
    else if (line.startsWith("FAIL\t")) {
      const [, name, why] = line.split("\t");
      if (name) failed.set(name, (why ?? "").trim() || "failed");
    } else if (line === "MANIFEST") manifest = true;
  }
  return { ok, failed, manifest };
}

/** Copy the selected skills into a private snapshot (symlinks followed, the
 *  fixed names skipped), hash the snapshot, and tar it once. Every host then
 *  receives the same bytes the manifest describes. */
async function snapshot(selection: SkillSelection, stage: string): Promise<{ skills: SkillSource[]; tar: string }> {
  const source = join(stage, "source");
  await mkdir(source);
  const skills = await mapPool(selection.skills, SKILL_HASH_PARALLELISM, async (skill) => {
    const into = join(source, skill.name);
    await mkdir(into, { recursive: true });
    const files = await skillFiles(skill.dir);
    await mapPool(files, FILE_IO_PARALLELISM, async ({ rel, path }) => {
      const to = join(into, rel);
      await mkdir(join(to, ".."), { recursive: true });
      await copyFile(path, to);
      await chmod(to, (await stat(path)).mode & 0o777);
    });
    return { ...skill, ...(await treeHash(into)) };
  });
  const tar = join(stage, "skills.tgz");
  const build = Bun.spawn(["tar", "czf", tar, ...(process.platform === "darwin" ? ["--no-xattrs"] : []),
    "-C", source, ...skills.map((s) => s.name)],
  { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  if (code !== 0) throw new Error(`skills archive build failed for set ${selection.set}: ${stderr.trim()}`);
  return { skills, tar };
}

async function syncHost(
  cfg: FleetConfig, set: string, h: Host, skills: readonly SkillSource[], tar: string | undefined,
  selections: ReadonlyMap<string, SkillSelection>, opts: { force: boolean; dryRun: boolean },
  run: typeof sshExec, push: typeof sshScp,
): Promise<SkillSyncHostResult> {
  const base = { set, host: h.name, dryRun: opts.dryRun };
  const names = skills.map((s) => s.name);
  const fail = (error: string, items: SkillSyncItem[] = [], orphans: string[] = []): SkillSyncHostResult =>
    ({ ...base, ok: false, items, orphans, error });
  const allSets = Object.keys(cfg.skills ?? {}).every((name) => selections.has(name));
  const orphansOf = (inv: HostInventory) => orphanRows(h.name, inv, selections, allSets)
    .filter((row) => row.set === set || !cfg.skills?.[row.set]).map((row) => row.skill);

  if (opts.dryRun) {
    const read = await readInventory(h, names, run);
    if (!read.inventory) return fail(read.error ?? "unreachable");
    const items = planSkills(rowsFor(set, h.name, skills, read.inventory), opts.force);
    return { ...base, ok: !items.some((i) => i.action === "held"), items, orphans: orphansOf(read.inventory) };
  }

  const token = crypto.randomUUID();
  const lockDir = h.os === "windows" ? "$env:USERPROFILE\\.agents\\skills" : "$HOME/.agents/skills";
  const lock = installLockScript(h, lockDir, token);
  const read = inventoryScript(h, names);
  let locked: ExecResult;
  try { locked = await run(h, `${lock.cmd}\n${read.cmd}`, lock.shell); }
  catch (error) { return fail(errorText(error)); }
  if (!locked.ok) return fail(locked.stderr.trim() || `skills sync lock failed (exit ${locked.code})`);
  const inv = parseInventory(locked.stdout);
  const items = planSkills(rowsFor(set, h.name, skills, inv), opts.force);
  const orphans = orphansOf(inv);
  const applying = items.filter((i) => i.action === "apply");
  const recording = items.filter((i) => i.action === "apply" || i.action === "adopt").map((i) => i.skill);
  const archive = applying.length && tar ? `fleet-skills-${token}.tgz` : undefined;
  let error: string | undefined;
  let retainLock = false;

  if (recording.length) {
    const syncedAt = new Date().toISOString().slice(0, 19) + "Z";
    const byName = new Map(skills.map((s) => [s.name, s]));
    const kept = Object.entries(inv.manifest).filter(([name]) => !recording.includes(name))
      .map(([name, entry]) => entryJson(name, entry));
    const adopted = items.filter((i) => i.action === "adopt")
      .map((i) => entryJson(i.skill, { hash: byName.get(i.skill)!.hash, set, syncedAt }));
    const ops: ApplyOp[] = applying.map((i) => ({
      name: i.skill,
      roots: applyRoots(h, inv.copies.get(i.skill) ?? []),
      next: entryJson(i.skill, { hash: byName.get(i.skill)!.hash, set, syncedAt }),
      ...(inv.manifest[i.skill] ? { previous: entryJson(i.skill, inv.manifest[i.skill]!) } : {}),
    }));
    try {
      if (archive) {
        const pushed = await push(h, tar!, archive);
        if (!pushed.ok) throw new Error(`scp failed: ${pushed.stderr.trim() || `exit ${pushed.code}`}`);
      }
      const script = applyScript(h, token, archive, ops, [...kept, ...adopted]);
      let result: ExecResult;
      try { result = await run(h, script.cmd, script.shell); }
      catch (e) { result = { host: h.name, ok: false, code: 255, stdout: "", stderr: errorText(e) }; }
      const parsed = parseApply(result.stdout);
      for (const item of applying) {
        if (parsed.ok.has(item.skill)) item.ok = true;
        else { item.ok = false; item.error = parsed.failed.get(item.skill) ?? "not applied"; }
      }
      if (!result.ok || !parsed.manifest) {
        error = result.stderr.trim() || `skills apply failed (exit ${result.code})`;
        if (result.code === 124 || result.code === 255) {
          retainLock = true;
          error += `; outcome unconfirmed; installation lock retained; inspect ~/.agents/skills and archive ${archive ?? "(none)"} before removing the lock`;
        }
      }
    } catch (e) {
      error = errorText(e);
      for (const item of applying) { item.ok = false; item.error ??= "not applied"; }
    }
  }

  if (!retainLock) {
    const release = installLockScript(h, lockDir, token, true, archive);
    try {
      const cleaned = await run(h, release.cmd, release.shell);
      if (!cleaned.ok) error = [error, `skills sync cleanup: ${cleaned.stderr.trim() || `exit ${cleaned.code}`}`].filter(Boolean).join("; ");
    } catch (e) {
      error = [error, `skills sync cleanup: ${errorText(e)}`].filter(Boolean).join("; ");
    }
  }
  const ok = !error && items.every((i) => i.action !== "held" && i.ok !== false);
  return { ...base, ok, items, orphans, ...(error ? { error } : {}) };
}

/** Push one set to its hosts (or `sel`). Refuses before any skill is read or
 *  written when `deploy` is disabled on a target. Drifted or unmanaged skills
 *  are held back alone unless `force`; the rest still apply. */
export async function syncSkills(
  cfg: FleetConfig, set: string, sel: string | undefined,
  opts: { force?: boolean; dryRun?: boolean } = {}, deps: SkillsDeps = {},
): Promise<SkillSyncHostResult[]> {
  const spec = resolveSkillSet(cfg, set);
  const run = deps.exec ?? sshExec;
  const push = deps.scp ?? sshScp;
  const resolveSel = deps.resolveSelector ?? (async (s: string) => s);
  const hosts = resolveHosts(cfg, await resolveSel(sel ?? spec.hosts));
  assertFeature(hosts, "deploy", cfg);
  const toolOwned = deps.toolOwned ?? await toolOwnedSkills(cfg);
  const selection = await selectSkills(cfg, set, { toolOwned });
  // Orphans are judged against every configured set's current selection.
  const selections = new Map<string, SkillSelection>([[set, selection]]);
  // A set whose root cannot be read is left out: its entries are then not judged.
  for (const other of Object.keys(cfg.skills ?? {})) {
    if (other === set) continue;
    const resolved = await selectSkills(cfg, other, { toolOwned }).catch(() => undefined);
    if (resolved) selections.set(other, resolved);
  }
  const flags = { force: opts.force === true, dryRun: opts.dryRun === true };
  if (flags.dryRun || !selection.skills.length) {
    return mapPool(hosts, hostParallelism(cfg), (h) =>
      syncHost(cfg, set, h, selection.skills, undefined, selections, { ...flags, dryRun: true }, run, push))
      .then((results) => flags.dryRun ? results : results.map((r) => ({ ...r, dryRun: false })));
  }
  const stage = await mkdtemp(join(tmpdir(), "fleet-skills-sync-"));
  try {
    const { skills, tar } = await snapshot(selection, stage);
    selections.set(set, { ...selection, skills });
    return await mapPool(hosts, hostParallelism(cfg), (h) => syncHost(cfg, set, h, skills, tar, selections, flags, run, push));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
