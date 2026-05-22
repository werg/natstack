/**
 * Tiny YAML frontmatter parser for the limited shape Spectrolite cares about.
 *
 * Supports:
 *   title: My Note
 *   title: "Quoted Title"
 *   dependencies:
 *     lodash: "npm:^4.17.21"
 *     "date-fns": "npm:2"
 *     "@workspace/agentic-chat": latest
 *
 * Not a general YAML parser — multi-line strings, arrays, anchors, etc.
 * are not supported. Anything that looks unfamiliar is silently ignored.
 */

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

export interface ParsedFrontmatter {
  title: string | null;
  dependencies: Record<string, string>;
  /** Raw YAML body (between the `---` fences) for downstream tools. */
  raw: string | null;
}

/**
 * Returns a fresh empty ParsedFrontmatter on every call. We intentionally
 * do NOT cache a singleton — callers commonly read `dependencies` and pass
 * it to downstream consumers that may mutate or merge into it, so handing
 * out a shared mutable object would let one caller poison every other
 * caller's result.
 */
function emptyParsed(): ParsedFrontmatter {
  return { title: null, dependencies: {}, raw: null };
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const m = FRONTMATTER_RE.exec(markdown);
  if (!m) return emptyParsed();
  const raw = m[1] ?? "";
  const lines = raw.split("\n");

  let title: string | null = null;
  const dependencies: Record<string, string> = {};
  let inDeps = false;
  let depsIndent = -1;

  for (const rawLine of lines) {
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) continue;

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trimEnd();

    if (inDeps) {
      if (indent <= depsIndent) {
        inDeps = false;
        depsIndent = -1;
        // fall through to process this line at top level
      } else {
        const kv = /^\s*([A-Za-z0-9_@/.-]+|"[^"]+"|'[^']+')\s*:\s*(.+)\s*$/.exec(line);
        if (kv) {
          const key = stripQuotes(kv[1] ?? "");
          const value = stripQuotes(kv[2] ?? "");
          if (key) dependencies[key] = value;
        }
        continue;
      }
    }

    // Top-level entry
    if (/^\s*title\s*:/.test(line)) {
      const titleMatch = /^\s*title\s*:\s*(.+)$/.exec(line);
      if (titleMatch) title = stripQuotes(titleMatch[1] ?? "") || null;
      continue;
    }
    if (/^\s*dependencies\s*:\s*$/.test(line)) {
      inDeps = true;
      depsIndent = indent;
      continue;
    }
  }

  return { title, dependencies, raw };
}

/** Diff two dependency maps; returns { added: pkgs newly present, changed: pkgs whose ref changed, removed: pkgs no longer present }. */
export function diffDependencies(
  before: Record<string, string>,
  after: Record<string, string>,
): { added: Record<string, string>; changed: Record<string, string>; removed: string[] } {
  const added: Record<string, string> = {};
  const changed: Record<string, string> = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) added[k] = v;
    else if (before[k] !== v) changed[k] = v;
  }
  for (const k of Object.keys(before)) {
    if (!(k in after)) removed.push(k);
  }
  return { added, changed, removed };
}
