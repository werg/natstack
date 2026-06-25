/**
 * GAD ↔ git bridge (WS3.P3) — interchange with the outside world only.
 * The workspace's own substrate is the GAD vcs; this bridge exports a head's
 * transition history to a local git checkout (for pushing to GitHub etc.)
 * and imports a git checkout's tree back as a snapshot transition.
 *
 * Per-repo distribution (W7): each workspace repo (`packages/foo`,
 * `panels/chat`, `projects/<vault>`, `meta`) has its own GAD log
 * `vcs:repo:<repoPath>` and its own `.git/` under `workspace/<repoPath>`. The
 * bridge ships ONE repo log at a time — never a composed/whole-tree export.
 * `exportRepoHead`/`importRepoTree` are thin wrappers over the generic
 * `(logId, head, gitDir)`-keyed export/import below.
 *
 * Mapping discipline: every exported commit carries a `GAD-State:` trailer and
 * (for per-repo exports) a `GAD-Repo:` trailer, so a commit unambiguously
 * identifies its repo log + state. The last exported state per
 * (logId, head, gitDir) is tracked in the store's KV (`gitbridge:…`), so
 * exports are incremental and idempotent.
 *
 * Full per-commit history IMPORT (topo-walk → multi-parent transitions) is
 * intentionally not implemented: per the plan, pre-bridge history stays in
 * git; interchange needs tree-level fidelity, not historical replay.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { GitClient } from "@natstack/git";

import type { WorkspaceVcs } from "./workspaceVcs.js";
import {
  VCS_MAIN_HEAD,
  logIdForRepo,
  normalizeRepoPathForLog,
  vcsLogActor,
  type VcsActor,
} from "./store.js";

export interface GitBridgeDeps {
  workspaceVcs: WorkspaceVcs;
  /**
   * The user's live workspace directory. Required for the per-repo wrappers
   * (`exportRepoHead`/`importRepoTree`) which derive each repo's checkout as
   * `workspace/<repoPath>` (its own `.git/`).
   */
  workspaceRoot?: string;
}

interface ExportMarker {
  stateHash: string;
  commitSha: string;
}

/** A raw vcs transition read off a per-repo log. */
interface VcsTransition {
  seq: number;
  envelopeId: string;
  actor: unknown;
  summary: string | null;
  outputStateHash: string | null;
}

const fsLike = {
  readFile: (p: string, encoding?: BufferEncoding) =>
    encoding ? fsp.readFile(p, encoding) : fsp.readFile(p),
  writeFile: (p: string, data: Uint8Array | string) => fsp.writeFile(p, data),
  unlink: (p: string) => fsp.unlink(p),
  readdir: (p: string) => fsp.readdir(p),
  mkdir: (p: string, options?: { recursive?: boolean }) => fsp.mkdir(p, options),
  rmdir: (p: string) => fsp.rmdir(p),
  stat: (p: string) => fsp.stat(p),
  lstat: (p: string) => fsp.lstat(p),
  symlink: (target: string, p: string) => fsp.symlink(target, p),
  readlink: (p: string) => fsp.readlink(p),
} as never;

export interface ExportResult {
  exported: number;
  headCommit: string | null;
}

export interface ImportResult {
  stateHash: string;
  changed: boolean;
}

export class GitBridge {
  private readonly git: GitClient;

  constructor(private readonly deps: GitBridgeDeps) {
    this.git = new GitClient(fsLike, {
      // Local-only operations; network interchange (push/pull) is done by
      // the caller's own git tooling or a credentialed http client.
      http: {
        request: () => {
          throw new Error("GitBridge is local-only; push/pull with external tooling");
        },
      } as never,
    });
  }

  // -------------------------------------------------------------------------
  // Markers (per logId+head+gitDir)
  // -------------------------------------------------------------------------

  /**
   * Marker key. Keyed by the owning vcs log so two repos exporting to sibling
   * checkouts never collide: `gitbridge:<vcs:repo:repoPath>:<gitDir>`.
   */
  private markerKey(logId: string, gitDir: string): string {
    return `gitbridge:${logId}:${gitDir}`;
  }

