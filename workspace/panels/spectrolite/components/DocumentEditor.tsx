/**
 * Document editor host — the GAD-native co-editing surface.
 *
 * Renders a single {@link MdxLexicalEditor} (raw Lexical + the vendored MDX
 * pipeline). On ready it builds the per-document {@link DocController}
 * (commit-on-quiescence + narrow remote reconcile) and the {@link UndoCoordinator}
 * (one ⌘Z stack over Lexical-native undo + GAD revert), then `load`s the doc
 * from the vault head via `vcs` — there are NO disk reads, NO polling, NO flush,
 * and NO disk-conflict banners.
 *
 * Per-JSX-node live render goes through {@link LiveJsxEditor}; component
 * view-state (`useDocState`) is private and lives in the panel-local
 * {@link ViewStateStore}, keyed by the doc's vcs path. When the scribe lands a
 * change, the affected blocks briefly highlight via the attribution sink.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, Text } from "@radix-ui/themes";
import { $getNodeByKey, $getRoot, type LexicalNode } from "lexical";
import { fromMarkdown } from "mdast-util-from-markdown";
import { importMdastTreeToLexical } from "@workspace/mdx-editor-core";
import { vcs } from "@workspace/runtime";
import { buildMdxConfig, type BuiltMdxConfig } from "../editor/mdxConfig";
import { MdxLexicalEditor, type LexicalUndoHandle } from "../editor/MdxLexicalEditor";
import type { MdxEditorCore } from "../editor/mdxEditorCore";
import { splitMdxBlocks } from "../editor/parseBlocks";
import { DocController } from "../coedit/docController";
import { UndoCoordinator } from "../coedit/undoCoordinator";
import { knownJsxDescriptors } from "../mdx/runtime";
import { LiveJsxEditor } from "../mdx/LiveJsxEditor";
import { DocStateContext, useDocState } from "../mdx/docState";
import { DepsContext, runtimeNamespace } from "../mdx/runtimeNamespace";
import { useApp } from "../app/context";
import type { JsxComponentDescriptor, JsxEditorProps } from "@workspace/mdx-editor-core";
import type { MentionCandidate } from "./MentionAutocomplete";
import { MentionAutocomplete } from "./MentionAutocomplete";

export interface DocumentEditorProps {
  /** Vault-relative path of the open document, e.g. `notes/E2E.mdx`. */
  relPath: string;
  theme: "light" | "dark";
  /** Frontmatter-declared dependencies; threaded into inline JSX + eval. */
  dependencies: Record<string, string>;
  /** Mention candidates from the channel roster (for @-autocomplete). */
  mentionCandidates: MentionCandidate[];
}

/** A canonical-derived recompute is debounced — full serialization isn't free. */
const RECOMPUTE_MS = 350;
/** How long a scribe-attributed block stays highlighted. */
const ATTRIBUTION_FLASH_MS = 2200;

