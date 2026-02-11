/**
 * Event Service - Subscription-based event system for shell/panels/workers.
 *
 * Replaces direct IPC event sending with a subscription model:
 * - Callers subscribe to events they care about
 * - Events are only sent to subscribers via WS
 * - Automatic cleanup when subscriber disconnects
 *
 * Usage:
 *   // Subscribe (from shell/panel/worker)
 *   rpc.call("main", "events.subscribe", "panel-tree-updated");
 *
 *   // Listen for events
 *   rpc.on("event:panel-tree-updated", (data) => { ... });
 */

import type { WebSocket } from "ws";
import type { ServiceContext, CallerKind } from "../serviceDispatcher.js";
import { isValidEventName, type EventName, type EventPayloads } from "../../shared/events.js";

// Re-export for consumers
export type { EventName, EventPayloads } from "../../shared/events.js";

// =============================================================================
// Subscriber interface
// =============================================================================

export interface Subscriber {
  send(channel: string, payload: unknown): void;
  readonly isAlive: boolean;
  /** Check if this subscriber is bound to the given WebSocket */
  isBoundTo(ws: WebSocket): boolean;
  onDestroyed(handler: () => void): void;
  callerKind: CallerKind;
}

/**
 * WsSubscriber — delivers events over WebSocket as ws:event messages.
 */
export class WsSubscriber implements Subscriber {
  private destroyed = false;
  private destroyHandlers: (() => void)[] = [];

  constructor(private ws: WebSocket, public callerKind: CallerKind) {
    ws.on("close", () => {
      this.destroyed = true;
      for (const handler of this.destroyHandlers) handler();
    });
  }

  get isAlive(): boolean {
    return !this.destroyed && this.ws.readyState === 1; // WebSocket.OPEN
  }

  send(channel: string, payload: unknown): void {
    if (this.isAlive) {
      this.ws.send(JSON.stringify({ type: "ws:event", event: channel, payload }));
    }
  }

  isBoundTo(ws: WebSocket): boolean {
    return this.ws === ws;
  }

  onDestroyed(handler: () => void): void {
    this.destroyHandlers.push(handler);
  }
}

// =============================================================================
// Event service
// =============================================================================

/**
 * Event service for managing subscriptions and emitting events.
 */
class EventService {
  private subscribers = new Map<EventName, Map<string, Subscriber>>();
  private subscribersByCallerId = new Map<string, Subscriber>();

  /**
   * Subscribe a caller to an event.
   * Uses callerId-keyed maps for stable identity across calls.
   */
  subscribe(event: EventName, callerId: string, subscriber: Subscriber): void {
    if (!this.subscribers.has(event)) {
      this.subscribers.set(event, new Map());
    }

    const subs = this.subscribers.get(event)!;
    subs.set(callerId, subscriber);
  }

  /**
   * Unsubscribe a caller from an event.
   */
  unsubscribe(event: EventName, callerId: string): void {
    this.subscribers.get(event)?.delete(callerId);
  }

  /**
   * Unsubscribe a caller from all events.
   */
  unsubscribeAll(callerId: string): void {
    for (const subs of this.subscribers.values()) {
      subs.delete(callerId);
    }
    this.subscribersByCallerId.delete(callerId);
  }

  /**
   * Emit an event to all subscribers.
   * All subscribers get the same ws:event message format.
   */
  emit<E extends EventName>(event: E, data?: EventPayloads[E]): void {
    const subs = this.subscribers.get(event);
    if (!subs || subs.size === 0) {
      return;
    }

    const channel = `event:${event}`;
    for (const [callerId, subscriber] of subs) {
      if (subscriber.isAlive) {
        subscriber.send(channel, data);
      } else {
        // Cleanup dead subscriber
        subs.delete(callerId);
      }
    }
  }

  /**
   * Get the number of subscribers for an event.
   */
  getSubscriberCount(event: EventName): number {
    return this.subscribers.get(event)?.size ?? 0;
  }

  /**
   * Get or create a subscriber for a callerId from a WS client.
   */
  getOrCreateSubscriber(ctx: ServiceContext): Subscriber {
    if (!ctx.wsClient) {
      throw new Error("Event subscriptions require a WS connection");
    }

    const existing = this.subscribersByCallerId.get(ctx.callerId);
    // Reuse only if alive AND bound to the same WS (connection replacement gives a new WS)
    if (existing && existing.isAlive && existing.isBoundTo(ctx.wsClient.ws)) return existing;

    // Remove stale subscriber's event entries if it was replaced
    if (existing) {
      for (const eventSubs of this.subscribers.values()) {
        eventSubs.delete(ctx.callerId);
      }
      this.subscribersByCallerId.delete(ctx.callerId);
    }

    const subscriber = new WsSubscriber(ctx.wsClient.ws, ctx.callerKind);
    this.subscribersByCallerId.set(ctx.callerId, subscriber);
    subscriber.onDestroyed(() => {
      // Only clean up if this is still the current subscriber (not replaced)
      if (this.subscribersByCallerId.get(ctx.callerId) === subscriber) {
        this.subscribersByCallerId.delete(ctx.callerId);
        for (const eventSubs of this.subscribers.values()) {
          eventSubs.delete(ctx.callerId);
        }
      }
    });
    return subscriber;
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
  switch (method) {
    case "subscribe": {
      const eventName = args[0] as EventName;
      if (!isValidEventName(eventName)) {
        throw new Error(`Unknown event: ${eventName}`);
      }
      const subscriber = eventService.getOrCreateSubscriber(ctx);
      eventService.subscribe(eventName, ctx.callerId, subscriber);
      return;
    }

    case "unsubscribe": {
      const eventName = args[0] as EventName;
      if (!isValidEventName(eventName)) {
        throw new Error(`Unknown event: ${eventName}`);
      }
      eventService.unsubscribe(eventName, ctx.callerId);
      return;
    }

    case "unsubscribeAll": {
      eventService.unsubscribeAll(ctx.callerId);
      return;
    }

    default:
      throw new Error(`Unknown events method: ${method}`);
  }
}
