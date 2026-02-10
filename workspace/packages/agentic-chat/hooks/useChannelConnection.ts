import { useState, useRef, useCallback, useEffect, type RefObject } from "react";
import { connect } from "@natstack/agentic-messaging/client";
import type {
  AgenticClient,
  RosterUpdate,
  IncomingEvent,
  MethodDefinition,
  ToolGroup,
  ToolRoleDeclaration,
  ChannelConfig,
} from "@natstack/agentic-messaging";
import type { ChatParticipantMetadata, ConnectionConfig } from "../types";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/** Tool roles configuration for the connection */
export type ToolRolesConfig = Partial<Record<ToolGroup, ToolRoleDeclaration>>;

export interface UseChannelConnectionOptions {
  /** Connection configuration (server URL, token, client ID) */
  config: ConnectionConfig;
  metadata: ChatParticipantMetadata;
  /** Tool roles this panel provides (for conflict detection) */
  toolRoles?: ToolRolesConfig;
  /** Called for each event (messages, method calls, method results, presence) */
  onEvent?: (event: IncomingEvent) => void;
  /** Called when roster changes */
  onRoster?: (roster: RosterUpdate<ChatParticipantMetadata>) => void;
  /** Called on connection errors */
  onError?: (error: Error) => void;
  /** Called when the client reconnects after a disconnect */
  onReconnect?: () => void;
}

export interface ConnectOptions {
  channelId: string;
  methods: Record<string, MethodDefinition>;
  /** Channel configuration (set when creating channel, read by joiners) */
  channelConfig?: ChannelConfig;
  /** Context ID for channel authorization (passed separately from channelConfig) */
  contextId?: string;
}

export interface UseChannelConnectionResult {
  client: AgenticClient<ChatParticipantMetadata> | null;
  clientRef: RefObject<AgenticClient<ChatParticipantMetadata> | null>;
  status: ConnectionStatus;
  connected: boolean;
  /** The client's ID on the channel (available after connection) */
  clientId: string | null;
  /** The static client ID from the connection config */
  panelClientId: string;
  connect: (options: ConnectOptions) => Promise<AgenticClient<ChatParticipantMetadata>>;
  disconnect: () => void;
}

export function useChannelConnection({
  config,
  metadata,
  toolRoles,
  onEvent,
  onRoster,
  onError,
  onReconnect,
}: UseChannelConnectionOptions): UseChannelConnectionResult {
  const [client, setClient] = useState<AgenticClient<ChatParticipantMetadata> | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const clientRef = useRef<AgenticClient<ChatParticipantMetadata> | null>(null);
  const unsubscribersRef = useRef<Array<() => void>>([]);

  // Keep callbacks in refs to avoid dependency issues
  const callbacksRef = useRef({ onEvent, onRoster, onError, onReconnect });
  useEffect(() => {
    callbacksRef.current = { onEvent, onRoster, onError, onReconnect };
  }, [onEvent, onRoster, onError, onReconnect]);

  const disconnect = useCallback(() => {
    // Clean up all subscriptions
    for (const unsub of unsubscribersRef.current) {
      unsub();
    }
    unsubscribersRef.current = [];

    if (clientRef.current) {
      void clientRef.current.close();
    }
    clientRef.current = null;
    setClient(null);
    setStatus("disconnected");
  }, []);

  const connectToChannel = useCallback(
    async (options: ConnectOptions): Promise<AgenticClient<ChatParticipantMetadata>> => {
      const { channelId, methods, channelConfig, contextId } = options;

      if (!config.serverUrl || !config.token) {
        const error = new Error("PubSub configuration not available");
        callbacksRef.current.onError?.(error);
        setStatus("error");
        throw error;
      }

      // Close existing connection if any
      disconnect();

      setStatus("connecting");

      try {
        const newClient = await connect<ChatParticipantMetadata>({
          serverUrl: config.serverUrl,
          token: config.token,
          channel: channelId,
          // Pass contextId for channel authorization (passed separately from channelConfig)
          contextId,
          // Pass channel config (set when creating, read by joiners from server)
          channelConfig,
          handle: metadata.handle,
          name: metadata.name,
          type: metadata.type,
          reconnect: true,
          clientId: config.clientId,
          methods,
          replayMode: "stream",
          extraMetadata: toolRoles ? { toolRoles } : undefined,
        });

        clientRef.current = newClient;

        const unsubs: Array<() => void> = [];

        // Set up unified event handling - single loop for all event types
        // includeEphemeral: true is required to receive agent-debug events (logs, lifecycle)
        const eventIterator = newClient.events({ includeReplay: true, includeEphemeral: true });
        let eventLoopRunning = true;
        // Store iterator ref for explicit cleanup - cast to any to avoid EventStreamItem vs IncomingEvent type mismatch
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let eventIteratorRef: AsyncIterableIterator<any> | null = eventIterator;

        void (async () => {
          try {
            for await (const event of eventIterator) {
              if (!eventLoopRunning) break;
              try {
                callbacksRef.current.onEvent?.(event as IncomingEvent);
              } catch (callbackError) {
                console.error("[useChannelConnection] Event callback error:", callbackError);
              }
            }
          } catch (streamError) {
            console.error("[useChannelConnection] Event stream error:", streamError);
            callbacksRef.current.onError?.(
              streamError instanceof Error ? streamError : new Error(String(streamError))
            );
          } finally {
            eventIteratorRef = null;
          }
        })();
        unsubs.push(() => {
          eventLoopRunning = false;
          // Explicitly close iterator to prevent accumulation
          eventIteratorRef?.return?.();
          eventIteratorRef = null;
        });

        // Set up roster handler (roster is separate from the events stream)
        unsubs.push(
          newClient.onRoster((roster: RosterUpdate<ChatParticipantMetadata>) => {
            try {
              callbacksRef.current.onRoster?.(roster);
            } catch (rosterError) {
              console.error("[useChannelConnection] Roster callback error:", rosterError);
            }
          })
        );

        // Set up reconnect handler
        unsubs.push(
          newClient.onReconnect(() => {
            try {
              callbacksRef.current.onReconnect?.();
            } catch (reconnectError) {
              console.error("[useChannelConnection] Reconnect callback error:", reconnectError);
            }
          })
        );

        unsubscribersRef.current = unsubs;
        setClient(newClient);
        setStatus("connected");
        return newClient;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        callbacksRef.current.onError?.(error);
        setStatus("error");
        disconnect();
        throw error;
      }
    },
    [config, metadata, toolRoles, disconnect]
  );

  // Clean up on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    client,
    clientRef,
    status,
    connected: status === "connected",
    clientId: client?.clientId ?? null,
    panelClientId: config.clientId,
    connect: connectToChannel,
    disconnect,
  };
}
