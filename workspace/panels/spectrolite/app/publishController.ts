/**
 * PublishController — the per-repo VCS publish UX (plan section F / W9).
 *
 * Under per-repo GAD-native editing the vault is **one repo**
 * (`projects/<vault>`) with its own log `vcs:repo:projects/<vault>`. The vault
 * panel edits that repo on a durable per-repo context head
 * (`ctx:vault-<hash>` on the vault's log); `main` moves only on an explicit
 * Publish, which is a build-gated `vcs.push({ repoPaths: [vaultRepo] })`.
 *
 * Spectrolite is **single-repo** (resolved decision): it binds to exactly one
 * vault repo and only ever pushes that repo. There is no group/multi-repo UX
 * here — groups are a CLI/agent concern.
 *
 * This controller drives:
 *  - the always-visible **"● N unpublished changes"** indicator
 *    (`vcs.pushStatus([vaultRepo])` = the vault repo's ctx-head-vs-`main` diff,
 *    NOT the unscoped `vcs.status`),
 *  - one-click **Publish** (`vcs.push`), which is build-gated — although the
 *    vault is a content-only repo (`projects/<vault>`) and is therefore ungated
 *    in practice, the controller still handles a `build-failed` outcome for
 *    robustness and surfaces its report,
 *  - **pending-merge** display / resolution.
 *
 * Publish is **commit-then-pull-main-then-push**: first `vcs.commit` the active
 * document's working edits into a messaged snapshot (push rejects while edits are
 * uncommitted), then merge `main` *into* the vault's ctx head (which the panel
 * may write), then fast-forward-only `vcs.push` ctx→`main`. So any divergence
 * conflicts in the panel's OWN head — resolvable with the normal editor conflict
 * tooling — and the push step fast-forwards the vault repo's `main`. Conflicts
 * never park unresolvably on `main`.
 *
 * Store-shaped (snapshot + subscribe) and pure over an injected vcs surface, so
 * it is unit-testable without a server.
 */

export interface PublishMergeResult {
  status: "up-to-date" | "merged" | "conflicted";
  conflicts: Array<{ path: string; kind: string }>;
}

/**
 * One structured build/type diagnostic. A SUPERTYPE of the vcs schema
 * `BuildDiagnostic` (notably its nullable `line`/`column`), so the generated
 * `VcsClient` push result is structurally assignable to {@link PublishVcs}
 * without a cast.
 */
export interface PublishDiagnostic {
  source: "esbuild" | "tsc";
  severity: "error" | "warning";
  file: string;
  line: number | null;
  column: number | null;
  message: string;
  lineText?: string | null;
  suggestion?: string | null;
}

/** One repo's build report from a push (manifests only; never bytes). */
export interface PublishBuildReport {
  repoPath: string;
  kind: string;
  role: "pushed" | "dependent";
  status: "ok" | "failed" | "skipped";
  builds: Array<{ target: string; diagnostics: PublishDiagnostic[] }>;
}

/** A per-repo divergence in a rejected fast-forward-only push: `main` advanced
 *  past the ctx head's merge-base. Reconcile with an explicit `vcs.merge`. */
export interface PublishRepoDivergence {
  repoPath: string;
  mergeable: "clean" | "conflict";
  conflictPaths?: string[];
}

/**
 * The discriminated result of `vcs.push` (mirrors VcsPushResult, scoped to the
 * vault repo). Push is fast-forward-only: it returns `diverged` (NOT a
 * `conflicted` status) when `main` moved past the ctx head's base — reconcile
 * with `vcs.merge` and re-push.
 */
export type PublishPushResult =
  | { status: "pushed" | "up-to-date"; repoPaths: string[]; reports: PublishBuildReport[] }
  | { status: "diverged"; divergences: PublishRepoDivergence[] }
  | { status: "build-failed"; reports: PublishBuildReport[] };

/** One repo's pre-push status (ctx head vs its own main). */
export interface PublishRepoStatus {
  repoPath: string;
  head?: string;
  headStateHash?: string | null;
  mainStateHash?: string | null;
  ahead: number;
  uncommitted: number;
  diverged: boolean;
  deleted: boolean;
  files: Array<{ path: string; kind: "added" | "removed" | "changed" }>;
}

