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

function resolveSegments(segments: string[]): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return ["__ESCAPE__"];
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
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
    const subsegments = resolveSegments(normalizedRel.slice(normalizedRoot.length + 1).split("/"));
    if (subsegments[0] === "__ESCAPE__") return null;
    return subsegments.length === 0 ? normalizedRoot : `${normalizedRoot}/${subsegments.join("/")}`;
  }
  const segments = resolveSegments(normalizedRel.split("/"));
  if (segments[0] === "__ESCAPE__") return null;
  return segments.length === 0 ? normalizedRoot : `${normalizedRoot}/${segments.join("/")}`;
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
