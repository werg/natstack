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
  WorkingAdvancedEvent,
  WorkspaceStateSource,
} from "../buildV2/stateTrigger.js";
import type { BuildSourceProvider } from "../buildV2/buildSource.js";
import type { RepoPushValidator, RepoBuildReport } from "../buildV2/index.js";
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
  VCS_MAIN_HEAD,
  VCS_ARCHIVE_HEAD_PREFIX,
  logIdForRepo,
  repoPathFromLogId,
  normalizeRepoPathForLog,
  joinRepoPrefix,
  vcsContextHead,
  vcsLogActor,
  VCS_REPO_LOG_PREFIX,
  type GadCaller,
  type WorktreeHeadRef,
  type VcsFileEntry,
  type SnapshotResult,
} from "./store.js";
import {
  discoverRepos,
  CONTAINER_SECTIONS,
  FLAT_SECTIONS,
  type DiscoveredRepo,
} from "./repoDiscovery.js";
import { EMPTY_STATE_HASH } from "@workspace/agentic-protocol";
import { MergeEngine, type MergeConflict } from "./merge.js";
import { computeReplaceHunks } from "./diff3.js";
import { ContextManager, type RepoState as ContextManagerRepoState } from "./contextManager.js";

/** A raw row returned by a gad-store read RPC (snake_case columns). */
type JsonRecord = Record<string, unknown>;

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
 * The canonical edit input for `edit` — an op union, not bare hunks, so
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

/** Result of {@link WorkspaceVcs.recordEdit} — a tracked WORKING edit (no commit
 *  head advance, no `vcs.log` entry, no build). */
export interface RecordEditResult {
  head: string;
  /** The working state hash (committed base + uncommitted ops) projected to disk. */
  stateHash: string;
  committed: false;
  status: "uncommitted";
  /** The shared per-call edit sequence assigned to this edit's ops. */
  editSeq: number;
  changedPaths: string[];
}

/** Result of {@link WorkspaceVcs.commit}. */
export interface CommitEditsResult {
  head: string;
  stateHash: string;
  eventId: string | null;
  headHash: string | null;
  /** Number of edit-op rows folded into this commit. */
  editCount: number;
  status: "committed" | "unchanged";
  changedPaths: string[];
}

/** A parked pending merge (the explicit commit-layer reconcile, §4.6). */
export interface PendingMergeInfo {
  oursStateHash: string;
  theirsStateHash: string;
  theirsEventId: string | null;
  baseStateHash: string | null;
  theirsHead: string;
  conflicts: Array<{ path: string; kind: string }>;
  provisionalStateHash: string;
  materialized?: boolean;
}

/** A commit on the source head not yet on the target — the upstream-commit shape
 *  shared by `vcs.merge` and the push-divergence error. */
export interface UpstreamCommit {
  eventId: string;
  message: string;
  stateHash: string;
  createdAt: string | null;
}

/** Result of the explicit merge reconcile ({@link WorkspaceVcs.mergeHeads}). */
export interface MergeReconcileResult {
  status: "up-to-date" | "merged" | "conflicted";
  stateHash: string | null;
  conflicts: MergeConflict[];
  mergeable: "clean" | "conflict";
  upstreamCommits: UpstreamCommit[];
  conflictPaths?: string[];
}

/** Per-repo divergence detail in a rejected push (§4.4). */
export interface RepoDivergence {
  repoPath: string;
  base: string | null;
  mainTip: string | null;
  upstreamCommits: UpstreamCommit[];
  mergeable: "clean" | "conflict";
  conflictPaths?: string[];
}

type PushResult =
  | {
      status: "pushed" | "up-to-date";
      repoPaths: string[];
      reports: RepoBuildReport[];
    }
  | { status: "diverged"; divergences: RepoDivergence[] }
  | { status: "build-failed"; reports: RepoBuildReport[] };

interface PushAdvanceCandidate {
  repoPath: string;
  logId: string;
  oursState: string;
  sourceEventId: string | null;
  candidateState: string;
  files: Array<{ path: string; contentHash: string; mode: number }>;
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

function isFinalHeadCasConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("worktree head CAS conflict") ||
      error.message.includes("ref CAS conflict"))
  );
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
/**
 * Rewrite a `package.json`'s `name` leaf to match a forked repo's new path,
 * preserving the existing scope (e.g. `"@workspace-panels/chat"` + `"panels/mychat"`
 * → `"@workspace-panels/mychat"`). Returns the new JSON text, or `null` if it
 * can't parse or has no string `name`.
 */
