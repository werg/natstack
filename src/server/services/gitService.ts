import * as fs from "fs";
import { lstatSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { execFileSync } from "child_process";
import { resolve, join, dirname, relative, isAbsolute } from "path";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { GitServer } from "@natstack/git-server";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { CodeIdentityResolver } from "./codeIdentityResolver.js";
import { requestCapabilityPermission } from "./capabilityPermission.js";
import { INTERNAL_GIT_WRITE_CAPABILITY } from "./gitWritePermission.js";

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
  approvalQueue?: ApprovalQueue;
  grantStore?: CapabilityGrantStore;
  codeIdentityResolver?: Pick<CodeIdentityResolver, "resolveByCallerId">;
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
      getTokenForPanel: { args: z.tuple([z.string()]), policy: { allowed: ["shell", "server"] } },
      revokeTokenForPanel: { args: z.tuple([z.string()]), policy: { allowed: ["shell", "server"] } },
      resolveRef: { args: z.tuple([z.string(), z.string()]) },
      createRepo: { args: z.tuple([z.string()]) },
    },
    handler: async (ctx, method, args) => {
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
          const { absolutePath, normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);

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
            } catch (err: unknown) {
              if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
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
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
          }

          await ensureGitWritePermission(ctx, deps, normalizedRepoPath, "create repo");

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

async function ensureGitWritePermission(
  ctx: ServiceContext,
  deps: {
    approvalQueue?: ApprovalQueue;
    grantStore?: CapabilityGrantStore;
    codeIdentityResolver?: Pick<CodeIdentityResolver, "resolveByCallerId">;
  },
  repoPath: string,
  operation: string,
): Promise<void> {
  if (ctx.callerKind === "shell" || ctx.callerKind === "server") {
    return;
  }
  if (ctx.callerKind !== "panel" && ctx.callerKind !== "worker") {
    throw new Error("Git write permission is unavailable for this caller");
  }
  if (!deps.approvalQueue || !deps.grantStore || !deps.codeIdentityResolver) {
    throw new Error("Git write permission is unavailable");
  }
  const authorization = await requestCapabilityPermission({
    approvalQueue: deps.approvalQueue,
    grantStore: deps.grantStore,
    codeIdentityResolver: deps.codeIdentityResolver,
  }, {
    callerId: ctx.callerId,
    callerKind: ctx.callerKind,
    capability: INTERNAL_GIT_WRITE_CAPABILITY,
    dedupKey: null,
    resource: {
      type: "git-repo",
      label: "Repository",
      value: repoPath,
    },
    title: "Write project files",
    description: "Allow this code version to write to an internal git repository.",
    details: [
      { label: "Operation", value: operation },
    ],
    deniedReason: "Git write permission denied",
  });
  if (!authorization.allowed) {
    throw new Error(authorization.reason ?? "Git write permission denied");
  }
}

function resolveWorkspaceRepoPath(workspacePath: string, repoPath: string): {
  absolutePath: string;
  normalizedRepoPath: string;
} {
  const workspaceAbs = resolve(workspacePath);
  const absolutePath = resolve(workspaceAbs, repoPath);

  // Containment via path.relative works on Windows / POSIX and is not
  // confused by trailing slashes on workspacePath.
  const rel = relative(workspaceAbs, absolutePath);
  if (rel.length > 0 && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error("Invalid repo path: escapes workspace root");
  }

  return {
    absolutePath,
    normalizedRepoPath: rel || ".",
  };
}
