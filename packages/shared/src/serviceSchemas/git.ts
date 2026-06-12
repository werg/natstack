/**
 * Wire schema for the "git" service — argument tuples, return shapes, and
 * per-method policies. Single source of truth shared by the server handler
 * (src/server/services/gitService.ts) and typed clients.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const gitRemoteSchema = z.object({
  name: z.string(),
  url: z.string(),
});
export type GitRemote = z.infer<typeof gitRemoteSchema>;

export const gitSharedRemotesSchema = z.record(
  z.record(z.record(z.string().nullable().optional()).optional()).optional()
);
export type GitSharedRemotes = z.infer<typeof gitSharedRemotesSchema>;

export const gitImportProjectSchema = z.object({
  path: z.string(),
  remote: gitRemoteSchema,
  credentialId: z.string().optional(),
});
export type GitImportProjectRequest = z.infer<typeof gitImportProjectSchema>;

export const gitCompleteWorkspaceDependenciesSchema = z.object({
  credentialId: z.string().optional(),
});
export type GitCompleteWorkspaceDependenciesOptions = z.infer<
  typeof gitCompleteWorkspaceDependenciesSchema
>;

export const gitContextDiffOptionsSchema = z.object({
  staged: z.boolean().optional(),
});
export type GitContextDiffOptions = z.infer<typeof gitContextDiffOptionsSchema>;

/** Workspace tree node returned by getWorkspaceTree (see @natstack/git-server types). */
export type GitWorkspaceNode = {
  name: string;
  path: string;
  isGitRepo: boolean;
  launchable?: { type: "app"; title: string; hidden?: boolean };
  packageInfo?: { name: string; version?: string };
  skillInfo?: { name: string; description: string };
  children: GitWorkspaceNode[];
};

export const gitWorkspaceNodeSchema: z.ZodType<GitWorkspaceNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    isGitRepo: z.boolean(),
    launchable: z
      .object({ type: z.literal("app"), title: z.string(), hidden: z.boolean().optional() })
      .optional(),
    packageInfo: z.object({ name: z.string(), version: z.string().optional() }).optional(),
    skillInfo: z.object({ name: z.string(), description: z.string() }).optional(),
    children: z.array(gitWorkspaceNodeSchema),
  })
);

export const gitWorkspaceTreeSchema = z.object({
  children: z.array(gitWorkspaceNodeSchema),
});
export type GitWorkspaceTree = z.infer<typeof gitWorkspaceTreeSchema>;

export const gitFindRepoForPathResultSchema = z
  .object({
    repoPath: z.string(),
    relativePath: z.string(),
  })
  .nullable();
export type GitFindRepoForPathResult = z.infer<typeof gitFindRepoForPathResultSchema>;

/** Workspace repo status (GitServer.status — raw porcelain index/workingTree codes). */
export const gitRepoStatusSchema = z.object({
  repoPath: z.string(),
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  dirty: z.boolean(),
  files: z.array(
    z.object({
      path: z.string(),
      index: z.string(),
      workingTree: z.string(),
    })
  ),
});
export type GitRepoStatus = z.infer<typeof gitRepoStatusSchema>;

/** Context repo status — matches RepoStatus from @natstack/git (contextGitClient consumers). */
export const gitContextFileStatusSchema = z.object({
  path: z.string(),
  status: z.enum(["unmodified", "modified", "added", "deleted", "untracked", "ignored"]),
  staged: z.boolean(),
  unstaged: z.boolean(),
});
export type GitContextFileStatus = z.infer<typeof gitContextFileStatusSchema>;

export const gitContextRepoStatusSchema = z.object({
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  dirty: z.boolean(),
  files: z.array(gitContextFileStatusSchema),
});
export type GitContextRepoStatus = z.infer<typeof gitContextRepoStatusSchema>;

export const gitContextCommitResultSchema = z.object({
  commitId: z.string(),
  summary: z.string(),
});
export type GitContextCommitResult = z.infer<typeof gitContextCommitResultSchema>;

