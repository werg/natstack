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

import { z } from "zod";
import type { WebSocket } from "ws";
import type { ServiceDefinition } from "./serviceDefinition.js";
import type { ServiceContext, CallerKind } from "./serviceDispatcher.js";
import { isValidEventName, type EventName, type EventPayloads } from "./events.js";

// Re-export for consumers
export type { EventName, EventPayloads } from "./events.js";

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
 * A live transport instance for one authenticated caller.
 *
 * `callerId` is durable identity: it survives reconnects and may have multiple
 * simultaneous live sessions. `connectionId` is transport identity: it names
 * exactly one live connection and must not be persisted.
 */
export interface EventSession extends Subscriber {
  callerId: string;
  connectionId: string;
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

export class WsEventSession extends WsSubscriber implements EventSession {
  constructor(
    ws: WebSocket,
    callerKind: CallerKind,
    public callerId: string,
    public connectionId: string,
  ) {
    super(ws, callerKind);
  }
}

// =============================================================================
// Event service
// =============================================================================

/**
 * Event service for managing subscriptions and emitting events.
 *
 * Two independent delivery surfaces, intentionally kept distinct:
 *
 *   1. **`emit(event, data)` — pub/sub broadcast.** Fans `data` out to every
 *      subscriber that called `events.subscribe(event)`. Iterates the
 *      event-keyed table (`subscribers`). Use for anything a caller opts
 *      into ("notify me when the panel tree changes").
 *
 *   2. **`emitToCaller(callerId, event, data)` — direct caller address.**
 *      Delivers to every live connection for one caller ID, bypassing the
 *      subscription table. The target doesn't need to have called
 *      `events.subscribe` — being authenticated on the RPC server is
 *      sufficient (see `RpcServer.handleAuth`, which registers an
 *      `EventSession`). Use when all live instances for one durable caller
 *      should receive a message.
 *
 *   3. **`emitToConnection(callerId, connectionId, event, data)` — direct
 *      session address.** Delivers to exactly one transport instance. Use for
 *      request/response-adjacent handoffs where delivering to a sibling shell
 *      or panel connection would be surprising.
 *
 * The two tables overlap deliberately. A caller who calls `events.subscribe`
 * for event X AND is authenticated will receive a `broadcast(X)` via `emit`
 * AND a direct-address via `emitToCaller/emitToConnection(event=X)`. That's
 * fine — direct delivery doesn't consult `subscribers`, and `emit` iterates
 * `subscribers` only. A caller who `events.unsubscribe`s from X still
 * receives direct delivery because direct-address semantics aren't governed by
 * the subscription table. Live sessions are cleaned up by connection
 * destruction, not by event-name unsubscription.
 */
export class EventService {
  static readonly DEFAULT_CONNECTION_ID = "_default";

  private subscribers = new Map<EventName, Map<string, Map<string, Subscriber>>>();
  private sessionsByCallerId = new Map<string, Map<string, EventSession>>();

  private getConnectionId(connectionId?: string): string {
    return connectionId ?? EventService.DEFAULT_CONNECTION_ID;
  }

  private getSessionBucket(callerId: string, create: true): Map<string, EventSession>;
  private getSessionBucket(callerId: string, create?: false): Map<string, EventSession> | undefined;
  private getSessionBucket(
    callerId: string,
    create = false,
  ): Map<string, EventSession> | undefined {
    let bucket = this.sessionsByCallerId.get(callerId);
    if (!bucket && create) {
      bucket = new Map();
      this.sessionsByCallerId.set(callerId, bucket);
    }
    return bucket;
  }

