import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

export interface ExtractedPage {
  title: string;
  markdown: string;
  url: string;
  /** Source content-type after sniffing. "html" | "pdf" | "text" | "markdown". */
  contentType: "html" | "pdf" | "text" | "markdown";
}

export interface ExtractFetcher {
  (url: string, init: RequestInit): Promise<{
    ok: boolean;
    status: number;
    url?: string;
    headers: { get(name: string): string | null };
    text: () => Promise<string>;
    arrayBuffer: () => Promise<ArrayBuffer>;
  }>;
}

export async function extractPage(
  url: string,
  fetcher: ExtractFetcher = fetch as unknown as ExtractFetcher,
): Promise<ExtractedPage> {
  const res = await fetcher(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  } as RequestInit);
  if (!res.ok) {
    throw new Error(`Fetch ${url} returned HTTP ${res.status}`);
  }
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const finalUrl = res.url ?? url;
  const looksLikePdf =
    contentType.includes("application/pdf") || /\.pdf(?:$|[?#])/iu.test(finalUrl);

  if (looksLikePdf) {
    const buf = await res.arrayBuffer();
    return await pdfToMarkdown(new Uint8Array(buf), finalUrl);
  }
  if (contentType.includes("text/markdown") || contentType.includes("text/x-markdown")) {
    const text = await res.text();
    return {
      title: deriveTitleFromUrl(finalUrl),
      markdown: text,
      url: finalUrl,
      contentType: "markdown",
    };
  }
  if (contentType.includes("text/plain") || contentType === "") {
    const text = await res.text();
    // If the body sniffs as HTML, fall through to HTML parsing.
    if (/^\s*<!doctype html|<html[\s>]/iu.test(text)) {
      return htmlToReadableMarkdown(text, finalUrl);
    }
    return {
      title: deriveTitleFromUrl(finalUrl),
      markdown: text,
      url: finalUrl,
      contentType: "text",
    };
  }
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    throw new Error(`Unsupported content-type for web_fetch: ${contentType || "unknown"}`);
  }

  const html = await res.text();
  return htmlToReadableMarkdown(html, finalUrl);
}

async function pdfToMarkdown(bytes: Uint8Array, sourceUrl: string): Promise<ExtractedPage> {
  // Lazy-import so panel-side subpath consumers don't pay the pdf.js cost.
  const { extractText, getDocumentProxy, getMeta } = await import("unpdf");
  const doc = await getDocumentProxy(bytes);
  const [{ text: pages }, meta] = await Promise.all([
    extractText(doc, { mergePages: false }),
    getMeta(doc).catch(() => ({ info: {} as Record<string, unknown> })),
  ]);

  const info = (meta as { info?: Record<string, unknown> }).info ?? {};
  const title =
    (typeof info["Title"] === "string" && info["Title"].trim()) ||
    deriveTitleFromUrl(sourceUrl);

  const parts: string[] = [];
  parts.push(`# ${title}`);
  parts.push("");
  const author = typeof info["Author"] === "string" ? info["Author"].trim() : "";
  if (author) parts.push(`_Author: ${author}_`);
  parts.push(`_Source: ${sourceUrl}_  _Pages: ${pages.length}_`);
  parts.push("");

  const pageTexts = Array.isArray(pages) ? pages : [String(pages)];
  for (let i = 0; i < pageTexts.length; i++) {
    parts.push(`## Page ${i + 1}`);
    parts.push("");
    parts.push(normalizePdfPageText(pageTexts[i] ?? ""));
    parts.push("");
  }

  return { title, markdown: parts.join("\n"), url: sourceUrl, contentType: "pdf" };
}

function normalizePdfPageText(s: string): string {
  return s
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function htmlToReadableMarkdown(html: string, sourceUrl: string): ExtractedPage {
  const { document } = parseHTML(html);
  const docTitle = (document.querySelector("title")?.textContent ?? "").trim();

  let title = docTitle || deriveTitleFromUrl(sourceUrl);
  let contentHtml: string | null = null;

  try {
    const article = new Readability(document as unknown as Document, {
      charThreshold: 200,
    }).parse();
    if (article?.content) {
      contentHtml = article.content;
      if (article.title) title = article.title;
    }
  } catch {
    // Readability can throw on unusual documents; fall back to <body>.
  }

  if (!contentHtml) {
    contentHtml = document.body?.innerHTML ?? "";
  }

  const { document: contentDoc } = parseHTML(`<div>${contentHtml}</div>`);
  const root = contentDoc.querySelector("div");
  const md = root ? domToMarkdown(root as unknown as Element).trim() : "";
  return { title, markdown: md, url: sourceUrl, contentType: "html" };
}

function deriveTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}

