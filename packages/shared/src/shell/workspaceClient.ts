/**
 * WorkspaceClient -- Shared workspace RPC wrappers.
 *
 * Wraps workspace-related server RPC calls, delegating to a typed client
 * derived from the shared `workspaceMethods` schema table. Platform-specific
 * operations (like workspace.select which requires app restart on Electron)
 * are intentionally excluded; each platform handles those independently.
 */
import type { RpcClient } from "@natstack/rpc";
import type { WorkspaceEntry } from "../types.js";
import type {
  HostTarget,
  HostTargetCandidate,
  HostTargetSelection,
  HostTargetSelectionInput,
} from "../hostTargets.js";
import { createTypedServiceClient, type TypedServiceClient } from "../typedServiceClient.js";
import { workspaceMethods } from "../serviceSchemas/workspace.js";

export class WorkspaceClient {
  private typed: TypedServiceClient<typeof workspaceMethods>;
  constructor(rpc: Pick<RpcClient, "call">) {
    this.typed = createTypedServiceClient("workspace", workspaceMethods, (service, method, args) =>
      rpc.call("main", `${service}.${method}`, args)
    );
  }
  getInfo(): ReturnType<typeof this.typed.getInfo> {
    return this.typed.getInfo();
  }
  list(): Promise<WorkspaceEntry[]> {
    return this.typed.list();
  }
  create(
    name: string,
    opts?: {
      forkFrom?: string;
    }
  ): Promise<WorkspaceEntry> {
    return this.typed.create(name, opts);
  }
  delete(name: string): Promise<void> {
    return this.typed.delete(name);
  }
  getActive(): Promise<string> {
    return this.typed.getActive();
  }
  appVersions(
    name: string
  ): Promise<{ current: unknown; previous: unknown[]; retentionLimit: number }> {
    return this.typed.units.versions(name);
  }
  rollbackApp(name: string, opts?: { buildKey?: string }): Promise<unknown> {
    return this.typed.units.rollback(name, opts);
  }
  listHostTargetCandidates(target: HostTarget): Promise<HostTargetCandidate[]> {
    return this.typed.hostTargets.list(target);
  }
  getHostTargetSelection(
    target: HostTarget
  ): Promise<{ selection: HostTargetSelection | null; valid: boolean; reason?: string }> {
    return this.typed.hostTargets.getSelection(target);
  }
  setHostTargetSelection(
    target: HostTarget,
    input: HostTargetSelectionInput
  ): Promise<HostTargetSelection> {
    return this.typed.hostTargets.setSelection(target, input);
  }
  clearHostTargetSelection(target: HostTarget): Promise<void> {
    return this.typed.hostTargets.clearSelection(target);
  }
  hostTargetVersions(
    target: HostTarget,
    sourceOrName: string
  ): Promise<{ current: unknown; previous: unknown[]; retentionLimit: number }> {
    return this.typed.hostTargets.versions(target, sourceOrName);
  }
  prepareHostTargetPinnedCommit(
    target: HostTarget,
    sourceOrName: string,
    commit: string
  ): Promise<unknown> {
    return this.typed.hostTargets.preparePinnedCommit(target, sourceOrName, commit);
  }
  launchHostTarget(target: HostTarget): Promise<{ launched: boolean }> {
    return this.typed.hostTargets.launch(target);
  }
}
