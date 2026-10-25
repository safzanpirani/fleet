/** Line diff for `fleet diff`: Myers' O(ND) alignment rendered as a unified
 *  diff in the same shape diff(1) -u prints. Pure; no I/O. */

/** Larger inputs are refused before any alignment work. */
export const DIFF_MAX_BYTES = 4 * 1024 * 1024;
/** Edit distance beyond which the changed middle is shown as one replace
 *  block instead of a minimal alignment, bounding the trace to a few MB. */
const MAX_EDIT_DISTANCE = 2000;

/** Decode file bytes as text, or explain why they are not diffable text. */
export function decodeDiffText(bytes: Uint8Array, label: string): string {
  if (bytes.length > DIFF_MAX_BYTES)
    throw new Error(`${label}: ${bytes.length} bytes exceeds the ${DIFF_MAX_BYTES / 1024 / 1024} MiB diff limit`);
  if (bytes.includes(0)) throw new Error(`${label}: binary file (contains NUL bytes); fleet diff compares text only`);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label}: binary file (not valid UTF-8); fleet diff compares text only`);
  }
}

type Op = { kind: " " | "-" | "+"; ai: number; bi: number };

/** Split text into lines; a last line without a newline gets a NUL suffix so it
 *  differs from the same line with one (NUL never survives decodeDiffText). */
function lines(text: string): string[] {
  if (text === "") return [];
  const out = text.split("\n");
  if (out.at(-1) === "") out.pop();
  else out[out.length - 1] += "\0";
  return out;
}

/** Myers shortest edit script between a[lo..] and b[lo..] after trimming;
 *  null when the edit distance passes MAX_EDIT_DISTANCE. */
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length, m = b.length, max = n + m, off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) return null;
    // v[k-1..k+1] for k in [-d, d], as the decisions of step d read it.
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], dEnd: number, n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = dEnd; d > 0; d--) {
    const s = trace[d]!;
    const at = (k: number) => s[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; ops.push({ kind: " ", ai: x, bi: y }); }
    if (x === prevX) { y--; ops.push({ kind: "+", ai: x, bi: y }); }
    else { x--; ops.push({ kind: "-", ai: x, bi: y }); }
  }
  while (x > 0 && y > 0) { x--; y--; ops.push({ kind: " ", ai: x, bi: y }); }
  return ops.reverse();
}

function editScript(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: " ", ai: i, bi: i });
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  const mid = myers(midA, midB);
  if (mid) for (const o of mid) ops.push({ kind: o.kind, ai: o.ai + start, bi: o.bi + start });
  else {
    for (let i = start; i < endA; i++) ops.push({ kind: "-", ai: i, bi: start });
    for (let j = start; j < endB; j++) ops.push({ kind: "+", ai: endA, bi: j });
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push({ kind: " ", ai: i, bi: j });
  return ops;
}

function range(start: number, count: number): string {
  const first = count === 0 ? start : start + 1;
  return count === 1 ? `${first}` : `${first},${count}`;
}

/** Unified diff of two texts with `context` lines around each change, headed by
 *  `--- labelA` / `+++ labelB`. Empty string when the texts are identical. */
export function unifiedDiff(before: string, after: string, labelA: string, labelB: string, context = 3): string {
  if (before === after) return "";
  const a = lines(before), b = lines(after);
  const ops = editScript(a, b);
  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  const render = (o: Op) => {
    const raw = o.kind === "+" ? b[o.bi]! : a[o.ai]!;
    return raw.endsWith("\0") ? `${o.kind}${raw.slice(0, -1)}\n\\ No newline at end of file` : o.kind + raw;
  };
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i]!.kind === " ") i++;
    if (i >= ops.length) break;
    const from = Math.max(0, i - context);
    let to = i;
    // Extend while the next change sits within 2×context of the last one.
    for (;;) {
      while (to < ops.length && ops[to]!.kind !== " ") to++;
      let next = to;
      while (next < ops.length && ops[next]!.kind === " ") next++;
      if (next < ops.length && next - to <= 2 * context) { to = next; continue; }
      to = Math.min(ops.length, to + context);
      break;
    }
    const hunk = ops.slice(from, to);
    const aCount = hunk.filter((o) => o.kind !== "+").length;
    const bCount = hunk.filter((o) => o.kind !== "-").length;
    out.push(`@@ -${range(hunk[0]!.ai, aCount)} +${range(hunk[0]!.bi, bCount)} @@`);
    for (const o of hunk) out.push(render(o));
    i = to;
  }
  return out.join("\n") + "\n";
}
