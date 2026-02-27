/**
 * useChatCore — Minimum viable chat hook.
 *
 * Handles: messages, connection, pagination, typing, send, input state,
 * method history, basic participants, channel title, interrupt/call.
 *
 * Feature hooks (roster tracking, debug, feedback, tools, inline UI,
 * pending agents) compose on top via extension refs.
 */

import { useState, useCallback, useMemo, useRef, useEffect, useReducer } from "react";
import { CONTENT_TYPE_TYPING } from "@workspace/agentic-messaging/utils";
import type {
  IncomingEvent,
  IncomingMethodResult,
  AggregatedEvent,
  TypingData,
  ChannelConfig,
} from "@workspace/agentic-messaging";
import type { Participant, RosterUpdate, AttachmentInput } from "@natstack/pubsub";
import { useChannelConnection } from "../useChannelConnection";
import type { UseChannelConnectionResult } from "../useChannelConnection";
import { useMethodHistory } from "../useMethodHistory";
import {
  dispatchAgenticEvent,
  aggregatedToChatMessage,
  type AgentEventHandlers,
  type EventMiddleware,
} from "../useAgentEvents";
import { cleanupPendingImages, type PendingImage } from "../../utils/imageUtils";
import type { MethodHistoryEntry } from "../../components/MethodHistoryItem";
import type {
  ChatMessage,
  ChatParticipantMetadata,
  ConnectionConfig,
  ChatInputContextValue,
} from "../../types";

// =============================================================================
// Message window reducer — single source of truth for messages + pagination
// =============================================================================

const MAX_VISIBLE_MESSAGES = 500;
const TRIM_THRESHOLD = MAX_VISIBLE_MESSAGES * 2;

export interface MessageWindowState {
  messages: ChatMessage[];
  oldestLoadedId: number | null;
  paginationExhausted: boolean;
}

export type MessageWindowAction =
  | { type: "replace"; updater: (prev: ChatMessage[]) => ChatMessage[] }
  | { type: "prepend"; olderMessages: ChatMessage[]; newCursor: number; exhausted: boolean }
  | { type: "reset" };

const messageWindowInitialState: MessageWindowState = {
  messages: [],
  oldestLoadedId: null,
  paginationExhausted: false,
};

function messageWindowReducer(state: MessageWindowState, action: MessageWindowAction): MessageWindowState {
  switch (action.type) {
    case "replace": {
      const updated = action.updater(state.messages);
      if (updated === state.messages) return state;

      // Auto-trim if over threshold
      if (updated.length > TRIM_THRESHOLD) {
        const trimmed = updated.slice(-MAX_VISIBLE_MESSAGES);
        const trimFirstPubsubId = trimmed[0]?.pubsubId;
        return {
          messages: trimmed,
          oldestLoadedId: trimFirstPubsubId ?? state.oldestLoadedId,
          paginationExhausted: false,
        };
      }

      // Initialize cursor if not yet set
      let { oldestLoadedId } = state;
      if (oldestLoadedId === null && updated.length > 0) {
        const firstWithId = updated.find((m) => m.pubsubId !== undefined);
        if (firstWithId?.pubsubId !== undefined) {
          oldestLoadedId = firstWithId.pubsubId;
        }
      }

      return { ...state, messages: updated, oldestLoadedId };
    }
    case "prepend": {
      const existingIds = new Set(
        state.messages.filter((m) => m.pubsubId != null).map((m) => m.pubsubId)
      );
      const deduped = action.olderMessages.filter(
        (m) => !m.pubsubId || !existingIds.has(m.pubsubId)
      );
      const merged = deduped.length > 0 ? [...deduped, ...state.messages] : state.messages;
      return {
        messages: merged,
        oldestLoadedId: action.newCursor,
        paginationExhausted: action.exhausted,
      };
    }
    case "reset":
      return messageWindowInitialState;
  }
}

// =============================================================================
// Types
// =============================================================================

/** Additional event handlers provided by feature hooks */
export interface FeatureEventHandlers {
  setDebugEvents?: AgentEventHandlers["setDebugEvents"];
  setDirtyRepoWarnings?: AgentEventHandlers["setDirtyRepoWarnings"];
  setPendingAgents?: AgentEventHandlers["setPendingAgents"];
  expectedStops?: Set<string>;
}

/** Roster extension callback — called after basic participant update */
export type RosterExtension = (
  roster: RosterUpdate<ChatParticipantMetadata>,
  prevParticipants: Record<string, Participant<ChatParticipantMetadata>>,
) => void;

/** Reconnect extension callback — called when the client reconnects */
export type ReconnectExtension = () => void;

