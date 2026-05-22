/**
 * Workspace path index. Keeps a list of every `.mdx` file under the repo
 * root, refreshed on demand (after flush or commit, or when the user
 * creates a file). Used for wikilink resolution and the backlinks panel.
 */

import { promises as fs } from "fs";

const DEFAULT_WALK_CONCURRENCY = 16;

export interface ListMdxPathsOptions {
  concurrency?: number;
}

export async function listMdxPaths(root: string, options: ListMdxPathsOptions = {}): Promise<string[]> {
  let pending = [root];
  const out: string[] = [];
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_WALK_CONCURRENCY));

  async function scan(dir: string): Promise<string[]> {
    let entries: { name: string; isDirectory: () => boolean }[] = [];
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })) as unknown as { name: string; isDirectory: () => boolean }[];
    } catch {
      return [];
    }
    const nextDirs: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        nextDirs.push(full);
      } else if (e.name.endsWith(".mdx")) {
        out.push(full.startsWith(`${root}/`) ? full.slice(root.length + 1) : full);
      }
    }
    return nextDirs;
  }

  while (pending.length > 0) {
    const batch = pending.splice(0, concurrency);
    const next = await Promise.all(batch.map(scan));
    pending = pending.concat(next.flat());
  }
  return out.sort();
}
