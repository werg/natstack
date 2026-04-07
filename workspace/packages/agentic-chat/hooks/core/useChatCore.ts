/**
 * useChatCore — Minimum viable chat hook.
 *
 * Delegates connection, messages, method history, event dispatch, typing,
 * pagination, roster tracking, pending agents, debug events, and dirty repo
 * warnings to SessionManager from @workspace/agentic-core.
 *
 * Retains in the React layer: input state, image cleanup, channel title,
 * initial prompt auto-send, inputContextValue memoization.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import type {
  PubSubClient,
  IncomingMethodResult,
  ChannelConfig,
  AttachmentInput,
  AgentDebugPayload,
  Participant,
} from "@natstack/pubsub";
import type { MethodDefinition } from "@natstack/pubsub";
import {
  SessionManager,
  isAgentParticipantType,
  type SessionManagerConfig,
  type MessageWindowState,
  type MessageWindowAction,
} from "@workspace/agentic-core";
import type { EventMiddleware, DirtyRepoDetails } from "@workspace/agentic-core";
import { cleanupPendingImages, type PendingImage } from "../../utils/imageUtils";
import type { MethodHistoryEntry } from "@workspace/agentic-core";
import type {
  ChatMessage,
  ChatParticipantMetadata,
  ConnectionConfig,
  PendingAgent,
} from "@workspace/agentic-core";
import type { ChatInputContextValue } from "../../types";

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
  eventMiddleware?: EventMiddleware[];
  /** If set, automatically sent as the first user message once connected */
  initialPrompt?: string;
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
  clientRef: React.RefObject<PubSubClient<ChatParticipantMetadata> | null>;
  connectToChannel: (options: { channelId: string; methods: Record<string, MethodDefinition>; channelConfig?: ChannelConfig; contextId?: string }) => Promise<PubSubClient<ChatParticipantMetadata>>;
  hasConnectedRef: React.MutableRefObject<boolean>;

  // Participants (current roster only)
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  participantsRef: React.MutableRefObject<Record<string, Participant<ChatParticipantMetadata>>>;

  // All participants (current + historical, from SessionManager)
  allParticipants: Record<string, Participant<ChatParticipantMetadata>>;

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

  // Agent state (from SessionManager)
  debugEvents: Array<AgentDebugPayload & { ts: number }>;
  dirtyRepoWarnings: Map<string, DirtyRepoDetails>;
  pendingAgents: Map<string, PendingAgent>;
  addPendingAgent: (handle: string, agentId: string) => void;
  onDismissDirtyWarning: (agentName: string) => void;

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
  initialPrompt,
}: UseChatCoreOptions): ChatCoreState {
  // --- Stable refs ---
  const selfIdRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);
  const participantsRef = useRef<Record<string, Participant<ChatParticipantMetadata>>>({});
  const inputRef = useRef("");

  // --- SessionManager (created once) ---
  const managerRef = useRef<SessionManager | null>(null);
  if (!managerRef.current) {
    const managerConfig: SessionManagerConfig = {
      config,
      metadata,
      eventMiddleware,
    };
    managerRef.current = new SessionManager(managerConfig);
  }
  const manager = managerRef.current;

  // --- React state driven by SessionManager events ---
  const [messages, setMessagesState] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Connecting...");
  const [participants, setParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});
  const [allParticipants, setAllParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});
  const [methodEntries, setMethodEntries] = useState<Map<string, MethodHistoryEntry>>(new Map());
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [debugEvents, setDebugEvents] = useState<Array<AgentDebugPayload & { ts: number }>>([]);
  const [dirtyRepoWarnings, setDirtyRepoWarnings] = useState<Map<string, DirtyRepoDetails>>(new Map());
  const [pendingAgents, setPendingAgents] = useState<Map<string, PendingAgent>>(new Map());

  // --- Client ref (synced with manager.client) ---
  const clientRef = useRef<PubSubClient<ChatParticipantMetadata> | null>(null);

  // --- Input state ---
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);

  // --- Cleanup pending images on unmount ---
  const pendingImagesRef = useRef(pendingImages);
  pendingImagesRef.current = pendingImages;
  useEffect(() => {
    return () => { cleanupPendingImages(pendingImagesRef.current); };
  }, []);

  // --- Subscribe to SessionManager events ---
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(manager.on("messagesChanged", (msgs) => {
      setMessagesState([...msgs] as ChatMessage[]);
      // Sync pagination state for correct React re-renders
      setOldestLoadedId(manager.oldestLoadedId);
      setPaginationExhausted(manager.paginationExhausted);
      setHasMoreHistory(manager.hasMoreHistory);
    }));

    unsubs.push(manager.on("connectionChanged", (isConnected, connectionStatus) => {
      setConnected(isConnected);
      setStatus(connectionStatus);
      // Sync clientRef
      clientRef.current = manager.client;
      // Sync selfId
      if (isConnected && manager.client) {
        selfIdRef.current = manager.client.clientId ?? config.clientId;
      }
      // Update hasMoreHistory on connection change
      setHasMoreHistory(manager.hasMoreHistory);
    }));

    unsubs.push(manager.on("participantsChanged", (parts) => {
      setParticipants({ ...parts });
    }));

    unsubs.push(manager.on("allParticipantsChanged", (allParts) => {
      const mutableAllParts = { ...allParts };
      setAllParticipants(mutableAllParts);
      participantsRef.current = mutableAllParts;
    }));

    unsubs.push(manager.on("methodHistoryChanged", (entries) => {
      setMethodEntries(new Map(entries));
    }));

    unsubs.push(manager.on("pendingAgentsChanged", (agents) => {
      setPendingAgents(new Map(agents));
    }));

    unsubs.push(manager.on("debugEvent", (event) => {
      setDebugEvents((prev) => [...prev, event]);
    }));

    unsubs.push(manager.on("dirtyRepoWarning", (handle, details) => {
      setDirtyRepoWarnings((prev) => {
        const next = new Map(prev);
        next.set(handle, details);
        return next;
      });
    }));

    unsubs.push(manager.on("error", (error) => {
      console.error("[Chat] Connection error:", error);
      setStatus(`Error: ${error.message}`);
    }));

    return () => {
      for (const unsub of unsubs) unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, config.clientId]);

  // --- Dispose manager on unmount ---
  useEffect(() => {
    return () => {
      manager.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager]);

  // --- Connect (delegates to manager) ---
  const connectToChannel = useCallback(
    async (options: { channelId: string; methods: Record<string, MethodDefinition>; channelConfig?: ChannelConfig; contextId?: string }): Promise<PubSubClient<ChatParticipantMetadata>> => {
      await manager.connect(options.channelId, {
        methods: options.methods,
        channelConfig: options.channelConfig,
        contextId: options.contextId,
      });
      // The client is now available
      const client = manager.client!;
      clientRef.current = client;
      selfIdRef.current = client.clientId ?? config.clientId;

      // Channel title subscription — cleaned up when client is closed by manager
      const initialTitle = client.channelConfig?.title;
      if (initialTitle) document.title = initialTitle;
      client.onConfigChange((cfg: ChannelConfig) => {
        if (cfg.title) document.title = cfg.title;
      });

      return client;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manager, config.clientId]
  );

  // --- Pagination state (tracked separately for React re-renders) ---
  const [oldestLoadedId, setOldestLoadedId] = useState<number | null>(null);
  const [paginationExhausted, setPaginationExhausted] = useState(false);

  // --- setMessages (delegates to manager's public API) ---
  const setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>> = useCallback(
    (action: React.SetStateAction<ChatMessage[]>) => {
      const updater = typeof action === "function" ? action : () => action;
      manager.updateMessages(updater);
    },
    [manager]
  );

  // --- dispatch (delegates to manager's public API) ---
  const dispatch: React.Dispatch<MessageWindowAction> = useCallback(
    (action: MessageWindowAction) => {
      manager.dispatchMessageAction(action);
    },
    [manager]
  );

  // --- messageWindow (driven by React state for correct re-renders) ---
  const messageWindow: MessageWindowState = useMemo(() => ({
    messages,
    oldestLoadedId,
    paginationExhausted,
  }), [messages, oldestLoadedId, paginationExhausted]);

  // --- Method history wrappers (delegate to manager's public API) ---
  const addMethodHistoryEntry = useCallback(
    (entry: MethodHistoryEntry) => {
      manager.addMethodHistoryEntry(entry);
    },
    [manager]
  );

  const updateMethodHistoryEntry = useCallback(
    (callId: string, updates: Partial<MethodHistoryEntry>) => {
      manager.updateMethodHistoryEntry(callId, updates);
    },
    [manager]
  );

  const handleMethodResult = useCallback(
    (result: IncomingMethodResult) => {
      manager.handleMethodResult(result);
    },
    [manager]
  );

  const clearMethodHistory = useCallback(() => {
    manager.clearMethodHistory();
  }, [manager]);

  // --- Typing ---
  const stopTyping = useCallback(async () => {
    await manager.stopTyping();
  }, [manager]);

  const startTyping = useCallback(async () => {
    await manager.startTyping();
  }, [manager]);

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
    if ((!hasText && !hasAttachments) || !manager.client?.connected) return;
    const text = currentInput.trim();
    // Optimistically clear input
    setInput("");
    inputRef.current = "";
    try {
      await manager.send(text || "", {
        attachments: hasAttachments ? attachments : undefined,
      });
    } catch (err) {
      // Restore draft so user can retry — rethrow so caller (ChatInput) keeps attachments
      setInput(text);
      inputRef.current = text;
      console.error("[Chat] Send failed, draft restored:", err);
      throw err;
    }
  }, [manager]);

  // --- Auto-send initial prompt once connected ---
  const initialPromptCaptured = useRef(initialPrompt);
  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    const prompt = initialPromptCaptured.current;
    if (!prompt || !connected || !manager.client || initialPromptSentRef.current) return;
    initialPromptSentRef.current = true;
    inputRef.current = prompt;
    sendMessage().catch((err) => console.warn("[Chat] Failed to send initial prompt:", err));
  }, [connected, sendMessage, manager]);

  // --- Load earlier messages ---
  const loadEarlierMessages = useCallback(async () => {
    if (loadingMore || !hasMoreHistory) return;
    setLoadingMore(true);
    try {
      await manager.loadEarlierMessages();
      setHasMoreHistory(manager.hasMoreHistory);
    } catch (err) {
      console.error("[Chat] Failed to load earlier messages:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [manager, loadingMore, hasMoreHistory]);

  // --- Interrupt / call method ---
  const handleInterruptAgent = useCallback(
    async (agentId: string, _messageId?: string, agentHandle?: string) => {
      if (!manager.client) return;
      const roster = participantsRef.current;
      let resolvedId = agentId;
      if (!roster[agentId] && agentHandle) {
        const byHandle = Object.values(roster).find(p => p.metadata.handle === agentHandle && isAgentParticipantType(p.metadata.type));
        if (byHandle) { resolvedId = byHandle.id; } else { console.warn(`Cannot interrupt: agent ${agentHandle} not in roster`); return; }
      }
      await manager.interrupt(resolvedId);
    },
    [manager]
  );

  const handleCallMethod = useCallback(
    (providerId: string, methodName: string, args: unknown) => {
      void manager.callMethod(providerId, methodName, args).catch((error: unknown) => {
        console.error(`Failed to call method ${methodName} on ${providerId}:`, error);
      });
    },
    [manager]
  );

  // --- addPendingAgent (delegates to manager) ---
  const addPendingAgent = useCallback((handle: string, agentId: string) => {
    manager.addPendingAgent(handle, agentId);
  }, [manager]);

  // --- Dismiss dirty repo warning ---
  const onDismissDirtyWarning = useCallback((agentName: string) => {
    manager.dismissDirtyRepoWarning(agentName);
    setDirtyRepoWarnings(prev => {
      const next = new Map(prev);
      next.delete(agentName);
      return next;
    });
  }, [manager]);

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
    allParticipants,
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