/** A per-repo commit result from `vcs.commit`. */
export interface PublishCommitResult {
  repoPath: string;
  stateHash: string;
  status: "committed" | "unchanged";
  changedPaths: string[];
}

export interface PublishVcs {
  /**
   * Per-repo unpushed status for the given repos (ctx-head-vs-`main` diff per
   * repo). Spectrolite always passes exactly the one vault repo.
   */
  pushStatus(repoPaths: string[]): Promise<PublishRepoStatus[]>;
  /**
   * Reconcile divergence on a repo: pull `main` into the caller's context head,
   * producing a merge commit. `repoPath` is REQUIRED and comes FIRST (per-repo
   * VCS); `head` is positional-optional (omit to default to the caller's own ctx
   * head — the vault head, which is what Publish wants). Signature matches the
   * generated `VcsClient.merge(repoPath, head?)` so the real client structurally
   * satisfies this surface (no cast).
   */
  merge(repoPath: string, head?: string): Promise<PublishMergeResult>;
  /**
   * Build-gated, fast-forward-only push of the caller's ctx head into each
   * repo's `main`. For Spectrolite this is always the single vault repo. Returns
   * the discriminated union (`pushed` / `up-to-date` / `diverged` /
   * `build-failed`); `diverged` means `main` moved past the base (reconcile with
   * `vcs.merge` and re-push) and a `build-failed` result means NO head advanced.
   */
  push(input: { repoPaths: string[]; sourceHead?: string }): Promise<PublishPushResult>;
  /** Fold durable working edits into a messaged ctx-head snapshot. */
  commit(input: { message: string; repoPaths?: string[] }): Promise<PublishCommitResult[]>;
  pendingMerge(
    repoPath: string,
    targetHead?: string
  ): Promise<{
    theirsHead: string;
    conflicts: Array<{ path: string; kind: string }>;
  } | null>;
  abortMerge(repoPath: string, targetHead?: string): Promise<{ aborted: boolean }>;
  /** Per-repo drift for the caller's context: `behind` = `main` advanced past the
   *  context's pinned base (the editor is showing a stale snapshot). */
  contextStatus(): Promise<Array<{ repoPath: string; forked: boolean; uncommitted?: boolean; ahead: boolean; behind: boolean; deleted?: boolean }>>;
  /** Pull latest `main` into the context's edited repos + re-pin its base. */
  rebaseContext(): Promise<{
    repos: Array<{ repoPath: string; status: "up-to-date" | "merged" | "conflicted" }>;
    baseView: string;
  }>;
}

export interface PublishSnapshot {
  ahead: number;
  /** Durable uncommitted working-edit rows on the vault head (push rejects while > 0). */
  uncommitted: number;
  files: Array<{ path: string; kind: "added" | "removed" | "changed" }>;
  /** The vault repo's main was archived/deleted; publishing this stale head is refused. */
  deleted: boolean;
  /** The vault head cannot fast-forward until it is merged/synced with main. */
  diverged: boolean;
  publishing: boolean;
  /** A conflicted pull parked on the panel's own ctx head, awaiting resolution. */
  pending: { theirsHead: string; conflicts: Array<{ path: string; kind: string }> } | null;
  /** The build report from the last `build-failed` push (null when none). */
  buildReport: PublishBuildReport[] | null;
  /** True when `main` has advanced past the context's pinned base for the vault —
   *  the editor is showing a stale snapshot; Sync (rebase) to pick up the latest. */
  behind: boolean;
  lastError: string | null;
}

export type PublishOutcome =
  | { status: "published" }
  | { status: "up-to-date" }
  | { status: "needs-resolve" }
  | { status: "build-failed"; reports: PublishBuildReport[] }
  | { status: "error"; message: string };

/**
 * Commit the active document's working copy to the ctx head as ONE deliberate
 * GAD commit, carrying the user's commit message. Returns the commit result, or
 * null when there is no active doc. `conflicted` means the commit parked a
 * pending merge (the publish must stop and route to resolution).
 */
export type CommitWorkingCopy = (
  message: string
) => Promise<{ stateHash: string; changed: boolean; conflicted?: boolean } | null>;

