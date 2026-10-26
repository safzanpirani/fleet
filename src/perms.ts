/**
 * Controller-side permission checks. The config decides what runs where, so a
 * config another user can write is someone else's code running as you; ssh
 * refuses a writable ~/.ssh/config for the same reason. Password files hold
 * credentials and must be private. Fleet's own state under ~/.fleet and the
 * images it captures are made private when created.
 *
 * Mode bits mean nothing on a Windows controller, so every check is skipped there.
 */
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, statSync,
} from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

/** What the checks read from the filesystem and the process, injectable for tests. */
export interface PermDeps {
  stat?: (path: string) => { mode: number; uid: number };
  lstat?: (path: string) => { isSymbolicLink(): boolean };
  readlink?: (path: string) => string;
  realpath?: (path: string) => string;
  /** Opens without following a final symlink where the platform can. */
  open?: (path: string) => number;
  fstat?: (fd: number) => { mode: number; uid: number };
  read?: (fd: number) => Uint8Array;
  close?: (fd: number) => void;
  uid?: number;
  platform?: NodeJS.Platform;
}

const octal = (mode: number) => (mode & 0o7777).toString(8).padStart(3, "0");
const currentUid = (deps: PermDeps) => deps.uid ?? process.getuid?.();
const skipChecks = (deps: PermDeps) => (deps.platform ?? process.platform) === "win32";
const openNoFollow = (path: string) => openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
const otherWritable = (mode: number) => (mode & 0o002) !== 0 && (mode & 0o1000) === 0;
/** Hops before a symlink chain counts as a loop, as Linux's ELOOP limit. */
const MAX_LINK_HOPS = 40;

/** Reads the config at `path` and returns its text, throwing when another user
 *  could have written it: its real file is group- or other-writable or owned by
 *  someone other than you or root, or its real directory, or the directory of
 *  any symlink on the way to it, is other-writable without the sticky bit.
 *  The path is resolved once; the real file is opened once without following a
 *  final link, and both the owner and mode check and the returned text come
 *  from that one descriptor, so a file swapped in after the check is never read. */
export function readTrustedConfig(path: string, deps: PermDeps = {}): string {
  const open = deps.open ?? openNoFollow;
  const read = deps.read ?? ((fd: number) => readFileSync(fd));
  const close = deps.close ?? closeSync;
  const decode = (fd: number) => new TextDecoder().decode(read(fd));
  if (skipChecks(deps)) {
    const fd = open(path);
    try { return decode(fd); } finally { close(fd); }
  }
  const stat = deps.stat ?? statSync, lstat = deps.lstat ?? lstatSync;
  const readlink = deps.readlink ?? ((p: string) => readlinkSync(p, "utf8"));
  const realpath = deps.realpath ?? realpathSync;
  // Walk the chain by hand so the directory holding each link is known.
  const linkDirs: string[] = [];
  let real = resolve(path);
  for (let hops = 0; ; hops++) {
    const dir = realpath(dirname(real));
    real = join(dir, basename(real));
    if (!lstat(real).isSymbolicLink()) break;
    if (hops === MAX_LINK_HOPS) throw new Error(`refusing to load fleet config ${path}: more than ${MAX_LINK_HOPS} symlinks`);
    linkDirs.push(dir);
    real = resolve(dir, readlink(real));
  }
  const shown = real === path ? real : `${path} (-> ${real})`;
  const refuse = (why: string, fix: string): never => {
    throw new Error(`refusing to load fleet config ${shown}: ${why}. The config decides what fleet runs on every host, `
      + `so another user who can change it can run commands as you. Fix: ${fix}`);
  };
  const dir = dirname(real);
  const ds = stat(dir);
  if (otherWritable(ds.mode))
    refuse(`its directory ${dir} is writable by every user without the sticky bit (mode ${octal(ds.mode)}), so anyone can replace it`,
      `chmod o-w ${dir}`);
  for (const linkDir of new Set(linkDirs)) {
    if (linkDir === dir) continue;
    const ls = stat(linkDir);
    if (otherWritable(ls.mode))
      refuse(`its path goes through a symlink in ${linkDir}, which is writable by every user without the sticky bit `
        + `(mode ${octal(ls.mode)}), so anyone can point it elsewhere`, `chmod o-w ${linkDir}`);
  }
  let fd: number;
  try { fd = open(real); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
    return refuse(`it was replaced by a symlink while fleet was checking it`, `check who can write ${dir}, then run the command again`);
  }
  try {
    const st = (deps.fstat ?? fstatSync)(fd);
    if (st.mode & 0o022) refuse(`it is group- or other-writable (mode ${octal(st.mode)})`, `chmod go-w ${real}`);
    const uid = currentUid(deps);
    if (uid !== undefined && st.uid !== uid && st.uid !== 0)
      refuse(`it is owned by uid ${st.uid}, not by you (uid ${uid}) or root`, `chown ${uid} ${real}`);
    return decode(fd);
  } finally { close(fd); }
}

/** Throws when a password file is readable or writable by anyone but you, or
 *  owned by another user. Called before the file is read, so a refused file's
 *  contents never enter the process. `label` names the setting in messages. */
export function assertPrivateSecret(path: string, label: string, deps: PermDeps = {}): void {
  if (skipChecks(deps)) return;
  const st = (deps.stat ?? statSync)(path);
  if (st.mode & 0o077)
    throw new Error(`${label} ${path} is accessible to other users (mode ${octal(st.mode)}); fix: chmod 600 ${path}`);
  const uid = currentUid(deps);
  if (uid !== undefined && st.uid !== uid)
    throw new Error(`${label} ${path} is owned by uid ${st.uid}, not by you (uid ${uid}); fix: chown ${uid} ${path} && chmod 600 ${path}`);
}

const tightened = new Set<string>();

/** Create `dir` (and missing parents) as 0700, and narrow an existing wider
 *  directory you own to 0700 once per process. Only fleet uses these
 *  directories. Never throws: callers that need the directory fail on their own. */
export function ensurePrivateDir(dir: string, deps: PermDeps = {}): void {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return; }
  if (skipChecks(deps) || tightened.has(dir)) return;
  tightened.add(dir);
  try {
    const st = (deps.stat ?? statSync)(dir);
    const uid = currentUid(deps);
    if ((st.mode & 0o077) && (uid === undefined || st.uid === uid)) chmodSync(dir, 0o700);
  } catch { /* best-effort: a wider directory still works */ }
}

/** `~/.fleet`, or a directory below it, private (see ensurePrivateDir). */
export function fleetStateDir(...sub: string[]): string {
  const root = join(homedir(), ".fleet");
  ensurePrivateDir(root);
  if (!sub.length) return root;
  const dir = join(root, ...sub);
  ensurePrivateDir(dir);
  return dir;
}

/** Write a file readable only by you. The chmod covers a file that already
 *  existed, whose mode `writeFile` would otherwise keep. */
export async function writePrivateFile(path: string, data: string | Uint8Array): Promise<void> {
  await writeFile(path, data, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
}
