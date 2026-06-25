/**
 * ContextManager — the single owner of an editing CONTEXT's VCS state.
 *
 * Before this existed, a context's state was smeared across four in-memory maps
 * on `WorkspaceVcs` (composed-view cache, sparse-materialization tracking,
 * pinned-base cache, decomposed-pinned-view cache) plus a durable context-base
 * pin row — hand-invalidated at scattered mutation sites. That made teardown a
 * leak hazard (`dropContext` had to remember every map) and the
 * "did-I-invalidate?" question impossible to answer locally.
 *
 * This class CONCENTRATES all of that. The key invariants:
 *  - There is exactly ONE place that holds per-context cache state and exactly
 *    one place ({@link dropContext}) that clears ALL of it (caches + every
 *    `ctx:{contextId}` head across repo logs + the pin ref) — atomic teardown,
 *    impossible to half-do.
 *  - The composed-view cache is SELF-INVALIDATING: it is keyed by a signature
 *    of the inputs that determine the view (the pinned base hash + every
 *    `ctx:{contextId}` head state). A stale entry cannot be returned because a
 *    changed input yields a different key; we never rely on a remembered
 *    `.delete()` at the mutation site.
 *
 * The durable pin lives in the gad store's structured `vcs_context_bases` table;
 * this class is its in-memory cache + lifecycle owner, not a replacement for it.
 */

import { EMPTY_STATE_HASH } from "@workspace/agentic-protocol";
import { normalizeRepoPathForLog, vcsContextHead } from "./store.js";

/** A `{ repoPath, stateHash }` pair — a repo's subtree state at some head. */
export interface RepoState {
  repoPath: string;
  stateHash: string;
}

/**
 * The narrow slice of `WorkspaceVcs` the ContextManager needs. WorkspaceVcs
 * implements this and constructs the manager with `this`. Keeping it an explicit
 * interface (rather than reaching into private fields) documents the seam and
 * keeps the manager unit-testable in isolation.
 */
export interface ContextVcsHost {
  /** Raw gad store call. */
  gadCall<T>(method: string, input: unknown): Promise<T>;
  /** Resolve a repo's structured worktree head state (`main`/`ctx:*`) or null. */
  resolveRepoHead(head: string, repoPath: string): Promise<string | null>;
  /** Compose per-repo subtree states into one workspace-rooted view. */
  composeRepoStates(repos: RepoState[]): Promise<string>;
  /** Every repo log carrying `headName` (`main` or `ctx:*`), as repo states. */
  collectRepoHeadStates(headName: string): Promise<RepoState[]>;
  /** Every repo's live `main` state. */
  collectRepoMainStates(): Promise<RepoState[]>;
  /** True if the repo was retired via `deleteRepo` (has an archive head) — lets
   *  contextStatus flag a deleted repo distinctly from a brand-new unpushed one. */
  repoWasArchived(repoPath: string): Promise<boolean>;
  /** The live workspace view (composed union of repo mains). */
  workspaceView(): Promise<{ stateHash: string }>;
  /** Decompose a composed view into per-repo subtree states (cached upstream). */
  decomposePinnedView(baseView: string): Promise<RepoState[]>;
  /** Materialize a repo subtree state into the context's working folder. */
  materializeRepo(contextId: string, repoPath: string, stateHash: string): Promise<void>;
  /** Delete a context's `ctx:{contextId}` head on a repo log (ref + log head). */
  deleteRepoContextHead(repoPath: string, head: string): Promise<void>;
  /** Pull `main` into the context's edited repo (3-way merge onto its ctx head). */
  mergeMainIntoContext(
    contextId: string,
    repoPath: string,
    actor: { id: string; kind: string }
  ): Promise<{ status: "up-to-date" | "merged" | "conflicted" }>;
  /** Cheap per-repo fingerprint of the context's working content: each touched
   *  repo's committed ctx-head state (null if none) + its highest uncommitted
   *  `edit_seq`. Drives the composed-view cache key (an edit invalidates it). */
  contextWorkingFingerprint(
    contextId: string
  ): Promise<Array<{ repoPath: string; committedState: string | null; editSeq: number }>>;
  /** The WORKING content state for a repo in a context (committed base + the
   *  repo's uncommitted ops; a pending merge's provisional when reconciling).
   *  Null when the repo doesn't exist in the context. */
  composeWorkingRepoState(contextId: string, repoPath: string): Promise<string | null>;
  /** Repos (paths) carrying uncommitted edits in a context (teardown discovery —
   *  a repo with uncommitted-ONLY edits has no ctx head). */
  listContextWorkingRepos(contextId: string): Promise<string[]>;
  /** Drop a repo's uncommitted edits + pending merge for a context (teardown). */
  clearContextRepoEdits(contextId: string, repoPath: string): Promise<void>;
}