  private removeSubscriber(callerId: string, connectionId: string, subscriber?: Subscriber): void {
    const bucket = this.sessionsByCallerId.get(callerId);
    if (bucket) {
      if (!subscriber || bucket.get(connectionId) === subscriber) {
        bucket.delete(connectionId);
      }
      if (bucket.size === 0) {
        this.sessionsByCallerId.delete(callerId);
      }
    }

    for (const eventSubs of this.subscribers.values()) {
      const callerSubs = eventSubs.get(callerId);
      if (!callerSubs) continue;
      if (!subscriber || callerSubs.get(connectionId) === subscriber) {
        callerSubs.delete(connectionId);
      }
      if (callerSubs.size === 0) {
        eventSubs.delete(callerId);
      }
    }
  }

  /**
   * Subscribe a caller to an event.
   * Uses callerId + connectionId keyed maps for stable identity across calls.
   */
  subscribe(
    event: EventName,
    callerId: string,
    subscriber: Subscriber,
    connectionId?: string,
  ): void {
    if (!this.subscribers.has(event)) {
      this.subscribers.set(event, new Map());
    }

    const subs = this.subscribers.get(event)!;
    let callerSubs = subs.get(callerId);
    if (!callerSubs) {
      callerSubs = new Map();
      subs.set(callerId, callerSubs);
    }
    callerSubs.set(this.getConnectionId(connectionId), subscriber);
  }

  /**
   * Unsubscribe a caller from an event.
   */
  unsubscribe(event: EventName, callerId: string, connectionId?: string): void {
    const callerSubs = this.subscribers.get(event)?.get(callerId);
    if (!callerSubs) return;
    callerSubs.delete(this.getConnectionId(connectionId));
    if (callerSubs.size === 0) {
      this.subscribers.get(event)?.delete(callerId);
    }
  }

  /**
   * Unsubscribe a caller from all events.
   */
  unsubscribeAll(callerId: string, connectionId?: string): void {
    const resolvedConnectionId = this.getConnectionId(connectionId);
    for (const subs of this.subscribers.values()) {
      const callerSubs = subs.get(callerId);
      if (!callerSubs) continue;
      callerSubs.delete(resolvedConnectionId);
      if (callerSubs.size === 0) {
        subs.delete(callerId);
      }
    }
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
    for (const [callerId, callerSubs] of subs) {
      for (const [connectionId, subscriber] of callerSubs) {
        if (subscriber.isAlive) {
          subscriber.send(channel, data);
        } else {
          this.removeSubscriber(callerId, connectionId, subscriber);
        }
      }
      if (callerSubs.size === 0) {
        subs.delete(callerId);
      }
    }
  }

  /** Direct-address every live connection for one durable caller identity. */
  emitToCaller<E extends EventName>(
    callerId: string,
    event: E,
    data?: EventPayloads[E],
  ): boolean {
    const callerSubs = this.sessionsByCallerId.get(callerId);
    if (!callerSubs || callerSubs.size === 0) return false;

    let delivered = false;
    const channel = `event:${event}`;
    for (const [connectionId, subscriber] of callerSubs) {
      if (subscriber.isAlive) {
        subscriber.send(channel, data);
        delivered = true;
      } else {
        this.removeSubscriber(callerId, connectionId, subscriber);
      }
    }
    return delivered;
  }

  /** Direct-address exactly one live transport connection for a caller. */
  emitToConnection<E extends EventName>(
    callerId: string,
    connectionId: string,
    event: E,
    data?: EventPayloads[E],
  ): boolean {
    const resolvedConnectionId = this.getConnectionId(connectionId);
    const subscriber = this.sessionsByCallerId.get(callerId)?.get(resolvedConnectionId);
    if (!subscriber || !subscriber.isAlive) {
      if (subscriber) this.removeSubscriber(callerId, resolvedConnectionId, subscriber);
      return false;
    }
    subscriber.send(`event:${event}`, data);
    return true;
  }

  /**
   * Get the number of subscribers for an event.
   */
  getSubscriberCount(event: EventName): number {
    let count = 0;
    for (const callerSubs of this.subscribers.get(event)?.values() ?? []) {
      count += callerSubs.size;
    }
    return count;
  }

