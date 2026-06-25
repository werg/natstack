import * as fs from "fs";
import { lstatSync } from "fs";
import * as fsPromises from "fs/promises";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import YAML from "yaml";
import { GitClient } from "@natstack/git";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServiceContext, VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { AppCapability } from "@natstack/shared/unitManifest";
import type { WorkspaceTreeScanner } from "../gadVcs/workspaceTree.js";
import type { WorkspaceConfig, WorkspaceGitRemoteConfig } from "@natstack/shared/workspace/types";
import {
  getDeclaredRemoteForRepo,
  getDeclaredRemotesForRepo,
  normalizeRemoteUrl,
  normalizeWorkspaceRepoPath,
  removeDeclaredRemoteFromConfig,
  setDeclaredRemoteInConfig,
  syncDeclaredRemoteForRepo,
  validateWorkspaceGitRemote,
  validateWorkspaceGitRemoteName,
} from "@natstack/shared/workspace/remotes";
import { WORKSPACE_IMPORT_PARENT_DIRS } from "@natstack/shared/workspace/sourceDirs";
import { gitInteropMethods } from "@natstack/shared/serviceSchemas/gitInterop";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { EgressProxy } from "./egressProxy.js";
import { requestCapabilityPermission } from "./capabilityPermission.js";
import { deleteDynamicProperty } from "../../lintHelpers";
import { isAuthorizedChrome } from "./chromeTrust.js";

const SHARED_GIT_REMOTE_CAPABILITY = "workspace-shared-git-remote";

type GitInteropServiceDeps = {
  treeScanner: WorkspaceTreeScanner;
  workspacePath?: string;
  workspaceConfig?: WorkspaceConfig;
  egressProxy?: Pick<EgressProxy, "forwardGitHttp">;
  approvalQueue?: ApprovalQueue;
  grantStore?: CapabilityGrantStore;
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  onWorkspaceSourceChanged?: (ctx: ServiceContext, summary: string) => Promise<void>;
  /**
   * Initialize the per-repo VCS log (`vcs:repo:<repoPath>`) for a freshly
   * cloned repo by snapshotting its on-disk tree into the repo log at `main`
   * (W7 distribution). No lockfile, no pinning — the clone lands at its
   * declared branch HEAD and its tree becomes the repo log's first `main`
   * state. Wired to `GitBridge.importRepoTree`. Optional so unit tests that
   * don't exercise distribution can omit it.
   */
  initRepoLog?: (repoPath: string) => Promise<void>;
};

type WorkspaceTreeNode = {
  path: string;
  isUnit: boolean;
  children: WorkspaceTreeNode[];
};

