/**
 * Minimal MDX file browser for the active context's filesystem.
 *
 * Lists every `.mdx` under the workspace root, lets the user open one in the
 * editor. Single-click selection — no drag/drop, no rename, no folders-as-
 * folders. New files are created via the "+ New" button.
 */

import { useCallback, useEffect, useState } from "react";
import { promises as fs } from "fs";
import { Box, Button, Callout, Code, Flex, ScrollArea, Text, TextField } from "@radix-ui/themes";
import { FileTextIcon, PlusIcon, ReloadIcon, ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { listMdxPaths } from "../state/workspacePaths";
import { joinSafe, parentDir } from "../state/safePath";

export interface FileTreeProps {
  root: string;
  activePath: string | null;
  onOpen: (path: string) => void;
  refreshNonce?: number;
  /** Optional: notify parent when the path list refreshes (so wikilink resolution caches stay in sync). */
  onPathsRefreshed?: (paths: string[]) => void;
}

export function FileTree({ root, activePath, onOpen, refreshNonce, onPathsRefreshed }: FileTreeProps) {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listMdxPaths(root);
      setFiles(list);
      onPathsRefreshed?.(list);
    } finally {
      setLoading(false);
    }
  }, [root, onPathsRefreshed]);

  useEffect(() => { void refresh(); }, [refresh, refreshNonce]);

  const handleCreate = useCallback(async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreateError(null);
    const relPath = trimmed.endsWith(".mdx") ? trimmed : `${trimmed}.mdx`;
    // Reject `../` traversal and absolute paths that would escape root.
    const full = joinSafe(root, relPath);
    if (!full) {
      setCreateError(`"${relPath}" escapes the workspace root`);
      return;
    }
    // Refuse to clobber an existing file.
    try {
      await fs.stat(full);
      setCreateError(`"${relPath}" already exists`);
      return;
    } catch {
      // ENOENT → safe to create
    }
    const parent = parentDir(full);
    if (parent) {
      try { await fs.mkdir(parent, { recursive: true }); } catch (err) {
        console.warn("[Spectrolite] mkdir failed:", err);
      }
    }
    try {
      // Exclusive-create: fail rather than clobber. We do NOT fall back to
      // a plain writeFile on non-EEXIST errors — an unknown failure
      // (EACCES, ENOSPC, etc.) shouldn't be silently downgraded to an
      // overwrite that could destroy a concurrently-created file. The
      // earlier stat() narrows the typical case; the `wx` flag closes
      // the residual race.
      const fsWithFlags = fs as unknown as { writeFile(p: string, data: string, opts?: { flag?: string }): Promise<void> };
      await fsWithFlags.writeFile(full, `# ${trimmed.replace(/\.mdx$/, "")}\n\n`, { flag: "wx" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/eexist/i.test(msg)) {
        setCreateError(`"${relPath}" already exists`);
        return;
      }
      console.warn("[Spectrolite] Failed to create file:", err);
      setCreateError(msg);
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
          onChange={(e) => { setNewName(e.target.value); if (createError) setCreateError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") void handleCreate(); }}
          style={{ flex: 1 }}
        />
        <Button size="1" variant="soft" onClick={() => void handleCreate()} disabled={!newName.trim()}>
          <PlusIcon />
        </Button>
      </Flex>
      {createError ? (
        <Callout.Root size="1" color="red">
          <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
          <Callout.Text size="1">{createError}</Callout.Text>
        </Callout.Root>
      ) : null}
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
