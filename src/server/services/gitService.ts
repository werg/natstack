import * as fs from "fs";
import { lstatSync } from "fs";
import * as fsPromises from "fs/promises";
import { readFile, mkdir, writeFile } from "fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "path";
import YAML from "yaml";
import { GitClient } from "@natstack/git";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServiceContext, VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { GitServer } from "@natstack/git-server";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { WorkspaceConfig, WorkspaceGitRemoteConfig } from "@natstack/shared/workspace/types";
import type { ContextFolderManager } from "@natstack/shared/contextFolderManager";
import type { EntityCache } from "@natstack/shared/runtime/entityCache";
import {
  getDeclaredRemoteForRepo,
  normalizeRemoteUrl,
  normalizeWorkspaceRepoPath,
  removeDeclaredRemoteFromConfig,
  setDeclaredRemoteInConfig,
  syncDeclaredRemoteForRepo,
  validateWorkspaceGitRemote,
  validateWorkspaceGitRemoteName,
} from "@natstack/shared/workspace/remotes";
import { WORKSPACE_IMPORT_PARENT_DIRS } from "@natstack/shared/workspace/sourceDirs";
import { execGitFileAsync } from "@natstack/shared/gitRuntime";
import { gitMethods } from "@natstack/shared/serviceSchemas/git";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { EgressProxy } from "./egressProxy.js";
import { requestCapabilityPermission } from "./capabilityPermission.js";
import { INTERNAL_GIT_WRITE_CAPABILITY } from "./gitCapabilities.js";
import { deleteDynamicProperty } from "../../lintHelpers";

/**
 * Allowed characters in user-supplied git refs/paths. Disallow anything that
 * could be interpreted as a flag or shell metacharacter; reject leading "-"
 * separately. This is a strict subset of git's full ref grammar — sufficient
 * for our use cases (branches, tags, panel paths) and rejects common attack
 * shapes like `--upload-pack=…`, `--exec=…`.
 */
const SAFE_REF_RE = /^[A-Za-z0-9._/@-]+$/;
const SHARED_GIT_REMOTE_CAPABILITY = "workspace-shared-git-remote";
const PROJECT_IMPORT_CAPABILITY = "workspace-project-import";

type GitServiceDeps = {
  gitServer: GitServer;
  tokenManager: TokenManager;
  workspacePath?: string;
  workspaceConfig?: WorkspaceConfig;
  contextFolderManager?: Pick<
    ContextFolderManager,
    "ensureContextFolder" | "getContextRoot" | "syncDeclaredRemotes" | "ensureRepoPresentInContexts"
  >;
  entityCache?: Pick<EntityCache, "resolveContext" | "listActive">;
  egressProxy?: Pick<EgressProxy, "forwardGitHttp">;
  approvalQueue?: ApprovalQueue;
  grantStore?: CapabilityGrantStore;
};

type WorkspaceTreeNode = {
  path: string;
  isGitRepo: boolean;
  children: WorkspaceTreeNode[];
};

type ImportWorkspaceRepoRequest = {
  path: string;
  remote: WorkspaceGitRemoteConfig;
  credentialId?: string;
};

type ImportedWorkspaceRepo = {
  path: string;
  remote: WorkspaceGitRemoteConfig;
};

type CompleteWorkspaceDependenciesResult = {
  imported: ImportedWorkspaceRepo[];
  skipped: Array<{
    path: string;
    reason: "already-present" | "unsupported-path";
  }>;
  failed: Array<{
    path: string;
    error: string;
  }>;
};

function assertSafeRef(ref: string, label = "ref"): string {
  if (!ref || ref.startsWith("-") || !SAFE_REF_RE.test(ref)) {
    throw new Error(`Invalid ${label}: ${ref}`);
  }
  return ref;
}

