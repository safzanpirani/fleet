/** Opt-in, target-side spike. Nothing in Fleet's normal execution path imports this. */
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Request {
  id: string;
  argv: string[];
  cwd: string;
}
export type Outcome =
  | { id: string; state: "absent"; retry: "same-request" }
  | { id: string; state: "prepared"; retry: "same-request" }
  | { id: string; state: "indeterminate"; retry: "never"; stdout: string; stderr: string }
  | { id: string; state: "completed"; retry: "replay-only"; code: number; stdout: string; stderr: string }
  | { id: string; state: "not-started"; retry: "replay-only"; error: string };
export type Phase = "admitted" | "dispatching" | "spawned" | "exited" | "completed";
interface Row {
  fingerprint: string;
  state: "prepared" | "dispatching" | "completed" | "not-started";
  code: number | null;
  error: string | null;
}

function openLedger(root: string): Database {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = statSync(root);
  if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error("safe-exec: --spool must be a private, caller-owned directory (0700)");
  }
  const path = join(root, "ledger.sqlite");
  closeSync(openSync(path, "a", 0o600));
  const db = new Database(path);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  db.exec(`CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatching', 'completed', 'not-started')),
    code INTEGER, error TEXT
  )`);
  return db;
}

function rowFor(db: Database, id: string): Row | null {
  return db.query("SELECT fingerprint, state, code, error FROM requests WHERE id = ?").get(id) as Row | null;
}

function outcome(root: string, id: string, row: Row | null): Outcome {
  if (!row) return { id, state: "absent", retry: "same-request" };
  if (row.state === "prepared") return { id, state: "prepared", retry: "same-request" };
  if (row.state === "not-started") return { id, state: "not-started", retry: "replay-only", error: row.error! };
  const key = createHash("sha256").update(id).digest("hex");
  const output = { stdout: join(root, `${key}.out`), stderr: join(root, `${key}.err`) };
  if (row.state === "completed") return { id, state: "completed", retry: "replay-only", code: row.code!, ...output };
  // Includes a live command: without a durable completion, death/liveness cannot prove its effects.
  return { id, state: "indeterminate", retry: "never", ...output };
}

export function status(spool: string, id: string): Outcome {
  const root = resolve(spool);
  const db = openLedger(root);
  try { return outcome(root, id, rowFor(db, id)); } finally { db.close(); }
}

/** Repeating an ID never launches its command twice, even across independent brokers.
 * onPhase is the failure-injection seam; omitted in normal opt-in use. */
export async function submit(
  spool: string, request: Request, onPhase?: (phase: Phase) => void | Promise<void>,
): Promise<Outcome> {
  if (!request.id || request.id.length > 256) throw new Error("safe-exec: request ID must contain 1–256 characters");
  if (!request.argv.length || request.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !request.argv[0]) {
    throw new Error("safe-exec: supply a nonempty executable and NUL-free arguments");
  }
  const cwd = resolve(request.cwd);
  const fingerprint = createHash("sha256").update(JSON.stringify([request.argv, cwd])).digest("hex");
  const root = resolve(spool);
  const db = openLedger(root);
  let out: number | undefined;
  let err: number | undefined;
  try {
    db.query("INSERT OR IGNORE INTO requests (id, fingerprint, state) VALUES (?, ?, 'prepared')").run(request.id, fingerprint);
    const row = rowFor(db, request.id)!;
    if (row.fingerprint !== fingerprint) throw new Error("safe-exec: request ID already binds a different command or cwd");
    await onPhase?.("admitted");
    // This committed CAS is the dispatch fence. Never reset it or infer safety from a dead PID.
    const claim = db.query("UPDATE requests SET state = 'dispatching' WHERE id = ? AND state = 'prepared'").run(request.id);
    if (claim.changes === 0) return outcome(root, request.id, rowFor(db, request.id));
    await onPhase?.("dispatching");
    const paths = outcome(root, request.id, rowFor(db, request.id));
    if (paths.state !== "indeterminate") throw new Error("safe-exec: invalid dispatch state");
    let child: Subprocess<"ignore", number, number>;
    try {
      // File handles, not controller pipes: grandchildren cannot hold up the leader's receipt.
      out = openSync(paths.stdout, "a", 0o600);
      err = openSync(paths.stderr, "a", 0o600);
      child = Bun.spawn(request.argv, { cwd, stdin: "ignore", stdout: out, stderr: err, detached: true });
    } catch (error) {
      // Only a synchronous spawn failure proves no child was started.
      db.query("UPDATE requests SET state = 'not-started', error = ? WHERE id = ? AND state = 'dispatching'")
        .run(error instanceof Error ? error.message : String(error), request.id);
      return outcome(root, request.id, rowFor(db, request.id));
    } finally {
      if (out !== undefined) { closeSync(out); out = undefined; }
      if (err !== undefined) { closeSync(err); err = undefined; }
    }
    await onPhase?.("spawned");
    const code = await child.exited;
    await onPhase?.("exited");
    db.query("UPDATE requests SET state = 'completed', code = ? WHERE id = ? AND state = 'dispatching'").run(code, request.id);
    await onPhase?.("completed");
    return outcome(root, request.id, rowFor(db, request.id));
  } finally {
    if (out !== undefined) closeSync(out);
    if (err !== undefined) closeSync(err);
    db.close();
  }
}

if (import.meta.main) {
  const [flag, spool, action, id, separator, ...argv] = process.argv.slice(2);
  if (flag !== "--spool" || !spool || !id || !["status", "submit"].includes(action ?? "") ||
      (action === "submit" ? separator !== "--" || !argv.length : separator !== undefined)) {
    console.error("usage: bun run src/spikes/safe-exec.ts --spool DIR status ID\n       bun run src/spikes/safe-exec.ts --spool DIR submit ID -- EXECUTABLE [ARG ...]");
    process.exit(2);
  }
  try {
    const result = action === "status" ? status(spool, id) : await submit(spool, { id, argv, cwd: process.cwd() });
    console.log(JSON.stringify(result));
    process.exitCode = result.state === "indeterminate" ? 75 : result.state === "not-started" ? 127 :
      result.state === "completed" ? result.code : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
