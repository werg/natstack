/**
 * @natstack/agentic-messaging broker
 *
 * API for brokers to advertise agent types and handle invites.
 */

import { connect as agenticConnect } from "./client.js";
import type { AgenticClient, EventStreamItem, IncomingEvent } from "./types.js";
import type {
  AgentTypeAdvertisement,
  BrokerConnectOptions,
  BrokerMetadata,
  Invite,
  InviteHandler,
  InviteResponse,
} from "./broker-types.js";
import { BrokerError } from "./broker-types.js";
import { InviteSchema, InviteResponseSchema } from "./broker-protocol.js";

function randomId(): string {
  const cryptoObj = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  throw new Error("crypto.randomUUID not available");
}

function isIncomingEvent(event: EventStreamItem): event is IncomingEvent {
  return "kind" in event;
}

/**
 * Broker client for advertising agent types and handling invites.
 */
export interface BrokerClient {
  /** Underlying agentic client (for advanced use) */
  readonly client: AgenticClient<BrokerMetadata>;

  /** This broker's client ID on the availability channel */
  readonly brokerId: string | null;

  /** Current agent type advertisements */
  readonly agentTypes: AgentTypeAdvertisement[];

  /** Update advertised agent types (updates roster metadata) */
  updateAgentTypes(agentTypes: AgentTypeAdvertisement[]): Promise<void>;

  /** Close the broker connection */
  close(): Promise<void>;

  /** Subscribe to errors */
  onError(handler: (error: Error) => void): () => void;
}

/**
 * Connect as a broker to the availability channel.
 *
 * @example
 * ```ts
 * const broker = await connectAsBroker(serverUrl, token, {
 *   availabilityChannel: "agent-availability",
 *   name: "My Agent Broker",
 *   agentTypes: [{
 *     id: "code-assistant",
 *     name: "Code Assistant",
 *     description: "An agent that helps with coding tasks",
 *     providesMethods: [{ name: "execute_code", parameters: {...}, description: "Execute code" }],
 *     requiresMethods: [{ name: "file_read", required: true }],
 *   }],
 *   onInvite: async (invite, senderId) => {
 *     // Custom acceptance logic
 *     return { accept: true };
 *   },
 *   onSpawn: async (invite, agentType) => {
 *     // Spawn the agent on the target channel
 *     const agent = await spawnMyAgent(invite.targetChannel, agentType);
 *     return { agentId: agent.id };
 *   },
 * });
 * ```
 */
