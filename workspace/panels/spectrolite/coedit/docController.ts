/**
 * DocController — the GAD-native document controller (edit → commit → push).
 *
 * One per open document. It owns, per path:
 *  - the loaded `baseStateHash` + the canonical text it represents (the last
 *    recorded WORKING state),
 *  - the live editor (Lexical) via the {@link CoEditEditor} contract,
 *  - **tracked working edits**: typing updates the editor + in-memory state and
 *    is debounced into one `vcs.edit` (replace-hunks of the dirty blocks,
 *    whole-doc fallback otherwise). `vcs.edit` durably records uncommitted
 *    working edits in GAD *with provenance* — it is NOT a commit: no commit-log
 *    entry, no head advance, no build, and it never appears in vcs.log. There is
 *    no panel-local draft buffer any more; GAD owns crash-durable working state.
 *  - a **deliberate commit** ({@link commitNow}): invoked ONLY by Publish (and
 *    the explicit Send-to-scribe flush). It flushes any pending working edit,
 *    then folds the context's accumulated uncommitted edits into one messaged
 *    snapshot via `vcs.commit({ message })`. Like a `git commit`; `main` advances
 *    only on the subsequent push.
 *  - **remote reconcile**: `vcs.subscribeHead` → on a COMMIT advance (a co-editor
 *    sealing a snapshot), read the changed file, block-diff vs current, classify
 *    (contained / structural / colliding) and apply narrowly. Working `vcs.edit`s
 *    do NOT broadcast a head advance, so the reconcile stream is commit-driven.
 *    Disk is a projection of head; the editor never reads or writes the
 *    filesystem.
 *
 * Pure orchestration over injected `editor` / `vcs` / `viewState` / `splitBlocks`
 * so it is unit-testable without Lexical or a live server.
 */

import { reconcileBlocks, type Block, type Collision } from "./blockReconcile.js";
import { buildEditOps, type ReplaceEditOp } from "./commitEdits.js";
import { liftLegacyViewState, type ViewStateStore } from "./viewState.js";

/** A single top-level editor block for reconciliation (registry view). */
export interface EditorBlock {
  id: string;
  signature: string;
  text: string;
}

/** A dirty block's base range + current text, for edit hunks. */
export interface DirtyCommit {
  /** Full serialization of the editor's current state. */
  canonical: string;
  dirty: Array<{ baseStart: number; baseEnd: number; newText: string }>;
}

export interface ContainedApply {
  kind: "contained";
  oldId: string;
  oldIndex: number;
  newText: string;
}
export interface StructuralApply {
  kind: "structural";
  fromIndex: number;
  toIndex: number;
  oldIds: string[];
  newTexts: string[];
  /** Stable id (node key) to insert the new content before; null = append. */
  beforeId: string | null;
}

/** The contract the Lexical editor (with its block registry) must satisfy. */
export interface CoEditEditor {
  /** Full canonical serialization of the current state. */
  getCanonical(): string;
  /** Replace the whole document — load / migration only (never mid-edit). */
  setCanonical(markdown: string): void;
  /** Re-baseline the registry: `canonical` is the new recorded base; clear
   *  dirty marks and recompute base ranges. */
  rebase(canonical: string): void;
  /** Current top-level blocks for reconciliation. */
  getBlocks(): EditorBlock[];
  /** Block ids the user is live in (dirty or active-caret). */
  getLiveBlockIds(): Set<string>;
  /** Current canonical + dirty blocks with base ranges, for an edit. */
  getDirtyCommit(): DirtyCommit;
  /** Apply a contained single-node replace — tagged `historic` (no re-record,
   *  no local undo entry). */
  applyContained(op: ContainedApply): void;
  /** Apply a structural bounded-range replace — tagged `historic`. */
  applyStructural(op: StructuralApply): void;
  /** Briefly highlight + attribute blocks to an actor (presence). */
  markAttribution(blockIds: string[], actor: { id: string; kind: string } | null): void;
  /** Fires on each local user edit (controller debounces the working edit). Returns unsubscribe. */
  onUserEdit(cb: () => void): () => void;
}