const EMPTY: PublishSnapshot = {
  ahead: 0,
  uncommitted: 0,
  files: [],
  deleted: false,
  diverged: false,
  publishing: false,
  pending: null,
  buildReport: null,
  behind: false,
  lastError: null,
};

export class PublishController {
  private snap: PublishSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  /**
   * @param vcs       the injected per-repo vcs surface.
   * @param vaultRepo the vault's repo path (`projects/<vault>`) — the single
   *                  repo this controller pushes / reads status for.
   */
  constructor(
    private readonly vcs: PublishVcs,
    private readonly vaultRepo: string,
    /**
     * Called after a successful rebase so the editor re-reads the (re-pinned)
     * base. Essential when the rebase advanced NO head — an unedited vault whose
     * `rebaseContext` only re-pins the base emits no `subscribeHead` advance, so
     * without this the bar would clear `behind` while the document still shows
     * the old pinned content.
     */
    private readonly onRebased?: () => void | Promise<void>,
    /**
     * Commit the active document's working copy to the ctx head as ONE deliberate
     * GAD commit, BEFORE the push step. Publish is the user's single "save +
     * publish" gesture: it commits the working copy with the supplied message,
     * then pushes ctx→main. Null when there is no active doc; if the snapshot
     * already reports durable working edits or a pending merge, Publish falls
     * back to a repo-scoped `vcs.commit` before pushing.
     */
    private readonly commitWorkingCopy?: CommitWorkingCopy
  ) {}

  getSnapshot(): PublishSnapshot {
    return this.snap;
  }

