/**
 * ServerInfo — extends ServerInfoLike with git operations and a generic RPC call.
 *
 * Used only in Electron main process where server access is via RPC.
 */

import type { ServerInfoLike } from "@natstack/shared/panelInterfaces";

export interface ServerInfo extends ServerInfoLike {
  /** Generic RPC call to a server service */
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
  getWorkspaceTree(): Promise<unknown>;
  listBranches(repoPath: string): Promise<unknown>;
  listCommits(repoPath: string, ref?: string, limit?: number): Promise<unknown>;
  /** Resolve a git ref to a commit SHA (used for GitHub paths) */
  resolveRef(repoPath: string, ref: string): Promise<string>;
}
