/**
 * @natstack/agentic-messaging broker client
 *
 * API for discovering brokers and inviting agents.
 */

import { connect as agenticConnect } from "./client.js";
import type { AgenticClient, AgenticParticipantMetadata } from "./types.js";
import type {
  AgentTypeAdvertisement,
  BrokerClientOptions,
  BrokerMetadata,
  BrokerQuery,
  DiscoveredBroker,
  Invite,
  InviteResponse,
  InviteResult,
} from "./broker-types.js";
import { BrokerError } from "./broker-types.js";
import { BrokerMetadataSchema, InviteResponseSchema, InviteSchema } from "./broker-protocol.js";

const DEFAULT_INVITE_TIMEOUT_MS = 30000;

function randomId(): string {
  const cryptoObj = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  throw new Error("crypto.randomUUID not available");
}

/**
 * Client for discovering brokers and inviting agents.
 */
export interface BrokerDiscoveryClient {
  /** Underlying agentic client */
  readonly client: AgenticClient<AgenticParticipantMetadata>;

  /** Discover all available brokers */
  discoverBrokers(): DiscoveredBroker[];

  /** Discover brokers matching a query */
  queryBrokers(query: BrokerQuery): DiscoveredBroker[];

  /** Find agent types across all brokers matching a query */
  findAgentTypes(query: BrokerQuery): Array<{
    broker: DiscoveredBroker;
    agentType: AgentTypeAdvertisement;
  }>;

  /** Send an invite to a broker */
  invite(
    brokerId: string,
    agentTypeId: string,
    targetChannel: string,
    options?: {
      config?: Record<string, unknown>;
      context?: string;
      timeoutMs?: number;
    }
  ): InviteResult;

  /** Subscribe to broker roster changes */
  onBrokersChanged(handler: (brokers: DiscoveredBroker[]) => void): () => void;

  /** Close the connection */
  close(): void;

  /** Wait for ready (replay complete) */
  ready(timeoutMs?: number): Promise<void>;
}

/**
 * Connect to the availability channel to discover and invite brokers.
 *
 * @example
 * ```ts
 * const discovery = await connectForDiscovery(serverUrl, token, {
 *   availabilityChannel: "agent-availability",
 *   name: "My App",
 *   type: "client",
 * });
 *
 * // Discover brokers
 * const brokers = discovery.discoverBrokers();
 *
 * // Query by capability
 * const codingBrokers = discovery.queryBrokers({
 *   providesTools: ["execute_code"],
 *   tags: ["coding"],
 * });
 *
 * // Invite an agent
 * const result = discovery.invite(
 *   brokers[0].brokerId,
 *   "code-assistant",
 *   "my-work-channel",
 *   { context: "Help me write a function" }
 * );
 *
 * const response = await result.response;
 * if (response.accepted) {
 *   console.log(`Agent connected with ID: ${response.agentId}`);
 * }
 * ```
 */
