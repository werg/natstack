/**
 * Workspace client — typed RPC wrapper for workspace management.
 * Shared by both panel and worker entry points.
 */

import type { RpcCaller } from "@natstack/rpc";

export interface WorkspaceEntry {
  name: string;
  lastOpened: number;
}

export interface InitPanelEntry {
  source: string;
  stateArgs?: Record<string, unknown>;
}

export interface WorkspaceConfig {
  id: string;
  initPanels?: InitPanelEntry[];
  git?: {
    remotes?: Record<string, Record<string, Record<string, string | null | undefined> | undefined> | undefined>;
  };
}

export interface WorkspaceClient {
  /** List all workspaces sorted by last opened. */
  list(): Promise<WorkspaceEntry[]>;
  /** Get the active workspace name. */
  getActive(): Promise<string>;
  /** Get the full entry for the active workspace (name, lastOpened). */
  getActiveEntry(): Promise<WorkspaceEntry>;
  /** Read the active workspace's meta/natstack.yml config. */
  getConfig(): Promise<WorkspaceConfig>;
  /** Create a new workspace. */
  create(name: string, opts?: { forkFrom?: string }): Promise<WorkspaceEntry>;
  /** Set the panels created on first initialization (when panel tree is empty). */
  setInitPanels(entries: InitPanelEntry[]): Promise<void>;
  /** Switch to a workspace (triggers app relaunch). */
  switchTo(name: string): Promise<void>;
}

export function createWorkspaceClient(rpc: RpcCaller): WorkspaceClient {
  return {
    list: () => rpc.call("main", "workspace.list"),
    getActive: () => rpc.call("main", "workspace.getActive"),
    getActiveEntry: () => rpc.call("main", "workspace.getActiveEntry"),
    getConfig: () => rpc.call("main", "workspace.getConfig"),
    create: (name, opts) => rpc.call("main", "workspace.create", name, opts),
    setInitPanels: (entries) => rpc.call("main", "workspace.setInitPanels", entries),
    switchTo: (name) => rpc.call("main", "workspace.select", name),
  };
}