export interface UseChatCoreOptions {
  config: ConnectionConfig;
  channelName: string;
  channelConfig?: ChannelConfig;
  contextId?: string;
  metadata?: ChatParticipantMetadata;
  theme?: "light" | "dark";
  eventMiddleware?: EventMiddleware[];
  /** Ref populated by composer with feature hook event handlers */
  featureHandlersRef?: React.MutableRefObject<FeatureEventHandlers>;
  /** Ref populated by composer with roster extension callbacks */
  rosterExtensionsRef?: React.MutableRefObject<RosterExtension[]>;
  /** Ref populated by composer with reconnect extension callbacks */
  reconnectExtensionsRef?: React.MutableRefObject<ReconnectExtension[]>;
}

export interface ChatCoreState {
  // Message state
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  dispatch: React.Dispatch<MessageWindowAction>;
  messageWindow: MessageWindowState;

  // Connection
  connected: boolean;
  status: string;
  clientRef: UseChannelConnectionResult["clientRef"];
  connectToChannel: UseChannelConnectionResult["connect"];
  hasConnectedRef: React.MutableRefObject<boolean>;

  // Participants (current roster only)
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  participantsRef: React.MutableRefObject<Record<string, Participant<ChatParticipantMetadata>>>;

  // Input
  input: string;
  pendingImages: PendingImage[];
  handleInputChange: (value: string) => void;
  setPendingImages: React.Dispatch<React.SetStateAction<PendingImage[]>>;

  // Pagination
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

  // Reset
  resetCore: () => void;

  // Refs
  selfIdRef: React.MutableRefObject<string | null>;

  // Session
  sessionEnabled: boolean | undefined;
  channelName: string;
  theme: "light" | "dark";
  config: ConnectionConfig;

