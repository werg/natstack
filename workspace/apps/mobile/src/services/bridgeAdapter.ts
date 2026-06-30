import type { PanelManager } from "@natstack/shared/shell/panelManager";
import { asPanelSlotId, type PanelEntityId } from "@natstack/shared/panel/ids";
import type { OpenExternalOptions } from "@natstack/shared/externalOpen";
import { externalOpenMethods } from "@natstack/shared/serviceSchemas/externalOpen";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import type { RpcEnvelope } from "@natstack/rpc";
import type { WebRtcSession } from "@natstack/rpc/transports/webrtcClient";
import type { MobileRpcClient } from "./mobileTransport";

export interface BridgeAdapterCallbacks {
  navigateToPanel(panelId: string): void;
}

export function createBridgeAdapter(deps: {
  panelManager: PanelManager;
  transport: MobileRpcClient;
  callbacks: BridgeAdapterCallbacks;
  getPanelInit?: (panelId: string) => Promise<unknown>;
  /** Push an inbound RPC envelope into a panel's webview (host → panel). */
  deliverToPanel: (panelId: string, envelope: unknown) => void;
  /**
   * The panel's runtime lease — entity id (the server's panel principal + lease
   * key) and the lease's connectionId. The panel session must redeem a grant for
   * the entity id and open on that exact connectionId so authorizePanelConnection
   * matches; undefined until the panel has been materialized (lease acquired).
   */
  getPanelLease: (
    panelId: string
  ) => { runtimeEntityId: PanelEntityId; connectionId: string } | undefined;
}) {
  // Tree mutations from hosted webviews route through the single server
  // authority (panelTree); the mirror updates reactively via the broadcast.
  const callPanelTree = <T = unknown>(method: string, callArgs: unknown[]): Promise<T> =>
    deps.transport.call("main", `panelTree.${method}`, callArgs) as Promise<T>;

  // Panel RPC relay. A panel's RpcClient rides this postMessage bridge: it sends
  // RPC envelopes via `postEnvelope` and receives them via `onEnvelope` (delivered
  // by `deliverToPanel`). Each panel gets its OWN grant-authenticated "panel"
  // session over the pipe, and we relay its envelopes TRANSPARENTLY over that
  // dedicated session (send out; the session's onMessage → deliverToPanel). The
  // server attributes by the authenticated session, so the panel's calls carry the
  // "panel" principal that capability-gated services (e.g. PubSub `subscribe`)
  // require — NOT "shell". Because the session is dedicated to this panel, replies,
  // events and stream frames demux straight back to it with no shared-session
  // ambiguity, and all RpcMessage types relay without per-type handling.
  const panelSessions = new Map<string, Promise<WebRtcSession>>();

  function ensurePanelSession(panelId: string): Promise<WebRtcSession> {
    let pending = panelSessions.get(panelId);
    if (!pending) {
      pending = (async () => {
        const lease = deps.getPanelLease(panelId);
        if (!lease) {
          throw new Error(`Panel ${panelId} has no runtime lease yet — cannot open panel session`);
        }
        const session = await deps.transport.openPanelSession(
          lease.runtimeEntityId,
          lease.connectionId
        );
        session.onMessage((envelope) => deps.deliverToPanel(panelId, envelope));
        return session;
      })();
      panelSessions.set(panelId, pending);
      // Drop a failed open so a later postEnvelope retries instead of reusing the
      // cached rejection.
      pending.catch(() => {
        if (panelSessions.get(panelId) === pending) panelSessions.delete(panelId);
      });
    }
    return pending;
  }

  function closePanelSession(panelId: string): void {
    const pending = panelSessions.get(panelId);
    if (!pending) return;
    panelSessions.delete(panelId);
    void pending.then((session) => session.close()).catch(() => {});
  }

  return {
    closePanelSession,
    async handle(panelId: string, method: string, args: unknown[]): Promise<unknown> {
      const slotId = asPanelSlotId(panelId);
      switch (method) {
        case "getPanelInit":
          if (deps.getPanelInit) return deps.getPanelInit(panelId);
          return deps.panelManager.getPanelInit(slotId);
        case "getInfo":
          return deps.panelManager.getInfo(slotId);
        case "focusPanel": {
          const targetId = args[0] as string;
          await deps.panelManager.notifyFocused(asPanelSlotId(targetId));
          deps.callbacks.navigateToPanel(targetId);
          return;
        }
        case "openPanelChild": {
          const [source, options] = args as [
            string,
            {
              name?: string;
              focus?: boolean;
              stateArgs?: Record<string, unknown>;
            }?,
          ];
          const created = await callPanelTree<{ id: string; title: string; kind: string }>(
            "create",
            [source, { parentId: panelId, name: options?.name, stateArgs: options?.stateArgs }]
          );
          if (options?.focus !== false) {
            deps.callbacks.navigateToPanel(created.id);
          }
          return { id: created.id, title: created.title, kind: created.kind };
        }
        case "openExternal": {
          const [url, options] = args as [string, OpenExternalOptions?];
          const externalOpen = createTypedServiceClient(
            "externalOpen",
            externalOpenMethods,
            (svc, method, callArgs) => deps.transport.call("main", `${svc}.${method}`, callArgs)
          );
          await externalOpen.openExternal(url, options);
          return;
        }
        case "getCdpEndpoint":
        case "navigate":
        case "goBack":
        case "goForward":
        case "stop":
          throw new Error(
            "CDP automation is routed through the server broker and is not available for mobile-held WebViews"
          );
        case "openDevtools":
          return;
        case "openFolderDialog":
          return null;
        case "postEnvelope": {
          // One-way send over the panel's dedicated "panel" session; replies +
          // events arrive via the session's onMessage → deliverToPanel.
          const [envelope] = args as [RpcEnvelope];
          void ensurePanelSession(panelId)
            // Return the send promise so a send rejection is caught here rather
            // than becoming an unhandled rejection (Finding 5).
            .then((session) => session.send(envelope))
            .catch((err) =>
              console.warn(`[bridgeAdapter] postEnvelope relay failed (panel ${panelId}):`, err)
            );
          return;
        }
        default:
          throw new Error(`Unknown mobile bridge method: ${method}`);
      }
    },
  };
}
