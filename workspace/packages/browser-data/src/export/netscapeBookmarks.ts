import type { ImportedBookmark } from "../types.js";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toUnixSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

interface FolderNode {
  name: string;
  children: Map<string, FolderNode>;
  bookmarks: ImportedBookmark[];
}

function buildTree(bookmarks: ImportedBookmark[]): FolderNode {
  const root: FolderNode = { name: "", children: new Map(), bookmarks: [] };

  for (const bm of bookmarks) {
    let current = root;
    for (const segment of bm.folder) {
      let child = current.children.get(segment);
      if (!child) {
        child = { name: segment, children: new Map(), bookmarks: [] };
        current.children.set(segment, child);
      }
      current = child;
    }
    current.bookmarks.push(bm);
  }

  return root;
}

function renderFolder(node: FolderNode, indent: number): string {
  const pad = "    ".repeat(indent);
  const lines: string[] = [];

  // Render bookmarks in this folder
  for (const bm of node.bookmarks) {
    const addDate = toUnixSeconds(bm.dateAdded);
    lines.push(
      `${pad}<DT><A HREF="${escapeHtml(bm.url)}" ADD_DATE="${addDate}">${escapeHtml(bm.title)}</A>`,
    );
  }

  // Render subfolders
  for (const child of node.children.values()) {
    const addDate = child.bookmarks.length > 0 || child.children.size > 0
      ? toUnixSeconds(
          Math.min(
            ...child.bookmarks.map((b) => b.dateAdded),
            ...Array.from(child.children.values()).flatMap((c) =>
              c.bookmarks.map((b) => b.dateAdded),
            ),
            Date.now(),
          ),
        )
      : toUnixSeconds(Date.now());

    const lastModified = child.bookmarks.length > 0
      ? toUnixSeconds(
          Math.max(...child.bookmarks.map((b) => b.dateModified ?? b.dateAdded)),
        )
      : addDate;

    lines.push(
      `${pad}<DT><H3 ADD_DATE="${addDate}" LAST_MODIFIED="${lastModified}">${escapeHtml(child.name)}</H3>`,
    );
    lines.push(`${pad}<DL><p>`);
    lines.push(renderFolder(child, indent + 1));
    lines.push(`${pad}</DL><p>`);
  }

  return lines.join("\n");
}

export function exportNetscapeBookmarks(bookmarks: ImportedBookmark[]): string {
  const tree = buildTree(bookmarks);

  const header = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>`;

  const body = renderFolder(tree, 1);
  const footer = `</DL><p>`;

  return `${header}\n${body}\n${footer}\n`;
}
