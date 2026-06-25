/**
 * Composition root — builds the store + the GAD-native pieces and wires them.
 *
 * Created once per panel mount. The vault runs under its own durable context
 * head (`ctx:<contextId>`), so:
 *   - `viewState` (per-viewer component state) is panel-local, per vault,
 *   - `publish` (PublishController) drives the ctx→main publish UX,
 *   - `vault` owns selection + the `vcs.listFiles` path index,
 *   - `session` owns the channel + resident scribe (NO edit-driven dispatch),
 *   - per-document DocControllers (owned by `DocumentEditor`) commit + reconcile.
 *
 * The React tree is a pure view of the store; controllers + DocControllers are
 * the only writers.
 */

import { panel, contextId as runtimeContextId, rpc, vcs } from "@workspace/runtime";
import { createPanelSandboxConfig } from "@workspace/agentic-core";
import { createStore, type Store } from "./store";
import { initialState, type PendingSuggestion, type SpectroliteState } from "./state";
import { SessionController } from "./sessionController";
import { VaultController, type VaultStarterDoc } from "./vaultController";
import { PublishController } from "./publishController";
import { createViewStateStore, type ViewStateStore } from "../coedit/viewState";
import { parseFrontmatter, diffDependencies } from "../mdx/frontmatter";
import { prefetchDependencies } from "../mdx/depPrefetch";
import type { Collision } from "../coedit/blockReconcile";
import { resolveContextId, type InstalledAgentRecord } from "../bootstrap";

interface PersistedStateArgs {
  channelName?: string;
  contextId?: string;
  installedAgents?: InstalledAgentRecord[];
  openPath?: string;
  pendingStarterDoc?: unknown;
  repoRoot?: string;
}

function parsePendingStarterDoc(value: unknown): VaultStarterDoc | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { path?: unknown; content?: unknown };
  return typeof candidate.path === "string" && typeof candidate.content === "string"
    ? { path: candidate.path, content: candidate.content }
    : null;
}

export interface SpectroliteApp {
  store: Store<SpectroliteState>;
  session: SessionController;
  vault: VaultController;
  publish: PublishController;
  viewState: ViewStateStore;
  /** The vault's stable head (`ctx:<contextId>`) the DocController subscribes to. */
  vaultHead: string;
  /** Open a document (vault-relative path) in the editor. */
  openFile(path: string): void;
  /** Recompute the active doc's frontmatter dependency map (feeds inline JSX). */
  setActiveDocSource(path: string, markdown: string): void;
  /** Mark/unmark a vault-relative path as having uncommitted edits. */
  setDirty(path: string, dirty: boolean): void;
  /** Surface live same-block collisions (DocController.onCollisions). */
  pushCollisions(collisions: Collision[], vcsPath: string): void;
  /**
   * Resolve a suggestion card. The active editor (registered by DocumentEditor)
   * applies the chosen text to the live blocks as a normal user edit (which the
   * DocController then commits); the card is dismissed regardless.
   */
  resolveSuggestion(id: string, resolved: SuggestionResolution | null): void;
  /** DocumentEditor registers how to apply a block resolution to the live doc. */
  registerSuggestionApplier(applier: SuggestionApplier | null): void;
  /** DocumentEditor registers the active doc's deliberate commit (Publish /
   *  Send-to-scribe flush). Carries a commit message. */
  registerCommitActiveDoc(commit: CommitActiveDoc | null): void;
  /** DocumentEditor registers a reload-now (re-read at the current head) — used
   *  after a Sync/rebase that re-pinned the base without advancing the head. */
  registerReloadActiveDoc(reload: ReloadActiveDoc | null): void;
  /** Commit the active doc's working copy now with a message (Send-to-scribe
   *  flush-first). NOT called on typing — only on deliberate user gestures. */
  commitActiveDoc(
    message: string
  ): Promise<{ stateHash: string; changed: boolean; conflicted?: boolean } | null>;
  /** A save 3-way-conflicted (DocController.onConflict): refresh publish state so
   *  the parked pending merge surfaces in the resolution UX. */
  onSaveConflict(vcsPath: string): void;
  start(): void;
  dispose(): void;
}

