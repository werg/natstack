/**
 * Tool-side adapter over the server's `vcs.*` RPC surface. The file-editing
 * tools (`edit`, `write`) record UNCOMMITTED working edits through GAD's
 * edit-first `vcs.edit` rather than writing the working tree directly — disk is
 * a projection of the head, never written behind GAD's back. Deliberate
 * milestones are sealed with `vcs.commit`, and `main` advances only via
 * `vcs.push`.
 */

import { resolveToCwd } from "./path-utils.js";

/**
 * Convert a user-supplied path (relative or absolute) to a GAD path that is
 * relative to the head root. The tool's `cwd` IS the head root, so the GAD path
 * is the path *relative to* cwd — not `cwd + path`. Works for any cwd (not just
 * "/") and rejects paths that escape the root.
 */
export function toVcsPath(path: string, cwd: string): string {
  const abs = resolveToCwd(path, cwd);
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (abs === cwd || `${abs}/` === root) return "";
  if (!abs.startsWith(root)) {
    throw new Error(`Path escapes the workspace root: ${path}`);
  }
  return abs.slice(root.length);
}

export type ToolVcsEditOp =
  | {
      kind: "replace";
      path: string;
      hunks: Array<{ start: number; end: number; oldText?: string; newText: string }>;
    }
  | { kind: "write"; path: string; content: ToolVcsFileWriteContent; mode?: number }
  | { kind: "create"; path: string; content: ToolVcsFileWriteContent; mode?: number }
  | { kind: "delete"; path: string }
  | { kind: "chmod"; path: string; mode: number };

export type ToolVcsFileWriteContent =
  | { kind: "text"; text: string }
  | { kind: "bytes"; base64: string };

export type ToolVcsFileReadContent =
  | { kind: "text"; text: string }
  | { kind: "bytes"; base64: string };

/** Result of `vcs.edit` — a tracked UNCOMMITTED working edit (no commit, no build). */
export interface ToolVcsEditResult {
  head: string;
  stateHash: string;
  committed: false;
  status: "uncommitted";
  editSeq: number;
  changedPaths: string[];
}

/** Per-repo result of `vcs.commit`. */
export interface ToolVcsCommitResult {
  repoPath: string;
  head: string;
  stateHash: string;
  eventId: string | null;
  headHash: string | null;
  editCount: number;
  status: "committed" | "unchanged";
  changedPaths: string[];
}

/** Result of `vcs.push` (discriminated by status). */
export type ToolVcsPushResult =
  | { status: "pushed"; repoPaths: string[]; reports: unknown[] }
  | { status: "up-to-date"; repoPaths: string[]; reports: unknown[] }
  | { status: "diverged"; divergences: unknown[] }
  | { status: "build-failed"; reports: unknown[] };

/** Result of `vcs.merge` — a reconcile commit pulling `main` into the head. */
export interface ToolVcsMergeResult {
  status: "up-to-date" | "merged" | "conflicted";
  stateHash: string | null;
  conflicts: Array<{ path: string; kind: string }>;
  mergeable: "clean" | "conflict";
  upstreamCommits: Array<{ eventId: string; message: string; stateHash: string }>;
  conflictPaths?: string[];
}

export interface ToolVcs {
  /** Read a file at the caller's head: content + the state hash to pin. */
  readFile(path: string): Promise<{ content: ToolVcsFileReadContent; stateHash: string } | null>;
  /**
   * Record edit ops as UNCOMMITTED working changes on the caller's head (server
   * resolves head + actor). NOT a commit: no head advance, no build. Seal with
   * {@link ToolVcs.commit}.
   */
  edit(input: {
    baseStateHash?: string;
    edits: ToolVcsEditOp[];
    repoPath?: string;
    /** Authoring tool-call id — the edge from these edits into the agentic
     *  trajectory (file → edit → invocation → turn → session). The edit/write
     *  tools pass their `toolCallId`. */
    invocationId?: string;
  }): Promise<ToolVcsEditResult>;
  /** Fold the caller's uncommitted working edits into a messaged snapshot per repo. */
  commit(input: {
    message: string;
    repoPaths?: string[];
    exclude?: string[];
  }): Promise<ToolVcsCommitResult[]>;
  /** Build-gate one or more repos' committed snapshots into `main` (atomic group). */
  push(input: { repoPaths: string[]; message?: string }): Promise<ToolVcsPushResult>;
  /** Pull `main` into the caller's head on a repo (reconcile divergence). */
  merge(repoPath: string): Promise<ToolVcsMergeResult>;
  /** Drop a repo's uncommitted working edits + any pending merge on the caller's head. */
  discardEdits(repoPath: string): Promise<{ discarded: number; stateHash: string }>;
}

/** Build a {@link ToolVcs} from a main-RPC call function. */
export function createToolVcs(
  callMain: <T>(method: string, args: unknown[]) => Promise<T>
): ToolVcs {
  return {
    readFile: (path) =>
      callMain<{ content: ToolVcsFileReadContent; stateHash: string } | null>("vcs.readFile", [
        "",
        path,
      ]),
    edit: (input) => callMain<ToolVcsEditResult>("vcs.edit", [input]),
    commit: (input) => callMain<ToolVcsCommitResult[]>("vcs.commit", [input]),
    push: (input) => callMain<ToolVcsPushResult>("vcs.push", [input]),
    merge: (repoPath) => callMain<ToolVcsMergeResult>("vcs.merge", [repoPath]),
    discardEdits: (repoPath) =>
      callMain<{ discarded: number; stateHash: string }>("vcs.discardEdits", [repoPath]),
  };
}
