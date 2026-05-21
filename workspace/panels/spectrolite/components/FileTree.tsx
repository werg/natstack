/**
 * Minimal MDX file browser for the active context's filesystem.
 *
 * Lists every `.mdx` under the workspace root, lets the user open one in the
 * editor. Single-click selection — no drag/drop, no rename, no folders-as-
 * folders. New files are created via the "+ New" button.
 */

import { useCallback, useEffect, useState } from "react";
import { promises as fs } from "fs";
import { Box, Button, Code, Flex, ScrollArea, Text, TextField } from "@radix-ui/themes";
import { FileTextIcon, PlusIcon, ReloadIcon } from "@radix-ui/react-icons";

export interface FileTreeProps {
  root: string;
  activePath: string | null;
  onOpen: (path: string) => void;
  refreshNonce?: number;
}

async function walkMdx(root: string, dir: string): Promise<string[]> {
  let entries: { name: string; isDirectory: () => boolean }[] = [];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as unknown as { name: string; isDirectory: () => boolean }[];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await walkMdx(root, full)));
    } else if (entry.name.endsWith(".mdx")) {
      out.push(full.startsWith(`${root}/`) ? full.slice(root.length + 1) : full);
    }
  }
  return out.sort();
}

export function FileTree({ root, activePath, onOpen, refreshNonce }: FileTreeProps) {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await walkMdx(root, root);
      setFiles(list);
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => { void refresh(); }, [refresh, refreshNonce]);

  const handleCreate = useCallback(async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const relPath = trimmed.endsWith(".mdx") ? trimmed : `${trimmed}.mdx`;
    const full = `${root}/${relPath}`;
    const lastSlash = full.lastIndexOf("/");
    if (lastSlash > 0) {
      await fs.mkdir(full.slice(0, lastSlash), { recursive: true });
    }
    try {
      await fs.writeFile(full, `# ${trimmed.replace(/\.mdx$/, "")}\n\n`);
    } catch (err) {
      console.warn("[Spectrolite] Failed to create file:", err);
      return;
    }
    setNewName("");
    await refresh();
    onOpen(relPath);
  }, [newName, root, refresh, onOpen]);

  return (
    <Flex direction="column" gap="2" style={{ height: "100%", padding: "var(--space-2)" }}>
      <Flex align="center" justify="between" gap="2">
        <Text size="1" weight="medium" color="gray">FILES</Text>
        <Button size="1" variant="ghost" color="gray" onClick={() => void refresh()} aria-label="Refresh">
          <ReloadIcon />
        </Button>
      </Flex>
      <Flex gap="1">
        <TextField.Root
          size="1"
          placeholder="new-note.mdx"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void handleCreate(); }}
          style={{ flex: 1 }}
        />
        <Button size="1" variant="soft" onClick={() => void handleCreate()} disabled={!newName.trim()}>
          <PlusIcon />
        </Button>
      </Flex>
      <Box style={{ flex: 1, minHeight: 0 }}>
        <ScrollArea>
          {loading ? (
            <Text size="1" color="gray">Loading…</Text>
          ) : files.length === 0 ? (
            <Text size="1" color="gray">No .mdx files yet</Text>
          ) : (
            <Flex direction="column" gap="0">
              {files.map((path) => {
                const active = path === activePath;
                return (
                  <Button
                    key={path}
                    size="1"
                    variant={active ? "soft" : "ghost"}
                    color={active ? "blue" : "gray"}
                    onClick={() => onOpen(path)}
                    style={{ justifyContent: "flex-start", textAlign: "left" }}
                  >
                    <FileTextIcon />
                    <Code variant="ghost" size="1">{path}</Code>
                  </Button>
                );
              })}
            </Flex>
          )}
        </ScrollArea>
      </Box>
    </Flex>
  );
}