type ImportWorkspaceRepoRequest = {
  path: string;
  remote: WorkspaceGitRemoteConfig;
  branch?: string;
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

export function createGitInteropService(deps: GitInteropServiceDeps): ServiceDefinition {
  return {
    name: "gitInterop",
    description: "External Git interop: declared remotes and remote project imports",
    policy: { allowed: ["shell", "panel", "app", "server", "worker", "do", "extension"] },
    methods: gitInteropMethods,
    handler: async (ctx, method, args) => {
      switch (method) {
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
          await persistWorkspaceConfigChange(deps.workspacePath, deps.workspaceConfig, nextConfig);
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
          await persistWorkspaceConfigChange(deps.workspacePath, deps.workspaceConfig, nextConfig);
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

        default:
          throw new Error(`Unknown gitInterop method: ${method}`);
      }
    },
  };
}

async function completeWorkspaceDependencies(
  ctx: ServiceContext,
  deps: GitInteropServiceDeps,
  options: { credentialId?: string } | undefined
): Promise<CompleteWorkspaceDependenciesResult> {
  if (!deps.workspacePath) throw new Error("No workspace path configured");
  if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");

  const tree = await deps.treeScanner.getSourceTree();
  const existingUnits = collectWorkspaceUnitPaths(tree.children as WorkspaceTreeNode[]);
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
    if (existingUnits.has(dependency.path)) {
      result.skipped.push({ path: dependency.path, reason: "already-present" });
      continue;
    }
    try {
      const imported = await importWorkspaceRepo(ctx, deps, {
        path: dependency.path,
        remote: dependency.remote,
        credentialId: options?.credentialId,
      });
      // W7: a newly cloned repo has no `vcs:repo:<path>` log yet. Snapshot its
      // cloned tree (at the declared branch HEAD) into a fresh repo log at
      // `main` so the workspace's live union (and every per-repo VCS op) can
      // see it immediately. No lockfile, no pinning — the clone's tree IS the
      // first state. A failure here must not unwind the clone (the repo is on
      // disk and usable); surface it as a non-fatal warning.
      if (deps.initRepoLog) {
        try {
          await deps.initRepoLog(imported.path);
        } catch (logErr) {
          console.warn(
            `[GitRemotes] Cloned ${imported.path} but failed to initialize its vcs:repo log:`,
            logErr instanceof Error ? logErr.message : String(logErr)
          );
        }
      }
      result.imported.push(imported);
      existingUnits.add(imported.path);
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
  for (const [section, units] of Object.entries(config.git?.remotes ?? {})) {
    for (const unitKey of Object.keys(units ?? {})) {
      const unitPath = normalizeWorkspaceRepoPath(`${section}/${unitKey}`);
      const remotes = getDeclaredRemotesForRepo(config, unitPath).sort((a, b) => {
        if (a.name === "origin") return -1;
        if (b.name === "origin") return 1;
        return a.name.localeCompare(b.name);
      });
      const cloneRemote = remotes[0];
      if (cloneRemote) entries.push({ path: unitPath, remote: cloneRemote });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function collectWorkspaceUnitPaths(nodes: WorkspaceTreeNode[]): Set<string> {
  const units = new Set<string>();
  for (const node of nodes) {
    if (node.isUnit) units.add(node.path);
    for (const childPath of collectWorkspaceUnitPaths(node.children)) {
      units.add(childPath);
    }
  }
  return units;
}

async function importWorkspaceRepo(
  ctx: ServiceContext,
  deps: GitInteropServiceDeps,
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
  const normalizedRemote = validateWorkspaceGitRemote({
    ...request.remote,
    branch: request.branch ?? request.remote.branch,
  });
  const nextConfig = setDeclaredRemoteInConfig(
    deps.workspaceConfig,
    validRepoPath,
    normalizedRemote
  );

  await ensureWorkspaceConfigWritePermission(
    ctx,
    deps,
    validRepoPath,
    normalizedRemote,
    nextConfig
  );
  const configChanged = await persistWorkspaceConfigChange(
    deps.workspacePath,
    deps.workspaceConfig,
    nextConfig
  );
  await mkdir(dirname(absolutePath), { recursive: true });
  try {
    const client = new GitClient(fsPromises, {
      http: createEgressGitHttpClient(deps.egressProxy, ctx.caller, request.credentialId),
    });
    await client.clone({
      url: normalizedRemote.url,
      dir: absolutePath,
      ref: normalizedRemote.branch,
    });
    await propagateSharedRemote(deps, validRepoPath);
  } catch (err) {
    await fsPromises.rm(absolutePath, { recursive: true, force: true }).catch(() => undefined);
    if (configChanged) {
      await notifyWorkspaceSourceChanged(ctx, deps, `Record Git remote for ${validRepoPath}`);
    }
    throw err;
  }
  deps.treeScanner.invalidate();
  await notifyWorkspaceSourceChanged(ctx, deps, `Import workspace project ${validRepoPath}`);
  return { path: validRepoPath, remote: normalizedRemote };
}

async function ensureWorkspaceConfigWritePermission(
  ctx: ServiceContext,
  deps: Pick<GitInteropServiceDeps, "workspacePath" | "approvalQueue" | "hasAppCapability">,
  unitPath: string,
  remote: WorkspaceGitRemoteConfig,
  nextConfig: WorkspaceConfig
): Promise<void> {
  if (!deps.workspacePath) throw new Error("No workspace path configured");
  if (!(await workspaceConfigWouldChange(deps.workspacePath, nextConfig))) return;
  if (isAuthorizedChrome(ctx.caller, { hasAppCapability: deps.hasAppCapability })) return;
  if (
    ctx.caller.runtime.kind !== "panel" &&
    ctx.caller.runtime.kind !== "app" &&
    ctx.caller.runtime.kind !== "worker" &&
    ctx.caller.runtime.kind !== "do"
  ) {
    throw new Error("Workspace config edit is unavailable for this caller");
  }
  const identity = ctx.caller.code;
  if (!identity) throw new Error("Workspace config edit requires a verified code identity");
  if (!deps.approvalQueue) throw new Error("Workspace config edit is unavailable");

  const decision = await deps.approvalQueue.request({
    kind: "unit-batch",
    callerId: ctx.caller.runtime.id,
    callerKind: ctx.caller.runtime.kind,
    repoPath: identity.repoPath,
    effectiveVersion: identity.effectiveVersion,
    dedupKey: `git-import-config:${unitPath}:${remote.name}:${remote.url}:${remote.branch ?? ""}`,
    trigger: "meta-change",
    title: "Import external Git project",
    description: "This import adds an external Git project declaration to workspace config.",
    units: [],
    configWrite: {
      repoPath: "meta",
      summary: workspaceConfigImportSummary(unitPath, remote),
    },
  });
  if (decision === "deny") throw new Error("Workspace config edit denied");
}

function isSupportedImportRepoPath(repoPath: string): boolean {
  const [parent, child] = repoPath.split("/");
  return !!child && (WORKSPACE_IMPORT_PARENT_DIRS as readonly string[]).includes(parent ?? "");
}

async function ensureSharedRemotePermission(
  ctx: ServiceContext,
  deps: Pick<GitInteropServiceDeps, "approvalQueue" | "grantStore" | "hasAppCapability">,
  unitPath: string,
  operation: "set" | "remove",
  remote: WorkspaceGitRemoteConfig | null
): Promise<void> {
  if (isAuthorizedChrome(ctx.caller, { hasAppCapability: deps.hasAppCapability })) return;
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
    { label: "Workspace unit", value: unitPath },
  ];
  if (remote) {
    details.push({ label: "Remote name", value: remote.name });
    if (remote.url) details.push({ label: "Remote URL", value: displayRemoteUrl(remote.url) });
    if (remote.branch) details.push({ label: "Branch", value: remote.branch });
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
      resource: { type: "git-remote", label: "Workspace unit", value: unitPath },
      operation: {
        kind: "git",
        verb: operation === "set" ? "Configure shared remote" : "Remove shared remote",
        object: { type: "git-remote", label: "Workspace unit", value: unitPath },
      },
      title:
        operation === "set"
          ? `Configure Git remote for ${unitPath}`
          : `Remove Git remote for ${unitPath}`,
      description:
        "Allow this code version to change the external Git remote shared by workspace contexts.",
      details,
      deniedReason: "Shared remote configuration denied",
    }
  );
  if (!authorization.allowed) {
    throw new Error(authorization.reason ?? "Shared remote configuration denied");
  }
}

async function workspaceConfigWouldChange(
  workspacePath: string,
  nextConfig: WorkspaceConfig
): Promise<boolean> {
  const metaDir = join(workspacePath, "meta");
  const configPath = join(metaDir, "natstack.yml");
  const before = await readFile(configPath, "utf-8");
  const beforeParsed = YAML.parse(before) as Record<string, unknown>;
  const nextContent = YAML.stringify({ ...beforeParsed, ...nextConfig });
  return before !== nextContent;
}

async function persistWorkspaceConfigChange(
  workspacePath: string,
  currentConfig: WorkspaceConfig,
  nextConfig: WorkspaceConfig
): Promise<boolean> {
  const metaDir = join(workspacePath, "meta");
  const configPath = join(metaDir, "natstack.yml");
  const before = await readFile(configPath, "utf-8");
  const beforeParsed = YAML.parse(before) as Record<string, unknown>;
  const nextContent = YAML.stringify({ ...beforeParsed, ...nextConfig });
  if (before === nextContent) return false;
  await writeFile(configPath, nextContent, "utf-8");
  mutateWorkspaceConfig(currentConfig, nextConfig);
  return true;
}

async function notifyWorkspaceSourceChanged(
  ctx: ServiceContext,
  deps: Pick<GitInteropServiceDeps, "onWorkspaceSourceChanged">,
  summary: string
): Promise<void> {
  await deps.onWorkspaceSourceChanged?.(ctx, summary);
}

async function propagateSharedRemote(
  deps: Pick<GitInteropServiceDeps, "workspacePath" | "workspaceConfig">,
  repoPath: string
): Promise<void> {
  if (!deps.workspacePath || !deps.workspaceConfig) return;
  await syncDeclaredRemoteForRepo({
    config: deps.workspaceConfig,
    workspaceRoot: deps.workspacePath,
    repoPath,
  });
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
  for await (const chunk of body) chunks.push(chunk);
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

function workspaceConfigImportSummary(unitPath: string, remote: WorkspaceGitRemoteConfig): string {
  const branch = remote.branch ? ` on ${remote.branch}` : "";
  return `meta/natstack.yml records ${remote.name}=${displayRemoteUrl(remote.url)} for ${unitPath}${branch}`;
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
  const rel = relative(workspaceAbs, absolutePath);
  if (rel.length > 0 && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error("Invalid workspace unit path: escapes workspace root");
  }
  return { absolutePath, normalizedRepoPath: rel || "." };
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
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
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
