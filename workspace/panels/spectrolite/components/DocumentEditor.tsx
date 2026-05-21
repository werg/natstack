/**
 * Live MDX editor host.
 *
 * Wraps `@mdxeditor/editor`'s `MDXEditor` with our plugin set:
 *   - `headingsPlugin`, `listsPlugin`, `quotePlugin`, `thematicBreakPlugin`
 *   - `linkPlugin` + `linkDialogPlugin`
 *   - `codeBlockPlugin` + `codeMirrorPlugin` for fenced code
 *   - `diffSourcePlugin` — toggle between WYSIWYG and raw source (= the
 *     whole-doc "break open" escape hatch)
 *   - `jsxPlugin` + `GenericJsxEditor` — per-component WYSIWYG, with the
 *     generic editor as the fallback (= per-component "break open" hatch)
 *   - `frontmatterPlugin` so `---` YAML at the top is preserved
 *   - `toolbarPlugin` with the diff/source toggle button
 *
 * Owns:
 *   - reading the file on open
 *   - propagating in-memory edits to disk on flush
 *   - notifying parent of dirty state for the flush controller
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { promises as fs } from "fs";
import { Box, Button, Flex, SegmentedControl, Text } from "@radix-ui/themes";
import { LightningBoltIcon, ReloadIcon, EyeOpenIcon, Pencil1Icon } from "@radix-ui/react-icons";
import { PreviewPane } from "./PreviewPane";
import {
  MDXEditor,
  type MDXEditorMethods,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  linkDialogPlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  diffSourcePlugin,
  frontmatterPlugin,
  jsxPlugin,
  toolbarPlugin,
  GenericJsxEditor,
  DiffSourceToggleWrapper,
  UndoRedo,
  BoldItalicUnderlineToggles,
  CodeToggle,
  CreateLink,
  ListsToggle,
  BlockTypeSelect,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { knownJsxDescriptors } from "../mdx/runtime";

export interface DocumentEditorProps {
  /** Absolute repo root — paths are stored relative to this. */
  repoRoot: string;
  /** Relative path inside the repo root. */
  relPath: string;
  /** Editor theme — drives MDXEditor's `contentEditableClassName`. */
  theme: "light" | "dark";
  /**
   * Called on every change with the *current* markdown text. Used by the
   * flush controller to debounce quiescence.
   */
  onChange: (path: string, markdown: string) => void;
  /**
   * Called when the file is reloaded from disk (initial open OR after the
   * agent writes to it). Lets the parent update its in-memory `savedMdx`.
   */
  onReload: (path: string, markdown: string) => void;
  /** Trigger manual flush — wired to the "Flush" toolbar button. */
  onFlushClick: (path: string) => void;
  /** True when there are user-side edits since the last flush. */
  hasUnflushedChanges: boolean;
}

const POLL_MS = 1500;