export async function connectAsBroker(
  serverUrl: string,
  token: string,
  options: BrokerConnectOptions
): Promise<BrokerClient> {
  const {
    availabilityChannel,
    name,
    handle,
    agentTypes: initialAgentTypes,
    onInvite,
    onSpawn,
    reconnect,
    customMetadata,
  } = options;

  let currentAgentTypes = [...initialAgentTypes];
  let brokerId: string | null = null;

  const baseMetadata: BrokerMetadata = {
    name,
    type: "broker",
    handle,
    isBroker: true as const,
    agentTypes: currentAgentTypes,
    ...customMetadata,
  };

  const client = await agenticConnect<BrokerMetadata>({
    serverUrl,
    token,
    channel: availabilityChannel,
    handle,
    name,
    type: "broker",
    extraMetadata: {
      isBroker: true as const,
      agentTypes: currentAgentTypes,
      ...customMetadata,
    },
    reconnect,
    skipOwnMessages: true,
  });

  // Track our own ID from roster
  client.onRoster((roster) => {
    if (brokerId) return;
    for (const [id, participant] of Object.entries(roster.participants)) {
      if (participant.metadata?.isBroker && participant.metadata?.name === name) {
        // Check if this is us by comparing agentTypes
        const meta = participant.metadata;
        if (
          meta.agentTypes?.length === currentAgentTypes.length &&
          meta.agentTypes[0]?.id === currentAgentTypes[0]?.id
        ) {
          brokerId = id;
          break;
        }
      }
    }
  });

  // Default invite handler: decline all
  const defaultHandler: InviteHandler = async () => ({
    accept: false,
    declineReason: "No invite handler configured",
    declineCode: "declined-by-policy",
  });

  const inviteHandler = onInvite ?? defaultHandler;

  // Process invite messages
  void (async () => {
    try {
      for await (const event of client.events({ includeEphemeral: true })) {
        if (!isIncomingEvent(event) || event.type !== "message") continue;

        // Skip replay messages - only process new invites
        // This prevents re-spawning agents for old invites after restart
        if (event.kind === "replay") continue;

        // Try to parse as invite
        try {
          const parsed = JSON.parse(event.content);
          if (parsed?.type !== "invite") continue;

          const invite = InviteSchema.safeParse(parsed.payload);
          if (!invite.success) continue;

          await handleInvite(invite.data, event.senderId);
        } catch {
          // Not a valid invite message, ignore
        }
      }
    } catch {
      // Connection closed
    }
  })();

  async function handleInvite(invite: Invite, senderId: string): Promise<void> {
    // Find the requested agent type
    const agentType = currentAgentTypes.find((t) => t.id === invite.agentTypeId);

    if (!agentType) {
      await sendResponse({
        inviteId: invite.inviteId,
        accepted: false,
        declineReason: `Unknown agent type: ${invite.agentTypeId}`,
        declineCode: "unknown-agent-type",
        ts: Date.now(),
      });
      return;
    }

    // Validate required parameters
    const requiredParams = agentType.parameters?.filter((p) => p.required) ?? [];
    const missingParams: string[] = [];

    for (const param of requiredParams) {
      const value = invite.config?.[param.key];
      const hasValue = value !== undefined && value !== "";
      const hasDefault = param.default !== undefined;

      if (!hasValue && !hasDefault) {
        missingParams.push(param.label || param.key);
      }
    }

    if (missingParams.length > 0) {
      await sendResponse({
        inviteId: invite.inviteId,
        accepted: false,
        declineReason: `Missing required parameters: ${missingParams.join(", ")}`,
        declineCode: "invalid-config",
        ts: Date.now(),
      });
      return;
    }

    try {
      // Call the invite handler
      const result = await inviteHandler(invite, senderId);

      if (!result.accept) {
        await sendResponse({
          inviteId: invite.inviteId,
          accepted: false,
          declineReason: result.declineReason,
          declineCode: result.declineCode,
          ts: Date.now(),
        });
        return;
      }

      // If handler provided agentId, agent is already connected
      if (result.agentId) {
        await sendResponse({
          inviteId: invite.inviteId,
          accepted: true,
          agentId: result.agentId,
          ts: Date.now(),
        });
        return;
      }

      // Need to spawn agent
      if (!onSpawn) {
        await sendResponse({
          inviteId: invite.inviteId,
          accepted: false,
          declineReason: "No spawn callback configured",
          declineCode: "internal-error",
          ts: Date.now(),
        });
        return;
      }

      const spawnResult = await onSpawn(invite, agentType);

      await sendResponse({
        inviteId: invite.inviteId,
        accepted: true,
        agentId: spawnResult.agentId,
        ts: Date.now(),
      });
    } catch (err) {
      await sendResponse({
        inviteId: invite.inviteId,
        accepted: false,
        declineReason: err instanceof Error ? err.message : String(err),
        declineCode: "internal-error",
        ts: Date.now(),
      });
    }
  }

  async function sendResponse(response: InviteResponse): Promise<void> {
    const validated = InviteResponseSchema.parse(response);
    // Ephemeral - invite/response are transient control messages, not chat history
    await client.send(JSON.stringify({ type: "invite-response", payload: validated }), {
      persist: false,
    });
  }

  async function updateAgentTypes(newAgentTypes: AgentTypeAdvertisement[]): Promise<void> {
    currentAgentTypes = [...newAgentTypes];
    const rosterMetadata =
      (brokerId && client.pubsub.roster[brokerId]?.metadata) || baseMetadata;
    await client.pubsub.updateMetadata({
      ...rosterMetadata,
      isBroker: true,
      agentTypes: currentAgentTypes,
    } as BrokerMetadata);
  }

  return {
    client,
    get brokerId() {
      return brokerId;
    },
    get agentTypes() {
      return currentAgentTypes;
    },
    updateAgentTypes,
    close: async () => client.close(),
    onError: (handler: (error: Error) => void) => client.onError(handler),
  };
}

/**
 * Helper to create a self-brokering agent that handles its own invites.
 * Useful for agents that can handle multiple concurrent conversations.
 *
 * @example
 * ```ts
 * const selfBroker = connectAsSelfBroker(serverUrl, token, {
 *   availabilityChannel: "agent-availability",
 *   name: "Multi-conversation Agent",
 *   agentType: {
 *     id: "chat-agent",
 *     name: "Chat Agent",
 *     description: "A conversational agent",
 *     providesMethods: [...],
 *     requiresMethods: [],
 *   },
 *   onInvite: async (invite) => {
 *     // Connect myself to the target channel
 *     const workClient = await connect({
 *       serverUrl,
 *       token,
 *       channel: invite.targetChannel,
 *       handle: "chat-agent",
 *       name: "Chat Agent",
 *       type: "agent",
 *     });
 *     return { accept: true, agentId: workClient.pubsub.clientId };
 *   },
 * });
 * ```
 */
export async function connectAsSelfBroker(
  serverUrl: string,
  token: string,
  options: Omit<BrokerConnectOptions, "agentTypes" | "onSpawn"> & {
    agentType: AgentTypeAdvertisement;
  }
): Promise<BrokerClient> {
  return await connectAsBroker(serverUrl, token, {
    ...options,
    agentTypes: [options.agentType],
  });
}