export function DocumentEditor({ relPath, theme, dependencies, mentionCandidates }: DocumentEditorProps) {
  const app = useApp();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [contentEditableEl, setContentEditableEl] = useState<HTMLElement | null>(null);

  const vcsPath = useMemo(() => app.vault.mapping().toVcsPath(relPath), [app, relPath]);

  const coreRef = useRef<MdxEditorCore | null>(null);
  const controllerRef = useRef<DocController | null>(null);
  const undoRef = useRef<UndoCoordinator | null>(null);

  // Build the editor config once: known descriptors get a live JSX editor that
  // resolves frontmatter deps. Each node compiles in isolation (local
  // incremental render); there is no whole-doc compile. The wildcard `"*"`
  // descriptor is included by knownJsxDescriptors and gets the same editor.
  const dependenciesRef = useRef(dependencies);
  dependenciesRef.current = dependencies;

  const config = useMemo<BuiltMdxConfig>(() => {
    const JsxEditor = (props: JsxEditorProps) => (
      <LiveJsxEditor
        {...props}
        dependencies={dependenciesRef.current}
      />
    );
    const descriptors: JsxComponentDescriptor[] = knownJsxDescriptors().map((d) => ({
      ...d,
      Editor: JsxEditor,
    }));
    return buildMdxConfig({ jsxComponentDescriptors: descriptors });
    // Built once per mounted document — the editor inputs (deps, exports) are
    // read through refs so the live editor never tears down mid-edit.
  }, []);

  // Set up the controller once the core is ready, then load the document. The
  // `relPath` is part of the key (see EditorPane), so a new doc remounts.
  useEffect(() => {
    return () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      undoRef.current = null;
      coreRef.current = null;
      app.registerSuggestionApplier(null);
      app.registerCommitActiveDoc(null);
      app.registerReloadActiveDoc(null);
      app.setDirty(relPath, false);
    };
  }, [app, relPath]);

  // Pull canonical once and update the cheap derived state. Dirtiness now means
  // "working copy diverges from the last recorded base" (the controller's view) —
  // not "has a live block", since typing records tracked working edits rather
  // than commits.
  const recompute = useMemo(
    () => (core: MdxEditorCore) => {
      const canonical = core.getCanonical();
      app.setActiveDocSource(relPath, canonical);
      const controller = controllerRef.current;
      app.setDirty(relPath, controller ? controller.isDirty() : core.getLiveBlockIds().size > 0);
    },
    [app, relPath],
  );

  const onReady = useMemo(
    () => (core: MdxEditorCore, lexicalUndo: LexicalUndoHandle) => {
      coreRef.current = core;

      const undo = new UndoCoordinator({
        lexical: lexicalUndo,
        // Per-repo VCS: revert must name the vault's repo (the single repo this
        // panel edits). repoPath is required on `vcs.revert`.
        revert: (target) => vcs.revert({ ...target, repoPath: app.publish.getRepo() }),
        onRevertIssued: (stateHash) => controllerRef.current?.expectHistoric(stateHash),
      });
      undoRef.current = undo;

      const controller = new DocController({
        editor: core,
        vcs,
        vaultHead: app.vaultHead,
        // Per-repo VCS: `vcs.commit` is scoped to the vault's single repo.
        vaultRepo: app.publish.getRepo(),
        viewState: app.viewState,
        splitBlocks: (markdown) => splitMdxBlocks(markdown),
        onCollisions: (collisions, path) => app.pushCollisions(collisions, path),
        onConflict: (path) => app.onSaveConflict(path),
        onSaveError: (path, err) => {
          // A working-edit record (or teardown flush) failed and can't retry —
          // keep the path marked unsaved (the edit may not be durable).
          const rel = app.vault.mapping().toVaultRelPath(path);
          app.setDirty(rel ?? path, true);
          console.warn("[spectrolite] working edit failed:", path, err);
        },
        // Working-copy dirtiness changed (working edit / commit / remote apply) —
        // mirror it into the store so the file index dot + PublishBar reflect it.
        onDirtyChange: (path, dirty) => {
          const rel = app.vault.mapping().toVaultRelPath(path);
          if (rel) app.setDirty(rel, dirty);
        },
        undo,
      });
      controllerRef.current = controller;
      // The deliberate commit (Publish / Send-to-scribe) — carries a message.
      app.registerCommitActiveDoc((message) => controller.commitNow(message));
      // Re-read this doc at the current head after a Sync/rebase (the re-pinned
      // base may have moved without advancing the head).
      app.registerReloadActiveDoc(() => controller.load(vcsPath));

      // A user-chosen collision resolution: replace the live blocks with the
      // resolved text as a NORMAL user edit (no historic tag) so the
      // DocController commits it like any other keystroke.
      app.registerSuggestionApplier((resolution) => {
        core.editor.update(() => {
          const targets = resolution.oldIds
            .map((id) => $getNodeByKey(id))
            .filter((node): node is LexicalNode => node != null);
          const anchor = resolution.beforeId ? $getNodeByKey(resolution.beforeId) : null;
          const root = $getRoot();
          const before = root.getChildrenSize();
          const tree = fromMarkdown(resolution.text, {
            extensions: config.assembled.syntaxExtensions,
            mdastExtensions: config.assembled.mdastExtensions,
          });
          importMdastTreeToLexical({
            root,
            mdastRoot: tree,
            visitors: config.assembled.importVisitors,
            jsxComponentDescriptors: config.jsxComponentDescriptors,
            codeBlockEditorDescriptors: config.codeBlockEditorDescriptors,
            directiveDescriptors: [],
          });
          const fresh = root.getChildren().slice(before);
          for (const node of fresh) {
            if (anchor && anchor.isAttached()) anchor.insertBefore(node);
            // else: leave the freshly-appended node at the end (append path).
          }
          for (const target of targets) target.remove();
        });
      });

      // Presence: flash the blocks a remote actor just touched.
      core.setAttributionSink((blockIds, actor) => {
        if (!actor || actor.kind === "panel") return;
        for (const key of blockIds) {
          const el = core.editor.getElementByKey(key);
          if (!el) continue;
          el.classList.add("spectrolite-scribe-touch");
          window.setTimeout(() => el.classList.remove("spectrolite-scribe-touch"), ATTRIBUTION_FLASH_MS);
        }
      });

      void controller.load(vcsPath)
        .then(() => {
          setReady(true);
          recompute(core);
        })
        .catch((err) => {
          console.warn(`[Spectrolite] failed to load ${vcsPath}:`, err);
          setError(err instanceof Error ? err.message : String(err));
        });

      // Recompute canonical-derived state (dirty flag, deps, export names) on a
      // debounce after each editor change (user OR remote apply).
      let timer: ReturnType<typeof setTimeout> | null = null;
      core.editor.registerUpdateListener(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          recompute(core);
        }, RECOMPUTE_MS);
      });
    },
    [app, vcsPath, recompute],
  );

  // ⌘Z / ⇧⌘Z drive the two-tier undo coordinator.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      const coordinator = undoRef.current;
      if (!coordinator) return;
      event.preventDefault();
      if (event.shiftKey) void coordinator.redo();
      else void coordinator.undo();
    };
    const root = containerRef.current;
    root?.addEventListener("keydown", onKeyDown);
    return () => root?.removeEventListener("keydown", onKeyDown);
  }, [ready]);

  // Locate the contenteditable for the mention autocomplete keylistener.
  useEffect(() => {
    if (!containerRef.current) return;
    const find = () => {
      const el = containerRef.current?.querySelector<HTMLElement>('[contenteditable="true"]');
      if (el && el !== contentEditableEl) setContentEditableEl(el);
    };
    find();
    const observer = new MutationObserver(find);
    observer.observe(containerRef.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [contentEditableEl]);

  const docStateValue = useMemo(() => ({ store: app.viewState, path: vcsPath }), [app, vcsPath]);

  // The mention adapter mutates the contenteditable directly; Lexical observes
  // the input event and the controller's onUserEdit handles the rest.
  const handleMentionAccept = useMemo(() => () => {}, []);

  if (error) {
    return (
      <Flex direction="column" gap="2" p="3">
        <Text color="red" size="2">Could not open {relPath}: {error}</Text>
      </Flex>
    );
  }

  return (
    <DocStateContext.Provider value={docStateValue}>
      <DepsContext.Provider value={dependencies}>
        <Flex
          direction="column"
          className={`spectrolite-mdx ${theme === "dark" ? "dark-theme" : ""}`}
          style={{ height: "100%" }}
        >
          <Box
            ref={containerRef}
            data-testid="spectrolite-editor"
            style={{ flex: 1, minHeight: 0, overflow: "auto", position: "relative" }}
          >
            <MdxLexicalEditor
              config={config}
              onReady={onReady}
              ariaLabel={relPath}
              className={`spectrolite-content ${theme === "dark" ? "spectrolite-content--dark" : ""}`}
            />
            <MentionAutocomplete
              container={contentEditableEl}
              candidates={mentionCandidates}
              onAccept={handleMentionAccept}
            />
            {!ready ? (
              <Flex
                align="center"
                justify="center"
                style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
              >
                <Text size="2" color="gray">Loading {relPath}…</Text>
              </Flex>
            ) : null}
          </Box>
        </Flex>
      </DepsContext.Provider>
    </DocStateContext.Provider>
  );
}

// `runtimeNamespace` + `useDocState` are exposed to sandboxed inline JSX via
// globalThis backdoors (the sandbox can't import panel-local modules). They use
// React context, so they bind to the providers above. Installed once.
const g = globalThis as Record<string, unknown>;
g["__spectroliteUseDocState__"] = useDocState;
g["__spectroliteRuntime__"] = runtimeNamespace;
g["__spectroliteUseIsMobile__"] = runtimeNamespace["useIsMobile"];
g["__spectroliteUseTouchDevice__"] = runtimeNamespace["useTouchDevice"];
g["__spectroliteUseViewportHeight__"] = runtimeNamespace["useViewportHeight"];
