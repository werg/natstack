/**
 * Backlinks panel — lists every file in the workspace that has a wikilink
 * pointing at the active file.
 *
 * Computed on demand by grepping each `.mdx` for the active file's
 * basename (without `.mdx`) inside `[[…]]` brackets. Scans are bounded
 * and concurrent so large vaults do not serialize thousands of file
 * reads onto the UI update path. v1 caches per (activePath, refreshKey)
 * — invalidate by bumping `refreshKey` after flush or commit.
 */

import { useEffect, useState } from "react";
import { promises as fs } from "fs";
import { Box, Code, Flex, Link, ScrollArea, Text } from "@radix-ui/themes";
import { Link2Icon } from "@radix-ui/react-icons";
import { extractWikilinks } from "../mdx/wikilink";

export interface BacklinksPanelProps {
  root: string;
  /** Active file, relative to root. */
  activePath: string | null;
  /** Workspace `.mdx` paths (relative). Refreshed by FileTree. */
  paths: string[];
  /** Bump to force re-scan after flush/commit. */
  refreshKey: number;
  /** Click handler — opens the referencing file in the editor. */
  onOpen: (path: string) => void;
}

interface Backlink {
  fromPath: string;
  /** Snippet of the line containing the wikilink, for context. */
  snippet: string;
}

const DEFAULT_BACKLINK_CONCURRENCY = 24;

export interface FindBacklinksOptions {
  concurrency?: number;
}

function basenameNoExt(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.mdx$/, "");
}

export async function findBacklinks(
  root: string,
  activePath: string,
  candidatePaths: string[],
  options: FindBacklinksOptions = {},
): Promise<Backlink[]> {
  const targetName = basenameNoExt(activePath);
  const fullTarget = activePath.replace(/\.mdx$/, "");
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_BACKLINK_CONCURRENCY));
  const candidates = candidatePaths.filter((path) => path !== activePath);

  async function scan(path: string): Promise<Backlink | null> {
    let content: string;
    try {
      content = await fs.readFile(`${root}/${path}`, "utf-8");
    } catch {
      return null;
    }
    if (!content.includes("[[") || (!content.includes(targetName) && !content.includes(fullTarget))) {
      return null;
    }
    const targets = extractWikilinks(content);
    const hit = targets.some((t) => {
      const trimmed = t.endsWith(".mdx") ? t.slice(0, -4) : t;
      return trimmed === targetName || trimmed === fullTarget || trimmed.endsWith(`/${targetName}`);
    });
    if (!hit) return null;
    const lineMatch = content.split("\n").find((line) => line.includes("[[") && (line.includes(targetName) || line.includes(fullTarget)));
    return { fromPath: path, snippet: lineMatch?.trim().slice(0, 120) ?? "" };
  }

  const out: Backlink[] = [];
  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(scan));
    for (const backlink of results) {
      if (backlink) out.push(backlink);
    }
  }
  return out;
}

export function BacklinksPanel({ root, activePath, paths, refreshKey, onOpen }: BacklinksPanelProps) {
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!activePath) {
      setBacklinks([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void findBacklinks(root, activePath, paths)
      .then((bl) => { if (!cancelled) setBacklinks(bl); })
      .catch(() => { if (!cancelled) setBacklinks([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [root, activePath, paths, refreshKey]);

  if (!activePath) return null;

  return (
    <Flex direction="column" gap="1" p="2" style={{ borderTop: "1px solid var(--gray-5)" }} data-testid="spectrolite-backlinks">
      <Flex align="center" gap="1">
        <Link2Icon />
        <Text size="1" weight="medium" color="gray">BACKLINKS</Text>
        <Text size="1" color="gray">· {backlinks.length}</Text>
      </Flex>
      <Box style={{ maxHeight: "30vh" }}>
        <ScrollArea>
          {loading ? (
            <Text size="1" color="gray">Scanning…</Text>
          ) : backlinks.length === 0 ? (
            <Text size="1" color="gray">None</Text>
          ) : (
            <Flex direction="column" gap="1">
              {backlinks.map((bl) => (
                <Box key={bl.fromPath}>
                  <Link size="1" onClick={(e) => { e.preventDefault(); onOpen(bl.fromPath); }} href="#" data-testid={`spectrolite-backlink-${bl.fromPath}`}>
                    <Code variant="ghost" size="1">{bl.fromPath}</Code>
                  </Link>
                  {bl.snippet ? (
                    <Text as="div" size="1" color="gray" style={{ marginLeft: "var(--space-2)" }}>
                      {bl.snippet}
                    </Text>
                  ) : null}
                </Box>
              ))}
            </Flex>
          )}
        </ScrollArea>
      </Box>
    </Flex>
  );
}
