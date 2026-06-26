import type { PendingCapabilityApproval } from "@natstack/shared/approvals";
import type { VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import {
  requestCapabilityPermission,
  type CapabilityPermissionDeps,
  type CapabilityPermissionResult,
} from "./capabilityPermission.js";

/**
 * The single context-isolation capability. A control-plane action (launch a
 * panel/worker/DO, retire one, drive/close/navigate a panel) is gated by this
 * capability iff it targets a context that is NOT the caller's own AND that
 * context already exists (holds state). Same-context and fresh-foreign actions
 * are free. This replaces the former `panel.structural` / `panel.automate` /
 * `workerd.lifecycle` / `runtime.crossContextEntity` capabilities.
 */
export const CONTEXT_BOUNDARY_CAPABILITY = "context.boundary" as const;

/** Grant key: one approval covers a (subject, target-context) pair. */
export function contextBoundaryResourceKey(targetContextId: string, subjectId: string): string {
  return `context:${targetContextId}:requester:${subjectId}`;
}

export interface ContextBoundaryDeps extends CapabilityPermissionDeps {
  /** True when the target context already holds state (active entity OR a materialized folder). */
  contextExists(contextId: string): boolean;
  /** Human label for the entity owning the target context, for prompt copy. */
  resolveContextOwnerLabel?(contextId: string): string | undefined;
}

export interface ContextBoundaryAction {
  /** Approval operation kind (matches existing approvalCopy switch values). */
  kind: "runtime" | "panel" | "worker-lifecycle";
  /** Verb shown in the prompt, e.g. "Create panel", "Close", "Navigate", "Destroy". */
  verb: string;
  /** Optional subject/source label (e.g. the panel source) for the details list. */
  targetLabel?: string;
  severity?: PendingCapabilityApproval["severity"];
  /** Coalesce duplicate prompts for the same logical operation. */
  groupKey?: string;
  signal?: AbortSignal;
}

export interface ContextBoundaryRequest {
  /**
   * Identity the prompt/grant is attributed to. MUST carry `.code` (a
   * panel/worker/do/app principal) — `requestCapabilityPermission` denies
   * (does not prompt) a `server`/`shell` caller, so callers resolve a concrete
   * subject (the acting entity, or the host-set anchor entity) first.
   */
  subjectCaller: VerifiedCaller;
  /** The acting/origin context. `null` => no usable origin (treated as foreign). */
  originContextId: string | null;
  /** The context being launched into / acted upon. */
  targetContextId: string;
  action: ContextBoundaryAction;
}

/**
 * The single context-boundary gate. Prompts iff `targetContextId` is foreign to
 * the subject AND already exists. Pure (no side effects); run it BEFORE any
 * mutation so denial is non-destructive.
 */
export async function requireContextBoundaryPermission(
  deps: ContextBoundaryDeps,
  request: ContextBoundaryRequest
): Promise<CapabilityPermissionResult> {
  const { subjectCaller, originContextId, targetContextId, action } = request;

  // Own context → free (subsumes self-targeting).
  if (originContextId != null && targetContextId === originContextId) {
    return { allowed: true };
  }
  // Foreign but fresh (no existing state to intrude on) → free.
  if (!deps.contextExists(targetContextId)) {
    return { allowed: true };
  }

  const subjectId = subjectCaller.runtime.id;
  const ownerLabel = deps.resolveContextOwnerLabel?.(targetContextId);
  const target = ownerLabel ?? targetContextId;
  const resourceKey = contextBoundaryResourceKey(targetContextId, subjectId);

  const details: NonNullable<PendingCapabilityApproval["details"]> = [];
  if (ownerLabel) details.push({ label: "Owner", value: ownerLabel });
  details.push({ label: "Target context", value: targetContextId });
  if (action.targetLabel) details.push({ label: "Subject", value: action.targetLabel });

  return requestCapabilityPermission(deps, {
    caller: subjectCaller,
    capability: CONTEXT_BOUNDARY_CAPABILITY,
    ...(action.severity ? { severity: action.severity } : {}),
    dedupKey: `context-boundary:${subjectId}:${targetContextId}`,
    ...(action.signal ? { signal: action.signal } : {}),
    resource: { type: "context", label: "Target context", value: target, key: resourceKey },
    operation: {
      kind: action.kind,
      verb: action.verb,
      object: { type: "context", label: "Context", value: target },
      ...(action.groupKey ? { groupKey: action.groupKey } : {}),
    },
    title: `${action.verb} in ${ownerLabel ? `${ownerLabel}'s` : `context ${targetContextId}`}`,
    description: `Runs code in / acts on ${
      ownerLabel ? `${ownerLabel}'s` : `context ${targetContextId}`
    } — another agent or panel's existing state.`,
    details,
    deniedReason: `${action.verb} denied: ${target} is another agent or panel's existing state`,
  });
}
