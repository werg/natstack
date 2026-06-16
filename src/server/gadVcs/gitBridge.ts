/**
 * GAD ↔ git bridge (WS3.P3) — interchange with the outside world only.
 * The workspace's own substrate is the GAD vcs; this bridge exports a head's
 * transition history to a local git checkout (for pushing to GitHub etc.)
 * and imports a git checkout's tree back as a snapshot transition.
 *
 * Mapping discipline: every exported commit carries a `GAD-State:` trailer;
 * the last exported state per (head, gitDir) is tracked in the store's KV
 * (`gitbridge:…`), so exports are incremental and idempotent.
 *
 * Full per-commit history IMPORT (topo-walk → multi-parent transitions) is
 * intentionally not implemented: per the plan, pre-bridge history stays in
 * git; interchange needs tree-level fidelity, not historical replay.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { GitClient } from "@natstack/git";

import type { WorkspaceVcs } from "./workspaceVcs.js";
import { VCS_LOG_ID } from "./store.js";

export interface GitBridgeDeps {
  workspaceVcs: WorkspaceVcs;
}

interface ExportMarker {
  stateHash: string;
  commitSha: string;
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

  private markerKey(head: string, gitDir: string): string {
    return `gitbridge:${head}:${gitDir}`;
  }

  private async getMarker(head: string, gitDir: string): Promise<ExportMarker | null> {
    const raw = (
      await this.deps.workspaceVcs.gadCall<{ value: string | null }>("getMarker", {
        key: this.markerKey(head, gitDir),
      })
    ).value;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ExportMarker;
    } catch {
      return null;
    }
  }

  private async setMarker(head: string, gitDir: string, marker: ExportMarker): Promise<void> {
    await this.deps.workspaceVcs.gadCall("setMarker", {
      key: this.markerKey(head, gitDir),
      value: JSON.stringify(marker),
    });
  }

  /**
   * Export a head's transition history into a git checkout: one commit per
   * vcs transition since the last export, each tree materialized from the
   * CAS, with a `GAD-State:` trailer. Returns the exported commit count and
   * the final commit sha; push separately with any git tooling/remote.
   */
  async exportHead(
    head: string,
    gitDir: string,
    opts: { authorName?: string; authorEmail?: string } = {}
  ): Promise<{ exported: number; headCommit: string | null }> {
    const vcs = this.deps.workspaceVcs;
    const transitions = await vcs.readVcsLog(10_000, head); // newest first
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

    const marker = await this.getMarker(head, gitDir);
    const markerIndex = marker
      ? ordered.findIndex((entry) => entry.outputStateHash === marker.stateHash)
      : -1;
    if (marker && markerIndex < 0) {
      throw new Error(
        `Git bridge marker state ${marker.stateHash} is not present in ${head}; export into an empty checkout or reset the marker`
      );
    }
    const startIndex = marker ? markerIndex + 1 : 0;

    let exported = 0;
    let lastSha = marker?.commitSha ?? null;
    for (const entry of ordered.slice(Math.max(0, startIndex))) {
      if (!entry.outputStateHash) continue;
      // Materialize this transition's tree over the checkout (tracked files
      // only; .git is untouched because the materializer never deletes
      // untracked paths). The sidecar lives outside gitDir so cross-transition
      // deletions are applied here, yet nothing VCS-internal is committed.
      await vcs.vcs.materializeState(entry.outputStateHash, gitDir, { sidecarDir });
      await this.git.addAll(gitDir);
      const actorId =
        entry.actor && typeof entry.actor === "object" && "id" in entry.actor
          ? String((entry.actor as { id: unknown }).id)
          : "natstack";
      const message = `${entry.summary ?? "workspace transition"}\n\nGAD-State: ${entry.outputStateHash}\nGAD-Event: ${entry.envelopeId}`;
      const sha = await this.git.commit({
        dir: gitDir,
        message,
        author: {
          name: opts.authorName ?? actorId,
          email: opts.authorEmail ?? "natstack@local",
        },
      });
      lastSha = sha;
      exported += 1;
      await this.setMarker(head, gitDir, {
        stateHash: entry.outputStateHash,
        commitSha: sha,
      });
    }
    return { exported, headCommit: lastSha };
  }

  /**
   * Import a git checkout's current tree as one snapshot transition on a
   * head (e.g. after `git pull` in the checkout). Records the source commit
   * in the transition metadata.
   */
  async importTree(
    gitDir: string,
    head: string,
    opts: { summary?: string } = {}
  ): Promise<{ stateHash: string; changed: boolean }> {
    const vcs = this.deps.workspaceVcs;
    const commitSha = await this.git.getCurrentCommit(gitDir);
    const snap = await vcs.vcs.snapshotDir(gitDir, {
      head,
      actor: { id: "git-bridge", kind: "system" },
      summary: opts.summary ?? `Import from git${commitSha ? ` @ ${commitSha.slice(0, 7)}` : ""}`,
      metadata: commitSha ? { gitCommitSha: commitSha, gitDir } : { gitDir },
    });
    if (commitSha && !snap.unchanged) {
      await this.setMarker(head, gitDir, { stateHash: snap.stateHash, commitSha });
    }
    return { stateHash: snap.stateHash, changed: !snap.unchanged };
  }
}

/** Type guard helper for vcs log ids used in trailers. */
export const GIT_BRIDGE_LOG_ID = VCS_LOG_ID;