export class ContextManager {
  // ── Per-context cache state (the ONLY home for all of it) ────────────────
  /** Pinned base view per context (mirror of the durable context-base row). */
  private readonly baseView = new Map<string, string>();
  /** Composed-view cache keyed by a content signature (self-invalidating). */
  private readonly composedView = new Map<string, { key: string; view: string }>();
  /** Sparse-materialization tracking: contextId → (repoPath → on-disk state). */
  private readonly materialized = new Map<string, Map<string, string>>();

  constructor(private readonly host: ContextVcsHost) {}

  // ── Pinned base view ─────────────────────────────────────────────────────

  /**
   * Pin (or re-pin) a context's base view. With `baseView` omitted this is an
   * idempotent CREATE — pins the current `workspaceView()` only if not already
   * pinned (so a second entity joining a context inherits the same pin). With
   * `baseView` given it FORCE-moves the pin (rebase / post-push re-pin).
   */
  async pinContext(contextId: string, baseView?: string): Promise<string> {
    if (baseView === undefined) {
      const existing = await this.contextBaseView(contextId);
      if (existing) return existing;
      baseView = (await this.host.workspaceView()).stateHash;
    }
    await this.host.gadCall("setContextBase", { contextId, stateHash: baseView });
    this.baseView.set(contextId, baseView);
    // The pin determines the view → drop the (now stale-keyed) composed entry.
    // (The signature key would catch it anyway; this just frees the slot.)
    this.composedView.delete(contextId);
    return baseView;
  }

  /** The context's pinned base view state, or null if never pinned. */
  async contextBaseView(contextId: string): Promise<string | null> {
    const cached = this.baseView.get(contextId);
    if (cached) return cached;
    const ref = await this.host.gadCall<{ stateHash?: string } | null>("getContextBase", {
      contextId,
    });
    const sh = ref?.stateHash ?? null;
    if (sh) this.baseView.set(contextId, sh);
    return sh;
  }

  // ── Composed view (self-invalidating cache) ──────────────────────────────

  /**
   * The context's composed view: each edited repo at its `ctx` head, every other
   * repo at its slice of the pinned base. Cached, but keyed by a signature of the
   * exact inputs (base hash + every ctx-head state), so a stale entry can never
   * be returned — an edit that advances any ctx head changes the key.
   */
  async resolveContextView(contextId: string): Promise<string> {
    const baseView = await this.contextBaseView(contextId);
    // The view reflects WORKING content (committed ctx head + uncommitted edits).
    // Key on the cheap fingerprint (committed head + max edit_seq per repo) so an
    // edit invalidates the entry; compute the (expensive) working states on miss.
    const fingerprint = await this.host.contextWorkingFingerprint(contextId);
    const key = this.viewSignature(baseView, fingerprint);
    const cached = this.composedView.get(contextId);
    if (cached && cached.key === key) return cached.view;
    // Fast path: a pure-read context (nothing touched) IS its pinned base.
    if (baseView && fingerprint.length === 0) {
      this.composedView.set(contextId, { key, view: baseView });
      return baseView;
    }
    const overlay = new Map<string, string>();
    for (const fp of fingerprint) {
      const working = await this.host.composeWorkingRepoState(contextId, fp.repoPath);
      if (working) overlay.set(normalizeRepoPathForLog(fp.repoPath), working);
    }
    const view = await this.computeContextView(baseView, overlay);
    this.composedView.set(contextId, { key, view });
    return view;
  }

  /**
   * The composed context view with ONE repo forced to a specific COMMITTED state
   * (or dropped, reverting it to its pinned base, when `repoStateHash` is null),
   * every other edited repo at its committed ctx head. Used to compute the
   * workspace-rooted "before"/"after" state of a per-repo COMMIT so the build
   * trigger can EV-diff a context commit against a real composed workspace state.
   */
  async composedViewWithRepoAt(
    contextId: string,
    repoPath: string,
    repoStateHash: string | null
  ): Promise<string> {
    const baseView = await this.contextBaseView(contextId);
    const norm = normalizeRepoPathForLog(repoPath);
    const overlay = new Map<string, string>();
    for (const c of await this.host.collectRepoHeadStates(vcsContextHead(contextId))) {
      if (normalizeRepoPathForLog(c.repoPath) !== norm) {
        overlay.set(normalizeRepoPathForLog(c.repoPath), c.stateHash);
      }
    }
    if (repoStateHash) overlay.set(norm, repoStateHash);
    return this.computeContextView(baseView, overlay);
  }

