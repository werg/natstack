/**
 * useChatCore — Channel-message-driven chat hook.
 *
 * The agent worker publishes Pi events as real channel messages. This hook:
 * - Owns the PubSubClient connection lifecycle
 * - Subscribes to ALL channel messages (persisted + replay) via useChannelMessages
 * - Builds a flat `ChatMessage[]` from channel messages
 * - Dispatches protocol events (method calls, debug, roster) from ConnectionManager
 * - Tracks method history with console/progress streaming
 * - Tracks participants (current + historical) and generates disconnect notifications
 *
 * Messages stream via the PubSub send → update → complete protocol.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import type {
  PubSubClient,
  ChannelConfig,
  AttachmentInput,
  Participant,
  AgentDebugPayload,
  IncomingMethodResult,
  IncomingEvent,
  MethodDefinition,
} from "@natstack/pubsub";
import { isAgentParticipantType } from "@natstack/pubsub";
import {
  ConnectionManager,
  type ConnectionConfig,
  type ChatParticipantMetadata,
  type ChatMessage,
  type MethodHistoryEntry,
  type PendingAgent,
  type DirtyRepoDetails,
  type DisconnectedAgentInfo,
} from "@workspace/agentic-core";
import { cleanupPendingImages, type PendingImage } from "../../utils/imageUtils";
import type { ChatInputContextValue } from "../../types";
import { useChannelMessages } from "../useChannelMessages.js";

/** Pending agent timeout per handle. */
const PENDING_AGENT_TIMEOUT_MS = 45_000;

/** Maximum debug events to retain (ring buffer). */
const MAX_DEBUG_EVENTS = 500;

/** Maximum method history entries before pruning. */
const METHOD_HISTORY_MAX = 2000;
const METHOD_HISTORY_PRUNE_TO = 1400;

