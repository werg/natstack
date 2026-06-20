/**
 * WorkspaceVcs — the server-side orchestration layer over {@link GadVcs}.
 *
 * One instance per server. Owns:
 *  - the main-head working tree (the user's workspace directory),
 *  - context-folder heads (`ctx:{contextId}` forks materialized under
 *    `.contexts/`),
 *  - per-state build-source checkouts (P1 cache: hardlinked from the CAS,
 *    deletable at any time),
 *  - the builds provenance log (`builds:workspace`),
 *  - the `state-advanced` event stream the build trigger subscribes to.
 *
 * Implements buildV2's `WorkspaceStateSource` and the builder's
 * `BuildSourceProvider`.
 */

import { EventEmitter } from "events";
import { serializeByKey } from "@natstack/shared/keyedSerializer";
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";

import { blobPath, getBytes, putBytes } from "../services/blobstoreService.js";

import type {
  BuildRecord,
  StateAdvancedEvent,
  WorkspaceStateSource,
} from "../buildV2/stateTrigger.js";
import type { BuildSourceProvider } from "../buildV2/buildSource.js";
import {
  discoverPackageGraph,
  type GraphNode,
  type PackageGraph,
} from "../buildV2/packageGraph.js";
import {
  GadVcs,
  assertSafeVcsPath,
  assertWritableVcsPath,
  MERGE_CONFLICTS_FILE,
  VCS_LOG_ID,
  VCS_MAIN_HEAD,
  vcsContextHead,
  vcsLogActor,
  type GadCaller,
  type VcsFileEntry,
  type SnapshotResult,
} from "./store.js";
import { MergeEngine, type MergeConflict } from "./merge.js";

const BUILDS_LOG_ID = "builds:workspace";
const SYSTEM_ACTOR = { id: "system", kind: "system" } as const;
const USER_ACTOR = { id: "user", kind: "user" } as const;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface WorkspaceVcsDeps {
  blobsDir: string;
  /** The user's live workspace directory (main head working tree). */
  workspaceRoot: string;
  /** Root for context-folder working trees (`{contextsRoot}/{contextId}`). */
  contextsRoot: string;
  /** Root for per-state build-source checkouts. */
  buildSourcesRoot: string;
}

export interface CommitResult extends SnapshotResult {
  head: string;
  changedPaths: string[];
}

export type VcsFileWriteContent =
  | { kind: "text"; text: string }
  | { kind: "bytes"; base64: string };

export type VcsFileReadContent = { kind: "text"; text: string } | { kind: "bytes"; base64: string };

export interface VcsFileContent {
  content: VcsFileReadContent;
  stateHash: string;
  contentHash: string;
  mode: number;
  size: number;
}

type StateAdvanceEditOp = NonNullable<StateAdvancedEvent["editOps"]>[number];

/**
 * The canonical edit input for `applyEdits` — an op union, not bare hunks, so
 * file create/overwrite/delete/mode aren't smuggled through fake text ranges.
 * `replace` hunks are exact ranges into the base file (offsets in the base
 * content the author saw); callers resolve any fuzzy matching before submitting.
 */
export type EditOp =
  | {
      kind: "replace";
      path: string;
      hunks: Array<{ start: number; end: number; oldText?: string; newText: string }>;
    }
  | { kind: "write"; path: string; content: VcsFileWriteContent; mode?: number }
  | { kind: "create"; path: string; content: VcsFileWriteContent; mode?: number }
  | { kind: "delete"; path: string }
  | { kind: "chmod"; path: string; mode: number };

export interface ApplyEditsResult {
  head: string;
  stateHash: string;
  eventId: string | null;
  headHash: string | null;
  status: "clean" | "conflicted";
  conflicts: MergeConflict[];
  changedPaths: string[];
}

export type HeadAdvanceHook = (event: StateAdvancedEvent) => Promise<void> | void;

interface PreparedSnapshotCandidate {
  head: string;
  previousStateHash: string | null;
  stateHash: string;
  files: VcsFileEntry[];
  fileCount: number;
  event: StateAdvancedEvent;
}

class SnapshotPreparedError extends Error {
  constructor(readonly candidate: PreparedSnapshotCandidate) {
    super("snapshot candidate prepared");
  }
}

class SnapshotApprovalStaleError extends Error {
  constructor(message = "approved snapshot candidate is stale") {
    super(message);
  }
}

const CONFLICT_KIND_HELP: Record<MergeConflict["kind"], string> = {
  content: "text conflict — resolve the `<<<<<<<` / `>>>>>>>` markers in the file",
  binary: "binary conflict — ours was kept; replace it with the intended version",
  "delete-vs-change":
    "deleted on one side, changed on the other — the change was kept; delete the file if the deletion was intended",
  mode: "file mode (executable bit) diverged — verify and `chmod` as intended",
};

/** Human-readable worktree summary of a pending merge's conflicts. */
function renderConflictSummary(
  head: string,
  theirsHead: string | undefined,
  conflicts: MergeConflict[]
): string {
  const lines = [
    `# Merge conflicts on \`${head}\``,
    "",
    theirsHead ? `Merging \`${theirsHead}\` into \`${head}\`.` : "",
    "",
    "Resolve each path below, then commit on this head to complete the merge,",
    "or abort the merge to discard it. This file is auto-generated and is not",
    "itself committed.",
    "",
  ];
  for (const c of conflicts) {
    lines.push(`- **${c.kind}** \`${c.path}\` — ${CONFLICT_KIND_HELP[c.kind]}`);
  }
  lines.push("");
  return lines.join("\n");
}

function bytesFromWriteContent(content: VcsFileWriteContent): Buffer {
  if (content.kind === "text") return Buffer.from(content.text, "utf8");
  if (content.kind === "bytes") {
    const normalized = content.base64.replace(/\s/g, "");
    const bytes = Buffer.from(normalized, "base64");
    if (bytes.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
      throw new Error("bytes content is not valid base64");
    }
    return bytes;
  }
  throw new Error("unknown file content kind");
}

function readContentFromBytes(bytes: Buffer): VcsFileReadContent {
  try {
    const text = UTF8_DECODER.decode(bytes);
    if (!text.includes("\u0000")) return { kind: "text", text };
  } catch {
    // Fall through to binary transport.
  }
  return { kind: "bytes", base64: bytes.toString("base64") };
}

/** Apply exact-range replacement hunks to base content (right-to-left so
 *  earlier offsets stay valid). Verifies `oldText` when supplied. */
function applyReplaceHunks(
  content: string,
  hunks: Array<{ start: number; end: number; oldText?: string; newText: string }>
): string {
  const sorted = [...hunks].sort((a, b) => b.start - a.start);
  let prevStart = content.length + 1;
  let out = content;
  for (const h of sorted) {
    if (h.start < 0 || h.end > content.length || h.start > h.end) {
      throw new Error(`replace hunk out of range [${h.start},${h.end}] (len ${content.length})`);
    }
    if (h.end > prevStart) throw new Error(`overlapping replace hunks at ${h.start}`);
    prevStart = h.start;
    if (h.oldText !== undefined && content.slice(h.start, h.end) !== h.oldText) {
      throw new Error(`replace hunk oldText mismatch at [${h.start},${h.end}]`);
    }
    out = out.slice(0, h.start) + h.newText + out.slice(h.end);
  }
  return out;
}

interface LocalWorkspaceState {
  stateHash: string;
  files: Array<{ path: string; content_hash: string; mode: number }>;
  subtreeHash(path: string): string | null;
}

/**
 * Bootstrap design: the build system must run BEFORE workerd (it builds the
 * gad-store worker itself), so WorkspaceVcs starts in local-first mode —
 * hashing the working tree with the shared worktree-hash implementation
 * (byte-identical to the DO's) and serving build sources from the CAS plus
 * an in-memory file list. `attachGad()` later ingests the pending local
 * state; the state hash is unchanged by construction, so no EV churn and no
 * rebuilds happen at the handover.
 */
export class WorkspaceVcs implements WorkspaceStateSource, BuildSourceProvider {
  readonly vcs: GadVcs;
  private gadCaller: GadCaller | null = null;
  private readonly emitter = new EventEmitter();
  /** Last known state per head — diff basis for changedPaths. */
  private readonly lastState = new Map<string, string>();
  /** Serialize snapshots per directory (concurrent scans of one tree race). */
  private readonly snapshotLocks = new Map<string, Promise<unknown>>();
  private ensureFreshInFlight: Promise<{ stateHash: string }> | null = null;
  /** Local main-head state served while the gad store is unreachable. */
  private localMain: LocalWorkspaceState | null = null;

  constructor(private readonly deps: WorkspaceVcsDeps) {
    this.vcs = new GadVcs({
      blobsDir: deps.blobsDir,
      gad: {
        call: <T>(method: string, input: unknown): Promise<T> => {
          if (!this.gadCaller) {
            return Promise.reject(
              new Error(`gad store not attached yet (call to ${method} during bootstrap)`)
            );
          }
          return this.gadCaller.call<T>(method, input);
        },
      },
    });
  }

