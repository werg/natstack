/**
 * EventsClient -- Shared event subscription RPC wrappers.
 *
 * Wraps events-related server RPC calls for subscribing to and
 * unsubscribing from shell events (panel-tree-updated, theme changes, etc.).
 */

import type { RpcBridge } from "@natstack/rpc";
import type { EventName } from "../events.js";

export class EventsClient {
  private rpc: RpcBridge;

  constructor(rpc: RpcBridge) {
    this.rpc = rpc;
  }

  subscribe(event: EventName): Promise<void> {
    return this.rpc.call<void>("main", "events.subscribe", event);
  }

  unsubscribe(event: EventName): Promise<void> {
    return this.rpc.call<void>("main", "events.unsubscribe", event);
  }

  unsubscribeAll(): Promise<void> {
    return this.rpc.call<void>("main", "events.unsubscribeAll");
  }
}