export interface HeadAdvance {
  head: string;
  stateHash: string;
  /** The advanced repo log's own state hash — matches the values
   *  `vcs.edit`/`vcs.commit`/`readFile`/`revert` return. For a per-repo head this
   *  differs from `stateHash` (the composed view), so self-echo and undo guards
   *  MUST correlate on this. Falls back to `stateHash` when absent (legacy
   *  whole-workspace heads, where the two are equal). */
  repoStateHash?: string;
  actor: { id: string; kind: string } | null;
  changedPaths: string[];
}

/** An UNCOMMITTED working-content advance (`vcs.edit`, incl. `vcs.revert`) on the
 *  vault head — delivered via {@link DocVcs.subscribeWorking}. `stateHash` is the
 *  working state (the undo/self-echo correlation hash). */
export interface WorkingAdvance {
  head: string;
  stateHash: string;
  actor: { id: string; kind: string } | null;
  changedPaths: string[];
}

/** A tracked WORKING edit result (`vcs.edit`) — no commit, no head advance. */
export interface EditResult {
  /** The working state hash (committed base + uncommitted ops) projected to disk. */
  stateHash: string;
  committed: false;
  status: "uncommitted";
  changedPaths: string[];
}

/** A per-repo commit result (`vcs.commit`) — folds working edits into a snapshot. */
export interface CommitResultRow {
  repoPath: string;
  stateHash: string;
  status: "committed" | "unchanged";
  changedPaths: string[];
}

/** Minimal vcs surface the controller needs (structurally a subset of VcsClient). */
export interface DocVcs {
  readFile(
    ref: string,
    path: string
  ): Promise<{
    content: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
    stateHash: string;
  } | null>;
  /** Record a batch of edits as UNCOMMITTED WORKING changes (no commit/build). */
  edit(input: { baseStateHash?: string; edits: ReplaceEditOp[] }): Promise<EditResult>;
  /** Fold the context's uncommitted working edits into ONE messaged snapshot per
   *  repo. `repoPaths` scopes to the vault repo; `message` is mandatory. */
  commit(input: { message: string; repoPaths?: string[] }): Promise<CommitResultRow[]>;
  subscribeHead(head: string, onAdvance: (advance: HeadAdvance) => void): () => void;
  /** Subscribe to UNCOMMITTED working advances (`vcs.edit`/`vcs.revert`) on the
   *  head. A revert is now a working edit, so its content arrives here (not via
   *  subscribeHead); the controller applies historic (coordinator-issued) ones. */
  subscribeWorking(head: string, onAdvance: (advance: WorkingAdvance) => void): () => void;
}

export interface UndoSink {
  /** A local commit sealed a Lexical checkpoint; `stateHash` is revertable. */
  sealCommit(stateHash: string): void;
  /** A remote (agent) transition landed; `stateHash` is revertable + attributed. */
  recordRemote(stateHash: string, actor: { id: string; kind: string } | null): void;
}

