/**
 * Live MDX editor host.
 *
 * Wraps `@mdxeditor/editor`'s `MDXEditor` with our plugin set:
 *   - `headingsPlugin`, `listsPlugin`, `quotePlugin`, `thematicBreakPlugin`
 *   - `linkPlugin` + `linkDialogPlugin`
 *   - `codeBlockPlugin` + `codeMirrorPlugin` for fenced code
 *   - `diffSourcePlugin` — toggle between WYSIWYG and raw source (= the
 *     whole-doc "break open" escape hatch)
 *   - `jsxPlugin` + `LiveJsxEditor` — per-component live render via
 *     `compileComponent`, falls back to GenericJsxEditor on errors via the
 *     LiveJsxEditor itself
 *   - `frontmatterPlugin` so `---` YAML at the top is preserved
 *   - `toolbarPlugin` with the diff/source toggle button
 *
 * Wikilink bridge: on read, `[[Page]]` becomes `<WikiLink target="Page" />`;
 * on flush (Workspace.tsx calls writeBufferToDisk), JSX wikilinks become
 * `[[Page]]` again. This keeps the on-disk format Obsidian-compatible
 * while letting MDXEditor render wikilinks as proper JSX with our
 * `WikiLink` component.
 *
 * Mention autocomplete: `MentionAutocomplete` attaches a DOM keydown
 * listener to the editor's contenteditable root, opens a popover on `@`,
 * and inserts the chosen handle as plain text via execCommand. Lexical
 * observes the contenteditable mutations and updates its state.
 *
 * Owns:
 *   - reading the file on open (and applying wikilink read-transform)
 *   - propagating in-memory edits to disk on flush
 *   - notifying parent of dirty state for the flush controller
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { promises as fs } from "fs";
import { Box, Button, Callout, Flex, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon, LightningBoltIcon, ReloadIcon } from "@radix-ui/react-icons";
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
  DiffSourceToggleWrapper,
  UndoRedo,
  BoldItalicUnderlineToggles,
  CodeToggle,
  CreateLink,
  ListsToggle,
  BlockTypeSelect,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { MentionAutocomplete, type MentionCandidate } from "./MentionAutocomplete";
import { knownJsxDescriptors } from "../mdx/runtime";
import { LiveJsxEditor } from "../mdx/LiveJsxEditor";
import { wikilinksFromJsx, wikilinksToJsx } from "../mdx/wikilink";
import { DocStateContext, type DocStateContextValue, useDocState } from "../mdx/docState";
import { parseFrontmatter, replaceFrontmatterState } from "../mdx/frontmatter";
import { compileDocModule, exportNamesFromSource, type CompiledDocModule } from "../mdx/docModule";
import { DepsContext, runtimeNamespace } from "../mdx/runtimeNamespace";
import { joinSafe, parentDir } from "../state/safePath";

export interface DocumentEditorProps {
  repoRoot: string;
  relPath: string;
  theme: "light" | "dark";
  onChange: (path: string, markdown: string) => void;
  onReload: (path: string, markdown: string) => void;
  onFlushClick: (path: string) => void;
  hasUnflushedChanges: boolean;
  /** Mention candidates from the channel roster. */
  mentionCandidates: MentionCandidate[];
  /** Frontmatter-declared dependencies; passed to inline JSX + preview compile. */
  dependencies: Record<string, string>;
}

const POLL_MS = 600;
/**
 * Debounce window for merging in-memory `state:` mutations back into the
 * MDX frontmatter. Short enough that the user sees state changes
 * reflected in the diff/source view on a glance; long enough that
 * dragging a slider doesn't rewrite the frontmatter on every animation
 * frame.
 */
const DOC_STATE_MERGE_MS = 600;
/**
 * Debounce window for the whole-doc compile. Recomputed only often
 * enough to feel responsive (~half a second after the user pauses);
 * coalesces sustained typing into one compile.
 */
const DOC_MODULE_COMPILE_MS = 500;

function isMissingFileError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /enoent/i.test(msg) || /no such file/i.test(msg);
}

