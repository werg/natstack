import type { EventService } from "@natstack/shared/eventsService";
import { isValidEventName, type EventName } from "@natstack/shared/events";
import type { PanelRuntimeLeaseChangedEvent } from "@natstack/shared/panel/panelLease";
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
        forwardOAuthCallback: (request) =>
          deps.getServerClient()?.call("credentials", "forwardOAuthCallback", [request]) ??
          Promise.resolve(),
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

    if (bareEvent === "apps:available") {
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

    if (isValidEventName(bareEvent)) {
      emitNormalized(bareEvent, payload);
    }
  };
}
