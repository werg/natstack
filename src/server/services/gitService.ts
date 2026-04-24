import * as fs from "fs";
import { lstatSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { execFileSync } from "child_process";
import { resolve, join, dirname, relative, isAbsolute } from "path";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { GitServer } from "@natstack/git-server";
import type { TokenManager } from "@natstack/shared/tokenManager";

/**
 * Allowed characters in user-supplied git refs/paths. Disallow anything that
 * could be interpreted as a flag or shell metacharacter; reject leading "-"
 * separately. This is a strict subset of git's full ref grammar — sufficient
 * for our use cases (branches, tags, panel paths) and rejects common attack
 * shapes like `--upload-pack=…`, `--exec=…`.
 */
const SAFE_REF_RE = /^[A-Za-z0-9._/@-]+$/;

function assertSafeRef(ref: string, label = "ref"): string {
  if (!ref || ref.startsWith("-") || !SAFE_REF_RE.test(ref)) {
    throw new Error(`Invalid ${label}: ${ref}`);
  }
  return ref;
}

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
        case "listCommits": {
          const repoPath = args[0] as string;
          const ref = args[1] as string;
          assertSafeRef(ref);
          return g.listCommits(repoPath, ref, args[2] as number);
        }
        case "getBaseUrl": return g.getBaseUrl();
        case "getTokenForPanel": return g.getTokenForPanel(args[0] as string);
        case "revokeTokenForPanel": g.revokeTokenForPanel(args[0] as string); return;
        case "resolveRef": {
          const repoPath = args[0] as string;
          const ref = args[1] as string;
          if (ref) assertSafeRef(ref);
          return g.resolveRef(repoPath, ref);
        }

        case "createRepo": {
          const [repoPath] = args as [string];
          if (!repoPath?.trim()) throw new Error("Repo path is required");
          if (!deps.workspacePath) throw new Error("No workspace path configured");

          const absolutePath = resolve(deps.workspacePath, repoPath);

          // Containment via path.relative — works on Windows / POSIX, not
          // confused by trailing slashes on workspacePath.
          const rel = relative(deps.workspacePath, absolutePath);
          if (rel.length > 0 && (rel.startsWith("..") || isAbsolute(rel))) {
            throw new Error("Invalid repo path: escapes workspace root");
          }

          if (fs.existsSync(absolutePath)) throw new Error(`Path already exists: ${repoPath}`);

          // Symlink-safety: refuse to create the repo if the parent (or, in the
          // race-y case, the target itself) is a symlink. A symlinked parent
          // would let `git init` (and our subsequent writes) escape the
          // workspace tree. Walk every existing ancestor up to workspacePath.
          let current = dirname(absolutePath);
          const workspaceAbs = resolve(deps.workspacePath);
          while (current.length >= workspaceAbs.length) {
            try {
              const st = lstatSync(current);
              if (st.isSymbolicLink()) {
                throw new Error(`Refusing to createRepo: ancestor "${current}" is a symlink`);
              }
            } catch (err: any) {
              if (err?.code === "ENOENT") {
                // not yet created — fine
              } else {
                throw err;
              }
            }
            if (current === workspaceAbs) break;
            const next = dirname(current);
            if (next === current) break;
            current = next;
          }
          // Also lstat the target (race window: pre-existing symlink at the
          // exact target path, even though existsSync above followed links).
          try {
            const tStat = lstatSync(absolutePath);
            if (tStat.isSymbolicLink()) {
              throw new Error(`Refusing to createRepo: target "${absolutePath}" is a symlink`);
            }
          } catch (err: any) {
            if (err?.code !== "ENOENT") throw err;
          }

          await mkdir(absolutePath, { recursive: true });
          // Use execFileSync (no shell) for every git invocation. Even though
          // current command strings are constant, this prevents future
          // interpolation regressions from becoming RCE.
          execFileSync("git", ["init"], { cwd: absolutePath, stdio: "pipe" });
          const repoName = repoPath.split("/").pop() ?? "project";
          await writeFile(join(absolutePath, "README.md"), `# ${repoName}\n\nA new NatStack project.\n`, "utf-8");
          execFileSync("git", ["add", "--", "README.md"], { cwd: absolutePath, stdio: "pipe" });
          execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: absolutePath, stdio: "pipe" });
          return;
        }

        default: throw new Error(`Unknown git method: ${method}`);
      }
    },
  };
}
