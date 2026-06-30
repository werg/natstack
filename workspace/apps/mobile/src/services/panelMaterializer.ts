import type { Panel } from "@natstack/shared/types";
import { getCurrentSnapshot } from "@natstack/shared/panel/accessors";
import { formatPanelRuntimeLeaseDeniedMessage } from "@natstack/shared/panel/panelLease";
import { asPanelEntityId, type PanelEntityId } from "@natstack/shared/panel/ids";
import { buildPanelUrl, type HostConfig } from "./panelUrls";

export interface MobileMaterializedPanel {
  panelId: string;
  url: string;
  managed: boolean;
  panelInit: unknown | null;
}

/**
 * Mobile workspace app-owned runtime materialization.
 *
 * The server owns persisted panel state. The mobile app owns WebView runtime
 * state: load URLs and host-injected panel identity.
 */
export async function materializeMobilePanel(opts: {
  panelId: string;
  panel: Panel;
  hostConfig: HostConfig;
  getPanelInit(panelId: string): Promise<unknown>;
  acquireLease(
    panelId: string,
    runtimeEntityId: PanelEntityId,
    opts: { connectionId: string }
  ): Promise<{ acquired: boolean; lease?: { holderLabel: string } }>;
  takeOverLease(
    panelId: string,
    runtimeEntityId: PanelEntityId,
    opts: { connectionId: string }
  ): Promise<{ acquired: boolean; lease?: { holderLabel: string } }>;
  leaseMode: "acquire" | "takeOver";
}): Promise<MobileMaterializedPanel> {
  const snapshot = getCurrentSnapshot(opts.panel);
  const managed = !snapshot.source.startsWith("browser:");
  const connectionId = `mobile-${opts.panelId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const leaseClient = opts.leaseMode === "takeOver" ? opts.takeOverLease : opts.acquireLease;
  const panelInit = await opts.getPanelInit(opts.panelId);
  const rawEntityId =
    panelInit &&
    typeof panelInit === "object" &&
    typeof (panelInit as { entityId?: unknown }).entityId === "string"
      ? (panelInit as { entityId: string }).entityId
      : null;
  if (!rawEntityId) {
    throw new Error(`Panel ${opts.panelId} did not provide a runtime entity id`);
  }
  // Validate the SHAPE here (throws loudly on a slot id "panel:tree/…" where an
  // entity id "panel:nav-…" is required) so the slot/entity mix-up cannot reach
  // the lease + grant as a laundered raw string — the brand then enforces it
  // through acquireLease → runtimeConnectionBySlot → openPanelSession at compile
  // time.
  const runtimeEntityId: PanelEntityId = asPanelEntityId(rawEntityId);
  const lease = await leaseClient(opts.panelId, runtimeEntityId, {
    connectionId,
  });
  if (!lease.acquired) {
    throw new Error(formatPanelRuntimeLeaseDeniedMessage(opts.panelId, lease.lease));
  }
  if (!managed) {
    return {
      panelId: opts.panelId,
      url: snapshot.source.slice("browser:".length),
      managed: false,
      panelInit: null,
    };
  }
  return {
    panelId: opts.panelId,
    url: buildPanelUrl(snapshot.source, snapshot.contextId, opts.hostConfig),
    managed: true,
    panelInit:
      panelInit && typeof panelInit === "object"
        ? {
            ...(panelInit as Record<string, unknown>),
            connectionId,
            clientLabel: "Mobile",
          }
        : panelInit,
  };
}
