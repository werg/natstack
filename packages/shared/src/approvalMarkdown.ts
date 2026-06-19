export type ApprovalMarkdownInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: ApprovalMarkdownInline[] }
  | { kind: "emphasis"; children: ApprovalMarkdownInline[] };

export type ApprovalMarkdownBlock =
  | { kind: "paragraph"; children: ApprovalMarkdownInline[] }
  | { kind: "bullet-list"; items: ApprovalMarkdownInline[][] }
  | { kind: "ordered-list"; items: ApprovalMarkdownInline[][] }
  | { kind: "code-block"; text: string };

const FENCE = /^\s*```/;
const BULLET = /^\s*[-*]\s+(.+)$/;
const ORDERED = /^\s*\d+[.)]\s+(.+)$/;

export function parseApprovalMarkdown(source: string): ApprovalMarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ApprovalMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (FENCE.test(line)) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code-block", text: code.join("\n") });
      continue;
    }

    const bullet = line.match(BULLET);
    if (bullet) {
      const items: ApprovalMarkdownInline[][] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(BULLET);
        if (!match) break;
        items.push(parseApprovalMarkdownInline(match[1] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "bullet-list", items });
      continue;
    }

    const ordered = line.match(ORDERED);
    if (ordered) {
      const items: ApprovalMarkdownInline[][] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(ORDERED);
        if (!match) break;
        items.push(parseApprovalMarkdownInline(match[1] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "ordered-list", items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (!current.trim() || FENCE.test(current) || BULLET.test(current) || ORDERED.test(current)) break;
      paragraph.push(current.trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", children: parseApprovalMarkdownInline(paragraph.join(" ")) });
  }

  return blocks;
}

export function parseApprovalMarkdownInline(source: string): ApprovalMarkdownInline[] {
  return parseInline(source, 0);
}

function parseInline(source: string, depth: number): ApprovalMarkdownInline[] {
  if (depth > 8 || !source) return source ? [{ kind: "text", text: source }] : [];
  const nodes: ApprovalMarkdownInline[] = [];
  let index = 0;
  while (index < source.length) {
    if (source[index] === "`") {
      const end = source.indexOf("`", index + 1);
      if (end > index + 1) {
        nodes.push({ kind: "code", text: source.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }
    if (source.startsWith("**", index)) {
      const end = source.indexOf("**", index + 2);
      if (end > index + 2) {
        nodes.push({ kind: "strong", children: parseInline(source.slice(index + 2, end), depth + 1) });
        index = end + 2;
        continue;
      }
    }
    if (source[index] === "*" && source[index + 1] !== "*") {
      const end = source.indexOf("*", index + 1);
      if (end > index + 1 && source[end + 1] !== "*") {
        nodes.push({ kind: "emphasis", children: parseInline(source.slice(index + 1, end), depth + 1) });
        index = end + 1;
        continue;
      }
    }

    const next = nextMarker(source, index + 1);
    nodes.push({ kind: "text", text: source.slice(index, next) });
    index = next;
  }
  return mergeText(nodes);
}

function nextMarker(source: string, start: number): number {
  const ticks = source.indexOf("`", start);
  const strong = source.indexOf("**", start);
  const emphasis = source.indexOf("*", start);
  const candidates = [ticks, strong, emphasis].filter((value) => value >= 0);
  return candidates.length ? Math.min(...candidates) : source.length;
}

function mergeText(nodes: ApprovalMarkdownInline[]): ApprovalMarkdownInline[] {
  const merged: ApprovalMarkdownInline[] = [];
  for (const node of nodes) {
    const previous = merged[merged.length - 1];
    if (node.kind === "text" && previous?.kind === "text") {
      previous.text += node.text;
    } else if (node.kind !== "text" || node.text) {
      merged.push(node);
    }
  }
  return merged;
}
