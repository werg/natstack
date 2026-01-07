/**
 * @natstack/git - Git operations for NatStack panels
 *
 * Provides git clone/pull/push operations using isomorphic-git,
 * designed to work with ZenFS OPFS backend in browser panels.
 *
 * Usage:
 * ```typescript
 * import { GitClient } from "@natstack/git";
 * import { promises as fsPromises } from "fs"; // ZenFS-shimmed in panels
 *
 * // Create git client - pass fs/promises directly
 * const git = new GitClient(fsPromises, {
 *   serverUrl: "http://localhost:63524",
 *   token: "your-token",
 * });
 *
 * // Clone a repository
 * await git.clone({
 *   url: "panels/my-panel",
 *   dir: "/src",
 *   ref: "main",
 * });
 *
 * // Make changes and push
 * await git.addAll("/src");
 * await git.commit({ dir: "/src", message: "Update" });
 * await git.push({ dir: "/src" });
 * ```
 */

export { GitClient, GitAuthError, type FsPromisesLike } from "./client.js";
export { bootstrap } from "./bootstrap.js";

export type {
  RepoArgSpec,
  NormalizedRepoArg,
  GitClientOptions,
  CloneOptions,
  PullOptions,
  PushOptions,
  CommitOptions,
  FileStatus,
  RepoStatus,
  StashEntry,
  FileDiff,
  Hunk,
  DiffLine,
  HunkSelection,
  StageHunksOptions,
  BranchInfo,
  CreateBranchOptions,
  RemoteStatus,
  GitProgress,
  BlameLine,
  FileHistoryEntry,
  BinaryDiffInfo,
  ImageDiff,
  ConflictInfo,
  ConflictMarker,
  ConflictResolution,
} from "./types.js";

export type { BootstrapConfig, BootstrapResult } from "./bootstrap.js";