  private async getMarker(logId: string, gitDir: string): Promise<ExportMarker | null> {
    const raw = (
      await this.deps.workspaceVcs.gadCall<{ value: string | null }>("getMarker", {
        key: this.markerKey(logId, gitDir),
      })
    ).value;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ExportMarker;
    } catch {
      return null;
    }
  }

  private async setMarker(logId: string, gitDir: string, marker: ExportMarker): Promise<void> {
    await this.deps.workspaceVcs.gadCall("setMarker", {
      key: this.markerKey(logId, gitDir),
      value: JSON.stringify(marker),
    });
  }

  // -------------------------------------------------------------------------
  // Per-repo wrappers (W7) — the public per-repo distribution surface.
  // -------------------------------------------------------------------------

  /**
   * Export ONE repo's head into its own git checkout. Targets exactly the repo
   * log `vcs:repo:<repoPath>` at `branch` (default `main`); the checkout is the
   * repo's own dir `workspace/<repoPath>` (its `.git/`). Each commit carries a
   * `GAD-Repo: <repoPath>` trailer alongside the `GAD-State:` trailer. Never
   * composes the workspace — strictly per-repo.
   */
  async exportRepoHead(
    repoPath: string,
    branch = VCS_MAIN_HEAD,
    opts: { authorName?: string; authorEmail?: string } = {}
  ): Promise<ExportResult> {
    const normalized = normalizeRepoPathForLog(repoPath);
    const logId = logIdForRepo(normalized);
    const gitDir = this.repoGitDir(normalized);
    return this.exportLog({ logId, head: branch, gitDir, repoPath: normalized, ...opts });
  }

  /**
   * Import ONE repo's current git tree as a snapshot transition on its repo log
   * `vcs:repo:<repoPath>` `main`. The checkout is `workspace/<repoPath>`.
   * Mirror of {@link exportRepoHead}.
   */
  async importRepoTree(
    repoPath: string,
    branch = VCS_MAIN_HEAD,
    opts: { summary?: string } = {}
  ): Promise<ImportResult> {
    const normalized = normalizeRepoPathForLog(repoPath);
    const logId = logIdForRepo(normalized);
    const gitDir = this.repoGitDir(normalized);
    return this.importLog({ logId, head: branch, gitDir, repoPath: normalized, ...opts });
  }

  /** `workspace/<repoPath>` — a repo's own checkout dir (its `.git/`). */
  private repoGitDir(repoPath: string): string {
    if (!this.deps.workspaceRoot) {
      throw new Error("GitBridge needs workspaceRoot for per-repo export/import");
    }
    return path.join(this.deps.workspaceRoot, ...repoPath.split("/"));
  }

  // -------------------------------------------------------------------------
  // Generic (logId, head, gitDir)-keyed export/import — shared core.
  // -------------------------------------------------------------------------

  private async exportLog(args: {
    logId: string;
    head: string;
    gitDir: string;
    repoPath?: string;
    authorName?: string;
    authorEmail?: string;
  }): Promise<ExportResult> {
    const { logId, head, gitDir, repoPath } = args;
    const vcs = this.deps.workspaceVcs;
    const transitions = await this.readLog(logId, head); // newest first
    const ordered = [...transitions].reverse();

    // Initialize the checkout when absent.
    let initialized = true;
    try {
      await fsp.access(path.join(gitDir, ".git"));
    } catch {
      initialized = false;
    }
    if (!initialized) {
      await fsp.mkdir(gitDir, { recursive: true });
      await this.git.init(gitDir, "main");
    }

    // Keep the materialize sidecar OUTSIDE the checkout: it must persist across
    // exports so cross-transition deletions are detected and applied to gitDir,
    // but it must never enter a git commit. A sibling dir satisfies both.
    const sidecarDir = `${gitDir}.gad-sidecar`;
    await fsp.mkdir(sidecarDir, { recursive: true });

    const marker = await this.getMarker(logId, gitDir);
    const markerIndex = marker
      ? ordered.findIndex((entry) => entry.outputStateHash === marker.stateHash)
      : -1;
    if (marker && markerIndex < 0) {
      throw new Error(
        `Git bridge marker state ${marker.stateHash} is not present in ${logId}#${head}; export into an empty checkout or reset the marker`
      );
    }
    const startIndex = marker ? markerIndex + 1 : 0;

    let exported = 0;
    let lastSha = marker?.commitSha ?? null;
    for (const entry of ordered.slice(Math.max(0, startIndex))) {
      if (!entry.outputStateHash) continue;
      // Materialize this transition's tree over the checkout (tracked files
      // only; .git is untouched because the materializer never deletes
      // untracked paths). materializeState is keyed by stateHash alone, so it
      // is log-agnostic — the per-repo state subtree materializes verbatim. The
      // sidecar lives outside gitDir so cross-transition deletions are applied
      // here, yet nothing VCS-internal is committed.
      await vcs.vcs.materializeState(entry.outputStateHash, gitDir, { sidecarDir });
      await this.git.addAll(gitDir);
      const actorId =
        entry.actor && typeof entry.actor === "object" && "id" in entry.actor
          ? String((entry.actor as { id: unknown }).id)
          : "natstack";
      const trailers = [`GAD-State: ${entry.outputStateHash}`, `GAD-Event: ${entry.envelopeId}`];
      if (repoPath) trailers.unshift(`GAD-Repo: ${repoPath}`);
      const message = `${entry.summary ?? "workspace transition"}\n\n${trailers.join("\n")}`;
      const sha = await this.git.commit({
        dir: gitDir,
        message,
        author: {
          name: args.authorName ?? actorId,
          email: args.authorEmail ?? "natstack@local",
        },
      });
      lastSha = sha;
      exported += 1;
      await this.setMarker(logId, gitDir, {
        stateHash: entry.outputStateHash,
        commitSha: sha,
      });
    }
    return { exported, headCommit: lastSha };
  }

  private async importLog(args: {
    logId: string;
    head: string;
    gitDir: string;
    repoPath?: string;
    summary?: string;
  }): Promise<ImportResult> {
    const { logId, head, gitDir, repoPath } = args;
    const vcs = this.deps.workspaceVcs;
    const commitSha = await this.git.getCurrentCommit(gitDir);

    // Scan + hash the checkout entirely locally (blobs enter the CAS). This is
    // log-agnostic — `localState` does not touch any log — so we can ingest the
    // resulting state onto the specific repo log here.
    const local = await vcs.vcs.localState(gitDir);
    const refStateHash = await this.resolveLogHeadState(logId, head);
    if (refStateHash && refStateHash === local.stateHash) {
      return { stateHash: refStateHash, changed: false };
    }

    const summary =
      args.summary ??
      `Import ${repoPath ? `${repoPath} ` : ""}from git${commitSha ? ` @ ${commitSha.slice(0, 7)}` : ""}`;
    const actor: VcsActor = { id: "git-bridge", kind: "system" };
    const metadata: Record<string, unknown> = { gitDir };
    if (commitSha) metadata["gitCommitSha"] = commitSha;
    if (repoPath) metadata["repoPath"] = repoPath;

    const result = await vcs.gadCall<{ stateHash: string }>("ingestWorktreeState", {
      logId,
      head,
      logKind: "vcs",
      actor: vcsLogActor(actor),
      files: local.files.map((file) => ({
        path: file.path,
        contentHash: file.contentHash,
        size: file.size,
        mode: file.mode,
      })),
      summary,
      metadata,
    });

    if (commitSha) {
      await this.setMarker(logId, gitDir, { stateHash: result.stateHash, commitSha });
    }
    return { stateHash: result.stateHash, changed: true };
  }

  // -------------------------------------------------------------------------
  // Low-level log reads (per logId, so per-repo logs are first-class).
  // -------------------------------------------------------------------------

  /** Snapshot/merge transitions for `logId`#`head`, newest first. */
  private async readLog(logId: string, head: string): Promise<VcsTransition[]> {
    const events = await this.deps.workspaceVcs.gadCall<
      Array<{
        seq: number;
        envelopeId: string;
        actor: unknown;
        payloadKind: string;
        payload: Record<string, unknown>;
      }>
    >("readLog", { logId, head, limit: 0 });
    return events
      .filter(
        (event) =>
          event.payloadKind === "state.snapshot_ingested" ||
          event.payloadKind === "state.merge_applied"
      )
      .map((event) => ({
        seq: event.seq,
        envelopeId: event.envelopeId,
        actor: event.actor,
        summary: typeof event.payload["summary"] === "string" ? event.payload["summary"] : null,
        outputStateHash:
          typeof event.payload["outputStateHash"] === "string"
            ? event.payload["outputStateHash"]
            : null,
      }))
      .reverse(); // newest first
  }

  /** Current state hash at `logId`#`head`, or null if the head is unborn. */
  private async resolveLogHeadState(logId: string, head: string): Promise<string | null> {
    const resolved = await this.deps.workspaceVcs.gadCall<{ stateHash?: string } | null>(
      "resolveWorktreeHead",
      { logId, head }
    );
    return resolved?.stateHash ?? null;
  }
}