const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE", "NAV",
  "FIGURE", "FIGCAPTION", "TABLE", "TR", "FORM",
]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "SVG"]);

function domToMarkdown(node: Element): string {
  const out: string[] = [];
  walk(node, out, { listDepth: 0, ordered: false });
  return out.join("").replace(/\n{3,}/gu, "\n\n");
}

interface WalkContext {
  listDepth: number;
  ordered: boolean;
}

function walk(node: Node, out: string[], ctx: WalkContext): void {
  if (node.nodeType === 3 /* TEXT_NODE */) {
    out.push(normalizeText((node as Text).data));
    return;
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
  const el = node as Element;
  const tag = el.tagName?.toUpperCase() ?? "";
  if (SKIP_TAGS.has(tag)) return;

  switch (tag) {
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
      const level = Number(tag.slice(1));
      out.push(`\n\n${"#".repeat(level)} `);
      walkChildren(el, out, ctx);
      out.push("\n\n");
      return;
    }
    case "BR":
      out.push("\n");
      return;
    case "HR":
      out.push("\n\n---\n\n");
      return;
    case "STRONG": case "B":
      out.push("**");
      walkChildren(el, out, ctx);
      out.push("**");
      return;
    case "EM": case "I":
      out.push("*");
      walkChildren(el, out, ctx);
      out.push("*");
      return;
    case "CODE":
      if (el.closest && el.closest("pre")) {
        walkChildren(el, out, ctx);
      } else {
        out.push("`");
        walkChildren(el, out, ctx);
        out.push("`");
      }
      return;
    case "PRE": {
      out.push("\n\n```\n");
      out.push((el.textContent ?? "").replace(/\n+$/u, ""));
      out.push("\n```\n\n");
      return;
    }
    case "BLOCKQUOTE": {
      const inner: string[] = [];
      walkChildren(el, inner, ctx);
      const quoted = inner.join("").trim().split("\n").map((line) => `> ${line}`).join("\n");
      out.push("\n\n" + quoted + "\n\n");
      return;
    }
    case "A": {
      const href = el.getAttribute("href") ?? "";
      const inner: string[] = [];
      walkChildren(el, inner, ctx);
      const text = inner.join("").trim();
      if (href && text) {
        out.push(`[${text}](${href})`);
      } else if (text) {
        out.push(text);
      }
      return;
    }
    case "UL": case "OL": {
      out.push("\n");
      const childCtx: WalkContext = { listDepth: ctx.listDepth + 1, ordered: tag === "OL" };
      let idx = 1;
      for (const child of Array.from(el.children)) {
        if (child.tagName?.toUpperCase() !== "LI") continue;
        const prefix = childCtx.ordered ? `${idx}. ` : "- ";
        out.push("  ".repeat(Math.max(0, childCtx.listDepth - 1)) + prefix);
        const liOut: string[] = [];
        walkChildren(child, liOut, childCtx);
        out.push(liOut.join("").trim() + "\n");
        idx++;
      }
      out.push("\n");
      return;
    }
    case "IMG": {
      const alt = el.getAttribute("alt") ?? "";
      const src = el.getAttribute("src") ?? "";
      if (src) out.push(`![${alt}](${src})`);
      return;
    }
  }

  if (BLOCK_TAGS.has(tag)) {
    out.push("\n");
    walkChildren(el, out, ctx);
    out.push("\n");
    return;
  }

  walkChildren(el, out, ctx);
}

function walkChildren(el: Element, out: string[], ctx: WalkContext): void {
  for (const child of Array.from(el.childNodes)) {
    walk(child, out, ctx);
  }
}

function normalizeText(s: string): string {
  return s.replace(/[\t\f\v]+/gu, " ").replace(/ {2,}/gu, " ").replace(/\n{3,}/gu, "\n\n");
}
