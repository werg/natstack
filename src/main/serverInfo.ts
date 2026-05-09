/**
 * ServerInfo — extends ServerInfoLike with git operations.
 *
 * Used only in Electron main process where server access is via RPC.
 */

import type { ServerInfoLike } from "@natstack/shared/panelInterfaces";

export interface ServerInfo extends ServerInfoLike {
  getWorkspaceTree(): Promise<unknown>;
  listBranches(repoPath: string): Promise<unknown>;
  listCommits(repoPath: string, ref?: string, limit?: number): Promise<unknown>;
  /** Resolve a git ref to a commit SHA (used for GitHub paths) */
  resolveRef(repoPath: string, ref: string): Promise<string>;
}
