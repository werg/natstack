/**
 * useChatCore — Pi-native chat hook.
 *
 * Pi (`@mariozechner/pi-coding-agent`) is the source of truth. This hook:
 * - Owns the PubSubClient connection lifecycle
 * - Subscribes to the channel's `natstack-state-snapshot` ephemeral stream
 * - Derives a flat `ChatMessage[]` from the latest Pi snapshot
 * - Tracks method history from channel method-call/result events
 * - Tracks participants from roster events
 *
 * NO event-replay state machine. NO message reducer. The hook just renders
 * what Pi has published.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import type {
  PubSubClient,
  ChannelConfig,
  AttachmentInput,
  Participant,
  AgentDebugPayload,
  IncomingMethodResult,
  MethodDefinition,
} from "@natstack/pubsub";
import {
  ConnectionManager,
  derivePiSnapshot,
  type ConnectionConfig,
  type ChatParticipantMetadata,
  type ChatMessage,
  type MethodHistoryEntry,
  type PendingAgent,
  type DirtyRepoDetails,
} from "@workspace/agentic-core";
import { cleanupPendingImages, type PendingImage } from "../../utils/imageUtils";
import type { ChatInputContextValue } from "../../types";
import { useChannelEphemeralMessages } from "../useChannelEphemeralMessages.js";
import { usePiSessionSnapshot } from "../usePiSessionSnapshot.js";
import { usePiTextDeltas } from "../usePiTextDeltas.js";

// =============================================================================
// Types
// =============================================================================

export interface UseChatCoreOptions {
  config: ConnectionConfig;
  channelName: string;
  channelConfig?: ChannelConfig;
  contextId?: string;
  metadata?: ChatParticipantMetadata;
  theme?: "light" | "dark";
  /** If set, automatically sent as the first user message once connected */
  initialPrompt?: string;
}

export interface ChatCoreState {
  messages: ChatMessage[];

  // Connection
  connected: boolean;
  status: string;
  clientRef: React.RefObject<PubSubClient<ChatParticipantMetadata> | null>;
  connectToChannel: (options: { channelId: string; methods: Record<string, MethodDefinition>; channelConfig?: ChannelConfig; contextId?: string }) => Promise<PubSubClient<ChatParticipantMetadata>>;
  hasConnectedRef: React.MutableRefObject<boolean>;

  // Participants
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  participantsRef: React.MutableRefObject<Record<string, Participant<ChatParticipantMetadata>>>;
  allParticipants: Record<string, Participant<ChatParticipantMetadata>>;

  // Input
  input: string;
  pendingImages: PendingImage[];
  handleInputChange: (value: string) => void;
  setPendingImages: React.Dispatch<React.SetStateAction<PendingImage[]>>;

  // Pagination (Pi-native chats are simpler — no pagination of past turns
  // since the snapshot includes all turns by construction)
  hasMoreHistory: boolean;
  loadingMore: boolean;
  loadEarlierMessages: () => Promise<void>;

  // Method history
  methodEntries: Map<string, MethodHistoryEntry>;
  addMethodHistoryEntry: (entry: MethodHistoryEntry) => void;
  updateMethodHistoryEntry: (callId: string, updates: Partial<MethodHistoryEntry>) => void;
  handleMethodResult: (result: IncomingMethodResult) => void;
  clearMethodHistory: () => void;

  // Actions
  sendMessage: (attachments?: AttachmentInput[]) => Promise<void>;
  handleInterruptAgent: (agentId: string, messageId?: string, agentHandle?: string) => Promise<void>;
  handleCallMethod: (providerId: string, methodName: string, args: unknown) => void;
  stopTyping: () => Promise<void>;

  // Agent state
  debugEvents: Array<AgentDebugPayload & { ts: number }>;
  dirtyRepoWarnings: Map<string, DirtyRepoDetails>;
  pendingAgents: Map<string, PendingAgent>;
  addPendingAgent: (handle: string, agentId: string) => void;
  onDismissDirtyWarning: (agentName: string) => void;

  selfIdRef: React.MutableRefObject<string | null>;

  sessionEnabled: boolean | undefined;
  channelName: string;
  theme: "light" | "dark";
  config: ConnectionConfig;

  inputContextValue: ChatInputContextValue;
}

// =============================================================================
// Hook
// =============================================================================

const DEFAULT_METADATA: ChatParticipantMetadata = { name: "Chat Panel", type: "panel", handle: "user" };

