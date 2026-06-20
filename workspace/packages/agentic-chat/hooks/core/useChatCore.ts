/**
 * useChatCore — Channel-message-driven chat hook.
 *
 * The agent worker publishes Pi events as real channel messages. This hook:
 * - Owns the PubSubClient connection lifecycle
 * - Subscribes to ALL channel messages (persisted + replay) via useChannelMessages
 * - Builds a flat `ChatMessage[]` from typed agentic events
 * - Dispatches non-transcript protocol events (debug, roster) from ConnectionManager
 * - Tracks participants (current + historical) and generates disconnect notifications
 *
 * Transcript UX streams via PubSub agentic events → reducer → view model.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import type {
  PubSubClient,
  ChannelConfig,
  AttachmentInput,
  Participant,
  AgentDebugPayload,
  IncomingEvent,
  MethodDefinition,
} from "@workspace/pubsub";
import { isAgentParticipantType } from "@workspace/pubsub";
import {
  ConnectionManager,
  type ActionBarPayload,
  type ConnectionConfig,
  type ChatParticipantMetadata,
  type ChatMessage,
  type MessageTypeDefinition,
  type PendingAgent,
  type DirtyRepoDetails,
  type DisconnectedAgentInfo,
} from "@workspace/agentic-core";
import { cleanupPendingImages, type PendingImage } from "../../utils/imageUtils";
import type { ChatInputContextValue } from "../../types";
import { useChannelMessages } from "../useChannelMessages.js";

/** Maximum debug events to retain (ring buffer). */
const MAX_DEBUG_EVENTS = 500;

const DEFAULT_CHAT_TITLE_MAX_LENGTH = 64;

export function titleFromFirstUserMessage(message: string): string | null {
  const normalized = message.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  if (normalized.length <= DEFAULT_CHAT_TITLE_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, DEFAULT_CHAT_TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}

export function shouldAutoSendInitialPrompt({
  prompt,
  connected,
  alreadySent,
  hasPriorMessages,
  force,
}: {
  prompt: string | undefined;
  connected: boolean;
  alreadySent: boolean;
  hasPriorMessages: boolean;
  /** Seed the prompt even when the channel already has transcript history
   *  (e.g. a fork). Still idempotent via the channel idempotency key. */
  force?: boolean;
}): boolean {
  return Boolean(prompt && connected && !alreadySent && (force || !hasPriorMessages));
}

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
  /** Send initialPrompt even if the channel already has history (idempotent). */
  forceInitialPrompt?: boolean;
}

export interface ChatCoreState {
  messages: ChatMessage[];

  // Connection
  connected: boolean;
  status: string;
  /** Last connection-layer error (subscribe failure, event-stream rejection).
   *  Surfaced via `ConnectionManager.onError`. Cleared by `dismissConnectionError`. */
  connectionError: { message: string; at: number } | null;
  dismissConnectionError: () => void;
  client: PubSubClient<ChatParticipantMetadata> | null;
  clientRef: React.RefObject<PubSubClient<ChatParticipantMetadata> | null>;
  connectToChannel: (options: {
    channelId: string;
    methods: Record<string, MethodDefinition>;
    channelConfig?: ChannelConfig;
    contextId?: string;
  }) => Promise<PubSubClient<ChatParticipantMetadata>>;
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

  // Pagination
  hasMoreHistory: boolean;
  loadingMore: boolean;
  loadEarlierMessages: () => Promise<void>;
  canonicalActionBar: ActionBarPayload | null;
  messageTypes: MessageTypeDefinition[];

  // Actions
  sendMessage: (
    attachments?: AttachmentInput[],
    options?: { mentions?: string[]; replyTo?: string }
  ) => Promise<void>;
  handleInterruptAgent: (
    agentId: string,
    messageId?: string,
    agentHandle?: string
  ) => Promise<void>;
  handleCancelInvocation: (transportCallId: string) => Promise<void>;
  handleCallMethod: (providerId: string, methodName: string, args: unknown) => void;
  handleCallMethodResult: (
    providerId: string,
    methodName: string,
    args: unknown
  ) => Promise<unknown>;
  stopTyping: () => Promise<void>;

