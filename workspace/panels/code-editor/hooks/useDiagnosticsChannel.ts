/**
 * Hook for subscribing to diagnostics from a PubSub channel.
 *
 * Connects to a chat channel and listens for TYPECHECK_EVENTS.DIAGNOSTICS
 * messages, converting them to local Diagnostic format.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { pubsubConfig, id as panelClientId } from "@workspace/runtime";
import { connect, type AgenticClient, type AgenticParticipantMetadata } from "@workspace/agentic-messaging";
import {
  TYPECHECK_EVENTS,
  type TypeCheckDiagnosticsEvent,
} from "@natstack/typecheck";
import {
  eventToDiagnostics,
  toTypeCheckDiagnostics,
  type Diagnostic,
} from "../types";

/** Metadata for code-editor participant */
interface CodeEditorMetadata extends AgenticParticipantMetadata {
  name: string;
  type: string;
  handle: string;
}

export interface UseDiagnosticsChannelResult {
  /** Whether connected to the channel */
  connected: boolean;
  /** Diagnostics received from the channel */
  remoteDiagnostics: Diagnostic[];
  /** Timestamp of the last diagnostics update */
  lastUpdate: number;
  /** Publish local diagnostics to the channel */
  publishDiagnostics: (panelPath: string, diagnostics: Diagnostic[], checkedFiles: string[]) => void;
  /** Connection error if any */
  error: string | null;
}

/**
 * Hook for subscribing to diagnostics from a PubSub channel.
 *
 * @param channelId - The channel ID to connect to, or null to disable
 */
export function useDiagnosticsChannel(
  channelId: string | null
): UseDiagnosticsChannelResult {
  const [connected, setConnected] = useState(false);
  const [remoteDiagnostics, setRemoteDiagnostics] = useState<Diagnostic[]>([]);
  const [lastUpdate, setLastUpdate] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<AgenticClient<CodeEditorMetadata> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Cleanup function
  const cleanup = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (clientRef.current) {
      void clientRef.current.close();
      clientRef.current = null;
    }
    setConnected(false);
  }, []);

  // Connect to channel when channelId changes
  useEffect(() => {
    if (!channelId) {
      cleanup();
      return;
    }

    if (!pubsubConfig) {
      setError("PubSub configuration not available");
      return;
    }

    // Capture non-null value for use in async closure
    const config = pubsubConfig;
    let cancelled = false;

    const connectToChannel = async () => {
      try {
        cleanup();

        const client = await connect<CodeEditorMetadata>({
          serverUrl: config.serverUrl,
          token: config.token,
          channel: channelId,
          handle: `code-editor-${panelClientId.slice(0, 8)}`,
          name: "Code Editor",
          type: "panel",
          reconnect: true,
          clientId: panelClientId,
          methods: {}, // No methods - just listening
          replayMode: "stream",
        });

        if (cancelled) {
          void client.close();
          return;
        }

        clientRef.current = client;
        setConnected(true);
        setError(null);

        // Start event loop for raw pubsub messages
        // Diagnostics are published directly to pubsub, not as agentic messages.
        // We access the underlying pubsub via cast since AgenticClient doesn't expose it.
        abortControllerRef.current = new AbortController();
        const { signal } = abortControllerRef.current;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawPubsub = (client as any).pubsub ?? (client as any);
        void (async () => {
          try {
            for await (const msg of rawPubsub.messages()) {
              if (signal.aborted || cancelled) break;

              if (msg.kind === "ready") continue;

              // Check for diagnostics message type
              if (msg.type === TYPECHECK_EVENTS.DIAGNOSTICS) {
                const payload = msg.payload as TypeCheckDiagnosticsEvent;
                setRemoteDiagnostics(eventToDiagnostics(payload));
                setLastUpdate(payload.timestamp);
              }
            }
          } catch (e) {
            if (e instanceof Error && e.name === "AbortError") return;
            throw e;
          }
        })();
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[useDiagnosticsChannel] Connection error:", message);
          setError(message);
          setConnected(false);
        }
      }
    };

    void connectToChannel();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [channelId, cleanup]);

  // Publish diagnostics to channel
  const publishDiagnostics = useCallback(
    (panelPath: string, diagnostics: Diagnostic[], checkedFiles: string[]) => {
      if (!clientRef.current) return;

      const event: TypeCheckDiagnosticsEvent = {
        panelPath,
        diagnostics: toTypeCheckDiagnostics(diagnostics),
        timestamp: Date.now(),
        checkedFiles,
      };

      void clientRef.current.publish(
        TYPECHECK_EVENTS.DIAGNOSTICS,
        event
      );
    },
    []
  );

  return {
    connected,
    remoteDiagnostics,
    lastUpdate,
    publishDiagnostics,
    error,
  };
}
