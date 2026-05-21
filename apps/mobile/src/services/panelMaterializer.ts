import type { Panel } from "@natstack/shared/types";
import { getCurrentSnapshot } from "@natstack/shared/panel/accessors";
import { buildPanelUrl, type HostConfig } from "./panelUrls";

export interface MobileMaterializedPanel {
  panelId: string;
  url: string;
  managed: boolean;
  panelInit: unknown | null;
}

/**
 * Mobile shell-owned runtime materialization.
 *
 * The server owns persisted panel state. The mobile shell owns WebView runtime
 * state: load URLs and host-injected panel identity.
 */
export async function materializeMobilePanel(opts: {
  panelId: string;
  panel: Panel;
  hostConfig: HostConfig;
  getPanelInit(panelId: string): Promise<unknown>;
  acquireLease(
    panelId: string,
    runtimeEntityId: string,
    opts: { connectionId: string }
  ): Promise<{ acquired: boolean; lease?: { holderLabel: string } }>;
  takeOverLease(
    panelId: string,
    runtimeEntityId: string,
    opts: { connectionId: string }
  ): Promise<{ acquired: boolean; lease?: { holderLabel: string } }>;
  leaseMode: "acquire" | "takeOver";
}): Promise<MobileMaterializedPanel> {
  const snapshot = getCurrentSnapshot(opts.panel);
  const managed = !snapshot.source.startsWith("browser:");
  if (!managed) {
    return {
      panelId: opts.panelId,
      url: snapshot.source.slice("browser:".length),
      managed: false,
      panelInit: null,
    };
  }

  const leaseConnectionId = `mobile-${opts.panelId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const leaseClient = opts.leaseMode === "takeOver" ? opts.takeOverLease : opts.acquireLease;
  const panelInit = await opts.getPanelInit(opts.panelId);
  const runtimeEntityId =
    panelInit &&
    typeof panelInit === "object" &&
    typeof (panelInit as { entityId?: unknown }).entityId === "string"
      ? (panelInit as { entityId: string }).entityId
      : null;
  if (!runtimeEntityId) {
    throw new Error(`Panel ${opts.panelId} did not provide a runtime entity id`);
  }
  const lease = await leaseClient(opts.panelId, runtimeEntityId, {
    connectionId: leaseConnectionId,
  });
  if (!lease.acquired) {
    throw new Error(
      `Panel ${opts.panelId} is running on ${lease.lease?.holderLabel ?? "another client"}`
    );
  }
  return {
    panelId: opts.panelId,
    url: buildPanelUrl(snapshot.source, snapshot.contextId, opts.hostConfig),
    managed: true,
    panelInit:
      panelInit && typeof panelInit === "object"
        ? { ...(panelInit as Record<string, unknown>), leaseConnectionId, clientLabel: "Mobile" }
        : panelInit,
  };
}
