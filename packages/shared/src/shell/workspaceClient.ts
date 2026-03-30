/**
 * WorkspaceClient -- Shared workspace RPC wrappers.
 *
 * Wraps workspace-related server RPC calls. Platform-specific operations
 * (like workspace.select which requires app restart on Electron) are
 * intentionally excluded; each platform handles those independently.
 */

import type { RpcBridge } from "@natstack/rpc";
import type { WorkspaceEntry } from "../types.js";

export class WorkspaceClient {
  private rpc: RpcBridge;

  constructor(rpc: RpcBridge) {
    this.rpc = rpc;
  }

  list(): Promise<WorkspaceEntry[]> {
    return this.rpc.call<WorkspaceEntry[]>("main", "workspace.list");
  }

  create(name: string, opts?: { forkFrom?: string }): Promise<WorkspaceEntry> {
    return this.rpc.call<WorkspaceEntry>("main", "workspace.create", name, opts);
  }

  delete(name: string): Promise<void> {
    return this.rpc.call<void>("main", "workspace.delete", name);
  }

  getActive(): Promise<string> {
    return this.rpc.call<string>("main", "workspace.getActive");
  }
}
