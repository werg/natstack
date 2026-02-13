/**
 * useAgenticChat — Main orchestration hook for agentic chat.
 *
 * Extracts all state management from the original panels/chat/index.tsx.
 * Returns a ChatContextValue-compatible object that can be passed to ChatProvider.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { CONTENT_TYPE_TYPING, CONTENT_TYPE_INLINE_UI } from "@natstack/agentic-messaging/utils";
import type {
  IncomingEvent,
  IncomingMethodResult,
  IncomingToolRoleRequestEvent,
  IncomingToolRoleResponseEvent,
  IncomingToolRoleHandoffEvent,
  AggregatedEvent,
  AgentDebugPayload,
  MethodDefinition,
  MethodExecutionContext,
  TypingData,
  FeedbackFormArgs,
  FeedbackCustomArgs,
  ChannelConfig,
} from "@natstack/agentic-messaging";
import {
  FeedbackFormArgsSchema,
  FeedbackCustomArgsSchema,
} from "@natstack/agentic-messaging/protocol-schemas";
import type { Participant, RosterUpdate, AttachmentInput } from "@natstack/pubsub";
import {
  useFeedbackManager,
  useToolApproval,
  wrapMethodsWithApproval,
  compileFeedbackComponent,
  cleanupFeedbackComponent,
  compileInlineUiComponent,
  cleanupInlineUiComponent,
  type FeedbackResult,
  type FeedbackUiToolArgs,
  type ActiveFeedbackTsx,
  type ActiveFeedbackSchema,
} from "@natstack/tool-ui";
import { useChannelConnection } from "./useChannelConnection";
import { useMethodHistory } from "./useMethodHistory";
import { useToolRole } from "./useToolRole";
import { dispatchAgenticEvent, aggregatedToChatMessage, type DirtyRepoDetails, type EventMiddleware } from "./useAgentEvents";
import { cleanupPendingImages, type PendingImage } from "../utils/imageUtils";
import { parseInlineUiData } from "../components/InlineUiMessage";
import type { MethodHistoryEntry } from "../components/MethodHistoryItem";
import type {
  ChatMessage,
  ChatParticipantMetadata,
  DisconnectedAgentInfo,
  PendingAgent,
  ConnectionConfig,
  AgenticChatActions,
  ToolProvider,
  ChatContextValue,
  InlineUiComponentEntry,
} from "../types";

/** Pending agent info passed from launcher */
interface PendingAgentInfo {
  agentId: string;
  handle: string;
}

export interface UseAgenticChatOptions {
  /** Connection configuration (server URL, token, client ID) */
  config: ConnectionConfig;
  /** Channel name to connect to */
  channelName: string;
  /** Channel configuration (working directory, restricted mode, etc.) */
  channelConfig?: ChannelConfig;
  /** Context ID for channel authorization */
  contextId?: string;
  /** Participant metadata for this client */
  metadata?: ChatParticipantMetadata;
  /** Tool provider factory — receives deps, returns method definitions */
  tools?: ToolProvider;
  /** Platform-specific actions */
  actions?: AgenticChatActions;
  /** Theme for the chat UI */
  theme?: "light" | "dark";
  /** Agents that are being spawned */
  pendingAgentInfos?: PendingAgentInfo[];
  /** Optional event middleware for custom event handling */
  eventMiddleware?: EventMiddleware[];
}