  /** The committed base slice for a repo in a context: its slice of the pinned
   *  base view (no drift), else its live `main`, else null. The lineage point a
   *  first edit/commit forks the ctx head from. */
  async pinnedRepoSlice(contextId: string, repoPath: string): Promise<string | null> {
    const baseView = await this.contextBaseView(contextId);
    if (baseView) {
      const match = (await this.host.decomposePinnedView(baseView)).find(
        (r) => normalizeRepoPathForLog(r.repoPath) === normalizeRepoPathForLog(repoPath)
      );
      if (match) return match.stateHash;
    }
    return this.host.resolveRepoHead("main", repoPath);
  }

  /** Stable signature of the inputs that determine a context's composed view: the
   *  pinned base + each touched repo's committed ctx-head state AND its
   *  uncommitted-edit fingerprint (so an edit changes the key). */
  private viewSignature(
    baseView: string | null,
    fingerprint: Array<{ repoPath: string; committedState: string | null; editSeq: number }>
  ): string {
    const fp = fingerprint
      .map((f) => `${normalizeRepoPathForLog(f.repoPath)}=${f.committedState ?? "-"}@${f.editSeq}`)
      .sort()
      .join(",");
    return `${baseView ?? "-"}|${fp}`;
  }

  private async computeContextView(
    baseView: string | null,
    overlay: Map<string, string>
  ): Promise<string> {
    // The base each unedited repo reads from: the PINNED base view (no drift),
    // falling back to live repo mains only when the context has no pin (legacy).
    const baseRepos = baseView
      ? await this.host.decomposePinnedView(baseView)
      : await this.host.collectRepoMainStates();

    if (overlay.size === 0) {
      return (
        baseView ??
        (baseRepos.length === 0 ? EMPTY_STATE_HASH : await this.host.composeRepoStates(baseRepos))
      );
    }

    const composedRepos: RepoState[] = baseRepos.map(({ repoPath, stateHash }) => ({
      repoPath,
      stateHash: overlay.get(normalizeRepoPathForLog(repoPath)) ?? stateHash,
    }));
    // Brand-new repos created in this context (overlaid but absent from the base).
    const baseSet = new Set(baseRepos.map((r) => normalizeRepoPathForLog(r.repoPath)));
    for (const [repoPath, stateHash] of overlay) {
      if (!baseSet.has(repoPath)) composedRepos.push({ repoPath, stateHash });
    }
    return composedRepos.length === 0
      ? EMPTY_STATE_HASH
      : await this.host.composeRepoStates(composedRepos);
  }

  // ── Sparse, demand-driven materialization ────────────────────────────────

  private materializedFor(contextId: string): Map<string, string> {
    let m = this.materialized.get(contextId);
    if (!m) {
      m = new Map();
      this.materialized.set(contextId, m);
    }
    return m;
  }

  /**
   * The state a repo should be on disk at for a context: its WORKING content —
   * the committed ctx head (or pinned-base slice / `main`) COMPOSED WITH the
   * repo's uncommitted edit-ops; or, while a merge is unresolved, the provisional
   * (conflict-marked) tree composed with any resolution edits. Equals the
   * committed base when the repo has no edits; null when it doesn't exist.
   */
  async contextRepoState(contextId: string, repoPath: string): Promise<string | null> {
    return this.host.composeWorkingRepoState(contextId, repoPath);
  }

