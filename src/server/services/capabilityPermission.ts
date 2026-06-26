import type {
  ApprovalOperationDescriptor,
  ApprovalRequesterCategory,
  ApprovalResourceScope,
  PendingCapabilityApproval,
} from "@natstack/shared/approvals";
import type {
  VerifiedCaller,
  ServiceContext,
  DeferredResult,
} from "@natstack/shared/serviceDispatcher";
import { deferIfNeeded } from "@natstack/shared/serviceDispatcher";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";

export const NETWORK_ALL_RESOURCE_KEY = "network:*" as const;

export interface CapabilityPermissionResource {
  type: string;
  label: string;
  value: string;
  /**
   * Stable grant key. Defaults to value so existing grants remain readable and
   * call sites can choose human-readable keys for non-URL resources.
   */
  key?: string;
  scope?: ApprovalResourceScope;
}

export function panelCapabilityResourceKey(
  targetPanelId: string,
  requesterEntityId: string
): string {
  return `panel:${targetPanelId}:requester:${requesterEntityId}`;
}

export interface CapabilityPermissionRequest {
  caller: VerifiedCaller;
  capability: string;
  severity?: PendingCapabilityApproval["severity"];
  dedupKey?: string | null;
  requesterCategory?: ApprovalRequesterCategory;
  operation?: ApprovalOperationDescriptor;
  signal?: AbortSignal;
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
      reason: "Capability caller is not an app, panel, worker, or durable object",
    };
  }

  const identity = request.caller.code;
  if (!identity) {
    return { allowed: false, reason: `Unknown capability caller: ${request.caller.runtime.id}` };
  }

  const resourceKey = request.resource.key ?? request.resource.value;
  const resourceScope = request.resource.scope ?? exactResourceScope(resourceKey);
  const dedupKey = request.dedupKey;
  if (deps.grantStore.hasGrant(request.capability, resourceKey, identity, resourceScope)) {
    return { allowed: true };
  }

  const decision = await deps.approvalQueue.request({
    kind: "capability",
    callerId: request.caller.runtime.id,
    callerKind,
    repoPath: identity.repoPath,
    effectiveVersion: identity.effectiveVersion,
    capability: request.capability,
    severity: request.severity,
    dedupKey,
    ...(request.requesterCategory ? { requesterCategory: request.requesterCategory } : {}),
    ...(request.operation ? { operation: request.operation } : {}),
    title: request.title,
    description: request.description,
    resource: {
      type: request.resource.type,
      label: request.resource.label,
      value: request.resource.value,
    },
    resourceScope,
    grantResourceKey: resourceKey,
    details: request.details,
    signal: request.signal,
  });
  if (decision === "deny") {
    return { allowed: false, reason: request.deniedReason };
  }
  if (decision !== "once") {
    const reusableDecision = decision as Exclude<GrantedDecision, "once" | "deny">;
    const grantIntent = resourceGrantIntentForDecision(
      request.capability,
      resourceKey,
      resourceScope,
      reusableDecision
    );
    deps.grantStore.grant(
      request.capability,
      grantIntent.resourceKey,
      identity,
      reusableDecision,
      grantIntent.resourceScope
    );
    if (typeof deps.approvalQueue.resolveMatching === "function") {
      deps.approvalQueue.resolveMatching((approval) => {
        if (approval.kind !== "capability") return false;
        const pendingResourceKey = approval.grantResourceKey ?? approval.resource?.value;
        if (!pendingResourceKey) return false;
        return deps.grantStore.hasGrant(
          approval.capability,
          pendingResourceKey,
          {
            callerId: approval.callerId,
            repoPath: approval.repoPath,
            effectiveVersion: approval.effectiveVersion,
          },
          approval.resourceScope
        );
      }, "once");
    }
  }
  return { allowed: true, decision };
}

/**
 * True if a non-prompting grant already covers this capability/resource for the
 * caller — the cheap pre-check that lets {@link withCapability} keep the fast
 * path inline (no deferral round-trip) when no human approval is needed.
 */
export function capabilityAlreadyGranted(
  deps: CapabilityPermissionDeps,
  caller: VerifiedCaller,
  capability: string,
  resource: CapabilityPermissionResource
): boolean {
  const identity = caller.code;
  if (!identity) return false;
  const resourceKey = resource.key ?? resource.value;
  return deps.grantStore.hasGrant(
    capability,
    resourceKey,
    identity,
    resource.scope ?? exactResourceScope(resourceKey)
  );
}

/**
 * Run a capability-gated action, deferring the whole approve-then-act
 * continuation out-of-band when the caller opted into deferral (callDeferred)
 * and an approval is actually pending. When a grant already exists, or the
 * caller can't defer, it runs inline — so existing callers see identical UX.
 *
 * The `continuation` receives the authorization result and owns the
 * allowed/denied handling (each call site keeps its own behavior).
 */
export function withCapability<T>(
  deps: CapabilityPermissionDeps,
  ctx: ServiceContext,
  request: Omit<CapabilityPermissionRequest, "caller" | "signal">,
  continuation: (authorization: CapabilityPermissionResult) => Promise<T>
): Promise<T> | DeferredResult {
  const granted = capabilityAlreadyGranted(deps, ctx.caller, request.capability, request.resource);
  return deferIfNeeded(ctx, !granted, async (signal) =>
    continuation(
      await requestCapabilityPermission(deps, { ...request, caller: ctx.caller, signal })
    )
  );
}

export function normalizeCallerKind(kind: string): "panel" | "app" | "worker" | "do" | null {
  if (kind === "panel" || kind === "app" || kind === "worker" || kind === "do") {
    return kind;
  }
  return null;
}

function exactResourceScope(key: string): ApprovalResourceScope {
  return { kind: "exact", key };
}

function resourceGrantIntentForDecision(
  capability: string,
  resourceKey: string,
  resourceScope: ApprovalResourceScope,
  decision: Exclude<GrantedDecision, "once" | "deny">
): { resourceKey: string; resourceScope: ApprovalResourceScope } {
  if (isNetworkCapability(capability) && (decision === "version" || decision === "repo")) {
    return {
      resourceKey: NETWORK_ALL_RESOURCE_KEY,
      resourceScope: { kind: "network", value: "*" },
    };
  }
  return { resourceKey, resourceScope };
}

function isNetworkCapability(capability: string): boolean {
  return capability === "external-network-fetch" || capability === "cors-response-read";
}