export interface DocControllerDeps {
  editor: CoEditEditor;
  vcs: DocVcs;
  /** The vault's stable head (`ctx:vault-<hash>`). */
  vaultHead: string;
  /** The vault's repo path (`projects/<vault>`) — `vcs.commit` is scoped to it. */
  vaultRepo: string;
  viewState: ViewStateStore;
  /** Parse canonical markdown into reconciliation blocks (mdast-based). */
  splitBlocks: (markdown: string) => Block[];
  /** Surface live same-block collisions as SuggestionCards. */
  onCollisions: (collisions: Collision[], vcsPath: string) => void;
  /** A deliberate commit (Publish/Send) parked a pending merge (markers
   *  materialized into the head). The app routes this to the pending-merge
   *  resolution UX (do not treat the commit as clean). */
  onConflict?: (vcsPath: string) => void;
  /** A working edit OR a commit FAILED. The app should keep the path marked
   *  unsaved rather than silently clearing the dirty indicator. */
  onSaveError?: (vcsPath: string, error: unknown) => void;
  /** Fires whenever the working-copy dirtiness MAY have changed (after a working
   *  edit, a commit, or a remote apply) so the app can update its indicator. */
  onDirtyChange?: (vcsPath: string, dirty: boolean) => void;
  undo?: UndoSink;
  /** Debounce window for recording the working edit (default 600ms). */
  editDebounceMs?: number;
  /** Schedule a debounced callback (injectable for tests). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class DocController {
  private vcsPath: string | null = null;
  private baseStateHash: string | null = null;
  private baseText = "";
  /** The repoStateHash of our own last commit — skip it when it echoes back. */
  private lastSelfStateHash: string | null = null;
  /** Head advances the undo coordinator initiated (reverts): apply their
   *  content, but do not attribute or re-record them (echo guard, decision 8). */
  private readonly historicAdvances = new Set<string>();
  private editTimer: unknown = null;
  /** Set while an async `vcs.edit` drain is in flight. */
  private editing = false;
  /** The active edit drain promise; awaited by explicit commit/dispose flushes. */
  private editPromise: Promise<void> | null = null;
  /** A user edit arrived while `editPromise` was active; run another pass after it. */
  private editAgain = false;
  /** A queued pass must run even after dispose (teardown flush). */
  private editAgainForce = false;
  private disposed = false;
  private offUserEdit: (() => void) | null = null;
  private offHead: (() => void) | null = null;
  private offWorking: (() => void) | null = null;

  // Fallback-rate metric (the rewrite's success bar).
  editCount = 0;
  fallbackCount = 0;

  constructor(private readonly deps: DocControllerDeps) {}

  get fallbackRate(): number {
    return this.editCount === 0 ? 0 : this.fallbackCount / this.editCount;
  }

  /** Load a document: read the WORKING content at the caller's head (committed
   *  base + any uncommitted edits projected to disk), migrate legacy view-state,
   *  seed the editor. No `fs.readFile`, no panel-local draft. */
  async load(vcsPath: string): Promise<void> {
    this.detachSubscriptions();
    this.vcsPath = vcsPath;
    const file = await this.deps.vcs.readFile("", vcsPath);
    const original = file && file.content.kind === "text" ? file.content.text : "";
    this.baseStateHash = file?.stateHash ?? null;

    const { viewState, canonical: stripped, migrated } = liftLegacyViewState(original);
    if (viewState) this.deps.viewState.seedIfAbsent(vcsPath, viewState);

    // The editor shows the working content the head projects (committed base plus
    // any uncommitted working edits already tracked in GAD — `readFile` returns
    // exactly that). `baseText` mirrors the canonical text `baseStateHash` holds
    // (after the one-time migration strip, the stripped text).
    const workingBase = migrated ? stripped : original;

    this.deps.editor.setCanonical(workingBase);
    this.offUserEdit = this.deps.editor.onUserEdit(() => this.scheduleEdit());
    this.offHead = this.deps.vcs.subscribeHead(this.deps.vaultHead, (advance) => {
      void this.onHeadAdvance(advance);
    });
    // A revert is a WORKING edit now (not a commit), so its content arrives on
    // the working channel — subscribe so undo/redo applies into the editor.
    this.offWorking = this.deps.vcs.subscribeWorking(this.deps.vaultHead, (advance) => {
      void this.onWorkingAdvance(advance);
    });

    // One-time migration: record the whole-doc strip as a working `vcs.edit` (a
    // real forward transition, not counted against the co-edit fallback metric).
    if (migrated && this.baseStateHash != null) {
      const result = await this.deps.vcs.edit({
        baseStateHash: this.baseStateHash,
        edits: [
          {
            kind: "replace",
            path: vcsPath,
            hunks: [{ start: 0, end: original.length, oldText: original, newText: stripped }],
          },
        ],
      });
      this.baseStateHash = result.stateHash;
      this.baseText = stripped;
      this.deps.editor.rebase(stripped);
    } else {
      this.baseText = workingBase;
    }

    this.emitDirty();
  }

