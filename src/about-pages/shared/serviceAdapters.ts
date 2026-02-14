/**
 * Service-backed adapters for GitClient and FsPromisesLike.
 *
 * These adapters route git and filesystem operations through the main process
 * git service via RPC, replacing direct Node.js API usage. This allows
 * about pages (git-init, dirty-repo) to work without nodeIntegration.
 */

import { rpc } from "@natstack/runtime";
import type { FsPromisesLike } from "@natstack/git";

/**
 * Create a FsPromisesLike implementation that routes through the git service.
 * All paths are validated server-side against the scope directory.
 *
 * @param scopeDir - The directory to scope all filesystem operations to
 */
export function createServiceFs(scopeDir: string): FsPromisesLike {
  return {
    async readFile(filePath: string, encoding?: BufferEncoding): Promise<Uint8Array | string> {
      const result = await rpc.call<string | { __binary: true; data: string }>(
        "main",
        "git.fs.readFile",
        scopeDir,
        filePath,
        encoding
      );
      if (typeof result === "object" && result !== null && "__binary" in result) {
        // Decode base64 binary data
        const binary = atob(result.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      }
      return result as string;
    },

    async writeFile(filePath: string, data: Uint8Array | string): Promise<void> {
      // Convert Uint8Array to string for RPC transport
      const payload = typeof data === "string" ? data : new TextDecoder().decode(data);
      await rpc.call("main", "git.fs.writeFile", scopeDir, filePath, payload);
    },

    async unlink(filePath: string): Promise<void> {
      await rpc.call("main", "git.fs.unlink", scopeDir, filePath);
    },

    async readdir(dirPath: string): Promise<string[]> {
      return rpc.call<string[]>("main", "git.fs.readdir", scopeDir, dirPath);
    },

    async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<string | undefined> {
      return rpc.call<string | undefined>("main", "git.fs.mkdir", scopeDir, dirPath, options);
    },

    async rmdir(dirPath: string): Promise<void> {
      await rpc.call("main", "git.fs.rmdir", scopeDir, dirPath);
    },

    async stat(filePath: string): Promise<{ isDirectory(): boolean; isFile(): boolean }> {
      const result = await rpc.call<{ isDirectory: boolean; isFile: boolean }>(
        "main",
        "git.fs.stat",
        scopeDir,
        filePath
      );
      return {
        isDirectory: () => result.isDirectory,
        isFile: () => result.isFile,
      };
    },
  };
}

/**
 * Create a GitClient-compatible object that routes through the git service.
 *
 * This implements the subset of GitClient methods used by GitStatusView.
 * Methods are duck-type compatible with the GitClient class interface.
 */
export function createServiceGitClient(): GitClientAdapter {
  return new GitClientAdapter();
}

/**
 * Adapter that mirrors GitClient's public API via RPC service calls.
 * Only implements methods used by GitStatusView and about pages.
 */
class GitClientAdapter {
  // Repository operations

  async init(dir: string, defaultBranch?: string): Promise<void> {
    await rpc.call("main", "git.init", dir, defaultBranch);
  }

  async isRepo(dir: string): Promise<boolean> {
    return rpc.call<boolean>("main", "git.isRepo", dir);
  }

  async status(dir: string): Promise<unknown> {
    return rpc.call("main", "git.status", dir);
  }

  // Staging operations

  async add(dir: string, filepath: string): Promise<void> {
    await rpc.call("main", "git.add", dir, filepath);
  }

  async addAll(dir: string): Promise<void> {
    await rpc.call("main", "git.addAll", dir);
  }

  async unstage(dir: string, filepath: string): Promise<void> {
    await rpc.call("main", "git.unstage", dir, filepath);
  }

  async stageHunks(options: unknown): Promise<void> {
    await rpc.call("main", "git.stageHunks", options);
  }

  async unstageHunks(options: unknown): Promise<void> {
    await rpc.call("main", "git.unstageHunks", options);
  }

  async discardChanges(dir: string, filepath: string): Promise<void> {
    await rpc.call("main", "git.discardChanges", dir, filepath);
  }

  // Commit operations

  async commit(options: unknown): Promise<string> {
    return rpc.call<string>("main", "git.commit", options);
  }

  async log(dir: string, options?: { depth?: number; ref?: string }): Promise<unknown[]> {
    return rpc.call<unknown[]>("main", "git.log", dir, options);
  }

  async getCommitFiles(dir: string, sha: string): Promise<unknown[]> {
    return rpc.call<unknown[]>("main", "git.getCommitFiles", dir, sha);
  }

  // Diff operations

  async getWorkingDiff(dir: string, filepath: string): Promise<unknown> {
    return rpc.call("main", "git.getWorkingDiff", dir, filepath);
  }

  async getStagedDiff(dir: string, filepath: string): Promise<unknown> {
    return rpc.call("main", "git.getStagedDiff", dir, filepath);
  }

  async getCommitDiff(dir: string, sha: string, filepath: string): Promise<unknown> {
    return rpc.call("main", "git.getCommitDiff", dir, sha, filepath);
  }

  // Stash operations

  async stash(dir: string, options?: { message?: string; includeUntracked?: boolean }): Promise<void> {
    await rpc.call("main", "git.stash", dir, options);
  }

  async stashList(dir: string): Promise<unknown[]> {
    return rpc.call<unknown[]>("main", "git.stashList", dir);
  }

  async stashApply(dir: string, index?: number): Promise<void> {
    await rpc.call("main", "git.stashApply", dir, index);
  }

  async stashPop(dir: string, index?: number): Promise<void> {
    await rpc.call("main", "git.stashPop", dir, index);
  }

  async stashDrop(dir: string, index?: number): Promise<void> {
    await rpc.call("main", "git.stashDrop", dir, index);
  }
}
