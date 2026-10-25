/** Typo suggestions for unknown names ("did you mean"). Pure; no I/O. */

/** Optimal-string-alignment Damerau-Levenshtein distance: insertions,
 *  deletions, substitutions and adjacent transpositions each cost 1. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const w = b.length + 1;
  let prev2 = new Array<number>(w).fill(0);
  let prev = Array.from({ length: w }, (_, j) => j);
  let cur = new Array<number>(w).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2]! + 1);
      cur[j] = d;
    }
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[b.length]!;
}

/** The largest distance still worth suggesting: 1 up to 5 characters, 2 up to 8, then 3. */
export function suggestionThreshold(input: string): number {
  return input.length <= 5 ? 1 : input.length <= 8 ? 2 : 3;
}

/** Up to `max` candidates within the length-scaled threshold of `input`,
 *  nearest first, ties in candidate order. Comparison ignores case and any
 *  leading dashes, so `--jsno` finds `--json`. Exact matches are skipped. */
export function suggest(input: string, candidates: Iterable<string>, max = 3): string[] {
  const norm = (s: string) => s.replace(/^-+/, "").toLowerCase();
  const needle = norm(input);
  if (!needle) return [];
  const limit = suggestionThreshold(needle);
  const seen = new Set<string>();
  const hits: { name: string; d: number; i: number }[] = [];
  let i = 0;
  for (const name of candidates) {
    if (seen.has(name) || name === input) continue;
    seen.add(name);
    const d = editDistance(needle, norm(name));
    if (d <= limit) hits.push({ name, d, i });
    i++;
  }
  return hits.sort((x, y) => x.d - y.d || x.i - y.i).slice(0, max).map((h) => h.name);
}

/** ` — did you mean: a, b?` for appending to an error message, or "" when nothing is close. */
export function didYouMean(input: string, candidates: Iterable<string>, max = 3): string {
  const hits = suggest(input, candidates, max);
  return hits.length ? ` — did you mean: ${hits.join(", ")}?` : "";
}
