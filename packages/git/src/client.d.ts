import type { FsClient } from "isomorphic-git";
import type { GitClientOptions, CloneOptions, PullOptions, PushOptions, CommitOptions, RepoStatus } from "./types.js";
import type { FsPromisesLike } from "./fs-adapter.js";
/**
 * Input type for GitClient constructor - accepts either:
 * - A raw fs/promises-like object (e.g., from `import("fs").then(m => m.promises)`)
 * - An already-adapted isomorphic-git FsClient (PromiseFsClient or CallbackFsClient)
 */
export type GitClientFs = FsPromisesLike | FsClient;
/**
 * Git client for panel OPFS operations
 *
 * Wraps isomorphic-git with:
 * - Bearer token authentication for NatStack git server
 * - ZenFS filesystem integration (automatically adapts fs/promises)
 * - Simplified API for common operations
 *
 * @example
 * ```typescript
 * // Pass fs/promises directly - adapter is applied internally
 * import { promises as fsPromises } from "fs";
 * const git = new GitClient(fsPromises, { serverUrl, token });
 *
 * // Or pass an already-adapted FsClient
 * const fs = createFsAdapter(fsPromises);
 * const git = new GitClient(fs, { serverUrl, token });
 * ```
 */
export declare class GitClient {
    private fs;
    private http;
    private serverUrl;
    private author;
    constructor(fs: GitClientFs, options: GitClientOptions);
    /**
     * Resolve a repo path to a full URL
     * - Absolute URLs pass through unchanged
     * - Relative paths are resolved against the git server
     */
    resolveUrl(repoPath: string): string;
    /**
     * Clone a repository
     */
    clone(options: CloneOptions): Promise<void>;
    /**
     * Pull latest changes from remote
     */
    pull(options: PullOptions): Promise<void>;
    /**
     * Fetch without merging
     */
    fetch(options: {
        dir: string;
        remote?: string;
        ref?: string;
    }): Promise<void>;
    /**
     * Push changes to remote
     */
    push(options: PushOptions): Promise<void>;
    /**
     * Stage a file for commit
     */
    add(dir: string, filepath: string): Promise<void>;
    /**
     * Stage all changes
     */
    addAll(dir: string): Promise<void>;
    /**
     * Create a commit
     */
    commit(options: CommitOptions): Promise<string>;
    /**
     * Get repository status
     */
    status(dir: string): Promise<RepoStatus>;
    /**
     * Checkout a ref (branch, tag, or commit)
     */
    checkout(dir: string, ref: string): Promise<void>;
    /**
     * Get the current commit hash
     */
    getCurrentCommit(dir: string): Promise<string | null>;
    /**
     * Get the current branch name
     */
    getCurrentBranch(dir: string): Promise<string | null>;
    /**
     * Check if a directory is a git repository
     */
    isRepo(dir: string): Promise<boolean>;
    /**
     * Initialize a new repository
     */
    init(dir: string, defaultBranch?: string): Promise<void>;
    /**
     * Add a remote
     */
    addRemote(dir: string, name: string, url: string): Promise<void>;
    /**
     * List remotes
     */
    listRemotes(dir: string): Promise<Array<{
        remote: string;
        url: string;
    }>>;
    /**
     * Get log of commits
     */
    log(dir: string, options?: {
        depth?: number;
        ref?: string;
    }): Promise<Array<{
        oid: string;
        message: string;
        author: {
            name: string;
            email: string;
            timestamp: number;
        };
    }>>;
}
//# sourceMappingURL=client.d.ts.map