/**
 * WebSocket Event Bus (Electron)
 *
 * Wraps the AgenticClient to implement the EventBus interface.
 * This is a thin wrapper since AgenticClient already provides most
 * of the functionality - we just expose it through the unified interface.
 *
 * NOTE: This handles OUTGOING operations only. Event reception is handled
 * separately by the runtime's event source (see event-source.ts).
 */

import type {
  AgenticClient,
  AgenticParticipantMetadata,
} from "@workspace/agentic-protocol";
import type { EventBus } from "../abstractions/event-bus.js";

/**
 * Create a WebSocket-based event bus from an AgenticClient.
 *
 * The EventBus interface is a subset of AgenticClient focused on
 * outgoing operations. This adapter simply delegates to the underlying
 * client for all methods.
 *
 * @param client - Connected AgenticClient instance
 * @returns EventBus implementation
 */
export function createWsEventBus<M extends AgenticParticipantMetadata = AgenticParticipantMetadata>(
  client: AgenticClient<M>
): EventBus<M> {
  // The EventBus interface is designed to be compatible with AgenticClient,
  // so we can return the client directly cast to EventBus. All required
  // methods exist on AgenticClient.
  //
  // We explicitly return the object to ensure type safety and make it
  // clear which methods are part of the EventBus contract.
  return {
    // Identity
    get handle() {
      return client.handle;
    },
    get clientId() {
      return client.clientId;
    },
    get channel() {
      return client.channel;
    },

    // Messaging
    send: client.send.bind(client),
    update: client.update.bind(client),
    complete: client.complete.bind(client),
    error: client.error.bind(client),
    publish: client.publish.bind(client),

    // Methods
    callMethod: client.callMethod.bind(client),
    discoverMethodDefs: client.discoverMethodDefs.bind(client),
    discoverMethodDefsFrom: client.discoverMethodDefsFrom.bind(client),
    sendMethodResult: client.sendMethodResult.bind(client),

    // Roster
    get roster() {
      return client.roster;
    },
    onRoster: client.onRoster.bind(client),
    resolveHandles: client.resolveHandles.bind(client),
    getParticipantByHandle: client.getParticipantByHandle.bind(client),
    updateMetadata: client.updateMetadata.bind(client),

    // Settings
    getSettings: client.getSettings.bind(client),
    updateSettings: client.updateSettings.bind(client),
    get sessionEnabled() {
      return client.sessionEnabled;
    },
    get sessionKey() {
      return client.sessionKey;
    },

    // Channel management
    get contextId() {
      return client.contextId;
    },
    get channelConfig() {
      return client.channelConfig;
    },
    setChannelTitle: client.setChannelTitle.bind(client),
    onTitleChange: client.onTitleChange.bind(client),

    // Agent management
    listAgents: client.listAgents.bind(client),
    inviteAgent: client.inviteAgent.bind(client),
    channelAgents: client.channelAgents.bind(client),
    removeAgent: client.removeAgent.bind(client),

    // Lifecycle
    get connected() {
      return client.connected;
    },
    get reconnecting() {
      return client.reconnecting;
    },
    close: client.close.bind(client),
    onDisconnect: client.onDisconnect.bind(client),
    onReconnect: client.onReconnect.bind(client),
    onError: client.onError.bind(client),
  };
}