  private detachSubscriptions(): void {
    this.offUserEdit?.();
    this.offHead?.();
    this.offWorking?.();
    this.offUserEdit = null;
    this.offHead = null;
    this.offWorking = null;
  }

  /** Whether the working copy diverges from the last recorded base (git-like
   *  dirty). A pending debounced edit not yet flushed still reads as dirty here. */
  isDirty(): boolean {
    if (this.vcsPath == null) return false;
    return this.deps.editor.getCanonical() !== this.baseText;
  }

  private emitDirty(): void {
    if (this.vcsPath == null) return;
    this.deps.onDirtyChange?.(this.vcsPath, this.isDirty());
  }

  /** Debounced record of the current working copy as a tracked `vcs.edit`. This
   *  is NOT a commit — GAD owns the durable uncommitted working state. */
  private scheduleEdit(): void {
    if (this.disposed) return;
    const ms = this.deps.editDebounceMs ?? 600;
    const set = this.deps.setTimer ?? ((fn, d) => setTimeout(fn, d));
    const clear = this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    if (this.editTimer != null) clear(this.editTimer);
    this.editTimer = set(() => {
      this.editTimer = null;
      void this.recordEdit();
    }, ms);
  }

  /** Record the current working copy as a tracked `vcs.edit` (surgical hunks of
   *  the dirty blocks, whole-doc fallback otherwise). Advances the recorded base
   *  on success. Coalesces: re-entrant calls while one is in flight request
   *  another pass, and explicit flushes wait for that pass before returning. */
  private async recordEdit(force = false): Promise<void> {
    if ((this.disposed && !force) || this.vcsPath == null || this.baseStateHash == null) return;
    if (this.editPromise) {
      this.editAgain = true;
      this.editAgainForce ||= force;
      await this.editPromise;
      return;
    }
    this.editPromise = this.drainEdits(force);
    await this.editPromise;
  }

  private async drainEdits(force = false): Promise<void> {
    this.editing = true;
    let allowAfterDispose = force;
    try {
      do {
        const passForce = allowAfterDispose;
        this.editAgain = false;
        this.editAgainForce = false;
        await this.recordEditOnce(passForce);
        allowAfterDispose = this.editAgainForce;
      } while (this.editAgain && (!this.disposed || allowAfterDispose));
    } finally {
      this.editing = false;
      this.editPromise = null;
      this.editAgain = false;
      this.editAgainForce = false;
    }
  }

  private async recordEditOnce(force = false): Promise<void> {
    if ((this.disposed && !force) || this.vcsPath == null || this.baseStateHash == null) return;
    const vcsPath = this.vcsPath;
    const { canonical, dirty } = this.deps.editor.getDirtyCommit();
    const built = buildEditOps({
      path: vcsPath,
      baseText: this.baseText,
      currentCanonical: canonical,
      dirtyBlocks: dirty,
    });
    if (!built.changed) {
      this.emitDirty();
      return;
    }

    this.editCount += 1;
    if (built.usedFallback) this.fallbackCount += 1;

    try {
      const result = await this.deps.vcs.edit({
        baseStateHash: this.baseStateHash,
        edits: built.edits,
      });
      // Advance the recorded base so the next edit computes hunks against it.
      this.baseStateHash = result.stateHash;
      this.baseText = canonical;
      this.deps.editor.rebase(canonical);
    } catch (error) {
      // The edit could not be recorded (e.g. a parked pending merge rejects
      // per-doc edits). Keep the path marked unsaved and surface it.
      this.deps.onSaveError?.(vcsPath, error);
    }
    this.emitDirty();
  }