export function createGitService(deps: GitServiceDeps): ServiceDefinition {
  return {
    name: "git",
    description: "Git operations and scoped filesystem access for panels",
    policy: { allowed: ["shell", "panel", "app", "server", "worker", "do", "extension"] },
    methods: gitMethods,
    handler: async (ctx, method, args) => {
      const g = deps.gitServer;

      switch (method) {
        case "getWorkspaceTree":
          return g.getWorkspaceTree();
        case "findRepoForPath": {
          const inputPath = normalizeWorkspaceRepoPath(args[0] as string);
          const tree = await g.getWorkspaceTree();
          const repos = [...collectWorkspaceRepoPaths(tree.children as WorkspaceTreeNode[])].sort(
            (a, b) => b.length - a.length
          );
          const repoPath = repos.find(
            (repo) => inputPath === repo || inputPath.startsWith(`${repo}/`)
          );
          if (!repoPath) return null;
          return {
            repoPath,
            relativePath: inputPath === repoPath ? "" : inputPath.slice(repoPath.length + 1),
          };
        }
        case "status":
          return g.status(args[0] as string);
        case "contextStatus": {
          const { contextId, rest } = splitExplicitContextArgs(ctx, args);
          return contextGitStatus(ctx, deps, rest[0] as string, contextId);
        }
        case "contextAddAll": {
          const { contextId, rest } = splitExplicitContextArgs(ctx, args);
          return contextGitAddAll(ctx, deps, rest[0] as string, contextId);
        }
        case "contextDiff": {
          const { contextId, rest } = splitExplicitContextArgs(ctx, args);
          return contextGitDiff(
            ctx,
            deps,
            rest[0] as string,
            rest[1] as { staged?: boolean } | undefined,
            contextId
          );
        }
        case "contextCommit": {
          const { contextId, rest } = splitExplicitContextArgs(ctx, args);
          return contextGitCommit(ctx, deps, rest[0] as string, rest[1] as string, contextId);
        }
        case "listBranches":
          return g.listBranches(args[0] as string);
        case "listCommits": {
          const repoPath = args[0] as string;
          const ref = args[1] as string;
          assertSafeRef(ref);
          return g.listCommits(repoPath, ref, args[2] as number);
        }
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
          const { absolutePath, normalizedRepoPath } = resolveWorkspaceRepoPath(
            deps.workspacePath,
            repoPath
          );

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

          await ensureRepoCreatePermission(ctx, deps, normalizedRepoPath);

          await mkdir(absolutePath, { recursive: true });
          // Use execFileSync (no shell) for every git invocation. Even though
          // current command strings are constant, this prevents future
          // interpolation regressions from becoming RCE.
          await execGitFileAsync(["init"], { cwd: absolutePath });
          const repoName = repoPath.split("/").pop() ?? "project";
          await writeFile(
            join(absolutePath, "README.md"),
            `# ${repoName}\n\nA new NatStack project.\n`,
            "utf-8"
          );
          await execGitFileAsync(["add", "--", "README.md"], { cwd: absolutePath });
          await execGitFileAsync(["commit", "-m", "Initial commit"], { cwd: absolutePath });
          if (deps.workspaceConfig) {
            await syncDeclaredRemoteForRepo({
              config: deps.workspaceConfig,
              workspaceRoot: deps.workspacePath,
              repoPath: normalizedRepoPath,
            });
          }
          return;
        }

        case "setSharedRemote": {
          const [repoPath, remoteInput] = args as [string, WorkspaceGitRemoteConfig];
          if (!deps.workspacePath) throw new Error("No workspace path configured");
          if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
          const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
          const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
          const normalizedRemote = validateWorkspaceGitRemote(remoteInput);

          await ensureSharedRemotePermission(ctx, deps, validRepoPath, "set", normalizedRemote);
          const nextConfig = setDeclaredRemoteInConfig(
            deps.workspaceConfig,
            validRepoPath,
            normalizedRemote
          );
          await persistWorkspaceConfigChange(deps.workspacePath, deps.workspaceConfig, nextConfig, {
            message: `Configure shared remote for ${validRepoPath}`,
          });
          await propagateSharedRemote(deps, validRepoPath);
          return nextConfig.git?.remotes;
        }

        case "removeSharedRemote": {
          const [repoPath, remoteName] = args as [string, string];
          if (!deps.workspacePath) throw new Error("No workspace path configured");
          if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
          const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
          const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
          const existing = getRemoteForApproval(deps.workspaceConfig, validRepoPath, remoteName);

          await ensureSharedRemotePermission(ctx, deps, validRepoPath, "remove", existing);
          const nextConfig = removeDeclaredRemoteFromConfig(
            deps.workspaceConfig,
            validRepoPath,
            remoteName
          );
          await persistWorkspaceConfigChange(deps.workspacePath, deps.workspaceConfig, nextConfig, {
            message: `Remove shared remote ${remoteName} for ${validRepoPath}`,
          });
          await propagateSharedRemote(deps, validRepoPath);
          return nextConfig.git?.remotes;
        }

        case "importProject": {
          const [request] = args as [ImportWorkspaceRepoRequest];
          return importWorkspaceRepo(ctx, deps, request);
        }

        case "completeWorkspaceDependencies": {
          const [options] = args as [{ credentialId?: string } | undefined];
          return completeWorkspaceDependencies(ctx, deps, options);
        }

        case "ensureRepoPresentInContexts": {
          const [repoPath] = args as [string];
          const validRepoPath = normalizeWorkspaceRepoPath(repoPath);
          await deps.contextFolderManager?.ensureRepoPresentInContexts(validRepoPath);
          return { ensured: validRepoPath };
        }

        default:
          throw new Error(`Unknown git method: ${method}`);
      }
    },
  };
}