export function useChatCore({
  config,
  channelName,
  channelConfig: _channelConfig,
  contextId: _contextId,
  metadata = DEFAULT_METADATA,
  theme = "dark",
  initialPrompt,
}: UseChatCoreOptions): ChatCoreState {
  // --- Stable refs ---
  const selfIdRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);
  const participantsRef = useRef<Record<string, Participant<ChatParticipantMetadata>>>({});
  const inputRef = useRef("");

  // --- Connection manager (PubSubClient lifecycle) ---
  const connectionRef = useRef<ConnectionManager | null>(null);
  if (!connectionRef.current) {
    connectionRef.current = new ConnectionManager({
      config,
      metadata,
      callbacks: {
        onStatusChange: (s) => {
          setStatus(s);
          setConnected(s === "connected");
        },
      },
    });
  }
  const connection = connectionRef.current;

  // --- React state ---
  const [client, setClient] = useState<PubSubClient<ChatParticipantMetadata> | null>(null);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Connecting...");
  const [participants, setParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});
  const [methodEntries, setMethodEntries] = useState<Map<string, MethodHistoryEntry>>(new Map());
  const [debugEvents, _setDebugEvents] = useState<Array<AgentDebugPayload & { ts: number }>>([]);
  const [dirtyRepoWarnings, setDirtyRepoWarnings] = useState<Map<string, DirtyRepoDetails>>(new Map());
  const [pendingAgents, setPendingAgents] = useState<Map<string, PendingAgent>>(new Map());

  const clientRef = useRef<PubSubClient<ChatParticipantMetadata> | null>(null);
  clientRef.current = client;

  // --- Input state ---
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);

  // --- Cleanup pending images on unmount ---
  const pendingImagesRef = useRef(pendingImages);
  pendingImagesRef.current = pendingImages;
  useEffect(() => {
    return () => { cleanupPendingImages(pendingImagesRef.current); };
  }, []);

  // --- Pi snapshot subscription ---
  const snapshotEphemerals = useChannelEphemeralMessages(client, "natstack-state-snapshot");
  const { snapshot, latestTs } = usePiSessionSnapshot(snapshotEphemerals);

  // --- Pi text-delta subscription (for typing-indicator overlay) ---
  const deltaEphemerals = useChannelEphemeralMessages(client, "natstack-text-delta");
  const textDelta = usePiTextDeltas(deltaEphemerals, latestTs);

  // --- Derive ChatMessage[] from Pi snapshot ---
  const messages = useMemo<ChatMessage[]>(() => {
    const derived = derivePiSnapshot(snapshot.messages, selfIdRef.current);
    if (textDelta && snapshot.isStreaming) {
      // Overlay an in-progress assistant message with the live delta text.
      derived.push({
        id: `delta-${textDelta.messageId}`,
        senderId: "assistant",
        content: textDelta.text,
        kind: "message",
        complete: false,
      });
    }
    return derived;
  }, [snapshot, textDelta]);

  // --- Connect ---
  const connectToChannel = useCallback(
    async (options: { channelId: string; methods: Record<string, MethodDefinition>; channelConfig?: ChannelConfig; contextId?: string }): Promise<PubSubClient<ChatParticipantMetadata>> => {
      setStatus("Connecting...");
      const newClient = await connection.connect({
        channelId: options.channelId,
        methods: options.methods,
        channelConfig: options.channelConfig,
        contextId: options.contextId,
      });
      setClient(newClient);
      setConnected(true);
      setStatus("Connected");
      selfIdRef.current = newClient.clientId ?? config.clientId;
      hasConnectedRef.current = true;

      // Channel title from config
      const initialTitle = newClient.channelConfig?.title;
      if (initialTitle) document.title = initialTitle;
      newClient.onConfigChange((cfg: ChannelConfig) => {
        if (cfg.title) document.title = cfg.title;
      });

      // Roster subscription — RosterUpdate.participants is a Record, not an array.
      newClient.onRoster?.((update) => {
        const next = { ...update.participants };
        participantsRef.current = next;
        setParticipants(next);
      });

      return newClient;
    },
    [connection, config.clientId],
  );

  // --- Dispose connection on unmount ---
  useEffect(() => {
    return () => {
      try {
        connection.disconnect();
      } catch {
        // best-effort cleanup
      }
    };
  }, [connection]);

  // --- Method history ---
  const addMethodHistoryEntry = useCallback((entry: MethodHistoryEntry) => {
    setMethodEntries((prev) => {
      const next = new Map(prev);
      next.set(entry.callId, entry);
      return next;
    });
  }, []);

  const updateMethodHistoryEntry = useCallback((callId: string, updates: Partial<MethodHistoryEntry>) => {
    setMethodEntries((prev) => {
      const next = new Map(prev);
      const existing = next.get(callId);
      if (existing) next.set(callId, { ...existing, ...updates });
      return next;
    });
  }, []);

  const handleMethodResult = useCallback((result: IncomingMethodResult) => {
    setMethodEntries((prev) => {
      const next = new Map(prev);
      const existing = next.get(result.callId);
      if (existing) {
        next.set(result.callId, {
          ...existing,
          status: result.isError ? "error" : "success",
          result: result.content,
          error: result.isError ? String(result.content ?? "") : undefined,
          completedAt: Date.now(),
        });
      }
      return next;
    });
  }, []);

  const clearMethodHistory = useCallback(() => {
    setMethodEntries(new Map());
  }, []);

  // --- Typing (no-op in Pi-native mode; the worker controls typing via snapshots) ---
  const stopTyping = useCallback(async () => {
    /* no-op */
  }, []);
  const startTyping = useCallback(async () => {
    /* no-op */
  }, []);

  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    inputRef.current = value;
    if (value.trim()) {
      void startTyping().catch(() => {});
    } else {
      void stopTyping().catch(() => {});
    }
  }, [startTyping, stopTyping]);

  // --- Send message ---
  const sendMessage = useCallback(async (attachments?: AttachmentInput[]): Promise<void> => {
    const currentInput = inputRef.current;
    const hasText = currentInput.trim().length > 0;
    const hasAttachments = attachments && attachments.length > 0;
    if ((!hasText && !hasAttachments) || !client) return;
    const text = currentInput.trim();
    setInput("");
    inputRef.current = "";
    try {
      await client.send(text || "", {
        attachments: hasAttachments ? attachments : undefined,
      });
    } catch (err) {
      setInput(text);
      inputRef.current = text;
      console.error("[Chat] Send failed, draft restored:", err);
      throw err;
    }
  }, [client]);

  // --- Auto-send initial prompt once connected ---
  const initialPromptCaptured = useRef(initialPrompt);
  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    const prompt = initialPromptCaptured.current;
    if (!prompt || !connected || !client || initialPromptSentRef.current) return;
    initialPromptSentRef.current = true;
    inputRef.current = prompt;
    sendMessage().catch((err) => console.warn("[Chat] Failed to send initial prompt:", err));
  }, [connected, client, sendMessage]);

  // --- Load earlier messages (no-op in Pi snapshot model) ---
  const loadEarlierMessages = useCallback(async () => {
    /* no-op: Pi snapshots include the entire conversation tree */
  }, []);

  // --- Interrupt / call method ---
  const handleInterruptAgent = useCallback(
    async (agentId: string, _messageId?: string, _agentHandle?: string) => {
      if (!client) return;
      try {
        await client.callMethod(agentId, "pause", {});
      } catch (err) {
        console.warn("[Chat] Interrupt failed:", err);
      }
    },
    [client],
  );

  const handleCallMethod = useCallback(
    (providerId: string, methodName: string, args: unknown) => {
      if (!client) return;
      const handle = client.callMethod(providerId, methodName, args);
      // MethodCallHandle has a result Promise
      void (handle as { result?: Promise<unknown> }).result?.catch((error: unknown) => {
        console.error(`Failed to call method ${methodName} on ${providerId}:`, error);
      });
    },
    [client],
  );

  const addPendingAgent = useCallback((handle: string, agentId: string) => {
    setPendingAgents((prev) => {
      const next = new Map(prev);
      next.set(handle, { agentId, status: "starting" });
      return next;
    });
  }, []);

  const onDismissDirtyWarning = useCallback((agentName: string) => {
    setDirtyRepoWarnings((prev) => {
      const next = new Map(prev);
      next.delete(agentName);
      return next;
    });
  }, []);

  const inputContextValue: ChatInputContextValue = useMemo(() => ({
    input,
    pendingImages,
    onInputChange: handleInputChange,
    onSendMessage: sendMessage,
    onImagesChange: setPendingImages,
  }), [input, pendingImages, handleInputChange, sendMessage]);

  return {
    messages,
    connected,
    status,
    clientRef,
    connectToChannel,
    hasConnectedRef,
    participants,
    participantsRef,
    allParticipants: participants,
    input,
    pendingImages,
    handleInputChange,
    setPendingImages,
    hasMoreHistory: false,
    loadingMore: false,
    loadEarlierMessages,
    methodEntries,
    addMethodHistoryEntry,
    updateMethodHistoryEntry,
    handleMethodResult,
    clearMethodHistory,
    sendMessage,
    handleInterruptAgent,
    handleCallMethod,
    stopTyping,
    debugEvents,
    dirtyRepoWarnings,
    pendingAgents,
    addPendingAgent,
    onDismissDirtyWarning,
    selfIdRef,
    sessionEnabled: true,
    channelName,
    theme,
    config,
    inputContextValue,
  };
}