  /** The undo coordinator calls this before issuing a `vcs.revert`, so the
   *  resulting head advance applies the reverted content WITHOUT recording it
   *  as a new (undoable) remote transition — preventing undo loops. */
  expectHistoric(stateHash: string): void {
    this.historicAdvances.add(stateHash);
  }

  /**
   * Commit the context's accumulated uncommitted working edits as ONE deliberate
   * GAD commit carrying a `message`. Invoked ONLY by Publish and the explicit
   * Send-to-scribe flush — NEVER on typing/quiescence. It first flushes any
   * pending debounced working edit (so all typed content is recorded), then
   * `vcs.commit({ message, repoPaths: [vaultRepo] })`. On success it remembers the
   * commit's state hash (so its head-advance echo is a no-op) and seals an undo
   * checkpoint.
   *
   * @param message human commit message (always supplied).
   */
  async commitNow(
    message: string
  ): Promise<{ stateHash: string; changed: boolean; conflicted?: boolean } | null> {
    if (this.disposed || this.vcsPath == null || this.baseStateHash == null) return null;
    const vcsPath = this.vcsPath;

    // Flush any pending debounced working edit first so the commit folds the
    // latest typed content (the debounce may not have fired yet).
    if (this.editTimer != null) {
      const clear = this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
      clear(this.editTimer);
      this.editTimer = null;
    }
    await this.recordEdit();

    let rows: CommitResultRow[];
    try {
      rows = await this.deps.vcs.commit({ message, repoPaths: [this.deps.vaultRepo] });
    } catch (error) {
      // A parked pending merge on the head (e.g. a conflicted publish-pull
      // awaiting resolution) rejects the commit. Surface the pending merge so
      // the resolution UX takes over rather than crashing.
      if (error instanceof Error && /merge in progress/u.test(error.message)) {
        this.deps.onConflict?.(vcsPath);
        return null;
      }
      throw error;
    }

    const row = rows.find((r) => r.repoPath === this.deps.vaultRepo) ?? rows[0] ?? null;
    if (!row || row.status === "unchanged") {
      // Nothing to commit — the working copy already equals the committed head.
      this.emitDirty();
      return { stateHash: row?.stateHash ?? this.baseStateHash, changed: false };
    }

    // Remember the commit's repo state hash so its head-advance echo is a no-op,
    // and seal an undo checkpoint.
    this.lastSelfStateHash = row.stateHash;
    this.deps.undo?.sealCommit(row.stateHash);
    this.emitDirty();
    return { stateHash: row.stateHash, changed: true };
  }

  private async onHeadAdvance(advance: HeadAdvance): Promise<void> {
    if (this.disposed || this.vcsPath == null) return;
    if (advance.head !== this.deps.vaultHead) return;
    // Correlate against the repo log's own state hash (the identity space of
    // edit/commit/readFile/revert returns), NOT the composed-view `stateHash` the
    // build trigger uses — they diverge for a per-repo head.
    const advanceHash = advance.repoStateHash ?? advance.stateHash;
    // Echo guard: our own commit coming back is not a remote edit.
    if (advanceHash === this.lastSelfStateHash) {
      this.lastSelfStateHash = null;
      return;
    }
    await this.applyAdvance(advanceHash, advance.changedPaths, advance.actor);
  }

  /**
   * A WORKING advance (`vcs.edit`/`vcs.revert`) landed on the vault head. On a
   * single-writer vault, working advances are our own: ordinary typing (already
   * in the editor — its echo is ignored) or a coordinator-issued REVERT, whose
   * content must be applied. We act ONLY on historic (revert) advances —
   * `expectHistoric` marked the revert's state — so undo/redo reflects into the
   * editor without re-recording our own keystrokes. (Multi-writer co-typing —
   * applying others' working edits live — is the deferred follow-up.)
   */
  private async onWorkingAdvance(advance: WorkingAdvance): Promise<void> {
    if (this.disposed || this.vcsPath == null) return;
    if (advance.head !== this.deps.vaultHead) return;
    if (!this.historicAdvances.has(advance.stateHash)) return;
    await this.applyAdvance(advance.stateHash, advance.changedPaths, advance.actor);
  }

