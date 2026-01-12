/**
 * Event Service - Subscription-based event system for shell/panels/workers.
 *
 * Replaces direct IPC event sending with a subscription model:
 * - Callers subscribe to events they care about
 * - Events are only sent to subscribers
 * - Automatic cleanup when WebContents is destroyed
 *
 * Usage:
 *   // Subscribe (from shell/panel/worker)
 *   rpc.call("main", "events.subscribe", "panel-tree-updated");
 *
 *   // Listen for events
 *   rpc.on("event:panel-tree-updated", (data) => { ... });
 */

import type { WebContents } from "electron";
import type { ServiceContext } from "../serviceDispatcher.js";
import { isValidEventName, type EventName, type EventPayloads } from "../../shared/ipc/events.js";

// Re-export for consumers
export type { EventName, EventPayloads } from "../../shared/ipc/events.js";

/**
 * Event service for managing subscriptions and emitting events.
 */
class EventService {
  private subscribers = new Map<EventName, Set<WebContents>>();

  /**
   * Subscribe a WebContents to an event.
   * Automatically cleans up when the WebContents is destroyed.
   */
  subscribe(event: EventName, webContents: WebContents): void {
    if (!this.subscribers.has(event)) {
      this.subscribers.set(event, new Set());
    }

    const subs = this.subscribers.get(event)!;
    if (subs.has(webContents)) {
      return; // Already subscribed
    }

    subs.add(webContents);

    // Clean up when WebContents is destroyed
    const cleanup = () => {
      this.subscribers.get(event)?.delete(webContents);
    };
    webContents.once("destroyed", cleanup);
  }

  /**
   * Unsubscribe a WebContents from an event.
   */
  unsubscribe(event: EventName, webContents: WebContents): void {
    this.subscribers.get(event)?.delete(webContents);
  }

  /**
   * Unsubscribe a WebContents from all events.
   */
  unsubscribeAll(webContents: WebContents): void {
    for (const subs of this.subscribers.values()) {
      subs.delete(webContents);
    }
  }

  /**
   * Emit an event to all subscribers.
   * For shell (identified by callerKind), sends via shell-rpc:event channel in RPC format.
   * For panels/workers, sends via event:{eventName} channel directly.
   */
  emit<E extends EventName>(event: E, data?: EventPayloads[E]): void {
    const subs = this.subscribers.get(event);
    if (!subs || subs.size === 0) {
      return;
    }

    const channel = `event:${event}`;
    for (const wc of subs) {
      if (!wc.isDestroyed()) {
        // Check if this is the shell WebContents (it has the __natstackKind global set to "shell")
        // We use a simple heuristic: shell subscribes via shell-rpc transport
        const callerKind = this.callerKinds.get(wc);
        if (callerKind === "shell") {
          // Shell expects RPC-formatted messages on shell-rpc:event channel
          wc.send("shell-rpc:event", {
            type: "event",
            fromId: "main",
            event: channel,
            payload: data,
          });
        } else {
          // Panels/workers get direct channel sends
          wc.send(channel, data);
        }
      }
    }
  }

  /**
   * Track caller kind for proper event formatting.
   */
  private callerKinds = new Map<WebContents, "shell" | "panel" | "worker">();

  /**
   * Set the caller kind for a WebContents.
   * Called during subscription to know how to format events.
   */
  setCallerKind(webContents: WebContents, kind: "shell" | "panel" | "worker"): void {
    this.callerKinds.set(webContents, kind);
    webContents.once("destroyed", () => {
      this.callerKinds.delete(webContents);
    });
  }

  /**
   * Emit an event to a specific WebContents (if subscribed).
   * Falls back to direct send if not using subscription model.
   */
  emitTo(webContents: WebContents, event: EventName, data?: unknown): void {
    if (!webContents.isDestroyed()) {
      webContents.send(`event:${event}`, data);
    }
  }

  /**
   * Get the number of subscribers for an event.
   */
  getSubscriberCount(event: EventName): number {
    return this.subscribers.get(event)?.size ?? 0;
  }

  /**
   * Check if a WebContents is subscribed to an event.
   */
  isSubscribed(event: EventName, webContents: WebContents): boolean {
    return this.subscribers.get(event)?.has(webContents) ?? false;
  }
}

// Singleton instance
export const eventService = new EventService();

/**
 * Service handler for the "events" service.
 * Called via service dispatcher.
 */
export async function handleEventsService(
  ctx: ServiceContext,
  method: string,
  args: unknown[]
): Promise<unknown> {
  // WebContents is required for event subscriptions
  if (!ctx.webContents) {
    throw new Error("Event subscriptions require webContents context");
  }

  switch (method) {
    case "subscribe": {
      const eventName = args[0] as EventName;
      if (!isValidEventName(eventName)) {
        throw new Error(`Unknown event: ${eventName}`);
      }
      eventService.subscribe(eventName, ctx.webContents);
      // Track caller kind for proper event formatting
      eventService.setCallerKind(ctx.webContents, ctx.callerKind);
      return;
    }

    case "unsubscribe": {
      const eventName = args[0] as EventName;
      if (!isValidEventName(eventName)) {
        throw new Error(`Unknown event: ${eventName}`);
      }
      eventService.unsubscribe(eventName, ctx.webContents);
      return;
    }

    case "unsubscribeAll": {
      eventService.unsubscribeAll(ctx.webContents);
      return;
    }

    default:
      throw new Error(`Unknown events method: ${method}`);
  }
}
