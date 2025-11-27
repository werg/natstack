import git from "isomorphic-git";
import type { FsClient, HttpClient, GitHttpRequest, GitHttpResponse } from "isomorphic-git";
import type {
  GitClientOptions,
  CloneOptions,
  PullOptions,
  PushOptions,
  CommitOptions,
  RepoStatus,
  FileStatus,
} from "./types.js";
import type { FsPromisesLike } from "./fs-adapter.js";
import { createFsAdapter } from "./fs-adapter.js";

/**
 * HTTP client for isomorphic-git with bearer token auth
 */
function createHttpClient(token: string): HttpClient {
  return {
    async request(request: GitHttpRequest): Promise<GitHttpResponse> {
      const { url, method = "GET", headers = {}, body } = request;

      // Add bearer token to all requests
      const authHeaders: Record<string, string> = {
        ...headers,
        Authorization: `Bearer ${token}`,
      };

      // Convert body if it's an async iterable
      let requestBody: Uint8Array | undefined;
      if (body) {
        if (body instanceof Uint8Array) {
          requestBody = body;
        } else {
          // Collect async iterable into single buffer
          const chunks: Uint8Array[] = [];
          for await (const chunk of body) {
            chunks.push(chunk);
          }
          const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
          const result = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
          }
          requestBody = result;
        }
      }

      const response = await fetch(url, {
        method,
        headers: authHeaders,
        body: requestBody as BodyInit | undefined,
      });

      // Convert response body to async iterable
      const responseBody = response.body
        ? toAsyncIterable(response.body)
        : (async function* () {})();

      return {
        url: response.url,
        method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      };
    },
  };
}

/**
 * Convert ReadableStream to AsyncIterableIterator
 */
async function* toAsyncIterable(
  stream: ReadableStream<Uint8Array>
): AsyncIterableIterator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Input type for GitClient constructor - accepts either:
 * - A raw fs/promises-like object (e.g., from `import("fs").then(m => m.promises)`)
 * - An already-adapted isomorphic-git FsClient (PromiseFsClient or CallbackFsClient)
 */
export type GitClientFs = FsPromisesLike | FsClient;

/**
 * Check if the input is already an FsClient (has `promises` property with readFile)
 * vs a raw fs/promises object (has methods like readFile directly on it)
 */
function isFsClient(fs: GitClientFs): fs is FsClient {
  // FsClient (PromiseFsClient) has a `promises` object with fs methods
  // FsPromisesLike has fs methods directly on the object (readFile, mkdir, etc.)
  const maybePromises = (fs as { promises?: { readFile?: unknown } }).promises;
  return maybePromises !== undefined && typeof maybePromises.readFile === "function";
}

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
export class GitClient {
  private fs: FsClient;
  private http: HttpClient;
  private serverUrl: string;
  private author: { name: string; email: string };

  constructor(fs: GitClientFs, options: GitClientOptions) {
    // Auto-adapt if given raw fs/promises, otherwise use as-is
    this.fs = isFsClient(fs) ? fs : createFsAdapter(fs);
    this.serverUrl = options.serverUrl;
    this.http = createHttpClient(options.token);
    this.author = options.author ?? {
      name: "NatStack Panel",
      email: "panel@natstack.local",
    };
  }

  /**
   * Resolve a repo path to a full URL
   * - Absolute URLs pass through unchanged
   * - Relative paths are resolved against the git server
   */
  resolveUrl(repoPath: string): string {
    if (repoPath.startsWith("http://") || repoPath.startsWith("https://")) {
      return repoPath;
    }
    // Remove leading slash if present
    const cleanPath = repoPath.startsWith("/") ? repoPath.slice(1) : repoPath;
    return `${this.serverUrl}/${cleanPath}`;
  }

  /**
   * Clone a repository
   */
  async clone(options: CloneOptions): Promise<void> {
    const url = this.resolveUrl(options.url);

    await git.clone({
      fs: this.fs,
      http: this.http,
      dir: options.dir,
      url,
      ref: options.ref,
      singleBranch: options.singleBranch ?? true,
      depth: options.depth ?? 1,
      // Don't fail if ref doesn't exist - we'll checkout after
      noCheckout: !!options.ref,
    });

    // If a specific ref was requested, checkout to it
    if (options.ref) {
      try {
        await git.checkout({
          fs: this.fs,
          dir: options.dir,
          ref: options.ref,
        });
      } catch {
        // If checkout fails, the ref might be a commit hash
        // Try to checkout by commit directly
        await git.checkout({
          fs: this.fs,
          dir: options.dir,
          ref: options.ref,
          force: true,
        });
      }
    }
  }

  /**
   * Pull latest changes from remote
   */
  async pull(options: PullOptions): Promise<void> {
    const author = options.author ?? this.author;

    await git.pull({
      fs: this.fs,
      http: this.http,
      dir: options.dir,
      remote: options.remote ?? "origin",
      ref: options.ref,
      singleBranch: true,
      author,
    });
  }

  /**
   * Fetch without merging
   */
  async fetch(options: { dir: string; remote?: string; ref?: string }): Promise<void> {
    await git.fetch({
      fs: this.fs,
      http: this.http,
      dir: options.dir,
      remote: options.remote ?? "origin",
      ref: options.ref,
      singleBranch: true,
    });
  }