  /**
   * Apply an incoming advance (commit OR historic revert) into the editor:
   * reconcile the head's content against the live blocks, attribute + record
   * non-historic remote edits for undo, surface collisions, and re-baseline when
   * clean. Shared by {@link onHeadAdvance} and {@link onWorkingAdvance}.
   */
  private async applyAdvance(
    advanceHash: string,
    changedPaths: string[],
    actor: { id: string; kind: string } | null
  ): Promise<void> {
    if (this.vcsPath == null) return;
    const isHistoric = this.historicAdvances.delete(advanceHash);
    if (!changedPaths.includes(this.vcsPath)) return;

    const file = await this.deps.vcs.readFile("", this.vcsPath);
    if (!file || file.content.kind !== "text") return;
    const incomingText = file.content.text;

    const incoming = this.deps.splitBlocks(incomingText);
    const current = this.deps.editor.getBlocks();
    const live = this.deps.editor.getLiveBlockIds();
    // `reconcileBlocks` reads only id/signature/text from `current` (the source
    // ranges come from `incoming`); EditorBlock carries exactly those. Cast is
    // type-only — no runtime effect.
    const { ops, collisions } = reconcileBlocks(current as Block[], incoming, live);

    const appliedIds: string[] = [];
    for (const op of ops) {
      if (op.kind === "contained") {
        this.deps.editor.applyContained(op);
        appliedIds.push(op.oldId);
      } else {
        this.deps.editor.applyStructural(op);
        appliedIds.push(...op.oldIds);
      }
    }
    // A revert (historic) applies its content but is neither attributed to an
    // agent nor recorded as a new undoable transition (the coordinator owns it).
    if (appliedIds.length > 0 && !isHistoric) {
      this.deps.editor.markAttribution(appliedIds, actor);
      this.deps.undo?.recordRemote(advanceHash, actor);
    }
    if (collisions.length > 0) {
      this.deps.onCollisions(collisions, this.vcsPath);
    }

    // With no unresolved collisions the editor now equals head → re-baseline the
    // recorded base.
    //
    // With collisions, the user's live blocks still diverge, so KEEP the base at
    // its pre-advance value: the next working edit / commit then sends against the
    // stale base and the server takes the 3-way diff3 merge path
    // (surfacing/resolving the conflict) instead of fast-forwarding the local
    // block over the remote one. (Applied non-colliding blocks re-emit as dirty
    // and fold cleanly in diff3.)
    if (collisions.length === 0) {
      this.baseStateHash = file.stateHash;
      this.baseText = incomingText;
      this.deps.editor.rebase(incomingText);
    }
    this.emitDirty();
  }

  dispose(): void {
    // Flush the pending working edit to GAD before teardown (NOT a commit) so
    // typing within the debounce window is durably recorded even as the editor
    // state unmounts. recordEdit reads the editor synchronously, so it captures
    // the latest content before the editor goes away. Must run BEFORE `disposed`
    // is set (disposed short-circuits recordEdit).
    if (this.editTimer != null) {
      const clear = this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
      clear(this.editTimer);
      this.editTimer = null;
    }
    void this.recordEdit(true).catch((err) => {
      // A failed working-edit flush has no retry (the editor is unmounting).
      // Surface it so the app keeps the path marked unsaved.
      if (this.vcsPath) this.deps.onSaveError?.(this.vcsPath, err);
    });
    this.disposed = true;
    this.detachSubscriptions();
  }
}