  // Agent state
  debugEvents: Array<AgentDebugPayload & { ts: number }>;
  dirtyRepoWarnings: Map<string, DirtyRepoDetails>;
  pendingAgents: Map<string, PendingAgent>;
  addPendingAgent: (handle: string, agentId: string) => void;
  setPendingAgentInfos: (agents: Array<{ handle: string; agentId: string }>) => void;
  removePendingAgent: (handle: string) => void;
  onDismissDirtyWarning: (agentName: string) => void;

  selfId: string | null;
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

const DEFAULT_METADATA: ChatParticipantMetadata = {
  name: "Chat Panel",
  type: "panel",
  handle: "user",
};

export function useChatCore({
  config,
  channelName,
  channelConfig: _channelConfig,
  contextId: _contextId,
  metadata = DEFAULT_METADATA,
  theme = "dark",
  initialPrompt,
  forceInitialPrompt = false,
}: UseChatCoreOptions): ChatCoreState {
  // --- Stable refs ---
  const selfIdRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);
  const participantsRef = useRef<Record<string, Participant<ChatParticipantMetadata>>>({});
  const allParticipantsRef = useRef<Record<string, Participant<ChatParticipantMetadata>>>({});
  const inputRef = useRef("");
  const defaultTitleSetRef = useRef(Boolean(_channelConfig?.title));
  const hasTranscriptMessagesRef = useRef(false);

