/**
 * Safe path joining for the panel filesystem.
 *
 * The panel's `fs` is RPC-backed and already scoped to the context's
 * filesystem root, so traversal is bounded by the RPC layer. We still
 * normalize and validate at the userland boundary to keep the editor's
 * behavior predictable (and to surface "this path is outside the repo
 * root" as a clear error rather than relying on the lower layer to
 * reject it silently).
 *
 * `joinSafe(root, rel)` returns a normalized absolute path inside `root`,
 * or `null` if `rel` would escape `root` via `..` segments.
 */

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

/** Discriminated return: either a resolved list of segments, or an
 *  `escape: true` marker. We use a struct rather than a magic string
 *  sentinel because a user-supplied path segment could legitimately be
 *  named "__ESCAPE__" (or any other in-band marker we might pick). */
type ResolveResult = { escape: true } | { escape: false; segments: string[] };

function resolveSegments(segments: string[]): ResolveResult {
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return { escape: true };
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return { escape: false, segments: out };
}

/**
 * Join `rel` onto `root` and return the resolved absolute path, or `null`
 * if `rel` would escape `root`. Both forward and backslash separators are
 * normalized to forward slashes.
 */
export function joinSafe(root: string, rel: string): string | null {
  const normalizedRoot = normalize(root).replace(/\/$/, "");
  const normalizedRel = normalize(rel);
  if (normalizedRel.startsWith("/")) {
    // Absolute paths must be inside the root.
    if (!normalizedRel.startsWith(`${normalizedRoot}/`) && normalizedRel !== normalizedRoot) return null;
    const result = resolveSegments(normalizedRel.slice(normalizedRoot.length + 1).split("/"));
    if (result.escape) return null;
    return result.segments.length === 0 ? normalizedRoot : `${normalizedRoot}/${result.segments.join("/")}`;
  }
  const result = resolveSegments(normalizedRel.split("/"));
  if (result.escape) return null;
  return result.segments.length === 0 ? normalizedRoot : `${normalizedRoot}/${result.segments.join("/")}`;
}

/**
 * Return the directory containing `path`, or null if `path` has no
 * containing directory. Forward-slash only.
 */
export function parentDir(path: string): string | null {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return null;
  return path.slice(0, idx);
}
