/**
 * YAML frontmatter parsing + targeted rewriting.
 *
 * Uses the `yaml` package so nested objects, arrays, and quoted strings
 * all work (the earlier hand-rolled flat parser couldn't represent
 * structured `state:` payloads — which is what `useDocState` needs).
 *
 * Shape of fields we care about:
 *   - `title`     — string, used for the header breadcrumb
 *   - `dependencies` — Record<package-name, version-or-ref>, used by the
 *     dep prefetcher
 *   - `state`     — Record<string, unknown>, used by the `useDocState`
 *     hook so inline JSX components can persist values into the doc
 *
 * `replaceFrontmatterState(md, state)` rewrites ONLY the `state:` key,
 * preserving every other top-level frontmatter entry. We round-trip
 * through `yaml.parse` / `yaml.stringify`, so comments inside the
 * frontmatter are not preserved — acceptable trade-off for v1.
 */

import * as YAML from "yaml";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

export interface ParsedFrontmatter {
  title: string | null;
  dependencies: Record<string, string>;
  state: Record<string, unknown>;
  raw: string | null;
}

function emptyParsed(): ParsedFrontmatter {
  return { title: null, dependencies: {}, state: {}, raw: null };
}

export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const m = FRONTMATTER_RE.exec(markdown);
  if (!m) return emptyParsed();
  const raw = m[1] ?? "";
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch {
    return { ...emptyParsed(), raw };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...emptyParsed(), raw };
  }
  const obj = parsed as Record<string, unknown>;
  const title = typeof obj["title"] === "string" ? (obj["title"] as string) : null;
  const dependencies: Record<string, string> = {};
  const depsField = obj["dependencies"];
  if (depsField && typeof depsField === "object" && !Array.isArray(depsField)) {
    for (const [k, v] of Object.entries(depsField as Record<string, unknown>)) {
      if (typeof v === "string") dependencies[k] = v;
    }
  }
  const state: Record<string, unknown> = {};
  const stateField = obj["state"];
  if (stateField && typeof stateField === "object" && !Array.isArray(stateField)) {
    Object.assign(state, stateField as Record<string, unknown>);
  }
  return { title, dependencies, state, raw };
}

/**
 * Replace the `state:` key in the markdown's frontmatter with `newState`,
 * preserving every other field. If `newState` is empty, the `state:`
 * key is dropped. If the document has no frontmatter and `newState` is
 * non-empty, a minimal frontmatter is prepended.
 *
 * Idempotent: passing the same `newState` twice produces the same string.
 */
export function replaceFrontmatterState(markdown: string, newState: Record<string, unknown>): string {
  const m = FRONTMATTER_RE.exec(markdown);
  let frontmatterObj: Record<string, unknown> = {};
  let body: string;
  if (m) {
    let parsed: unknown;
    try {
      parsed = YAML.parse(m[1] ?? "");
    } catch {
      // Malformed frontmatter — refuse to rewrite. Silently emitting a
      // fresh frontmatter would erase the user's `title`, `dependencies`,
      // and any other keys we couldn't parse. The user's component-state
      // mutations stay in memory; they'll land successfully once the
      // frontmatter parses again.
      return markdown;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      // Frontmatter parsed but isn't an object map — same conservative
      // bail-out.
      return markdown;
    }
    frontmatterObj = parsed as Record<string, unknown>;
    body = markdown.slice(m[0].length);
  } else {
    body = markdown;
  }

  if (Object.keys(newState).length === 0) {
    delete frontmatterObj["state"];
  } else {
    frontmatterObj["state"] = newState;
  }

  if (Object.keys(frontmatterObj).length === 0) {
    // No frontmatter needed; return the body as-is.
    return body;
  }
  const newYaml = YAML.stringify(frontmatterObj).trimEnd();
  // Ensure exactly one blank line between the frontmatter and the body.
  const trimmedBody = body.replace(/^\n+/, "");
  return `---\n${newYaml}\n---\n\n${trimmedBody}`;
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

/**
 * Returns true iff the only difference between two markdown documents
 * is the value of the frontmatter `state:` key — i.e. the prose body
 * is byte-identical AND every frontmatter field except `state` is
 * structurally equal.
 *
 * Used by the flush pipeline to decide whether a particular flush is
 * "just component state mutating" (skip the kb.user_edit publish — the
 * agent doesn't want a notification every time the user nudges a
 * slider) versus a real prose / frontmatter / dependency edit (publish
 * as usual).
 */
export function isStateOnlyChange(before: string, after: string): boolean {
  if (before === after) return true;
  // Body comparison — split off the `---…---` header and compare the
  // rest byte-for-byte.
  if (bodyOf(before) !== bodyOf(after)) return false;
  const fmBefore = frontmatterMinusState(before);
  const fmAfter = frontmatterMinusState(after);
  return stableStringify(fmBefore) === stableStringify(fmAfter);
}

function bodyOf(markdown: string): string {
  const m = FRONTMATTER_RE.exec(markdown);
  return m ? markdown.slice(m[0].length) : markdown;
}

function frontmatterMinusState(markdown: string): unknown {
  const m = FRONTMATTER_RE.exec(markdown);
  if (!m) return null;
  try {
    const parsed = YAML.parse(m[1] ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed ?? null;
    const rest: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
    delete rest["state"];
    return rest;
  } catch {
    return null;
  }
}

/** Object-key-sorted JSON serialization, so map ordering doesn't
 *  produce false-positive diffs on logically equal frontmatters. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/** Shallow-equal compare two state maps. */
export function statesEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!(k in b)) return false;
    if (!Object.is(a[k], b[k])) {
      // Deep-equal by JSON serialization for non-primitive values.
      try {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}
