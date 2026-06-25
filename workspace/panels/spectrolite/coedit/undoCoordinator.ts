/**
 * Undo coordinator — one ⌘Z stack over two tiers (decision 8 + section C).
 *
 * The debounced working-edit recording means recent keystrokes may not have a
 * GAD transition yet, so ⌘Z must first undo **uncommitted local edits via
 * Lexical's native undo** (normal typing feel). Once an edit is committed — and
 * for every *agent* transition — undo becomes a **GAD revert**: `vcs.revert`
 * forward-applies the inverse patch (never a head reset), so reverting one
 * transition preserves later edits and an overlap surfaces as a conflict.
 *
 * The Lexical↔GAD boundary is invisible and a revert round-trips
 * `vcs.revert → subscribeHead → node replace`, which Lexical would otherwise
 * record as a NEW undoable action (double-undo / loops). So this single
 * coordinator owns ⌘Z and ⇧⌘Z:
 *   1. commits/agent-edits seal a checkpoint (push a revertable transition);
 *   2. ⌘Z drains uncommitted Lexical edits first, then reverts the last sealed
 *      transition;
 *   3. revert-applied node replacements are tagged `historic` (via the editor)
 *      and pass the **echo guard** (`onRevertIssued`) so they are NOT recorded
 *      as new remote transitions or re-committed — preventing undo loops.
 * Redo mirrors: a revert is itself a forward transition, so redo reverts the
 * revert (the original change reapplied).
 *
 * Pure over an injected Lexical-undo capability + a revert function, so the
 * tier logic + stacks are unit-testable without a live editor or server.
 */

import type { UndoSink } from "./docController.js";

/** Lexical's native history capability (tier 1). */
export interface LexicalUndo {
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;
}

export type RevertFn = (target: { stateHash: string }) => Promise<{ stateHash: string }>;

interface Transition {
  stateHash: string;
  kind: "local" | "remote";
  actor: { id: string; kind: string } | null;
}

export type UndoOutcome = "lexical" | "revert" | "none";

export interface UndoCoordinatorDeps {
  lexical: LexicalUndo;
  revert: RevertFn;
  /** Echo guard: the stateHash a revert just produced is coordinator-managed —
   *  the DocController applies its content but must NOT record it as a new
   *  remote transition (else it re-enters the undo stack → a loop). */
  onRevertIssued?: (stateHash: string) => void;
}

export class UndoCoordinator implements UndoSink {
  private readonly undoStack: Transition[] = [];
  private readonly redoStack: Array<{ original: Transition; revertHash: string }> = [];

  constructor(private readonly deps: UndoCoordinatorDeps) {}

  /** A local commit sealed a checkpoint — its transition is revertable. */
  sealCommit(stateHash: string): void {
    this.undoStack.push({ stateHash, kind: "local", actor: null });
    this.redoStack.length = 0;
  }

  /** A remote (agent) transition landed — revertable + attributed. */
  recordRemote(stateHash: string, actor: { id: string; kind: string } | null): void {
    this.undoStack.push({ stateHash, kind: "remote", actor });
    this.redoStack.length = 0;
  }

  get canUndo(): boolean {
    return this.deps.lexical.canUndo() || this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.deps.lexical.canRedo() || this.redoStack.length > 0;
  }

  /** ⌘Z: drain uncommitted Lexical edits, then revert the last sealed transition. */
  async undo(): Promise<UndoOutcome> {
    if (this.deps.lexical.canUndo()) {
      this.deps.lexical.undo();
      return "lexical";
    }
    const transition = this.undoStack.pop();
    if (!transition) return "none";
    const result = await this.deps.revert({ stateHash: transition.stateHash });
    this.deps.onRevertIssued?.(result.stateHash);
    this.redoStack.push({ original: transition, revertHash: result.stateHash });
    return "revert";
  }

  /** ⇧⌘Z: redo Lexical, then re-apply the last reverted transition. */
  async redo(): Promise<UndoOutcome> {
    if (this.deps.lexical.canRedo()) {
      this.deps.lexical.redo();
      return "lexical";
    }
    const entry = this.redoStack.pop();
    if (!entry) return "none";
    // Reverting the revert reapplies the original change (forward, never reset).
    const result = await this.deps.revert({ stateHash: entry.revertHash });
    this.deps.onRevertIssued?.(result.stateHash);
    this.undoStack.push(entry.original);
    return "revert";
  }

  /**
   * Per-block "revert this scribe change" — the same forward-inverse path as
   * ⌘Z, for an arbitrary committed/agent transition. Conflicts (overlap with
   * current content) surface like any edit.
   */
  async revertTransition(stateHash: string): Promise<{ stateHash: string }> {
    const result = await this.deps.revert({ stateHash });
    this.deps.onRevertIssued?.(result.stateHash);
    // Remove it from the undo stack if present (it's been explicitly reverted).
    const idx = this.undoStack.findIndex((t) => t.stateHash === stateHash);
    if (idx >= 0) this.undoStack.splice(idx, 1);
    return result;
  }
}
