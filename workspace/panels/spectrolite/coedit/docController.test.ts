import { describe, it, expect, beforeEach } from "vitest";
import {
  DocController,
  type CoEditEditor,
  type DocVcs,
  type DirtyCommit,
  type EditorBlock,
  type HeadAdvance,
  type WorkingAdvance,
  type ContainedApply,
  type StructuralApply,
} from "./docController.js";
import { applyReplaceHunks, type ReplaceEditOp } from "./commitEdits.js";
import { ViewStateStore, type ViewStateBackend } from "./viewState.js";
import type { Block } from "./blockReconcile.js";

const VAULT_HEAD = "ctx:vault-test";
const PATH = "projects/default/Doc.mdx";

/** Split a doc into blocks on blank lines (shared by editor + incoming). */
function splitOn(md: string, idPrefix: string): Block[] {
  const parts = md.split("\n\n");
  const out: Block[] = [];
  let pos = 0;
  parts.forEach((text, i) => {
    const start = pos;
    const end = pos + text.length;
    pos = end + 2;
    if (text.length) out.push({ id: `${idPrefix}${i}`, signature: text, text, start, end });
  });
  return out;
}

class FakeEditor implements CoEditEditor {
  canonical = "";
  liveIds = new Set<string>();
  private dirty: DirtyCommit["dirty"] = [];
  applied: Array<ContainedApply | StructuralApply> = [];
  attributions: Array<{ ids: string[]; actor: unknown }> = [];
  rebases: string[] = [];
  private callbacks = new Set<() => void>();

  getCanonical(): string {
    return this.canonical;
  }
  setCanonical(md: string): void {
    this.canonical = md;
  }
  rebase(canonical: string): void {
    this.dirty = [];
    this.liveIds = new Set();
    this.rebases.push(canonical);
  }
  getBlocks(): EditorBlock[] {
    return splitOn(this.canonical, "b").map((b) => ({ id: b.id, signature: b.signature, text: b.text }));
  }
  getLiveBlockIds(): Set<string> {
    return this.liveIds;
  }
  getDirtyCommit(): DirtyCommit {
    return { canonical: this.canonical, dirty: this.dirty };
  }
  applyContained(op: ContainedApply): void {
    this.applied.push(op);
  }
  applyStructural(op: StructuralApply): void {
    this.applied.push(op);
  }
  markAttribution(blockIds: string[], actor: { id: string; kind: string } | null): void {
    this.attributions.push({ ids: blockIds, actor });
  }
  onUserEdit(cb: () => void): () => void {
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }
  get userEditSubscriptionCount(): number {
    return this.callbacks.size;
  }
  /** Test helper: simulate a local user edit producing new canonical + dirty set. */
  userEdit(canonical: string, dirty: DirtyCommit["dirty"], live: string[] = []): void {
    this.canonical = canonical;
    this.dirty = dirty;
    this.liveIds = new Set(live);
    for (const cb of this.callbacks) cb();
  }
}

const VAULT_REPO = "projects/default";

class FakeVcs implements DocVcs {
  files = new Map<string, string>();
  private hashN = 0;
  stateHash = "state:0";
  /** Working `vcs.edit` calls (one per debounced flush — NOT a commit). */
  edits: Array<{ baseStateHash?: string; edits: ReplaceEditOp[] }> = [];
  /** Deliberate `vcs.commit` calls (Publish / Send flush). */
  commits: Array<{ message: string; repoPaths?: string[] }> = [];
  private editPauses: Array<Promise<void>> = [];
  private callbacks = new Set<(advance: HeadAdvance) => void>();
  private workingCallbacks = new Set<(advance: WorkingAdvance) => void>();

