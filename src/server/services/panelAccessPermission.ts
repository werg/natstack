import type { PanelAccessOperation, PanelAccessTarget } from "@natstack/shared/panelAccessPolicy";
import {
  PANEL_AUTOMATE_CAPABILITY,
  PANEL_STRUCTURAL_CAPABILITY,
  accessDecision,
} from "@natstack/shared/panelAccessPolicy";
import type { ServiceContext, VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import {
  panelCapabilityResourceKey,
  requestCapabilityPermission,
  type CapabilityPermissionDeps,
} from "./capabilityPermission.js";

export interface PanelAccessPermissionTarget extends PanelAccessTarget {
  title?: string;
  source?: string;
  kind?: "workspace" | "browser" | string;
  runtimeEntityId?: string;
}

export interface PanelAccessPermissionDeps extends CapabilityPermissionDeps {
  resolveRequesterPanel?(caller: VerifiedCaller): Promise<PanelAccessPermissionTarget | null>;
  hasApprovalSession?(): boolean;
}

export interface PanelAccessPermissionResult {
  allowed: boolean;
  capability?: string;
  prompted?: boolean;
  reason?: string;
}

export async function requirePanelAccessPermission(
  deps: PanelAccessPermissionDeps,
  ctx: ServiceContext,
  op: PanelAccessOperation,
  target: PanelAccessPermissionTarget
): Promise<PanelAccessPermissionResult> {
  const requesterPanel =
    ctx.caller.runtime.kind === "panel" && deps.resolveRequesterPanel
      ? await deps.resolveRequesterPanel(ctx.caller)
      : null;
  if (op === "stateArgs.set" && isSelfPanelTarget(ctx.caller, target, requesterPanel)) {
    return { allowed: true };
  }
  const decision = accessDecision(
    op,
    {
      id: ctx.caller.runtime.id,
      kind: ctx.caller.runtime.kind,
      privileged: requesterPanel?.privileged === true || requesterPanel?.shell === true,
    },
    target
  );

  if (!decision.allow) {
    return { allowed: false, reason: "Panel access denied by policy" };
  }
  if (!decision.capability) {
    return { allowed: true };
  }
  const requesterEntityId = ctx.caller.runtime.id;
  const targetLabel = target.title ?? target.id;
  const resourceKey = panelCapabilityResourceKey(target.id, requesterEntityId);
  const identity = ctx.caller.code;
  const existingGrant =
    identity && deps.grantStore.hasGrant(decision.capability, resourceKey, identity);
  const impliedByAutomationGrant =
    identity &&
    decision.capability === PANEL_STRUCTURAL_CAPABILITY &&
    deps.grantStore.hasGrant(PANEL_AUTOMATE_CAPABILITY, resourceKey, identity);
  if (existingGrant || impliedByAutomationGrant) {
    return { allowed: true, capability: decision.capability };
  }
  if (!existingGrant && deps.hasApprovalSession && !deps.hasApprovalSession()) {
    return {
      allowed: false,
      capability: decision.capability,
      reason: "No approval-capable shell is connected",
    };
  }
  const result = await requestCapabilityPermission(deps, {
    caller: ctx.caller,
    capability: decision.capability,
    severity: decision.severity,
    resource: {
      type: "panel",
      label: "Panel",
      value: targetLabel,
      key: resourceKey,
    },
    title: titleFor(op, targetLabel, decision.severity),
    description: descriptionFor(op, targetLabel),
    details: [
      { label: "Operation", value: op },
      { label: "Target panel", value: target.id },
      ...(target.source ? [{ label: "Source", value: target.source }] : []),
    ],
    deniedReason: `${op} denied for panel ${target.id}`,
  });

  if (!result.allowed) {
    return { allowed: false, capability: decision.capability, reason: result.reason };
  }
  return {
    allowed: true,
    capability: decision.capability,
    prompted: result.decision !== undefined,
  };
}

function isSelfPanelTarget(
  caller: VerifiedCaller,
  target: PanelAccessPermissionTarget,
  requesterPanel: PanelAccessPermissionTarget | null
): boolean {
  if (caller.runtime.kind !== "panel") return false;
  if (target.runtimeEntityId && target.runtimeEntityId === caller.runtime.id) return true;
  if (requesterPanel?.runtimeEntityId && target.runtimeEntityId) {
    return requesterPanel.runtimeEntityId === target.runtimeEntityId;
  }
  return Boolean(requesterPanel?.id && requesterPanel.id === target.id);
}

function titleFor(
  op: PanelAccessOperation,
  targetLabel: string,
  severity: "standard" | "severe" | undefined
): string {
  if (op === "cdp") return severity === "severe" ? "Drive privileged panel" : "Automate panel";
  if (op === "navigate") return "Navigate panel";
  if (op === "reload") return "Reload panel";
  if (op === "openPanel") return "Open panel";
  if (op === "close" || op === "archive") return "Close panel";
  if (op === "unload") return "Unload panel";
  if (op === "movePanel") return "Move panel";
  if (op === "takeOver") return "Take over panel";
  if (op === "openDevTools") return "Open panel DevTools";
  if (op === "rebuildPanel") return "Rebuild panel";
  if (op === "rebuildAndReload") return "Rebuild and reload panel";
  if (op === "stateArgs.set" || op === "updatePanelState") return "Change panel state";
  return `Change ${targetLabel}`;
}

function descriptionFor(op: PanelAccessOperation, targetLabel: string): string {
  if (op === "cdp") {
    return `Allow this requester to connect to ${targetLabel} over CDP.`;
  }
  if (
    op === "navigate" ||
    op === "reload" ||
    op === "goBack" ||
    op === "goForward" ||
    op === "stop"
  ) {
    return `Allow this requester to drive ${targetLabel}.`;
  }
  if (op === "openPanel") {
    return `Allow this requester to open a panel under ${targetLabel}.`;
  }
  if (op === "close" || op === "archive") {
    return `Allow this requester to close ${targetLabel}.`;
  }
  if (op === "unload") {
    return `Allow this requester to unload ${targetLabel}.`;
  }
  if (op === "movePanel") {
    return `Allow this requester to move ${targetLabel} in the panel tree.`;
  }
  if (op === "takeOver") {
    return `Allow this requester to take over hosting for ${targetLabel}.`;
  }
  if (op === "openDevTools") {
    return `Allow this requester to open DevTools for ${targetLabel}.`;
  }
  if (op === "rebuildPanel") {
    return `Allow this requester to rebuild ${targetLabel}.`;
  }
  if (op === "rebuildAndReload") {
    return `Allow this requester to rebuild and reload ${targetLabel}.`;
  }
  if (op === "stateArgs.set" || op === "updatePanelState") {
    return `Allow this requester to change state for ${targetLabel}.`;
  }
  return `Allow this requester to change ${targetLabel}.`;
}
