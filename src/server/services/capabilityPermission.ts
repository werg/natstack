import type { PendingCapabilityApproval } from "@natstack/shared/approvals";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import type { CapabilityGrantIdentity, CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { CodeIdentityResolver } from "./codeIdentityResolver.js";

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
  callerId: string;
  callerKind: string;
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
  codeIdentityResolver: Pick<CodeIdentityResolver, "resolveByCallerId">;
}

export interface CapabilityPermissionResult {
  allowed: boolean;
  reason?: string;
  decision?: Exclude<GrantedDecision, "deny">;
}

export async function requestCapabilityPermission(
  deps: CapabilityPermissionDeps,
  request: CapabilityPermissionRequest,
): Promise<CapabilityPermissionResult> {
  const callerKind = normalizeCallerKind(request.callerKind);
  if (!callerKind) {
    return { allowed: false, reason: "Capability caller is not a panel or worker" };
  }

  const identity = deps.codeIdentityResolver.resolveByCallerId(request.callerId);
  if (!identity) {
    return { allowed: false, reason: `Unknown capability caller: ${request.callerId}` };
  }

  const resourceKey = request.resource.key ?? request.resource.value;
  if (deps.grantStore.hasGrant(request.capability, resourceKey, identity)) {
    return { allowed: true };
  }

  const decision = await deps.approvalQueue.request({
    kind: "capability",
    callerId: request.callerId,
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

export function resolveCapabilityIdentity(
  callerId: string,
  codeIdentityResolver: Pick<CodeIdentityResolver, "resolveByCallerId"> | undefined,
): CapabilityGrantIdentity {
  const identity = codeIdentityResolver?.resolveByCallerId(callerId);
  return {
    repoPath: identity?.repoPath ?? callerId,
    effectiveVersion: identity?.effectiveVersion ?? "unknown",
  };
}

function normalizeCallerKind(kind: string): "panel" | "worker" | null {
  if (kind === "panel" || kind === "worker") {
    return kind;
  }
  return null;
}
