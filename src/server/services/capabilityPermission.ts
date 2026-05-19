import type { PendingCapabilityApproval } from "@natstack/shared/approvals";
import type { VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";

/**
 * Canonical capability name guarding cross-context durable-object entity access.
 * Re-exported here so callers can import the constant from the capability
 * permission module rather than redefining it.
 */
export const RUNTIME_CROSS_CONTEXT_ENTITY = "runtime.crossContextEntity" as const;

export interface CapabilityPermissionResource {
  type: string;
  label: string;
  value: string;
  /**
   * Stable grant key. Defaults to value so existing grants remain readable and
   * call sites can choose human-readable keys for non-URL resources.
   */
  key?: string;
}

export interface CapabilityPermissionRequest {
  caller: VerifiedCaller;
  capability: string;
  dedupKey?: string | null;
  resource: CapabilityPermissionResource;
  title: string;
  description?: string;
  details?: PendingCapabilityApproval["details"];
  deniedReason: string;
}

export interface CapabilityPermissionDeps {
  approvalQueue: ApprovalQueue;
  grantStore: CapabilityGrantStore;
}

export interface CapabilityPermissionResult {
  allowed: boolean;
  reason?: string;
  decision?: Exclude<GrantedDecision, "deny">;
}

export async function requestCapabilityPermission(
  deps: CapabilityPermissionDeps,
  request: CapabilityPermissionRequest
): Promise<CapabilityPermissionResult> {
  const callerKind = normalizeCallerKind(request.caller.runtime.kind);
  if (!callerKind) {
    return {
      allowed: false,
      reason: "Capability caller is not a panel, worker, or durable object",
    };
  }

  const identity = request.caller.code;
  if (!identity) {
    return { allowed: false, reason: `Unknown capability caller: ${request.caller.runtime.id}` };
  }

  const resourceKey = request.resource.key ?? request.resource.value;
  if (deps.grantStore.hasGrant(request.capability, resourceKey, identity)) {
    return { allowed: true };
  }

  const decision = await deps.approvalQueue.request({
    kind: "capability",
    callerId: request.caller.runtime.id,
    callerKind,
    repoPath: identity.repoPath,
    effectiveVersion: identity.effectiveVersion,
    capability: request.capability,
    dedupKey: request.dedupKey,
    title: request.title,
    description: request.description,
    resource: {
      type: request.resource.type,
      label: request.resource.label,
      value: request.resource.value,
    },
    details: request.details,
  });
  if (decision === "deny") {
    return { allowed: false, reason: request.deniedReason };
  }
  if (decision !== "once") {
    deps.grantStore.grant(request.capability, resourceKey, identity, decision);
  }
  return { allowed: true, decision };
}

export function normalizeCallerKind(kind: string): "panel" | "worker" | "do" | null {
  if (kind === "panel" || kind === "worker" || kind === "do") {
    return kind;
  }
  return null;
}
