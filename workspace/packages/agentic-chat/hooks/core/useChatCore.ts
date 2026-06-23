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
  type InvocationCardPayload,
} from "@workspace/agentic-core";
import type { MessageBlockInput } from "@workspace/agentic-protocol";
import { cleanupPendingImages, type PendingImage } from "../../utils/imageUtils";
import type {
  ChatInputContextValue,
  FlushNarration,
  PrimaryActionIntent,
  UndoableAction,
} from "../../types";
import { useChannelMessages } from "../useChannelMessages.js";

/** Maximum debug events to retain (ring buffer). */
const MAX_DEBUG_EVENTS = 500;

const DEFAULT_CHAT_TITLE_MAX_LENGTH = 64;

/**
 * Resolve the effective appearance when no explicit `theme` prop is passed.
 * NEVER defaults to a literal "dark" — it follows the system / centralized
 * appearance via `prefers-color-scheme`, so a light-mode user is never forced
 * into dark by an embedder that forgot to thread a theme.
 */
export function resolveSystemTheme(): "light" | "dark" {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {
      /* fall through */
    }
  }
  return "light";
}

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

/**
 * Reconcile the after-turn id set against the live transcript: drop an id once
 * its message is PRESENT but no longer a pending-unread self message (read /
 * retracted / errored). Ids not yet in the transcript — a just-sent message
 * whose echo hasn't landed — are KEPT, so a concurrent update can't prune a tag
 * before its message arrives. Returns `prev` unchanged when nothing drops, so
 * it's effect-safe. Without this the set only grows — leaving the palette's
 * queued count stale and "cancel queued" firing no-op retractions.
 */