  // Input context value (convenience)
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
  eventMiddleware,
  featureHandlersRef,
  rosterExtensionsRef,
  reconnectExtensionsRef,
}: UseChatCoreOptions): ChatCoreState {
  const selfIdRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);
  const participantsRef = useRef<Record<string, Participant<ChatParticipantMetadata>>>({});
  const prevParticipantsRef = useRef<Record<string, Participant<ChatParticipantMetadata>>>({});
  const eventMiddlewareRef = useRef(eventMiddleware);
  eventMiddlewareRef.current = eventMiddleware;
  const inputRef = useRef("");

  // --- Message state ---
  const [messageWindow, dispatch] = useReducer(messageWindowReducer, messageWindowInitialState);
  const { messages } = messageWindow;
  const setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>> = useCallback(
    (action: React.SetStateAction<ChatMessage[]>) => {
      dispatch({ type: "replace", updater: typeof action === "function" ? action : () => action });
    },
    []
  );

  // --- Input state ---
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [status, setStatus] = useState("Connecting...");
  const [participants, setParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});

  // --- Pagination ---
  const [firstChatMessageId, setFirstChatMessageId] = useState<number | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);

  const hasMoreHistory = useMemo(() => {
    if (messageWindow.paginationExhausted) return false;
    if (messageWindow.oldestLoadedId === null) return false;
    if (firstChatMessageId !== undefined) {
      return messageWindow.oldestLoadedId > firstChatMessageId;
    }
    return true;
  }, [messageWindow.paginationExhausted, messageWindow.oldestLoadedId, firstChatMessageId]);

  // --- Cleanup pending images on unmount ---
  const pendingImagesRef = useRef(pendingImages);
  pendingImagesRef.current = pendingImages;
  useEffect(() => {
    return () => { cleanupPendingImages(pendingImagesRef.current); };
  }, []);

  // --- Method history ---
  const { methodEntries, addMethodHistoryEntry, updateMethodHistoryEntry, handleMethodResult, clearMethodHistory } =
    useMethodHistory({ setMessages, clientId: config.clientId });

  // --- Channel connection ---
  const { clientRef, connected, clientId, connect: connectToChannel } = useChannelConnection({
    config,
    metadata,
    onEvent: useCallback(
      (event: IncomingEvent) => {
        try {
          const selfId = selfIdRef.current ?? config.clientId;
          const ext = featureHandlersRef?.current;
          dispatchAgenticEvent(
            event,
            {
              setMessages,
              addMethodHistoryEntry,
              handleMethodResult,
              setDebugEvents: ext?.setDebugEvents,
              setDirtyRepoWarnings: ext?.setDirtyRepoWarnings,
              setPendingAgents: ext?.setPendingAgents,
              expectedStops: ext?.expectedStops,
            },
            selfId,
            participantsRef.current,
            eventMiddlewareRef.current,
          );
        } catch (err) {
          console.error("[Chat] Event dispatch error:", err);
        }
      },
      [setMessages, addMethodHistoryEntry, handleMethodResult, config.clientId, featureHandlersRef]
    ),
    onAggregatedEvent: useCallback((event: AggregatedEvent) => {
      switch (event.type) {
        case "message": {
          const chatMsg = aggregatedToChatMessage(event);
          setMessages(prev => {
            if (chatMsg.pubsubId && prev.some(m => m.pubsubId === chatMsg.pubsubId)) return prev;
            if (prev.some(m => m.id === chatMsg.id)) return prev;
            return [...prev, chatMsg];
          });
          break;
        }
        case "method-call": {
          addMethodHistoryEntry({
            callId: event.callId,
            methodName: event.methodName,
            description: undefined,
            args: event.args,
            status: "pending",
            startedAt: event.ts,
            providerId: event.providerId,
            callerId: event.senderId,
            handledLocally: false,
          });
          break;
        }
        case "method-result": {
          const isError = event.status === "error";
          handleMethodResult({
            kind: "replay",
            senderId: event.senderId,
            ts: event.ts,
            callId: event.callId,
            content: event.content,
            complete: event.status !== "incomplete",
            isError,
            pubsubId: event.pubsubId,
            senderMetadata: {
              name: event.senderName,
              type: event.senderType,
              handle: event.senderHandle,
            },
          } as IncomingMethodResult);
          break;
        }
      }
    }, [setMessages, addMethodHistoryEntry, handleMethodResult]),
    onRoster: useCallback((roster: RosterUpdate<ChatParticipantMetadata>) => {
      const prev = prevParticipantsRef.current;

      // Basic participant update
      setParticipants(roster.participants);

      // Call roster extensions (roster tracking, pending agents, etc.)
      const extensions = rosterExtensionsRef?.current ?? [];
      for (const ext of extensions) {
        ext(roster, prev);
      }

      prevParticipantsRef.current = roster.participants;
    }, [rosterExtensionsRef]),
    onReconnect: useCallback(() => {
      prevParticipantsRef.current = {};
      // Call reconnect extensions (roster tracking clears disconnect messages, resets suppression)
      const extensions = reconnectExtensionsRef?.current ?? [];
      for (const ext of extensions) {
        ext();
      }
    }, [reconnectExtensionsRef]),
    onError: useCallback((error: Error) => {
      console.error("[Chat] Connection error:", error);
      setStatus(`Error: ${error.message}`);
    }, []),
  });

  // Sync participantsRef
  participantsRef.current = participants;

  // Synchronous guard for pagination
  const loadingMoreRef = useRef(false);

  // Sync firstChatMessageId on every ready
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !connected) return;
    return client.onReady(() => {
      setFirstChatMessageId(client.firstChatMessageId);
    });
  }, [connected, clientRef]);

  // Load earlier messages
  const loadEarlierMessages = useCallback(async () => {
    const client = clientRef.current;
    const oldestLoadedId = messageWindow.oldestLoadedId;
    if (!client || loadingMoreRef.current || !hasMoreHistory || !oldestLoadedId) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      let currentBeforeId = oldestLoadedId;
      let olderMessages: ChatMessage[] = [];
      let hasMore = true;

      while (hasMore && olderMessages.length === 0) {
        const result = await client.getAggregatedMessagesBefore(currentBeforeId, 50);
        olderMessages = result.messages.map(aggregatedToChatMessage);
        hasMore = result.hasMore;

        if (result.nextBeforeId !== undefined) {
          currentBeforeId = result.nextBeforeId;
        } else {
          hasMore = false;
          break;
        }
      }

      dispatch({ type: "prepend", olderMessages, newCursor: currentBeforeId, exhausted: !hasMore });
    } catch (err) {
      console.error("[Chat] Failed to load earlier messages:", err);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [clientRef, messageWindow.oldestLoadedId, hasMoreHistory]);

  useEffect(() => { selfIdRef.current = clientId; }, [clientId]);

  // Channel title subscription
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !connected) return;
    const initialTitle = client.channelConfig?.title;
    if (initialTitle) document.title = initialTitle;
    const unsubscribe = client.onTitleChange((title: string) => { document.title = title; });
    return () => { unsubscribe(); };
  }, [connected, clientRef]);

  // --- Typing indicators ---
  const typingMessageIdRef = useRef<string | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const TYPING_DEBOUNCE_MS = 2000;

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) { clearTimeout(typingTimeoutRef.current); typingTimeoutRef.current = null; }
    };
  }, []);

  const stopTyping = useCallback(async () => {
    if (typingTimeoutRef.current) { clearTimeout(typingTimeoutRef.current); typingTimeoutRef.current = null; }
    if (typingMessageIdRef.current && clientRef.current?.connected) {
      await clientRef.current.update(typingMessageIdRef.current, "", { complete: true, persist: false });
      typingMessageIdRef.current = null;
    }
  }, [clientRef]);

  const startTyping = useCallback(async () => {
    const client = clientRef.current;
    if (!client?.connected) return;
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    if (!typingMessageIdRef.current) {
      const typingData: TypingData = { senderId: client.clientId ?? config.clientId, senderName: metadata.name, senderType: metadata.type };
      const { messageId } = await client.send(JSON.stringify(typingData), { contentType: CONTENT_TYPE_TYPING, persist: false });
      typingMessageIdRef.current = messageId;
    }
    typingTimeoutRef.current = setTimeout(() => {
      void stopTyping().catch((err) => console.error("[Chat] Stop typing timeout error:", err));
    }, TYPING_DEBOUNCE_MS);
  }, [clientRef, config.clientId, metadata.name, metadata.type, stopTyping]);

  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    inputRef.current = value;
    if (value.trim()) {
      void startTyping().catch((err) => console.error("[Chat] Start typing error:", err));
    } else {
      void stopTyping().catch((err) => console.error("[Chat] Stop typing error:", err));
    }
  }, [startTyping, stopTyping]);

  // --- Send message ---
  const sendMessage = useCallback(async (attachments?: AttachmentInput[]): Promise<void> => {
    const currentInput = inputRef.current;
    const hasText = currentInput.trim().length > 0;
    const hasAttachments = attachments && attachments.length > 0;
    if ((!hasText && !hasAttachments) || !clientRef.current?.connected) return;
    await stopTyping();
    const text = currentInput.trim();
    setInput("");
    inputRef.current = "";
    const { messageId } = await clientRef.current.send(text || "", { attachments: hasAttachments ? attachments : undefined });
    const selfId = clientRef.current.clientId ?? config.clientId;
    setMessages((prev) => {
      if (prev.some((m) => m.id === messageId)) return prev;
      return [...prev, { id: messageId, senderId: selfId, content: text, complete: true, pending: true, kind: "message" }];
    });
  }, [config.clientId, clientRef, stopTyping, setMessages]);

  // --- Interrupt / call method ---
  const handleInterruptAgent = useCallback(
    async (agentId: string, _messageId?: string, agentHandle?: string) => {
      if (!clientRef.current) return;
      const roster = participantsRef.current;
      let targetId = agentId;
      if (!roster[agentId] && agentHandle) {
        const byHandle = Object.values(roster).find(p => p.metadata.handle === agentHandle && p.metadata.type !== "panel");
        if (byHandle) { targetId = byHandle.id; } else { console.warn(`Cannot interrupt: agent ${agentHandle} not in roster`); return; }
      }
      try { await clientRef.current.callMethod(targetId, "pause", { reason: "User interrupted execution" }).result; }
      catch (error) { console.error("Failed to interrupt agent:", error); }
    },
    [clientRef]
  );

  const handleCallMethod = useCallback(
    (providerId: string, methodName: string, args: unknown) => {
      if (!clientRef.current) return;
      void clientRef.current.callMethod(providerId, methodName, args).result.catch((error: unknown) => {
        console.error(`Failed to call method ${methodName} on ${providerId}:`, error);
      });
    },
    [clientRef]
  );

  // --- Reset ---
  const resetCore = useCallback(() => {
    dispatch({ type: "reset" });
    setFirstChatMessageId(undefined);
    setInput("");
    inputRef.current = "";
    cleanupPendingImages(pendingImagesRef.current);
    setPendingImages([]);
    setParticipants({});
    clearMethodHistory();
    loadingMoreRef.current = false;
    setLoadingMore(false);
  }, [clearMethodHistory]);

  // --- Input context value ---
  const inputContextValue: ChatInputContextValue = useMemo(() => ({
    input,
    pendingImages,
    onInputChange: handleInputChange,
    onSendMessage: sendMessage,
    onImagesChange: setPendingImages,
  }), [input, pendingImages, handleInputChange, sendMessage]);

  return {
    messages,
    setMessages,
    dispatch,
    messageWindow,
    connected,
    status,
    clientRef,
    connectToChannel,
    hasConnectedRef,
    participants,
    participantsRef,
    input,
    pendingImages,
    handleInputChange,
    setPendingImages,
    hasMoreHistory,
    loadingMore,
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
    resetCore,
    selfIdRef,
    sessionEnabled: clientRef.current?.sessionEnabled,
    channelName,
    theme,
    config,
    inputContextValue,
  };
}
