/**
 * Wikilink syntax bridge: `[[Page]]` / `[[Page|Alias]]` ↔ `<WikiLink>` JSX.
 *
 * MDXEditor's markdown parser pipeline isn't extensible from userland (the
 * MarkdownParseOptions type is intentionally excluded from public types), so
 * we pre-process at the read/write boundary:
 *
 *   - On file open (read from disk):
 *     `[[Page Name]]` becomes `<WikiLink target="Page Name" />`
 *     `[[Page Name|click here]]` becomes `<WikiLink target="Page Name">click here</WikiLink>`
 *   - On flush (write to disk): the inverse transformation.
 *
 * `<WikiLink>` is registered as a JSX descriptor (text-level, inline-like)
 * so MDXEditor renders it via the editor we wire in `LiveJsxEditor.tsx`.
 * Preview-mode compilation receives the JSX directly since `mdxComponents`
 * exposes `WikiLink` as a runtime component.
 *
 * Path resolution uses Obsidian-style "shortestPossible" matching against
 * the workspace's `.mdx` files: the link target is the file basename
 * (without `.mdx`), and the resolver walks the workspace to find the
 * shortest matching path.
 */

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const WIKILINK_JSX_RE_SELF = /<WikiLink\s+target=("([^"]+)"|'([^']+)')\s*\/>/g;
const WIKILINK_JSX_RE_WITH_TEXT = /<WikiLink\s+target=("([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/WikiLink>/g;
const FRONTMATTER_RE = /^(---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n)/;

/** Strip the YAML frontmatter (if any) off the front of the doc and
 *  return [frontmatter, body]. Wikilink transforms should NEVER touch
 *  the frontmatter — a `title: "My [[Foo]] note"` would be silently
 *  rewritten to invalid YAML otherwise. */
function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const m = FRONTMATTER_RE.exec(markdown);
  if (!m) return { frontmatter: "", body: markdown };
  return { frontmatter: m[1] ?? "", body: markdown.slice((m[1] ?? "").length) };
}

/**
 * Split a markdown document into [code-fenced, non-code-fenced] segments
 * so we can apply transforms only outside code blocks. Supports both ```
 * fenced and `~~~` fenced (and inline `code` is left alone — the
 * wikilink regex requires `[[` which doesn't occur in inline code we want
 * to transform anyway).
 */
