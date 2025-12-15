/**
 * @natstack/pubsub - WebSocket pub/sub client for NatStack
 *
 * Provides real-time messaging between panels and workers via a persistent
 * WebSocket connection with SQLite-backed message history.
 *
 * @example Basic usage
 * ```typescript
 * import { connect } from "@natstack/pubsub";
 * import { pubsubConfig } from "@natstack/runtime/panel";
 *
 * // Connect to a channel
 * const client = connect(pubsubConfig.serverUrl, pubsubConfig.token, {
 *   channel: "chat",
 *   sinceId: lastKnownId, // Optional: resume from where you left off
 * });
 *
 * // Wait for ready (replay complete)
 * await client.ready();
 *
 * // Process messages
 * for await (const msg of client.messages()) {
 *   console.log(msg.type, msg.payload);
 * }
 * ```
 *
 * @example With auto-reconnection
 * ```typescript
 * const client = connect(serverUrl, token, {
 *   channel: "chat",
 *   reconnect: true, // Use defaults: 1s initial delay, 30s max, infinite attempts
 * });
 *
 * // Or with custom config
 * const client = connect(serverUrl, token, {
 *   channel: "chat",
 *   reconnect: { delayMs: 500, maxDelayMs: 10000, maxAttempts: 5 },
 * });
 *
 * client.onDisconnect(() => console.log("Disconnected, reconnecting..."));
 * client.onReconnect(() => console.log("Reconnected!"));
 * ```
 */

export * from "./types.js";
export { connect } from "./client.js";
export type { PubSubClient } from "./client.js";

// Re-export for convenience when used with runtime
import { connect as connectRaw, type PubSubClient } from "./client.js";
import { PubSubError, type ConnectOptions } from "./types.js";

/**
 * Connect using runtime-injected config.
 * For use in panels/workers where pubsubConfig is available.
 *
 * @example
 * ```typescript
 * import { connectWithConfig } from "@natstack/pubsub";
 * import { pubsubConfig } from "@natstack/runtime/panel";
 *
 * const client = connectWithConfig(pubsubConfig, { channel: "notifications" });
 * await client.ready();
 * ```
 */
export function connectWithConfig(
  config: { serverUrl: string; token: string } | null,
  options: ConnectOptions
): PubSubClient {
  if (!config) {
    throw new PubSubError(
      "PubSub config not available. Ensure pubsubConfig is provided by the runtime.",
      "connection"
    );
  }
  return connectRaw(config.serverUrl, config.token, options);
}