export function DocumentEditor({
  repoRoot,
  relPath,
  theme,
  onChange,
  onReload,
  onFlushClick,
  hasUnflushedChanges,
}: DocumentEditorProps) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const editorRef = useRef<MDXEditorMethods | null>(null);
  const lastDiskRef = useRef<string | null>(null);
  const inFlightWriteRef = useRef(false);

  const fullPath = `${repoRoot}/${relPath}`;

  // Read on open + when the path changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const buf = await fs.readFile(fullPath, "utf-8");
        if (cancelled) return;
        lastDiskRef.current = buf;
        setMarkdown(buf);
        onReload(relPath, buf);
      } catch (err) {
        if (cancelled) return;
        setError(`Failed to read ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [fullPath, relPath, onReload]);

  // Poll for external (agent) writes. If the file changed on disk and the
  // user has no unflushed in-memory edits, reload. If there are unflushed
  // edits, skip — the user keeps editing; conflict resolution happens via
  // the diff/source view.
  useEffect(() => {
    const handle = setInterval(async () => {
      if (inFlightWriteRef.current) return;
      try {
        const buf = await fs.readFile(fullPath, "utf-8");
        if (buf === lastDiskRef.current) return;
        lastDiskRef.current = buf;
        if (hasUnflushedChanges) {
          console.info(`[Spectrolite] ${relPath} changed on disk while user has unflushed edits — keeping buffer`);
          return;
        }
        setMarkdown(buf);
        editorRef.current?.setMarkdown(buf);
        onReload(relPath, buf);
      } catch {
        /* file may have been deleted; ignore for v1 */
      }
    }, POLL_MS);
    return () => clearInterval(handle);
  }, [fullPath, relPath, hasUnflushedChanges, onReload]);

  const handleChange = useCallback((next: string) => {
    onChange(relPath, next);
  }, [onChange, relPath]);

  const flushNow = useCallback(() => {
    onFlushClick(relPath);
  }, [onFlushClick, relPath]);

  const descriptors = useMemo(() => {
    return knownJsxDescriptors().map((d) => ({ ...d, Editor: GenericJsxEditor }));
  }, []);

  const plugins = useMemo(() => [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    frontmatterPlugin(),
    codeBlockPlugin({ defaultCodeBlockLanguage: "tsx" }),
    codeMirrorPlugin({
      codeBlockLanguages: {
        tsx: "TSX",
        ts: "TypeScript",
        js: "JavaScript",
        json: "JSON",
        bash: "Shell",
        md: "Markdown",
        mdx: "MDX",
        "": "Plain",
      },
    }),
    diffSourcePlugin({ viewMode: "rich-text", diffMarkdown: "" }),
    jsxPlugin({ jsxComponentDescriptors: descriptors }),
    toolbarPlugin({
      toolbarContents: () => (
        <DiffSourceToggleWrapper>
          <UndoRedo />
          <BoldItalicUnderlineToggles />
          <CodeToggle />
          <CreateLink />
          <ListsToggle />
          <BlockTypeSelect />
          <Box style={{ flex: 1 }} />
          <Button
            size="1"
            variant={hasUnflushedChanges ? "solid" : "soft"}
            color={hasUnflushedChanges ? "amber" : "gray"}
            disabled={!hasUnflushedChanges}
            onClick={flushNow}
          >
            <LightningBoltIcon /> Flush
          </Button>
        </DiffSourceToggleWrapper>
      ),
    }),
  ], [descriptors, hasUnflushedChanges, flushNow]);

  if (error) {
    return (
      <Flex direction="column" gap="2" p="3">
        <Text color="red" size="2">{error}</Text>
        <Button size="1" variant="soft" onClick={() => { lastDiskRef.current = null; }}>
          <ReloadIcon /> Retry
        </Button>
      </Flex>
    );
  }

  if (markdown === null) {
    return (
      <Flex align="center" justify="center" style={{ height: "100%" }}>
        <Text size="2" color="gray">Loading {relPath}…</Text>
      </Flex>
    );
  }

  return (
    <Flex direction="column" className={`spectrolite-mdx ${theme === "dark" ? "dark-theme" : ""}`} style={{ height: "100%" }}>
      <Flex
        align="center"
        justify="end"
        gap="2"
        px="2"
        py="1"
        style={{ borderBottom: "1px solid var(--gray-5)", flexShrink: 0 }}
      >
        <SegmentedControl.Root size="1" value={mode} onValueChange={(v) => setMode(v as "edit" | "preview")}>
          <SegmentedControl.Item value="edit">
            <Flex align="center" gap="1"><Pencil1Icon /> Edit</Flex>
          </SegmentedControl.Item>
          <SegmentedControl.Item value="preview">
            <Flex align="center" gap="1"><EyeOpenIcon /> Preview</Flex>
          </SegmentedControl.Item>
        </SegmentedControl.Root>
      </Flex>
      <Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {mode === "edit" ? (
          <Box style={{ height: "100%", overflow: "auto" }}>
            <MDXEditor
              ref={editorRef}
              markdown={markdown}
              onChange={handleChange}
              plugins={plugins}
              contentEditableClassName={`spectrolite-content ${theme === "dark" ? "spectrolite-content--dark" : ""}`}
            />
          </Box>
        ) : (
          <PreviewPane markdown={markdown} />
        )}
      </Box>
    </Flex>
  );
}

/**
 * Write the in-memory buffer to disk. Called by the flush pipeline.
 * Exposed as a helper rather than a method on DocumentEditor so the flush
 * controller can write on its own schedule.
 */
export async function writeBufferToDisk(repoRoot: string, relPath: string, content: string): Promise<void> {
  const full = `${repoRoot}/${relPath}`;
  const lastSlash = full.lastIndexOf("/");
  if (lastSlash > 0) {
    await fs.mkdir(full.slice(0, lastSlash), { recursive: true });
  }
  await fs.writeFile(full, content);
}
