/**
 * @workspace/agentic-do — Composable agent modules for Durable Objects.
 *
 * Agent DOs extend AgentWorkerBase, which embeds Pi (`@mariozechner/pi-agent-core`)
 * in-process via the PiRunner from `@natstack/harness`. Non-agent DOs (e.g.
 * PubSub channel DOs) extend DurableObjectBase directly.
 */

export { AgentWorkerBase } from "./agent-worker-base.js";
export { DOIdentity } from "./identity.js";
export { SubscriptionManager } from "./subscription-manager.js";
export { ContinuationStore } from "./continuation-store.js";
export type { PendingCall } from "./continuation-store.js";
export { ChannelClient } from "./channel-client.js";
