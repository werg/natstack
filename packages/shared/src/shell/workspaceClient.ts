/**
 * WorkspaceClient -- Shared workspace RPC wrappers.
 *
 * Wraps workspace-related server RPC calls. Platform-specific operations
 * (like workspace.select which requires app restart on Electron) are
 * intentionally excluded; each platform handles those independently.
 */
import type { RpcBridge } from "@natstack/rpc";
import type { WorkspaceEntry } from "../types.js";
import type {
  HostTarget,
  HostTargetCandidate,
  HostTargetSelection,
  HostTargetSelectionInput,
} from "../hostTargets.js";
export class WorkspaceClient {
  private rpc: RpcBridge;
  constructor(rpc: RpcBridge) {
    this.rpc = rpc;
  }
  list(): Promise<WorkspaceEntry[]> {
    return this.rpc.call<WorkspaceEntry[]>("main", "workspace.list", []);
  }
  create(
    name: string,
    opts?: {
      forkFrom?: string;
    }
  ): Promise<WorkspaceEntry> {
    return this.rpc.call<WorkspaceEntry>("main", "workspace.create", [name, opts]);
  }
  delete(name: string): Promise<void> {
    return this.rpc.call<void>("main", "workspace.delete", [name]);
  }
  getActive(): Promise<string> {
    return this.rpc.call<string>("main", "workspace.getActive", []);
  }
  appVersions(
    name: string
  ): Promise<{ current: unknown; previous: unknown[]; retentionLimit: number }> {
    return this.rpc.call("main", "workspace.units.versions", [name]);
  }
  rollbackApp(name: string, opts?: { buildKey?: string }): Promise<unknown> {
    return this.rpc.call("main", "workspace.units.rollback", [name, opts]);
  }
  listHostTargetCandidates(target: HostTarget): Promise<HostTargetCandidate[]> {
    return this.rpc.call("main", "workspace.hostTargets.list", [target]);
  }
  getHostTargetSelection(
    target: HostTarget
  ): Promise<{ selection: HostTargetSelection | null; valid: boolean; reason?: string }> {
    return this.rpc.call("main", "workspace.hostTargets.getSelection", [target]);
  }
  setHostTargetSelection(
    target: HostTarget,
    input: HostTargetSelectionInput
  ): Promise<HostTargetSelection> {
    return this.rpc.call("main", "workspace.hostTargets.setSelection", [target, input]);
  }
  clearHostTargetSelection(target: HostTarget): Promise<void> {
    return this.rpc.call("main", "workspace.hostTargets.clearSelection", [target]);
  }
  hostTargetVersions(
    target: HostTarget,
    sourceOrName: string
  ): Promise<{ current: unknown; previous: unknown[]; retentionLimit: number }> {
    return this.rpc.call("main", "workspace.hostTargets.versions", [target, sourceOrName]);
  }
  prepareHostTargetPinnedCommit(
    target: HostTarget,
    sourceOrName: string,
    commit: string
  ): Promise<unknown> {
    return this.rpc.call("main", "workspace.hostTargets.preparePinnedCommit", [
      target,
      sourceOrName,
      commit,
    ]);
  }
  launchHostTarget(target: HostTarget): Promise<{ launched: boolean }> {
    return this.rpc.call("main", "workspace.hostTargets.launch", [target]);
  }
}
