/**
 * EventsClient -- Shared event subscription RPC wrappers.
 *
 * Wraps events-related server RPC calls for subscribing to and
 * unsubscribing from shell events (panel-tree-updated, theme changes, etc.).
 */

import type { RpcBridge } from "@natstack/rpc";
import type { EventName } from "../events.js";
import type { RecoveryCoordinator } from "./recoveryCoordinator.js";

export class EventsClient {
  private rpc: RpcBridge;
  private subscriptions = new Set<EventName>();

  constructor(rpc: RpcBridge, recoveryCoordinator?: Pick<RecoveryCoordinator, "registerResubscribeHandler">) {
    this.rpc = rpc;
    recoveryCoordinator?.registerResubscribeHandler("events-client", () => this.resubscribeAll());
  }

  async subscribe(event: EventName): Promise<void> {
    this.subscriptions.add(event);
    try {
      await this.rpc.call<void>("main", "events.subscribe", event);
    } catch (error) {
      this.subscriptions.delete(event);
      throw error;
    }
  }

  async unsubscribe(event: EventName): Promise<void> {
    this.subscriptions.delete(event);
    await this.rpc.call<void>("main", "events.unsubscribe", event);
  }

  async unsubscribeAll(): Promise<void> {
    this.subscriptions.clear();
    await this.rpc.call<void>("main", "events.unsubscribeAll");
  }

  async resubscribeAll(): Promise<void> {
    for (const event of this.subscriptions) {
      await this.rpc.call<void>("main", "events.subscribe", event);
    }
  }
}
