/**
 * Config Types - Connection configuration for agents, panels, and workers.
 */

/**
 * PubSub connection configuration.
 * Used by agents, panels, and workers to connect to the pubsub server.
 */
export interface PubSubConfig {
  /** WebSocket server URL (e.g., ws://127.0.0.1:49452) */
  serverUrl: string;
  /** Bearer token for authentication */
  token: string;
}
