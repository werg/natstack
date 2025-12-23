import { useState, useRef, useCallback, useEffect, type RefObject } from "react";
import { pubsubConfig, id as panelClientId } from "@natstack/runtime";
import {
  connect,
  type AgenticClient,
  type RosterUpdate,
  type IncomingEvent,
  type ToolDefinition,
} from "@natstack/agentic-messaging";
import type { ChatParticipantMetadata } from "../types";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface UseChannelConnectionOptions {
  metadata: ChatParticipantMetadata;
  /** Called for each event (messages, tool calls, tool results, presence) */
  onEvent?: (event: IncomingEvent) => void;
  /** Called when roster changes */
  onRoster?: (roster: RosterUpdate<ChatParticipantMetadata>) => void;
  /** Called on connection errors */
  onError?: (error: Error) => void;
}

export interface UseChannelConnectionResult {
  client: AgenticClient<ChatParticipantMetadata> | null;
  clientRef: RefObject<AgenticClient<ChatParticipantMetadata> | null>;
  status: ConnectionStatus;
  connected: boolean;
  /** The client's ID on the channel (available after connection) */
  clientId: string | null;
  /** The panel's static ID from runtime */
  panelClientId: string;
  connect: (channelId: string, tools: Record<string, ToolDefinition>) => Promise<AgenticClient<ChatParticipantMetadata>>;
  disconnect: () => void;
}

export function useChannelConnection({
  metadata,
  onEvent,
  onRoster,
  onError,
}: UseChannelConnectionOptions): UseChannelConnectionResult {
  const [client, setClient] = useState<AgenticClient<ChatParticipantMetadata> | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const clientRef = useRef<AgenticClient<ChatParticipantMetadata> | null>(null);
  const unsubscribersRef = useRef<Array<() => void>>([]);

  // Keep callbacks in refs to avoid dependency issues
  const callbacksRef = useRef({ onEvent, onRoster, onError });
  useEffect(() => {
    callbacksRef.current = { onEvent, onRoster, onError };
  }, [onEvent, onRoster, onError]);

  const disconnect = useCallback(() => {
    // Clean up all subscriptions
    for (const unsub of unsubscribersRef.current) {
      unsub();
    }
    unsubscribersRef.current = [];

    clientRef.current?.close();
    clientRef.current = null;
    setClient(null);
    setStatus("disconnected");
  }, []);

  const connectToChannel = useCallback(
    async (channelId: string, tools: Record<string, ToolDefinition>): Promise<AgenticClient<ChatParticipantMetadata>> => {
      if (!pubsubConfig) {
        const error = new Error("PubSub configuration not available");
        callbacksRef.current.onError?.(error);
        setStatus("error");
        throw error;
      }

      // Close existing connection if any
      disconnect();

      setStatus("connecting");

      const newClient = connect<ChatParticipantMetadata>(
        pubsubConfig.serverUrl,
        pubsubConfig.token,
        {
          channel: channelId,
          reconnect: true,
          clientId: panelClientId,
          metadata,
          tools,
        }
      );

      clientRef.current = newClient;

      // Set up subscriptions IMMEDIATELY (before await ready())
      // This ensures handlers are registered before replay completes
      const unsubs: Array<() => void> = [];

      // Set up unified event handling - single loop for all event types
      const eventIterator = newClient.events();
      let eventLoopRunning = true;
      void (async () => {
        for await (const event of eventIterator) {
          if (!eventLoopRunning) break;
          callbacksRef.current.onEvent?.(event);
        }
      })();
      unsubs.push(() => {
        eventLoopRunning = false;
      });

      // Set up roster handler (roster is separate from the events stream)
      unsubs.push(
        newClient.onRoster((roster: RosterUpdate<ChatParticipantMetadata>) => {
          callbacksRef.current.onRoster?.(roster);
        })
      );

      unsubscribersRef.current = unsubs;

      try {
        await newClient.ready();
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
    [metadata, disconnect]
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
    panelClientId,
    connect: connectToChannel,
    disconnect,
  };
}
