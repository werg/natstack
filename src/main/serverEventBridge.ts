import type { EventService } from "@natstack/shared/eventsService";
import { isValidEventName, type EventName } from "@natstack/shared/events";
import type { PanelTreeSnapshot } from "@natstack/shared/types";
import type { PanelRuntimeLeaseChangedEvent } from "@natstack/shared/panel/panelLease";
import type { PendingApproval } from "@natstack/shared/approvals";
import { credentialsMethods } from "@natstack/shared/serviceSchemas/credentials";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import type { ServerClient } from "./serverClient.js";
import type { PanelOrchestrator } from "./panelOrchestrator.js";
import type { AppOrchestrator, AppAvailableEvent } from "./appOrchestrator.js";
import { handleExternalOpenPayload, type ExternalOpenPayload } from "./oauthLoopbackHandoff.js";

export interface ServerEventBridgeDeps {
  eventService: EventService;
  getPanelOrchestrator(): PanelOrchestrator | null;
  getAppOrchestrator?(): AppOrchestrator | null;
  getServerClient(): ServerClient | null;
  openExternal(url: string): Promise<void>;
  warn(message: string): void;
  /** OS-level attention (badge/flash/notification) for pending approvals. */
  onApprovalPendingChanged?(pending: PendingApproval[]): void;
  /** Host-target apps changed state; desktop bootstrap can retry launch. */
  onAppHostTargetChanged?(event: ServerHostTargetChangeEvent): void;
}

export interface ServerHostTargetChangeEvent {
  event:
    | "apps:available"
    | "apps:status"
    | "extensions:status"
    | "host-targets:changed"
    | "host-target-launch:session-changed";
  payload: unknown;
}

/**
 * Normalizes raw server events before they enter the local shell event bus.
 *
 * Raw server events are either direct control-plane messages such as
 * `build:complete`, or EventService frames prefixed as `event:<name>`. Any event
 * requiring local Electron state, ID translation, or side effects is consumed
 * here. Only normalized shell events are re-emitted to the renderer.
 */
export function createServerEventBridge(deps: ServerEventBridgeDeps) {
  const emitNormalized = (event: EventName, payload: unknown): void => {
    (deps.eventService.emit as (e: EventName, d: unknown) => void)(event, payload);
  };
  const credentialsClientFor = (client: ServerClient) =>
    createTypedServiceClient("credentials", credentialsMethods, (service, method, args) =>
      client.call(service, method, args)
    );

  return function handleServerEvent(event: string, payload: unknown): void {
    const panelOrchestrator = deps.getPanelOrchestrator();
    const appOrchestrator = deps.getAppOrchestrator?.() ?? null;

    if (event === "build:complete") {
      const { source, error } = payload as { source?: unknown; error?: unknown };
      if (typeof source === "string") {
        panelOrchestrator?.applyBuildComplete(
          source,
          typeof error === "string" ? error : undefined
        );
      }
      return;
    }

    if (!event.startsWith("event:")) return;

    const bareEvent = event.slice("event:".length);
    if (bareEvent === "external-open:open") {
      void handleExternalOpenPayload(payload as ExternalOpenPayload, {
        openExternal: deps.openExternal,
        forwardOAuthCallback: (request) => {
          const client = deps.getServerClient();
          return client
            ? credentialsClientFor(client).forwardOAuthCallback(request)
            : Promise.resolve();
        },
      }).catch((err: unknown) => {
        deps.warn(
          `[externalOpen] OAuth browser handoff failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
      return;
    }

    if (bareEvent === "browser-panel:open") {
      const { url, parentPanelId } = payload as { url?: unknown; parentPanelId?: unknown };
      if (typeof url === "string" && typeof parentPanelId === "string") {
        void panelOrchestrator
          ?.createBrowserUrlPanel(parentPanelId, url, { focus: true })
          .catch((err: unknown) => {
            deps.warn(
              `[browserPanel] createBrowserUrlPanel failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          });
      }
      return;
    }

    if (bareEvent === "panel:runtimeLeaseChanged") {
      const leaseEvent = payload as PanelRuntimeLeaseChangedEvent;
      void panelOrchestrator?.applyRuntimeLeaseChanged(leaseEvent).catch((err: unknown) => {
        deps.warn(
          `[panelRuntime] failed to apply lease change for ${leaseEvent.slotId}/${leaseEvent.runtimeEntityId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
      return;
    }

    if (bareEvent === "panel-title-updated") {
      const { panelId, title, explicit } = payload as {
        panelId?: unknown;
        title?: unknown;
        explicit?: unknown;
      };
      if (typeof panelId === "string" && typeof title === "string") {
        panelOrchestrator?.applyServerPanelTitleUpdate({
          panelId,
          title,
          explicit: explicit === true,
        });
      }
      return;
    }

    if (bareEvent === "apps:available") {
      deps.onAppHostTargetChanged?.({ event: "apps:available", payload });
      void appOrchestrator
        ?.applyAppAvailable(payload as AppAvailableEvent)
        .catch((err: unknown) => {
          deps.warn(
            `[apps] failed to apply app availability: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        });
      if (isValidEventName(bareEvent)) {
        emitNormalized(bareEvent, payload);
      }
      return;
    }

    if (
      bareEvent === "host-targets:changed" ||
      bareEvent === "host-target-launch:session-changed"
    ) {
      const target =
        payload && typeof payload === "object" ? (payload as { target?: unknown }).target : null;
      if (!target || target === "electron") {
        deps.onAppHostTargetChanged?.({ event: bareEvent, payload });
      }
      if (isValidEventName(bareEvent)) {
        emitNormalized(bareEvent, payload);
      }
      return;
    }

    if (bareEvent === "apps:status" || bareEvent === "extensions:status") {
      deps.onAppHostTargetChanged?.({ event: bareEvent, payload });
    }

    if (bareEvent === "panel-tree-updated") {
      void panelOrchestrator
        ?.applyServerPanelTreeSnapshot(payload as PanelTreeSnapshot)
        .catch((err: unknown) => {
          deps.warn(
            `[panelTree] failed to apply server tree snapshot: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        });
      return;
    }

    if (bareEvent === "shell-approval:pending-changed") {
      const { pending } = payload as { pending?: unknown };
      if (Array.isArray(pending)) {
        deps.onApprovalPendingChanged?.(pending as PendingApproval[]);
      }
      // Fall through — the renderer's approval bar consumes the same event.
    }

    if (isValidEventName(bareEvent)) {
      emitNormalized(bareEvent, payload);
    }
  };
}