  /**
   * Register a live direct-address delivery session.
   */
  registerSession(session: EventSession): void {
    const resolvedConnectionId = this.getConnectionId(session.connectionId);
    const bucket = this.getSessionBucket(session.callerId, true);
    const existing = bucket.get(resolvedConnectionId);
    if (existing) {
      this.removeSubscriber(session.callerId, resolvedConnectionId, existing);
    }
    this.getSessionBucket(session.callerId, true).set(resolvedConnectionId, session);
    session.onDestroyed(() => {
      this.removeSubscriber(session.callerId, resolvedConnectionId, session);
    });
  }

  /**
   * Register an external subscriber (e.g., IPC-backed) for direct delivery.
   * Used when the caller doesn't have a WebSocket. The optional connection ID
   * still represents an ephemeral runtime session and must not be persisted.
   */
  registerSubscriber(callerId: string, subscriber: Subscriber, connectionId?: string): void {
    const session = Object.assign(subscriber, {
      callerId,
      connectionId: this.getConnectionId(connectionId),
    }) satisfies EventSession;
    this.registerSession(session);
  }

  /**
   * Get or create a subscriber for a callerId from a WS client.
   */
  getOrCreateSubscriber(ctx: ServiceContext): Subscriber {
    const connectionId = this.getConnectionId(ctx.connectionId);
    // Allow pre-registered subscribers (e.g., IPC-backed shell subscriber)
    const preRegistered = this.sessionsByCallerId.get(ctx.callerId)?.get(connectionId);
    if (preRegistered && preRegistered.isAlive) return preRegistered;

    if (!ctx.wsClient) {
      throw new Error("Event subscriptions require a WS connection or pre-registered subscriber");
    }

    const existing = this.sessionsByCallerId.get(ctx.callerId)?.get(connectionId);
    // Cast ws from WsClientInfo.ws (unknown) to WebSocket -- eventsService
    // is server-only code that always receives the concrete WS instance.
    const ws = ctx.wsClient.ws as WebSocket;

    // Reuse only if alive AND bound to the same WS (connection replacement gives a new WS)
    if (existing && existing.isAlive && existing.isBoundTo(ws)) return existing;

    // Remove stale subscriber's event entries if it was replaced
    if (existing) {
      this.removeSubscriber(ctx.callerId, connectionId, existing);
    }

    const session = new WsEventSession(ws, ctx.callerKind, ctx.callerId, connectionId);
    this.registerSession(session);
    return session;
  }
}

/**
 * Create a ServiceDefinition that wraps an existing EventService instance.
 * The same EventService instance is used for both RPC handling and in-process emit().
 */
export function createEventsServiceDefinition(eventService: EventService): ServiceDefinition {
  return {
    name: "events",
    description: "Event subscriptions",
    policy: { allowed: ["shell", "panel", "server", "worker"] },
    methods: {
      subscribe: { args: z.tuple([z.string()]) },
      unsubscribe: { args: z.tuple([z.string()]) },
      unsubscribeAll: { args: z.tuple([]) },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "subscribe": {
          const eventName = args[0] as EventName;
          if (!isValidEventName(eventName)) {
            throw new Error(`Unknown event: ${eventName}`);
          }
          const subscriber = eventService.getOrCreateSubscriber(ctx);
          eventService.subscribe(eventName, ctx.callerId, subscriber, ctx.connectionId);
          return;
        }
        case "unsubscribe": {
          const eventName = args[0] as EventName;
          if (!isValidEventName(eventName)) {
            throw new Error(`Unknown event: ${eventName}`);
          }
          eventService.unsubscribe(eventName, ctx.callerId, ctx.connectionId);
          return;
        }
        case "unsubscribeAll": {
          eventService.unsubscribeAll(ctx.callerId, ctx.connectionId);
          return;
        }
        default:
          throw new Error(`Unknown events method: ${method}`);
      }
    },
  };
}