export function DocumentEditor({
  repoRoot,
  relPath,
  theme,
  onChange,
  onReload,
  onFlushClick,
  hasUnflushedChanges,
  mentionCandidates,
  dependencies,
}: DocumentEditorProps) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<MDXEditorMethods | null>(null);
  const lastDiskRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [contentEditableEl, setContentEditableEl] = useState<HTMLElement | null>(null);

  // Doc-level compile output. `exportNames` is the list of export
  // identifiers visible to inline JSX nodes (so they can use `<Counter />`
  // when the same doc defines `export const Counter = …`). `version` is
  // bumped after each successful compile so LiveJsxEditor instances
  // recompile and pick up updated export bodies.
  const [docExportNames, setDocExportNames] = useState<ReadonlyArray<string>>([]);
  const [docExportsVersion, setDocExportsVersion] = useState(0);
  const [docCompileError, setDocCompileError] = useState<string | null>(null);
  const docCompileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // In-memory state map mirrors the doc's frontmatter `state:` block.
  // Mutations from `useDocState` setters land here immediately so that
  // every other consumer re-renders, but the merge into the markdown
  // buffer is debounced — we don't want to rewrite the frontmatter on
  // every slider tick.
  const [docState, setDocState] = useState<Record<string, unknown>>({});
  const docStateRef = useRef(docState);
  docStateRef.current = docState;
  const mergeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const relPathRef = useRef(relPath);
  relPathRef.current = relPath;
  const hasUnflushedChangesRef = useRef(hasUnflushedChanges);
  hasUnflushedChangesRef.current = hasUnflushedChanges;

  // Conflict banner: set when the agent writes the file while the user
  // has unflushed in-buffer changes. The user picks which side wins.
  const [diskConflict, setDiskConflict] = useState<{ disk: string } | null>(null);
  // Set when the file no longer exists on disk (deleted out from
  // under us). Editor keeps the in-memory buffer; user can choose to
  // recreate or discard.
  const [fileMissing, setFileMissing] = useState(false);

  // Resolved + traversal-checked. Defensive even though the panel's fs is
  // RPC-scoped to the context root.
  const fullPath = useMemo(() => joinSafe(repoRoot, relPath), [repoRoot, relPath]);

  const loadFromDisk = useCallback(async (signal?: { cancelled: boolean }) => {
    if (!fullPath) {
      setError(`Refusing to open "${relPath}" — path escapes the workspace root.`);
      return;
    }
    try {
      const raw = await fs.readFile(fullPath, "utf-8");
      if (signal?.cancelled) return;
      const transformed = wikilinksToJsx(raw);
      lastDiskRef.current = raw;
      setMarkdown(transformed);
      setError(null);
      // Cancel any in-flight state merge; the on-disk content is authoritative.
      if (mergeTimerRef.current) {
        clearTimeout(mergeTimerRef.current);
        mergeTimerRef.current = null;
      }
      setDocState(parseFrontmatter(transformed).state);
      editorRef.current?.setMarkdown(transformed);
      onReload(relPath, transformed);
    } catch (err) {
      if (signal?.cancelled) return;
      if (isMissingFileError(err)) {
        lastDiskRef.current = null;
        setError(null);
        setFileMissing(true);
        setMarkdown((prev) => prev ?? "");
        return;
      }
      setError(`Failed to read ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [fullPath, relPath, onReload]);

  // Read on open + when the path changes. Also clear the globalThis
  // doc-export stash so a previous doc's `Counter` etc. can't briefly
  // resolve in the new doc's inline JSX before our compile catches up.
  useEffect(() => {
    (globalThis as Record<string, unknown>)["__spectroliteDocExports__"] = {};
    setMarkdown(null);
    setError(null);
    setDiskConflict(null);
    setFileMissing(false);
    lastDiskRef.current = null;
    const signal = { cancelled: false };
    void loadFromDisk(signal);
    return () => { signal.cancelled = true; };
  }, [loadFromDisk]);

  // Poll for external (agent) file writes. On detected change, reload AND
  // clear any stale error state (the previous read may have failed because
  // the file didn't exist yet).
  useEffect(() => {
    if (!fullPath) return;
    const handle = setInterval(async () => {
      try {
        const raw = await fs.readFile(fullPath, "utf-8");
        if (raw === lastDiskRef.current) return;
        lastDiskRef.current = raw;
        if (fileMissing) setFileMissing(false);
        if (hasUnflushedChangesRef.current) {
          // Don't silently drop the user's in-buffer work — surface a
          // conflict banner instead so they pick the winner.
          setDiskConflict({ disk: raw });
          return;
        }
        // Safe reload path: merge our in-memory state map into the new
        // disk content's frontmatter so component-state updates the
        // user just made aren't lost when the agent's write arrives.
        const transformed = wikilinksToJsx(raw);
        const merged = Object.keys(docStateRef.current).length > 0
          ? replaceFrontmatterState(transformed, docStateRef.current)
          : transformed;
        setMarkdown(merged);
        setError(null);
        // Frontmatter from disk wins for state keys the user hasn't
        // touched; keys the user updated locally are preserved by the
        // `merged` re-application above. Refresh docState from the
        // *merged* version so future renders read the same source of
        // truth as the buffer.
        if (mergeTimerRef.current) {
          clearTimeout(mergeTimerRef.current);
          mergeTimerRef.current = null;
        }
        setDocState(parseFrontmatter(merged).state);
        editorRef.current?.setMarkdown(merged);
        onReload(relPath, merged);
      } catch (err) {
        // ENOENT means the file disappeared — likely deleted by the
        // agent or out-of-band. Surface a banner; the in-memory buffer
        // is the user's only copy now.
        if (isMissingFileError(err)) {
          if (!fileMissing) setFileMissing(true);
        }
        /* ignore other transient read errors */
      }
    }, POLL_MS);
    return () => clearInterval(handle);
  }, [fullPath, relPath, onReload, fileMissing]);

  // Conflict resolution actions. "Keep mine" preserves the buffer (next
  // flush will overwrite the disk version). "Take agent's" reloads from
  // disk (the user's unflushed prose changes are lost; their `state:`
  // map is merged into the agent's content).
  const resolveConflictKeepMine = useCallback(() => {
    setDiskConflict(null);
  }, []);
  const resolveConflictTakeDisk = useCallback(() => {
    const conflict = diskConflict;
    if (!conflict) return;
    setDiskConflict(null);
    const transformed = wikilinksToJsx(conflict.disk);
    const merged = Object.keys(docStateRef.current).length > 0
      ? replaceFrontmatterState(transformed, docStateRef.current)
      : transformed;
    if (mergeTimerRef.current) {
      clearTimeout(mergeTimerRef.current);
      mergeTimerRef.current = null;
    }
    setMarkdown(merged);
    setDocState(parseFrontmatter(merged).state);
    editorRef.current?.setMarkdown(merged);
    onReload(relPath, merged);
  }, [diskConflict, onReload, relPath]);

  const recreateMissingFile = useCallback(async () => {
    if (!fullPath || markdown === null) return;
    try {
      const parent = parentDir(fullPath);
      if (parent) await fs.mkdir(parent, { recursive: true });
      const onDisk = wikilinksFromJsx(markdown);
      await fs.writeFile(fullPath, onDisk);
      lastDiskRef.current = onDisk;
      setFileMissing(false);
      setError(null);
      onReload(relPath, markdown);
    } catch (err) {
      setError(`Failed to recreate ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [fullPath, markdown, onReload, relPath]);

  // Whole-doc compile pipeline. Each meaningful markdown change kicks a
  // debounced re-compile. We keep last-good export bodies installed on
  // globalThis even when the current source has a syntax error so
  // existing inline JSX nodes don't briefly lose their components while
  // the user is mid-typing a new export.
  const recompileDoc = useCallback(async (mdxSource: string) => {
    let module: CompiledDocModule | null;
    try {
      module = await compileDocModule(mdxSource);
    } catch {
      module = null;
    }
    if (!module) {
      setDocCompileError("Doc compile failed (existing components keep last-known render).");
      return;
    }
    setDocCompileError(null);
    const g = globalThis as Record<string, unknown>;
    g["__spectroliteDocExports__"] = module.exports;
    setDocExportNames((prev) => {
      const next = [...module.exportNames];
      const prevKey = prev.join(",");
      const nextKey = next.join(",");
      return prevKey === nextKey ? prev : next;
    });
    setDocExportsVersion((v) => v + 1);
  }, []);

  const scheduleDocCompile = useCallback((mdxSource: string) => {
    if (docCompileTimerRef.current) clearTimeout(docCompileTimerRef.current);
    // Fast path: docs with no `export` declarations can't bring new
    // names into scope, so skip the compile entirely.
    if (!/(^|\n)\s*export\s/.test(mdxSource)) {
      if (docExportNames.length > 0) {
        (globalThis as Record<string, unknown>)["__spectroliteDocExports__"] = {};
        setDocExportNames([]);
        setDocExportsVersion((v) => v + 1);
        setDocCompileError(null);
      }
      return;
    }
    docCompileTimerRef.current = setTimeout(() => {
      docCompileTimerRef.current = null;
      void recompileDoc(mdxSource);
    }, DOC_MODULE_COMPILE_MS);
  }, [docExportNames.length, recompileDoc]);

  // Initial compile on file open + on disk reload (markdown changes
  // through state, regardless of source).
  useEffect(() => {
    if (markdown === null) return;
    scheduleDocCompile(markdown);
  }, [markdown, scheduleDocCompile]);

  // Drop the doc-compile timer on unmount.
  useEffect(() => () => {
    if (docCompileTimerRef.current) clearTimeout(docCompileTimerRef.current);
  }, []);

  // MDXEditor doesn't know about our in-memory state map, so its
  // emitted markdown has the stale-frontmatter version. Merge state in
  // here so the buffer (and disk, on flush) always reflects the latest
  // state map. The editor's own Lexical state stays as-is — we never
  // call setMarkdown during normal editing, so the user's cursor
  // doesn't jump on state changes.
  const handleChange = useCallback((next: string) => {
    const stateMap = docStateRef.current;
    const merged = Object.keys(stateMap).length > 0
      ? replaceFrontmatterState(next, stateMap)
      : next;
    onChange(relPath, merged);
    scheduleDocCompile(merged);
  }, [onChange, relPath, scheduleDocCompile]);

  const flushNow = useCallback(() => {
    onFlushClick(relPath);
  }, [onFlushClick, relPath]);

  // useDocState setter — invoked by inline JSX components. The update
  // happens in two steps:
  //   1. We update the in-memory state map immediately so the React
  //      context re-renders and every other useDocState consumer sees
  //      the new value within the same tick.
  //   2. We schedule a debounced merge into the editor buffer. After
  //      DOC_STATE_MERGE_MS of no further state changes, we rewrite the
  //      frontmatter's `state:` block and push the new markdown into
  //      the editor via setMarkdown. The editor's onChange fires and
  //      routes through handleEditorChange in the usual way, so the
  //      flush pipeline picks the doc up as dirty.
  const handleDocStateChange = useCallback((key: string, update: unknown) => {
    setDocState((prev) => {
      // Resolve functional updates against the LATEST state map (the
      // `prev` argument here is React's freshest value), not against a
      // render-time snapshot. Without this, two setX(n => n+1) calls
      // in the same tick both see the same prev and collapse to a
      // single increment.
      const resolved = typeof update === "function"
        ? (update as (prev: unknown) => unknown)(prev[key])
        : update;
      const current = prev[key];
      // Skip the update if the new value is structurally equal — common
      // when controlled inputs re-emit the same value on focus changes.
      if (Object.is(current, resolved)) return prev;
      try {
        if (JSON.stringify(current) === JSON.stringify(resolved)) return prev;
      } catch { /* fallthrough */ }
      return { ...prev, [key]: resolved };
    });
    if (mergeTimerRef.current) clearTimeout(mergeTimerRef.current);
    mergeTimerRef.current = setTimeout(() => {
      mergeTimerRef.current = null;
      const editor = editorRef.current;
      if (!editor) return;
      const current = editor.getMarkdown();
      const newMdx = replaceFrontmatterState(current, docStateRef.current);
      if (newMdx === current) return;
      // CRITICAL: don't call setMarkdown here. That would replace
      // Lexical's editor state and jump the user's cursor — annoying
      // when they're mid-prose and a JSX button updates state. Instead
      // route the merged markdown straight to the parent buffer via
      // onChange. The editor's view of the frontmatter stays slightly
      // stale (the source-view toggle would show old state values),
      // but the on-disk + in-buffer truth is current, and the user's
      // editing focus is preserved. Next time the editor fires an
      // onChange (user types), handleChange re-merges state into its
      // emitted markdown so the buffer stays correct.
      onChangeRef.current(relPathRef.current, newMdx);
      scheduleDocCompile(newMdx);
    }, DOC_STATE_MERGE_MS);
  }, [scheduleDocCompile]);

  const flushPendingDocStateMerge = useCallback(() => {
    if (mergeTimerRef.current) {
      clearTimeout(mergeTimerRef.current);
      mergeTimerRef.current = null;
    }
    const editor = editorRef.current;
    if (!editor) return;
    const current = editor.getMarkdown();
    const newMdx = replaceFrontmatterState(current, docStateRef.current);
    if (newMdx === current) return;
    onChangeRef.current(relPathRef.current, newMdx);
    void writeBufferToDisk(repoRoot, relPathRef.current, newMdx).catch((err) => {
      console.warn(`[Spectrolite] state merge write failed for ${relPathRef.current}:`, err);
    });
  }, [repoRoot]);

  // Merge pending component state before unmount/path changes so a quick
  // vault switch or panel close does not discard the latest state update.
  useEffect(() => () => {
    flushPendingDocStateMerge();
  }, [flushPendingDocStateMerge]);

  const docStateContextValue: DocStateContextValue = useMemo(() => ({
    state: docState,
    setState: handleDocStateChange,
  }), [docState, handleDocStateChange]);

  // Expose useDocState + the runtime namespace + the panel-aware
  // responsive hooks to sandbox-compiled JSX (LiveJsxEditor wrapper and
  // runtime.Eval blocks) via globalThis backdoors. The sandbox can't
  // `import` panel-local modules, so we publish the hooks/components
  // alongside the panel's other globals. The hooks use React context,
  // so they pick up the active providers below.
  useEffect(() => {
    const g = globalThis as Record<string, unknown>;
    g["__spectroliteUseDocState__"] = useDocState;
    g["__spectroliteRuntime__"] = runtimeNamespace;
    g["__spectroliteUseIsMobile__"] = runtimeNamespace["useIsMobile"];
    g["__spectroliteUseTouchDevice__"] = runtimeNamespace["useTouchDevice"];
    g["__spectroliteUseViewportHeight__"] = runtimeNamespace["useViewportHeight"];
  }, []);

  // (Whole-doc compile pipeline lives above, near the top of the
  // component, so handleChange and other hooks can reference it.)

  // Locate the contenteditable root for the mention autocomplete keylistener
  useEffect(() => {
    if (!containerRef.current) return;
    const find = () => {
      const el = containerRef.current?.querySelector<HTMLElement>("[contenteditable=\"true\"]");
      if (el && el !== contentEditableEl) setContentEditableEl(el);
    };
    find();
    const observer = new MutationObserver(find);
    observer.observe(containerRef.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [contentEditableEl]);

  const descriptors = useMemo(() => {
    // Bind the current dependency map + doc exports into each per-node
    // Editor so live-compiled JSX can resolve frontmatter-declared
    // packages AND references like `<Counter />` where Counter is an
    // `export const Counter = …` declared earlier in the same doc.
    const EditorWithDeps = (jsxProps: Parameters<typeof LiveJsxEditor>[0]) =>
      <LiveJsxEditor
        {...jsxProps}
        dependencies={dependencies}
        docExportNames={docExportNames}
        docExportsVersion={docExportsVersion}
      />;
    return knownJsxDescriptors().map((d) => ({ ...d, Editor: EditorWithDeps }));
  }, [dependencies, docExportNames, docExportsVersion]);

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

  const handleMentionAccept = useCallback((_handle: string) => {
    // The MentionAutocomplete adapter already performed the contenteditable
    // mutation via execCommand. Trigger a synthetic change so Lexical's
    // editorState picks up the new text via getMarkdown.
    const md = editorRef.current?.getMarkdown();
    if (md != null) onChange(relPath, md);
  }, [onChange, relPath]);

  if (error) {
    return (
      <Flex direction="column" gap="2" p="3">
        <Text color="red" size="2">{error}</Text>
        <Button
          size="1"
          variant="soft"
          onClick={() => {
            lastDiskRef.current = null;
            void loadFromDisk();
          }}
        >
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
    <DocStateContext.Provider value={docStateContextValue}>
      <DepsContext.Provider value={dependencies}>
        <Flex direction="column" className={`spectrolite-mdx ${theme === "dark" ? "dark-theme" : ""}`} style={{ height: "100%" }}>
          {diskConflict ? (
            <Callout.Root color="amber" size="1" style={{ borderRadius: 0, borderLeft: 0, borderRight: 0 }} data-testid="spectrolite-disk-conflict">
              <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
              <Callout.Text size="2">
                This file was changed on disk while you have unflushed edits.
              </Callout.Text>
              <Flex gap="2" mt="2">
                <Button size="2" variant="solid" color="amber" onClick={resolveConflictTakeDisk}>
                  Reload from disk
                </Button>
                <Button size="2" variant="soft" color="gray" onClick={resolveConflictKeepMine}>
                  Keep my edits
                </Button>
              </Flex>
            </Callout.Root>
          ) : null}
          {fileMissing ? (
            <Callout.Root color="red" size="1" style={{ borderRadius: 0, borderLeft: 0, borderRight: 0 }} data-testid="spectrolite-file-missing">
              <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
              <Callout.Text size="2">
                This file no longer exists on disk. Your in-memory buffer is the only copy. Recreate it, or pick another file.
              </Callout.Text>
              <Flex gap="2" mt="2">
                <Button size="2" variant="solid" color="red" onClick={() => void recreateMissingFile()}>
                  Recreate file
                </Button>
              </Flex>
            </Callout.Root>
          ) : null}
          {docCompileError ? (
            <Flex align="center" gap="2" px="2" py="1" style={{ background: "var(--amber-3)", borderBottom: "1px solid var(--amber-6)", flexShrink: 0 }} data-testid="spectrolite-doc-compile-error">
              <Text size="1" color="amber">{docCompileError}</Text>
            </Flex>
          ) : null}
          <Box ref={containerRef} data-testid="spectrolite-editor" style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative" }}>
            <Box style={{ height: "100%", overflow: "auto" }}>
              <MDXEditor
                ref={editorRef}
                markdown={markdown}
                onChange={handleChange}
                plugins={plugins}
                contentEditableClassName={`spectrolite-content ${theme === "dark" ? "spectrolite-content--dark" : ""}`}
              />
              <MentionAutocomplete
                container={contentEditableEl}
                candidates={mentionCandidates}
                onAccept={handleMentionAccept}
              />
            </Box>
          </Box>
        </Flex>
      </DepsContext.Provider>
    </DocStateContext.Provider>
  );
}

/**
 * Write the in-memory buffer to disk. Called by the flush pipeline.
 * Applies the inverse wikilink transformation (`<WikiLink>` → `[[Page]]`)
 * so the on-disk format stays Obsidian-compatible.
 *
 * Refuses to write paths that escape `repoRoot` via `../`.
 */
export async function writeBufferToDisk(repoRoot: string, relPath: string, content: string): Promise<void> {
  const full = joinSafe(repoRoot, relPath);
  if (!full) {
    throw new Error(`Refusing to write "${relPath}" — path escapes the workspace root.`);
  }
  const parent = parentDir(full);
  if (parent) {
    await fs.mkdir(parent, { recursive: true });
  }
  await fs.writeFile(full, wikilinksFromJsx(content));
}
