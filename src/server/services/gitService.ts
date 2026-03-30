import * as fs from "fs";
import { mkdir, writeFile } from "fs/promises";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { GitServer } from "@natstack/git-server";
import type { TokenManager } from "@natstack/shared/tokenManager";

export function createGitService(deps: {
  gitServer: GitServer;
  tokenManager: TokenManager;
  workspacePath?: string;
}): ServiceDefinition {
  return {
    name: "git",
    description: "Git operations and scoped filesystem access for panels",
    policy: { allowed: ["shell", "panel", "server", "worker"] },
    methods: {
      getWorkspaceTree: { args: z.tuple([]) },
      listBranches: { args: z.tuple([z.string()]) },
      listCommits: { args: z.tuple([z.string(), z.string(), z.number()]) },
      getBaseUrl: { args: z.tuple([]) },
      getTokenForPanel: { args: z.tuple([z.string()]) },
      revokeTokenForPanel: { args: z.tuple([z.string()]) },
      resolveRef: { args: z.tuple([z.string(), z.string()]) },
      createRepo: { args: z.tuple([z.string()]) },
    },
    handler: async (_ctx, method, args) => {
      const g = deps.gitServer;

      switch (method) {
        case "getWorkspaceTree": return g.getWorkspaceTree();
        case "listBranches": return g.listBranches(args[0] as string);
        case "listCommits": return g.listCommits(args[0] as string, args[1] as string, args[2] as number);
        case "getBaseUrl": return g.getBaseUrl();
        case "getTokenForPanel": return g.getTokenForPanel(args[0] as string);
        case "revokeTokenForPanel": g.revokeTokenForPanel(args[0] as string); return;
        case "resolveRef": return g.resolveRef(args[0] as string, args[1] as string);

        case "createRepo": {
          const [repoPath] = args as [string];
          if (!repoPath?.trim()) throw new Error("Repo path is required");
          if (!deps.workspacePath) throw new Error("No workspace path configured");
          const absolutePath = resolve(deps.workspacePath, repoPath);
          if (!absolutePath.startsWith(deps.workspacePath + "/") && absolutePath !== deps.workspacePath) {
            throw new Error("Invalid repo path: escapes workspace root");
          }
          if (fs.existsSync(absolutePath)) throw new Error(`Path already exists: ${repoPath}`);
          await mkdir(absolutePath, { recursive: true });
          execSync("git init", { cwd: absolutePath, stdio: "pipe" });
          const repoName = repoPath.split("/").pop() ?? "project";
          await writeFile(join(absolutePath, "README.md"), `# ${repoName}\n\nA new NatStack project.\n`, "utf-8");
          execSync("git add README.md", { cwd: absolutePath, stdio: "pipe" });
          execSync('git commit -m "Initial commit"', { cwd: absolutePath, stdio: "pipe" });
          return;
        }

        default: throw new Error(`Unknown git method: ${method}`);
      }
    },
  };
}
