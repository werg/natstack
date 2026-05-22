/**
 * Compute unified diffs and extract @-mentions for the flush pipeline.
 *
 * We use the `diff` npm package (createPatch / structuredPatch) — small,
 * battle-tested, and produces a unified-diff string the agent can read with
 * its existing tools.
 */

import { createPatch } from "diff";

export interface FlushPayload {
  path: string;
  beforeSha?: string;
  afterSha?: string;
  unifiedDiff: string;
  addedLines: number;
  removedLines: number;
  mentions: string[];
  at: number;
}

const MENTION_RE = /(?:^|[\s(<])@([A-Za-z0-9_.-]+)\b/g;

/** Extract @handle tokens that appear in any added line of the diff. */
export function extractMentionsFromDiff(unifiedDiff: string, knownHandles: Iterable<string>): string[] {
  const set = new Set(knownHandles);
  const found = new Set<string>();
  for (const line of unifiedDiff.split("\n")) {
    // Diff header lines are "+++ " or "--- " (with a trailing space). A
    // real content line like "+++Hello" is added content and must not be
    // skipped.
    if (!line.startsWith("+") || line.startsWith("+++ ")) continue;
    const body = line.slice(1);
    for (const match of body.matchAll(MENTION_RE)) {
      const handle = match[1];
      if (handle && set.has(handle)) found.add(handle);
    }
  }
  return [...found];
}

export interface BuildFlushArgs {
  path: string;
  before: string;
  after: string;
  knownHandles: Iterable<string>;
}

export function buildFlushPayload({ path, before, after, knownHandles }: BuildFlushArgs): FlushPayload | null {
  if (before === after) return null;
  const unifiedDiff = createPatch(path, before, after, "", "");
  const mentions = extractMentionsFromDiff(unifiedDiff, knownHandles);
  let added = 0;
  let removed = 0;
  for (const line of unifiedDiff.split("\n")) {
    // "+++ " / "--- " (with a trailing space) are file headers; raw
    // content lines starting with the same characters but with no trailing
    // space are real additions/removals.
    if (line.startsWith("+") && !line.startsWith("+++ ")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("--- ")) removed += 1;
  }
  return {
    path,
    unifiedDiff,
    addedLines: added,
    removedLines: removed,
    mentions,
    at: Date.now(),
  };
}