  /** Every repo visible in a context's view (pinned-base repos ∪ ctx-head repos ∪ working-only repos). */
  async contextRepoList(contextId: string): Promise<string[]> {
    const baseView = await this.contextBaseView(contextId);
    const base = baseView
      ? await this.host.decomposePinnedView(baseView)
      : await this.host.collectRepoMainStates();
    const ctx = await this.host.collectRepoHeadStates(vcsContextHead(contextId));
    const working = await this.host.listContextWorkingRepos(contextId);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of [...base, ...ctx]) {
      const n = normalizeRepoPathForLog(r.repoPath);
      if (!seen.has(n)) {
        seen.add(n);
        out.push(r.repoPath);
      }
    }
    for (const repoPath of working) {
      const n = normalizeRepoPathForLog(repoPath);
      if (!seen.has(n)) {
        seen.add(n);
        out.push(repoPath);
      }
    }
    return out;
  }

  /** True iff `repoPath`'s subtree is currently materialized on disk for the
   *  context (at its expected state). Used by the loud read-time assertion. */
  isContextRepoMaterialized(contextId: string, repoPath: string): boolean {
    return this.materializedFor(contextId).has(normalizeRepoPathForLog(repoPath));
  }

  /**
   * Demand-materialize specific repos (or the whole view) into a context's
   * working folder. Sparse: only the requested repos' subtrees are written, each
   * at its context state, and a repo already on disk at the right state is
   * skipped. A SECTION prefix (e.g. `panels`) expands to every repo under it;
   * `"all"` is reserved for genuine workspace-wide operations.
   */
  async materializeContextRepos(contextId: string, repos: string[] | "all"): Promise<void> {
    const all = await this.contextRepoList(contextId);
    let list: string[];
    if (repos === "all") {
      list = all;
    } else {
      const set = new Set<string>();
      for (const req of repos) {
        const reqNorm = normalizeRepoPathForLog(req).replace(/\/+$/, "");
        for (const r of all) {
          const rn = normalizeRepoPathForLog(r);
          if (rn === reqNorm || rn.startsWith(`${reqNorm}/`)) set.add(r);
        }
      }
      list = [...set];
    }
    const mat = this.materializedFor(contextId);
    for (const repoPath of list) {
      const norm = normalizeRepoPathForLog(repoPath);
      const state = await this.contextRepoState(contextId, repoPath);
      if (!state) continue; // repo doesn't exist anywhere — nothing to materialize
      if (mat.get(norm) === state) continue; // already on disk at the right state
      await this.host.materializeRepo(contextId, repoPath, state);
      mat.set(norm, state);
    }
  }

  /**
   * Record that a repo's subtree was (re)materialized on disk for a context at
   * `stateHash`. Called by the edit path after it projects the new head state to
   * disk, so the sparse tracking stays fresh without a redundant materialize.
   */
  noteMaterialized(contextId: string, repoPath: string, stateHash: string): void {
    this.materializedFor(contextId).set(normalizeRepoPathForLog(repoPath), stateHash);
  }

  // ── Lifecycle: rebase / status / drop ────────────────────────────────────

  /**
   * Rebase: pull the latest `main` into each of the context's edited repos
   * (3-way merge onto the `ctx` head), then RE-PIN the base to the current
   * `workspaceView()` so unedited repos also advance to latest.
   */
  async rebaseContext(
    contextId: string,
    actor: { id: string; kind: string }
  ): Promise<{
    repos: Array<{ repoPath: string; status: "up-to-date" | "merged" | "conflicted" }>;
    baseView: string;
  }> {
    const head = vcsContextHead(contextId);
    // Reject up-front on uncommitted edits — a rebase merges over committed
    // states only (each per-repo merge would reject anyway; fail clearly first).
    const dirty = (await this.host.contextWorkingFingerprint(contextId)).filter(
      (f) => f.editSeq > 0
    );
    if (dirty.length > 0) {
      throw new Error(
        `rebaseContext: uncommitted edits in ${dirty
          .map((f) => f.repoPath)
          .join(", ")} — vcs.commit or vcs.discardEdits first`
      );
    }
    const repos: Array<{ repoPath: string; status: "up-to-date" | "merged" | "conflicted" }> = [];
    for (const { repoPath } of await this.host.collectRepoHeadStates(head)) {
      const main = await this.host.resolveRepoHead("main", repoPath);
      if (!main) {
        repos.push({ repoPath, status: "up-to-date" });
        continue;
      }
      const merged = await this.host.mergeMainIntoContext(contextId, repoPath, actor);
      repos.push({ repoPath, status: merged.status });
    }
    // Only re-pin the base when EVERY edited repo merged cleanly. If any repo
    // conflicted, leave the pin where it was so the context keeps reporting
    // `behind` until the conflicts are resolved — re-pinning would falsely mark
    // it caught-up while unresolved conflicts remain on its ctx heads.
    const conflicted = repos.some((r) => r.status === "conflicted");
    const baseView = conflicted
      ? ((await this.contextBaseView(contextId)) ?? (await this.host.workspaceView()).stateHash)
      : await this.pinContext(contextId, (await this.host.workspaceView()).stateHash);
    return { repos, baseView };
  }

  /**
   * Per-repo summary of where this full workspace branch differs from main or
   * needs attention: `forked` (the context has a committed `ctx` head for this
   * repo), `uncommitted` (it carries working edits), `ahead` (committed ctx head
   * differs from `main`), `behind` (main advanced past the pinned base). Only
   * interesting repos are returned. A repo with uncommitted-only edits (no ctx
   * head yet) is included.
   */
  async contextStatus(contextId: string): Promise<
    Array<{
      repoPath: string;
      forked: boolean;
      uncommitted: boolean;
      ahead: boolean;
      behind: boolean;
      deleted: boolean;
    }>
  > {
    const head = vcsContextHead(contextId);
    const baseView = await this.contextBaseView(contextId);
    const baseRepos = baseView
      ? await this.host.decomposePinnedView(baseView)
      : await this.host.collectRepoMainStates();
    const baseByRepo = new Map(
      baseRepos.map((r) => [normalizeRepoPathForLog(r.repoPath), r.stateHash])
    );
    const ctxByRepo = new Map(
      (await this.host.collectRepoHeadStates(head)).map((c) => [
        normalizeRepoPathForLog(c.repoPath),
        { repoPath: c.repoPath, stateHash: c.stateHash },
      ])
    );
    // Uncommitted-edit fingerprint per repo (includes uncommitted-only repos).
    const editSeqByRepo = new Map(
      (await this.host.contextWorkingFingerprint(contextId)).map((f) => [
        normalizeRepoPathForLog(f.repoPath),
        f.editSeq,
      ])
    );
    const repoKeys = new Set([...baseByRepo.keys(), ...ctxByRepo.keys(), ...editSeqByRepo.keys()]);
    const out: Array<{
      repoPath: string;
      forked: boolean;
      uncommitted: boolean;
      ahead: boolean;
      behind: boolean;
      deleted: boolean;
    }> = [];
    for (const key of repoKeys) {
      const ctx = ctxByRepo.get(key) ?? null;
      const baseState = baseByRepo.get(key) ?? null;
      const repoPath = ctx?.repoPath ?? key;
      const mainState = await this.host.resolveRepoHead("main", repoPath);
      const forked = ctx !== null;
      const uncommitted = (editSeqByRepo.get(key) ?? 0) > 0;
      const behind = baseState !== null && mainState !== null && mainState !== baseState;
      // The context still references this repo, but its `main` is gone AND it was
      // archived — i.e. retired via deleteRepo (not a brand-new unpushed repo,
      // which also lacks a main but has no archive head). Flag it so an agent
      // sees the repo is gone BEFORE a push fails the resurrection guard.
      const deleted = mainState === null && (await this.host.repoWasArchived(repoPath));
      let ahead = false;
      if (forked) {
        if (mainState === null) {
          ahead = !deleted && ctx!.stateHash !== EMPTY_STATE_HASH;
        } else if (ctx!.stateHash !== mainState) {
          const mergeBase =
            (
              await this.host.gadCall<{ baseStateHash: string | null }>("getMergeBase", {
                leftStateHash: mainState,
                rightStateHash: ctx!.stateHash,
              })
            ).baseStateHash ?? EMPTY_STATE_HASH;
          // `ahead` means the context has commits not contained in main. When the
          // ctx head is an ancestor of main, it is only behind.
          ahead = mergeBase !== ctx!.stateHash;
        }
      }
      if (forked || uncommitted || behind || deleted) {
        out.push({ repoPath, forked, uncommitted, ahead, behind, deleted });
      }
    }
    return out.sort((a, b) => a.repoPath.localeCompare(b.repoPath));
  }

  /**
   * Teardown — the ONE place all per-context state dies. Per repo in (committed
   * ctx heads ∪ uncommitted-edit repos): drop its uncommitted edits + pending
   * merge AND delete its `ctx:{contextId}` head; then drop the pin ref and every
   * in-memory cache. Discovers via BOTH committed heads and uncommitted-edit rows
   * because an edit no longer lazy-forks the ctx head — a repo with
   * uncommitted-ONLY edits has no ctx head and would otherwise be missed.
   * Atomic by construction; idempotent.
   */
  async dropContext(contextId: string): Promise<void> {
    const head = vcsContextHead(contextId);
    const repoPaths = new Set<string>();
    for (const { repoPath } of await this.host.collectRepoHeadStates(head)) {
      repoPaths.add(repoPath);
    }
    for (const repoPath of await this.host.listContextWorkingRepos(contextId)) {
      repoPaths.add(repoPath);
    }
    for (const repoPath of repoPaths) {
      await this.host.clearContextRepoEdits(contextId, repoPath); // uncommitted edits + pending
      await this.host.deleteRepoContextHead(repoPath, head); // ctx ref + log head
    }
    await this.host.gadCall("deleteContextBase", { contextId }).catch(() => {});
    this.baseView.delete(contextId);
    this.composedView.delete(contextId);
    this.materialized.delete(contextId);
  }
}
