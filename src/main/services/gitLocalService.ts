import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import { GitClient, type FsPromisesLike } from "@natstack/git";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";

function createServiceGitClient(): GitClient {
  return new GitClient(fs as unknown as FsPromisesLike, {
    serverUrl: "",
    token: "",
  });
}

let gitClient: GitClient | null = null;

function getGitClient(): GitClient {
  if (!gitClient) {
    gitClient = createServiceGitClient();
  }
  return gitClient;
}

function validateScopedPath(scopeDir: string, filePath: string): string {
  const resolved = path.resolve(filePath);
  const resolvedScope = path.resolve(scopeDir);
  if (!resolved.startsWith(resolvedScope + path.sep) && resolved !== resolvedScope) {
    throw new Error(`Path "${filePath}" is outside allowed scope "${scopeDir}"`);
  }
  return resolved;
}

export function createGitLocalService(): ServiceDefinition {
  return {
    name: "git",
    description: "Local git+fs for shell about-pages",
    policy: { allowed: ["shell", "panel", "server"] },
    methods: {
      init: { args: z.tuple([z.string(), z.string().optional()]) },
      isRepo: { args: z.tuple([z.string()]) },
      status: { args: z.tuple([z.string()]) },
      add: { args: z.tuple([z.string(), z.string()]) },
      addAll: { args: z.tuple([z.string()]) },
      unstage: { args: z.tuple([z.string(), z.string()]) },
      stageHunks: { args: z.tuple([z.unknown()]) },
      unstageHunks: { args: z.tuple([z.unknown()]) },
      discardChanges: { args: z.tuple([z.string(), z.string()]) },
      commit: { args: z.tuple([z.unknown()]) },
      log: { args: z.tuple([z.string(), z.object({ depth: z.number().optional(), ref: z.string().optional() }).optional()]) },
      getCommitFiles: { args: z.tuple([z.string(), z.string()]) },
      getWorkingDiff: { args: z.tuple([z.string(), z.string()]) },
      getStagedDiff: { args: z.tuple([z.string(), z.string()]) },
      getCommitDiff: { args: z.tuple([z.string(), z.string(), z.string()]) },
      stash: { args: z.tuple([z.string(), z.object({ message: z.string().optional(), includeUntracked: z.boolean().optional() }).optional()]) },
      stashList: { args: z.tuple([z.string()]) },
      stashApply: { args: z.tuple([z.string(), z.number().optional()]) },
      stashPop: { args: z.tuple([z.string(), z.number().optional()]) },
      stashDrop: { args: z.tuple([z.string(), z.number().optional()]) },
      "fs.readFile": { args: z.tuple([z.string(), z.string(), z.string().optional()]) },
      "fs.writeFile": { args: z.tuple([z.string(), z.string(), z.string()]) },
      "fs.unlink": { args: z.tuple([z.string(), z.string()]) },
      "fs.readdir": { args: z.tuple([z.string(), z.string()]) },
      "fs.mkdir": { args: z.tuple([z.string(), z.string(), z.object({ recursive: z.boolean().optional() }).optional()]) },
      "fs.rmdir": { args: z.tuple([z.string(), z.string()]) },
      "fs.stat": { args: z.tuple([z.string(), z.string()]) },
    },
    handler: async (_ctx, method, args) => {
      const client = getGitClient();

      switch (method) {
        // Repository operations
        case "init": {
          const dir = args[0] as string;
          const defaultBranch = (args[1] as string) ?? "main";
          await client.init(dir, defaultBranch);
          return;
        }
        case "isRepo": {
          const dir = args[0] as string;
          return client.isRepo(dir);
        }
        case "status": {
          const dir = args[0] as string;
          return client.status(dir);
        }

        // Staging operations
        case "add": {
          const [dir, filepath] = args as [string, string];
          await client.add(dir, filepath);
          return;
        }
        case "addAll": {
          const dir = args[0] as string;
          await client.addAll(dir);
          return;
        }
        case "unstage": {
          const [dir, filepath] = args as [string, string];
          await client.unstage(dir, filepath);
          return;
        }
        case "stageHunks": {
          const options = args[0] as Parameters<GitClient["stageHunks"]>[0];
          await client.stageHunks(options);
          return;
        }
        case "unstageHunks": {
          const options = args[0] as Parameters<GitClient["unstageHunks"]>[0];
          await client.unstageHunks(options);
          return;
        }
        case "discardChanges": {
          const [dir, filepath] = args as [string, string];
          await client.discardChanges(dir, filepath);
          return;
        }

        // Commit operations
        case "commit": {
          const options = args[0] as Parameters<GitClient["commit"]>[0];
          return client.commit(options);
        }
        case "log": {
          const [dir, options] = args as [string, { depth?: number; ref?: string }?];
          return client.log(dir, options);
        }
        case "getCommitFiles": {
          const [dir, sha] = args as [string, string];
          return client.getCommitFiles(dir, sha);
        }

        // Diff operations
        case "getWorkingDiff": {
          const [dir, filepath] = args as [string, string];
          return client.getWorkingDiff(dir, filepath);
        }
        case "getStagedDiff": {
          const [dir, filepath] = args as [string, string];
          return client.getStagedDiff(dir, filepath);
        }
        case "getCommitDiff": {
          const [dir, sha, filepath] = args as [string, string, string];
          return client.getCommitDiff(dir, sha, filepath);
        }

        // Stash operations
        case "stash": {
          const [dir, options] = args as [string, { message?: string; includeUntracked?: boolean }?];
          await client.stash(dir, options);
          return;
        }
        case "stashList": {
          const dir = args[0] as string;
          return client.stashList(dir);
        }
        case "stashApply": {
          const [dir, index] = args as [string, number?];
          await client.stashApply(dir, index);
          return;
        }
        case "stashPop": {
          const [dir, index] = args as [string, number?];
          await client.stashPop(dir, index);
          return;
        }
        case "stashDrop": {
          const [dir, index] = args as [string, number?];
          await client.stashDrop(dir, index);
          return;
        }

        // Scoped filesystem operations
        case "fs.readFile": {
          const [scopeDir, filePath, encoding] = args as [string, string, BufferEncoding?];
          const resolved = validateScopedPath(scopeDir, filePath);
          if (encoding) {
            return fs.readFile(resolved, { encoding });
          }
          const buffer = await fs.readFile(resolved);
          return { __binary: true, data: buffer.toString("base64") };
        }
        case "fs.writeFile": {
          const [scopeDir, filePath, data] = args as [string, string, string];
          const resolved = validateScopedPath(scopeDir, filePath);
          await fs.writeFile(resolved, data);
          return;
        }
        case "fs.unlink": {
          const [scopeDir, filePath] = args as [string, string];
          const resolved = validateScopedPath(scopeDir, filePath);
          await fs.unlink(resolved);
          return;
        }
        case "fs.readdir": {
          const [scopeDir, dirPath] = args as [string, string];
          const resolved = validateScopedPath(scopeDir, dirPath);
          return fs.readdir(resolved);
        }
        case "fs.mkdir": {
          const [scopeDir, dirPath, options] = args as [string, string, { recursive?: boolean }?];
          const resolved = validateScopedPath(scopeDir, dirPath);
          return fs.mkdir(resolved, options);
        }
        case "fs.rmdir": {
          const [scopeDir, dirPath] = args as [string, string];
          const resolved = validateScopedPath(scopeDir, dirPath);
          await fs.rmdir(resolved);
          return;
        }
        case "fs.stat": {
          const [scopeDir, filePath] = args as [string, string];
          const resolved = validateScopedPath(scopeDir, filePath);
          const stat = await fs.stat(resolved);
          return { isDirectory: stat.isDirectory(), isFile: stat.isFile() };
        }

        default:
          throw new Error(`Unknown git service method: ${method}`);
      }
    },
  };
}