  /**
   * Push changes to remote
   */
  async push(options: PushOptions): Promise<void> {
    await git.push({
      fs: this.fs,
      http: this.http,
      dir: options.dir,
      remote: options.remote ?? "origin",
      ref: options.ref,
      force: options.force ?? false,
    });
  }

  /**
   * Stage a file for commit
   */
  async add(dir: string, filepath: string): Promise<void> {
    await git.add({
      fs: this.fs,
      dir,
      filepath,
    });
  }

  /**
   * Stage all changes
   */
  async addAll(dir: string): Promise<void> {
    // Get status to find all changed files
    const status = await this.status(dir);

    for (const file of status.files) {
      if (file.status === "deleted") {
        await git.remove({
          fs: this.fs,
          dir,
          filepath: file.path,
        });
      } else if (file.status !== "unmodified" && file.status !== "ignored") {
        await git.add({
          fs: this.fs,
          dir,
          filepath: file.path,
        });
      }
    }
  }

  /**
   * Create a commit
   */
  async commit(options: CommitOptions): Promise<string> {
    const author = options.author ?? this.author;

    const sha = await git.commit({
      fs: this.fs,
      dir: options.dir,
      message: options.message,
      author,
    });

    return sha;
  }

  /**
   * Get repository status
   */
  async status(dir: string): Promise<RepoStatus> {
    // Get current branch
    let branch: string | null = null;
    try {
      const branchResult = await git.currentBranch({
        fs: this.fs,
        dir,
        fullname: false,
      });
      branch = branchResult ?? null;
    } catch {
      // Might be in detached HEAD state
    }

    // Get current commit
    let commit: string | null = null;
    try {
      commit = await git.resolveRef({
        fs: this.fs,
        dir,
        ref: "HEAD",
      });
    } catch {
      // Empty repo
    }

    // Get file statuses
    const matrix = await git.statusMatrix({
      fs: this.fs,
      dir,
    });

    const files: FileStatus[] = matrix.map(([filepath, head, workdir, stage]) => {
      // Status matrix: [filepath, HEAD, WORKDIR, STAGE]
      // Values: 0 = absent, 1 = identical to HEAD, 2 = different from HEAD

      let status: FileStatus["status"];
      let staged = false;

      if (head === 0 && workdir === 2 && stage === 0) {
        status = "untracked";
      } else if (head === 0 && workdir === 2 && stage === 2) {
        status = "added";
        staged = true;
      } else if (head === 1 && workdir === 0 && stage === 0) {
        status = "deleted";
        staged = true;
      } else if (head === 1 && workdir === 0 && stage === 1) {
        status = "deleted";
      } else if (head === 1 && workdir === 2 && stage === 1) {
        status = "modified";
      } else if (head === 1 && workdir === 2 && stage === 2) {
        status = "modified";
        staged = true;
      } else if (head === 1 && workdir === 2 && stage === 3) {
        status = "modified";
        staged = true;
      } else if (head === 1 && workdir === 1 && stage === 1) {
        status = "unmodified";
      } else {
        status = "unmodified";
      }

      return {
        path: filepath,
        status,
        staged,
      };
    });

    const dirty = files.some(
      (f) => f.status !== "unmodified" && f.status !== "ignored"
    );

    return {
      branch,
      commit,
      dirty,
      files,
    };
  }

  /**
   * Checkout a ref (branch, tag, or commit)
   */
  async checkout(dir: string, ref: string): Promise<void> {
    await git.checkout({
      fs: this.fs,
      dir,
      ref,
    });
  }

  /**
   * Get the current commit hash
   */
  async getCurrentCommit(dir: string): Promise<string | null> {
    try {
      return await git.resolveRef({
        fs: this.fs,
        dir,
        ref: "HEAD",
      });
    } catch {
      return null;
    }
  }

  /**
   * Get the current branch name
   */
  async getCurrentBranch(dir: string): Promise<string | null> {
    try {
      const result = await git.currentBranch({
        fs: this.fs,
        dir,
        fullname: false,
      });
      return result ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Check if a directory is a git repository
   */
  async isRepo(dir: string): Promise<boolean> {
    try {
      await git.findRoot({
        fs: this.fs,
        filepath: dir,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Initialize a new repository
   */
  async init(dir: string, defaultBranch: string = "main"): Promise<void> {
    await git.init({
      fs: this.fs,
      dir,
      defaultBranch,
    });
  }

  /**
   * Add a remote
   */
  async addRemote(
    dir: string,
    name: string,
    url: string
  ): Promise<void> {
    await git.addRemote({
      fs: this.fs,
      dir,
      remote: name,
      url: this.resolveUrl(url),
    });
  }

  /**
   * List remotes
   */
  async listRemotes(dir: string): Promise<Array<{ remote: string; url: string }>> {
    return git.listRemotes({
      fs: this.fs,
      dir,
    });
  }

  /**
   * Get log of commits
   */
  async log(
    dir: string,
    options?: { depth?: number; ref?: string }
  ): Promise<Array<{ oid: string; message: string; author: { name: string; email: string; timestamp: number } }>> {
    const commits = await git.log({
      fs: this.fs,
      dir,
      depth: options?.depth ?? 10,
      ref: options?.ref ?? "HEAD",
    });

    return commits.map((c) => ({
      oid: c.oid,
      message: c.commit.message,
      author: {
        name: c.commit.author.name,
        email: c.commit.author.email,
        timestamp: c.commit.author.timestamp,
      },
    }));
  }
}