  get attached(): boolean {
    return this.gadCaller !== null;
  }

  /**
   * Attach the gad store once workerd is up. Ingests the bootstrap local
   * state (same state hash the local hashing produced — the DO recomputes
   * and agrees), then emits a state advance only if the durable ref actually
   * moved (first boot or out-of-band edits since the last server run).
   */
  async attachGad(gad: GadCaller): Promise<void> {
    this.gadCaller = gad;
    if (this.localMain) {
      this.localMain = null;
      this.lastState.delete(VCS_MAIN_HEAD);
      await this.commitHead(VCS_MAIN_HEAD, {
        summary: "workspace scan (bootstrap ingest)",
        actor: SYSTEM_ACTOR,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Heads / dirs
  // -------------------------------------------------------------------------

  contextDir(contextId: string): string {
    return path.join(this.deps.contextsRoot, contextId);
  }

  private dirForHead(head: string): string {
    if (head === VCS_MAIN_HEAD) return this.deps.workspaceRoot;
    if (head.startsWith("ctx:")) return this.contextDir(head.slice(4));
    throw new Error(`No working tree for head: ${head}`);
  }

  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return serializeByKey(this.snapshotLocks, key, fn);
  }

  // -------------------------------------------------------------------------
  // Commit / scan
  // -------------------------------------------------------------------------

  /**
   * Snapshot a head's working tree. Emits `state-advanced` (with precise
   * changed paths) when the state moved. THE single write path for both
   * explicit commits and scan-on-demand freshness.
   */
  async commitHead(
    head: string,
    opts: {
      summary?: string;
      actor?: { id: string; kind: string };
      beforeAdvance?: HeadAdvanceHook;
    } = {}
  ): Promise<CommitResult> {
    if (opts.beforeAdvance) {
      return this.commitHeadWithUnlockedApproval(head, {
        ...opts,
        beforeAdvance: opts.beforeAdvance,
      });
    }

    return this.locked(head, async () => {
      const dir = this.dirForHead(head);
      const actor = opts.actor ?? USER_ACTOR;
      const prevState = this.lastState.get(head) ?? (await this.vcs.resolveWorktreeRef(head));
      // A pending conflicted merge turns this commit into the merge
      // resolution: record the merge parents and the merge transition kind.
      const pending = this.attached
        ? (
            await this.gad().call<{
              info: {
                theirsStateHash: string;
                provisionalStateHash: string;
                materialized?: boolean;
              } | null;
            }>("getPendingMerge", { logId: VCS_LOG_ID, head })
          ).info
        : null;
      // Recovery invariant: a pending merge whose conflict markers never
      // reached the worktree (crash between setPendingMerge and
      // materializeState) must be re-materialized before this commit —
      // otherwise the pre-merge tree would be recorded as the resolution and
      // the source side's changes silently dropped.
      if (pending && pending.materialized === false) {
        await this.vcs.materializeState(pending.provisionalStateHash, dir);
        await this.gad().call("setPendingMerge", {
          logId: VCS_LOG_ID,
          head,
          info: { ...pending, materialized: true },
        });
      }
      const snap = await this.vcs.snapshotDir(dir, {
        head,
        actor,
        ...(opts.summary ? { summary: opts.summary } : {}),
        ...(pending
          ? {
              force: true,
              parentStateHashes: [pending.theirsStateHash],
              eventKind: "state.merge_applied" as const,
            }
          : {}),
      });
      if (pending) {
        await this.gad().call("clearPendingMerge", { logId: VCS_LOG_ID, head });
        await this.syncConflictSummary(head);
      }
      this.lastState.set(head, snap.stateHash);
      let changedPaths: string[] = [];
      if (!snap.unchanged) {
        const event = await this.stateAdvancedEvent({
          head,
          previousStateHash: prevState,
          stateHash: snap.stateHash,
          eventId: snap.eventId || null,
          headHash: snap.headHash || null,
          actor,
          transitionKind: pending ? "merge-resolution" : "snapshot",
        });
        changedPaths = event.changedPaths;
        this.emitter.emit("state-advanced", event);
      }
      return { ...snap, head, changedPaths };
    });
  }

  private async commitHeadWithUnlockedApproval(
    head: string,
    opts: {
      summary?: string;
      actor?: { id: string; kind: string };
      beforeAdvance: HeadAdvanceHook;
    }
  ): Promise<CommitResult> {
    const actor = opts.actor ?? USER_ACTOR;
    while (true) {
      const prepared = await this.prepareCommitSnapshot(head, opts, actor);
      if (prepared.kind === "committed") return prepared.result;

      await opts.beforeAdvance(prepared.candidate.event);

      try {
        return await this.finalizeApprovedCommitSnapshot(prepared.candidate, opts, actor);
      } catch (error) {
        if (error instanceof SnapshotApprovalStaleError) continue;
        throw error;
      }
    }
  }

  private async prepareCommitSnapshot(
    head: string,
    opts: {
      summary?: string;
      actor?: { id: string; kind: string };
      beforeAdvance: HeadAdvanceHook;
    },
    actor: { id: string; kind: string }
  ): Promise<
    | { kind: "candidate"; candidate: PreparedSnapshotCandidate }
    | { kind: "committed"; result: CommitResult }
  > {
    return this.locked(head, async () => {
      const dir = this.dirForHead(head);
      const pending = await this.preparePendingMergeForCommit(head, dir);
      try {
        const snap = await this.vcs.snapshotDir(dir, {
          head,
          actor,
          ...(opts.summary ? { summary: opts.summary } : {}),
          beforeIngest: async (candidate) => {
            const event = await this.stateAdvancedEvent({
              head,
              previousStateHash: candidate.previousStateHash,
              stateHash: candidate.stateHash,
              eventId: null,
              headHash: null,
              actor,
              transitionKind: pending ? "merge-resolution" : "snapshot",
            });
            throw new SnapshotPreparedError({
              head,
              previousStateHash: candidate.previousStateHash,
              stateHash: candidate.stateHash,
              files: candidate.files,
              fileCount: candidate.fileCount,
              event,
            });
          },
          ...(pending
            ? {
                force: true,
                parentStateHashes: [pending.theirsStateHash],
                eventKind: "state.merge_applied" as const,
              }
            : {}),
        });
        this.lastState.set(head, snap.stateHash);
        return { kind: "committed" as const, result: { ...snap, head, changedPaths: [] } };
      } catch (error) {
        if (error instanceof SnapshotPreparedError) {
          return { kind: "candidate" as const, candidate: error.candidate };
        }
        throw error;
      }
    });
  }

  private async finalizeApprovedCommitSnapshot(
    approved: PreparedSnapshotCandidate,
    opts: {
      summary?: string;
      actor?: { id: string; kind: string };
      beforeAdvance: HeadAdvanceHook;
    },
    actor: { id: string; kind: string }
  ): Promise<CommitResult> {
    return this.locked(approved.head, async () => {
      const dir = this.dirForHead(approved.head);
      const pending = await this.preparePendingMergeForCommit(approved.head, dir);
      let validated = false;
      const snap = await this.vcs.snapshotDir(dir, {
        head: approved.head,
        actor,
        ...(opts.summary ? { summary: opts.summary } : {}),
        beforeIngest: (candidate) => {
          if (
            candidate.previousStateHash !== approved.previousStateHash ||
            candidate.stateHash !== approved.stateHash
          ) {
            throw new SnapshotApprovalStaleError();
          }
          validated = true;
        },
        ...(approved.previousStateHash ? { expectedRefStateHash: approved.previousStateHash } : {}),
        ...(pending
          ? {
              force: true,
              parentStateHashes: [pending.theirsStateHash],
              eventKind: "state.merge_applied" as const,
            }
          : {}),
      });

      if (snap.unchanged) {
        if (snap.stateHash !== approved.stateHash) throw new SnapshotApprovalStaleError();
        this.lastState.set(approved.head, snap.stateHash);
        return { ...snap, head: approved.head, changedPaths: [] };
      }
      if (!validated) throw new SnapshotApprovalStaleError();

      if (pending) {
        await this.gad().call("clearPendingMerge", { logId: VCS_LOG_ID, head: approved.head });
        await this.syncConflictSummary(approved.head);
      }
      this.lastState.set(approved.head, snap.stateHash);
      const event = await this.stateAdvancedEvent({
        head: approved.head,
        previousStateHash: approved.previousStateHash,
        stateHash: snap.stateHash,
        eventId: snap.eventId || null,
        headHash: snap.headHash || null,
        actor,
        transitionKind: pending ? "merge-resolution" : "snapshot",
      });
      this.emitter.emit("state-advanced", event);
      return { ...snap, head: approved.head, changedPaths: event.changedPaths };
    });
  }

  private async preparePendingMergeForCommit(
    head: string,
    dir: string
  ): Promise<{
    theirsStateHash: string;
    provisionalStateHash: string;
    materialized?: boolean;
  } | null> {
    const pending = this.attached
      ? (
          await this.gad().call<{
            info: {
              theirsStateHash: string;
              provisionalStateHash: string;
              materialized?: boolean;
            } | null;
          }>("getPendingMerge", { logId: VCS_LOG_ID, head })
        ).info
      : null;
    if (pending && pending.materialized === false) {
      await this.vcs.materializeState(pending.provisionalStateHash, dir);
      await this.gad().call("setPendingMerge", {
        logId: VCS_LOG_ID,
        head,
        info: { ...pending, materialized: true },
      });
    }
    return pending;
  }

  // -------------------------------------------------------------------------
  // Worktree ingest (FS → GAD)
  //
  // The internal worktree-snapshot primitive: scan a head's working tree and
  // ingest any out-of-band changes onto the head. This is the FS→GAD boundary
  // — needed because `main` IS the real workspace (direct edits, `git push`),
  // and used by bootstrap, merge resolution, and tests. It is NOT exposed over
  // RPC: sandboxed callers commit through `applyEdits` (edit-first), never by
  // snapshotting their context worktree behind GAD's back.
  // -------------------------------------------------------------------------

  /** Snapshot the main workspace worktree onto `main`. */
  commit(
    opts: {
      summary?: string;
      actor?: { id: string; kind: string };
      beforeAdvance?: HeadAdvanceHook;
    } = {}
  ): Promise<CommitResult> {
    return this.commitHead(VCS_MAIN_HEAD, opts);
  }

  /** Snapshot a context folder worktree onto its `ctx:{id}` head. */
  commitContext(
    contextId: string,
    opts: {
      summary?: string;
      actor?: { id: string; kind: string };
      beforeAdvance?: HeadAdvanceHook;
    } = {}
  ): Promise<CommitResult> {
    return this.commitHead(vcsContextHead(contextId), opts);
  }

  // -------------------------------------------------------------------------
  // WorkspaceStateSource (buildV2 trigger)
  // -------------------------------------------------------------------------

  async ensureFresh(): Promise<{ stateHash: string }> {
    if (this.ensureFreshInFlight) return this.ensureFreshInFlight;
    this.ensureFreshInFlight = this.ensureFreshUncoalesced().finally(() => {
      this.ensureFreshInFlight = null;
    });
    return this.ensureFreshInFlight;
  }

  private async ensureFreshUncoalesced(): Promise<{ stateHash: string }> {
    if (!this.attached) {
      // Bootstrap: hash locally (blobs enter the CAS), no DO involved.
      const local = await this.locked(VCS_MAIN_HEAD, () =>
        this.vcs.localState(this.deps.workspaceRoot)
      );
      this.localMain = {
        stateHash: local.stateHash,
        files: local.files.map((file) => ({
          path: file.path,
          content_hash: file.contentHash,
          mode: file.mode,
        })),
        subtreeHash: (p) => local.manifest.subtreeHash(p),
      };
      this.lastState.set(VCS_MAIN_HEAD, local.stateHash);
      return { stateHash: local.stateHash };
    }
    const result = await this.commitHead(VCS_MAIN_HEAD, {
      summary: "workspace scan",
      actor: SYSTEM_ACTOR,
    });
    return { stateHash: result.stateHash };
  }

  async unitHashes(stateHash: string, relPaths: string[]): Promise<Record<string, string | null>> {
    if (relPaths.length === 0) return {};
    const localMain = this.localMain;
    if (!this.attached && localMain && localMain.stateHash === stateHash) {
      return Object.fromEntries(
        relPaths.map((relPath) => [relPath, localMain.subtreeHash(relPath)])
      );
    }
    const result = await this.gad().call<{
      subtreeHashes: Record<string, string | null>;
    }>("getSubtreeHashes", { stateHash, paths: relPaths });
    return result.subtreeHashes;
  }

  async resolveHead(head: string): Promise<string | null> {
    if (!this.attached && head === VCS_MAIN_HEAD) {
      return this.localMain?.stateHash ?? null;
    }
    return await this.vcs.resolveWorktreeRef(head);
  }

  async discoverGraph(stateHash: string): Promise<PackageGraph> {
    const sourceRoot = await this.materializeStateForGraphDiscovery(stateHash);
    return discoverPackageGraph(sourceRoot);
  }

  private gad(): GadCaller {
    if (!this.gadCaller) throw new Error("gad store not attached");
    return this.gadCaller;
  }

  /** Raw store call for satellite modules (git bridge). */
  gadCall<T>(method: string, input: unknown): Promise<T> {
    return this.gad().call<T>(method, input);
  }

  async diffPaths(leftStateHash: string, rightStateHash: string): Promise<string[]> {
    const diff = await this.gad().call<{
      added: Array<{ path: string }>;
      removed: Array<{ path: string }>;
      changed: Array<{ path: string }>;
    }>("diffGadStates", { leftStateHash, rightStateHash });
    return [
      ...diff.added.map((file) => file.path),
      ...diff.removed.map((file) => file.path),
      ...diff.changed.map((file) => file.path),
    ];
  }

  private async diffFileChanges(
    leftStateHash: string | null,
    rightStateHash: string
  ): Promise<StateAdvancedEvent["fileChanges"]> {
    if (!leftStateHash) {
      const files = await this.gad().call<
        Array<{ path: string; content_hash: string; mode: number }>
      >("listStateFiles", { stateHash: rightStateHash });
      return files.map((file) => ({
        kind: "added" as const,
        path: file.path,
        oldContentHash: null,
        newContentHash: file.content_hash,
        oldMode: null,
        newMode: file.mode,
      }));
    }

    const diff = await this.gad().call<{
      added: Array<{ path: string; content_hash: string; mode: number }>;
      removed: Array<{ path: string; content_hash: string; mode: number }>;
      changed: Array<{
        path: string;
        before: { content_hash: string; mode: number };
        after: { content_hash: string; mode: number };
      }>;
    }>("diffGadStates", { leftStateHash, rightStateHash });
    return [
      ...diff.added.map((file) => ({
        kind: "added" as const,
        path: file.path,
        oldContentHash: null,
        newContentHash: file.content_hash,
        oldMode: null,
        newMode: file.mode,
      })),
      ...diff.removed.map((file) => ({
        kind: "removed" as const,
        path: file.path,
        oldContentHash: file.content_hash,
        newContentHash: null,
        oldMode: file.mode,
        newMode: null,
      })),
      ...diff.changed.map((file) => ({
        kind: "changed" as const,
        path: file.path,
        oldContentHash: file.before.content_hash,
        newContentHash: file.after.content_hash,
        oldMode: file.before.mode,
        newMode: file.after.mode,
      })),
    ];
  }

  private async stateAdvancedEvent(input: {
    head: string;
    previousStateHash: string | null;
    stateHash: string;
    eventId: string | null;
    headHash: string | null;
    actor: { id: string; kind: string } | null;
    transitionKind: StateAdvancedEvent["transitionKind"];
    editOps?: StateAdvanceEditOp[];
  }): Promise<StateAdvancedEvent> {
    const fileChanges =
      input.previousStateHash === input.stateHash
        ? []
        : await this.diffFileChanges(input.previousStateHash, input.stateHash);
    return {
      head: input.head,
      stateHash: input.stateHash,
      sinceStateHash: input.previousStateHash,
      eventId: input.eventId,
      headHash: input.headHash,
      actor: input.actor,
      transitionKind: input.transitionKind,
      changedPaths: fileChanges.map((change) => change.path),
      fileChanges,
      editOps: input.editOps ?? [],
    };
  }

  onStateAdvanced(cb: (event: StateAdvancedEvent) => void): () => void {
    this.emitter.on("state-advanced", cb);
    return () => this.emitter.off("state-advanced", cb);
  }

  async recordBuild(record: BuildRecord): Promise<void> {
    if (!this.attached) return; // bootstrap builds re-record after attach if rebuilt
    await this.gad().call("appendLogEvent", {
      logId: BUILDS_LOG_ID,
      head: "main",
      logKind: "builds",
      events: [
        {
          envelopeId: `build:${record.buildKey}:${record.status}`,
          actor: SYSTEM_ACTOR,
          payloadKind: "build.completed",
          payload: {
            protocol: "agentic.trajectory.v1",
            inputStateHash: record.inputStateHash,
            unitName: record.unitName,
            subtree: record.subtree,
            ev: record.ev,
            buildKey: record.buildKey,
            status: record.status,
            ...(record.error ? { error: record.error } : {}),
          },
        },
      ],
    });
  }

  // -------------------------------------------------------------------------
  // BuildSourceProvider (builder)
  // -------------------------------------------------------------------------

  async materializeForBuild(
    units: GraphNode[],
    stateRef: string,
    _workspaceRoot: string
  ): Promise<{ sourceRoot: string }> {
    const stateHash = await this.resolveStateRef(stateRef);
    const dirName = crypto.createHash("sha256").update(stateHash).digest("hex").slice(0, 24);
    const sourceRoot = path.join(this.deps.buildSourcesRoot, dirName);
    const prefixes = units.map((unit) => unit.relativePath);
    await this.locked(`build-src:${dirName}`, async () => {
      if (!this.attached && this.localMain?.stateHash === stateHash) {
        await this.vcs.materializeFileList(this.localMain.files, sourceRoot, prefixes);
        return;
      }
      await this.vcs.materializeSubtrees(stateHash, sourceRoot, prefixes);
    });
    return { sourceRoot };
  }

  private async materializeStateForGraphDiscovery(stateHash: string): Promise<string> {
    const dirName = crypto
      .createHash("sha256")
      .update(`graph:${stateHash}`)
      .digest("hex")
      .slice(0, 24);
    const sourceRoot = path.join(this.deps.buildSourcesRoot, `graph-${dirName}`);
    await this.locked(`build-graph:${dirName}`, async () => {
      if (!this.attached && this.localMain?.stateHash === stateHash) {
        await this.vcs.materializeFileList(this.localMain.files, sourceRoot, []);
        return;
      }
      await this.vcs.materializeState(stateHash, sourceRoot, { clean: true });
    });
    return sourceRoot;
  }

  /** Resolve `state:…` hashes verbatim; head names to their current state. */
  async resolveStateRef(stateRef: string): Promise<string> {
    if (stateRef.startsWith("state:")) return stateRef;
    const resolved = await this.resolveHead(stateRef);
    if (!resolved) throw new Error(`Unknown vcs ref: ${stateRef}`);
    return resolved;
  }

  // -------------------------------------------------------------------------
  // Context folders (GAD branches)
  // -------------------------------------------------------------------------

  /**
   * Ensure a context folder exists: fork `main` → `ctx:{id}` (idempotent)
   * and materialize the fork state into `{contextsRoot}/{contextId}`.
   */
  async ensureContextFolder(contextId: string): Promise<{ dir: string; head: string }> {
    const head = vcsContextHead(contextId);
    const dir = this.contextDir(contextId);
    const fork = await this.vcs.forkContext(contextId);
    if (fork.stateHash) {
      await this.locked(head, () => this.vcs.materializeState(assertHash(fork.stateHash), dir));
      this.lastState.set(head, assertHash(fork.stateHash));
    }
    return { dir, head };
  }

  // -------------------------------------------------------------------------
  // Merge (WS3.P4)
  // -------------------------------------------------------------------------

  /**
   * Merge `sourceHead` into `targetHead`. Clean merges (and fast-forwards)
   * commit `state.merge_applied` on the target head and materialize the
   * result into the target working tree. Conflicted merges materialize a
   * conflict-marked provisional tree and park a pending-merge ref — the next
   * commit on the target head records the merge parents (resolution).
   */
  async mergeHeads(
    targetHead: string,
    sourceHead: string,
    opts: { actor?: { id: string; kind: string }; beforeAdvance?: HeadAdvanceHook } = {}
  ): Promise<{
    status: "up-to-date" | "merged" | "conflicted";
    stateHash: string | null;
    conflicts: MergeConflict[];
  }> {
    if (opts.beforeAdvance) {
      return this.mergeHeadsWithUnlockedApproval(targetHead, sourceHead, {
        actor: opts.actor ?? USER_ACTOR,
        beforeAdvance: opts.beforeAdvance,
      });
    }

    return this.locked(targetHead, async () => {
      const actor = opts.actor ?? USER_ACTOR;
      const logActor = vcsLogActor(actor);
      const pending = (
        await this.gad().call<{ info: unknown | null }>("getPendingMerge", {
          logId: VCS_LOG_ID,
          head: targetHead,
        })
      ).info;
      if (pending) {
        throw new Error(`merge in progress on ${targetHead}: commit the resolution or abortMerge`);
      }

      // Commit any uncommitted work on both sides first — a merge over a
      // dirty tree would silently fold unrelated edits into the merge.
      const targetDir = this.dirForHead(targetHead);
      const preMergeState =
        this.lastState.get(targetHead) ?? (await this.vcs.resolveWorktreeRef(targetHead));
      const oursSnap = await this.vcs.snapshotDir(targetDir, {
        head: targetHead,
        actor,
        summary: `pre-merge snapshot of ${targetHead}`,
      });
      if (!oursSnap.unchanged) {
        this.lastState.set(targetHead, oursSnap.stateHash);
        const event = await this.stateAdvancedEvent({
          head: targetHead,
          previousStateHash: preMergeState,
          stateHash: oursSnap.stateHash,
          eventId: oursSnap.eventId || null,
          headHash: oursSnap.headHash || null,
          actor,
          transitionKind: "snapshot",
        });
        this.emitter.emit("state-advanced", event);
      }
      const theirsState = await this.vcs.resolveWorktreeRef(sourceHead);
      if (!theirsState) throw new Error(`Merge source head has no state: ${sourceHead}`);
      const oursState = oursSnap.stateHash;

      const engine = new MergeEngine({ blobsDir: this.deps.blobsDir, gad: this.gad() });
      const result = await engine.compute(oursState, theirsState, {
        ours: targetHead,
        theirs: sourceHead,
      });

      if (result.status === "up-to-date") {
        return { status: "up-to-date", stateHash: oursState, conflicts: [] };
      }

      if (result.status === "clean" || result.status === "fast-forward") {
        const ingest = await this.gad().call<{
          stateHash: string;
          eventId: string;
          headHash: string;
        }>("ingestWorktreeState", {
          logId: VCS_LOG_ID,
          head: targetHead,
          logKind: "vcs",
          actor: logActor,
          files: result.files,
          baseStateHash: oursState,
          parentStateHashes: [theirsState],
          eventKind: "state.merge_applied",
          summary: `Merge ${sourceHead} into ${targetHead}`,
        });
        this.lastState.set(targetHead, ingest.stateHash);
        await this.vcs.materializeState(ingest.stateHash, targetDir);
        const event = await this.stateAdvancedEvent({
          head: targetHead,
          previousStateHash: oursState,
          stateHash: ingest.stateHash,
          eventId: ingest.eventId,
          headHash: ingest.headHash,
          actor,
          transitionKind: "merge",
        });
        this.emitter.emit("state-advanced", event);
        return { status: "merged", stateHash: ingest.stateHash, conflicts: [] };
      }

      // Conflicted: stage the provisional tree, park the pending merge, and
      // materialize the markers for resolution. The pending merge is recorded
      // with `materialized: false` first and flipped after materializeState
      // succeeds — a crash in between leaves a record that commitHead detects
      // and re-materializes (otherwise the next commit would silently drop
      // the source side: a marker-less worktree recorded as the resolution).
      const staged = await this.gad().call<{ stateHash: string }>("stageWorktreeState", {
        files: result.files,
        summary: `Provisional merge of ${sourceHead} into ${targetHead}`,
      });
      const pendingInfo = {
        oursStateHash: oursState,
        theirsStateHash: theirsState,
        baseStateHash: result.baseStateHash,
        theirsHead: sourceHead,
        conflicts: result.conflicts,
        provisionalStateHash: staged.stateHash,
      };
      await this.gad().call("setPendingMerge", {
        logId: VCS_LOG_ID,
        head: targetHead,
        info: { ...pendingInfo, materialized: false },
      });
      await this.vcs.materializeState(staged.stateHash, targetDir);
      await this.gad().call("setPendingMerge", {
        logId: VCS_LOG_ID,
        head: targetHead,
        info: { ...pendingInfo, materialized: true },
      });
      await this.syncConflictSummary(targetHead);
      return { status: "conflicted", stateHash: staged.stateHash, conflicts: result.conflicts };
    });
  }

  private async mergeHeadsWithUnlockedApproval(
    targetHead: string,
    sourceHead: string,
    opts: { actor: { id: string; kind: string }; beforeAdvance: HeadAdvanceHook }
  ): Promise<{
    status: "up-to-date" | "merged" | "conflicted";
    stateHash: string | null;
    conflicts: MergeConflict[];
  }> {
    const actor = opts.actor;
    const logActor = vcsLogActor(actor);
    while (true) {
      await this.assertNoPendingMerge(targetHead);
      await this.commitHead(targetHead, {
        actor,
        summary: `pre-merge snapshot of ${targetHead}`,
        beforeAdvance: opts.beforeAdvance,
      });

      const prepared = await this.prepareMergeAdvance(targetHead, sourceHead, actor);
      if (prepared.kind === "done") return prepared.result;
      if (prepared.kind === "retry") continue;

      await opts.beforeAdvance(prepared.event);

      try {
        return await this.finalizeApprovedMerge(prepared, logActor, actor);
      } catch (error) {
        if (error instanceof SnapshotApprovalStaleError) continue;
        throw error;
      }
    }
  }

  private async assertNoPendingMerge(targetHead: string): Promise<void> {
    await this.locked(targetHead, async () => {
      const pending = (
        await this.gad().call<{ info: unknown | null }>("getPendingMerge", {
          logId: VCS_LOG_ID,
          head: targetHead,
        })
      ).info;
      if (pending) {
        throw new Error(`merge in progress on ${targetHead}: commit the resolution or abortMerge`);
      }
    });
  }

  private async prepareMergeAdvance(
    targetHead: string,
    sourceHead: string,
    actor: { id: string; kind: string }
  ): Promise<
    | {
        kind: "candidate";
        targetHead: string;
        sourceHead: string;
        targetDir: string;
        oursState: string;
        theirsState: string;
        files: Array<{ path: string; contentHash: string; mode: number }>;
        event: StateAdvancedEvent;
        conflicts: MergeConflict[];
        baseStateHash: string | null;
        provisionalStateHash: string;
      }
    | {
        kind: "done";
        result: {
          status: "up-to-date" | "merged" | "conflicted";
          stateHash: string | null;
          conflicts: MergeConflict[];
        };
      }
    | { kind: "retry" }
  > {
    return this.locked(targetHead, async () => {
      const pending = (
        await this.gad().call<{ info: unknown | null }>("getPendingMerge", {
          logId: VCS_LOG_ID,
          head: targetHead,
        })
      ).info;
      if (pending) {
        throw new Error(`merge in progress on ${targetHead}: commit the resolution or abortMerge`);
      }

      const targetDir = this.dirForHead(targetHead);
      try {
        const verification = await this.vcs.snapshotDir(targetDir, {
          head: targetHead,
          actor,
          summary: `pre-merge snapshot of ${targetHead}`,
          beforeIngest: () => {
            throw new SnapshotApprovalStaleError("target changed before merge approval");
          },
        });
        if (!verification.unchanged) return { kind: "retry" as const };
      } catch (error) {
        if (error instanceof SnapshotApprovalStaleError) return { kind: "retry" as const };
        throw error;
      }

      const theirsState = await this.vcs.resolveWorktreeRef(sourceHead);
      if (!theirsState) throw new Error(`Merge source head has no state: ${sourceHead}`);
      const oursState = await this.vcs.resolveWorktreeRef(targetHead);
      if (!oursState) throw new Error(`Merge target head has no state: ${targetHead}`);

      const engine = new MergeEngine({ blobsDir: this.deps.blobsDir, gad: this.gad() });
      const result = await engine.compute(oursState, theirsState, {
        ours: targetHead,
        theirs: sourceHead,
      });

      if (result.status === "up-to-date") {
        return {
          kind: "done" as const,
          result: { status: "up-to-date" as const, stateHash: oursState, conflicts: [] },
        };
      }

      if (result.status === "clean" || result.status === "fast-forward") {
        const staged = await this.gad().call<{ stateHash: string }>("stageWorktreeState", {
          files: result.files,
          summary: `Candidate merge of ${sourceHead} into ${targetHead}`,
        });
        const event = await this.stateAdvancedEvent({
          head: targetHead,
          previousStateHash: oursState,
          stateHash: staged.stateHash,
          eventId: null,
          headHash: null,
          actor,
          transitionKind: "merge",
        });
        return {
          kind: "candidate" as const,
          targetHead,
          sourceHead,
          targetDir,
          oursState,
          theirsState,
          files: result.files,
          event,
          conflicts: [],
          baseStateHash: result.baseStateHash,
          provisionalStateHash: staged.stateHash,
        };
      }

      // Conflicted: stage the provisional tree now, but DEFER parking the
      // pending merge + materializing markers onto the target worktree until
      // AFTER the approval gate runs (finalizeApprovedMerge). Otherwise an
      // unapproved caller could write conflict markers onto e.g. the main
      // worktree without the main-advance approval ever firing.
      const staged = await this.gad().call<{ stateHash: string }>("stageWorktreeState", {
        files: result.files,
        summary: `Provisional merge of ${sourceHead} into ${targetHead}`,
      });
      const event = await this.stateAdvancedEvent({
        head: targetHead,
        previousStateHash: oursState,
        stateHash: staged.stateHash,
        eventId: null,
        headHash: null,
        actor,
        transitionKind: "merge",
      });
      return {
        kind: "candidate" as const,
        targetHead,
        sourceHead,
        targetDir,
        oursState,
        theirsState,
        files: result.files,
        event,
        conflicts: result.conflicts,
        baseStateHash: result.baseStateHash,
        provisionalStateHash: staged.stateHash,
      };
    });
  }

  private async finalizeApprovedMerge(
    prepared: {
      kind: "candidate";
      targetHead: string;
      sourceHead: string;
      targetDir: string;
      oursState: string;
      theirsState: string;
      files: Array<{ path: string; contentHash: string; mode: number }>;
      event: StateAdvancedEvent;
      conflicts: MergeConflict[];
      baseStateHash: string | null;
      provisionalStateHash: string;
    },
    logActor: ReturnType<typeof vcsLogActor>,
    actor: { id: string; kind: string }
  ): Promise<{ status: "merged" | "conflicted"; stateHash: string; conflicts: MergeConflict[] }> {
    return this.locked(prepared.targetHead, async () => {
      const pending = (
        await this.gad().call<{ info: unknown | null }>("getPendingMerge", {
          logId: VCS_LOG_ID,
          head: prepared.targetHead,
        })
      ).info;
      if (pending) {
        throw new Error(
          `merge in progress on ${prepared.targetHead}: commit the resolution or abortMerge`
        );
      }
      const currentTarget = await this.vcs.resolveWorktreeRef(prepared.targetHead);
      const currentSource = await this.vcs.resolveWorktreeRef(prepared.sourceHead);
      if (currentTarget !== prepared.oursState || currentSource !== prepared.theirsState) {
        throw new SnapshotApprovalStaleError();
      }

      // Approved conflicted merge: NOW park the pending merge + materialize the
      // provisional (marker) tree onto the target. The head ref is not advanced;
      // the resolution commit completes it. This runs only after beforeAdvance.
      if (prepared.conflicts.length > 0) {
        const pendingInfo = {
          oursStateHash: prepared.oursState,
          theirsStateHash: prepared.theirsState,
          baseStateHash: prepared.baseStateHash,
          theirsHead: prepared.sourceHead,
          conflicts: prepared.conflicts,
          provisionalStateHash: prepared.provisionalStateHash,
        };
        await this.gad().call("setPendingMerge", {
          logId: VCS_LOG_ID,
          head: prepared.targetHead,
          info: { ...pendingInfo, materialized: false },
        });
        await this.vcs.materializeState(prepared.provisionalStateHash, prepared.targetDir);
        await this.gad().call("setPendingMerge", {
          logId: VCS_LOG_ID,
          head: prepared.targetHead,
          info: { ...pendingInfo, materialized: true },
        });
        await this.syncConflictSummary(prepared.targetHead);
        return {
          status: "conflicted" as const,
          stateHash: prepared.provisionalStateHash,
          conflicts: prepared.conflicts,
        };
      }

      const ingest = await this.gad().call<{
        stateHash: string;
        eventId: string;
        headHash: string;
      }>("ingestWorktreeState", {
        logId: VCS_LOG_ID,
        head: prepared.targetHead,
        logKind: "vcs",
        actor: logActor,
        files: prepared.files,
        baseStateHash: prepared.oursState,
        expectedRefStateHash: prepared.oursState,
        parentStateHashes: [prepared.theirsState],
        eventKind: "state.merge_applied",
        summary: `Merge ${prepared.sourceHead} into ${prepared.targetHead}`,
      });
      this.lastState.set(prepared.targetHead, ingest.stateHash);
      await this.vcs.materializeState(ingest.stateHash, prepared.targetDir);
      const event = await this.stateAdvancedEvent({
        head: prepared.targetHead,
        previousStateHash: prepared.oursState,
        stateHash: ingest.stateHash,
        eventId: ingest.eventId,
        headHash: ingest.headHash,
        actor,
        transitionKind: "merge",
      });
      this.emitter.emit("state-advanced", event);
      return { status: "merged", stateHash: ingest.stateHash, conflicts: [] };
    });
  }

  /** Abandon a pending conflicted merge: restore the pre-merge tree. */
  /**
   * Write or remove the worktree merge-conflict summary for a head, driven off
   * its pending-merge record. Non-content conflicts (mode / binary /
   * delete-vs-change) leave no in-file `<<<<<<<` markers, so this file is the
   * only worktree-visible signal for CLI/agent/direct users. It is ignored by
   * snapshots (never committed) and removed when the merge resolves or aborts.
   */
  private async syncConflictSummary(head: string): Promise<void> {
    const file = path.join(this.dirForHead(head), MERGE_CONFLICTS_FILE);
    const pending = this.attached
      ? (
          await this.gad().call<{
            info: { conflicts?: MergeConflict[]; theirsHead?: string } | null;
          }>("getPendingMerge", { logId: VCS_LOG_ID, head })
        ).info
      : null;
    const conflicts = pending?.conflicts ?? [];
    if (pending && conflicts.length > 0) {
      await fsp.writeFile(file, renderConflictSummary(head, pending.theirsHead, conflicts), "utf8");
    } else {
      await fsp.rm(file, { force: true });
    }
  }

  async abortMerge(
    targetHead: string,
    opts: { actor?: { id: string; kind: string }; beforeAdvance?: HeadAdvanceHook } = {}
  ): Promise<{ aborted: boolean }> {
    return this.locked(targetHead, async () => {
      const pending = (
        await this.gad().call<{
          info: { oursStateHash: string; provisionalStateHash: string } | null;
        }>("getPendingMerge", {
          logId: VCS_LOG_ID,
          head: targetHead,
        })
      ).info;
      if (!pending) return { aborted: false };
      if (opts.beforeAdvance && pending.provisionalStateHash !== pending.oursStateHash) {
        const event = await this.stateAdvancedEvent({
          head: targetHead,
          previousStateHash: pending.provisionalStateHash,
          stateHash: pending.oursStateHash,
          eventId: null,
          headHash: null,
          actor: opts.actor ?? USER_ACTOR,
          transitionKind: "merge-resolution",
        });
        await opts.beforeAdvance(event);
      }
      await this.gad().call("clearPendingMerge", { logId: VCS_LOG_ID, head: targetHead });
      await this.vcs.materializeState(pending.oursStateHash, this.dirForHead(targetHead));
      await this.syncConflictSummary(targetHead);
      this.lastState.set(targetHead, pending.oursStateHash);
      return { aborted: true };
    });
  }

  async pendingMerge(targetHead: string): Promise<{
    theirsHead: string;
    conflicts: Array<{ path: string; kind: string }>;
  } | null> {
    const pending = (
      await this.gad().call<{
        info: { theirsHead: string; conflicts: Array<{ path: string; kind: string }> } | null;
      }>("getPendingMerge", { logId: VCS_LOG_ID, head: targetHead })
    ).info;
    return pending ? { theirsHead: pending.theirsHead, conflicts: pending.conflicts } : null;
  }

  // -------------------------------------------------------------------------
  // Edit-first commit (co-editing)
  // -------------------------------------------------------------------------

  /**
   * Apply replacement ops onto `baseStateHash` (siblings inherited from base,
   * untouched) and advance `head`. Fast-forwards when head == base; otherwise
   * 3-way merges the authored draft against the advanced head via the
   * explicit-base merge engine (no DAG lookup — the base is known). Materializes
   * the resulting head state into its working tree, so disk is a projection of
   * head, not a writer.
   *
   * THE edit-first write path for both the user (panel) and agent tools. The
   * caller-facing service supplies `actor` from the verified caller runtime —
   * never trusted from clients.
   */
  async applyEdits(input: {
    head: string;
    baseStateHash: string;
    edits: EditOp[];
    actor: { id: string; kind: string };
    beforeAdvance?: HeadAdvanceHook;
  }): Promise<ApplyEditsResult> {
    return this.locked(input.head, async () => {
      const existingPending = (
        await this.gad().call<{ info: unknown | null }>("getPendingMerge", {
          logId: VCS_LOG_ID,
          head: input.head,
        })
      ).info;
      if (existingPending) {
        throw new Error(`merge in progress on ${input.head}: commit the resolution or abortMerge`);
      }

      // 1. Full file map from the base state — siblings preserved by construction.
      const baseFiles = await this.gad().call<
        Array<{ path: string; content_hash: string; mode: number }>
      >("listStateFiles", { stateHash: input.baseStateHash });
      const files = new Map(
        baseFiles.map((f) => [f.path, { path: f.path, contentHash: f.content_hash, mode: f.mode }])
      );

      // 2. Apply ops → the authored "mine" file set.
      for (const op of input.edits) {
        // Reject worktree-escaping paths before they enter GAD state. The only
        // client-side guard (harness toVcsPath) is bypassable by calling
        // vcs.applyEdits directly, so this server-boundary check is authoritative.
        assertSafeVcsPath(op.path);
        // A create/write must not introduce a path the snapshot scan excludes
        // (VCS internals / secrets / generated dirs) — otherwise it would write
        // e.g. `.git/hooks/*` or `.env` to disk and vanish on the next scan.
        if (op.kind === "create" || op.kind === "write") {
          await assertWritableVcsPath(op.path);
        }
        if (op.kind === "delete") {
          if (!files.delete(op.path)) throw new Error(`delete: no such path ${op.path}`);
          continue;
        }
        if (op.kind === "chmod") {
          const cur = files.get(op.path);
          if (!cur) throw new Error(`chmod: no such path ${op.path}`);
          files.set(op.path, { ...cur, mode: op.mode });
          continue;
        }
        if (op.kind === "create" || op.kind === "write") {
          if (op.kind === "create" && files.has(op.path)) {
            throw new Error(`create: path already exists ${op.path}`);
          }
          const { digest } = await putBytes(this.deps.blobsDir, bytesFromWriteContent(op.content));
          files.set(op.path, {
            path: op.path,
            contentHash: digest,
            mode: op.mode ?? files.get(op.path)?.mode ?? 33188,
          });
          continue;
        }
        // replace
        const cur = files.get(op.path);
        if (!cur) throw new Error(`replace: no such path ${op.path}`);
        const baseBytes = await getBytes(this.deps.blobsDir, cur.contentHash);
        if (!baseBytes) throw new Error(`replace: base blob missing for ${op.path}`);
        const baseContent = readContentFromBytes(baseBytes);
        if (baseContent.kind !== "text") {
          throw new Error(`replace: cannot apply text hunks to binary file ${op.path}`);
        }
        const nextText = applyReplaceHunks(baseContent.text, op.hunks);
        const { digest } = await putBytes(this.deps.blobsDir, Buffer.from(nextText, "utf8"));
        files.set(op.path, { ...cur, contentHash: digest });
      }
      const mineFiles = [...files.values()];

      // Provenance: the authored op union (recorded against the transition).
      const baseByPath = new Map(baseFiles.map((f) => [f.path, f.content_hash]));
      const editOps = input.edits.map((op) => ({
        kind: op.kind,
        path: op.path,
        oldContentHash: baseByPath.get(op.path) ?? null,
        newContentHash: op.kind === "delete" ? null : (files.get(op.path)?.contentHash ?? null),
        hunks: op.kind === "replace" ? op.hunks : undefined,
        mode: "mode" in op ? op.mode : undefined,
      }));

      // 3. Where is head now? (authoritative ref read for CAS).
      const headState = (await this.vcs.resolveWorktreeRef(input.head)) ?? input.baseStateHash;
      const dir = this.dirForHead(input.head);
      const actor = input.actor;
      const logActor = vcsLogActor(actor);

      let finalState: string;
      let finalEventId: string | null = null;
      let finalHeadHash: string | null = null;
      let status: "clean" | "conflicted" = "clean";
      let conflicts: MergeConflict[] = [];

      if (headState === input.baseStateHash) {
        // Fast-forward — no one advanced head since the author's base.
        if (input.beforeAdvance) {
          const staged = await this.gad().call<{ stateHash: string }>("stageWorktreeState", {
            files: mineFiles,
            summary: `Candidate edit by ${actor.kind}:${actor.id} on ${input.head}`,
          });
          const event = await this.stateAdvancedEvent({
            head: input.head,
            previousStateHash: input.baseStateHash,
            stateHash: staged.stateHash,
            eventId: null,
            headHash: null,
            actor,
            transitionKind: "edit",
            editOps,
          });
          await input.beforeAdvance(event);
        }
        const ingest = await this.gad().call<{
          stateHash: string;
          eventId: string;
          headHash: string;
        }>("ingestWorktreeState", {
          logId: VCS_LOG_ID,
          head: input.head,
          logKind: "vcs",
          actor: logActor,
          files: mineFiles,
          baseStateHash: input.baseStateHash,
          expectedRefStateHash: input.baseStateHash,
          eventKind: "state.snapshot_ingested",
          editOps,
        });
        finalState = ingest.stateHash;
        finalEventId = ingest.eventId;
        finalHeadHash = ingest.headHash;
      } else {
        // Stale: stage the authored draft and 3-way merge it into head.
        const draftEventId = crypto.randomUUID();
        const mine = await this.gad().call<{ stateHash: string; eventId: string | null }>(
          "stageWorktreeState",
          {
            files: mineFiles,
            baseStateHash: input.baseStateHash,
            summary: `draft by ${actor.kind}:${actor.id} on ${input.head}`,
            transition: {
              logId: VCS_LOG_ID,
              head: `draft:${input.head}:${draftEventId}`,
              logKind: "vcs",
              actor: logActor,
              eventId: draftEventId,
              metadata: { sourceHead: input.head, kind: "authored-draft" },
            },
          }
        );
        const engine = new MergeEngine({ blobsDir: this.deps.blobsDir, gad: this.gad() });
        const result = await engine.compute3(
          { base: input.baseStateHash, ours: mine.stateHash, theirs: headState },
          { ours: `${actor.kind}:${actor.id}`, theirs: input.head }
        );
        if (result.status === "up-to-date") {
          finalState = headState;
        } else if (result.status === "clean" || result.status === "fast-forward") {
          if (input.beforeAdvance) {
            const staged = await this.gad().call<{ stateHash: string }>("stageWorktreeState", {
              files: result.files,
              summary: `Candidate merge of draft into ${input.head}`,
            });
            const event = await this.stateAdvancedEvent({
              head: input.head,
              previousStateHash: headState,
              stateHash: staged.stateHash,
              eventId: null,
              headHash: null,
              actor,
              transitionKind: "edit",
              editOps,
            });
            await input.beforeAdvance(event);
          }
          const ingest = await this.gad().call<{
            stateHash: string;
            eventId: string;
            headHash: string;
          }>("ingestWorktreeState", {
            logId: VCS_LOG_ID,
            head: input.head,
            logKind: "vcs",
            actor: logActor,
            files: result.files,
            baseStateHash: headState,
            expectedRefStateHash: headState,
            // Head is the implicit first parent (the ref advance); record the
            // authored draft as the second so ancestry reads "authored from
            // base, merged into head".
            parentStateHashes: [mine.stateHash],
            eventKind: "state.merge_applied",
            editOps,
          });
          finalState = ingest.stateHash;
          finalEventId = ingest.eventId;
          finalHeadHash = ingest.headHash;
        } else {
          // Conflicted: park a pending merge + materialize the marked tree
          // (mirrors mergeHeads; resolved by a later commit on this head).
          status = "conflicted";
          conflicts = result.conflicts;
          const provisional = await this.gad().call<{ stateHash: string }>("stageWorktreeState", {
            files: result.files,
            summary: `Provisional merge of draft into ${input.head}`,
          });
          const pendingInfo = {
            oursStateHash: headState,
            theirsStateHash: mine.stateHash,
            baseStateHash: result.baseStateHash,
            theirsHead: input.head,
            conflicts: result.conflicts,
            provisionalStateHash: provisional.stateHash,
          };
          await this.gad().call("setPendingMerge", {
            logId: VCS_LOG_ID,
            head: input.head,
            info: { ...pendingInfo, materialized: false },
          });
          await this.vcs.materializeState(provisional.stateHash, dir);
          await this.gad().call("setPendingMerge", {
            logId: VCS_LOG_ID,
            head: input.head,
            info: { ...pendingInfo, materialized: true },
          });
          await this.syncConflictSummary(input.head);
          return {
            head: input.head,
            stateHash: provisional.stateHash,
            eventId: null,
            headHash: null,
            status,
            conflicts,
            changedPaths: await this.diffPaths(headState, provisional.stateHash),
          };
        }
      }

      // Materialize the new head state into its working tree (projection).
      await this.vcs.materializeState(finalState, dir);
      this.lastState.set(input.head, finalState);
      const changedPaths =
        finalState === headState ? [] : await this.diffPaths(headState, finalState);
      if (finalState !== headState) {
        const event = await this.stateAdvancedEvent({
          head: input.head,
          previousStateHash: headState,
          stateHash: finalState,
          eventId: finalEventId,
          headHash: finalHeadHash,
          actor,
          transitionKind: "edit",
          editOps,
        });
        this.emitter.emit("state-advanced", event);
      }
      return {
        head: input.head,
        stateHash: finalState,
        eventId: finalEventId,
        headHash: finalHeadHash,
        status,
        conflicts,
        changedPaths,
      };
    });
  }

  /**
   * Content read at a ref (head name or `state:` hash). Returns the file
   * bytes/text PLUS the resolved `stateHash` the caller should pin as the base
   * for a subsequent `applyEdits` (CAS). Distinct from the store's
   * `readGadFileAtState`, which returns metadata only.
   */
  async readFile(ref: string, filePath: string): Promise<VcsFileContent | null> {
    const stateHash = await this.resolveStateRef(ref);
    const meta = await this.gad().call<{
      content_hash: string;
      mode: number;
    } | null>("readGadFileAtState", { stateHash, path: filePath });
    if (!meta) return null;
    const bytes = await getBytes(this.deps.blobsDir, meta.content_hash);
    if (!bytes) throw new Error(`readFile: blob missing from CAS: ${meta.content_hash}`);
    return {
      content: readContentFromBytes(bytes),
      stateHash,
      contentHash: meta.content_hash,
      mode: meta.mode,
      size: bytes.length,
    };
  }

  /**
   * List every file path (+ content hash, mode) at a ref (head name or
   * `state:` hash). The path index, wikilink resolution, and file tree read
   * from GAD through this — never an `fs` walk of the working tree.
   */
  async listFiles(
    ref: string
  ): Promise<Array<{ path: string; contentHash: string; mode: number }>> {
    const stateHash = await this.resolveStateRef(ref);
    const files = await this.gad().call<
      Array<{ path: string; content_hash: string; mode: number }>
    >("listStateFiles", { stateHash });
    return files.map((f) => ({ path: f.path, contentHash: f.content_hash, mode: f.mode }));
  }

  /** Read a CAS blob as edit-op write content (text when valid UTF-8, else bytes). */
  private async blobAsWriteContent(contentHash: string): Promise<VcsFileWriteContent> {
    const bytes = await getBytes(this.deps.blobsDir, contentHash);
    if (!bytes) throw new Error(`revert: blob missing from CAS: ${contentHash}`);
    // VcsFileReadContent and VcsFileWriteContent are the same shape.
    return readContentFromBytes(bytes);
  }

  /** Resolve the `outputStateHash` of the transition to revert (by the state
   *  it produced, or by event id via the head's log). */
  private async resolveRevertTarget(
    head: string,
    target: { stateHash?: string; eventId?: string }
  ): Promise<string> {
    if (target.stateHash) return target.stateHash;
    if (target.eventId) {
      const events = await this.gad().call<
        Array<{ envelopeId: string; payload: Record<string, unknown> }>
      >("readLog", { logId: VCS_LOG_ID, head, limit: 0 });
      const match = events.find((event) => event.envelopeId === target.eventId);
      const output = match?.payload?.["outputStateHash"];
      if (typeof output !== "string") {
        throw new Error(`revert: event ${target.eventId} produced no output state on ${head}`);
      }
      return output;
    }
    throw new Error("revert: target requires a stateHash or eventId");
  }

  /**
   * Revert a transition by computing its **inverse patch** (the pre-transition
   * content of every path it touched) and applying it **forward** onto the
   * current head via {@link applyEdits} — a `git revert`, never a `git reset`
   * (the head ref only ever moves forward). The transition is identified by the
   * state it produced (`stateHash` = its `outputStateHash`) or by `eventId`.
   *
   * Because the inverse is staged off the transition's *after* state and 3-way
   * merged into the live head, later non-overlapping edits are preserved and an
   * overlap with current content surfaces as an ordinary merge conflict — never
   * a silent clobber. Unifies "revert my edit" and "revert the scribe's edit"
   * (decision 8 / the editor's GAD-history undo).
   */
  async revert(input: {
    head: string;
    target: { stateHash?: string; eventId?: string };
    actor: { id: string; kind: string };
    beforeAdvance?: HeadAdvanceHook;
  }): Promise<ApplyEditsResult> {
    const afterStateHash = await this.resolveRevertTarget(input.head, input.target);
    const producer = await this.gad().call<{ input_state_hash?: string } | null>(
      "getGadStateProducer",
      { stateHash: afterStateHash }
    );
    const beforeStateHash = producer?.input_state_hash;
    if (!beforeStateHash) {
      throw new Error(`revert: no transition produced ${afterStateHash} (cannot invert)`);
    }
    const diff = await this.gad().call<{
      added: Array<{ path: string }>;
      removed: Array<{ path: string; content_hash: string; mode: number }>;
      changed: Array<{ path: string; before: { content_hash: string; mode: number } }>;
    }>("diffGadStates", { leftStateHash: beforeStateHash, rightStateHash: afterStateHash });

    const edits: EditOp[] = [];
    // It ADDED these paths → the inverse deletes them.
    for (const file of diff.added) edits.push({ kind: "delete", path: file.path });
    // It DELETED these → the inverse recreates them with pre-transition content.
    for (const file of diff.removed) {
      edits.push({
        kind: "create",
        path: file.path,
        content: await this.blobAsWriteContent(file.content_hash),
        mode: file.mode,
      });
    }
    // It CHANGED these → the inverse restores the pre-transition content.
    for (const file of diff.changed) {
      edits.push({
        kind: "write",
        path: file.path,
        content: await this.blobAsWriteContent(file.before.content_hash),
        mode: file.before.mode,
      });
    }

    if (edits.length === 0) {
      const headState = (await this.resolveHead(input.head)) ?? afterStateHash;
      return {
        head: input.head,
        stateHash: headState,
        eventId: null,
        headHash: null,
        status: "clean",
        conflicts: [],
        changedPaths: [],
      };
    }
    return this.applyEdits({
      head: input.head,
      baseStateHash: afterStateHash,
      edits,
      actor: input.actor,
      beforeAdvance: input.beforeAdvance,
    });
  }

  /**
   * GAD state-diff of `head` against its publish baseline (`main`): the
   * unpublished changes on this head. Pure CAS computation — there is NO
   * worktree scan, because the on-disk tree is a disposable projection of the
   * head (edits commit through `applyEdits`, which keeps disk and head in
   * lockstep). `head` equal to the baseline — or `main` against itself — yields
   * no changes. This is the single diff both {@link statusHead} and
   * {@link publishStatus} are built on. `added`/`removed` are oriented from the
   * baseline's perspective: a file present on `head` but not on `main` is
   * "added", the change a publish would apply.
   */
  private async unpublishedDelta(
    head: string,
    mainHead: string = VCS_MAIN_HEAD
  ): Promise<{
    headStateHash: string | null;
    baseStateHash: string | null;
    added: string[];
    removed: string[];
    changed: string[];
  }> {
    const headStateHash = await this.resolveHead(head);
    const baseStateHash = await this.resolveHead(mainHead);
    if (!headStateHash || !baseStateHash || headStateHash === baseStateHash) {
      return { headStateHash, baseStateHash, added: [], removed: [], changed: [] };
    }
    const diff = await this.gad().call<{
      added: Array<{ path: string }>;
      removed: Array<{ path: string }>;
      changed: Array<{ path: string }>;
    }>("diffGadStates", { leftStateHash: baseStateHash, rightStateHash: headStateHash });
    return {
      headStateHash,
      baseStateHash,
      added: diff.added.map((file) => file.path),
      removed: diff.removed.map((file) => file.path),
      changed: diff.changed.map((file) => file.path),
    };
  }

  /**
   * Publish status for a context head: how far it is **ahead of `main`**
   * (the unpublished changes). The signal the editor's "● N unpublished
   * changes" indicator and Publish action are built on. Same underlying diff
   * as {@link statusHead}, shaped for the publish UI (ahead count + both
   * state hashes).
   */
  async publishStatus(
    head: string,
    mainHead: string = VCS_MAIN_HEAD
  ): Promise<{
    head: string;
    ctxStateHash: string | null;
    mainStateHash: string | null;
    ahead: number;
    files: Array<{ path: string; kind: "added" | "removed" | "changed" }>;
  }> {
    const delta = await this.unpublishedDelta(head, mainHead);
    const files = [
      ...delta.added.map((path) => ({ path, kind: "added" as const })),
      ...delta.removed.map((path) => ({ path, kind: "removed" as const })),
      ...delta.changed.map((path) => ({ path, kind: "changed" as const })),
    ];
    return {
      head,
      ctxStateHash: delta.headStateHash,
      mainStateHash: delta.baseStateHash,
      ahead: files.length,
      files,
    };
  }

  // -------------------------------------------------------------------------
  // Memory file indexing (WS4) — bytes live in the CAS, so the server feeds
  // changed file text to the store's FTS index after main-head advances.
  // -------------------------------------------------------------------------

  private memoryIndexQueue: Promise<void> = Promise.resolve();

  /** Start incremental file indexing on main-head advances. Idempotent per
   *  state via the `memidx:main` marker (rebuilt after cache amnesia). */
  enableMemoryIndexing(): void {
    this.onStateAdvanced((event) => {
      if (event.head !== VCS_MAIN_HEAD) return;
      this.memoryIndexQueue = this.memoryIndexQueue
        .then(() => this.indexMainFiles(event.stateHash))
        .catch((error) => console.warn("[VcsMemory] index failed:", error));
    });
    // Catch up on whatever happened while the server was down.
    this.memoryIndexQueue = this.memoryIndexQueue
      .then(async () => {
        const current = await this.resolveHead(VCS_MAIN_HEAD);
        if (current) await this.indexMainFiles(current);
      })
      .catch((error) => console.warn("[VcsMemory] initial index failed:", error));
  }

  async indexMainFiles(stateHash: string): Promise<void> {
    if (!this.attached) return;
    const marker = (
      await this.gad().call<{ value: string | null }>("getMemoryIndexMarker", { key: "main" })
    ).value;
    if (marker === stateHash) return;

    const MAX_INDEXED_FILE_BYTES = 256 * 1024;
    const files: Array<{ path: string; contentHash: string; text: string }> = [];
    let removedPaths: string[] = [];
    const wanted: Array<{ path: string; content_hash: string }> = [];
    if (marker) {
      const diff = await this.gad().call<{
        added: Array<{ path: string; content_hash: string }>;
        removed: Array<{ path: string }>;
        changed: Array<{ path: string; after: { path: string; content_hash: string } }>;
      }>("diffGadStates", { leftStateHash: marker, rightStateHash: stateHash });
      wanted.push(...diff.added, ...diff.changed.map((entry) => entry.after));
      removedPaths = diff.removed.map((file) => file.path);
    } else {
      wanted.push(
        ...(await this.gad().call<Array<{ path: string; content_hash: string }>>("listStateFiles", {
          stateHash,
        }))
      );
    }
    for (const file of wanted) {
      const bytes = await getBytes(this.deps.blobsDir, file.content_hash);
      if (!bytes || bytes.length > MAX_INDEXED_FILE_BYTES) continue;
      if (bytes.subarray(0, 8192).includes(0)) continue; // binary
      files.push({ path: file.path, contentHash: file.content_hash, text: bytes.toString("utf8") });
    }
    if (files.length > 0 || removedPaths.length > 0) {
      await this.gad().call("indexMemoryFiles", { files, removedPaths });
    }
    await this.gad().call("setMemoryIndexMarker", { key: "main", value: stateHash });
  }

  /** Provenance-carrying memory search (messages, claims, files). */
  async recallMemory(input: { query: string; kinds?: string[]; limit?: number }): Promise<unknown> {
    return await this.gad().call("recallMemory", input);
  }

  // -------------------------------------------------------------------------
  // GC (WS3.P5)
  // -------------------------------------------------------------------------

  /**
   * Run a full GC cycle: mark in the store (also prunes orphaned value
   * rows), then sweep blob candidates older than `minAgeMs` and delete
   * their bytes from the filesystem CAS (two-phase deletion).
   */
  async runGc(opts: { minAgeMs?: number } = {}): Promise<{
    keptStates: number;
    sweptStates: number;
    sweptManifests: number;
    sweptFileVersions: number;
    sweptBlobs: number;
  }> {
    const mark = await this.gad().call<{
      keptStates: number;
      sweptStates: number;
      sweptManifests: number;
      sweptFileVersions: number;
      blobCandidates: number;
    }>("runGadGcMark", {});
    const sweep = await this.gad().call<{ digests: string[] }>("runGadGcSweep", {
      minAgeMs: opts.minAgeMs ?? 60_000,
    });
    for (const digest of sweep.digests) {
      await fsp.rm(blobPath(this.deps.blobsDir, digest), { force: true }).catch(() => {});
    }
    return {
      keptStates: mark.keptStates,
      sweptStates: mark.sweptStates,
      sweptManifests: mark.sweptManifests,
      sweptFileVersions: mark.sweptFileVersions,
      sweptBlobs: sweep.digests.length,
    };
  }

  /** Recent vcs transitions for a head, newest first. */
  async readVcsLog(
    limit: number,
    head: string = VCS_MAIN_HEAD
  ): Promise<
    Array<{
      seq: number;
      envelopeId: string;
      actor: unknown;
      summary: string | null;
      outputStateHash: string | null;
      appendedAt: string;
    }>
  > {
    const events = await this.gad().call<
      Array<{
        seq: number;
        envelopeId: string;
        actor: unknown;
        payloadKind: string;
        payload: Record<string, unknown>;
        appendedAt: string;
      }>
    >("readLog", { logId: VCS_LOG_ID, head, limit: 0 });
    return events
      .filter(
        (event) =>
          event.payloadKind === "state.snapshot_ingested" ||
          event.payloadKind === "state.merge_applied"
      )
      .slice(-limit)
      .reverse()
      .map((event) => ({
        seq: event.seq,
        envelopeId: event.envelopeId,
        actor: event.actor,
        summary: typeof event.payload["summary"] === "string" ? event.payload["summary"] : null,
        outputStateHash:
          typeof event.payload["outputStateHash"] === "string"
            ? event.payload["outputStateHash"]
            : null,
        appendedAt: event.appendedAt,
      }));
  }

  /** Working-tree status of a head against its durable ref. */
  /**
   * Status of a head: its unpublished changes against `main` (a pure GAD
   * state-diff, never a worktree scan). `dirty` is true iff the head is ahead
   * of `main`; `main` is always clean (it is the baseline).
   */
  async statusHead(head: string): Promise<{
    stateHash: string | null;
    dirty: boolean;
    added: string[];
    removed: string[];
    changed: string[];
  }> {
    const delta = await this.unpublishedDelta(head);
    return {
      stateHash: delta.headStateHash,
      dirty: delta.added.length > 0 || delta.removed.length > 0 || delta.changed.length > 0,
      added: delta.added,
      removed: delta.removed,
      changed: delta.changed,
    };
  }
}

function assertHash(value: string | null): string {
  if (!value) throw new Error("Expected a state hash");
  return value;
}
