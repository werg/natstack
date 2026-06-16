/**
 * Canonical JSON — the ONE implementation of key-sorted, undefined-dropping
 * JSON serialization used for every content hash in the protocol (envelope
 * hash chains, worktree manifests, state hashes). gad-store and the server
 * vcs must agree byte-for-byte with this module; do not fork it.
 */

export function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child !== undefined) sorted[key] = sortForCanonicalJson(child);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value));
}