  // Suppress disconnect detection until we see ourselves in the roster
  // (avoids spurious disconnects during initial handshake).
  const suppressDisconnectRef = useRef(true);
  // Track expected stops so we don't show "disconnected" for them.
  const expectedStopsRef = useRef(new Set<string>());
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
          if (s === "connected") {
            // Clear any prior error on successful (re)connect.
            setConnectionError(null);
          }
        },
        onError: (err) => {
          console.error("[useChatCore] connection error:", err);
          setConnectionError({ message: err.message, at: Date.now() });
        },
        onEvent: (event: IncomingEvent) => {
          // --- Agent debug signal events ---
          if (event.type === "agent-debug") {
            const payload = (event as { payload: AgentDebugPayload }).payload;
            const ts = (event as { ts: number }).ts ?? Date.now();
            setDebugEvents((prev) => {
              const next = [...prev, { ...payload, ts }];
              return next.length > MAX_DEBUG_EVENTS ? next.slice(-MAX_DEBUG_EVENTS) : next;
            });

            // Dirty repo warnings
            if (
              payload.debugType === "lifecycle" &&
              payload.event === "warning" &&
              payload.reason === "dirty-repo"
            ) {
              const details = payload.details as DirtyRepoDetails | undefined;
              if (details) {
                setDirtyRepoWarnings((prev) => {
                  const n = new Map(prev);
                  n.set(payload.handle, details);
                  return n;
                });
              }
            }

            // Track expected idle stops so roster handler can suppress disconnect message.
            if (
              payload.debugType === "lifecycle" &&
              payload.event === "stopped" &&
              payload.reason === "idle"
            ) {
              expectedStopsRef.current.add(payload.handle);
            }

            // Spawn errors → update pending agent status
            if (payload.debugType === "spawn-error") {
              setPendingAgents((prev) => {
                const existing = prev.get(payload.handle);
                if (!existing) return prev;
                const n = new Map(prev);
                n.set(payload.handle, {
                  ...existing,
                  status: "error",
                  error: {
                    message: payload.error ?? "Agent failed to start",
                    details: payload.buildError ? JSON.stringify(payload.buildError) : undefined,
                  },
                });
                return n;
              });
            }
          }
        },
        onReconnect: () => {
          // Reset disconnect suppression and clear stale state
          suppressDisconnectRef.current = true;
          allParticipantsRef.current = {};
          setDisconnectMessages([]);
          setStatus("Connected");
        },
      },
    });
  }
  const connection = connectionRef.current;

  // --- React state ---
  const [client, setClient] = useState<PubSubClient<ChatParticipantMetadata> | null>(null);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Connecting...");
  const [connectionError, setConnectionError] = useState<{ message: string; at: number } | null>(
    null
  );
  const dismissConnectionError = useCallback(() => setConnectionError(null), []);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [participants, setParticipants] = useState<
    Record<string, Participant<ChatParticipantMetadata>>
  >({});
  const [debugEvents, setDebugEvents] = useState<Array<AgentDebugPayload & { ts: number }>>([]);
  const [dirtyRepoWarnings, setDirtyRepoWarnings] = useState<Map<string, DirtyRepoDetails>>(
    new Map()
  );
  const [pendingAgents, setPendingAgents] = useState<Map<string, PendingAgent>>(new Map());

  const clientRef = useRef<PubSubClient<ChatParticipantMetadata> | null>(null);
  clientRef.current = client;

  // --- Input state ---
  const [input, setInput] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);

  // --- Cleanup pending images on unmount ---
  const pendingImagesRef = useRef(pendingImages);
  pendingImagesRef.current = pendingImages;
  useEffect(() => {
    return () => {
      cleanupPendingImages(pendingImagesRef.current);
    };
  }, []);

  // --- Channel messages subscription ---
  const {
    messages: channelMessages,
    actionBar: channelActionBar,
    messageTypes,
    hasMoreHistory: channelHasMore,
    loadingMore: channelLoadingMore,
    loadEarlierMessages: channelLoadEarlier,
    backfillAfterLocalPublish,
  } = useChannelMessages(client);

  // --- Disconnect system messages (injected from roster changes) ---
  const [disconnectMessages, setDisconnectMessages] = useState<ChatMessage[]>([]);

  // Merge channel-derived transcript messages with local non-transcript system notices.
  const messages = useMemo(() => {
    return [...channelMessages, ...disconnectMessages];
  }, [channelMessages, disconnectMessages]);

  useEffect(() => {
    if (messages.length > 0) {
      hasTranscriptMessagesRef.current = true;
    }
  }, [messages.length]);

  // --- Connect ---
  const connectToChannel = useCallback(
    async (options: {
      channelId: string;
      methods: Record<string, MethodDefinition>;
      channelConfig?: ChannelConfig;
      contextId?: string;
    }): Promise<PubSubClient<ChatParticipantMetadata>> => {
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
      const resolvedSelfId = newClient.clientId ?? config.clientId;
      selfIdRef.current = resolvedSelfId;
      setSelfId(resolvedSelfId);
      hasConnectedRef.current = true;

      // Channel title from config
      const initialTitle = newClient.channelConfig?.title;
      if (initialTitle) {
        defaultTitleSetRef.current = true;
        document.title = initialTitle;
      }
      newClient.onConfigChange((cfg: ChannelConfig) => {
        if (cfg.title) {
          defaultTitleSetRef.current = true;
          document.title = cfg.title;
        }
      });

      // Roster subscription
      newClient.onRoster?.((update) => {
        const prev = participantsRef.current;
        const next = { ...update.participants };
        participantsRef.current = next;
        setParticipants(next);

        // Unsuppress disconnect detection once we see ourselves in the roster
        if (suppressDisconnectRef.current && config.clientId in next) {
          suppressDisconnectRef.current = false;
        }

        // Accumulate historical participants
        allParticipantsRef.current = { ...allParticipantsRef.current, ...next };
        // Also preserve departed participants
        for (const [id, p] of Object.entries(prev)) {
          if (!(id in next)) allParticipantsRef.current[id] = p;
        }

        // --- Disconnect detection ---
        if (!suppressDisconnectRef.current) {
          const changeIsExpectedLeave =
            update.change?.type === "leave" &&
            ((update as { change?: { leaveReason?: string } }).change?.leaveReason === "graceful" ||
              (update as { change?: { leaveReason?: string } }).change?.leaveReason === "replaced");

          for (const [pid, prevP] of Object.entries(prev)) {
            if (next[pid]) continue;
            if (!isAgentParticipantType(prevP?.metadata?.type)) continue;

            // Skip expected leaves (graceful, replaced) and expected idle stops.
            const handle = prevP.metadata.handle;
            const isExpectedStop = expectedStopsRef.current.has(handle) || changeIsExpectedLeave;
            expectedStopsRef.current.delete(handle);
            if (isExpectedStop) continue;

            const info: DisconnectedAgentInfo = {
              name: prevP.metadata.name,
              handle,
              type: prevP.metadata.type,
            };
            setDisconnectMessages((msgs) => {
              if (msgs.some((m) => m.disconnectedAgent?.handle === handle)) return msgs;
              return [
                ...msgs,
                {
                  id: `system-disconnect-${pid}-${Date.now()}`,
                  senderId: "system",
                  content: "",
                  kind: "system",
                  complete: true,
                  disconnectedAgent: info,
                  senderMetadata: { name: info.name, type: info.type, handle: info.handle },
                },
              ];
            });
          }
        }

        // Clear disconnect messages when an agent with the same handle reconnects
        const agentHandles = new Set(
          Object.values(next)
            .filter((p) => isAgentParticipantType(p.metadata.type))
            .map((p) => p.metadata.handle)
        );
        setDisconnectMessages((msgs) => {
          const filtered = msgs.filter(
            (m) => !m.disconnectedAgent || !agentHandles.has(m.disconnectedAgent.handle)
          );
          return filtered.length === msgs.length ? msgs : filtered;
        });

        // Auto-clear pending agents whose handle is now in the roster
        setPendingAgents((prevPending) => {
          if (prevPending.size === 0) return prevPending;
          let changed = false;
          const nextPending = new Map(prevPending);
          for (const handle of prevPending.keys()) {
            if (
              agentHandles.has(handle) ||
              Object.values(next).some(
                (p) => (p?.metadata?.handle as string | undefined) === handle
              )
            ) {
              nextPending.delete(handle);
              changed = true;
            }
          }
          return changed ? nextPending : prevPending;
        });
      });

      // Check initial roster snapshot
      const initialRoster = newClient.roster ?? {};
      allParticipantsRef.current = { ...allParticipantsRef.current, ...initialRoster };
      setPendingAgents((prevPending) => {
        if (prevPending.size === 0) return prevPending;
        let changed = false;
        const nextPending = new Map(prevPending);
        for (const handle of prevPending.keys()) {
          if (
            Object.values(initialRoster).some(
              (p) => (p?.metadata?.handle as string | undefined) === handle
            )
          ) {
            nextPending.delete(handle);
            changed = true;
          }
        }
        return changed ? nextPending : prevPending;
      });

      return newClient;
    },
    [connection, config.clientId]
  );

  // --- Dispose connection on unmount ---
  useEffect(() => {
    return () => {
      try {
        connection.disconnect();
      } catch {
        /* best-effort */
      }
    };
  }, [connection]);

  // --- Typing indicators (signal, roster-based) ---
  const typingActiveRef = useRef(false);

  const stopTyping = useCallback(async () => {
    if (!typingActiveRef.current) return;
    typingActiveRef.current = false;
    const c = clientRef.current;
    if (c?.connected) {
      try {
        await c.setTyping(false);
      } catch {
        /* best-effort */
      }
    }
  }, []);

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);
      inputRef.current = value;
      void stopTyping().catch((err) => {
        console.warn("[useChatCore] Failed to stop typing after input change:", err);
      });
    },
    [stopTyping]
  );

  // --- Send message ---
  const sendMessage = useCallback(
    async (
      attachments?: AttachmentInput[],
      options?: { mentions?: string[]; replyTo?: string }
    ): Promise<void> => {
      const currentInput = inputRef.current;
      const hasText = currentInput.trim().length > 0;
      const hasAttachments = attachments && attachments.length > 0;
      if ((!hasText && !hasAttachments) || !clientRef.current) return;
      const text = currentInput.trim();
      const previousReplyTo = options?.replyTo ?? null;
      setInput("");
      inputRef.current = "";
      setReplyTo(null);
      void stopTyping().catch((err) => {
        console.warn("[useChatCore] Failed to stop typing before send:", err);
      });
      try {
        const hadPriorTranscriptMessages = hasTranscriptMessagesRef.current;
        const { pubsubId } = await clientRef.current.send(text || "", {
          attachments: hasAttachments ? attachments : undefined,
          mentions: options?.mentions && options.mentions.length > 0 ? options.mentions : undefined,
          replyTo: options?.replyTo,
        });
        await backfillAfterLocalPublish(pubsubId);
        const defaultTitle =
          !defaultTitleSetRef.current && !hadPriorTranscriptMessages
            ? titleFromFirstUserMessage(text)
            : null;
        if (defaultTitle) {
          defaultTitleSetRef.current = true;
          document.title = defaultTitle;
          void clientRef.current
            .updateChannelConfig({ title: defaultTitle, titleExplicit: false })
            .catch((err) => {
              console.warn("[useChatCore] Failed to persist default channel title:", err);
            });
        }
      } catch (err) {
        setInput(text);
        inputRef.current = text;
        setReplyTo(previousReplyTo);
        console.error("[Chat] Send failed, draft restored:", err);
        throw err;
      }
    },
    [backfillAfterLocalPublish, stopTyping]
  );

  // --- Auto-send initial prompt once connected ---
  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    if (!client) return;
    const hasPriorMessages = hasTranscriptMessagesRef.current;
    const prompt = initialPrompt;
    if (
      !prompt ||
      !shouldAutoSendInitialPrompt({
        prompt,
        connected,
        alreadySent: initialPromptSentRef.current,
        hasPriorMessages,
        force: forceInitialPrompt,
      })
    ) {
      return;
    }
    initialPromptSentRef.current = true;

    const defaultTitle = !defaultTitleSetRef.current ? titleFromFirstUserMessage(prompt) : null;
    if (defaultTitle) {
      defaultTitleSetRef.current = true;
      document.title = defaultTitle;
      void client
        .updateChannelConfig({ title: defaultTitle, titleExplicit: false })
        .catch((err) => {
          console.warn("[useChatCore] Failed to persist initial prompt channel title:", err);
        });
    }

    client
      .send(prompt, {
        idempotencyKey: `initial-prompt:${channelName}`,
        // Injected prompt: rendered as if from the user, but system-originated —
        // supporting context, not the human's own typed input.
        tier: "secondary",
      })
      .then(({ pubsubId }) => backfillAfterLocalPublish(pubsubId))
      .catch((err) => console.warn("[Chat] Failed to send initial prompt:", err));
  }, [backfillAfterLocalPublish, connected, client, channelName, initialPrompt, forceInitialPrompt]);

  // --- Load earlier messages (delegates to useChannelMessages pagination) ---
  const loadEarlierMessages = channelLoadEarlier;

  // --- Interrupt / call method ---
  const handleInterruptAgent = useCallback(
    async (agentId: string, _messageId?: string, agentHandle?: string) => {
      const c = clientRef.current;
      if (!c) return;
      // Resolve by handle if agentId isn't a participant ID
      let targetId = agentId;
      const roster = allParticipantsRef.current;
      if (!roster[agentId] && agentHandle) {
        const byHandle = Object.values(roster).find(
          (p) => p.metadata.handle === agentHandle && isAgentParticipantType(p.metadata.type)
        );
        if (byHandle) targetId = Object.keys(roster).find((k) => roster[k] === byHandle) ?? agentId;
      } else if (!roster[agentId]) {
        const byHandle = Object.values(roster).find(
          (p) => p.metadata.handle === agentId && isAgentParticipantType(p.metadata.type)
        );
        if (byHandle) targetId = Object.keys(roster).find((k) => roster[k] === byHandle) ?? agentId;
      }
      try {
        await c.callMethod(targetId, "pause", { reason: "User interrupted execution" });
      } catch (err) {
        console.warn("[Chat] Interrupt failed:", err);
      }
    },
    []
  );

  const handleCancelInvocation = useCallback(async (transportCallId: string) => {
    const c = clientRef.current;
    if (!c) return;
    // Stop a method this panel is executing (e.g. an eval) immediately and
    // in-process by firing its local AbortController. The executing method's
    // own abort path publishes invocation.cancelled, which settles the agent's
    // pending result — so the turn still learns the call ended. We do this
    // BEFORE the channel round-trip because the round-trip is unreliable for
    // stopping local work (the DO may have no pending_calls row left to cancel,
    // so it never broadcasts invocation.cancelled).
    const abortedLocally = c.abortExecutingMethod(transportCallId);
    try {
      // Still notify the channel so its pending_calls bookkeeping is cleared
      // and any remote provider executing the call is asked to stop. Best
      // effort — when we already aborted locally this is just cleanup.
      await c.cancelMethodCall(transportCallId);
    } catch (err) {
      if (!abortedLocally) console.warn("[Chat] Cancel invocation failed:", err);
    }
  }, []);

  const handleCallMethod = useCallback((providerId: string, methodName: string, args: unknown) => {
    const c = clientRef.current;
    if (!c) return;
    const handle = c.callMethod(providerId, methodName, args);
    void (handle as { result?: Promise<unknown> }).result?.catch((error: unknown) => {
      console.error(`Failed to call method ${methodName} on ${providerId}:`, error);
    });
  }, []);

  /** Like handleCallMethod, but awaits and returns the provider's result payload.
   *  Used by settings UIs that need to read getAgentSettings / confirm setters. */
  const handleCallMethodResult = useCallback(
    async (providerId: string, methodName: string, args: unknown): Promise<unknown> => {
      const c = clientRef.current;
      if (!c) throw new Error("Not connected to channel");
      const handle = c.callMethod(providerId, methodName, args);
      const result = (handle as { result?: Promise<unknown> }).result;
      return result ? await result : undefined;
    },
    []
  );

  const addPendingAgent = useCallback((handle: string, agentId: string) => {
    setPendingAgents((prev) => {
      const next = new Map(prev);
      next.set(handle, { agentId, status: "starting" });
      return next;
    });
  }, []);

  const setPendingAgentInfos = useCallback((agents: Array<{ handle: string; agentId: string }>) => {
    setPendingAgents((prev) => {
      const next = new Map<string, PendingAgent>();
      for (const agent of agents) {
        const existing = prev.get(agent.handle);
        next.set(
          agent.handle,
          existing?.status === "error"
            ? { ...existing, agentId: agent.agentId }
            : { agentId: agent.agentId, status: "starting" }
        );
      }
      return next;
    });
  }, []);

  const removePendingAgent = useCallback((handle: string) => {
    setPendingAgents((prev) => {
      if (!prev.has(handle)) return prev;
      const next = new Map(prev);
      next.delete(handle);
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

  const inputContextValue: ChatInputContextValue = useMemo(
    () => ({
      input,
      pendingImages,
      onInputChange: handleInputChange,
      onSendMessage: sendMessage,
      onImagesChange: setPendingImages,
      replyTo,
      replyToMessage: replyTo ? (messages.find((message) => message.id === replyTo) ?? null) : null,
      setReplyTo,
    }),
    [input, pendingImages, handleInputChange, sendMessage, replyTo, messages]
  );

  return {
    messages,
    connected,
    status,
    connectionError,
    dismissConnectionError,
    client,
    clientRef,
    connectToChannel,
    hasConnectedRef,
    participants,
    participantsRef,
    allParticipants: { ...allParticipantsRef.current, ...participants },
    input,
    pendingImages,
    handleInputChange,
    setPendingImages,
    hasMoreHistory: channelHasMore,
    loadingMore: channelLoadingMore,
    loadEarlierMessages,
    canonicalActionBar: channelActionBar,
    messageTypes,
    sendMessage,
    handleInterruptAgent,
    handleCancelInvocation,
    handleCallMethod,
    handleCallMethodResult,
    stopTyping,
    debugEvents,
    dirtyRepoWarnings,
    pendingAgents,
    addPendingAgent,
    setPendingAgentInfos,
    removePendingAgent,
    onDismissDirtyWarning,
    selfId,
    selfIdRef,
    sessionEnabled: true,
    channelName,
    theme,
    config,
    inputContextValue,
  };
}