export async function connectForDiscovery(
  serverUrl: string,
  token: string,
  options: BrokerClientOptions
): Promise<BrokerDiscoveryClient> {
  const {
    availabilityChannel,
    name,
    type,
    inviteTimeoutMs = DEFAULT_INVITE_TIMEOUT_MS,
    reconnect,
  } = options;

  const pendingInvites = new Map<
    string,
    {
      resolve: (response: InviteResponse) => void;
      reject: (error: Error) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  >();

  const brokerChangeHandlers = new Set<(brokers: DiscoveredBroker[]) => void>();

  const client = agenticConnect<AgenticParticipantMetadata>(serverUrl, token, {
    channel: availabilityChannel,
    reconnect,
    metadata: { name, type },
    skipOwnMessages: true,
  });

  // Watch for roster changes to notify broker change handlers
  client.onRoster(() => {
    const brokers = discoverBrokers();
    for (const handler of brokerChangeHandlers) {
      handler(brokers);
    }
  });

  // Process invite response messages
  void (async () => {
    try {
      for await (const msg of client.messages()) {
        if (msg.type !== "message") continue;

        try {
          const parsed = JSON.parse(msg.content);
          if (parsed?.type !== "invite-response") continue;

          const response = InviteResponseSchema.safeParse(parsed.payload);
          if (!response.success) continue;

          const pending = pendingInvites.get(response.data.inviteId);
          if (pending) {
            clearTimeout(pending.timeoutId);
            pendingInvites.delete(response.data.inviteId);
            pending.resolve(response.data);
          }
        } catch {
          // Not a valid response message, ignore
        }
      }
    } catch {
      // Connection closed - reject all pending invites
      for (const [, pending] of pendingInvites) {
        clearTimeout(pending.timeoutId);
        pending.reject(new BrokerError("Connection closed", "broker-offline"));
      }
      pendingInvites.clear();
    }
  })();

  function discoverBrokers(): DiscoveredBroker[] {
    const brokers: DiscoveredBroker[] = [];

    for (const [id, participant] of Object.entries(client.roster)) {
      const metadata = participant.metadata as Record<string, unknown>;

      // Check if this is a broker
      if (metadata?.["isBroker"] !== true) continue;

      const parsed = BrokerMetadataSchema.safeParse(metadata);
      if (!parsed.success) continue;

      brokers.push({
        brokerId: id,
        name: parsed.data.name,
        agentTypes: parsed.data.agentTypes,
        metadata: parsed.data as BrokerMetadata,
      });
    }

    return brokers;
  }

  function matchesQuery(agentType: AgentTypeAdvertisement, query: BrokerQuery): boolean {
    // Tag matching (OR)
    if (query.tags && query.tags.length > 0) {
      const typeTags = agentType.tags ?? [];
      if (!query.tags.some((t) => typeTags.includes(t))) {
        return false;
      }
    }

    // Provides tools matching (AND)
    if (query.providesTools && query.providesTools.length > 0) {
      const providedNames = agentType.providesTools.map((t) => t.name);
      if (!query.providesTools.every((t) => providedNames.includes(t))) {
        return false;
      }
    }

    // Requires tools matching (AND)
    if (query.requiresTools && query.requiresTools.length > 0) {
      const requiredNames = agentType.requiresTools.filter((t) => t.name).map((t) => t.name!);
      if (!query.requiresTools.every((t) => requiredNames.includes(t))) {
        return false;
      }
    }

    // Description contains (case-insensitive)
    if (query.descriptionContains) {
      const searchTerm = query.descriptionContains.toLowerCase();
      if (!agentType.description.toLowerCase().includes(searchTerm)) {
        return false;
      }
    }

    return true;
  }

  function queryBrokers(query: BrokerQuery): DiscoveredBroker[] {
    const allBrokers = discoverBrokers();

    return allBrokers.filter((broker) =>
      broker.agentTypes.some((agentType) => matchesQuery(agentType, query))
    );
  }

  function findAgentTypes(
    query: BrokerQuery
  ): Array<{ broker: DiscoveredBroker; agentType: AgentTypeAdvertisement }> {
    const results: Array<{ broker: DiscoveredBroker; agentType: AgentTypeAdvertisement }> = [];

    for (const broker of discoverBrokers()) {
      for (const agentType of broker.agentTypes) {
        if (matchesQuery(agentType, query)) {
          results.push({ broker, agentType });
        }
      }
    }

    return results;
  }

  function invite(
    brokerId: string,
    agentTypeId: string,
    targetChannel: string,
    options?: {
      config?: Record<string, unknown>;
      context?: string;
      timeoutMs?: number;
    }
  ): InviteResult {
    // Verify broker exists
    const broker = client.roster[brokerId];
    if (!broker) {
      throw new BrokerError(`Broker not found: ${brokerId}`, "broker-not-found");
    }

    const inviteId = randomId();
    const timeoutMs = options?.timeoutMs ?? inviteTimeoutMs;

    const invite: Invite = {
      inviteId,
      targetChannel,
      agentTypeId,
      config: options?.config,
      context: options?.context,
      ts: Date.now(),
    };

    let cancelled = false;

    const response = new Promise<InviteResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (cancelled) return;
        pendingInvites.delete(inviteId);
        reject(new BrokerError("Invite timed out", "invite-timeout"));
      }, timeoutMs);

      pendingInvites.set(inviteId, { resolve, reject, timeoutId });

      // Send the invite
      const validated = InviteSchema.parse(invite);
      client
        .send(JSON.stringify({ type: "invite", payload: validated }), {
          persist: true,
        })
        .catch((err) => {
          clearTimeout(timeoutId);
          pendingInvites.delete(inviteId);
          reject(
            new BrokerError(
              err instanceof Error ? err.message : String(err),
              "broker-offline",
              err
            )
          );
        });
    });

    return {
      invite,
      response,
      cancel() {
        cancelled = true;
        const pending = pendingInvites.get(inviteId);
        if (pending) {
          clearTimeout(pending.timeoutId);
          pendingInvites.delete(inviteId);
          pending.reject(new BrokerError("Invite cancelled", "timeout"));
        }
      },
    };
  }

  function onBrokersChanged(handler: (brokers: DiscoveredBroker[]) => void): () => void {
    brokerChangeHandlers.add(handler);
    return () => brokerChangeHandlers.delete(handler);
  }

  // Wait for initial ready
  await client.ready();

  return {
    client,
    discoverBrokers,
    queryBrokers,
    findAgentTypes,
    invite,
    onBrokersChanged,
    close: () => client.close(),
    ready: (timeoutMs?: number) => client.ready(timeoutMs),
  };
}

/**
 * Convenience function to invite an agent and wait for connection.
 * Combines discovery + invite in one call.
 *
 * @example
 * ```ts
 * const response = await inviteAgent(serverUrl, token, {
 *   availabilityChannel: "agent-availability",
 *   brokerId: "broker-123",
 *   agentTypeId: "code-assistant",
 *   targetChannel: "my-work-channel",
 *   clientName: "My App",
 *   timeoutMs: 30000,
 * });
 *
 * if (response.accepted) {
 *   // Agent is now connected to my-work-channel
 * }
 * ```
 */
export async function inviteAgent(
  serverUrl: string,
  token: string,
  options: {
    availabilityChannel: string;
    brokerId: string;
    agentTypeId: string;
    targetChannel: string;
    clientName: string;
    config?: Record<string, unknown>;
    context?: string;
    timeoutMs?: number;
  }
): Promise<InviteResponse> {
  const discovery = await connectForDiscovery(serverUrl, token, {
    availabilityChannel: options.availabilityChannel,
    name: options.clientName,
    type: "client",
    inviteTimeoutMs: options.timeoutMs,
  });

  try {
    const result = discovery.invite(options.brokerId, options.agentTypeId, options.targetChannel, {
      config: options.config,
      context: options.context,
      timeoutMs: options.timeoutMs,
    });

    return await result.response;
  } finally {
    discovery.close();
  }
}
