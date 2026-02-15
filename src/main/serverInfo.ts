/**
 * ServerInfo — interface for server-side services accessed by PanelManager.
 *
 * Replaces the direct GitServer dependency. Methods are async because they
 * delegate to the server process via RPC.
 */

import type { CallerKind } from "./serviceDispatcher.js";

export interface ServerInfo {
  /** Server's RPC port for direct client connections */
  rpcPort: number;
  gitBaseUrl: string;
  pubsubUrl: string;
  /** Create a server-side token for panel git/pubsub auth */
  createPanelToken(panelId: string, kind: CallerKind): Promise<string>;
  /** Ensure server-side token exists (idempotent — returns existing or creates new) */
  ensurePanelToken(panelId: string, kind: CallerKind): Promise<string>;
  /** Revoke server-side token */
  revokePanelToken(panelId: string): Promise<void>;
  /** Get existing server-side token (for pubsub config) */
  getPanelToken(panelId: string): Promise<string | null>;
  /** Get git auth token for panel */
  getGitTokenForPanel(panelId: string): Promise<string>;
  /** Revoke git auth token */
  revokeGitToken(panelId: string): Promise<void>;
  /** Git queries (delegated to server) */
  getWorkspaceTree(): Promise<unknown>;
  listBranches(repoPath: string): Promise<unknown>;
  listCommits(repoPath: string, ref: string, limit: number): Promise<unknown>;
  /** Resolve a git ref to a commit SHA (used for GitHub paths) */
  resolveRef(repoPath: string, ref: string): Promise<string>;
  /** List discovered agents (delegated to server) */
  listAgents(): Promise<unknown>;
  /** Generic RPC call to a server service */
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
}