async function completeWorkspaceDependencies(
  ctx: ServiceContext,
  deps: GitServiceDeps,
  options: { credentialId?: string } | undefined
): Promise<CompleteWorkspaceDependenciesResult> {
  if (!deps.workspacePath) throw new Error("No workspace path configured");
  if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");

  const tree = await deps.gitServer.getWorkspaceTree();
  const existingRepos = collectWorkspaceRepoPaths(tree.children as WorkspaceTreeNode[]);
  const configuredRemotes = listConfiguredWorkspaceRemotes(deps.workspaceConfig);
  const result: CompleteWorkspaceDependenciesResult = {
    imported: [],
    skipped: [],
    failed: [],
  };

  for (const dependency of configuredRemotes) {
    if (!isSupportedImportRepoPath(dependency.path)) {
      result.skipped.push({ path: dependency.path, reason: "unsupported-path" });
      continue;
    }
    if (existingRepos.has(dependency.path)) {
      result.skipped.push({ path: dependency.path, reason: "already-present" });
      continue;
    }
    try {
      const imported = await importWorkspaceRepo(ctx, deps, {
        path: dependency.path,
        remote: dependency.remote,
        credentialId: options?.credentialId,
      });
      result.imported.push(imported);
      existingRepos.add(imported.path);
    } catch (err) {
      result.failed.push({
        path: dependency.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

function listConfiguredWorkspaceRemotes(config: WorkspaceConfig): Array<{
  path: string;
  remote: WorkspaceGitRemoteConfig;
}> {
  const entries: Array<{ path: string; remote: WorkspaceGitRemoteConfig }> = [];
  for (const [section, repos] of Object.entries(config.git?.remotes ?? {})) {
    for (const [repoKey, repoRemotes] of Object.entries(repos ?? {})) {
      if (!repoRemotes) continue;
      const repoPath = normalizeWorkspaceRepoPath(`${section}/${repoKey}`);
      const remotes = Object.entries(repoRemotes)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([name, url]) => validateWorkspaceGitRemote({ name, url }))
        .sort((a, b) => {
          if (a.name === "origin") return -1;
          if (b.name === "origin") return 1;
          return a.name.localeCompare(b.name);
        });
      const cloneRemote = remotes[0];
      if (cloneRemote) {
        entries.push({
          path: repoPath,
          remote: cloneRemote,
        });
      }
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function collectWorkspaceRepoPaths(nodes: WorkspaceTreeNode[]): Set<string> {
  const repos = new Set<string>();
  for (const node of nodes) {
    if (node.isGitRepo) {
      repos.add(node.path);
    }
    for (const childPath of collectWorkspaceRepoPaths(node.children)) {
      repos.add(childPath);
    }
  }
  return repos;
}

type ContextRepoStatus = {
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  files: Array<{
    path: string;
    status: "unmodified" | "modified" | "added" | "deleted" | "untracked" | "ignored";
    staged: boolean;
    unstaged: boolean;
  }>;
};

/** Caller kinds without a context-bound entity: they name the context explicitly. */
const EXPLICIT_CONTEXT_CALLER_KINDS = new Set(["server", "shell", "harness"]);

/**
 * For server/shell/harness callers the first argument of a context git call is
 * the contextId (same convention as fs.*); entity-bound callers (panel, app,
 * worker, do, extension) resolve their context from the EntityCache instead.
 */
function splitExplicitContextArgs(
  ctx: ServiceContext,
  args: unknown[]
): { contextId?: string; rest: unknown[] } {
  if (!EXPLICIT_CONTEXT_CALLER_KINDS.has(ctx.caller.runtime.kind)) {
    return { rest: args };
  }
  const [contextId, ...rest] = args;
  if (typeof contextId !== "string" || !contextId) {
    throw new Error(
      `${ctx.caller.runtime.kind} context git calls must provide contextId as first argument`
    );
  }
  return { contextId, rest };
}

async function resolveContextRepoDir(
  ctx: ServiceContext,
  deps: GitServiceDeps,
  repoPathInput: string,
  explicitContextId?: string
): Promise<{ repoPath: string; repoDir: string }> {
  if (!deps.contextFolderManager || !deps.entityCache) {
    throw new Error("Context git operations are unavailable");
  }

  let contextId: string;
  if (explicitContextId !== undefined) {
    // Shell/harness callers may only address contexts that already exist (a
    // context folder on disk, or an active entity bound to the context);
    // server callers are trusted to create contexts. Mirrors fsService.
    if (ctx.caller.runtime.kind !== "server") {
      const known =
        deps.contextFolderManager.getContextRoot(explicitContextId) !== null ||
        deps.entityCache.listActive().some((record) => record.contextId === explicitContextId);
      if (!known) {
        throw new Error(`Unknown contextId: ${explicitContextId}`);
      }
    }
    contextId = explicitContextId;
  } else {
    const contextCallerId =
      ctx.caller.runtime.kind === "extension" && ctx.chainCaller
        ? ctx.chainCaller.callerId
        : ctx.caller.runtime.id;
    const resolved = deps.entityCache.resolveContext(contextCallerId);
    if (!resolved) {
      throw new Error(`No context registered for caller ${contextCallerId}`);
    }
    contextId = resolved;
  }

  const repoPath = normalizeWorkspaceRepoPath(repoPathInput);
  const contextRoot = await deps.contextFolderManager.ensureContextFolder(contextId);
  const repoDir = resolve(contextRoot, repoPath);
  const rel = relative(resolve(contextRoot), repoDir);
  if (rel.length > 0 && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error("Invalid repo path: escapes context root");
  }

  return { repoPath, repoDir };
}

async function contextGitStatus(
  ctx: ServiceContext,
  deps: GitServiceDeps,
  repoPathInput: string,
  explicitContextId?: string
): Promise<ContextRepoStatus> {
  const { repoDir } = await resolveContextRepoDir(ctx, deps, repoPathInput, explicitContextId);
  const [branchResult, commitResult, porcelain] = await Promise.allSettled([
    runContextGit(repoDir, ["branch", "--show-current"]),
    runContextGit(repoDir, ["rev-parse", "--verify", "HEAD"]),
    runContextGit(repoDir, ["status", "--porcelain=v1"]),
  ]);

  const branch =
    branchResult.status === "fulfilled" && branchResult.value.trim()
      ? branchResult.value.trim()
      : null;
  const commit =
    commitResult.status === "fulfilled" && commitResult.value.trim()
      ? commitResult.value.trim()
      : null;
  const statusOutput = porcelain.status === "fulfilled" ? porcelain.value : "";
  const files = statusOutput
    .split("\n")
    .filter(Boolean)
    .map((line) => porcelainLineToFileStatus(line));

  return {
    branch,
    commit,
    dirty: files.length > 0,
    files,
  };
}

async function contextGitAddAll(
  ctx: ServiceContext,
  deps: GitServiceDeps,
  repoPathInput: string,
  explicitContextId?: string
): Promise<void> {
  const { repoDir } = await resolveContextRepoDir(ctx, deps, repoPathInput, explicitContextId);
  await execGitFileAsync(["add", "-A", "--", "."], { cwd: repoDir });
}

async function contextGitDiff(
  ctx: ServiceContext,
  deps: GitServiceDeps,
  repoPathInput: string,
  options?: { staged?: boolean },
  explicitContextId?: string
): Promise<string> {
  const { repoDir } = await resolveContextRepoDir(ctx, deps, repoPathInput, explicitContextId);
  return runContextGit(repoDir, options?.staged ? ["diff", "--cached"] : ["diff", "HEAD"]);
}

async function contextGitCommit(
  ctx: ServiceContext,
  deps: GitServiceDeps,
  repoPathInput: string,
  message: string,
  explicitContextId?: string
): Promise<{ commitId: string; summary: string }> {
  const { repoDir } = await resolveContextRepoDir(ctx, deps, repoPathInput, explicitContextId);
  if (!message.trim()) throw new Error("Commit message is required");
  const staged = await runContextGit(repoDir, ["diff", "--cached", "--name-only"]);
  if (!staged.trim()) {
    throw new Error("Nothing to commit: no staged changes");
  }
  await execGitFileAsync(
    ["-c", "user.email=natstack@local", "-c", "user.name=natstack", "commit", "-m", message],
    { cwd: repoDir }
  );
  const commitId = (await runContextGit(repoDir, ["rev-parse", "HEAD"])).trim();
  const summary = (await runContextGit(repoDir, ["log", "-1", "--format=%s"])).trim();
  return { commitId, summary };
}

async function runContextGit(repoDir: string, args: readonly string[]): Promise<string> {
  return (await execGitFileAsync(args, { cwd: repoDir })).stdout;
}

function porcelainLineToFileStatus(line: string): ContextRepoStatus["files"][number] {
  const index = line.slice(0, 1);
  const workingTree = line.slice(1, 2);
  const rawPath = line.slice(3).trim();
  const path = rawPath.includes(" -> ") ? (rawPath.split(" -> ").pop() ?? rawPath).trim() : rawPath;

  const staged = index !== " " && index !== "?";
  const unstaged = workingTree !== " " && workingTree !== "?";
  let status: ContextRepoStatus["files"][number]["status"] = "modified";

  if (index === "?" && workingTree === "?") {
    status = "untracked";
  } else if (index === "A" || workingTree === "A") {
    status = "added";
  } else if (index === "D" || workingTree === "D") {
    status = "deleted";
  } else if (index === "!" && workingTree === "!") {
    status = "ignored";
  }

  return {
    path,
    status,
    staged,
    unstaged,
  };
}

async function importWorkspaceRepo(
  ctx: ServiceContext,
  deps: GitServiceDeps,
  request: ImportWorkspaceRepoRequest
): Promise<ImportedWorkspaceRepo> {
  if (!deps.workspacePath) throw new Error("No workspace path configured");
  if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
  if (!deps.egressProxy) throw new Error("Project import is unavailable");

  const { absolutePath, normalizedRepoPath } = resolveWorkspaceRepoPath(
    deps.workspacePath,
    request.path
  );
  const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
  if (!isSupportedImportRepoPath(validRepoPath)) {
    throw new Error(`Imports must target one of: ${WORKSPACE_IMPORT_PARENT_DIRS.join(", ")}`);
  }
  if (fs.existsSync(absolutePath)) throw new Error(`Path already exists: ${request.path}`);
  assertWorkspaceCreateTargetSafe(deps.workspacePath, absolutePath, "importProject");
  const normalizedRemote = validateWorkspaceGitRemote(request.remote);

  await ensureImportProjectPermission(ctx, deps, validRepoPath, normalizedRemote);
  await mkdir(dirname(absolutePath), { recursive: true });
  try {
    const client = new GitClient(fsPromises, {
      http: createEgressGitHttpClient(deps.egressProxy, ctx.caller, request.credentialId),
    });
    await client.clone({ url: normalizedRemote.url, dir: absolutePath });
    const nextConfig = setDeclaredRemoteInConfig(
      deps.workspaceConfig,
      validRepoPath,
      normalizedRemote
    );
    await persistWorkspaceConfigChange(deps.workspacePath, deps.workspaceConfig, nextConfig, {
      message: `Import project ${validRepoPath}`,
    });
    await propagateSharedRemote(deps, validRepoPath);
    deps.gitServer.invalidateTreeCache();
    await deps.contextFolderManager?.ensureRepoPresentInContexts(validRepoPath);
    return { path: validRepoPath, remote: normalizedRemote };
  } catch (err) {
    await fsPromises.rm(absolutePath, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

async function ensureImportProjectPermission(
  ctx: ServiceContext,
  deps: {
    approvalQueue?: ApprovalQueue;
    grantStore?: CapabilityGrantStore;
  },
  repoPath: string,
  remote: WorkspaceGitRemoteConfig
): Promise<void> {
  if (ctx.caller.runtime.kind === "shell" || ctx.caller.runtime.kind === "server") {
    return;
  }
  if (
    ctx.caller.runtime.kind !== "panel" &&
    ctx.caller.runtime.kind !== "app" &&
    ctx.caller.runtime.kind !== "worker" &&
    ctx.caller.runtime.kind !== "do"
  ) {
    throw new Error("Project import is unavailable for this caller");
  }
  if (!deps.approvalQueue || !deps.grantStore) {
    throw new Error("Project import is unavailable");
  }
  const authorization = await requestCapabilityPermission(
    {
      approvalQueue: deps.approvalQueue,
      grantStore: deps.grantStore,
    },
    {
      caller: ctx.caller,
      capability: PROJECT_IMPORT_CAPABILITY,
      dedupKey: null,
      resource: {
        type: "workspace-project",
        label: "Project path",
        value: repoPath,
      },
      title: "Add project repo",
      description: "Allow this code version to import a remote repository into workspace source.",
      details: [
        { label: "Project path", value: repoPath },
        { label: "Remote name", value: remote.name },
        { label: "Remote URL", value: displayRemoteUrl(remote.url) },
      ],
      deniedReason: "Project import denied",
    }
  );
  if (!authorization.allowed) {
    throw new Error(authorization.reason ?? "Project import denied");
  }
}

function isSupportedImportRepoPath(repoPath: string): boolean {
  const [parent, child] = repoPath.split("/");
  return !!child && (WORKSPACE_IMPORT_PARENT_DIRS as readonly string[]).includes(parent ?? "");
}

async function ensureSharedRemotePermission(
  ctx: ServiceContext,
  deps: {
    approvalQueue?: ApprovalQueue;
    grantStore?: CapabilityGrantStore;
  },
  repoPath: string,
  operation: "set" | "remove",
  remote: WorkspaceGitRemoteConfig | null
): Promise<void> {
  if (ctx.caller.runtime.kind === "shell" || ctx.caller.runtime.kind === "server") {
    return;
  }
  if (
    ctx.caller.runtime.kind !== "panel" &&
    ctx.caller.runtime.kind !== "app" &&
    ctx.caller.runtime.kind !== "worker" &&
    ctx.caller.runtime.kind !== "do"
  ) {
    throw new Error("Shared remote configuration is unavailable for this caller");
  }
  if (!deps.approvalQueue || !deps.grantStore) {
    throw new Error("Shared remote configuration is unavailable");
  }
  const details = [
    {
      label: "Operation",
      value: operation === "set" ? "Add or update shared remote" : "Remove shared remote",
    },
    { label: "Repository path", value: repoPath },
  ];
  if (remote) {
    details.push({ label: "Remote name", value: remote.name });
    if (remote.url) {
      details.push({ label: "Remote URL", value: displayRemoteUrl(remote.url) });
    }
  }
  const authorization = await requestCapabilityPermission(
    {
      approvalQueue: deps.approvalQueue,
      grantStore: deps.grantStore,
    },
    {
      caller: ctx.caller,
      capability: SHARED_GIT_REMOTE_CAPABILITY,
      dedupKey: null,
      resource: {
        type: "git-remote",
        label: "Workspace repo",
        value: repoPath,
      },
      title: operation === "set" ? "Configure shared remote" : "Remove shared remote",
      description: "Allow this code version to change the remote URL shared by workspace contexts.",
      details,
      deniedReason: "Shared remote configuration denied",
    }
  );
  if (!authorization.allowed) {
    throw new Error(authorization.reason ?? "Shared remote configuration denied");
  }
}

async function persistWorkspaceConfigChange(
  workspacePath: string,
  currentConfig: WorkspaceConfig,
  nextConfig: WorkspaceConfig,
  opts: { message: string }
): Promise<void> {
  const metaDir = join(workspacePath, "meta");
  const configPath = join(metaDir, "natstack.yml");
  const before = await readFile(configPath, "utf-8");
  const beforeParsed = YAML.parse(before) as Record<string, unknown>;
  const nextContent = YAML.stringify({
    ...beforeParsed,
    ...nextConfig,
  });
  if (before === nextContent) {
    return;
  }
  await writeFile(configPath, nextContent, "utf-8");
  mutateWorkspaceConfig(currentConfig, nextConfig);
  await execGitFileAsync(["add", "--", "natstack.yml"], { cwd: metaDir });
  const status = (
    await execGitFileAsync(["status", "--porcelain", "--", "natstack.yml"], {
      cwd: metaDir,
    })
  ).stdout;
  if (!status.trim()) return;
  await execGitFileAsync(
    ["-c", "user.email=natstack@local", "-c", "user.name=natstack", "commit", "-m", opts.message],
    { cwd: metaDir }
  );
}

async function propagateSharedRemote(
  deps: {
    workspacePath?: string;
    workspaceConfig?: WorkspaceConfig;
    contextFolderManager?: Pick<ContextFolderManager, "syncDeclaredRemotes">;
  },
  repoPath: string
): Promise<void> {
  if (!deps.workspacePath || !deps.workspaceConfig) return;
  await syncDeclaredRemoteForRepo({
    config: deps.workspaceConfig,
    workspaceRoot: deps.workspacePath,
    repoPath,
  });
  await deps.contextFolderManager?.syncDeclaredRemotes(repoPath);
}

function createEgressGitHttpClient(
  egressProxy: Pick<EgressProxy, "forwardGitHttp">,
  caller: VerifiedCaller,
  credentialId?: string
) {
  return {
    async request(request: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: Uint8Array | AsyncIterable<Uint8Array>;
    }) {
      const body = request.body ? await collectGitBody(request.body) : undefined;
      const response = await egressProxy.forwardGitHttp({
        caller,
        url: request.url,
        method: request.method ?? "GET",
        headers: request.headers ?? {},
        body,
        credentialId,
      });
      return {
        url: response.url,
        method: response.method,
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        headers: response.headers,
        body: (async function* () {
          yield response.body;
        })(),
      };
    },
  };
}

async function collectGitBody(body: Uint8Array | AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function mutateWorkspaceConfig(target: WorkspaceConfig, next: WorkspaceConfig): void {
  for (const key of Object.keys(target) as Array<keyof WorkspaceConfig>) {
    deleteDynamicProperty(target, key);
  }
  Object.assign(target, next);
}

function getRemoteForApproval(
  config: WorkspaceConfig,
  repoPath: string,
  remoteName: string
): WorkspaceGitRemoteConfig {
  const normalizedRemoteName = validateWorkspaceGitRemoteName(remoteName);
  const remote = getDeclaredRemoteForRepo(config, repoPath, remoteName);
  return remote ? { name: remote.name, url: remote.url } : { name: normalizedRemoteName, url: "" };
}

function displayRemoteUrl(value: string): string {
  return normalizeRemoteUrl(value).replace(/^https?:\/\//, "");
}

async function ensureRepoCreatePermission(
  ctx: ServiceContext,
  deps: {
    approvalQueue?: ApprovalQueue;
    grantStore?: CapabilityGrantStore;
  },
  repoPath: string
): Promise<void> {
  if (ctx.caller.runtime.kind === "shell" || ctx.caller.runtime.kind === "server") {
    return;
  }
  if (
    ctx.caller.runtime.kind !== "panel" &&
    ctx.caller.runtime.kind !== "app" &&
    ctx.caller.runtime.kind !== "worker" &&
    ctx.caller.runtime.kind !== "do"
  ) {
    throw new Error("Repository creation is unavailable for this caller");
  }
  if (!deps.approvalQueue || !deps.grantStore) {
    throw new Error("Repository creation is unavailable");
  }
  const authorization = await requestCapabilityPermission(
    {
      approvalQueue: deps.approvalQueue,
      grantStore: deps.grantStore,
    },
    {
      caller: ctx.caller,
      capability: INTERNAL_GIT_WRITE_CAPABILITY,
      dedupKey: null,
      resource: {
        type: "git-repo",
        label: "Repository",
        value: repoPath,
      },
      title: "Create workspace repo",
      description: "Allow this code version to create this workspace repository.",
      details: [{ label: "Operation", value: "create repo" }],
      deniedReason: "Repository creation denied",
    }
  );
  if (!authorization.allowed) {
    throw new Error(authorization.reason ?? "Repository creation denied");
  }
}

function resolveWorkspaceRepoPath(
  workspacePath: string,
  repoPath: string
): {
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

function assertWorkspaceCreateTargetSafe(
  workspacePath: string,
  absolutePath: string,
  operation: string
): void {
  let current = dirname(absolutePath);
  const workspaceAbs = resolve(workspacePath);
  while (current.length >= workspaceAbs.length) {
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing to ${operation}: ancestor "${current}" is a symlink`);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }
    if (current === workspaceAbs) break;
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  try {
    const tStat = lstatSync(absolutePath);
    if (tStat.isSymbolicLink()) {
      throw new Error(`Refusing to ${operation}: target "${absolutePath}" is a symlink`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}