export function useAgenticChat({
  config,
  channelName,
  channelConfig,
  contextId,
  metadata = { name: "Chat Panel", type: "panel", handle: "user" },
  tools,
  actions,
  theme = "dark",
  pendingAgentInfos,
  eventMiddleware,
}: UseAgenticChatOptions): ChatContextValue & { toolRole: ReturnType<typeof useToolRole> } {
  const selfIdRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);
  const participantsRef = useRef<Record<string, Participant<ChatParticipantMetadata>>>({});
  const prevParticipantsRef = useRef<Record<string, Participant<ChatParticipantMetadata>>>({});
  const suppressDisconnectRef = useRef(true);
  const toolRoleHandlerRef = useRef<((event: IncomingToolRoleRequestEvent) => void) | null>(null);
  const toolRoleResponseHandlerRef = useRef<((event: IncomingToolRoleResponseEvent) => void) | null>(null);
  const toolRoleHandoffHandlerRef = useRef<((event: IncomingToolRoleHandoffEvent) => void) | null>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [status, setStatus] = useState("Connecting...");
  const [participants, setParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});
  const [historicalParticipants, setHistoricalParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});
  const [debugEvents, setDebugEvents] = useState<Array<AgentDebugPayload & { ts: number }>>([]);
  const [debugConsoleAgent, setDebugConsoleAgent] = useState<string | null>(null);
  const [dirtyRepoWarnings, setDirtyRepoWarnings] = useState<Map<string, DirtyRepoDetails>>(new Map());

  const [pendingAgents, setPendingAgents] = useState<Map<string, PendingAgent>>(() => {
    const initial = new Map<string, PendingAgent>();
    if (pendingAgentInfos) {
      for (const agent of pendingAgentInfos) {
        initial.set(agent.handle, { agentId: agent.agentId, status: "starting" });
      }
    }
    return initial;
  });

  // Pending agent timeout handling
  const PENDING_TIMEOUT_MS = 45_000;
  const pendingTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timeouts = pendingTimeoutsRef.current;
    for (const [handle, agent] of pendingAgents) {
      if (agent.status === "starting" && !timeouts.has(handle)) {
        const timeout = setTimeout(() => {
          setPendingAgents(prev => {
            const next = new Map(prev);
            const existing = next.get(handle);
            if (existing?.status === "starting") {
              next.set(handle, {
                ...existing,
                status: "error",
                error: { message: "Agent failed to start (timeout)" },
              });
            }
            return next;
          });
          timeouts.delete(handle);
        }, PENDING_TIMEOUT_MS);
        timeouts.set(handle, timeout);
      }
    }
    for (const [handle, timeout] of timeouts) {
      if (!pendingAgents.has(handle)) {
        clearTimeout(timeout);
        timeouts.delete(handle);
      }
    }
  }, [pendingAgents]);

  useEffect(() => {
    return () => {
      for (const timeout of pendingTimeoutsRef.current.values()) {
        clearTimeout(timeout);
      }
    };
  }, []);

  // Inline UI components
  const [inlineUiComponents, setInlineUiComponents] = useState<Map<string, InlineUiComponentEntry>>(new Map());

  useEffect(() => {
    const compileInlineUiMessages = async () => {
      for (const msg of messages) {
        if (msg.contentType !== CONTENT_TYPE_INLINE_UI) continue;
        const data = parseInlineUiData(msg.content);
        if (!data) continue;
        if (inlineUiComponents.has(data.id)) continue;

        try {
          const result = await compileInlineUiComponent({ code: data.code });
          if (result.success) {
            setInlineUiComponents(prev => {
              const updated = new Map(prev);
              updated.set(data.id, { Component: result.Component!, cacheKey: result.cacheKey! });
              return updated;
            });
          } else {
            setInlineUiComponents(prev => {
              const updated = new Map(prev);
              updated.set(data.id, { cacheKey: data.code, error: result.error });
              return updated;
            });
          }
        } catch (err) {
          setInlineUiComponents(prev => {
            const updated = new Map(prev);
            updated.set(data.id, { cacheKey: data.code, error: err instanceof Error ? err.message : String(err) });
            return updated;
          });
        }
      }
    };
    void compileInlineUiMessages();
  }, [messages, inlineUiComponents]);

  // Memory management
  const MAX_VISIBLE_MESSAGES = 500;
  const TRIM_THRESHOLD = MAX_VISIBLE_MESSAGES * 2;
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [oldestLoadedId, setOldestLoadedId] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (messages.length > TRIM_THRESHOLD) {
      let referencedUiIds: Set<string> | undefined;
      setMessages((prev) => {
        const trimmed = prev.slice(-MAX_VISIBLE_MESSAGES);
        referencedUiIds = new Set<string>();
        for (const msg of trimmed) {
          if (msg.contentType === CONTENT_TYPE_INLINE_UI) {
            const data = parseInlineUiData(msg.content);
            if (data) referencedUiIds!.add(data.id);
          }
        }
        const firstMsg = trimmed[0];
        if (firstMsg?.pubsubId) {
          setOldestLoadedId(firstMsg.pubsubId);
          setHasMoreHistory(true);
        }
        return trimmed;
      });
      if (referencedUiIds) {
        const ids = referencedUiIds;
        setInlineUiComponents(prevComponents => {
          const next = new Map(prevComponents);
          let removedCount = 0;
          for (const [id, component] of prevComponents) {
            if (!ids.has(id)) {
              if (component.Component && component.cacheKey) {
                cleanupInlineUiComponent(component.cacheKey);
              }
              next.delete(id);
              removedCount++;
            }
          }
          return removedCount > 0 ? next : prevComponents;
        });
      }
    }
  }, [messages.length]);

  // Cleanup pending images on unmount
  const pendingImagesRef = useRef(pendingImages);
  pendingImagesRef.current = pendingImages;
  useEffect(() => {
    return () => { cleanupPendingImages(pendingImagesRef.current); };
  }, []);

  // Combine historical + current participants
  const allParticipants = useMemo(() => {
    return { ...historicalParticipants, ...participants };
  }, [historicalParticipants, participants]);
  participantsRef.current = allParticipants;

  const handleDismissDirtyWarning = useCallback((agentName: string) => {
    setDirtyRepoWarnings((prev) => {
      const next = new Map(prev);
      next.delete(agentName);
      return next;
    });
  }, []);

  // Feedback manager
  const { activeFeedbacks, addFeedback, removeFeedback, dismissFeedback, handleFeedbackError } = useFeedbackManager();

  const { methodEntries, addMethodHistoryEntry, updateMethodHistoryEntry, handleMethodResult, clearMethodHistory } =
    useMethodHistory({ setMessages, clientId: config.clientId });

  // Channel connection
  const { clientRef, connected, clientId, connect: connectToChannel } = useChannelConnection({
    config,
    metadata,
    toolRoles: {
      "file-ops": { providing: true },
      "git-ops": { providing: true },
      "workspace-ops": { providing: true },
    },
    onEvent: useCallback(
      (event: IncomingEvent) => {
        try {
          const selfId = selfIdRef.current ?? config.clientId;
          dispatchAgenticEvent(
            event,
            { setMessages, addMethodHistoryEntry, handleMethodResult, setDebugEvents, setDirtyRepoWarnings, setPendingAgents },
            selfId,
            participantsRef.current,
            eventMiddleware,
          );
          if (event.type === "tool-role-request") {
            try { toolRoleHandlerRef.current?.(event); } catch (err) { console.error("[Chat] Tool role request error:", err); }
          }
          if (event.type === "tool-role-response") {
            try { toolRoleResponseHandlerRef.current?.(event); } catch (err) { console.error("[Chat] Tool role response error:", err); }
          }
          if (event.type === "tool-role-handoff") {
            try { toolRoleHandoffHandlerRef.current?.(event); } catch (err) { console.error("[Chat] Tool role handoff error:", err); }
          }
        } catch (err) {
          console.error("[Chat] Event dispatch error:", err);
        }
      },
      [setMessages, addMethodHistoryEntry, handleMethodResult, config.clientId, eventMiddleware]
    ),
    onAggregatedEvent: useCallback((event: AggregatedEvent) => {
      switch (event.type) {
        case "message": {
          const chatMsg = aggregatedToChatMessage(event);
          setMessages(prev => {
            // Dedup by pubsubId
            if (chatMsg.pubsubId && prev.some(m => m.pubsubId === chatMsg.pubsubId)) return prev;
            // Dedup by UUID
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
      const newParticipants = roster.participants;
      const prevParts = prevParticipantsRef.current;

      if (suppressDisconnectRef.current && config.clientId in newParticipants) {
        suppressDisconnectRef.current = false;
      }

      setHistoricalParticipants((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [id, participant] of Object.entries(newParticipants)) {
          if (!(id in next)) { next[id] = participant; changed = true; }
        }
        return changed ? next : prev;
      });

      const prevIds = new Set(Object.keys(prevParts));
      const newIds = new Set(Object.keys(newParticipants));
      const disconnectedIds: string[] = [];

      if (!suppressDisconnectRef.current) {
        for (const prevId of prevIds) {
          if (!newIds.has(prevId)) {
            disconnectedIds.push(prevId);
            const disconnected = prevParts[prevId];
            const meta = disconnected?.metadata;
            if (meta && meta.type !== "panel") {
              const agentInfo: DisconnectedAgentInfo = {
                name: meta.name, handle: meta.handle, panelId: meta.panelId, agentTypeId: meta.agentTypeId, type: meta.type,
              };
              setMessages((prev) => [...prev, {
                id: `system-disconnect-${prevId}-${Date.now()}`, senderId: "system", content: "", kind: "system", complete: true, disconnectedAgent: agentInfo,
              }]);
            }
          }
        }
      }

      if (disconnectedIds.length > 0) {
        const disconnectedSet = new Set(disconnectedIds);
        setMessages((prev) => {
          let changed = false;
          const next = prev.map((msg) => {
            if (msg.contentType === "typing" && !msg.complete && disconnectedSet.has(msg.senderId)) { changed = true; return { ...msg, complete: true }; }
            return msg;
          });
          return changed ? next : prev;
        });
      }

      const newHandles = new Set(Object.values(newParticipants).map((p) => p.metadata.handle));
      setPendingAgents((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const handle of prev.keys()) {
          if (newHandles.has(handle)) { next.delete(handle); changed = true; }
        }
        return changed ? next : prev;
      });

      const reconnectingHandles = new Set<string>();
      for (const newId of newIds) {
        if (!prevIds.has(newId) && newParticipants[newId]?.metadata?.type !== "panel") {
          reconnectingHandles.add(newParticipants[newId].metadata.handle);
        }
      }

      if (reconnectingHandles.size > 0) {
        const staleSenderIds = new Set<string>();
        for (const [id, p] of Object.entries(prevParts)) {
          if (reconnectingHandles.has(p.metadata.handle) && !newIds.has(id)) { staleSenderIds.add(id); }
        }
        if (staleSenderIds.size > 0) {
          setMessages((prev) => {
            let changed = false;
            const next = prev.map((msg) => {
              if (msg.contentType === "typing" && !msg.complete && staleSenderIds.has(msg.senderId)) { changed = true; return { ...msg, complete: true }; }
              return msg;
            });
            return changed ? next : prev;
          });
        }
      }

      const agentHandles = new Set(Object.values(newParticipants).filter(p => p.metadata.type !== "panel").map(p => p.metadata.handle));
      setMessages((prev) => {
        const filtered = prev.filter(msg => {
          if (msg.kind !== "system" || !msg.disconnectedAgent) return true;
          return !agentHandles.has(msg.disconnectedAgent.handle);
        });
        return filtered.length === prev.length ? prev : filtered;
      });

      prevParticipantsRef.current = newParticipants;
      setParticipants(newParticipants);
    }, [config.clientId]),
    onReconnect: useCallback(() => {
      suppressDisconnectRef.current = true;
      prevParticipantsRef.current = {};
      setMessages((prev) => {
        const filtered = prev.filter(msg => msg.kind !== "system" || !msg.disconnectedAgent);
        return filtered.length === prev.length ? prev : filtered;
      });
    }, []),
    onError: useCallback((error: Error) => {
      console.error("[Chat] Connection error:", error);
      setStatus(`Error: ${error.message}`);
    }, []),
  });

  // Load earlier messages (using aggregated pagination)
  const loadEarlierMessages = useCallback(async () => {
    const client = clientRef.current;
    if (!client || loadingMore || !hasMoreHistory || !oldestLoadedId) return;
    setLoadingMore(true);
    try {
      let currentBeforeId = oldestLoadedId;
      let olderMessages: ChatMessage[] = [];
      let hasMore = true;

      // Loop to skip pages with only non-message events (method calls, presence, etc.)
      while (hasMore && olderMessages.length === 0) {
        const result = await client.getAggregatedMessagesBefore(currentBeforeId, 50);
        olderMessages = result.messages.map(aggregatedToChatMessage);
        hasMore = result.hasMore;

        // Always advance cursor via nextBeforeId (prevents livelock on empty pages)
        if (result.nextBeforeId !== undefined) {
          currentBeforeId = result.nextBeforeId;
        } else {
          hasMore = false;
          break;
        }
      }

      if (olderMessages.length > 0) {
        setMessages(prev => {
          const existingIds = new Set(
            prev.filter(m => m.pubsubId != null).map(m => m.pubsubId)
          );
          const deduped = olderMessages.filter(
            m => !m.pubsubId || !existingIds.has(m.pubsubId)
          );
          return [...deduped, ...prev];
        });
      }
      setOldestLoadedId(currentBeforeId);
      setHasMoreHistory(hasMore);
    } catch (err) {
      console.error("[Chat] Failed to load earlier messages:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [clientRef, oldestLoadedId, hasMoreHistory, loadingMore]);

  useEffect(() => { selfIdRef.current = clientId; }, [clientId]);

  // Channel title subscription
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !connected) return;
    const initialTitle = client.channelConfig?.title;
    if (initialTitle) document.title = initialTitle;
    const unsubscribe = client.onTitleChange((title) => { document.title = title; });
    return () => { unsubscribe(); };
  }, [connected, clientRef]);

  // Initialize pagination
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !connected || messages.length === 0) return;
    if (oldestLoadedId !== null) return;
    const firstMsgWithId = messages.find((m) => m.pubsubId !== undefined);
    if (firstMsgWithId?.pubsubId !== undefined) {
      setOldestLoadedId(firstMsgWithId.pubsubId);
      const serverChatCount = client.chatMessageCount;
      const dbMessageCount = messages.filter((m) => m.pubsubId !== undefined).length;
      if (serverChatCount !== undefined && serverChatCount > dbMessageCount) {
        setHasMoreHistory(true);
      }
    }
  }, [connected, messages.length, oldestLoadedId, clientRef]);

  // Typing indicators
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
    if (value.trim()) {
      void startTyping().catch((err) => console.error("[Chat] Start typing error:", err));
    } else {
      void stopTyping().catch((err) => console.error("[Chat] Stop typing error:", err));
    }
  }, [startTyping, stopTyping]);

  // Tool approval
  const approval = useToolApproval(clientRef.current, { addFeedback, removeFeedback });

  // Tool role
  const toolRole = useToolRole(clientRef.current, clientId);

  useEffect(() => {
    toolRoleHandlerRef.current = toolRole.handleToolRoleRequest;
    toolRoleResponseHandlerRef.current = toolRole.handleToolRoleResponse;
    toolRoleHandoffHandlerRef.current = toolRole.handleToolRoleHandoff;
  }, [toolRole.handleToolRoleRequest, toolRole.handleToolRoleResponse, toolRole.handleToolRoleHandoff]);

  // Feedback handlers
  const handleFeedbackResult = useCallback((callId: string, feedbackResult: FeedbackResult) => {
    if (feedbackResult.type === "submit") {
      updateMethodHistoryEntry(callId, { status: "success", result: feedbackResult.value, completedAt: Date.now() });
    } else if (feedbackResult.type === "cancel") {
      updateMethodHistoryEntry(callId, { status: "success", result: null, completedAt: Date.now() });
    } else {
      updateMethodHistoryEntry(callId, { status: "error", error: feedbackResult.message, completedAt: Date.now() });
    }
  }, [updateMethodHistoryEntry]);

  const handleFeedbackFormCall = useCallback(
    async (callId: string, args: FeedbackFormArgs, ctx: MethodExecutionContext) => {
      const entry: MethodHistoryEntry = {
        callId, methodName: "feedback_form", description: "Display a form to collect user input",
        args, status: "pending", startedAt: Date.now(), callerId: ctx.callerId, handledLocally: true,
      };
      addMethodHistoryEntry(entry);
      return new Promise<FeedbackResult>((resolve, reject) => {
        const feedback: ActiveFeedbackSchema = {
          type: "schema", callId, title: args.title, fields: args.fields, values: args.values ?? {},
          submitLabel: args.submitLabel, cancelLabel: args.cancelLabel,
          timeout: args.timeout, timeoutAction: args.timeoutAction, severity: args.severity,
          hideSubmit: args.hideSubmit, hideCancel: args.hideCancel, createdAt: Date.now(),
          complete: (feedbackResult: FeedbackResult) => {
            removeFeedback(callId); handleFeedbackResult(callId, feedbackResult); resolve(feedbackResult);
          },
        };
        addFeedback(feedback);
      });
    },
    [addFeedback, removeFeedback, addMethodHistoryEntry, handleFeedbackResult]
  );

  const handleFeedbackCustomCall = useCallback(
    async (callId: string, args: FeedbackCustomArgs, ctx: MethodExecutionContext) => {
      const entry: MethodHistoryEntry = {
        callId, methodName: "feedback_custom", description: "Display a custom React component for user interaction",
        args, status: "pending", startedAt: Date.now(), callerId: ctx.callerId, handledLocally: true,
      };
      addMethodHistoryEntry(entry);
      const result = await compileFeedbackComponent({ code: args.code } as FeedbackUiToolArgs);
      if (!result.success) {
        updateMethodHistoryEntry(callId, { status: "error", error: result.error, completedAt: Date.now() });
        throw new Error(result.error);
      }
      const cacheKey = result.cacheKey!;
      return new Promise<FeedbackResult>((resolve, reject) => {
        const feedback: ActiveFeedbackTsx = {
          type: "tsx", callId, Component: result.Component!, createdAt: Date.now(), cacheKey, title: args.title,
          complete: (feedbackResult: FeedbackResult) => {
            removeFeedback(callId); cleanupFeedbackComponent(cacheKey);
            handleFeedbackResult(callId, feedbackResult); resolve(feedbackResult);
          },
        };
        addFeedback(feedback);
      });
    },
    [addFeedback, removeFeedback, addMethodHistoryEntry, updateMethodHistoryEntry, handleFeedbackResult]
  );

  const handleFeedbackDismiss = useCallback((callId: string) => { dismissFeedback(callId); }, [dismissFeedback]);

  // Refs for stable callback access in connection effect
  const handleFeedbackFormCallRef = useRef(handleFeedbackFormCall);
  const handleFeedbackCustomCallRef = useRef(handleFeedbackCustomCall);
  const approvalRef = useRef(approval);
  const toolRoleShouldProvideGroupRef = useRef(toolRole.shouldProvideGroup);

  useEffect(() => {
    handleFeedbackFormCallRef.current = handleFeedbackFormCall;
    handleFeedbackCustomCallRef.current = handleFeedbackCustomCall;
    approvalRef.current = approval;
    toolRoleShouldProvideGroupRef.current = toolRole.shouldProvideGroup;
  }, [handleFeedbackFormCall, handleFeedbackCustomCall, approval, toolRole.shouldProvideGroup]);

  // Connect to channel on mount
  useEffect(() => {
    if (!channelName || !config.serverUrl) return;
    if (hasConnectedRef.current) return;
    hasConnectedRef.current = true;

    async function doConnect() {
      try {
        const feedbackFormMethodDef: MethodDefinition = {
          description: `Show a form to collect user input.

**Result:** \`{ type: "submit", value: { fieldKey: userValue, ... } }\` or \`{ type: "cancel" }\`

**Field types:** string, number, boolean, select (needs \`options\`), slider (\`min\`/\`max\`), segmented (\`options\`)
**Field props:** \`key\` (required), \`label\` (required), \`type\` (required), \`default\`, \`required\`, \`description\`
**Pre-populate:** Add \`values: { "key": "existing value" }\``,
          parameters: FeedbackFormArgsSchema,
          execute: async (args, ctx) => handleFeedbackFormCallRef.current(ctx.callId, args as FeedbackFormArgs, ctx),
        };

        const feedbackCustomMethodDef: MethodDefinition = {
          description: `[Chat Panel] Show a custom React UI. For advanced cases only - prefer feedback_form for standard forms.

**Result:** \`{ type: "submit", value: ... }\` or \`{ type: "cancel" }\`

Component receives \`onSubmit(value)\`, \`onCancel()\`, \`onError(msg)\` props.
Available: \`@radix-ui/themes\`, \`@radix-ui/react-icons\`, \`react\`

**Requirements:**
- Component MUST use \`export default\` (named exports alone won't work)
- Syntax: TSX (TypeScript + JSX)

**Rendering context:** Your component is rendered inside a container Card with a header, scroll area, and resize handle. Do NOT wrap your component in a top-level Card — use \`<Flex direction="column" gap="3" p="2">\` or similar as root.

**Example:**
\`\`\`tsx
import { useState } from "react";
import { Button, Flex, Text, TextField } from "@radix-ui/themes";

export default function App({ onSubmit, onCancel }) {
  const [name, setName] = useState("");
  return (
    <Flex direction="column" gap="3" p="2">
      <Text size="2" weight="bold">What is your name?</Text>
      <TextField.Root value={name} onChange={e => setName(e.target.value)} />
      <Flex gap="2" justify="end">
        <Button variant="soft" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onSubmit({ name })}>Submit</Button>
      </Flex>
    </Flex>
  );
}
\`\`\``,
          parameters: FeedbackCustomArgsSchema,
          execute: async (args, ctx) => handleFeedbackCustomCallRef.current(ctx.callId, args as FeedbackCustomArgs, ctx),
        };

        // Build tool methods from provider
        let toolMethods: Record<string, MethodDefinition> = {};
        if (tools) {
          const rawTools = tools({ clientRef, workspaceRoot: (channelConfig as Record<string, unknown>)?.workingDirectory as string | undefined });
          // Wrap with approval
          toolMethods = wrapMethodsWithApproval(
            rawTools,
            {
              isAgentGranted: (...args) => approvalRef.current.isAgentGranted(...args),
              checkToolApproval: (...args) => approvalRef.current.checkToolApproval(...args),
              requestApproval: (...args) => approvalRef.current.requestApproval(...args),
            },
            (agentId) => clientRef.current?.roster[agentId]?.metadata.name ?? agentId,
            () => ({ shouldProvideGroup: toolRoleShouldProvideGroupRef.current! })
          );
        }

        const methods: Record<string, MethodDefinition> = {
          feedback_form: feedbackFormMethodDef,
          feedback_custom: feedbackCustomMethodDef,
          ...toolMethods,
        };

        await connectToChannel({ channelId: channelName, methods, channelConfig, contextId });
        setStatus("Connected");
      } catch (err) {
        console.error("[Chat] Connection error:", err);
        setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
        hasConnectedRef.current = false;
      }
    }

    void doConnect();
  }, [channelName, channelConfig, contextId, connectToChannel, config.serverUrl, tools]);

  // Reset handler
  const reset = useCallback(() => {
    setMessages([]);
    setInput("");
    cleanupPendingImages(pendingImages);
    setPendingImages([]);
    setParticipants({});
    setHistoricalParticipants({});
    clearMethodHistory();
    for (const callId of activeFeedbacks.keys()) { dismissFeedback(callId); }
    actions?.onNewConversation?.();
  }, [clearMethodHistory, activeFeedbacks, dismissFeedback, pendingImages, actions]);

  // Send message
  const sendMessage = useCallback(async (attachments?: AttachmentInput[]): Promise<void> => {
    const hasText = input.trim().length > 0;
    const hasAttachments = attachments && attachments.length > 0;
    if ((!hasText && !hasAttachments) || !clientRef.current?.connected) return;
    await stopTyping();
    const text = input.trim();
    setInput("");
    const { messageId } = await clientRef.current.send(text || "", { attachments: hasAttachments ? attachments : undefined });
    const selfId = clientRef.current.clientId ?? config.clientId;
    setMessages((prev) => {
      if (prev.some((m) => m.id === messageId)) return prev;
      return [...prev, { id: messageId, senderId: selfId, content: text, complete: true, pending: true, kind: "message" }];
    });
  }, [input, config.clientId, clientRef, stopTyping]);

  // Interrupt agent
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

  // Wrap platform actions
  const handleAddAgent = actions?.onAddAgent
    ? useCallback(async () => {
        const launcherContextId = clientRef.current?.contextId;
        await actions.onAddAgent!(channelName, launcherContextId);
      }, [channelName, clientRef, actions])
    : undefined;

  return {
    // Connection
    connected,
    status,
    channelId: channelName,
    sessionEnabled: clientRef.current?.sessionEnabled,

    // Messages
    messages,
    methodEntries,
    inlineUiComponents,
    hasMoreHistory,
    loadingMore,

    // Participants
    participants,
    allParticipants,

    // Input
    input,
    pendingImages,

    // Agent state
    debugEvents,
    debugConsoleAgent,
    dirtyRepoWarnings,
    pendingAgents,

    // Feedback
    activeFeedbacks,

    // Theme
    theme,

    // Handlers
    onInputChange: handleInputChange,
    onSendMessage: sendMessage,
    onImagesChange: setPendingImages,
    onLoadEarlierMessages: loadEarlierMessages,
    onInterrupt: handleInterruptAgent,
    onCallMethod: handleCallMethod,
    onFeedbackDismiss: handleFeedbackDismiss,
    onFeedbackError: handleFeedbackError,
    onDebugConsoleChange: setDebugConsoleAgent,
    onDismissDirtyWarning: handleDismissDirtyWarning,
    onReset: reset,

    // Optional actions
    onAddAgent: handleAddAgent,
    onFocusPanel: actions?.onFocusPanel,
    onReloadPanel: actions?.onReloadPanel,

    // Tool approval
    toolApproval: {
      settings: approval.settings,
      onSetFloor: approval.setGlobalFloor,
      onGrantAgent: approval.grantAgent,
      onRevokeAgent: approval.revokeAgent,
      onRevokeAll: approval.revokeAll,
    },

    // Tool role
    toolRole,
  };
}
