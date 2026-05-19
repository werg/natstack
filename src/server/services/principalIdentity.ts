import type { EntityCache } from "@natstack/shared/runtime/entityCache";

export interface ResolvedCodeIdentity {
  callerId: string;
  callerKind: "worker" | "panel" | "do";
  repoPath: string;
  effectiveVersion: string;
}

/**
 * Resolve the code/source identity for a runtime caller, used at trust-boundary
 * hand-offs (RPC verify, capability grants, audit). Reads from the Node-side
 * `EntityCache` mirror of `WorkspaceDO`. Returns null for callers without an
 * active entity (e.g. uninitialized handshake) or unsupported kinds (server,
 * shell, extension).
 */
export function resolveCodeIdentity(
  entityCache: Pick<EntityCache, "resolveActive">,
  callerId: string
): ResolvedCodeIdentity | null {
  const record = entityCache.resolveActive(callerId);
  if (!record) return null;
  if (record.kind !== "panel" && record.kind !== "worker" && record.kind !== "do") return null;
  return {
    callerId,
    callerKind: record.kind === "panel" ? "panel" : record.kind === "do" ? "do" : "worker",
    repoPath: record.source.repoPath,
    effectiveVersion: record.source.effectiveVersion,
  };
}
