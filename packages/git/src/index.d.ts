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
export { GitClient, type GitClientFs } from "./client.js";
export { DependencyResolver } from "./dependencies.js";
export { bootstrap, hasSource } from "./bootstrap.js";
export { createFsAdapter } from "./fs-adapter.js";
/**
 * Set git commit SHAs in globalThis for cache optimization.
 * This should be called after bootstrap() completes successfully.
 *
 * @param bootstrapResult - The result from bootstrap() containing source and dependency commits
 */
export declare function setGitCommits(bootstrapResult: {
    sourceCommit?: string;
    depCommits?: Record<string, string>;
}): void;
export type { GitDependency, ResolvedDependency, GitClientOptions, CloneOptions, PullOptions, PushOptions, CommitOptions, FileStatus, RepoStatus, } from "./types.js";
export type { BootstrapConfig, BootstrapResult } from "./bootstrap.js";
export type { FsPromisesLike } from "./fs-adapter.js";
//# sourceMappingURL=index.d.ts.map