export function pruneAfterTurnIds(
  prev: Set<string>,
  messages: ChatMessage[],
  selfId: string | null
): Set<string> {
  if (prev.size === 0) return prev;
  const byId = new Map(messages.map((m) => [m.id, m]));
  const isPendingSelf = (m: ChatMessage): boolean =>
    m.senderId === selfId &&
    (m.kind ?? "message") === "message" &&
    !m.error &&
    !m.retracted &&
    (m.receipts?.aggregate ?? "pending") === "pending";
  let next: Set<string> | null = null;
  for (const id of prev) {
    const m = byId.get(id);
    // Drop once the message is PRESENT but no longer a pending-unread self outbox
    // item (read / retracted / errored). ABSENT ids are kept — a just-sent
    // after-turn message may not have been projected back yet, and a concurrent
    // transcript update must not prune its tag before its echo lands.
    if (m && !isPendingSelf(m)) {
      (next ??= new Set(prev)).delete(id);
    }
  }
  return next ?? prev;
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
    options?: { mentions?: string[]; replyTo?: string; metadata?: Record<string, unknown> }
  ) => Promise<void>;
  handleInterruptAgent: (
    agentId: string,
    messageId?: string,
    agentHandle?: string
  ) => Promise<void>;
  handleCancelInvocation: (
    invocation: InvocationCardPayload,
    senderId: string
  ) => Promise<void>;
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

  // --- Delivery model ---
  agentBusy: boolean;
  hasOpenTurn: boolean;
  primaryActionIntent: PrimaryActionIntent;
  pendingSendCount: number;
  afterTurnMessageIds: Set<string>;
  failedSendMessageIds: Set<string>;
  flushNarration: FlushNarration | undefined;
  undoableAction: UndoableAction | undefined;
  editPendingMessage: (messageId: string, newText: string) => Promise<void>;
  cancelPendingMessage: (messageId: string) => Promise<void>;
  flushOutboxAndInterrupt: () => Promise<void>;
  undoLastAction: () => void;
  retrySend: (messageId: string) => void;

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
  theme: themeProp,
  initialPrompt,
  forceInitialPrompt = false,
}: UseChatCoreOptions): ChatCoreState {
  // Appearance flows from the explicit prop OR the system / centralized
  // appearance — never a hardcoded "dark" fallback.
  const theme: "light" | "dark" = themeProp ?? resolveSystemTheme();
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

  // --- Delivery-model UI state (local only; not protocol state) ---
  /** Transient count of in-flight sends — the "Sending…" ghost. */
  const [pendingSendCount, setPendingSendCount] = useState(0);
  /** Message ids sent with after-turn intent (drives the outbox lane cue). */
  const [afterTurnMessageIds, setAfterTurnMessageIds] = useState<Set<string>>(new Set());
  /** Message ids whose send failed (shown as "Failed — tap to retry"). */
  const [failedSendMessageIds, setFailedSendMessageIds] = useState<Set<string>>(new Set());
  /** Transient flush narration for the inline pill + aria-live. */
  const [flushNarration, setFlushNarration] = useState<
    { text: string; remaining: number } | undefined
  >(undefined);
  /** Short reversible undo window after a retract/cancel. */
  const [undoableAction, setUndoableAction] = useState<
    { kind: "retract" | "cancel"; messageIds: string[]; expiresAt: number } | undefined
  >(undefined);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Retained text of retracted messages so undo can re-send them. */
  const retractedTextRef = useRef<Map<string, string>>(new Map());

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
    hasOpenTurn,
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

  // Prune the after-turn id set as messages leave the queue (read / retracted /
  // gone) so it can't grow unbounded and leave stale palette state. See
  // pruneAfterTurnIds.
  useEffect(() => {
    setAfterTurnMessageIds((prev) => pruneAfterTurnIds(prev, messages, selfId));
  }, [messages, selfId]);

  // Stable access to the latest messages inside callbacks (edit/cancel/flush).
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;

  // --- agentBusy: OR every busy signal so interrupt/steer affordances stay
  //     enabled across the whole turn (a single signal flickers mid-turn). ---
  const agentBusy = useMemo(() => {
    return (
      messages.some((m) => m.contentType === "typing") ||
      Object.values(participants).some(
        (p) => (p.metadata as { typing?: boolean })?.typing === true
      ) ||
      hasOpenTurn
    );
  }, [messages, participants, hasOpenTurn]);

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
      options?: { mentions?: string[]; replyTo?: string; metadata?: Record<string, unknown> }
    ): Promise<void> => {
      const currentInput = inputRef.current;
      const hasText = currentInput.trim().length > 0;
      const hasAttachments = attachments && attachments.length > 0;
      if ((!hasText && !hasAttachments) || !clientRef.current) return;
      const text = currentInput.trim();
      const previousReplyTo = options?.replyTo ?? null;
      const isAfterTurn = options?.metadata?.["deliverAfterTurn"] === true;
      setInput("");
      inputRef.current = "";
      setReplyTo(null);
      void stopTyping().catch((err) => {
        console.warn("[useChatCore] Failed to stop typing before send:", err);
      });
      // "Sending…" ghost: a transient local-only indicator while in flight.
      setPendingSendCount((n) => n + 1);
      let settledGhost = false;
      const settleGhost = () => {
        if (settledGhost) return;
        settledGhost = true;
        setPendingSendCount((n) => Math.max(0, n - 1));
      };
      try {
        const hadPriorTranscriptMessages = hasTranscriptMessagesRef.current;
        const { messageId, pubsubId } = await clientRef.current.send(text || "", {
          attachments: hasAttachments ? attachments : undefined,
          mentions: options?.mentions && options.mentions.length > 0 ? options.mentions : undefined,
          replyTo: options?.replyTo,
          metadata: options?.metadata,
        });
        // Tag after-turn sends so the outbox can render the "after this turn"
        // lane, and clear any prior failed flag for a retried id.
        if (messageId) {
          if (isAfterTurn) {
            setAfterTurnMessageIds((prev) => {
              const next = new Set(prev);
              next.add(messageId);
              return next;
            });
          }
          setFailedSendMessageIds((prev) => {
            if (!prev.has(messageId)) return prev;
            const next = new Set(prev);
            next.delete(messageId);
            return next;
          });
        }
        settleGhost();
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
        settleGhost();
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

  // --- Pause all busy agents (optionally requesting an incremental flush) ---
  const pauseBusyAgents = useCallback(async (flushDeferred = false): Promise<number> => {
    const c = clientRef.current;
    if (!c) return 0;
    const roster = participantsRef.current;
    const agentIds = Object.entries(roster)
      .filter(([, p]) => isAgentParticipantType(p.metadata.type))
      .map(([id]) => id);
    let paused = 0;
    await Promise.all(
      agentIds.map(async (id) => {
        try {
          await c.callMethod(id, "pause", {
            reason: flushDeferred ? "User requested send now" : "User interrupted execution",
            ...(flushDeferred ? { flushDeferred: true } : {}),
          });
          paused += 1;
        } catch (err) {
          console.warn("[Chat] Pause agent failed:", err);
        }
      })
    );
    return paused;
  }, []);

  // --- Edit a still-unread outbox message (rebuild text + attachment blocks
  //     so images survive a text-only edit) ---
  const editPendingMessage = useCallback(
    async (messageId: string, newText: string): Promise<void> => {
      const c = clientRef.current;
      if (!c) return;
      const msg = messagesRef.current.find((m) => m.id === messageId);
      const attachments = msg?.attachments ?? [];
      const blocks: MessageBlockInput[] = [
        { blockId: `${messageId}:block:0` as never, type: "text", content: newText },
        ...attachments.map((attachment, index) => ({
          blockId: `${messageId}:block:${index + 1}` as never,
          type: "attachment" as const,
          metadata: {
            mimeType: attachment.mimeType,
            filename: attachment.name,
          },
        })),
      ];
      try {
        const { pubsubId } = await c.editMessage(messageId, blocks, {
          revision: msg?.revision,
        });
        await backfillAfterLocalPublish(pubsubId);
      } catch (err) {
        console.warn("[Chat] Edit message failed:", err);
        throw err;
      }
    },
    [backfillAfterLocalPublish]
  );

  // --- Cancel (retract) a still-unread outbox message + raise an Undo window ---
  const cancelPendingMessage = useCallback(
    async (messageId: string): Promise<void> => {
      const c = clientRef.current;
      if (!c) return;
      const msg = messagesRef.current.find((m) => m.id === messageId);
      if (msg) retractedTextRef.current.set(messageId, msg.content);
      try {
        const { pubsubId } = await c.retractMessage(messageId, {
          reason: "Canceled by author",
        });
        await backfillAfterLocalPublish(pubsubId);
      } catch (err) {
        console.warn("[Chat] Retract message failed:", err);
        throw err;
      }
      // Short reversible-until-committed undo window. Consecutive cancels within
      // the window accumulate into ONE undoable action so a bulk "cancel queued"
      // is restored by a single Undo (the retained text for each id is kept).
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      setUndoableAction((current) =>
        current && current.kind === "cancel"
          ? { kind: "cancel", messageIds: [...current.messageIds, messageId], expiresAt: Date.now() + 5000 }
          : { kind: "cancel", messageIds: [messageId], expiresAt: Date.now() + 5000 }
      );
      undoTimerRef.current = setTimeout(() => {
        setUndoableAction((current) => {
          if (current) for (const id of current.messageIds) retractedTextRef.current.delete(id);
          return undefined;
        });
      }, 5000);
    },
    [backfillAfterLocalPublish]
  );

  // --- Undo the last retract/cancel by re-sending every retained text ---
  const undoLastAction = useCallback(() => {
    setUndoableAction((current) => {
      if (!current) return undefined;
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      for (const id of current.messageIds) {
        const text = retractedTextRef.current.get(id);
        retractedTextRef.current.delete(id);
        if (text && clientRef.current) {
          void clientRef.current
            .send(text, {})
            .then(({ pubsubId }) => backfillAfterLocalPublish(pubsubId))
            .catch((err) => console.warn("[Chat] Undo re-send failed:", err));
        }
      }
      return undefined;
    });
  }, [backfillAfterLocalPublish]);

  // --- Flush: pause busy agents with flushDeferred and narrate the outcome ---
  const flushOutboxAndInterrupt = useCallback(async (): Promise<void> => {
    const outboxCount = messagesRef.current.filter(
      (m) =>
        m.senderId === selfIdRef.current &&
        (m.kind ?? "message") === "message" &&
        !m.error &&
        !m.retracted &&
        (m.receipts?.aggregate ?? "pending") === "pending"
    ).length;
    const paused = await pauseBusyAgents(true);
    // The loop decides steers-vs-deferred; the client narrates from what it can
    // see locally. One flush advances the pipeline by one step.
    const remaining = Math.max(0, outboxCount - 1);
    const text =
      paused === 0 && outboxCount === 0
        ? "Nothing to flush"
        : remaining > 0
          ? `Sent 1 of ${outboxCount} queued · ${remaining} waiting`
          : outboxCount > 0
            ? "Steers delivered — press again to send your next queued message."
            : "Interrupted";
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    setFlushNarration({ text, remaining });
    flushTimerRef.current = setTimeout(() => setFlushNarration(undefined), 4000);
  }, [pauseBusyAgents]);

  // --- Retry a failed send by re-sending the retained draft ---
  const retrySend = useCallback(
    (messageId: string) => {
      const text = retractedTextRef.current.get(messageId);
      const c = clientRef.current;
      if (!text || !c) return;
      void c
        .send(text, {})
        .then(({ pubsubId }) => backfillAfterLocalPublish(pubsubId))
        .catch((err) => console.warn("[Chat] Retry send failed:", err));
    },
    [backfillAfterLocalPublish]
  );

  // --- primaryActionIntent: what pressing Enter does right now ---
  const primaryActionIntent: "send" | "steer" | "queue" = agentBusy ? "steer" : "send";

  // Clear undo / flush timers on unmount.
  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, []);

  const handleCancelInvocation = useCallback(
    async (invocation: InvocationCardPayload, senderId: string) => {
      const c = clientRef.current;
      if (!c) return;
      // An `eval` runs SERVER-SIDE in the owning agent's per-channel EvalDO, not
      // in this panel — there is no transportCallId to abort locally and no
      // pending_calls row for the channel to cancel. The run is keyed by the
      // invocation's own id (invocationId === runId), owned by the agent that
      // emitted it (senderId). Route the cancel THROUGH that agent: it calls
      // eval.cancel for itself, so the eval service resolves the owner from the
      // agent caller (the panel can't address another owner's EvalDO).
      if (invocation.name === "eval") {
        try {
          const handle = c.callMethod(senderId, "cancelEval", { runId: invocation.id });
          await (handle as { result?: Promise<unknown> }).result;
        } catch (err) {
          console.warn("[Chat] Cancel eval failed:", err);
        }
        return;
      }
      const transportCallId = invocation.transportCallId;
      if (!transportCallId) return;
      // Stop a method this panel is executing (e.g. a panel-local tool) immediately
      // and in-process by firing its local AbortController. The executing method's
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
    },
    []
  );

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
    agentBusy,
    hasOpenTurn,
    primaryActionIntent,
    pendingSendCount,
    afterTurnMessageIds,
    failedSendMessageIds,
    flushNarration,
    undoableAction,
    editPendingMessage,
    cancelPendingMessage,
    flushOutboxAndInterrupt,
    undoLastAction,
    retrySend,
    inputContextValue,
  };
}