  async readFile(_ref: string, path: string) {
    const text = this.files.get(path);
    if (text == null) return null;
    return { content: { kind: "text" as const, text }, stateHash: this.stateHash };
  }
  /** Working edits recorded since the last commit (drives commit `status`). */
  private uncommitted = 0;
  pauseNextEdit(): () => void {
    let release!: () => void;
    this.editPauses.push(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    return release;
  }
  async edit(input: { baseStateHash?: string; edits: ReplaceEditOp[] }) {
    const pause = this.editPauses.shift();
    if (pause) await pause;
    this.edits.push(input);
    this.uncommitted += 1;
    for (const op of input.edits) {
      const cur = this.files.get(op.path) ?? "";
      this.files.set(op.path, applyReplaceHunks(cur, op.hunks));
    }
    this.stateHash = `state:s${++this.hashN}`;
    // A working edit does NOT broadcast a head advance.
    return {
      stateHash: this.stateHash,
      committed: false as const,
      status: "uncommitted" as const,
      changedPaths: input.edits.map((e) => e.path),
    };
  }
  async commit(input: { message: string; repoPaths?: string[] }) {
    this.commits.push(input);
    const had = this.uncommitted > 0;
    this.uncommitted = 0;
    const repoPath = input.repoPaths?.[0] ?? VAULT_REPO;
    if (had) this.stateHash = `state:c${++this.hashN}`;
    // A commit DOES broadcast a head advance (echoed back to the panel).
    return [
      {
        repoPath,
        stateHash: this.stateHash,
        status: had ? ("committed" as const) : ("unchanged" as const),
        changedPaths: had ? Array.from(this.files.keys()) : [],
      },
    ];
  }
  subscribeHead(_head: string, onAdvance: (advance: HeadAdvance) => void): () => void {
    this.callbacks.add(onAdvance);
    return () => {
      this.callbacks.delete(onAdvance);
    };
  }
  subscribeWorking(_head: string, onAdvance: (advance: WorkingAdvance) => void): () => void {
    this.workingCallbacks.add(onAdvance);
    return () => {
      this.workingCallbacks.delete(onAdvance);
    };
  }
  get headSubscriptionCount(): number {
    return this.callbacks.size;
  }
  get workingSubscriptionCount(): number {
    return this.workingCallbacks.size;
  }
  /** Test helper: a remote actor advanced the head, changing `path`. */
  remoteAdvance(path: string, newContent: string, actor: { id: string; kind: string }): void {
    this.files.set(path, newContent);
    this.stateHash = `state:r${++this.hashN}`;
    for (const cb of this.callbacks) {
      cb({ head: VAULT_HEAD, stateHash: this.stateHash, actor, changedPaths: [path] });
    }
  }
  /** Test helper: a coordinator REVERT landed as a WORKING advance (the new
   *  revert path). `stateHash` is the revert's working state (the controller
   *  must have `expectHistoric`'d it to apply it). */
  workingRevert(path: string, newContent: string, stateHash: string): void {
    this.files.set(path, newContent);
    this.stateHash = stateHash;
    for (const cb of this.workingCallbacks) {
      cb({ head: VAULT_HEAD, stateHash, actor: null, changedPaths: [path] });
    }
  }
  /** Echo a specific stateHash back as an advance (own-commit echo). */
  echo(path: string, stateHash: string): void {
    for (const cb of this.callbacks) {
      cb({ head: VAULT_HEAD, stateHash, actor: { id: "panel", kind: "panel" }, changedPaths: [path] });
    }
  }
  /** Echo where the head advance carries the composed-context-view `stateHash`
   *  (what the build trigger sees) DISTINCT from the repo log's `repoStateHash`
   *  (what vcs.edit/vcs.commit return) — the real per-repo VCS shape. */
  echoComposed(path: string, repoStateHash: string, composedStateHash: string): void {
    for (const cb of this.callbacks) {
      cb({
        head: VAULT_HEAD,
        stateHash: composedStateHash,
        repoStateHash,
        actor: { id: "panel", kind: "panel" },
        changedPaths: [path],
      });
    }
  }
}

function mapBackend(): ViewStateBackend {
  const store = new Map<string, string>();
  return {
    read: (k) => store.get(k) ?? null,
    write: (k, v) => void store.set(k, v),
    remove: (k) => void store.delete(k),
  };
}

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

function makeController(extra?: Partial<{ collisions: Array<{ collisions: unknown; path: string }> }>) {
  const editor = new FakeEditor();
  const vcs = new FakeVcs();
  const viewState = new ViewStateStore(mapBackend());
  const collisions: Array<{ collisions: unknown; path: string }> = extra?.collisions ?? [];
  const controller = new DocController({
    editor,
    vcs,
    vaultHead: VAULT_HEAD,
    vaultRepo: VAULT_REPO,
    viewState,
    splitBlocks: (md) => splitOn(md, "i"),
    onCollisions: (c, p) => collisions.push({ collisions: c, path: p }),
    setTimer: (fn) => {
      fn();
      return 1;
    },
    clearTimer: () => {},
  });
  return { editor, vcs, viewState, controller, collisions };
}

describe("DocController", () => {
  let h: ReturnType<typeof makeController>;
  beforeEach(() => {
    h = makeController();
  });

  it("loads content from vcs (no fs) and seeds the editor", async () => {
    h.vcs.files.set(PATH, "# Title\n\nbody");
    await h.controller.load(PATH);
    expect(h.editor.canonical).toBe("# Title\n\nbody");
  });

  it("reloads without stacking editor or VCS subscriptions", async () => {
    h.vcs.files.set(PATH, "one");
    await h.controller.load(PATH);
    expect(h.editor.userEditSubscriptionCount).toBe(1);
    expect(h.vcs.headSubscriptionCount).toBe(1);
    expect(h.vcs.workingSubscriptionCount).toBe(1);

    h.vcs.files.set(PATH, "two");
    await h.controller.load(PATH);
    expect(h.editor.canonical).toBe("two");
    expect(h.editor.userEditSubscriptionCount).toBe(1);
    expect(h.vcs.headSubscriptionCount).toBe(1);
    expect(h.vcs.workingSubscriptionCount).toBe(1);

    h.controller.dispose();
    expect(h.editor.userEditSubscriptionCount).toBe(0);
    expect(h.vcs.headSubscriptionCount).toBe(0);
    expect(h.vcs.workingSubscriptionCount).toBe(0);
  });

  it("migrates legacy state: frontmatter into the sidecar and strips canonical", async () => {
    h.vcs.files.set(PATH, "---\ntitle: D\nstate:\n  count: 9\n---\n\nbody\n");
    await h.controller.load(PATH);
    await flush();
    // Sidecar seeded.
    expect(h.viewState.get(PATH, "count", 0)).toBe(9);
    // Canonical lost `state:` and a one-time strip WORKING edit fired (no commit).
    expect(h.editor.canonical).not.toContain("state:");
    expect(h.vcs.edits.length).toBe(1);
    expect(h.vcs.commits.length).toBe(0);
    expect(h.vcs.files.get(PATH)).not.toContain("state:");
  });

  it("records dirty blocks as surgical working-edit hunks (no fallback, no commit)", async () => {
    h.vcs.files.set(PATH, "AAA\n\nBBB\n\nCCC");
    await h.controller.load(PATH);
    h.editor.userEdit("AAA\n\nB2B\n\nCCC", [{ baseStart: 5, baseEnd: 8, newText: "B2B" }], ["b1"]);
    await flush();
    // Typing records a WORKING edit, NOT a commit (no per-keystroke commit).
    expect(h.vcs.edits.length).toBe(1);
    expect(h.vcs.commits.length).toBe(0);
    expect(h.vcs.edits[0]!.edits[0]!.hunks).toEqual([
      { start: 5, end: 8, oldText: "BBB", newText: "B2B" },
    ]);
    expect(h.controller.fallbackRate).toBe(0);
    expect(h.vcs.files.get(PATH)).toBe("AAA\n\nB2B\n\nCCC");
  });

  it("does not record an edit when nothing changed (quiescence ≠ churn)", async () => {
    h.vcs.files.set(PATH, "AAA\n\nBBB");
    await h.controller.load(PATH);
    h.editor.userEdit("AAA\n\nBBB", [], []); // no actual change
    await flush();
    expect(h.vcs.edits.length).toBe(0);
  });

  it("commitNow flushes the pending working edit then folds it into ONE commit", async () => {
    h.vcs.files.set(PATH, "AAA\n\nBBB\n\nCCC");
    await h.controller.load(PATH);
    h.editor.userEdit("AAA\n\nB2B\n\nCCC", [{ baseStart: 5, baseEnd: 8, newText: "B2B" }], ["b1"]);
    await flush();
    expect(h.vcs.edits.length).toBe(1); // typing recorded a working edit
    const committed = await h.controller.commitNow("Publish");
    expect(committed?.changed).toBe(true);
    expect(h.vcs.commits.length).toBe(1);
    expect(h.vcs.commits[0]!.message).toBe("Publish");
    expect(h.vcs.commits[0]!.repoPaths).toEqual([VAULT_REPO]);
  });

  it("commitNow waits for an in-flight working edit and then flushes newer text", async () => {
    h.vcs.files.set(PATH, "AAA\n\nBBB\n\nCCC");
    await h.controller.load(PATH);

    const releaseFirstEdit = h.vcs.pauseNextEdit();
    h.editor.userEdit("AAA\n\nB2B\n\nCCC", [{ baseStart: 5, baseEnd: 8, newText: "B2B" }], ["b1"]);
    await flush();

    // A second edit and the explicit Publish flush both arrive while the first
    // `vcs.edit` is still pending. The controller must queue another pass and
    // commit only after that latest pass lands.
    h.editor.userEdit("AAA\n\nB33\n\nCCC", [{ baseStart: 5, baseEnd: 8, newText: "B33" }], ["b1"]);
    const committedPromise = h.controller.commitNow("Publish");
    await flush();
    expect(h.vcs.commits).toHaveLength(0);

    releaseFirstEdit();
    const committed = await committedPromise;
    expect(committed?.changed).toBe(true);
    expect(h.vcs.edits).toHaveLength(2);
    expect(h.vcs.files.get(PATH)).toBe("AAA\n\nB33\n\nCCC");
    expect(h.vcs.commits).toHaveLength(1);
    expect(h.vcs.commits[0]!.message).toBe("Publish");
  });

  it("ignores the echo of its own commit (no reconcile)", async () => {
    h.vcs.files.set(PATH, "AAA\n\nBBB");
    await h.controller.load(PATH);
    h.editor.userEdit("AAA\n\nB2B", [{ baseStart: 5, baseEnd: 8, newText: "B2B" }], ["b1"]);
    await flush();
    const committed = await h.controller.commitNow("Publish");
    const selfHash = committed!.stateHash;
    h.vcs.echo(PATH, selfHash);
    await flush();
    expect(h.editor.applied).toEqual([]); // echo was not treated as a remote edit
  });

  it("suppresses the echo of its own commit even when the advance carries the composed view hash", async () => {
    // Real per-repo VCS: vcs.commit returns the repo log's subtree hash, but the
    // subscribeHead advance carries the composed-context-view hash (for the build
    // trigger). The self-echo guard must correlate on `repoStateHash`, not the
    // divergent `stateHash`, or the panel reconciles its OWN commit as a remote edit.
    h.vcs.files.set(PATH, "AAA\n\nBBB");
    await h.controller.load(PATH);
    h.editor.userEdit("AAA\n\nB2B", [{ baseStart: 5, baseEnd: 8, newText: "B2B" }], ["b1"]);
    const committed = await h.controller.commitNow("publish");
    expect(committed?.changed).toBe(true);
    const repoHash = committed!.stateHash; // identity space of the commit return
    // Advance comes back with a DIFFERENT composed stateHash; repoStateHash matches.
    h.vcs.echoComposed(PATH, repoHash, "state:composed-view-xyz");
    await flush();
    expect(h.editor.applied).toEqual([]); // recognized as our own echo — no reconcile
  });

  it("reconciles a non-colliding remote edit surgically (contained, attributed)", async () => {
    h.vcs.files.set(PATH, "AAA\n\nBBB\n\nCCC");
    await h.controller.load(PATH);
    h.vcs.remoteAdvance(PATH, "AAA\n\nB2B\n\nCCC", { id: "scribe", kind: "agent" });
    await flush();
    expect(h.editor.applied).toEqual([
      { kind: "contained", oldId: "b1", oldIndex: 1, newText: "B2B" },
    ]);
    expect(h.editor.attributions[0]).toMatchObject({ ids: ["b1"], actor: { kind: "agent" } });
    expect(h.collisions).toEqual([]);
  });

  it("applies a coordinator revert delivered as a WORKING advance (historic; not re-attributed)", async () => {
    h.vcs.files.set(PATH, "AAA\n\nBBB\n\nCCC");
    await h.controller.load(PATH);
    // vcs.revert is a WORKING edit now, so its content arrives on the working
    // channel. The coordinator marks the revert's working state historic first.
    h.controller.expectHistoric("state:revert-1");
    h.vcs.workingRevert(PATH, "AAA\n\nB2B\n\nCCC", "state:revert-1");
    await flush();
    expect(h.editor.applied).toEqual([
      { kind: "contained", oldId: "b1", oldIndex: 1, newText: "B2B" },
    ]);
    // Historic: applied but NOT attributed and NOT re-recorded for undo (the
    // coordinator owns it — prevents undo loops).
    expect(h.editor.attributions).toEqual([]);
  });

  it("ignores a non-historic working advance (its own keystroke echo on a single-writer vault)", async () => {
    h.vcs.files.set(PATH, "AAA\n\nBBB\n\nCCC");
    await h.controller.load(PATH);
    // A working advance the controller did NOT expectHistoric — i.e. its own
    // typing echoing back. Must be a no-op (no reconcile, no apply).
    h.vcs.workingRevert(PATH, "AAA\n\nZZZ\n\nCCC", "state:own-edit");
    await flush();
    expect(h.editor.applied).toEqual([]);
  });

  it("routes a remote edit that collides with a live block to SuggestionCards (no apply)", async () => {
    h.vcs.files.set(PATH, "AAA\n\nBBB\n\nCCC");
    await h.controller.load(PATH);
    // User is live in the middle block (b1).
    h.editor.userEdit("AAA\n\nBBB\n\nCCC", [], ["b1"]);
    h.vcs.remoteAdvance(PATH, "AAA\n\nB2B\n\nCCC", { id: "scribe", kind: "agent" });
    await flush();
    expect(h.editor.applied).toEqual([]);
    expect(h.collisions).toHaveLength(1);
    expect(h.collisions[0]!.path).toBe(PATH);
  });
});
