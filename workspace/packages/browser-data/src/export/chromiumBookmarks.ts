import type { ImportedBookmark } from "../types.js";

// Chrome epoch: 1601-01-01 00:00:00 UTC
// Difference from Unix epoch (1970-01-01) in microseconds
const CHROME_EPOCH_OFFSET = 11644473600000000n;

function unixMsToChrome(unixMs: number): string {
  return (BigInt(unixMs) * 1000n + CHROME_EPOCH_OFFSET).toString();
}

interface ChromeNode {
  children?: ChromeNode[];
  date_added: string;
  date_last_used?: string;
  date_modified?: string;
  id: string;
  name: string;
  type: "url" | "folder";
  url?: string;
}

interface FolderAccum {
  children: Map<string, FolderAccum>;
  bookmarks: ImportedBookmark[];
}

function buildFolder(bookmarks: ImportedBookmark[]): FolderAccum {
  const root: FolderAccum = { children: new Map(), bookmarks: [] };
  for (const bm of bookmarks) {
    let current = root;
    // Skip the first folder segment (already routed to bar/other)
    const segments = bm.folder.slice(1);
    for (const seg of segments) {
      let child = current.children.get(seg);
      if (!child) {
        child = { children: new Map(), bookmarks: [] };
        current.children.set(seg, child);
      }
      current = child;
    }
    current.bookmarks.push(bm);
  }
  return root;
}

let idCounter = 0;

function accumToNodes(accum: FolderAccum): ChromeNode[] {
  const nodes: ChromeNode[] = [];

  for (const bm of accum.bookmarks) {
    nodes.push({
      date_added: unixMsToChrome(bm.dateAdded),
      id: String(++idCounter),
      name: bm.title,
      type: "url",
      url: bm.url,
    });
  }

  for (const [name, child] of accum.children) {
    const earliest = Math.min(
      ...child.bookmarks.map((b) => b.dateAdded),
      ...Array.from(child.children.values()).flatMap((c) =>
        c.bookmarks.map((b) => b.dateAdded),
      ),
      Date.now(),
    );
    nodes.push({
      children: accumToNodes(child),
      date_added: unixMsToChrome(earliest),
      date_modified: unixMsToChrome(
        child.bookmarks.length > 0
          ? Math.max(
              ...child.bookmarks.map((b) => b.dateModified ?? b.dateAdded),
            )
          : earliest,
      ),
      id: String(++idCounter),
      name,
      type: "folder",
    });
  }

  return nodes;
}

function simpleChecksum(json: string): string {
  // Chrome uses MD5 but we produce a placeholder since we don't want to
  // pull in a crypto dependency just for this. Consumers can recalculate.
  let hash = 0;
  for (let i = 0; i < json.length; i++) {
    const ch = json.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

export function exportChromiumBookmarks(bookmarks: ImportedBookmark[]): string {
  // Reset id counter for deterministic output
  idCounter = 0;

  const barBookmarks = bookmarks.filter(
    (b) => b.folder.length > 0 && b.folder[0] === "Bookmarks Bar",
  );
  const otherBookmarks = bookmarks.filter(
    (b) => b.folder.length === 0 || b.folder[0] !== "Bookmarks Bar",
  );

  const barAccum = buildFolder(barBookmarks);
  const otherAccum = buildFolder(otherBookmarks);

  const roots = {
    bookmark_bar: {
      children: accumToNodes(barAccum),
      date_added: unixMsToChrome(Date.now()),
      date_modified: unixMsToChrome(Date.now()),
      id: String(++idCounter),
      name: "Bookmarks bar",
      type: "folder" as const,
    },
    other: {
      children: accumToNodes(otherAccum),
      date_added: unixMsToChrome(Date.now()),
      date_modified: unixMsToChrome(Date.now()),
      id: String(++idCounter),
      name: "Other bookmarks",
      type: "folder" as const,
    },
    synced: {
      children: [] as ChromeNode[],
      date_added: unixMsToChrome(Date.now()),
      date_modified: unixMsToChrome(0),
      id: String(++idCounter),
      name: "Mobile bookmarks",
      type: "folder" as const,
    },
  };

  const obj = { checksum: "", roots, version: 1 };
  const json = JSON.stringify(obj, null, 3);
  obj.checksum = simpleChecksum(json);

  return JSON.stringify(obj, null, 3);
}