/** Typing indicator auto-stop debounce (ms). */
const TYPING_DEBOUNCE_MS = 3000;

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
  /** Last connection-layer error (subscribe failure, event-stream rejection).
   *  Surfaced via `ConnectionManager.onError`. Cleared by `dismissConnectionError`. */
  connectionError: { message: string; at: number } | null;
  dismissConnectionError: () => void;
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

  // Agent state
  debugEvents: Array<AgentDebugPayload & { ts: number }>;
  dirtyRepoWarnings: Map<string, DirtyRepoDetails>;
  pendingAgents: Map<string, PendingAgent>;
  addPendingAgent: (handle: string, agentId: string) => void;
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
  const allParticipantsRef = useRef<Record<string, Participant<ChatParticipantMetadata>>>({});
  const inputRef = useRef("");

  // Suppress disconnect detection until we see ourselves in the roster
  // (avoids spurious disconnects during initial handshake).
  const suppressDisconnectRef = useRef(true);
  // Track expected stops (idle/timeout) so we don't show "disconnected" for them.
  const expectedStopsRef = useRef(new Set<string>());
  // Per-handle pending agent timeout timers.
  const pendingTimeoutsRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Typing indicator state (metadata-based).
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          // --- Method call tracking ---
          if (event.type === "method-call") {
            const e = event as { callId: string; methodName: string; senderId: string; providerId?: string; args?: unknown; ts: number };
            // Look up method description from roster's advertised methods.
            let description: string | undefined;
            const provider = allParticipantsRef.current[e.providerId ?? e.senderId];
            if (provider?.metadata) {
              const methods = (provider.metadata as Record<string, unknown>)["methods"];
              if (Array.isArray(methods)) {
                const m = methods.find((m: unknown) => (m as { name?: string })?.name === e.methodName);
                if (m) description = (m as { description?: string }).description;
              }
            }
            const isLocal = (e.providerId ?? e.senderId) === selfIdRef.current;
            setMethodEntries((prev) => {
              const next = new Map(prev);
              next.set(e.callId, {
                callId: e.callId,
                methodName: e.methodName,
                description,
                args: e.args,
                status: "pending",
                startedAt: e.ts,
                providerId: e.providerId ?? e.senderId,
                callerId: e.senderId,
                handledLocally: isLocal,
              });
              // Auto-prune if over limit
              if (next.size > METHOD_HISTORY_MAX) {
                const entries = [...next.entries()];
                const completed = entries.filter(([, v]) => v.status !== "pending");
                if (completed.length > 0) {
                  const toRemove = completed.slice(0, next.size - METHOD_HISTORY_PRUNE_TO);
                  for (const [k] of toRemove) next.delete(k);
                }
              }
              return next;
            });
          }

          // --- Method result tracking (with console/progress streaming) ---
          if (event.type === "method-result") {
            const e = event as IncomingMethodResult;
            setMethodEntries((prev) => {
              const existing = prev.get(e.callId);
              if (!existing) return prev;
              const next = new Map(prev);

              // Progress update
              if ((e as { progress?: number }).progress !== undefined) {
                next.set(e.callId, { ...existing, progress: (e as { progress?: number }).progress });
              }

              // Console chunk (type: "console" content)
              const content = e.content as Record<string, unknown> | undefined;
              const isConsoleChunk = !!content && content["type"] === "console" && typeof content["content"] === "string";
              if (isConsoleChunk) {
                const line = content["content"] as string;
                const consoleOutput = existing.consoleOutput ? `${existing.consoleOutput}\n${line}` : line;
                next.set(e.callId, { ...existing, consoleOutput });
                return next;
              }

              // Final completion
              if (e.complete) {
                if (e.isError) {
                  let errorMessage = "Method execution failed";
                  if (typeof e.content === "string") errorMessage = e.content;
                  else if (content && typeof content["error"] === "string") errorMessage = content["error"] as string;
                  next.set(e.callId, { ...existing, status: "error", error: errorMessage, completedAt: Date.now() });
                } else {
                  next.set(e.callId, { ...existing, status: "success", result: e.content, completedAt: Date.now() });
                }
              }
              return next;
            });
          }

          // --- Agent debug events (ephemeral) ---
          if (event.type === "agent-debug") {
            const payload = (event as { payload: AgentDebugPayload }).payload;
            const ts = (event as { ts: number }).ts ?? Date.now();
            setDebugEvents((prev) => {
              const next = [...prev, { ...payload, ts }];
              return next.length > MAX_DEBUG_EVENTS ? next.slice(-MAX_DEBUG_EVENTS) : next;
            });

            // Dirty repo warnings
            if (payload.debugType === "lifecycle" && payload.event === "warning" && payload.reason === "dirty-repo") {
              const details = payload.details as DirtyRepoDetails | undefined;
              if (details) {
                setDirtyRepoWarnings((prev) => { const n = new Map(prev); n.set(payload.handle, details); return n; });
              }
            }

            // Track expected stops (idle/timeout) so roster handler can suppress disconnect message
            if (payload.debugType === "lifecycle" && payload.event === "stopped" &&
                (payload.reason === "idle" || payload.reason === "timeout")) {
              expectedStopsRef.current.add(payload.handle);
            }

            // Spawn errors → update pending agent status
            if (payload.debugType === "spawn-error") {
              setPendingAgents((prev) => {
                const existing = prev.get(payload.handle);
                if (!existing) return prev;
                const n = new Map(prev);
                n.set(payload.handle, {
                  ...existing, status: "error",
                  error: { message: payload.error ?? "Agent failed to start", details: payload.buildError ? JSON.stringify(payload.buildError) : undefined },
                });
                return n;
              });
            }

            // Spawning lifecycle → auto-create pending agent
            if (payload.debugType === "lifecycle" && payload.event === "spawning") {
              setPendingAgents((prev) => {
                if (prev.has(payload.handle)) return prev;
                const n = new Map(prev);
                n.set(payload.handle, { agentId: payload.agentId, status: "starting" });
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
  const [connectionError, setConnectionError] = useState<{ message: string; at: number } | null>(null);
  const dismissConnectionError = useCallback(() => setConnectionError(null), []);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [participants, setParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});
  const [methodEntries, setMethodEntries] = useState<Map<string, MethodHistoryEntry>>(new Map());
  const [debugEvents, setDebugEvents] = useState<Array<AgentDebugPayload & { ts: number }>>([]);
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
    return () => {
      cleanupPendingImages(pendingImagesRef.current);
      // Clear pending agent timeouts
      for (const t of pendingTimeoutsRef.current.values()) clearTimeout(t);
      pendingTimeoutsRef.current.clear();
      // Clear typing timeout
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };
  }, []);

  // --- Channel messages subscription ---
  const {
    messages: channelMessages,
    hasMoreHistory: channelHasMore,
    loadingMore: channelLoadingMore,
    loadEarlierMessages: channelLoadEarlier,
  } = useChannelMessages(client);

  // --- Optimistic local messages (shown immediately on send, reconciled on server echo) ---
  const [optimisticMessages, setOptimisticMessages] = useState<ChatMessage[]>([]);

  // --- Disconnect system messages (injected from roster changes) ---
  const [disconnectMessages, setDisconnectMessages] = useState<ChatMessage[]>([]);

  // Merge: channel messages + optimistic (filtered to remove echoed ones) + disconnect system messages.
  const messages = useMemo(() => {
    const channelIds = new Set(channelMessages.map((m) => m.id));
    const pendingOptimistic = optimisticMessages.filter((m) => !channelIds.has(m.id));
    return [...channelMessages, ...pendingOptimistic, ...disconnectMessages];
  }, [channelMessages, optimisticMessages, disconnectMessages]);

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
      const resolvedSelfId = newClient.clientId ?? config.clientId;
      selfIdRef.current = resolvedSelfId;
      setSelfId(resolvedSelfId);
      hasConnectedRef.current = true;

      // Channel title from config
      const initialTitle = newClient.channelConfig?.title;
      if (initialTitle) document.title = initialTitle;
      newClient.onConfigChange((cfg: ChannelConfig) => {
        if (cfg.title) document.title = cfg.title;
      });

      // Roster subscription
      newClient.onRoster?.((update) => {
        const prev = participantsRef.current;
        const next = { ...update.participants };
        participantsRef.current = next;
        setParticipants(next);

        // Unsuppress disconnect detection once we see ourselves in the roster
        if (suppressDisconnectRef.current && (config.clientId in next)) {
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

            // Skip expected leaves (graceful, replaced) and expected stops (idle, timeout)
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
              return [...msgs, {
                id: `system-disconnect-${pid}-${Date.now()}`,
                senderId: "system",
                content: "",
                kind: "system",
                complete: true,
                disconnectedAgent: info,
                senderMetadata: { name: info.name, type: info.type, handle: info.handle },
              }];
            });
          }
        }

        // Clear disconnect messages when an agent with the same handle reconnects
        const agentHandles = new Set(
          Object.values(next)
            .filter((p) => isAgentParticipantType(p.metadata.type))
            .map((p) => p.metadata.handle),
        );
        setDisconnectMessages((msgs) => {
          const filtered = msgs.filter((m) => !m.disconnectedAgent || !agentHandles.has(m.disconnectedAgent.handle));
          return filtered.length === msgs.length ? msgs : filtered;
        });

        // Auto-clear pending agents whose handle is now in the roster
        setPendingAgents((prevPending) => {
          if (prevPending.size === 0) return prevPending;
          let changed = false;
          const nextPending = new Map(prevPending);
          for (const handle of prevPending.keys()) {
            if (agentHandles.has(handle) || Object.values(next).some((p) => (p?.metadata?.handle as string | undefined) === handle)) {
              nextPending.delete(handle);
              changed = true;
            }
          }
          if (changed) schedulePendingTimeouts(nextPending);
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
          if (Object.values(initialRoster).some((p) => (p?.metadata?.handle as string | undefined) === handle)) {
            nextPending.delete(handle);
            changed = true;
          }
        }
        return changed ? nextPending : prevPending;
      });

      return newClient;
    },
    [connection, config.clientId],
  );

  // --- Dispose connection on unmount ---
  useEffect(() => {
    return () => {
      try { connection.disconnect(); } catch { /* best-effort */ }
    };
  }, [connection]);

  // --- Pending agent per-handle timeouts ---
  const schedulePendingTimeouts = useCallback((agents: Map<string, PendingAgent>) => {
    // Schedule timeouts for new "starting" agents
    for (const [handle, agent] of agents) {
      if (agent.status === "starting" && !pendingTimeoutsRef.current.has(handle)) {
        const timer = setTimeout(() => {
          pendingTimeoutsRef.current.delete(handle);
          setPendingAgents((prev) => {
            const existing = prev.get(handle);
            if (existing?.status !== "starting") return prev;
            const n = new Map(prev);
            n.set(handle, { ...existing, status: "error", error: { message: "Agent failed to start (timeout)" } });
            return n;
          });
        }, PENDING_AGENT_TIMEOUT_MS);
        pendingTimeoutsRef.current.set(handle, timer);
      }
    }
    // Clear timeouts for agents no longer pending
    for (const [handle, timer] of pendingTimeoutsRef.current) {
      if (!agents.has(handle)) {
        clearTimeout(timer);
        pendingTimeoutsRef.current.delete(handle);
      }
    }
  }, []);

  // Schedule timeouts when pendingAgents changes
  useEffect(() => {
    schedulePendingTimeouts(pendingAgents);
  }, [pendingAgents, schedulePendingTimeouts]);

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

  // --- Typing indicators (ephemeral, roster-based) ---
  const typingActiveRef = useRef(false);

  const stopTyping = useCallback(async () => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    if (!typingActiveRef.current) return;
    typingActiveRef.current = false;
    const c = clientRef.current;
    if (c?.connected) {
      try { await c.setTyping(false); } catch { /* best-effort */ }
    }
  }, []);

  const startTyping = useCallback(async () => {
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    if (!typingActiveRef.current) {
      typingActiveRef.current = true;
      const c = clientRef.current;
      if (c?.connected) {
        try { await c.setTyping(true); } catch { /* best-effort */ }
      }
    }
    typingTimeoutRef.current = setTimeout(() => {
      void stopTyping().catch(() => {});
    }, TYPING_DEBOUNCE_MS);
  }, [stopTyping]);

  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    inputRef.current = value;
    if (value.trim()) {
      void startTyping().catch(() => {});
    } else {
      void stopTyping().catch(() => {});
    }
  }, [startTyping, stopTyping]);

  // --- Send message (with optimistic local rendering) ---
  const sendMessage = useCallback(async (attachments?: AttachmentInput[]): Promise<void> => {
    const currentInput = inputRef.current;
    const hasText = currentInput.trim().length > 0;
    const hasAttachments = attachments && attachments.length > 0;
    if ((!hasText && !hasAttachments) || !clientRef.current) return;
    const text = currentInput.trim();
    setInput("");
    inputRef.current = "";
    void stopTyping().catch(() => {});
    try {
      const { messageId } = await clientRef.current.send(text || "", {
        attachments: hasAttachments ? attachments : undefined,
      });
      // Insert optimistic local message (include attachments for image-only sends)
      const selfId = selfIdRef.current ?? config.clientId;
      const optimisticAttachments = hasAttachments
        ? attachments!.map((a) => ({ id: crypto.randomUUID(), ...a }))
        : undefined;
      setOptimisticMessages((prev) => {
        if (prev.some((m) => m.id === messageId)) return prev;
        return [...prev, {
          id: messageId,
          senderId: selfId,
          content: text,
          kind: "message",
          complete: true,
          pending: true,
          attachments: optimisticAttachments as ChatMessage["attachments"],
          senderMetadata: { name: metadata.name, type: metadata.type, handle: metadata.handle },
        }];
      });
    } catch (err) {
      setInput(text);
      inputRef.current = text;
      console.error("[Chat] Send failed, draft restored:", err);
      throw err;
    }
  }, [config.clientId, metadata, stopTyping]);

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
          (p) => p.metadata.handle === agentHandle && isAgentParticipantType(p.metadata.type),
        );
        if (byHandle) targetId = Object.keys(roster).find((k) => roster[k] === byHandle) ?? agentId;
      } else if (!roster[agentId]) {
        const byHandle = Object.values(roster).find(
          (p) => p.metadata.handle === agentId && isAgentParticipantType(p.metadata.type),
        );
        if (byHandle) targetId = Object.keys(roster).find((k) => roster[k] === byHandle) ?? agentId;
      }
      try {
        await c.callMethod(targetId, "pause", { reason: "User interrupted execution" });
      } catch (err) {
        console.warn("[Chat] Interrupt failed:", err);
      }
    },
    [],
  );

  const handleCallMethod = useCallback(
    (providerId: string, methodName: string, args: unknown) => {
      const c = clientRef.current;
      if (!c) return;
      const handle = c.callMethod(providerId, methodName, args);
      void (handle as { result?: Promise<unknown> }).result?.catch((error: unknown) => {
        console.error(`Failed to call method ${methodName} on ${providerId}:`, error);
      });
    },
    [],
  );

  const addPendingAgent = useCallback((handle: string, agentId: string) => {
    setPendingAgents((prev) => {
      const next = new Map(prev);
      next.set(handle, { agentId, status: "starting" });
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
    connectionError,
    dismissConnectionError,
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
