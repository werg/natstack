/**
 * ServerInfo — extends ServerInfoLike with git operations and required RPC call.
 *
 * Used only in Electron main process where server access is via RPC.
 * The git methods satisfy GitBridgeLike for bridge handler sharing.
 */

import type { ServerInfoLike } from "@natstack/shared/panelInterfaces";
import type { GitBridgeLike } from "@natstack/shared/bridgeHandlersCommon";

export interface ServerInfo extends ServerInfoLike, GitBridgeLike {
  /** Generic RPC call to a server service */
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
  /** Resolve a git ref to a commit SHA (used for GitHub paths) */
  resolveRef(repoPath: string, ref: string): Promise<string>;
}
