import type { VerifiedCaller } from "@natstack/shared/serviceDispatcher";

export interface WorkspaceNode {
  name: string;
  path: string;
  isGitRepo: boolean;
  launchable?: { title: string; hidden?: boolean };
  packageInfo?: { name: string; version?: string };
  skillInfo?: { name: string; description: string };
  children: WorkspaceNode[];
}

export interface WorkspaceTree {
  children: WorkspaceNode[];
}

export interface BranchInfo {
  name: string;
  current: boolean;
  remote?: string;
}

export interface CommitInfo {
  oid: string;
  message: string;
  author: { name: string; timestamp: number };
}

export interface RepoStatus {
  repoPath: string;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  files: Array<{
    path: string;
    index: string;
    workingTree: string;
  }>;
}

/** Minimal GitWatcher interface — subset used by GitServer. */
export interface GitWatcherLike {
  on(event: string, callback: (repoPath: string) => void): () => void;
}

export interface GitPushAuthorizationRequest {
  caller: VerifiedCaller;
  repoPath: string;
  branch: string;
  commit: string;
}

export interface GitPushAuthorizationResult {
  allowed: boolean;
  reason?: string;
}

export type GitPushAuthorizer = (
  request: GitPushAuthorizationRequest,
) => Promise<GitPushAuthorizationResult> | GitPushAuthorizationResult;