function splitByCodeBlocks(markdown: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  const lines = markdown.split("\n");
  let inFence = false;
  let fenceMarker = "";
  let buf: string[] = [];
  const flush = (code: boolean) => {
    if (buf.length === 0) return;
    out.push({ code, text: buf.join("\n") });
    buf = [];
  };
  for (const line of lines) {
    if (!inFence) {
      const fenceMatch = /^\s{0,3}(```+|~~~+)/.exec(line);
      if (fenceMatch) {
        flush(false);
        inFence = true;
        fenceMarker = fenceMatch[1]!;
        buf.push(line);
        continue;
      }
      buf.push(line);
      continue;
    }
    // In-fence: a closing fence is CommonMark-compliant only if it's
    // up-to-three-space-indented, a run of the same marker character at
    // least as long as the opener, and followed by whitespace only. The
    // previous `line.includes(fenceMarker)` would falsely close on any
    // line containing the marker as a substring (e.g. a JS string with
    // backticks inside).
    const marker = fenceMarker[0]!;
    const closeRe = new RegExp(`^\\s{0,3}${marker === "`" ? "`" : "~"}{${fenceMarker.length},}\\s*$`);
    if (closeRe.test(line)) {
      buf.push(line);
      flush(true);
      inFence = false;
      fenceMarker = "";
    } else {
      buf.push(line);
    }
  }
  flush(inFence);
  return out;
}

function transformOutsideCode(markdown: string, fn: (segment: string) => string): string {
  return splitByCodeBlocks(markdown)
    .map((seg) => (seg.code ? seg.text : fn(seg.text)))
    .join("\n");
}

/** Transform on read: `[[X]]` → `<WikiLink target="X" />`, but only
 *  outside code blocks AND outside the YAML frontmatter (a wikilink in
 *  `title:` is a literal string, not a doc link). */
export function wikilinksToJsx(markdown: string): string {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const transformed = transformOutsideCode(body, (segment) =>
    segment.replace(WIKILINK_RE, (_match, target: string, alias: string | undefined) => {
      const t = target.trim();
      if (!alias) return `<WikiLink target="${escapeAttr(t)}" />`;
      return `<WikiLink target="${escapeAttr(t)}">${escapeText(alias.trim())}</WikiLink>`;
    }),
  );
  return frontmatter + transformed;
}

/** Transform on write: `<WikiLink ...>` → `[[X]]` / `[[X|Y]]`, but only
 *  outside code blocks AND outside the YAML frontmatter. Decodes the
 *  HTML entity escapes that `wikilinksToJsx` introduced so the target
 *  text round-trips verbatim across flushes. */
export function wikilinksFromJsx(markdown: string): string {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const transformed = transformOutsideCode(body, (segment) => {
    let out = segment.replace(WIKILINK_JSX_RE_WITH_TEXT, (_match, _full, dq, sq, text: string) => {
      const target = unescapeAttr((dq ?? sq ?? "").trim());
      const inner = unescapeText(text.trim());
      if (!inner || inner === target) return `[[${target}]]`;
      return `[[${target}|${inner}]]`;
    });
    out = out.replace(WIKILINK_JSX_RE_SELF, (_match, _full, dq, sq) => {
      const target = unescapeAttr((dq ?? sq ?? "").trim());
      return `[[${target}]]`;
    });
    return out;
  });
  return frontmatter + transformed;
}

/**
 * Escape a string for inclusion as a double-quoted JSX attribute value.
 * Ampersand MUST be escaped first to avoid double-escaping the other
 * substitutions. We escape `<` and `>` too even though they're technically
 * legal inside attribute values, because MDX's JSX parser is strict.
 *
 * Counterpart `unescapeAttr` reverses these substitutions. Both are used
 * together so the JSX round-trip `[[X]]` → `<WikiLink target="X" />` →
 * `[[X]]` preserves the original target text. Without the inverse decode,
 * `[[Foo & Bar]]` would persist to disk as `[[Foo &amp; Bar]]` after one
 * flush and accumulate more escapes on each subsequent round-trip.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeAttr(value: string): string {
  // Reverse order: decode numeric-style entities last so we don't
  // re-collapse legitimate `&amp;` sequences. We only decode the four
  // entities `escapeAttr` produces; arbitrary HTML entities are left
  // alone (they're unusual inside wikilink targets and a user-typed
  // `&amp;` in `[[]]` syntax should round-trip as written).
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function escapeText(value: string): string {
  return escapeAttr(value)
    .replace(/{/g, "&#123;")
    .replace(/}/g, "&#125;");
}

function unescapeText(value: string): string {
  const decodedBraces = value
    .replace(/&#123;/g, "{")
    .replace(/&#125;/g, "}")
    .replace(/&amp;#123;/g, "&#123;")
    .replace(/&amp;#125;/g, "&#125;");
  return unescapeAttr(decodedBraces);
}

/**
 * Obsidian-style shortestPossible resolver. Given a wikilink target and a
 * list of relative paths (from the workspace root), returns the shortest
 * matching path or `null` if no match.
 */
export function resolveWikilinkTarget(target: string, allPaths: string[]): string | null {
  const needle = target.endsWith(".mdx") ? target : `${target}.mdx`;
  const matches = allPaths.filter((p) => p === needle || p.endsWith(`/${needle}`));
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.length - b.length);
  return matches[0]!;
}

/** Find every wikilink target in a markdown document (post-JSX or raw), skipping code blocks.
 *  Returns targets in the user-facing (decoded) form, so comparison against
 *  the active file's basename works regardless of which form the document
 *  currently holds. */
export function extractWikilinks(markdown: string): string[] {
  const out = new Set<string>();
  for (const seg of splitByCodeBlocks(markdown)) {
    if (seg.code) continue;
    for (const m of seg.text.matchAll(WIKILINK_RE)) {
      out.add(m[1]!.trim());
    }
    for (const m of seg.text.matchAll(WIKILINK_JSX_RE_SELF)) {
      out.add(unescapeAttr((m[2] ?? m[3] ?? "").trim()));
    }
    for (const m of seg.text.matchAll(WIKILINK_JSX_RE_WITH_TEXT)) {
      out.add(unescapeAttr((m[2] ?? m[3] ?? "").trim()));
    }
  }
  return [...out];
}