export const gitBranchInfoSchema = z.object({
  name: z.string(),
  current: z.boolean(),
  remote: z.string().optional(),
});
export type GitBranchInfo = z.infer<typeof gitBranchInfoSchema>;

export const gitCommitInfoSchema = z.object({
  oid: z.string(),
  message: z.string(),
  author: z.object({ name: z.string(), timestamp: z.number() }),
});
export type GitCommitInfo = z.infer<typeof gitCommitInfoSchema>;

export const gitImportedWorkspaceRepoSchema = z.object({
  path: z.string(),
  remote: gitRemoteSchema,
});
export type GitImportedWorkspaceRepo = z.infer<typeof gitImportedWorkspaceRepoSchema>;

export const gitCompleteWorkspaceDependenciesResultSchema = z.object({
  imported: z.array(gitImportedWorkspaceRepoSchema),
  skipped: z.array(
    z.object({
      path: z.string(),
      reason: z.enum(["already-present", "unsupported-path"]),
    })
  ),
  failed: z.array(
    z.object({
      path: z.string(),
      error: z.string(),
    })
  ),
});
export type GitCompleteWorkspaceDependenciesResult = z.infer<
  typeof gitCompleteWorkspaceDependenciesResultSchema
>;

export const gitEnsureRepoPresentResultSchema = z.object({
  ensured: z.string(),
});
export type GitEnsureRepoPresentResult = z.infer<typeof gitEnsureRepoPresentResultSchema>;

export const gitMethods = defineServiceMethods({
  getWorkspaceTree: { args: z.tuple([]), returns: gitWorkspaceTreeSchema },
  findRepoForPath: { args: z.tuple([z.string()]), returns: gitFindRepoForPathResultSchema },
  status: { args: z.tuple([z.string()]), returns: gitRepoStatusSchema },
  // context* methods: entity callers (panel/app/worker/do/extension) pass
  // [repoPath, ...]; explicit-context callers (server/shell/harness) prepend
  // their contextId: [contextId, repoPath, ...] — same convention as fs.*.
  contextStatus: {
    args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    returns: gitContextRepoStatusSchema,
  },
  contextAddAll: {
    args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    returns: z.void(),
  },
  contextDiff: {
    args: z.union([
      z.tuple([z.string()]),
      z.tuple([z.string(), gitContextDiffOptionsSchema.optional()]),
      z.tuple([z.string(), z.string()]),
      z.tuple([z.string(), z.string(), gitContextDiffOptionsSchema.optional()]),
    ]),
    returns: z.string(),
  },
  contextCommit: {
    args: z.union([
      z.tuple([z.string(), z.string()]),
      z.tuple([z.string(), z.string(), z.string()]),
    ]),
    returns: gitContextCommitResultSchema,
  },
  listBranches: { args: z.tuple([z.string()]), returns: z.array(gitBranchInfoSchema) },
  listCommits: {
    args: z.tuple([z.string(), z.string(), z.number()]),
    returns: z.array(gitCommitInfoSchema),
  },
  resolveRef: { args: z.tuple([z.string(), z.string()]), returns: z.string() },
  createRepo: { args: z.tuple([z.string()]), returns: z.void() },
  setSharedRemote: {
    args: z.tuple([z.string(), gitRemoteSchema]),
    returns: gitSharedRemotesSchema.optional(),
  },
  removeSharedRemote: {
    args: z.tuple([z.string(), z.string()]),
    returns: gitSharedRemotesSchema.optional(),
  },
  importProject: {
    args: z.tuple([gitImportProjectSchema]),
    returns: gitImportedWorkspaceRepoSchema,
  },
  completeWorkspaceDependencies: {
    args: z.union([z.tuple([]), z.tuple([gitCompleteWorkspaceDependenciesSchema.optional()])]),
    returns: gitCompleteWorkspaceDependenciesResultSchema,
  },
  ensureRepoPresentInContexts: {
    args: z.tuple([z.string()]),
    returns: gitEnsureRepoPresentResultSchema,
  },
});
export type GitMethods = typeof gitMethods;
