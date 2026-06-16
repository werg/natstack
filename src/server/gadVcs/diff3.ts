/**
 * Vendored three-way line merge (diff3) — pure, no deps (P4).
 *
 * Standard shape: compute LCS-based alignments base↔ours and base↔theirs,
 * walk the base, take non-conflicting changes from either side, and emit
 * git-style conflict hunks where both sides changed the same region
 * differently.
 */

export interface Diff3Result {
  ok: boolean;
  /** Merged text (with conflict markers when !ok). */
  text: string;
  conflicts: number;
}

interface Chunk {
  /** [start, end) in base */
  baseStart: number;
  baseEnd: number;
  /** replacement lines from the changed side */
  lines: string[];
}

/** Myers-lite LCS diff: returns chunks describing side's changes vs base. */
function diffChunks(base: string[], side: string[]): Chunk[] {
  const n = base.length;
  const m = side.length;
  // LCS table (n+1 x m+1). Workspace files are small enough for O(n·m) here;
  // the merge engine only diff3s files that BOTH sides touched.
  const lcs: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) lcs.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        base[i] === side[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const chunks: Chunk[] = [];
  let i = 0;
  let j = 0;
  let pending: Chunk | null = null;
  const flush = (): void => {
    if (pending) {
      chunks.push(pending);
      pending = null;
    }
  };
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === side[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      pending ??= { baseStart: i, baseEnd: i, lines: [] };
      pending.lines.push(side[j]!);
      j++;
    } else {
      pending ??= { baseStart: i, baseEnd: i, lines: [] };
      pending.baseEnd = i + 1;
      i++;
    }
  }
  flush();
  return chunks;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

export interface Diff3Options {
  oursLabel?: string;
  theirsLabel?: string;
}

export function diff3Merge(
  baseText: string,
  oursText: string,
  theirsText: string,
  opts: Diff3Options = {}
): Diff3Result {
  // Fast paths
  if (oursText === theirsText) return { ok: true, text: oursText, conflicts: 0 };
  if (oursText === baseText) return { ok: true, text: theirsText, conflicts: 0 };
  if (theirsText === baseText) return { ok: true, text: oursText, conflicts: 0 };

  const base = splitLines(baseText);
  const ours = splitLines(oursText);
  const theirs = splitLines(theirsText);
  const oursChunks = diffChunks(base, ours);
  const theirsChunks = diffChunks(base, theirs);

  const out: string[] = [];
  let conflicts = 0;
  let cursor = 0; // position in base
  let oi = 0;
  let ti = 0;

  while (oi < oursChunks.length || ti < theirsChunks.length) {
    const oc = oursChunks[oi];
    const tc = theirsChunks[ti];
    const next = Math.min(oc?.baseStart ?? Infinity, tc?.baseStart ?? Infinity);
    // copy untouched base up to the next chunk
    for (; cursor < next; cursor++) out.push(base[cursor]!);

    const oActive = oc !== undefined && oc.baseStart <= cursor;
    const tActive = tc !== undefined && tc.baseStart <= cursor;
    const spansOverlap =
      oc !== undefined &&
      tc !== undefined &&
      (oActive || tActive) &&
      (oc.baseStart === tc.baseStart || (oc.baseStart < tc.baseEnd && tc.baseStart < oc.baseEnd));

    if (spansOverlap) {
      if (!oc || !tc) throw new Error("internal diff3 overlap without both chunks");
      // Overlapping region: extend to the union of both sides' base spans,
      // absorbing any further chunks that fall inside the union.
      let regionEnd = Math.max(oc.baseEnd, tc.baseEnd, cursor);
      const oursLines: string[] = [...oc.lines];
      const theirsLines: string[] = [...tc.lines];
      // Per-side coverage: base extent already represented in that side's
      // lines, so gap-filling never duplicates or resurrects base lines.
      let oursCovEnd = oc.baseEnd;
      let theirsCovEnd = tc.baseEnd;
      oi++;
      ti++;
      let grew = true;
      while (grew) {
        grew = false;
        while (oi < oursChunks.length && oursChunks[oi]!.baseStart < regionEnd) {
          const chunk = oursChunks[oi]!;
          // unchanged base lines between the previous chunk and this one
          for (let k = oursCovEnd; k < chunk.baseStart; k++) oursLines.push(base[k]!);
          oursLines.push(...chunk.lines);
          oursCovEnd = Math.max(oursCovEnd, chunk.baseEnd);
          regionEnd = Math.max(regionEnd, chunk.baseEnd);
          oi++;
          grew = true;
        }
        while (ti < theirsChunks.length && theirsChunks[ti]!.baseStart < regionEnd) {
          const chunk = theirsChunks[ti]!;
          for (let k = theirsCovEnd; k < chunk.baseStart; k++) theirsLines.push(base[k]!);
          theirsLines.push(...chunk.lines);
          theirsCovEnd = Math.max(theirsCovEnd, chunk.baseEnd);
          regionEnd = Math.max(regionEnd, chunk.baseEnd);
          ti++;
          grew = true;
        }
      }
      // Lines of base between each side's covered span and regionEnd that the
      // side did NOT change are part of that side's view of the region.
      const oursView = regionView(base, oc.baseStart, oursCovEnd, regionEnd, oursLines, cursor);
      const theirsView = regionView(
        base,
        tc.baseStart,
        theirsCovEnd,
        regionEnd,
        theirsLines,
        cursor
      );

      if (sameLines(oursView, theirsView)) {
        out.push(...oursView);
      } else {
        conflicts++;
        out.push(`<<<<<<< ${opts.oursLabel ?? "ours"}`);
        out.push(...oursView);
        out.push("=======");
        out.push(...theirsView);
        out.push(`>>>>>>> ${opts.theirsLabel ?? "theirs"}`);
      }
      cursor = regionEnd;
    } else if (oActive && !tActive) {
      out.push(...oc.lines);
      cursor = Math.max(cursor, oc.baseEnd);
      oi++;
    } else if (tActive && !oActive) {
      out.push(...tc.lines);
      cursor = Math.max(cursor, tc.baseEnd);
      ti++;
    }
  }
  for (; cursor < base.length; cursor++) out.push(base[cursor]!);

  return { ok: conflicts === 0, text: joinLines(out, baseText, oursText, theirsText), conflicts };
}

/** A side's content for the conflict region [start, regionEnd). */
function regionView(
  base: string[],
  chunkStart: number,
  chunkEnd: number,
  regionEnd: number,
  changedLines: string[],
  regionStart: number
): string[] {
  const view: string[] = [];
  // base lines before the side's own chunk inside the region
  for (let k = regionStart; k < chunkStart; k++) view.push(base[k]!);
  view.push(...changedLines);
  // base lines after the side's chunk through the region end
  for (let k = chunkEnd; k < regionEnd; k++) view.push(base[k]!);
  return view;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function joinLines(
  lines: string[],
  baseText: string,
  oursText: string,
  theirsText: string
): string {
  const text = lines.join("\n");
  // Preserve a trailing newline when any input ended with one.
  const trailing = baseText.endsWith("\n") || oursText.endsWith("\n") || theirsText.endsWith("\n");
  return text.length > 0 && trailing ? `${text}\n` : text;
}