  /** The repo this controller is bound to (`projects/<vault>`). */
  getRepo(): string {
    return this.vaultRepo;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(patch: Partial<PublishSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  /** Recompute the unpublished count + any pending merge (call on head advance). */
  async refresh(): Promise<void> {
    if (!this.vaultRepo) {
      this.set({
        ahead: 0,
        uncommitted: 0,
        files: [],
        deleted: false,
        diverged: false,
        pending: null,
        buildReport: null,
        behind: false,
        lastError: null,
      });
      return;
    }
    try {
      const [statuses, pending, ctxStatus] = await Promise.all([
        this.vcs.pushStatus([this.vaultRepo]),
        this.vcs.pendingMerge(this.vaultRepo),
        this.vcs.contextStatus().catch(() => []),
      ]);
      const status =
        statuses.find((s) => s.repoPath === this.vaultRepo) ?? statuses[0] ?? {
          repoPath: this.vaultRepo,
          ahead: 0,
          uncommitted: 0,
          diverged: false,
          deleted: false,
          files: [],
        };
      const behind =
        status.diverged || ctxStatus.some((s) => s.repoPath === this.vaultRepo && s.behind);
      const deleted =
        status.deleted || ctxStatus.some((s) => s.repoPath === this.vaultRepo && s.deleted);
      this.set({
        ahead: status.ahead,
        uncommitted: status.uncommitted,
        files: status.files,
        deleted,
        diverged: status.diverged,
        pending,
        behind,
        lastError: null,
      });
    } catch (error) {
      this.set({ lastError: errorMessage(error) });
    }
  }

  /**
   * Sync the vault to latest `main`: pull main into the context's edited repos and
   * re-pin the base, so the editor reflects concurrent pushes. Used when the bar
   * shows `behind` (the pinned context has drifted from main).
   */
  async rebase(): Promise<PublishMergeResult["status"] | "error"> {
    if (!this.vaultRepo) return "up-to-date";
    try {
      const res = await this.vcs.rebaseContext();
      await this.refresh();
      // Reload the editor: the base moved, but an unedited vault advanced no head
      // so the DocController's subscribeHead won't fire on its own.
      await this.onRebased?.();
      const vault = res.repos.find((r) => r.repoPath === this.vaultRepo);
      return vault?.status ?? "up-to-date";
    } catch (error) {
      this.set({ lastError: errorMessage(error) });
      return "error";
    }
  }

  private async commitBeforePublish(message: string): Promise<"ready" | "needs-resolve"> {
    const needsRepoCommit = this.snap.pending !== null || this.snap.uncommitted > 0;
    let committed = false;

    if (this.commitWorkingCopy) {
      const result = await this.commitWorkingCopy(message);
      if (result?.conflicted) {
        const pending = await this.vcs.pendingMerge(this.vaultRepo);
        this.set({ pending });
        return "needs-resolve";
      }
      committed = result !== null;
    }

    if (!committed && needsRepoCommit) {
      await this.vcs.commit({ message, repoPaths: [this.vaultRepo] });
      committed = true;
    }

    if (committed) {
      await this.refresh();
      if (this.snap.pending) return "needs-resolve";
    }

    return "ready";
  }

  /**
   * Publish the vault repo to its `main` as ONE deliberate user gesture:
   *   1. COMMIT durable working edits to the ctx head with the supplied
   *      `message` after flushing the active document when one is mounted (the
   *      deliberate, git-like commit — there is no commit-per-keystroke stream);
   *   2. pull `main` into ctx first (so conflicts land in the panel's own head);
   *   3. build-gated `vcs.push` ctx→`main` for the single vault repo.
   *
   * @param message the commit message for step 1 (defaulted by the UI).
   */
  async publish(message = "Publish"): Promise<PublishOutcome> {
    if (this.snap.publishing) return { status: "error", message: "already publishing" };
    if (!this.vaultRepo) return { status: "error", message: "No vault selected" };
    this.set({ publishing: true, lastError: null, buildReport: null });
    try {
      // Step 1: commit durable working edits. A pending merge is completed by
      // this commit after the user resolves markers; unresolved markers keep the
      // pending merge surfaced and stop before push.
      if ((await this.commitBeforePublish(message)) === "needs-resolve") {
        return { status: "needs-resolve" };
      }
      // Publish is pull-main-then-push (after the commit above). A conflict in
      // the PULL parks on the caller's own ctx head (resolvable in-editor →
      // needs-resolve). A `diverged` push is a TOCTOU (main advanced again after
      // the pull); the server advanced no head, so we re-pull the newer main and
      // retry, bounded. A `build-failed` push (rare for a content-only vault repo,
      // but handled) advanced no head — surface the report and stop.
      for (let attempt = 0; attempt < 3; attempt++) {
        // Pull main into the vault's own ctx head (repo-first signature; head
        // omitted = the caller's vault head). Reconciles divergence before push.
        const pull = await this.vcs.merge(this.vaultRepo);
        if (pull.status === "conflicted") {
          const pending = await this.vcs.pendingMerge(this.vaultRepo);
          this.set({ pending });
          return { status: "needs-resolve" };
        }
        let result: PublishPushResult;
        try {
          result = await this.vcs.push({ repoPaths: [this.vaultRepo] });
        } catch (error) {
          // A concurrent `main` advance DURING the build gate makes the
          // store-level group commit THROW `ref CAS conflict` rather than
          // returning `diverged`. It is the same benign TOCTOU — the server
          // advanced no head — so re-pull the newer main and retry (bounded),
          // exactly as for a `diverged` result. Anything else is a real error.
          if (isRefCasConflict(error)) continue; // main moved mid-gate; re-pull + retry
          throw error;
        }
        if (result.status === "diverged") continue; // main moved; re-pull + retry
        if (result.status === "build-failed") {
          this.set({ buildReport: result.reports });
          return { status: "build-failed", reports: result.reports };
        }
        await this.refresh();
        return { status: result.status === "up-to-date" ? "up-to-date" : "published" };
      }
      return {
        status: "error",
        message: "Publish kept racing a concurrent change to main — please try again.",
      };
    } catch (error) {
      const message = errorMessage(error);
      this.set({ lastError: message });
      return { status: "error", message };
    } finally {
      this.set({ publishing: false });
    }
  }

  /** Abandon a conflicted pull, restoring the pre-merge ctx tree. */
  async abort(): Promise<void> {
    if (!this.vaultRepo) return;
    try {
      await this.vcs.abortMerge(this.vaultRepo);
      this.set({ pending: null });
      await this.refresh();
    } catch (error) {
      this.set({ lastError: errorMessage(error) });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A store-level optimistic-concurrency failure (`ref CAS conflict: <ref>`),
 *  thrown when `main` advanced between the pull and the gated group commit.
 *  Benign and retriable — treated like a `conflicted` push result. */
function isRefCasConflict(error: unknown): boolean {
  return /\bCAS conflict\b/u.test(errorMessage(error));
}
