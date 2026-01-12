// Broker functionality entry point
// Use: import { connectAsBroker, ... } from "@natstack/agentic-messaging/broker"

export * from "./broker-types.js";
export * from "./broker-protocol.js";
export { connectAsBroker, connectAsSelfBroker } from "./broker.js";
export { connectForDiscovery, inviteAgent } from "./broker-client.js";
export type { BrokerClient } from "./broker.js";
export type { BrokerDiscoveryClient } from "./broker-client.js";