export type CommitActiveDoc = (
  message: string
) => Promise<{ stateHash: string; changed: boolean; conflicted?: boolean } | null>;
/** Re-read the active document at the current head (used after a Sync/rebase). */
export type ReloadActiveDoc = () => Promise<void>;

/** The text the user chose for a colliding run, with the run's live block ids. */
export interface SuggestionResolution {
  oldIds: string[];
  beforeId: string | null;
  text: string;
}

export type SuggestionApplier = (resolution: SuggestionResolution) => void;

export function createSpectroliteApp(): SpectroliteApp {
  const args = panel.stateArgs.get<PersistedStateArgs>();
  const contextId = resolveContextId(args.contextId, runtimeContextId) ?? null;
  const pendingStarterDoc = parsePendingStarterDoc(args.pendingStarterDoc);
  const store = createStore(initialState({
    contextId,
    channelName: args.channelName ?? null,
    repoRoot: args.repoRoot ?? null,
    openPath: args.openPath ?? null,
    installedAgents: args.installedAgents ?? [],
  }));

  // The panel runs under the vault's contextId, so the vault's durable head IS
  // the caller's own ctx head.
  const vaultHead = contextId ? `ctx:${contextId}` : "ctx:unbound";

  const viewState = createViewStateStore();
  // The vault is a single repo: its repo path IS the vault's workspace-relative
  // root (`projects/<vault>`). Spectrolite only ever pushes this one repo, so
  // the controller is bound to it (per-repo push/pushStatus on
  // `vcs:repo:projects/<vault>`). `""` (root) is used until a vault is picked.
  // The generated VcsClient structurally satisfies the narrow PublishVcs surface
  // (push/pushStatus/merge/pendingMerge/abortMerge) the controller consumes — no
  // cast needed (PublishVcs is a structural supertype of the client methods).
  //
  // The active document's reload-now (re-read at the current head), registered by
  // DocumentEditor. Declared before `publish` so the controller's onRebased can
  // close over it. `onRebased` re-reads the active doc after a Sync: an unedited
  // vault's rebase only re-pins the base (no head advance), so the DocController
  // won't reload on its own — without this the editor would show stale content
  // under a cleared "behind" indicator.
  let reloadActiveDocFn: ReloadActiveDoc | null = null;
  // The active document's deliberate commit (working copy → ctx head with a
  // message), registered by DocumentEditor. Declared before `publish` so the
  // controller's commit-then-push step can close over it. Publish ties the
  // commit and the push into one user gesture.
  let commitActiveDocFn: CommitActiveDoc | null = null;
  const publish = new PublishController(
    vcs,
    args.repoRoot ?? "",
    () => (reloadActiveDocFn ? reloadActiveDocFn() : Promise.resolve()),
    (message) => (commitActiveDocFn ? commitActiveDocFn(message) : Promise.resolve(null))
  );

  // A panel sandbox used solely to prefetch frontmatter-declared dependencies
  // into the panel's module map so inline JSX (LiveJsxEditor) + Preview-mode
  // compilation can resolve them. Mirrors the local sandbox LiveJsxEditor and
  // runtimeNamespace each build for live compile.
  const depSandbox = createPanelSandboxConfig(rpc);

  // The active doc's last-seen frontmatter deps (so inline JSX tracks edits
  // without re-parsing on every keystroke at the app layer).
  let lastDeps: Record<string, string> = {};
  // How the active document applies a user-chosen collision resolution.
  let suggestionApplier: SuggestionApplier | null = null;

  const setActiveDocSource = (path: string, markdown: string): void => {
    if (store.getState().activePath !== path) return;
    const next = parseFrontmatter(markdown).dependencies;
    const { added, changed, removed } = diffDependencies(lastDeps, next);
    if (Object.keys(added).length === 0 && Object.keys(changed).length === 0 && removed.length === 0) return;
    lastDeps = next;
    store.setState({ activeDeps: next });
    void prefetchDependencies(depSandbox, { ...added, ...changed }, (line) => {
      console.info(line);
    }).catch((err) => console.warn("[Spectrolite] dependency prefetch failed:", err));
  };

  const session = new SessionController(store);

  const vault = new VaultController(store, {
    onVaultSelected: (repoRoot) => {
      session.onVaultSelected(repoRoot);
      void publish.refresh();
    },
  });

  const openFileInternal = (path: string, extraStateArgs?: Record<string, unknown>): void => {
    if (store.getState().activePath === path) {
      if (extraStateArgs) void panel.stateArgs.set({ openPath: path, ...extraStateArgs });
      return;
    }
    store.setState((prev) => ({
      activePath: path,
      recentPaths: [path, ...prev.recentPaths.filter((p) => p !== path)].slice(0, 12),
      // A doc switch clears stale deps; setActiveDocSource re-derives them.
      activeDeps: {},
      // Suggestions are per-doc; drop any not for the new doc on open.
      pendingSuggestions: prev.pendingSuggestions.filter(
        (s) => s.vcsPath === vault.mapping().toVcsPath(path),
      ),
    }));
    lastDeps = {};
    void panel.stateArgs.set({ openPath: path, ...(extraStateArgs ?? {}) });
  };

  const createPendingStarterDoc = async (): Promise<void> => {
    if (!pendingStarterDoc) return;
    try {
      const created = await vault.createFile(pendingStarterDoc.path, pendingStarterDoc.content);
      openFileInternal(created, { pendingStarterDoc: null });
    } catch (err) {
      console.warn("[Spectrolite] starter doc creation failed:", err);
    }
  };

  let started = false;
  let offPublishHead: (() => void) | null = null;
  let offPublishWorking: (() => void) | null = null;
  return {
    store,
    session,
    vault,
    publish,
    viewState,
    vaultHead,
    openFile(path) {
      openFileInternal(path);
    },
    setActiveDocSource,
    setDirty(path, dirty) {
      store.setState((prev) => {
        const has = prev.dirtyPaths.includes(path);
        if (dirty === has) return {};
        return {
          dirtyPaths: dirty
            ? [...prev.dirtyPaths, path]
            : prev.dirtyPaths.filter((p) => p !== path),
        };
      });
    },
    pushCollisions(collisions, vcsPath) {
      if (collisions.length === 0) return;
      const additions: PendingSuggestion[] = collisions.map((collision) => ({
        id: `${vcsPath}:${collision.fromIndex}:${collision.toIndex}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
        vcsPath,
        collision,
      }));
      store.setState((prev) => ({ pendingSuggestions: [...prev.pendingSuggestions, ...additions] }));
    },
    resolveSuggestion(id, resolved) {
      const suggestion = store.getState().pendingSuggestions.find((s) => s.id === id);
      if (resolved && suggestion && suggestion.vcsPath === vault.mapping().toVcsPath(store.getState().activePath ?? "")) {
        try {
          suggestionApplier?.(resolved);
        } catch (err) {
          console.warn("[Spectrolite] applying suggestion failed:", err);
        }
      }
      store.setState((prev) => {
        const next = prev.pendingSuggestions.filter((s) => s.id !== id);
        return next.length === prev.pendingSuggestions.length ? {} : { pendingSuggestions: next };
      });
    },
    registerSuggestionApplier(applier) {
      suggestionApplier = applier;
    },
    registerCommitActiveDoc(commit) {
      commitActiveDocFn = commit;
    },
    registerReloadActiveDoc(reload) {
      reloadActiveDocFn = reload;
    },
    commitActiveDoc(message) {
      return commitActiveDocFn ? commitActiveDocFn(message) : Promise.resolve(null);
    },
    onSaveConflict() {
      // The save parked a pending merge on the vault head; surface it.
      void publish.refresh();
    },
    start() {
      if (started) return;
      started = true;
      void session.start();
      if (store.getState().repoRoot !== null) {
        void createPendingStarterDoc();
        void vault.refreshPaths();
        void publish.refresh();
      }
      offPublishHead = vcs.subscribeHead(vaultHead, () => {
        void publish.refresh();
      });
      offPublishWorking = vcs.subscribeWorking(vaultHead, () => {
        void publish.refresh();
      });
    },
    dispose() {
      offPublishHead?.();
      offPublishWorking?.();
      offPublishHead = null;
      offPublishWorking = null;
      session.dispose();
    },
  };
}