function renameWorkspacePackage(jsonText: string, toPath: string): string | null {
  let pkg: { name?: unknown } & Record<string, unknown>;
  try {
    pkg = JSON.parse(jsonText) as { name?: unknown } & Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof pkg.name !== "string") return null;
  const leaf = toPath.split("/").pop() ?? toPath;
  const slash = pkg.name.lastIndexOf("/");
  pkg.name = slash >= 0 ? `${pkg.name.slice(0, slash + 1)}${leaf}` : leaf;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

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
   * Attach the gad store once workerd is up. Drops the bootstrap local state
   * and seeds every present repo's `main` log from the on-disk workspace tree
   * (per-repo, see {@link ensureRepoLogsFromDisk}). Each repo's state hash is
   * the one local hashing already produced — the DO recomputes and agrees —
   * so repos that were already seeded no-op and don't churn the build trigger.
   */
  async attachGad(gad: GadCaller): Promise<void> {
    this.gadCaller = gad;
    if (this.localMain) {
      this.localMain = null;
      this.lastState.delete(VCS_MAIN_HEAD);
    }
    await this.ensureRepoLogsFromDisk();
  }

  // -------------------------------------------------------------------------
  // Heads / dirs
  // -------------------------------------------------------------------------

  contextDir(contextId: string): string {
    return path.join(this.deps.contextsRoot, contextId);
  }

  // -------------------------------------------------------------------------
  // Per-repo routing (W2)
  //
  // Every repo (`packages/foo`, `panels/chat`, `projects/<vault>`, `meta`) has
  // its own GAD log `vcs:repo:<path>` with heads `main`/`ctx:*`. A repo's state
  // is subtree-rooted. There is no whole-tree log — every head is keyed by a
  // repoPath.
  // -------------------------------------------------------------------------

  /**
   * Log id for a repo (per-repo VCS). A repoPath is required — there is no
   * whole-tree log to fall back to. The argument is typed `string | undefined`
   * only so the many internal head-routing paths can forward an optional
   * `opts.repoPath` through one chokepoint; an undefined value is a programming
   * error (a head operation reached the store without a repo).
   */
  private repoLogId(repoPath: string | undefined): string {
    if (!repoPath) {
      throw new Error(
        "per-repo VCS: a repoPath is required (no whole-tree vcs:workspace log exists)"
      );
    }
    return logIdForRepo(repoPath);
  }

  /** Working-tree dir for a (repoPath, head): a repo's subtree under the
   *  workspace root (main) or under its context folder (`ctx:*`). */
  private dirForRepoHead(repoPath: string | undefined, head: string): string {
    const base =
      head === VCS_MAIN_HEAD
        ? this.deps.workspaceRoot
        : head.startsWith("ctx:")
          ? this.contextDir(head.slice(4))
          : (() => {
              throw new Error(`No working tree for head: ${head}`);
            })();
    return repoPath ? path.join(base, ...normalizeRepoPathForLog(repoPath).split("/")) : base;
  }

  /** Compose a per-repo state key for `lastState` / lock maps. */
  private stateKey(logId: string, head: string): string {
    return `${logId}\x00${head}`;
  }

  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return serializeByKey(this.snapshotLocks, key, fn);
  }

  /** Acquire several per-key locks at once, sorted (and de-duplicated) so two
   *  overlapping multi-key acquisitions can never deadlock, then run `fn` holding
   *  all of them. NOT re-entrant — `fn` must not re-acquire one of `keys`. */
  private lockedMany<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(keys)].sort();
    const acquire = (i: number): Promise<T> =>
      i >= sorted.length ? fn() : this.locked(sorted[i]!, () => acquire(i + 1));
    return acquire(0);
  }

  private commitEventIdForHead(ref: WorktreeHeadRef | null, label: string): string | null {
    if (!ref || ref.stateHash === EMPTY_STATE_HASH) return null;
    if (!ref.commitEventId) {
      throw new Error(`${label} has state ${ref.stateHash} but no commit event identity`);
    }
    return ref.commitEventId;
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
      /** Repo the head lives on (per-repo VCS). Required in practice — there is
       *  no whole-tree log; an undefined value throws in `repoLogId`. */
      repoPath?: string;
    } = {}
  ): Promise<CommitResult> {
    if (opts.beforeAdvance) {
      return this.commitHeadWithUnlockedApproval(head, {
        ...opts,
        beforeAdvance: opts.beforeAdvance,
      });
    }

    const repoPath = opts.repoPath;
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, head);
    return this.locked(sk, async () => {
      const dir = this.dirForRepoHead(repoPath, head);
      const actor = opts.actor ?? USER_ACTOR;
      const prevState = this.lastState.get(sk) ?? (await this.vcs.resolveWorktreeRef(head, logId));
      // A pending conflicted merge turns this commit into the merge
      // resolution: record the merge parents and the merge transition kind.
      const pending = this.attached
        ? (
            await this.gad().call<{
              info: {
                theirsStateHash: string;
                theirsEventId?: string | null;
                provisionalStateHash: string;
                materialized?: boolean;
              } | null;
            }>("getPendingMerge", { logId, head })
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
          logId,
          head,
          info: { ...pending, materialized: true },
        });
      }
      const snap = await this.vcs.snapshotDir(dir, {
        head,
        logId,
        actor,
        ...(opts.summary ? { summary: opts.summary } : {}),
        ...(pending
          ? {
              force: true,
              parentStateHashes: [pending.theirsStateHash],
              ...(pending.theirsEventId ? { parentEventIds: [pending.theirsEventId] } : {}),
              eventKind: "state.merge_applied" as const,
            }
          : {}),
      });
      if (pending) {
        await this.gad().call("clearPendingMerge", { logId, head });
        await this.syncConflictSummary(head, repoPath);
      }
      this.lastState.set(sk, snap.stateHash);
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
          repoPath,
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
      repoPath?: string;
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
      repoPath?: string;
    },
    actor: { id: string; kind: string }
  ): Promise<
    | { kind: "candidate"; candidate: PreparedSnapshotCandidate }
    | { kind: "committed"; result: CommitResult }
  > {
    const repoPath = opts.repoPath;
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, head);
    return this.locked(sk, async () => {
      const dir = this.dirForRepoHead(repoPath, head);
      const pending = await this.preparePendingMergeForCommit(head, dir, logId);
      try {
        const snap = await this.vcs.snapshotDir(dir, {
          head,
          logId,
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
              repoPath,
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
                ...(pending.theirsEventId ? { parentEventIds: [pending.theirsEventId] } : {}),
                eventKind: "state.merge_applied" as const,
              }
            : {}),
        });
        this.lastState.set(sk, snap.stateHash);
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
      repoPath?: string;
    },
    actor: { id: string; kind: string }
  ): Promise<CommitResult> {
    const repoPath = opts.repoPath;
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, approved.head);
    return this.locked(sk, async () => {
      const dir = this.dirForRepoHead(repoPath, approved.head);
      const pending = await this.preparePendingMergeForCommit(approved.head, dir, logId);
      let validated = false;
      const snap = await this.vcs.snapshotDir(dir, {
        head: approved.head,
        logId,
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
              ...(pending.theirsEventId ? { parentEventIds: [pending.theirsEventId] } : {}),
              eventKind: "state.merge_applied" as const,
            }
          : {}),
      });

      if (snap.unchanged) {
        if (snap.stateHash !== approved.stateHash) throw new SnapshotApprovalStaleError();
        this.lastState.set(sk, snap.stateHash);
        return { ...snap, head: approved.head, changedPaths: [] };
      }
      if (!validated) throw new SnapshotApprovalStaleError();

      if (pending) {
        await this.gad().call("clearPendingMerge", { logId, head: approved.head });
        await this.syncConflictSummary(approved.head, repoPath);
      }
      this.lastState.set(sk, snap.stateHash);
      const event = await this.stateAdvancedEvent({
        head: approved.head,
        previousStateHash: approved.previousStateHash,
        stateHash: snap.stateHash,
        eventId: snap.eventId || null,
        headHash: snap.headHash || null,
        actor,
        transitionKind: pending ? "merge-resolution" : "snapshot",
        repoPath,
      });
      this.emitter.emit("state-advanced", event);
      return { ...snap, head: approved.head, changedPaths: event.changedPaths };
    });
  }

  private async preparePendingMergeForCommit(
    head: string,
    dir: string,
    logId: string
  ): Promise<{
    theirsStateHash: string;
    theirsEventId?: string | null;
    provisionalStateHash: string;
    materialized?: boolean;
  } | null> {
    const pending = this.attached
      ? (
          await this.gad().call<{
            info: {
              theirsStateHash: string;
              theirsEventId?: string | null;
              provisionalStateHash: string;
              materialized?: boolean;
            } | null;
          }>("getPendingMerge", { logId, head })
        ).info
      : null;
    if (pending && pending.materialized === false) {
      await this.vcs.materializeState(pending.provisionalStateHash, dir);
      await this.gad().call("setPendingMerge", {
        logId,
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
  // RPC: sandboxed callers commit through `edit` (edit-first), never by
  // snapshotting their context worktree behind GAD's back.
  // -------------------------------------------------------------------------

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
    await this.snapshotRepoLogsFromDisk();
    return await this.workspaceView();
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

  async resolveHead(head: string, repoPath?: string): Promise<string | null> {
    if (!repoPath && !this.attached && head === VCS_MAIN_HEAD) {
      return this.localMain?.stateHash ?? null;
    }
    return await this.vcs.resolveWorktreeRef(head, this.repoLogId(repoPath));
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
    workspaceStateHash?: string;
    /** When set, the diff/state are subtree-rooted on this repo's log; the
     *  event is re-rooted to workspace-relative for the build trigger (finding
     *  #1): changedPaths/fileChanges get the repo prefix and the build
     *  `stateHash` becomes the composed workspace view. `repoPath` is carried as
     *  routing metadata. */
    repoPath?: string;
  }): Promise<StateAdvancedEvent> {
    const fileChanges =
      input.previousStateHash === input.stateHash
        ? []
        : await this.diffFileChanges(input.previousStateHash, input.stateHash);

    if (!input.repoPath) {
      return {
        head: input.head,
        stateHash: input.stateHash,
        repoStateHash: input.stateHash,
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

    // Per-repo advance: re-root the subtree-relative diff to workspace-relative
    // and point the build trigger at the composed workspace view, so
    // unitsForChangedPaths/buildUnit run against a workspace-rooted state and a
    // subtree-rooted repo state never reaches them directly.
    const repoPath = input.repoPath;
    const reroot = (p: string): string => joinRepoPrefix(repoPath, p);
    // The build trigger discovers the graph + EV-diffs against `stateHash` and
    // `sinceStateHash` as WORKSPACE-ROOTED states — a subtree-rooted repo state
    // must never reach it. For `main` advances use the composed workspace view;
    // for a context (`ctx:*`) advance use the composed CONTEXT view (the pinned
    // base with this context's ctx heads overlaid) so a context build sees its
    // own edits. `sinceStateHash` is the same composed view with the edited repo
    // at its prior state, for a precise per-edit changeset.
    const ctxId = input.head.startsWith("ctx:") ? input.head.slice("ctx:".length) : null;
    const workspaceStateHash =
      input.head === VCS_MAIN_HEAD
        ? (input.workspaceStateHash ??
          (await this.workspaceViewWithRepoAtSafe(repoPath, input.stateHash)) ??
          input.stateHash)
        : ctxId
          ? await this.contextManager.resolveContextView(ctxId).catch(() => input.stateHash)
          : input.stateHash;
    const sinceStateHash =
      input.head === VCS_MAIN_HEAD
        ? ((await this.workspaceViewWithRepoAtSafe(repoPath, input.previousStateHash)) ??
          input.previousStateHash)
        : ctxId
          ? await this.contextManager
              .composedViewWithRepoAt(ctxId, repoPath, input.previousStateHash)
              .catch(() => input.previousStateHash)
          : input.previousStateHash;
    return {
      head: input.head,
      stateHash: workspaceStateHash,
      // The build trigger's `stateHash` is the composed view above; clients
      // correlating with edit/readFile/revert returns need the raw
      // subtree-rooted repo state, which is `input.stateHash` here.
      repoStateHash: input.stateHash,
      sinceStateHash,
      eventId: input.eventId,
      headHash: input.headHash,
      actor: input.actor,
      transitionKind: input.transitionKind,
      repoPath,
      changedPaths: fileChanges.map((change) => reroot(change.path)),
      fileChanges: fileChanges.map((change) => ({ ...change, path: reroot(change.path) })),
      editOps: (input.editOps ?? []).map((op) => ({ ...op, path: reroot(op.path) })),
    };
  }

  /** Best-effort composed workspace view with one repo overlaid. Used while a
   *  candidate `main` advance is still uncommitted, so approval/build events see
   *  the state that WOULD exist after the candidate rather than stale live main. */
  private async workspaceViewWithRepoAtSafe(
    repoPath: string,
    repoStateHash: string | null
  ): Promise<string | null> {
    try {
      return await this.workspaceViewWithRepoAt(repoPath, repoStateHash);
    } catch {
      return null;
    }
  }

  onStateAdvanced(cb: (event: StateAdvancedEvent) => void): () => void {
    this.emitter.on("state-advanced", cb);
    return () => this.emitter.off("state-advanced", cb);
  }

  /** Subscribe to UNCOMMITTED working-content advances (recordEdit). Distinct
   *  from `state-advanced`: the build trigger ignores these; reactive views and
   *  dirty indicators consume them. */
  onWorkingAdvanced(cb: (event: WorkingAdvancedEvent) => void): () => void {
    this.emitter.on("working-advanced", cb);
    return () => this.emitter.off("working-advanced", cb);
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

  /** Resolve `state:…` hashes verbatim; head names to their current state on
   *  the given repo's log. A bare head name requires a repoPath (per-repo VCS —
   *  there is no whole-tree head to resolve). */
  async resolveStateRef(stateRef: string, repoPath?: string): Promise<string> {
    if (stateRef.startsWith("state:")) return stateRef;
    const resolved = await this.resolveHead(stateRef, repoPath);
    if (!resolved) throw new Error(`Unknown vcs ref: ${stateRef}`);
    return resolved;
  }

  // -------------------------------------------------------------------------
  // Context folders (GAD branches)
  // -------------------------------------------------------------------------

  // ── Context state ownership (A1) ───────────────────────────────────────
  // A context's entire VCS state — pinned base, composed-view cache, sparse
  // materialization tracking, lifecycle — is owned by a single {@link
  // ContextManager}. WorkspaceVcs delegates every per-context op to it through
  // the {@link ContextVcsHost} seam below (the manager never reaches into
  // WorkspaceVcs internals). Teardown clears ALL per-context state in one place
  // (impossible to half-do), and the composed-view cache is self-invalidating
  // (keyed by base + ctx-head signature), eliminating the "did I remember to
  // invalidate?" hazard that used to live at every mutation site.
  private readonly contextManager = new ContextManager({
    gadCall: <T>(method: string, input: unknown): Promise<T> => this.gad().call<T>(method, input),
    resolveRepoHead: (head: string, repoPath: string) =>
      this.vcs.resolveWorktreeRef(head, this.repoLogId(repoPath)),
    composeRepoStates: async (repos: ContextManagerRepoState[]) =>
      repos.length === 0
        ? EMPTY_STATE_HASH
        : (await this.gad().call<{ stateHash: string }>("composeRepoStates", { repos })).stateHash,
    collectRepoHeadStates: (headName: string) => this.collectRepoHeadStates(headName),
    collectRepoMainStates: () => this.collectRepoMainStates(),
    repoWasArchived: (repoPath: string) => this.repoWasArchived(this.repoLogId(repoPath)),
    workspaceView: () => this.workspaceView(),
    decomposePinnedView: (baseView: string) => this.decomposePinnedView(baseView),
    materializeRepo: async (contextId: string, repoPath: string, stateHash: string) => {
      await this.locked(this.stateKey(this.repoLogId(repoPath), `mat:${contextId}`), () =>
        this.vcs.materializeState(
          stateHash,
          this.dirForRepoHead(repoPath, vcsContextHead(contextId)),
          { clean: true }
        )
      );
    },
    deleteRepoContextHead: async (repoPath: string, head: string) => {
      const logId = this.repoLogId(repoPath);
      // Fully retire the head (events + log_heads row + both refs + edit-ops) in
      // one txn — deleting only the refs leaves a stale fork pointer that fails
      // the gad integrity check.
      await this.gad()
        .call("deleteLogHead", { logId, head })
        .catch(() => {});
      this.lastState.delete(this.stateKey(logId, head));
    },
    mergeMainIntoContext: (
      contextId: string,
      repoPath: string,
      actor: { id: string; kind: string }
    ) => this.mergeHeads(vcsContextHead(contextId), VCS_MAIN_HEAD, { repoPath, actor }),
    contextWorkingFingerprint: (contextId: string) => this.contextWorkingFingerprint(contextId),
    composeWorkingRepoState: (contextId: string, repoPath: string) =>
      this.composeWorkingRepoStateForContext(contextId, repoPath),
    listContextWorkingRepos: (contextId: string) => this.listContextWorkingRepos(contextId),
    clearContextRepoEdits: async (contextId: string, repoPath: string) => {
      await this.gad()
        .call("discardWorkingEdits", {
          logId: this.repoLogId(repoPath),
          head: vcsContextHead(contextId),
        })
        .catch(() => {});
    },
  });

  /**
   * Cheap per-repo fingerprint of a context's working content — the inputs the
   * composed view depends on: each touched repo's committed ctx-head state (null
   * if none) and its highest uncommitted `edit_seq`. Folded into the composed-view
   * cache key so an edit invalidates it. Covers repos with a ctx head AND repos
   * with uncommitted-only edits (no ctx head yet).
   */
  private async contextWorkingFingerprint(
    contextId: string
  ): Promise<Array<{ repoPath: string; committedState: string | null; editSeq: number }>> {
    const head = vcsContextHead(contextId);
    const repoPaths = new Set<string>();
    for (const c of await this.collectRepoHeadStates(head)) {
      repoPaths.add(normalizeRepoPathForLog(c.repoPath));
    }
    for (const repoPath of await this.listContextWorkingRepos(contextId)) {
      repoPaths.add(normalizeRepoPathForLog(repoPath));
    }
    const out: Array<{ repoPath: string; committedState: string | null; editSeq: number }> = [];
    for (const repoPath of repoPaths) {
      const logId = this.repoLogId(repoPath);
      const committedState = await this.vcs.resolveWorktreeRef(head, logId);
      const rows = await this.gad().call<JsonRecord[]>("listWorkingEdits", { logId, head });
      const editSeq = rows.reduce((m, r) => Math.max(m, Number(r["edit_seq"] ?? 0)), 0);
      out.push({ repoPath, committedState, editSeq });
    }
    return out;
  }

  /** Repos (paths) with uncommitted edits in a context (discovery for the
   *  composed view + teardown). */
  private async listContextWorkingRepos(contextId: string): Promise<string[]> {
    const rows = await this.gad().call<Array<{ logId: string }>>("listContextWorkingRepos", {
      head: vcsContextHead(contextId),
    });
    return rows.map((r) => repoPathFromLogId(r.logId)).filter((p): p is string => p !== null);
  }

  /** The WORKING content state for a repo in a context (committed base — or a
   *  pending merge's provisional — composed with the repo's uncommitted ops).
   *  Equals the committed base when the repo has no edits; null when the repo
   *  doesn't exist in the context at all. */
  private async composeWorkingRepoStateForContext(
    contextId: string,
    repoPath: string
  ): Promise<string | null> {
    const head = vcsContextHead(contextId);
    const logId = this.repoLogId(repoPath);
    const { base } = await this.resolveComposeBase(head, repoPath);
    if (base === EMPTY_STATE_HASH) {
      const rows = await this.gad().call<JsonRecord[]>("listWorkingEdits", { logId, head });
      if (rows.length === 0) return null; // repo absent from this context
    }
    const working = await this.composeWorkingFileMap(logId, head, base);
    return this.stageFiles([...working.files.values()], `working content for ${head}`);
  }

  /** Pin (or re-pin) a context's base view (see {@link ContextManager.pinContext}). */
  pinContext(contextId: string, baseView?: string): Promise<string> {
    return this.contextManager.pinContext(contextId, baseView);
  }

  /** The context's pinned base view state, or null if never pinned. */
  contextBaseView(contextId: string): Promise<string | null> {
    return this.contextManager.contextBaseView(contextId);
  }

  /** The context's composed view (edited repos at their ctx head, the rest at
   *  the pinned base). Self-invalidating cache; see {@link ContextManager}. */
  resolveContextView(contextId: string): Promise<string> {
    return this.contextManager.resolveContextView(contextId);
  }

  /** The state a repo should be on disk at for a context (ctx head / pinned base
   *  slice / live main). Null when the repo doesn't exist anywhere. */
  contextRepoState(contextId: string, repoPath: string): Promise<string | null> {
    return this.contextManager.contextRepoState(contextId, repoPath);
  }

  /** True iff `repoPath`'s subtree is currently materialized on disk for the
   *  context. Backs the loud read-time assertion. */
  isContextRepoMaterialized(contextId: string, repoPath: string): boolean {
    return this.contextManager.isContextRepoMaterialized(contextId, repoPath);
  }

  /** Demand-materialize specific repos (or the whole view) into a context's
   *  working folder (sparse; see {@link ContextManager.materializeContextRepos}). */
  materializeContextRepos(contextId: string, repos: string[] | "all"): Promise<void> {
    return this.contextManager.materializeContextRepos(contextId, repos);
  }

  async ensureContextFolder(contextId: string): Promise<{ dir: string; head: string }> {
    const head = vcsContextHead(contextId);
    const dir = this.contextDir(contextId);
    // Sparse: ensure the folder EXISTS but materialize nothing — repos are
    // written on demand by `materializeContextRepos`.
    await fsp.mkdir(dir, { recursive: true });
    return { dir, head };
  }

  /**
   * Teardown — drop ALL per-context state when a context retires (caches + every
   * `ctx:{contextId}` head across repo logs + the pin ref) in ONE atomic place
   * (see {@link ContextManager.dropContext}). Without this, context churn leaks
   * memory and orphans refs.
   */
  dropContext(contextId: string): Promise<void> {
    return this.contextManager.dropContext(contextId);
  }

  /**
   * Rebase — pull the latest `main` into each edited repo (3-way merge onto the
   * `ctx` head) then RE-PIN the base to the current `workspaceView()` so unedited
   * repos also advance (see {@link ContextManager.rebaseContext}).
   */
  rebaseContext(
    contextId: string,
    actor: { id: string; kind: string } = SYSTEM_ACTOR
  ): Promise<{
    repos: Array<{ repoPath: string; status: "up-to-date" | "merged" | "conflicted" }>;
    baseView: string;
  }> {
    return this.contextManager.rebaseContext(contextId, actor);
  }

  /**
   * Context status — per-repo `forked`/`uncommitted`/`ahead`/`behind`/`deleted`
   * summary (see {@link ContextManager.contextStatus}). Only interesting repos
   * are returned.
   */
  contextStatus(contextId: string): Promise<
    Array<{
      repoPath: string;
      forked: boolean;
      uncommitted: boolean;
      ahead: boolean;
      behind: boolean;
      deleted: boolean;
    }>
  > {
    return this.contextManager.contextStatus(contextId);
  }

  /**
   * Schema v20 removed encoded VCS refs entirely. Kept as a no-op startup hook
   * for callers that still run the old cleanup step.
   */
  async gcLegacyWorkspaceLog(): Promise<{ deleted: number }> {
    return { deleted: 0 };
  }

  /**
   * Fork a repo's entire `main` history into a NEW repo at `toPath` — a no-copy
   * lineage fork (`forkLog`): the new repo's `vcs:repo:<toPath>` history descends
   * from the source, so `log --repo <toPath>` shows the inherited events and
   * later edits build on that lineage. The `package.json` `name` leaf is rewritten
   * to the new path so the fork doesn't collide with the source in the build graph
   * (it is immediately build-valid). Deeper renames (component/class names) are the
   * caller's job. Errors if the source has no history or the destination exists.
   */
  async forkRepo(
    fromPath: string,
    toPath: string,
    actor: { id: string; kind: string } = USER_ACTOR
  ): Promise<{ repoPath: string; head: string; inherited: number; stateHash: string }> {
    const from = normalizeRepoPathForLog(fromPath);
    const to = normalizeRepoPathForLog(toPath);
    if (from === to) throw new Error(`forkRepo: source and destination are the same (${from})`);
    const fromLogId = logIdForRepo(from);
    const toLogId = logIdForRepo(to);

    const fromMain = await this.vcs.resolveWorktreeRef(VCS_MAIN_HEAD, fromLogId);
    if (!fromMain) throw new Error(`forkRepo: source repo "${from}" has no history to fork`);
    if (await this.vcs.resolveWorktreeRef(VCS_MAIN_HEAD, toLogId)) {
      throw new Error(`forkRepo: destination repo "${to}" already exists`);
    }

    // 1. No-copy lineage fork: vcs:repo:<from> @ main → vcs:repo:<to> @ main.
    const fork = await this.gad().call<{ inherited: number }>("forkLog", {
      fromLogId,
      fromHead: VCS_MAIN_HEAD,
      toLogId,
      toHead: VCS_MAIN_HEAD,
    });

    // 2. Rewrite package.json `name` (when present) so the fork is build-valid —
    //    a direct main-bootstrap commit on top of the inherited lineage (history
    //    preserved + rename). `main` advances only via push or bootstrap; this
    //    repo-creation rename is a bootstrap-class op, so it ingests directly
    //    (not through recordEdit, which targets ctx heads).
    let stateHash = fromMain;
    const pkg = await this.readFile(VCS_MAIN_HEAD, "package.json", to);
    if (pkg && pkg.content.kind === "text") {
      const renamed = renameWorkspacePackage(pkg.content.text, to);
      if (renamed && renamed !== pkg.content.text) {
        const baseFiles = await this.gad().call<
          Array<{ path: string; content_hash: string; mode: number }>
        >("listStateFiles", { stateHash: fromMain });
        const { digest } = await putBytes(this.deps.blobsDir, Buffer.from(renamed, "utf8"));
        const files = baseFiles.map((f) =>
          f.path === "package.json"
            ? { path: f.path, contentHash: digest, mode: f.mode }
            : { path: f.path, contentHash: f.content_hash, mode: f.mode }
        );
        const ingest = await this.gad().call<{
          stateHash: string;
          eventId: string;
          headHash: string;
        }>("ingestWorktreeState", {
          logId: toLogId,
          head: VCS_MAIN_HEAD,
          logKind: "vcs",
          actor: vcsLogActor(actor),
          files,
          baseStateHash: fromMain,
          expectedRefStateHash: fromMain,
          eventKind: "state.snapshot_ingested",
          summary: `forkRepo: rename package to ${to}`,
          editOps: [
            {
              kind: "write",
              path: "package.json",
              oldContentHash: pkg.contentHash,
              newContentHash: digest,
            },
          ],
        });
        stateHash = ingest.stateHash;
        this.emitter.emit(
          "state-advanced",
          await this.stateAdvancedEvent({
            head: VCS_MAIN_HEAD,
            previousStateHash: fromMain,
            stateHash,
            eventId: ingest.eventId,
            headHash: ingest.headHash,
            actor,
            transitionKind: "snapshot",
            repoPath: to,
          })
        );
      }
    }

    await this.vcs
      .materializeState(stateHash, this.dirForRepoHead(to, VCS_MAIN_HEAD))
      .catch(() => {});
    this.lastState.set(this.stateKey(toLogId, VCS_MAIN_HEAD), stateHash);
    return { repoPath: to, head: VCS_MAIN_HEAD, inherited: fork.inherited, stateHash };
  }

  // -------------------------------------------------------------------------
  // Merge (WS3.P4)
  // -------------------------------------------------------------------------

  /**
   * Explicit reconcile (§4.6): merge `sourceHead` (typically `main`) into
   * `targetHead` (a `ctx:*` head), producing a MERGE COMMIT — never auto-done by
   * push. Rejects on uncommitted edits (a clean working state is required) and on
   * a reconcile already in progress.
   *
   *  - **clean** (no file overlaps — the ffwd case): commit the 3-way result on
   *    the ctx head with `baseStateHash: ctxHead` + `parentStateHashes:
   *    [theirsTip]` and NO file resolution.
   *  - **conflict** (in-file): materialize the conflicted tree (markers) into the
   *    context filesystem + park a pending merge on the ctx head; the agent
   *    resolves with `vcs.edit`s and then `vcs.commit` consumes the pending and
   *    records the merge commit.
   *
   * Returns the same structured shape as the push-divergence error (the upstream
   * commits + clean/conflict + conflictPaths).
   */
  async mergeHeads(
    targetHead: string,
    sourceHead: string,
    opts: {
      actor?: { id: string; kind: string };
      repoPath?: string;
    } = {}
  ): Promise<MergeReconcileResult> {
    const repoPath = opts.repoPath;
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, targetHead);
    return this.locked(sk, async () => {
      const actor = opts.actor ?? USER_ACTOR;
      const logActor = vcsLogActor(actor);
      const existingPending = (
        await this.gad().call<{ info: PendingMergeInfo | null }>("getPendingMerge", {
          logId,
          head: targetHead,
        })
      ).info;
      if (existingPending) {
        throw new Error(
          `merge in progress on ${targetHead}: resolve + vcs.commit, or vcs.discardEdits`
        );
      }
      // Clean working state required — a merge over uncommitted edits would fold
      // unrelated changes into the merge commit.
      const working = await this.gad().call<JsonRecord[]>("listWorkingEdits", {
        logId,
        head: targetHead,
      });
      if (working.length > 0) {
        throw new Error(
          `uncommitted edits on ${targetHead} — vcs.commit or vcs.discardEdits before merge`
        );
      }
      const targetDir = this.dirForRepoHead(repoPath, targetHead);
      const oursHeadRef = await this.vcs.resolveWorktreeHead(targetHead, logId);
      const oursState =
        oursHeadRef?.stateHash ?? (await this.resolveCommittedBase(targetHead, repoPath));
      const theirsHeadRef = await this.vcs.resolveWorktreeHead(sourceHead, logId);
      const theirsState = theirsHeadRef?.stateHash;
      if (!theirsState) throw new Error(`merge source head has no state: ${sourceHead}`);
      const theirsEventId = this.commitEventIdForHead(
        theirsHeadRef,
        `merge source head ${sourceHead}`
      );
      const upstreamCommits = await this.upstreamCommitsBetween(
        oursState,
        theirsState,
        theirsEventId
      );

      const engine = new MergeEngine({ blobsDir: this.deps.blobsDir, gad: this.gad() });
      const result = await engine.compute(oursState, theirsState, {
        ours: targetHead,
        theirs: sourceHead,
      });

      if (result.status === "up-to-date") {
        return {
          status: "up-to-date",
          stateHash: oursState,
          conflicts: [],
          mergeable: "clean",
          upstreamCommits,
        };
      }

      if (result.status === "clean" || result.status === "fast-forward") {
        // Clean merge → a merge COMMIT on the ctx head (no file resolution). ours
        // is the implicit first parent (the ref advance); theirs is the added one.
        const ingest = await this.gad().call<{
          stateHash: string;
          eventId: string;
          headHash: string;
        }>("ingestWorktreeState", {
          logId,
          head: targetHead,
          logKind: "vcs",
          actor: logActor,
          files: result.files,
          baseStateHash: oursState,
          expectedRefStateHash: oursState,
          parentStateHashes: [theirsState],
          ...(theirsEventId ? { parentEventIds: [theirsEventId] } : {}),
          eventKind: "state.merge_applied",
          summary: `Merge ${sourceHead} into ${targetHead}`,
        });
        this.lastState.set(sk, ingest.stateHash);
        await this.vcs.materializeState(ingest.stateHash, targetDir).catch(() => {});
        if (targetHead.startsWith("ctx:") && repoPath) {
          this.contextManager.noteMaterialized(
            targetHead.slice("ctx:".length),
            repoPath,
            ingest.stateHash
          );
        }
        const event = await this.stateAdvancedEvent({
          head: targetHead,
          previousStateHash: oursState,
          stateHash: ingest.stateHash,
          eventId: ingest.eventId,
          headHash: ingest.headHash,
          actor,
          transitionKind: "merge",
          repoPath,
        });
        this.emitter.emit("state-advanced", event);
        return {
          status: "merged",
          stateHash: ingest.stateHash,
          conflicts: [],
          mergeable: "clean",
          upstreamCommits,
        };
      }

      // Conflicted: stage the provisional (conflict-marked) tree, park the
      // pending merge, and materialize the markers into the context FS. The agent
      // resolves via vcs.edit (working ops over the provisional) and seals it with
      // vcs.commit, which consumes the pending and records the merge parents. The
      // pending is written `materialized: false` first and flipped after
      // materialize succeeds (crash-recovery invariant).
      const staged = await this.gad().call<{ stateHash: string }>("stageWorktreeState", {
        files: result.files,
        summary: `Provisional merge of ${sourceHead} into ${targetHead}`,
      });
      const pendingInfo = {
        oursStateHash: oursState,
        theirsStateHash: theirsState,
        theirsEventId,
        baseStateHash: result.baseStateHash,
        theirsHead: sourceHead,
        conflicts: result.conflicts,
        provisionalStateHash: staged.stateHash,
      };
      await this.gad().call("setPendingMerge", {
        logId,
        head: targetHead,
        info: { ...pendingInfo, materialized: false },
      });
      await this.vcs.materializeState(staged.stateHash, targetDir);
      await this.gad().call("setPendingMerge", {
        logId,
        head: targetHead,
        info: { ...pendingInfo, materialized: true },
      });
      if (targetHead.startsWith("ctx:") && repoPath) {
        this.contextManager.noteMaterialized(
          targetHead.slice("ctx:".length),
          repoPath,
          staged.stateHash
        );
      }
      await this.syncConflictSummary(targetHead, repoPath);
      return {
        status: "conflicted",
        stateHash: staged.stateHash,
        conflicts: result.conflicts,
        mergeable: "conflict",
        conflictPaths: result.conflicts.map((c) => c.path),
        upstreamCommits,
      };
    });
  }

  /** The source head's commits not yet on the target (first-parent walk from
   *  `theirs` back to `oursState`) — the structured upstream-commits list
   *  shared by `vcs.merge` and the push-divergence error. */
  private async upstreamCommitsBetween(
    oursState: string,
    theirsState: string,
    theirsEventId?: string | null
  ): Promise<
    Array<{ eventId: string; message: string; stateHash: string; createdAt: string | null }>
  > {
    if (theirsEventId) {
      return this.upstreamCommitsBetweenEvents(oursState, theirsEventId);
    }
    const out: Array<{
      eventId: string;
      message: string;
      stateHash: string;
      createdAt: string | null;
    }> = [];
    let cur: string | null = theirsState;
    for (let i = 0; i < 100; i++) {
      if (!cur || cur === oursState || cur === EMPTY_STATE_HASH) break;
      const stateHash: string = cur;
      const prod = await this.gad().call<{
        event_id?: string;
        summary?: string | null;
        input_state_hash?: string | null;
        created_at?: string | null;
      } | null>("getGadStateProducer", { stateHash });
      if (!prod?.event_id) break;
      out.push({
        eventId: String(prod.event_id),
        message: prod.summary ? String(prod.summary) : "",
        stateHash: cur,
        createdAt: prod.created_at ? String(prod.created_at) : null,
      });
      cur = prod.input_state_hash ? String(prod.input_state_hash) : null;
    }
    return out;
  }

  private async upstreamCommitsBetweenEvents(
    stopState: string,
    tipEventId: string
  ): Promise<
    Array<{ eventId: string; message: string; stateHash: string; createdAt: string | null }>
  > {
    const out: Array<{
      eventId: string;
      message: string;
      stateHash: string;
      createdAt: string | null;
    }> = [];
    let cur: string | null = tipEventId;
    for (let i = 0; i < 100; i++) {
      if (!cur) break;
      const transition = await this.gad().call<{
        output_state_hash?: string | null;
        summary?: string | null;
        created_at?: string | null;
      } | null>("getGadStateTransition", { eventId: cur });
      const stateHash = transition?.output_state_hash ? String(transition.output_state_hash) : null;
      if (!stateHash || stateHash === stopState || stateHash === EMPTY_STATE_HASH) break;
      out.push({
        eventId: cur,
        message: transition?.summary ? String(transition.summary) : "",
        stateHash,
        createdAt: transition?.created_at ? String(transition.created_at) : null,
      });
      const ancestors = await this.commitAncestors("", cur, 1);
      cur = ancestors[0]?.parentEventIds[0] ?? null;
    }
    return out;
  }
  /**
   * Write or remove the worktree merge-conflict summary for a head, driven off
   * its pending-merge record. Non-content conflicts (mode / binary /
   * delete-vs-change) leave no in-file `<<<<<<<` markers, so this file is the
   * only worktree-visible signal for CLI/agent/direct users. It is ignored by
   * snapshots (never committed) and removed when the merge resolves or aborts.
   */
  private async syncConflictSummary(head: string, repoPath?: string): Promise<void> {
    const logId = this.repoLogId(repoPath);
    const file = path.join(this.dirForRepoHead(repoPath, head), MERGE_CONFLICTS_FILE);
    const pending = this.attached
      ? (
          await this.gad().call<{
            info: { conflicts?: MergeConflict[]; theirsHead?: string } | null;
          }>("getPendingMerge", { logId, head })
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
    opts: {
      actor?: { id: string; kind: string };
      beforeAdvance?: HeadAdvanceHook;
      repoPath?: string;
    } = {}
  ): Promise<{ aborted: boolean }> {
    const repoPath = opts.repoPath;
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, targetHead);
    return this.locked(sk, async () => {
      const pending = (
        await this.gad().call<{
          info: { oursStateHash: string; provisionalStateHash: string } | null;
        }>("getPendingMerge", {
          logId,
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
          repoPath,
        });
        await opts.beforeAdvance(event);
      }
      await this.gad().call("clearPendingMerge", { logId, head: targetHead });
      await this.vcs.materializeState(
        pending.oursStateHash,
        this.dirForRepoHead(repoPath, targetHead)
      );
      await this.syncConflictSummary(targetHead, repoPath);
      this.lastState.set(sk, pending.oursStateHash);
      return { aborted: true };
    });
  }

  async pendingMerge(
    targetHead: string,
    repoPath?: string
  ): Promise<{
    theirsHead: string;
    conflicts: Array<{ path: string; kind: string }>;
  } | null> {
    const pending = (
      await this.gad().call<{
        info: { theirsHead: string; conflicts: Array<{ path: string; kind: string }> } | null;
      }>("getPendingMerge", { logId: this.repoLogId(repoPath), head: targetHead })
    ).info;
    return pending ? { theirsHead: pending.theirsHead, conflicts: pending.conflicts } : null;
  }

  // -------------------------------------------------------------------------
  // Edit → commit → push (the three-layer VCS)
  //
  // recordEdit appends per-file working edit-ops (tracked durably with full
  // provenance) over the repo's working content WITHOUT advancing the commit
  // head, building, or appearing in vcs.log — it emits `working-advanced`, not
  // `state-advanced`, and it NEVER merges (a non-applying replace is a plain
  // error; a concurrent edit/commit/merge fails the two-part CAS → recompute +
  // retry). commit folds the uncommitted ops into ONE deliberate, messaged
  // ctx-head snapshot (and owns exactly those edits, queryable both ways). main
  // advances only via push. The caller-facing service supplies `actor`/
  // `invocationId`/`turnId` from the verified caller runtime — never trusted
  // from clients.
  // -------------------------------------------------------------------------

  /**
   * Record a batch of file edits as UNCOMMITTED working edit-ops on a `ctx:*`
   * head. Appends ops over the current working content (committed base — the ctx
   * head if it exists, else the context's pinned-base slice, else `main` — plus
   * this repo's prior uncommitted ops, or a pending merge's provisional tree
   * during conflict resolution); puts new blobs in CAS; persists the rows in one
   * DO transaction with a two-part CAS (uncommitted edit_seq AND the committed
   * ctx-head state); projects the new working content to disk; emits
   * `working-advanced`. No state mint, no ref advance, no log event, no build.
   */
  async recordEdit(input: {
    head: string;
    /** Optional optimistic guard: the composed working state the author saw. */
    baseStateHash?: string;
    edits: EditOp[];
    actor: { id: string; kind: string };
    repoPath?: string;
    invocationId?: string;
    turnId?: string;
  }): Promise<RecordEditResult> {
    if (input.head === VCS_MAIN_HEAD || !input.head.startsWith("ctx:")) {
      throw new Error(
        `edit: '${input.head}' — edits target a ctx:* head; main advances only via push`
      );
    }
    const repoPath = input.repoPath;
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, input.head);
    return this.locked(sk, async () => {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        // 1. Current working content + the two-part fingerprint it depends on.
        const { base } = await this.resolveComposeBase(input.head, repoPath);
        const ctxHeadState = await this.vcs.resolveWorktreeRef(input.head, logId); // CAS anchor
        const working = await this.composeWorkingFileMap(logId, input.head, base);
        if (input.baseStateHash !== undefined) {
          const currentWorkingState = await this.stageFiles(
            [...working.files.values()],
            `working CAS base for ${input.head}`
          );
          if (currentWorkingState !== input.baseStateHash) {
            throw new Error(
              `edit CAS conflict on ${input.head}: working state ${currentWorkingState} != expected ${input.baseStateHash}`
            );
          }
        }
        // 2. Apply ops → new file map + the edit-op rows (blobs put to CAS here).
        const { files, rows: opRows } = await this.buildEditOpRows(
          new Map(working.files),
          input.edits
        );
        if (opRows.length === 0) {
          return {
            head: input.head,
            stateHash: await this.stageFiles([...files.values()], `working ${input.head}`),
            committed: false,
            status: "uncommitted",
            editSeq: working.maxEditSeq,
            changedPaths: [],
          };
        }
        const eventId = crypto.randomUUID();
        try {
          // 3. Atomic persist (single DO txn) — CAS on BOTH the uncommitted
          //    sequence AND the committed ctx-head state.
          const { editSeq } = await this.gad().call<{ editSeq: number }>("insertWorkingEditOps", {
            logId,
            head: input.head,
            actorId: input.actor.id,
            actorJson: JSON.stringify(vcsLogActor(input.actor)),
            invocationId: input.invocationId ?? null,
            turnId: input.turnId ?? null,
            eventId,
            ops: opRows,
            expectedEditSeq: working.maxEditSeq,
            expectedCommitHead: ctxHeadState ?? null,
          });
          // 4. Projection (OUTSIDE the txn): materialize the new working content.
          const stateHash = await this.stageFiles(
            [...files.values()],
            `working edit by ${input.actor.kind}:${input.actor.id} on ${input.head}`
          );
          await this.vcs
            .materializeState(stateHash, this.dirForRepoHead(repoPath, input.head))
            .catch(() => {});
          this.lastState.set(sk, stateHash);
          if (repoPath) {
            this.contextManager.noteMaterialized(
              input.head.slice("ctx:".length),
              repoPath,
              stateHash
            );
          }
          const changedPaths = repoPath
            ? opRows.map((op) => joinRepoPrefix(repoPath, op.path))
            : opRows.map((op) => op.path);
          this.emitter.emit("working-advanced", {
            head: input.head,
            repoPath,
            actor: input.actor,
            stateHash,
            baseStateHash: base,
            editSeq,
            changedPaths,
          } satisfies WorkingAdvancedEvent);
          return {
            head: input.head,
            stateHash,
            committed: false,
            status: "uncommitted",
            editSeq,
            changedPaths,
          };
        } catch (error) {
          // A concurrent edit (stale edit_seq) or commit/merge (advanced the
          // committed head) → recompute the ops against the new working content
          // and retry. Any other error propagates.
          if (error instanceof Error && error.message.includes("CAS conflict")) {
            lastErr = error;
            continue;
          }
          throw error;
        }
      }
      throw new Error(
        `edit: gave up after concurrent-edit retries on ${input.head}: ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`
      );
    });
  }

  /**
   * Commit the uncommitted edits on a `ctx:*` head as ONE deliberate, messaged
   * snapshot: compose (committed base + included ops − `exclude`) and ingest it
   * onto the ctx head, re-keying the included edit-op rows to the new commit. A
   * pending merge on the head makes this the merge-resolution commit (records the
   * additional parent + consumes the pending). `unchanged` only when no included
   * rows remain AND there is no pending merge. Mandatory message. `main` is
   * rejected (push only). Multi-repo commit loops per repo (non-atomic; atomicity
   * is push's job).
   */
  async commit(input: {
    head: string;
    repoPath: string;
    message: string;
    exclude?: string[];
    actor: { id: string; kind: string };
    invocationId?: string;
    turnId?: string;
  }): Promise<CommitEditsResult> {
    if (input.head === VCS_MAIN_HEAD || !input.head.startsWith("ctx:")) {
      throw new Error(
        `commit: '${input.head}' — commit targets a ctx:* head; main advances only via push`
      );
    }
    if (!input.message || !input.message.trim()) {
      throw new Error("commit: a message is required");
    }
    const repoPath = input.repoPath;
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, input.head);
    const exclude = new Set(input.exclude ?? []);
    return this.locked(sk, async () => {
      const pending = (
        await this.gad().call<{ info: PendingMergeInfo | null }>("getPendingMerge", {
          logId,
          head: input.head,
        })
      ).info;
      const workingRows = await this.gad().call<JsonRecord[]>("listWorkingEdits", {
        logId,
        head: input.head,
      });
      const includedRows = workingRows.filter((r) => !exclude.has(String(r["path"])));
      const ctxHead = await this.vcs.resolveWorktreeRef(input.head, logId); // CAS + lineage parent
      // unchanged ONLY when nothing is included AND no pending merge needs sealing.
      if (includedRows.length === 0 && !pending) {
        return {
          head: input.head,
          stateHash: ctxHead ?? EMPTY_STATE_HASH,
          eventId: null,
          headHash: null,
          editCount: 0,
          status: "unchanged",
          changedPaths: [],
        };
      }
      // Compose the committed file set = composeBase + INCLUDED ops only (excluded
      // paths stay at base content and keep their working rows uncommitted).
      const { base, pendingTheirs, pendingTheirsEventId } = await this.resolveComposeBase(
        input.head,
        repoPath
      );
      const lineageBase = ctxHead ?? (await this.resolveCommittedBase(input.head, repoPath));
      const baseFiles = await this.gad().call<
        Array<{ path: string; content_hash: string; mode: number }>
      >("listStateFiles", { stateHash: base });
      const files = new Map(
        baseFiles.map((f) => [f.path, { path: f.path, contentHash: f.content_hash, mode: f.mode }])
      );
      for (const r of includedRows) this.applyWorkingRowToMap(files, r);
      // Reject unresolved conflict markers (only possible while a pending merge
      // is being resolved — recordEdit never introduces markers).
      if (pending) await this.assertNoConflictMarkers(files, pending.conflicts);
      const result = await this.gad().call<{
        stateHash: string;
        eventId: string;
        headHash: string;
        committedSeq: number;
        editCount: number;
      }>("commitRepo", {
        logId,
        head: input.head,
        files: [...files.values()],
        baseStateHash: lineageBase,
        expectedCommitState: ctxHead ?? null,
        summary: input.message,
        actor: vcsLogActor(input.actor),
        invocationId: input.invocationId ?? null,
        turnId: input.turnId ?? null,
        ...(pending ? { parentStateHashes: [pendingTheirs!] } : {}),
        ...(pending && pendingTheirsEventId ? { parentEventIds: [pendingTheirsEventId] } : {}),
        includeEditRowIds: includedRows.map((r) => Number(r["id"])),
      });
      // Re-project the working content (new ctx head + any remaining excluded ops)
      // to disk. The pending (if any) is now consumed.
      await this.reprojectWorking(logId, input.head, repoPath);
      const event = await this.stateAdvancedEvent({
        head: input.head,
        previousStateHash: ctxHead ?? lineageBase,
        stateHash: result.stateHash,
        eventId: result.eventId,
        headHash: result.headHash,
        actor: input.actor,
        transitionKind: pending ? "merge-resolution" : "snapshot",
        editOps: includedRows.map((r) => this.editOpFromRow(r)),
        repoPath,
      });
      this.emitter.emit("state-advanced", event);
      return {
        head: input.head,
        stateHash: result.stateHash,
        eventId: result.eventId,
        headHash: result.headHash,
        editCount: result.editCount,
        status: "committed",
        changedPaths: event.changedPaths,
      };
    });
  }

  /**
   * Drop a repo's uncommitted edits on a head AND clear any pending merge (aborts
   * an in-progress reconcile), then re-materialize the committed ctx head to disk
   * (the "abort / stash-drop").
   */
  async discardEdits(input: {
    head: string;
    repoPath: string;
  }): Promise<{ discarded: number; stateHash: string }> {
    const repoPath = input.repoPath;
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, input.head);
    return this.locked(sk, async () => {
      const { discarded } = await this.gad().call<{ discarded: number }>("discardWorkingEdits", {
        logId,
        head: input.head,
      });
      const stateHash = await this.reprojectWorking(logId, input.head, repoPath);
      return { discarded, stateHash };
    });
  }

  // ── Working-content composition helpers ────────────────────────────────────

  /** The committed base a repo's working content composes on: the ctx head if it
   *  exists, else the context's pinned-base slice for that repo, else `main`,
   *  else the empty state. (A first edit has no ctx head; the ctx head is created
   *  at first commit.) Ignores any pending merge — see {@link resolveComposeBase}. */
  private async resolveCommittedBase(head: string, repoPath: string | undefined): Promise<string> {
    const logId = this.repoLogId(repoPath);
    const ctxHead = await this.vcs.resolveWorktreeRef(head, logId);
    if (ctxHead) return ctxHead;
    if (head.startsWith("ctx:") && repoPath) {
      const slice = await this.contextManager.pinnedRepoSlice(head.slice("ctx:".length), repoPath);
      if (slice) return slice;
    }
    return (await this.vcs.resolveWorktreeRef(VCS_MAIN_HEAD, logId)) ?? EMPTY_STATE_HASH;
  }

  /** The base the working CONTENT replays over: a pending merge's provisional
   *  (conflict-marked) tree while a reconcile is unresolved, else the committed
   *  base. Returns the merge's `theirs` tip when a pending exists (the additional
   *  commit parent). */
  private async resolveComposeBase(
    head: string,
    repoPath: string | undefined
  ): Promise<{ base: string; pendingTheirs: string | null; pendingTheirsEventId: string | null }> {
    const logId = this.repoLogId(repoPath);
    const pending = (
      await this.gad().call<{ info: PendingMergeInfo | null }>("getPendingMerge", { logId, head })
    ).info;
    if (pending) {
      return {
        base: pending.provisionalStateHash,
        pendingTheirs: pending.theirsStateHash,
        pendingTheirsEventId: pending.theirsEventId ?? null,
      };
    }
    return {
      base: await this.resolveCommittedBase(head, repoPath),
      pendingTheirs: null,
      pendingTheirsEventId: null,
    };
  }

  /** Reconstruct a repo's working content: the committed base file set with the
   *  uncommitted edit-op rows replayed in (edit_seq, ordinal) order. Returns the
   *  file map, the highest uncommitted `edit_seq` (the CAS fingerprint), and the
   *  raw rows. */
  private async composeWorkingFileMap(
    logId: string,
    head: string,
    baseStateHash: string
  ): Promise<{
    files: Map<string, { path: string; contentHash: string; mode: number }>;
    maxEditSeq: number;
    rows: JsonRecord[];
  }> {
    const baseFiles = await this.gad().call<
      Array<{ path: string; content_hash: string; mode: number }>
    >("listStateFiles", { stateHash: baseStateHash });
    const files = new Map(
      baseFiles.map((f) => [f.path, { path: f.path, contentHash: f.content_hash, mode: f.mode }])
    );
    const rows = await this.gad().call<JsonRecord[]>("listWorkingEdits", { logId, head });
    let maxEditSeq = 0;
    for (const r of rows) {
      const editSeq = Number(r["edit_seq"] ?? 0);
      if (editSeq > maxEditSeq) maxEditSeq = editSeq;
      this.applyWorkingRowToMap(files, r);
    }
    return { files, maxEditSeq, rows };
  }

  /** Apply one persisted edit-op row to a working file map (replay uses the row's
   *  post-content hash; hunks are pure provenance and never applied here). */
  private applyWorkingRowToMap(
    files: Map<string, { path: string; contentHash: string; mode: number }>,
    row: JsonRecord
  ): void {
    const kind = String(row["kind"]);
    const p = String(row["path"]);
    if (kind === "delete") {
      files.delete(p);
      return;
    }
    if (kind === "chmod") {
      const cur = files.get(p);
      if (cur) files.set(p, { ...cur, mode: Number(row["mode"] ?? cur.mode) });
      return;
    }
    const newHash = row["new_content_hash"] ? String(row["new_content_hash"]) : null;
    if (!newHash) return;
    files.set(p, {
      path: p,
      contentHash: newHash,
      mode: row["mode"] != null ? Number(row["mode"]) : (files.get(p)?.mode ?? 33188),
    });
  }

  /** Apply EditOps to a working file map → the new map + the edit-op rows to
   *  persist (kind/path/old+new hash/hunks/mode). Whole-file `write` over an
   *  existing TEXT file is diffed into hunks so fs-library edits carry the same
   *  hunk-level provenance as the agent replace/edit tool. Blobs are put to CAS. */
  private async buildEditOpRows(
    files: Map<string, { path: string; contentHash: string; mode: number }>,
    edits: EditOp[]
  ): Promise<{
    files: Map<string, { path: string; contentHash: string; mode: number }>;
    rows: Array<{
      kind: "replace" | "write" | "create" | "delete" | "chmod";
      path: string;
      oldContentHash: string | null;
      newContentHash: string | null;
      hunks?: unknown;
      mode?: number | null;
    }>;
  }> {
    const rows: Array<{
      kind: "replace" | "write" | "create" | "delete" | "chmod";
      path: string;
      oldContentHash: string | null;
      newContentHash: string | null;
      hunks?: unknown;
      mode?: number | null;
    }> = [];
    for (const op of edits) {
      // Server-boundary path guards (the client harness guard is bypassable).
      assertSafeVcsPath(op.path);
      if (op.kind === "create" || op.kind === "write") await assertWritableVcsPath(op.path);
      const before = files.get(op.path);
      const oldHash = before?.contentHash ?? null;
      if (op.kind === "delete") {
        if (!files.delete(op.path)) throw new Error(`delete: no such path ${op.path}`);
        rows.push({ kind: "delete", path: op.path, oldContentHash: oldHash, newContentHash: null });
        continue;
      }
      if (op.kind === "chmod") {
        if (!before) throw new Error(`chmod: no such path ${op.path}`);
        files.set(op.path, { ...before, mode: op.mode });
        rows.push({
          kind: "chmod",
          path: op.path,
          oldContentHash: oldHash,
          newContentHash: oldHash,
          mode: op.mode,
        });
        continue;
      }
      if (op.kind === "create" || op.kind === "write") {
        if (op.kind === "create" && before)
          throw new Error(`create: path already exists ${op.path}`);
        const bytes = bytesFromWriteContent(op.content);
        const { digest } = await putBytes(this.deps.blobsDir, bytes);
        const mode = op.mode ?? before?.mode ?? 33188;
        files.set(op.path, { path: op.path, contentHash: digest, mode });
        let hunks: unknown | undefined;
        if (op.kind === "write" && before) {
          const oldBytes = await getBytes(this.deps.blobsDir, before.contentHash);
          const oldContent = oldBytes ? readContentFromBytes(oldBytes) : null;
          const newContent = readContentFromBytes(bytes);
          if (oldContent?.kind === "text" && newContent.kind === "text") {
            const h = computeReplaceHunks(oldContent.text, newContent.text);
            if (h.length > 0) hunks = h;
          }
        }
        rows.push({
          kind: op.kind,
          path: op.path,
          oldContentHash: oldHash,
          newContentHash: digest,
          ...(hunks !== undefined ? { hunks } : {}),
          mode,
        });
        continue;
      }
      // replace — exact hunks into the current content.
      if (!before) throw new Error(`replace: no such path ${op.path}`);
      const baseBytes = await getBytes(this.deps.blobsDir, before.contentHash);
      if (!baseBytes) throw new Error(`replace: base blob missing for ${op.path}`);
      const baseContent = readContentFromBytes(baseBytes);
      if (baseContent.kind !== "text") {
        throw new Error(`replace: cannot apply text hunks to binary file ${op.path}`);
      }
      const nextText = applyReplaceHunks(baseContent.text, op.hunks);
      const { digest } = await putBytes(this.deps.blobsDir, Buffer.from(nextText, "utf8"));
      files.set(op.path, { ...before, contentHash: digest });
      rows.push({
        kind: "replace",
        path: op.path,
        oldContentHash: oldHash,
        newContentHash: digest,
        hunks: op.hunks,
      });
    }
    return { files, rows };
  }

  /** Stage a file set as a content-addressed state (no head advance). */
  private async stageFiles(
    files: Array<{ path: string; contentHash: string; mode: number }>,
    summary: string
  ): Promise<string> {
    if (files.length === 0) return EMPTY_STATE_HASH;
    return (await this.gad().call<{ stateHash: string }>("stageWorktreeState", { files, summary }))
      .stateHash;
  }

  /** Re-derive a head's working content (committed base + uncommitted ops) and
   *  materialize it to disk; returns the staged working state hash. */
  private async reprojectWorking(
    logId: string,
    head: string,
    repoPath: string | undefined
  ): Promise<string> {
    const { base } = await this.resolveComposeBase(head, repoPath);
    const working = await this.composeWorkingFileMap(logId, head, base);
    const stateHash = await this.stageFiles(
      [...working.files.values()],
      `working content for ${head}`
    );
    await this.vcs
      .materializeState(stateHash, this.dirForRepoHead(repoPath, head), { clean: true })
      .catch(() => {});
    if (head.startsWith("ctx:") && repoPath) {
      this.contextManager.noteMaterialized(head.slice("ctx:".length), repoPath, stateHash);
    }
    this.lastState.set(this.stateKey(logId, head), stateHash);
    return stateHash;
  }

  /** Map a persisted edit-op row to the `editOps` shape carried on a
   *  state-advanced event (paths re-rooted by stateAdvancedEvent). */
  private editOpFromRow(row: JsonRecord): StateAdvanceEditOp {
    return {
      kind: String(row["kind"]) as StateAdvanceEditOp["kind"],
      path: String(row["path"]),
      oldContentHash: row["old_content_hash"] ? String(row["old_content_hash"]) : null,
      newContentHash: row["new_content_hash"] ? String(row["new_content_hash"]) : null,
      ...(row["hunks_json"] ? { hunks: JSON.parse(String(row["hunks_json"])) } : {}),
      ...(row["mode"] != null ? { mode: Number(row["mode"]) } : {}),
    };
  }

  /** Reject a commit whose included content still carries conflict markers in any
   *  of the merge's conflicted paths. */
  private async assertNoConflictMarkers(
    files: Map<string, { path: string; contentHash: string; mode: number }>,
    conflicts: Array<{ path: string; kind: string }>
  ): Promise<void> {
    const markers = /^(<{7}|={7}|>{7})/m;
    for (const c of conflicts) {
      const f = files.get(c.path);
      if (!f) continue;
      const bytes = await getBytes(this.deps.blobsDir, f.contentHash);
      if (!bytes) continue;
      const content = readContentFromBytes(bytes);
      if (content.kind === "text" && markers.test(content.text)) {
        throw new Error(`commit: resolve conflict markers in ${c.path} first`);
      }
    }
  }

  /**
   * Content read at a ref (head name or `state:` hash). Returns the file
   * bytes/text PLUS the resolved `stateHash` the caller should pin as the base
   * for a subsequent `edit` (CAS). Distinct from the store's
   * `readGadFileAtState`, which returns metadata only.
   */
  async readFile(ref: string, filePath: string, repoPath?: string): Promise<VcsFileContent | null> {
    const stateHash = await this.resolveStateRef(ref, repoPath);
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
    ref: string,
    repoPath?: string
  ): Promise<Array<{ path: string; contentHash: string; mode: number }>> {
    const stateHash = await this.resolveStateRef(ref, repoPath);
    const files = await this.gad().call<
      Array<{ path: string; content_hash: string; mode: number }>
    >("listStateFiles", { stateHash });
    return files.map((f) => ({ path: f.path, contentHash: f.content_hash, mode: f.mode }));
  }

  // -------------------------------------------------------------------------
  // Traversal reads (edit/commit graph — all index-backed gad-store queries)
  // -------------------------------------------------------------------------

  /** Map a raw gad-store edit-op row to the camelCase VCS provenance shape. */
  private mapEditOpRow(row: JsonRecord): {
    id: number;
    eventId: string;
    committedEventId: string | null;
    committedSeq: number | null;
    editSeq: number | null;
    outputStateHash: string | null;
    ordinal: number;
    kind: string;
    path: string;
    oldContentHash: string | null;
    newContentHash: string | null;
    mode: number | null;
    actorId: string | null;
    invocationId: string | null;
    turnId: string | null;
    createdAt: string | null;
  } {
    const s = (v: unknown): string | null => (v == null ? null : String(v));
    const n = (v: unknown): number | null => (v == null ? null : Number(v));
    return {
      id: Number(row["id"]),
      eventId: String(row["event_id"]),
      committedEventId: s(row["committed_event_id"]),
      committedSeq: n(row["committed_seq"]),
      editSeq: n(row["edit_seq"]),
      outputStateHash: s(row["output_state_hash"]),
      ordinal: Number(row["ordinal"] ?? 0),
      kind: String(row["kind"]),
      path: String(row["path"]),
      oldContentHash: s(row["old_content_hash"]),
      newContentHash: s(row["new_content_hash"]),
      mode: n(row["mode"]),
      actorId: s(row["actor_id"]),
      invocationId: s(row["invocation_id"]),
      turnId: s(row["turn_id"]),
      createdAt: s(row["created_at"]),
    };
  }

  /** commit → the edits it owns (by commit event id), in replay order. */
  async listCommitEdits(repoPath: string, commitEventId: string) {
    const rows = await this.gad().call<JsonRecord[]>("listCommitEdits", { commitEventId });
    void repoPath; // commit event ids are globally unique; repoPath scopes the caller's intent
    return rows.map((r) => this.mapEditOpRow(r));
  }

  /** A path's edit history / blame in COMMIT-lineage order (+ uncommitted tail). */
  async fileHistory(repoPath: string, filePath: string, head?: string, limit?: number) {
    const norm = normalizeRepoPathForLog(repoPath);
    const relPath = filePath.startsWith(`${norm}/`) ? filePath.slice(norm.length + 1) : filePath;
    const rows = await this.gad().call<JsonRecord[]>("fileHistory", {
      logId: this.repoLogId(repoPath),
      path: relPath,
      ...(head ? { head } : {}),
      ...(limit ? { limit } : {}),
    });
    return rows.map((r) => this.mapEditOpRow(r));
  }

  /** Walk a commit's ancestry in the event-keyed commit DAG. */
  async commitAncestors(repoPath: string, eventId: string, limit?: number) {
    void repoPath;
    return this.gad().call<
      Array<{ eventId: string; stateHash: string | null; parentEventIds: string[] }>
    >("commitAncestors", { eventId, ...(limit ? { limit } : {}) });
  }

  /** Edits authored by an actor (author provenance), newest-lineage last. */
  async editsByActor(actorId: string, limit?: number) {
    const rows = await this.gad().call<JsonRecord[]>("editsByActor", {
      actorId,
      ...(limit ? { limit } : {}),
    });
    return rows.map((r) => this.mapEditOpRow(r));
  }

  /** Edits authored in an agent turn (causal provenance — ties VCS to the
   *  agentic trajectory). Populated when the caller supplies a turnId. */
  async editsByTurn(turnId: string) {
    const rows = await this.gad().call<JsonRecord[]>("editsByTurn", { turnId });
    return rows.map((r) => this.mapEditOpRow(r));
  }

  /** Edits authored in a single tool-call invocation (causal provenance). */
  async editsByInvocation(invocationId: string) {
    const rows = await this.gad().call<JsonRecord[]>("editsByInvocation", { invocationId });
    return rows.map((r) => this.mapEditOpRow(r));
  }

  /**
   * On-demand build of a head's WORKING content scoped to repos/units, WITHOUT
   * touching the published EV baseline (build is authoritative only at push).
   */
  async previewBuild(input: {
    head: string;
    repoPaths?: string[];
    units?: string[];
    getBuildSystem?: () => RepoPushValidator | null;
  }): Promise<RepoBuildReport[]> {
    const buildSystem = input.getBuildSystem?.();
    if (!buildSystem) return [];
    const workingView = input.head.startsWith("ctx:")
      ? await this.contextManager.resolveContextView(input.head.slice("ctx:".length))
      : (await this.workspaceView()).stateHash;
    return buildSystem.previewBuild(workingView, {
      ...(input.repoPaths ? { repoPaths: input.repoPaths } : {}),
      ...(input.units ? { units: input.units } : {}),
    });
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
    target: { stateHash?: string; eventId?: string },
    repoPath?: string
  ): Promise<string> {
    if (target.stateHash) return target.stateHash;
    if (target.eventId) {
      const events = await this.gad().call<
        Array<{ envelopeId: string; payload: Record<string, unknown> }>
      >("readLog", { logId: this.repoLogId(repoPath), head, limit: 0 });
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
   * current head via {@link edit} — a `git revert`, never a `git reset`
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
    repoPath?: string;
    invocationId?: string;
    turnId?: string;
  }): Promise<RecordEditResult> {
    const repoPath = input.repoPath;
    const afterStateHash = await this.resolveRevertTarget(input.head, input.target, repoPath);
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
      const headState = (await this.resolveHead(input.head, repoPath)) ?? afterStateHash;
      return {
        head: input.head,
        stateHash: headState,
        committed: false,
        status: "uncommitted",
        editSeq: 0,
        changedPaths: [],
      };
    }
    // A revert is a WORKING edit (inverse patch) — the user commits it later.
    // Stage it over the branch's current working content. The target state's
    // `afterStateHash` identifies what to invert; it is not the CAS base once
    // later commits exist on the branch.
    return this.recordEdit({
      head: input.head,
      edits,
      actor: input.actor,
      ...(repoPath ? { repoPath } : {}),
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
    });
  }

  /**
   * GAD state-diff of `head` against its publish lineage: the committed changes
   * unique to `head`, never upstream-only drift from `main`. Pure CAS
   * computation — there is NO worktree scan, because the on-disk tree is a
   * disposable projection of the head. If `head` is an ancestor of `main`, there
   * is nothing unpublished even though the states differ.
   */
  private async unpublishedDelta(
    head: string,
    repoPath?: string,
    mainHead: string = VCS_MAIN_HEAD
  ): Promise<{
    headStateHash: string | null;
    baseStateHash: string | null;
    diverged: boolean;
    added: string[];
    removed: string[];
    changed: string[];
  }> {
    const headStateHash = await this.resolveHead(head, repoPath);
    const baseStateHash = await this.resolveHead(mainHead, repoPath);
    if (!headStateHash || headStateHash === baseStateHash) {
      return { headStateHash, baseStateHash, diverged: false, added: [], removed: [], changed: [] };
    }

    let diffBaseStateHash: string;
    let diverged = false;
    if (!baseStateHash) {
      diffBaseStateHash = EMPTY_STATE_HASH;
    } else {
      const mergeBase =
        (
          await this.gad().call<{ baseStateHash: string | null }>("getMergeBase", {
            leftStateHash: baseStateHash,
            rightStateHash: headStateHash,
          })
        ).baseStateHash ?? EMPTY_STATE_HASH;
      diverged = mergeBase !== baseStateHash;
      // Upstream-only drift: the context head is already contained in main.
      if (mergeBase === headStateHash) {
        return { headStateHash, baseStateHash, diverged, added: [], removed: [], changed: [] };
      }
      diffBaseStateHash = mergeBase;
    }

    const diff = await this.gad().call<{
      added: Array<{ path: string }>;
      removed: Array<{ path: string }>;
      changed: Array<{ path: string }>;
    }>("diffGadStates", { leftStateHash: diffBaseStateHash, rightStateHash: headStateHash });
    return {
      headStateHash,
      baseStateHash,
      diverged,
      added: diff.added.map((file) => file.path),
      removed: diff.removed.map((file) => file.path),
      changed: diff.changed.map((file) => file.path),
    };
  }

  /**
   * Push status for a repo: how far a head is ahead of that repo's `main` (the
   * committed, unpushed changes), how many UNCOMMITTED working edits it carries
   * (push rejects while > 0), and whether `main` has DIVERGED (a fast-forward
   * push is impossible without an explicit vcs.merge). Per-repo; paths are
   * repo-relative.
   */
  async pushStatus(
    repoPath: string,
    head: string = VCS_MAIN_HEAD
  ): Promise<{
    repoPath: string;
    head: string;
    headStateHash: string | null;
    mainStateHash: string | null;
    ahead: number;
    uncommitted: number;
    diverged: boolean;
    /** The repo was deleted from the workspace (its `main` is archived/gone). A
     *  push will be refused — restore or drop the context rather than re-push. */
    deleted: boolean;
    files: Array<{ path: string; kind: "added" | "removed" | "changed" }>;
  }> {
    const delta = await this.unpublishedDelta(head, repoPath);
    const files = [
      ...delta.added.map((path) => ({ path, kind: "added" as const })),
      ...delta.removed.map((path) => ({ path, kind: "removed" as const })),
      ...delta.changed.map((path) => ({ path, kind: "changed" as const })),
    ];
    const logId = this.repoLogId(repoPath);
    const deleted =
      (await this.vcs.resolveWorktreeRef(VCS_MAIN_HEAD, logId)) === null &&
      (await this.repoWasArchived(logId));
    const uncommitted =
      head === VCS_MAIN_HEAD
        ? 0
        : (await this.gad().call<JsonRecord[]>("listWorkingEdits", { logId, head })).length;
    return {
      repoPath: normalizeRepoPathForLog(repoPath),
      head,
      headStateHash: delta.headStateHash,
      mainStateHash: delta.baseStateHash,
      ahead: files.length,
      uncommitted,
      diverged: delta.diverged,
      deleted,
      files,
    };
  }

  // -------------------------------------------------------------------------
  // Memory file indexing (WS4) — bytes live in the CAS, so the server feeds
  // changed file text to the store's FTS index after main-head advances.
  // -------------------------------------------------------------------------

  private memoryIndexQueue: Promise<void> = Promise.resolve();

  /**
   * Start incremental per-repo file indexing on a repo's `main`-head advances
   * (W8). Each repo's index is keyed by its own `memidx:<repoPath>` marker
   * (rebuilt after cache amnesia). Indexed paths are re-rooted to
   * workspace-relative so recall returns globally-addressable paths regardless
   * of which repo owns the file.
   */
  enableMemoryIndexing(): void {
    this.onStateAdvanced((event) => {
      if (event.head !== VCS_MAIN_HEAD) return;
      const repoPath = event.repoPath;
      if (!repoPath) return; // per-repo only; legacy whole-tree advances ignored
      this.memoryIndexQueue = this.memoryIndexQueue
        .then(() => this.indexRepoFiles(repoPath))
        .catch((error) => console.warn("[VcsMemory] index failed:", error));
    });
    // Catch up on whatever happened while the server was down: index each
    // discovered repo's current main.
    this.memoryIndexQueue = this.memoryIndexQueue
      .then(async () => {
        for (const repo of await this.discoverRepos()) {
          await this.indexRepoFiles(repo.repoPath).catch((error) =>
            console.warn(`[VcsMemory] initial index for ${repo.repoPath} failed:`, error)
          );
        }
      })
      .catch((error) => console.warn("[VcsMemory] initial index failed:", error));
  }

  /** Index a single repo's `main` head into the FTS index (W8). */
  async indexRepoFiles(repoPath: string): Promise<void> {
    if (!this.attached) return;
    const norm = normalizeRepoPathForLog(repoPath);
    const stateHash = await this.resolveHead(VCS_MAIN_HEAD, norm);
    if (!stateHash) return;
    const markerKey = `memidx:${norm}`;
    const marker = (
      await this.gad().call<{ value: string | null }>("getMemoryIndexMarker", { key: markerKey })
    ).value;
    if (marker === stateHash) return;

    const MAX_INDEXED_FILE_BYTES = 256 * 1024;
    const reroot = (p: string): string => joinRepoPrefix(norm, p);
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
      removedPaths = diff.removed.map((file) => reroot(file.path));
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
      files.push({
        path: reroot(file.path),
        contentHash: file.content_hash,
        text: bytes.toString("utf8"),
      });
    }
    if (files.length > 0 || removedPaths.length > 0) {
      await this.gad().call("indexMemoryFiles", { files, removedPaths });
    }
    await this.gad().call("setMemoryIndexMarker", { key: markerKey, value: stateHash });
  }

  /**
   * Provenance-carrying memory search (messages, claims, files). `repoPaths`
   * scopes file results to the selected repos; omit to search across all. The
   * prefix predicate is pushed INTO the gad-store query so `limit` bounds the
   * already-scoped result set — a post-query filter would apply `limit` first
   * and then decimate it (returning far fewer than `limit` scoped hits). The
   * client-side filter below is a redundant safety net over the same workspace-
   * relative paths, in case an older gad-store ignores `pathPrefixes`.
   */
  async recallMemory(input: {
    query: string;
    kinds?: string[];
    limit?: number;
    repoPaths?: string[];
  }): Promise<unknown> {
    const { repoPaths, ...rest } = input;
    const prefixes =
      repoPaths && repoPaths.length > 0 ? repoPaths.map((r) => normalizeRepoPathForLog(r)) : null;
    const result = (await this.gad().call("recallMemory", {
      ...rest,
      ...(prefixes ? { pathPrefixes: prefixes } : {}),
    })) as {
      results?: Array<{ path?: string | null }>;
    };
    if (!prefixes) return result;
    const within = (p: string | null | undefined): boolean =>
      typeof p === "string" && prefixes.some((pre) => p === pre || p.startsWith(`${pre}/`));
    return {
      ...result,
      results: (result.results ?? []).filter((r) => r.path == null || within(r.path)),
    };
  }

  // -------------------------------------------------------------------------
  // Workspace view — live union of repo mains (W3)
  // -------------------------------------------------------------------------

  /**
   * Enumerate the repo set from the live composed workspace view's file list
   * (build-unit repos ∪ content-only repos ∪ `meta`). Purely a function of the
   * tracked paths of every repo's `main`. An empty workspace (no repo mains)
   * composes to the empty state ⇒ no repos.
   */
  async discoverRepos(): Promise<DiscoveredRepo[]> {
    const repoStates = await this.collectRepoMainStates();
    if (repoStates.length === 0) return [];
    const composed = await this.gad().call<{ stateHash: string }>("composeRepoStates", {
      repos: repoStates,
    });
    const filePaths = (
      await this.gad().call<Array<{ path: string }>>("listStateFiles", {
        stateHash: composed.stateHash,
      })
    ).map((f) => f.path);
    return discoverRepos(filePaths);
  }

  /**
   * Severe, global-state action: permanently remove a repo from the workspace.
   * Distinct from an edit/snapshot — it does not ADVANCE a repo head, it RETIRES
   * one. The repo's `main` history is ARCHIVED (moved to a non-`main` archive
   * head — fully preserved and restorable), the repo is dropped from the composed
   * workspace view (so build discovery / materialize stop seeing it — the proper
   * close to the deletion gap that `snapshotDir` deliberately cannot infer), its
   * on-disk subtree is removed, and a synthetic `main` advance is emitted so the
   * build trigger / tree scanner re-discover without it. User approval is gated
   * upstream in the service layer (a dedicated severe per-repo capability); this
   * performs the already-authorized deletion. Idempotent only insofar as it
   * throws when the repo has no committed `main`.
   */
  /** Workspace-relative paths of repos whose build unit directly depends on
   *  `repoPath`'s unit, at a workspace state. Empty when `repoPath` is content-
   *  only (not a build unit) or has no dependents — used to gate deletion. */
  private async dependentRepoPaths(repoPath: string, atStateHash: string): Promise<string[]> {
    const graph = await this.discoverGraph(atStateHash);
    const node = graph.allNodes().find((n) => normalizeRepoPathForLog(n.relativePath) === repoPath);
    if (!node) return []; // content-only repo (not in the build graph)
    const deps = new Set<string>();
    for (const depName of graph.getReverseDeps(node.name)) {
      const depNode = graph.tryGet(depName);
      if (depNode) deps.add(normalizeRepoPathForLog(depNode.relativePath));
    }
    deps.delete(repoPath);
    return [...deps].sort();
  }

  async deleteRepo(input: {
    repoPath: string;
    actor: { id: string; kind: string };
    /** Delete even when other repos still depend on this one (their builds may
     *  break). Without it, a repo with dependents is refused. */
    force?: boolean;
    /** Authorization hook (the service layer's approval gate). Invoked once the
     *  target + its file count are known but BEFORE anything is mutated, so a
     *  throw (denial) aborts the deletion with no side effects. */
    beforeDelete?: (info: {
      repoPath: string;
      fileCount: number;
      stateHash: string;
      dependents: string[];
    }) => Promise<void>;
  }): Promise<{
    repoPath: string;
    archived: boolean;
    archiveHead: string | null;
    removedPaths: string[];
    /** Live repos that depended on the deleted one (non-empty only under force). */
    dependents: string[];
    stateHash: string;
  }> {
    if (!this.attached) throw new Error("deleteRepo requires an attached gad store");
    const repoPath = normalizeRepoPathForLog(input.repoPath);
    if (repoPath === "meta") {
      throw new Error("Refusing to delete the `meta` repo (workspace configuration).");
    }
    const logId = this.repoLogId(repoPath);
    return this.locked(this.stateKey(logId, VCS_MAIN_HEAD), async () => {
      const repoMainState = await this.vcs.resolveWorktreeRef(VCS_MAIN_HEAD, logId);
      if (!repoMainState) {
        throw new Error(
          `Cannot delete ${repoPath}: it has no committed \`main\` (not a tracked repo).`
        );
      }
      // The paths that leave the workspace (re-rooted), for the emitted advance.
      const removedPaths = (
        await this.gad().call<Array<{ path: string }>>("listStateFiles", {
          stateHash: repoMainState,
        })
      ).map((f) => joinRepoPrefix(repoPath, f.path));

      const prevView = await this.workspaceView();

      // Dependent gate: other live repos that import this one would have their
      // builds broken by the removal (deletion bypasses the push build-gate).
      // Refuse and list them unless `force` is set.
      const dependents = await this.dependentRepoPaths(repoPath, prevView.stateHash);
      if (dependents.length > 0 && !input.force) {
        throw new Error(
          `Cannot delete ${repoPath}: ${dependents.length} repo(s) depend on it ` +
            `(${dependents.join(", ")}). Their builds will break — pass force to delete anyway.`
        );
      }

      // Authorize BEFORE any mutation — a denial throws out with no side effects.
      await input.beforeDelete?.({
        repoPath,
        fileCount: removedPaths.length,
        stateHash: repoMainState,
        dependents,
      });

      // Archive history + drop the repo's `main` from the live worktree-ref set.
      const archive = await this.gad().call<{ archived: boolean; archiveHead: string | null }>(
        "archiveRepoMain",
        { logId, archiveHead: `${VCS_ARCHIVE_HEAD_PREFIX}${repoMainState}` }
      );
      this.lastState.delete(this.stateKey(logId, VCS_MAIN_HEAD));
      // Remove the repo's on-disk projection under the workspace root.
      await fsp.rm(this.dirForRepoHead(repoPath, VCS_MAIN_HEAD), { recursive: true, force: true });

      // Emit a `main` advance reflecting the removal (diff prev→next composed
      // view = the removed files) so the build trigger / tree scanner / dev mirror
      // react and the deleted units drop out of discovery.
      const nextView = await this.workspaceView();
      const event = await this.stateAdvancedEvent({
        head: VCS_MAIN_HEAD,
        previousStateHash: prevView.stateHash,
        stateHash: nextView.stateHash,
        eventId: null,
        headHash: null,
        actor: input.actor,
        transitionKind: "merge",
      });
      this.emitter.emit("state-advanced", event);

      return {
        repoPath,
        archived: archive.archived,
        archiveHead: archive.archiveHead,
        removedPaths,
        dependents,
        stateHash: nextView.stateHash,
      };
    });
  }

  /** Archived (deleted) heads for a repo log, newest first by ref update time.
   *  Non-empty iff the repo was retired via {@link deleteRepo}. */
  private async repoArchiveHeads(
    logId: string
  ): Promise<Array<{ head: string; stateHash: string }>> {
    const heads = await this.gad().call<
      Array<{ logId: string; head: string; stateHash: string; updatedAt?: string }>
    >("listWorktreeHeads", { logId });
    return heads
      .filter((head) => head.head.startsWith(VCS_ARCHIVE_HEAD_PREFIX))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .map((head) => ({ head: head.head, stateHash: head.stateHash }));
  }

  /** True if this repo log was retired via {@link deleteRepo} (has an archive
   *  head) — used to refuse silent resurrection by a stale-context push. */
  private async repoWasArchived(logId: string): Promise<boolean> {
    return (await this.repoArchiveHeads(logId)).length > 0;
  }

  /**
   * Recover a deleted repo: re-point its `main` at its most recent archive head
   * (the reverse of {@link deleteRepo}'s archival), re-materialize it on disk and
   * emit a `main` advance so build/tree re-discover it. FAILS if a live `main`
   * already exists for the path — i.e. a DIFFERENT repo was created there since
   * the deletion — rather than clobbering it. Approval is gated upstream via the
   * `beforeRestore` hook. Throws when there is nothing archived to restore.
   */
  async restoreRepo(input: {
    repoPath: string;
    actor: { id: string; kind: string };
    beforeRestore?: (info: {
      repoPath: string;
      fileCount: number;
      stateHash: string;
    }) => Promise<void>;
  }): Promise<{
    repoPath: string;
    restored: boolean;
    fromArchiveHead: string | null;
    restoredPaths: string[];
    stateHash: string;
  }> {
    if (!this.attached) throw new Error("restoreRepo requires an attached gad store");
    const repoPath = normalizeRepoPathForLog(input.repoPath);
    const logId = this.repoLogId(repoPath);
    return this.locked(this.stateKey(logId, VCS_MAIN_HEAD), async () => {
      // Concurrency guard: a different repo now occupies the path.
      if (await this.vcs.resolveWorktreeRef(VCS_MAIN_HEAD, logId)) {
        throw new Error(
          `Cannot restore ${repoPath}: a repo already occupies that path (it was re-created since deletion).`
        );
      }
      const archives = await this.repoArchiveHeads(logId);
      const newest = archives[0];
      if (!newest) {
        throw new Error(`Cannot restore ${repoPath}: no archived history found at that path.`);
      }
      const restoredPaths = (
        await this.gad().call<Array<{ path: string }>>("listStateFiles", {
          stateHash: newest.stateHash,
        })
      ).map((f) => joinRepoPrefix(repoPath, f.path));

      await input.beforeRestore?.({
        repoPath,
        fileCount: restoredPaths.length,
        stateHash: newest.stateHash,
      });

      const prevView = await this.workspaceView();
      const restore = await this.gad().call<{ restored: boolean; archiveHead: string | null }>(
        "restoreRepoMain",
        { logId, archiveHead: newest.head }
      );
      this.lastState.delete(this.stateKey(logId, VCS_MAIN_HEAD));
      // Re-materialize the repo's subtree on disk under the workspace root.
      await this.vcs.materializeState(
        newest.stateHash,
        this.dirForRepoHead(repoPath, VCS_MAIN_HEAD)
      );

      const nextView = await this.workspaceView();
      const event = await this.stateAdvancedEvent({
        head: VCS_MAIN_HEAD,
        previousStateHash: prevView.stateHash,
        stateHash: nextView.stateHash,
        eventId: null,
        headHash: null,
        actor: input.actor,
        transitionKind: "merge",
      });
      this.emitter.emit("state-advanced", event);

      return {
        repoPath,
        restored: restore.restored,
        fromArchiveHead: restore.archiveHead,
        restoredPaths,
        stateHash: nextView.stateHash,
      };
    });
  }

  /**
   * Enumerate the repo set from the ON-DISK workspace tree (not the GAD logs).
   * The bootstrap counterpart of {@link discoverRepos}: it scans the workspace
   * root so repos can be seeded into their logs before any `vcs:repo:*` `main`
   * exists. Walks each section (container sections one level deep, flat sections
   * by their own files), feeds the discovered relative file paths through the
   * shared {@link discoverRepos}, and returns the repo descriptors.
   */
  private async discoverReposFromDisk(): Promise<DiscoveredRepo[]> {
    const filePaths = await this.scanWorkspaceRepoPaths();
    return discoverRepos(filePaths);
  }

  /**
   * Collect enough workspace-relative paths from disk for {@link discoverRepos}
   * to enumerate every present repo. `discoverRepos` only needs `section/<name>`
   * (or `meta/<file>`) representatives, so we walk one level into each container
   * section and read the flat sections' immediate files — no full-tree walk.
   */
  private async scanWorkspaceRepoPaths(): Promise<string[]> {
    const root = this.deps.workspaceRoot;
    const out: string[] = [];
    let sections: import("node:fs").Dirent[];
    try {
      sections = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const section of sections) {
      if (!section.isDirectory()) continue;
      const sectionName = section.name;
      if (CONTAINER_SECTIONS.has(sectionName)) {
        let children: import("node:fs").Dirent[];
        try {
          children = await fsp.readdir(path.join(root, sectionName), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of children) {
          if (child.isDirectory()) out.push(`${sectionName}/${child.name}/.repo`);
        }
      } else if (FLAT_SECTIONS.has(sectionName)) {
        let files: import("node:fs").Dirent[];
        try {
          files = await fsp.readdir(path.join(root, sectionName), { withFileTypes: true });
        } catch {
          continue;
        }
        // A single representative file is enough; flat sections map the section
        // dir itself to one repo. Use a marker if the dir is otherwise empty.
        const file = files.find((f) => f.isFile());
        out.push(`${sectionName}/${file?.name ?? ".repo"}`);
      }
    }
    return out;
  }

  /**
   * Bootstrap on-disk: for every repo present in the workspace tree whose
   * `vcs:repo:<repoPath>` `main` is missing, snapshot that repo's subtree into
   * its own log. Replaces the old whole-tree migrate/finalize: there is no
   * `vcs:workspace` log; each repo is seeded independently and directly from the
   * working tree. Idempotent — repos that already have a `main` are skipped, and
   * a repo whose on-disk state already matches its `main` no-ops in `snapshotDir`.
   */
  async ensureRepoLogsFromDisk(): Promise<void> {
    if (!this.attached) return;
    const repos = await this.discoverReposFromDisk();
    for (const repo of repos) {
      const repoPath = repo.repoPath;
      const logId = this.repoLogId(repoPath);
      const existing = await this.vcs.resolveWorktreeRef(VCS_MAIN_HEAD, logId);
      if (existing) continue;
      const dir = this.dirForRepoHead(repoPath, VCS_MAIN_HEAD);
      const snap = await this.locked(this.stateKey(logId, VCS_MAIN_HEAD), () =>
        this.vcs.snapshotDir(dir, {
          head: VCS_MAIN_HEAD,
          logId,
          actor: SYSTEM_ACTOR,
          summary: `seed ${repoPath} from disk`,
        })
      );
      this.lastState.set(this.stateKey(logId, VCS_MAIN_HEAD), snap.stateHash);
    }
  }

  /**
   * Snapshot every present on-disk repo subtree onto that repo's `main` log.
   * Unlike {@link ensureRepoLogsFromDisk}, this does not skip repos that already
   * have `main`, so it captures out-of-band disk mutations such as Git import
   * config writes in `meta/natstack.yml`.
   */
  async snapshotRepoLogsFromDisk(
    opts: {
      summary?: string;
      actor?: { id: string; kind: string };
    } = {}
  ): Promise<void> {
    if (!this.attached) return;
    for (const repo of await this.discoverReposFromDisk()) {
      await this.commitHead(VCS_MAIN_HEAD, {
        summary: opts.summary ?? "workspace scan",
        actor: opts.actor ?? SYSTEM_ACTOR,
        repoPath: repo.repoPath,
      });
    }
  }

  /**
   * Resolve every per-repo `vcs:repo:<path>` `main` head that currently exists
   * from structured worktree-head rows. Returns `{ repoPath, stateHash }` pairs
   * for `composeRepoStates`.
   */
  private collectRepoMainStates(): Promise<Array<{ repoPath: string; stateHash: string }>> {
    return this.collectRepoHeadStates(VCS_MAIN_HEAD);
  }

  /**
   * Every repo log that has the given head (`main` or `ctx:{contextId}`), as
   * `{ repoPath, stateHash }`. This reads structured worktree-head rows instead
   * of parsing storage-encoded ref names.
   */
  private async collectRepoHeadStates(
    headName: string
  ): Promise<Array<{ repoPath: string; stateHash: string }>> {
    const heads = await this.gad().call<Array<{ logId: string; head: string; stateHash: string }>>(
      "listWorktreeHeads",
      { logIdPrefix: VCS_REPO_LOG_PREFIX, head: headName }
    );
    const out: Array<{ repoPath: string; stateHash: string }> = [];
    for (const head of heads) {
      const repoPath = repoPathFromLogId(head.logId);
      if (!repoPath) continue;
      out.push({ repoPath, stateHash: head.stateHash });
    }
    return out.sort((a, b) => a.repoPath.localeCompare(b.repoPath));
  }

  /**
   * Decompose a pinned composed workspace view into its per-repo subtree states,
   * cached by view hash (a `baseView` is immutable, so this is computed once per
   * context base).
   */
  private readonly pinnedViewCache = new Map<
    string,
    Array<{ repoPath: string; stateHash: string }>
  >();
  private async decomposePinnedView(
    baseView: string
  ): Promise<Array<{ repoPath: string; stateHash: string }>> {
    const cached = this.pinnedViewCache.get(baseView);
    if (cached) return cached;
    const files = (
      await this.gad().call<Array<{ path: string }>>("listStateFiles", { stateHash: baseView })
    ).map((f) => f.path);
    const repos = discoverRepos(files);
    const out: Array<{ repoPath: string; stateHash: string }> = [];
    for (const repo of repos) {
      const sub = await this.gad().call<{ stateHash: string }>("getSubtreeAsState", {
        stateHash: baseView,
        prefix: repo.repoPath,
      });
      out.push({ repoPath: repo.repoPath, stateHash: sub.stateHash });
    }
    // Bound the cache: decomposed views accumulate as bases change/rebase.
    if (this.pinnedViewCache.size >= 64) {
      const oldest = this.pinnedViewCache.keys().next().value;
      if (oldest !== undefined) this.pinnedViewCache.delete(oldest);
    }
    this.pinnedViewCache.set(baseView, out);
    return out;
  }

  /**
   * The live workspace view: the composed union of every repo's `main` head
   * state. A workspace-rooted state for whole-tree consumers (build discovery,
   * materialize, diff, git export). No pins, no lockfile.
   */
  async workspaceView(): Promise<{ stateHash: string }> {
    const repoStates = await this.collectRepoMainStates();
    // Empty workspace (no repo mains) composes to the empty state — there is no
    // whole-tree log to fall back to.
    if (repoStates.length === 0) return { stateHash: EMPTY_STATE_HASH };
    return await this.gad().call<{ stateHash: string }>("composeRepoStates", {
      repos: repoStates,
    });
  }

  /**
   * The composed workspace view with ONE repo overridden to a candidate state
   * (or removed when `stateHash` is null): the workspace AS IT WOULD BE if
   * `repoPath` advanced to that state. Used to give main-advance approval and
   * push validation the CANDIDATE composed view, so pre-commit checks analyze the
   * new state rather than the still-current one.
   */
  async workspaceViewWithRepoAt(repoPath: string, stateHash: string | null): Promise<string> {
    const norm = normalizeRepoPathForLog(repoPath);
    const repos = (await this.collectRepoMainStates()).filter(
      (r) => normalizeRepoPathForLog(r.repoPath) !== norm
    );
    if (stateHash) repos.push({ repoPath: norm, stateHash });
    if (repos.length === 0) return EMPTY_STATE_HASH;
    return (await this.gad().call<{ stateHash: string }>("composeRepoStates", { repos })).stateHash;
  }

  /** Materialize the live workspace view (each repo's head into its subtree)
   *  into `dir` as one composed directory with one sidecar. */
  async materializeWorkspace(dir: string): Promise<{ stateHash: string }> {
    const view = await this.workspaceView();
    await this.vcs.materializeState(view.stateHash, dir, { clean: true });
    return view;
  }

  // -------------------------------------------------------------------------
  // Push — per-repo head advance + atomic group push (W4)
  // -------------------------------------------------------------------------

  /**
   * Group push (W4): advance N repos' `main` heads atomically, gated on the
   * build. For each repo, prepare a candidate (3-way merge of its source head
   * into `main`); if any repo conflicts, abort all (no head advances). Then
   * `buildSystem.validateRepoPush` on the composed candidate view: on success,
   * commit every repo's head in one store transaction via `ingestRepoGroup`;
   * on build failure, advance none. Content-only repos skip the gate.
   *
   * `getBuildSystem` is injected by the service layer (deferred to avoid a build
   * dependency in the VCS core).
   */
  async push(input: {
    repoPaths: string[];
    sourceHead: string;
    message?: string;
    actor: { id: string; kind: string };
    beforeAdvance?: HeadAdvanceHook;
    getBuildSystem?: () => RepoPushValidator | null;
    /** Internal bounded retry after a final store CAS race. */
    _casRetry?: boolean;
  }): Promise<PushResult> {
    const sourceHead = input.sourceHead;
    const repoPaths = input.repoPaths.map((r) => normalizeRepoPathForLog(r));
    const seenRepoPaths = new Set<string>();
    for (const repoPath of repoPaths) {
      if (seenRepoPaths.has(repoPath)) {
        throw new Error(`push: duplicate repoPath "${repoPath}"`);
      }
      seenRepoPaths.add(repoPath);
    }

    // Precondition 1 — reject on uncommitted edits in any source ctx repo (the
    // source must be clean; commit or discard first).
    if (sourceHead.startsWith("ctx:")) {
      for (const repoPath of repoPaths) {
        const working = await this.gad().call<JsonRecord[]>("listWorkingEdits", {
          logId: logIdForRepo(repoPath),
          head: sourceHead,
        });
        if (working.length > 0) {
          throw new Error(
            `push: uncommitted edits in ${repoPath} — vcs.commit or vcs.discardEdits first`
          );
        }
      }
    }

    // Precondition 2 — fast-forward-only. Per repo: the ctx head must already
    // descend from `main`'s tip. If `main` diverged (concurrent commits since the
    // base), collect a structured divergence; reconciliation is an explicit
    // vcs.merge, never an auto-merge here.
    const advancing: PushAdvanceCandidate[] = [];
    const divergences: RepoDivergence[] = [];

    for (const repoPath of repoPaths) {
      const logId = logIdForRepo(repoPath);
      const oursHeadRef = await this.vcs.resolveWorktreeHead(VCS_MAIN_HEAD, logId);
      const oursState = oursHeadRef?.stateHash ?? EMPTY_STATE_HASH;
      const oursEventId = this.commitEventIdForHead(oursHeadRef, `${repoPath}:main`);
      // Deletion-resurrection guard (unchanged): a stale context cannot revive a
      // repo retired via deleteRepo.
      if (oursState === EMPTY_STATE_HASH && (await this.repoWasArchived(logId))) {
        throw new Error(
          `push: repo "${repoPath}" was deleted (its history is archived). A stale context ` +
            `cannot resurrect it by pushing. Restore it explicitly (vcs.restoreRepo) or drop/rebase ` +
            `your context.`
        );
      }
      const sourceHeadRef =
        sourceHead === VCS_MAIN_HEAD
          ? oursHeadRef
          : await this.vcs.resolveWorktreeHead(sourceHead, logId);
      const theirsState = sourceHead === VCS_MAIN_HEAD ? oursState : sourceHeadRef?.stateHash;
      const sourceEventId =
        sourceHead === VCS_MAIN_HEAD
          ? oursEventId
          : this.commitEventIdForHead(sourceHeadRef, `${repoPath}:${sourceHead}`);
      // Phantom-repo guard (unchanged).
      if (oursState === EMPTY_STATE_HASH && (!theirsState || theirsState === EMPTY_STATE_HASH)) {
        throw new Error(
          `push: unknown repo "${repoPath}" — it has no main and no content on ${sourceHead}. ` +
            `Create files under ${repoPath}/ first, then push.`
        );
      }
      // Nothing to advance for this repo.
      if (!theirsState || theirsState === oursState) continue;

      // First push of a brand-new repo (no main) is trivially fast-forwardable.
      if (oursState !== EMPTY_STATE_HASH) {
        const base =
          (
            await this.gad().call<{ baseStateHash: string | null }>("getMergeBase", {
              leftStateHash: oursState,
              rightStateHash: theirsState,
            })
          ).baseStateHash ?? EMPTY_STATE_HASH;
        if (base !== oursState) {
          // Diverged: `main` advanced past the ctx head's merge-base. Dry-run a
          // 3-way to report clean-mergeable vs conflicting (no advance, no markers).
          const engine = new MergeEngine({ blobsDir: this.deps.blobsDir, gad: this.gad() });
          const dry = await engine.compute(oursState, theirsState, {
            ours: `${repoPath}:main`,
            theirs: `${repoPath}:${sourceHead}`,
          });
          divergences.push({
            repoPath,
            base,
            mainTip: oursState,
            upstreamCommits: await this.upstreamCommitsBetween(base, oursState, oursEventId),
            mergeable: dry.status === "conflicted" ? "conflict" : "clean",
            ...(dry.status === "conflicted"
              ? { conflictPaths: dry.conflicts.map((c) => c.path) }
              : {}),
          });
          continue;
        }
      }
      // Fast-forwardable: the candidate is the ctx-head state itself.
      const files = await this.gad().call<
        Array<{ path: string; content_hash: string; mode: number }>
      >("listStateFiles", { stateHash: theirsState });
      advancing.push({
        repoPath,
        logId,
        oursState,
        sourceEventId,
        candidateState: theirsState,
        files: files.map((f) => ({ path: f.path, contentHash: f.content_hash, mode: f.mode })),
      });
    }

    // Any divergence ⇒ reject all-or-nothing with the structured error.
    if (divergences.length > 0) {
      return { status: "diverged", divergences };
    }
    if (advancing.length === 0) {
      return { status: "up-to-date", repoPaths, reports: [] };
    }

    // Build gate over the FULL composed candidate view (every repo at main, the
    // pushed repos overlaid at their ctx-head states) — the only authoritative
    // build (validateRepoPush builds + caches + recordBuilds the candidate).
    const baseStates = await this.collectRepoMainStates();
    const overlay = new Map(baseStates.map((s) => [s.repoPath, s.stateHash]));
    for (const c of advancing) overlay.set(c.repoPath, c.candidateState);
    const baseView = await this.gad().call<{ stateHash: string }>("composeRepoStates", {
      repos: baseStates,
    });
    const candidateView = await this.gad().call<{ stateHash: string }>("composeRepoStates", {
      repos: [...overlay].map(([repoPath, stateHash]) => ({ repoPath, stateHash })),
    });
    const buildSystem = input.getBuildSystem?.();
    let reports: RepoBuildReport[] = [];
    if (buildSystem) {
      reports = await buildSystem.validateRepoPush(
        advancing.map((c) => c.repoPath),
        candidateView.stateHash,
        { baseView: baseView.stateHash }
      );
      const ok = !reports.some((r) => r.required && r.status === "failed");
      if (!ok) {
        return { status: "build-failed", reports };
      }
    }

    if (input.beforeAdvance) {
      for (const c of advancing) {
        const event = await this.stateAdvancedEvent({
          head: VCS_MAIN_HEAD,
          previousStateHash: c.oursState,
          stateHash: c.candidateState,
          workspaceStateHash: candidateView.stateHash,
          eventId: null,
          headHash: null,
          actor: input.actor,
          transitionKind: "merge",
          repoPath: c.repoPath,
        });
        await input.beforeAdvance(event);
      }
    }

    // Atomically fast-forward every advancing main in ONE store transaction.
    let committed: Awaited<ReturnType<WorkspaceVcs["advanceRepoGroup"]>>;
    try {
      committed = await this.advanceRepoGroup({
        entries: advancing.map((c) => ({
          repoPath: c.repoPath,
          files: c.files,
          expectedHeadState: c.oursState,
          parentStateHash: c.candidateState,
          parentEventId: c.sourceEventId,
        })),
        ...(input.message ? { message: input.message } : {}),
        actor: input.actor,
      });
    } catch (error) {
      if (!isFinalHeadCasConflict(error)) throw error;
      const race = await this.pushRaceResult(advancing, reports);
      if (race) {
        if (race.status === "up-to-date" && sourceHead.startsWith("ctx:")) {
          await this.pinContext(sourceHead.slice("ctx:".length), candidateView.stateHash).catch(
            () => {}
          );
        }
        return race;
      }
      if (!input._casRetry) {
        return this.push({ ...input, _casRetry: true });
      }
      throw new Error("push: main changed during final advance; retry push");
    }
    const committedByRepo = new Map(
      committed.results.map((result) => [normalizeRepoPathForLog(result.repoPath), result])
    );

    // Materialize + emit per-repo `main` advances (build trigger persists the EV
    // baseline off these; the units are gate cache-hits so no rebuild).
    for (const c of advancing) {
      const committedResult = committedByRepo.get(c.repoPath);
      const committedState = committedResult?.stateHash ?? c.candidateState;
      this.lastState.set(this.stateKey(c.logId, VCS_MAIN_HEAD), committedState);
      await this.vcs
        .materializeState(committedState, this.dirForRepoHead(c.repoPath, VCS_MAIN_HEAD))
        .catch(() => {});
      const event = await this.stateAdvancedEvent({
        head: VCS_MAIN_HEAD,
        previousStateHash: c.oursState,
        stateHash: committedState,
        workspaceStateHash: candidateView.stateHash,
        eventId: committedResult?.eventId ?? null,
        headHash: committedResult?.headHash ?? null,
        actor: input.actor,
        transitionKind: "merge",
        repoPath: c.repoPath,
      });
      this.emitter.emit("state-advanced", event);
    }
    // Re-pin the context base to the freshly-pushed workspace view.
    if (sourceHead.startsWith("ctx:")) {
      await this.pinContext(sourceHead.slice("ctx:".length), candidateView.stateHash).catch(
        () => {}
      );
    }
    return { status: "pushed", repoPaths: advancing.map((c) => c.repoPath), reports };
  }

  private async pushRaceResult(
    advancing: PushAdvanceCandidate[],
    reports: RepoBuildReport[]
  ): Promise<PushResult | null> {
    const divergences: RepoDivergence[] = [];
    let allAlreadyApplied = true;
    for (const c of advancing) {
      const currentRef = await this.vcs.resolveWorktreeHead(VCS_MAIN_HEAD, c.logId);
      const currentState = currentRef?.stateHash ?? EMPTY_STATE_HASH;
      if (currentState === c.candidateState) continue;
      allAlreadyApplied = false;
      const currentEventId = this.commitEventIdForHead(currentRef, `${c.repoPath}:main`);
      const base =
        (
          await this.gad().call<{ baseStateHash: string | null }>("getMergeBase", {
            leftStateHash: currentState,
            rightStateHash: c.candidateState,
          })
        ).baseStateHash ?? EMPTY_STATE_HASH;
      if (base === currentState) continue;
      const engine = new MergeEngine({ blobsDir: this.deps.blobsDir, gad: this.gad() });
      const dry = await engine.compute(currentState, c.candidateState, {
        ours: `${c.repoPath}:main`,
        theirs: `${c.repoPath}:candidate`,
      });
      divergences.push({
        repoPath: c.repoPath,
        base,
        mainTip: currentState,
        upstreamCommits: await this.upstreamCommitsBetween(base, currentState, currentEventId),
        mergeable: dry.status === "conflicted" ? "conflict" : "clean",
        ...(dry.status === "conflicted" ? { conflictPaths: dry.conflicts.map((x) => x.path) } : {}),
      });
    }
    if (divergences.length > 0) return { status: "diverged", divergences };
    if (allAlreadyApplied) {
      return { status: "up-to-date", repoPaths: advancing.map((c) => c.repoPath), reports };
    }
    return null;
  }

  /**
   * The transaction boundary that makes groups first-class (W4). Takes per-head
   * locks for every entry's `vcs:repo:<path>` `main`, then delegates the commit
   * to the W1 `ingestRepoGroup` store primitive, which performs every entry's
   * CAS (`expectedRefStateHash`) + state-create + log-append inside ONE store
   * transaction — all heads advance or none do. Single-repo push is the
   * one-entry case.
   */
  async advanceRepoGroup(input: {
    entries: Array<{
      repoPath: string;
      files: Array<{ path: string; contentHash: string; mode: number }>;
      expectedHeadState: string;
      parentStateHash?: string | null;
      parentEventId?: string | null;
    }>;
    message?: string;
    actor: { id: string; kind: string };
  }): Promise<{
    results: Array<{ repoPath: string; stateHash: string; eventId: string; headHash: string }>;
  }> {
    // Take every per-head `main` lock (sorted, deadlock-free) around the atomic
    // store-level commit. `push` already holds these locks for the whole push, so
    // it calls {@link advanceRepoGroupUnlocked} directly to avoid re-entrancy.
    const keys = input.entries.map((e) => this.stateKey(logIdForRepo(e.repoPath), VCS_MAIN_HEAD));
    return this.lockedMany(keys, () => this.advanceRepoGroupUnlocked(input));
  }

  /** The atomic group commit WITHOUT acquiring the per-repo `main` locks — the
   *  caller must already hold them (see {@link advanceRepoGroup}/{@link push}). */
  private async advanceRepoGroupUnlocked(input: {
    entries: Array<{
      repoPath: string;
      files: Array<{ path: string; contentHash: string; mode: number }>;
      expectedHeadState: string;
      parentStateHash?: string | null;
      parentEventId?: string | null;
    }>;
    message?: string;
    actor: { id: string; kind: string };
  }): Promise<{
    results: Array<{ repoPath: string; stateHash: string; eventId: string; headHash: string }>;
  }> {
    const logActor = vcsLogActor(input.actor);
    const sorted = [...input.entries].sort((a, b) => a.repoPath.localeCompare(b.repoPath));
    const grouped = await this.gad().call<{
      results: Array<{
        logId: string;
        head: string;
        stateHash: string;
        eventId: string;
        headHash: string;
      }>;
    }>("ingestRepoGroup", {
      entries: sorted.map((entry) => ({
        logId: logIdForRepo(entry.repoPath),
        head: VCS_MAIN_HEAD,
        logKind: "vcs",
        actor: logActor,
        files: entry.files,
        baseStateHash: entry.expectedHeadState,
        expectedRefStateHash: entry.expectedHeadState,
        ...(entry.parentStateHash ? { parentStateHashes: [entry.parentStateHash] } : {}),
        ...(entry.parentEventId ? { parentEventIds: [entry.parentEventId] } : {}),
        eventKind: "state.merge_applied" as const,
        summary: input.message ?? `group push of ${entry.repoPath}`,
      })),
    });
    return {
      results: grouped.results.map((r, i) => ({
        repoPath: sorted[i]!.repoPath,
        stateHash: r.stateHash,
        eventId: r.eventId,
        headHash: r.headHash,
      })),
    };
  }

  /**
   * Coordinated multi-repo pull (W4 `mergeGroup`): merge each repo's source
   * head into its own `main`/target. Best-effort per-repo (not a single store
   * transaction — pulls are not the atomic group-push path).
   */
  async mergeGroup(
    entries: Array<{ repoPath: string; sourceHead: string; targetHead?: string }>,
    opts: { actor?: { id: string; kind: string } } = {}
  ): Promise<
    Array<{
      repoPath: string;
      status: "up-to-date" | "merged" | "conflicted";
      stateHash: string | null;
      conflicts: MergeConflict[];
    }>
  > {
    const out: Array<{
      repoPath: string;
      status: "up-to-date" | "merged" | "conflicted";
      stateHash: string | null;
      conflicts: MergeConflict[];
    }> = [];
    for (const entry of entries) {
      const result = await this.mergeHeads(entry.targetHead ?? VCS_MAIN_HEAD, entry.sourceHead, {
        ...(opts.actor ? { actor: opts.actor } : {}),
        repoPath: entry.repoPath,
      });
      out.push({
        repoPath: normalizeRepoPathForLog(entry.repoPath),
        status: result.status,
        stateHash: result.stateHash,
        conflicts: result.conflicts,
      });
    }
    return out;
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
    head: string = VCS_MAIN_HEAD,
    repoPath?: string
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
    >("readLog", { logId: this.repoLogId(repoPath), head, limit: 0 });
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
  async statusHead(
    head: string,
    repoPath?: string
  ): Promise<{
    stateHash: string | null;
    dirty: boolean;
    uncommitted: number;
    added: string[];
    removed: string[];
    changed: string[];
    /** The repo was deleted from the workspace (its `main` is archived/gone). */
    deleted: boolean;
  }> {
    const delta = await this.unpublishedDelta(head, repoPath);
    const deleted =
      repoPath != null &&
      (await this.vcs.resolveWorktreeRef(VCS_MAIN_HEAD, this.repoLogId(repoPath))) === null &&
      (await this.repoWasArchived(this.repoLogId(repoPath)));
    const uncommitted =
      head === VCS_MAIN_HEAD || repoPath == null
        ? 0
        : (
            await this.gad().call<JsonRecord[]>("listWorkingEdits", {
              logId: this.repoLogId(repoPath),
              head,
            })
          ).length;
    return {
      stateHash: delta.headStateHash,
      dirty:
        delta.added.length > 0 ||
        delta.removed.length > 0 ||
        delta.changed.length > 0 ||
        uncommitted > 0,
      uncommitted,
      added: delta.added,
      removed: delta.removed,
      changed: delta.changed,
      deleted,
    };
  }
}
