/**
 * Agentic Chat Panel
 *
 * Full chat interface that connects to a channel via stateArgs.channelName.
 * Provides file, git, search, and eval tools to agents.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { Flex, Text, Button, Card } from "@radix-ui/themes";
import { pubsubConfig, id as panelClientId, buildNsLink, buildFocusLink, createChild, useStateArgs, forceRepaint, ensurePanelLoaded } from "@natstack/runtime";
import { usePanelTheme } from "@natstack/react";
import { z } from "zod";
import type { ComponentType } from "react";
import { CONTENT_TYPE_TYPING, CONTENT_TYPE_INLINE_UI } from "@natstack/agentic-messaging/utils";
import type {
  IncomingEvent,
  IncomingToolRoleRequestEvent,
  IncomingToolRoleResponseEvent,
  IncomingToolRoleHandoffEvent,
  IncomingAgentDebugEvent,
  AgentDebugPayload,
  MethodDefinition,
  MethodExecutionContext,
  TypingData,
  InlineUiData,
  FeedbackFormArgs,
  FeedbackCustomArgs,
} from "@natstack/agentic-messaging";
import {
  FeedbackFormArgsSchema,
  FeedbackCustomArgsSchema,
} from "@natstack/agentic-messaging/protocol-schemas";
import type { Participant, RosterUpdate, Attachment, AttachmentInput } from "@natstack/pubsub";
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
  type ActiveFeedback,
  type ActiveFeedbackTsx,
  type ActiveFeedbackSchema,
} from "@natstack/tool-ui";
import {
  executeEvalTool,
  EVAL_DEFAULT_TIMEOUT_MS,
  EVAL_MAX_TIMEOUT_MS,
  EVAL_FRAMEWORK_TIMEOUT_MS,
} from "./eval/evalTool";
import { createAllToolMethodDefinitions } from "./tools";
import { useChannelConnection } from "./hooks/useChannelConnection";
import { useMethodHistory, type ChatMessage } from "./hooks/useMethodHistory";
import { useToolRole } from "./hooks/useToolRole";
import { dispatchAgenticEvent, type DirtyRepoDetails } from "./hooks/useAgentEvents";
import type { MethodHistoryEntry } from "./components/MethodHistoryItem";
import { ToolRoleConflictModal } from "./components/ToolRoleConflictModal";
import { ChatPhase } from "./components/ChatPhase";
import { cleanupPendingImages, type PendingImage } from "./utils/imageUtils";
import type { ChatParticipantMetadata, DisconnectedAgentInfo, PendingAgent, PendingAgentStatus } from "./types";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { parseInlineUiData } from "./components/InlineUiMessage";

/** Pending agent info passed from chat-launcher */
interface PendingAgentInfo {
  agentId: string;
  handle: string;
}

/** Type for chat panel state args */
interface ChatStateArgs {
  channelName: string;
  channelConfig?: {
    workingDirectory?: string;
    restrictedMode?: boolean;
  };
  /** Context ID for channel authorization (passed separately from channelConfig) */
  contextId?: string;
  /** Agents that are being spawned (passed from chat-launcher) */
  pendingAgents?: PendingAgentInfo[];
}

export default function AgenticChat() {
  const theme = usePanelTheme();
  const stateArgs = useStateArgs<ChatStateArgs>();
  const { channelName, channelConfig, contextId } = stateArgs;

  // Derive workspace root with proper priority:
  // 1. channelConfig.workingDirectory (passed from chat-launcher)
  // 2. NATSTACK_WORKSPACE env var (legacy/backwards compatibility)
  // 3. "/" for restricted/OPFS mode (sandbox root)
  const workspaceRoot = channelConfig?.workingDirectory
    || process.env["NATSTACK_WORKSPACE"]?.trim()
    || (channelConfig?.restrictedMode ? "/" : undefined);

  const selfIdRef = useRef<string | null>(null);
  // Track if we've already connected to prevent reconnection loops
  const hasConnectedRef = useRef(false);
  // Ref to access current participants in memoized callbacks
  const participantsRef = useRef<Record<string, Participant<ChatParticipantMetadata>>>({});
  // Ref to track previous participants for detecting disconnections
  const prevParticipantsRef = useRef<Record<string, Participant<ChatParticipantMetadata>>>({});
  // Refs for tool role handlers - set after toolRole hook is created
  const toolRoleHandlerRef = useRef<((event: IncomingToolRoleRequestEvent) => void) | null>(null);
  const toolRoleResponseHandlerRef = useRef<((event: IncomingToolRoleResponseEvent) => void) | null>(null);
  const toolRoleHandoffHandlerRef = useRef<((event: IncomingToolRoleHandoffEvent) => void) | null>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [status, setStatus] = useState("Connecting...");
  const [participants, setParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});
  // Historical participants reconstructed from presence events during replay
  const [historicalParticipants, setHistoricalParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});

  // Debug events for agents (ephemeral, in-memory only)
  const [debugEvents, setDebugEvents] = useState<Array<AgentDebugPayload & { ts: number }>>([]);
  // Currently open debug console agent handle
  const [debugConsoleAgent, setDebugConsoleAgent] = useState<string | null>(null);

  // Dirty repo warnings for agents that spawned with uncommitted changes
  const [dirtyRepoWarnings, setDirtyRepoWarnings] = useState<Map<string, { modified: string[]; untracked: string[]; staged: string[] }>>(new Map());

  // Pending agents state (initialized from stateArgs, managed locally)
  // key: handle, value: PendingAgent { agentId, status, error? }
  const [pendingAgents, setPendingAgents] = useState<Map<string, PendingAgent>>(() => {
    const initial = new Map<string, PendingAgent>();
    if (stateArgs.pendingAgents) {
      for (const agent of stateArgs.pendingAgents) {
        initial.set(agent.handle, { agentId: agent.agentId, status: "starting" });
      }
    }
    return initial;
  });

  // Removed production console logging

  // Pending agent timeout handling with refs to prevent reset on re-renders
  const PENDING_TIMEOUT_MS = 45_000;
  const pendingTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timeouts = pendingTimeoutsRef.current;

    // Add timeouts for new "starting" agents
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

    // Clear timeouts for agents no longer pending
    for (const [handle, timeout] of timeouts) {
      if (!pendingAgents.has(handle)) {
        clearTimeout(timeout);
        timeouts.delete(handle);
      }
    }
  }, [pendingAgents]);

  // Cleanup pending timeouts on unmount
  useEffect(() => {
    return () => {
      for (const timeout of pendingTimeoutsRef.current.values()) {
        clearTimeout(timeout);
      }
    };
  }, []);

  // Track compiled inline UI components by ID
  // Key: inline UI id, Value: { Component, cacheKey, error? }
  const [inlineUiComponents, setInlineUiComponents] = useState<Map<string, {
    Component?: ComponentType<{ props: Record<string, unknown> }>;
    cacheKey: string;
    error?: string;
  }>>(new Map());

  // Compile inline_ui messages when they arrive
  // This effect watches for new messages with contentType "inline_ui" and compiles their MDX
  useEffect(() => {
    const compileInlineUiMessages = async () => {
      for (const msg of messages) {
        if (msg.contentType !== CONTENT_TYPE_INLINE_UI) continue;

        const data = parseInlineUiData(msg.content);
        if (!data) continue;

        // Skip if already compiled
        if (inlineUiComponents.has(data.id)) continue;

        try {
          // Use compileInlineUiComponent for inline_ui (passes props through)
          const result = await compileInlineUiComponent({ code: data.code });
          if (result.success) {
            setInlineUiComponents(prev => {
              const updated = new Map(prev);
              updated.set(data.id, {
                Component: result.Component!,
                cacheKey: result.cacheKey!,
              });
              return updated;
            });
          } else {
            setInlineUiComponents(prev => {
              const updated = new Map(prev);
              updated.set(data.id, {
                cacheKey: data.code,
                error: result.error,
              });
              return updated;
            });
          }
        } catch (err) {
          setInlineUiComponents(prev => {
            const updated = new Map(prev);
            updated.set(data.id, {
              cacheKey: data.code,
              error: err instanceof Error ? err.message : String(err),
            });
            return updated;
          });
        }
      }
    };

    void compileInlineUiMessages();
  }, [messages, inlineUiComponents]);

  // Memory management constants for message history
  const MAX_VISIBLE_MESSAGES = 500;
  const TRIM_THRESHOLD = MAX_VISIBLE_MESSAGES * 2; // Trim at 1000 messages

  // Pagination state for loading older messages
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [oldestLoadedId, setOldestLoadedId] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Trim messages when they exceed threshold to prevent memory leaks.
  // Uses the updater form of setMessages to avoid stale closure over `messages`.
  // Captures referencedUiIds via a closure variable so setInlineUiComponents
  // can run as a separate call (not nested inside the updater).
  useEffect(() => {
    if (messages.length > TRIM_THRESHOLD) {
      let referencedUiIds: Set<string> | undefined;

      setMessages((prev) => {
        const trimmed = prev.slice(-MAX_VISIBLE_MESSAGES);

        // Build a set of inline UI IDs still referenced by surviving messages
        referencedUiIds = new Set<string>();
        for (const msg of trimmed) {
          if (msg.contentType === CONTENT_TYPE_INLINE_UI) {
            const data = parseInlineUiData(msg.content);
            if (data) referencedUiIds.add(data.id);
          }
        }

        // Track oldest loaded message for pagination
        const firstMsg = trimmed[0];
        if (firstMsg?.pubsubId) {
          setOldestLoadedId(firstMsg.pubsubId);
          setHasMoreHistory(true); // We trimmed, so there's definitely more
        }
        return trimmed;
      });

      // Clean up inline UI components for trimmed messages only.
      // referencedUiIds is populated synchronously by the updater above.
      if (referencedUiIds) {
        const ids = referencedUiIds;
        setInlineUiComponents(prevComponents => {
          const next = new Map(prevComponents);
          let removedCount = 0;

          for (const [id, component] of prevComponents) {
            if (!ids.has(id)) {
              // Clean up the compiled component
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

  // Ref to track pendingImages for unmount cleanup (avoids closure over stale state)
  const pendingImagesRef = useRef(pendingImages);
  pendingImagesRef.current = pendingImages;

  // Cleanup pending images only on unmount to prevent revoking URLs still in use
  useEffect(() => {
    return () => {
      cleanupPendingImages(pendingImagesRef.current);
    };
  }, []); // Empty deps = unmount only

  // Ref to access current message count in heartbeat without stale closure
  const messageCountRef = useRef(messages.length);
  messageCountRef.current = messages.length;

  // Debug/monitoring listeners with proper cleanup
  useEffect(() => {
    // Error handlers
    const errorHandler = (event: ErrorEvent) => {
      console.error("[Chat] Global error:", event.error);
    };
    const rejectionHandler = (event: PromiseRejectionEvent) => {
      console.error("[Chat] Unhandled rejection:", event.reason);
    };

    // Visibility/lifecycle handlers
    const visibilityHandler = () => {
      if (document.hidden) {
        console.log("[Chat] Panel hidden");
      } else {
        console.log("[Chat] Panel visible");
        forceRepaint?.();
      }
    };

    // Setup listeners
    window.addEventListener("error", errorHandler);
    window.addEventListener("unhandledrejection", rejectionHandler);
    document.addEventListener("visibilitychange", visibilityHandler);

    // Cleanup on unmount
    return () => {
      window.removeEventListener("error", errorHandler);
      window.removeEventListener("unhandledrejection", rejectionHandler);
      document.removeEventListener("visibilitychange", visibilityHandler);
    };
  }, []); // Only run once on mount

  // Combine historical participants (from replay) with current participants
  // Current participants take precedence over historical ones
  const allParticipants = useMemo(() => {
    return { ...historicalParticipants, ...participants };
  }, [historicalParticipants, participants]);

  // Keep participantsRef up to date for memoized callbacks
  participantsRef.current = allParticipants;

  // Handler for dismissing dirty repo warnings
  const handleDismissDirtyWarning = useCallback((agentName: string) => {
    setDirtyRepoWarnings((prev) => {
      const next = new Map(prev);
      next.delete(agentName);
      return next;
    });
  }, []);

  // Use feedback manager hook for UI feedback lifecycle
  const {
    activeFeedbacks,
    addFeedback,
    removeFeedback,
    dismissFeedback,
    handleFeedbackError,
  } = useFeedbackManager();

  const {
    methodEntries,
    addMethodHistoryEntry,
    updateMethodHistoryEntry,
    handleMethodResult,
    clearMethodHistory,
  } = useMethodHistory({ setMessages, clientId: panelClientId });

  // Use channel connection hook with event handler that uses extracted helper
  const {
    clientRef,
    connected,
    clientId,
    connect: connectToChannel,
    disconnect,
  } = useChannelConnection({
    metadata: {
      name: "Chat Panel",
      type: "panel",
      handle: "user",
    },
    // Declare that this panel provides file and git tools
    toolRoles: {
      "file-ops": { providing: true },
      "git-ops": { providing: true },
      "workspace-ops": { providing: true },
    },
    onEvent: useCallback(
      (event: IncomingEvent) => {
        try {
          const selfId = selfIdRef.current ?? panelClientId;
          dispatchAgenticEvent(
            event,
            {
              setMessages,
              addMethodHistoryEntry,
              handleMethodResult,
              setDebugEvents,
              setDirtyRepoWarnings,
              setPendingAgents,
            },
            selfId,
            participantsRef.current
          );
          // Handle tool role events
          if (event.type === "tool-role-request") {
            try {
              toolRoleHandlerRef.current?.(event);
            } catch (err) {
              console.error("[Chat] Tool role request handler error:", err);
            }
          }
          if (event.type === "tool-role-response") {
            try {
              toolRoleResponseHandlerRef.current?.(event);
            } catch (err) {
              console.error("[Chat] Tool role response handler error:", err);
            }
          }
          if (event.type === "tool-role-handoff") {
            try {
              toolRoleHandoffHandlerRef.current?.(event);
            } catch (err) {
              console.error("[Chat] Tool role handoff handler error:", err);
            }
          }
        } catch (err) {
          console.error("[Chat] Event dispatch error:", err);
        }
      },
      [
        setMessages,
        addMethodHistoryEntry,
        handleMethodResult,
        panelClientId,
        selfIdRef,
      ]
    ),
    onRoster: useCallback((roster: RosterUpdate<ChatParticipantMetadata>) => {
      const newParticipants = roster.participants;
      const prevParticipants = prevParticipantsRef.current;

      // Accumulate all participants ever seen into historicalParticipants.
      // This covers replay (presence events no longer flow through the event stream).
      setHistoricalParticipants((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [id, participant] of Object.entries(newParticipants)) {
          if (!(id in next)) {
            next[id] = participant;
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      // Detect disconnected participants (were in prev roster but not in new)
      const prevIds = new Set(Object.keys(prevParticipants));
      const newIds = new Set(Object.keys(newParticipants));

      const disconnectedIds: string[] = [];
      for (const prevId of prevIds) {
        if (!newIds.has(prevId)) {
          disconnectedIds.push(prevId);
          // This participant disconnected
          const disconnected = prevParticipants[prevId];
          const metadata = disconnected?.metadata;

          // Only create notification for non-panel participants (agents/workers)
          if (metadata && metadata.type !== "panel") {
            const agentInfo: DisconnectedAgentInfo = {
              name: metadata.name,
              handle: metadata.handle,
              panelId: metadata.panelId,
              agentTypeId: metadata.agentTypeId,
              type: metadata.type,
            };

            // Add system message for the disconnection
            setMessages((prev) => [
              ...prev,
              {
                id: `system-disconnect-${prevId}-${Date.now()}`,
                senderId: "system",
                content: "",
                kind: "system",
                complete: true,
                disconnectedAgent: agentInfo,
              },
            ]);
          }
        }
      }

      // Clean up typing indicators from disconnected participants
      // (typing messages only hide when complete=true, but agents may crash before marking them)
      if (disconnectedIds.length > 0) {
        const disconnectedSet = new Set(disconnectedIds);
        setMessages((prev) => {
          let changed = false;
          const next = prev.map((msg) => {
            if (msg.contentType === "typing" && !msg.complete && disconnectedSet.has(msg.senderId)) {
              changed = true;
              return { ...msg, complete: true };
            }
            return msg;
          });
          return changed ? next : prev;
        });
      }

      // Remove newly joined agents from pendingAgents
      // Check by handle since that's how we track pending agents
      const newHandles = new Set(Object.values(newParticipants).map((p) => p.metadata.handle));
      setPendingAgents((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const handle of prev.keys()) {
          if (newHandles.has(handle)) {
            next.delete(handle);
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      // Detect agents that are reconnecting (new to roster, non-panel).
      // An agent may get a new clientId (senderId) each wake cycle, so we
      // match by handle to find ALL previous senderIds for that agent and
      // clear their stale typing indicators.
      const reconnectingHandles = new Set<string>();
      for (const newId of newIds) {
        if (!prevIds.has(newId) && newParticipants[newId]?.metadata?.type !== "panel") {
          reconnectingHandles.add(newParticipants[newId].metadata.handle);
        }
      }

      // Build set of OLD senderIds belonging to reconnecting agents.
      // Use prevParticipants (ref, always current) to find old clientIds
      // for agents that are now reconnecting with a new clientId.
      // When an agent sleeps and wakes, it gets a new clientId — old typing
      // indicators under the previous clientId may not have been cleaned up
      // (race condition between cleanup message and disconnect).
      if (reconnectingHandles.size > 0) {
        const staleSenderIds = new Set<string>();
        for (const [id, p] of Object.entries(prevParticipants)) {
          if (reconnectingHandles.has(p.metadata.handle) && !newIds.has(id)) {
            staleSenderIds.add(id);
          }
        }

        if (staleSenderIds.size > 0) {
          setMessages((prev) => {
            let changed = false;
            const next = prev.map((msg) => {
              if (msg.contentType === "typing" && !msg.complete && staleSenderIds.has(msg.senderId)) {
                changed = true;
                return { ...msg, complete: true };
              }
              return msg;
            });
            return changed ? next : prev;
          });
        }
      }

      // Remove stale disconnect messages for agents that rejoined by handle
      const agentHandles = new Set(
        Object.values(newParticipants)
          .filter(p => p.metadata.type !== "panel")
          .map(p => p.metadata.handle)
      );
      setMessages((prev) => {
        const filtered = prev.filter(msg => {
          // Keep non-system messages
          if (msg.kind !== "system" || !msg.disconnectedAgent) return true;
          // Remove disconnect message if agent with same handle is now present
          return !agentHandles.has(msg.disconnectedAgent.handle);
        });
        return filtered.length === prev.length ? prev : filtered;
      });

      // Update refs and state
      prevParticipantsRef.current = newParticipants;
      setParticipants(newParticipants);
    }, []),
    onError: useCallback((error: Error) => {
      console.error("[Chat Panel] Connection error:", error);
      setStatus(`Error: ${error.message}`);
    }, []),
  });

  // Load earlier messages from server (SQLite-backed) - must be after useChannelConnection
  const loadEarlierMessages = useCallback(async () => {
    const client = clientRef.current;
    if (!client || loadingMore || !hasMoreHistory || !oldestLoadedId) return;

    setLoadingMore(true);
    try {
      let currentBeforeId = oldestLoadedId;
      let olderMessages: ChatMessage[] = [];
      let hasMore = true;

      // Loop to skip batches that contain only non-message types
      // (method-call, method-result, presence, tool-role-*, agent-debug, etc.)
      // which are not displayed in the chat UI.
      while (hasMore && olderMessages.length === 0) {
        const result = await client.getMessagesBefore(currentBeforeId, 100);

        if (result.messages.length === 0) {
          hasMore = false;
          break;
        }

        // Update pagination cursor from raw (unfiltered) result
        currentBeforeId = result.messages[0]?.id ?? currentBeforeId;
        hasMore = result.hasMore;

        // Only include user-visible "message" type events — other types
        // (method-call, presence, etc.) are handled via separate state and
        // would show up as empty bubbles if converted to ChatMessages.
        const chatMessages = result.messages.filter((m) => m.type === "message");

        olderMessages = chatMessages.map((msg) => {
          const payload = typeof msg.payload === "object" && msg.payload !== null
            ? (msg.payload as { content?: string; contentType?: string })
            : {};
          return {
            id: String(msg.id),
            pubsubId: msg.id,
            senderId: msg.senderId,
            content: payload.content ?? "",
            contentType: payload.contentType,
            kind: "message" as const,
            complete: true,
            senderMetadata: msg.senderMetadata as { name?: string; type?: string; handle?: string } | undefined,
            attachments: msg.attachments,
          };
        });
      }

      if (olderMessages.length > 0) {
        setMessages((prev) => [...olderMessages, ...prev]);
      }
      setOldestLoadedId(currentBeforeId);
      setHasMoreHistory(hasMore);
    } catch (err) {
      console.error("[Chat] Failed to load earlier messages:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [clientRef, oldestLoadedId, hasMoreHistory, loadingMore]);

  useEffect(() => {
    selfIdRef.current = clientId;
  }, [clientId]);

  // Subscribe to channel title changes and update panel title via document.title
  // Electron's page-title-updated event will propagate this to the panel persistence
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !connected) return;

    // Set initial title if available
    const initialTitle = client.channelConfig?.title;
    if (initialTitle) {
      document.title = initialTitle;
    }

    // Subscribe to title changes
    const unsubscribe = client.onTitleChange((title) => {
      document.title = title;
    });

    return () => {
      unsubscribe();
    };
  }, [connected, clientRef]);

  // Initialize pagination state when connected and messages are loaded
  // This seeds hasMoreHistory from chatMessageCount so users can load history
  // even before trimming occurs
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !connected || messages.length === 0) return;

    // Only initialize once (when oldestLoadedId is not set)
    if (oldestLoadedId !== null) return;

    // Find the oldest message with a pubsubId
    const firstMsgWithId = messages.find((m) => m.pubsubId !== undefined);
    if (firstMsgWithId?.pubsubId !== undefined) {
      setOldestLoadedId(firstMsgWithId.pubsubId);

      // Check if there are more chat messages on the server than we have loaded.
      // Use chatMessageCount (type="message" only) instead of totalMessageCount
      // to avoid false positives from protocol chatter (method-call, presence, etc.)
      const serverChatCount = client.chatMessageCount;
      const dbMessageCount = messages.filter((m) => m.pubsubId !== undefined).length;
      if (serverChatCount !== undefined && serverChatCount > dbMessageCount) {
        setHasMoreHistory(true);
      }
    }
  }, [connected, messages.length, oldestLoadedId, clientRef]);

  // Typing indicator state - tracks ephemeral typing message
  const typingMessageIdRef = useRef<string | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const TYPING_DEBOUNCE_MS = 2000; // Stop typing after 2s of inactivity

  // Cleanup typing timeout on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    };
  }, []);

  // Stop typing indicator
  const stopTyping = useCallback(async () => {
    // Clear timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }

    // Complete the typing message (ephemeral - not persisted)
    if (typingMessageIdRef.current && clientRef.current?.connected) {
      await clientRef.current.update(typingMessageIdRef.current, "", { complete: true, persist: false });
      typingMessageIdRef.current = null;
    }
  }, [clientRef]);

  // Start or continue typing indicator
  const startTyping = useCallback(async () => {
    const client = clientRef.current;
    if (!client?.connected) return;

    // Clear existing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Send typing message if not already typing
    if (!typingMessageIdRef.current) {
      const typingData: TypingData = {
        senderId: client.clientId ?? panelClientId,
        senderName: "User",
        senderType: "panel",
      };
      const { messageId } = await client.send(JSON.stringify(typingData), {
        contentType: CONTENT_TYPE_TYPING,
        persist: false, // Ephemeral - won't be saved
      });
      typingMessageIdRef.current = messageId;
    }

    // Set timeout to stop typing after inactivity
    typingTimeoutRef.current = setTimeout(() => {
      void stopTyping().catch((err) => {
        console.error("[Chat] Stop typing timeout error:", err);
      });
    }, TYPING_DEBOUNCE_MS);
  }, [clientRef, panelClientId, stopTyping]);

  // Handle input change with typing indicator
  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    if (value.trim()) {
      void startTyping().catch((err) => {
        console.error("[Chat] Start typing error:", err);
      });
    } else {
      void stopTyping().catch((err) => {
        console.error("[Chat] Stop typing error:", err);
      });
    }
  }, [startTyping, stopTyping]);

  // Tool approval hook - uses client for persistence and feedback system for UI
  const approval = useToolApproval(clientRef.current, { addFeedback, removeFeedback });

  // Tool role hook - handles conflict detection and negotiation
  const toolRole = useToolRole(clientRef.current, clientId);

  // Keep the tool role handler refs updated so onEvent can call them
  useEffect(() => {
    toolRoleHandlerRef.current = toolRole.handleToolRoleRequest;
    toolRoleResponseHandlerRef.current = toolRole.handleToolRoleResponse;
    toolRoleHandoffHandlerRef.current = toolRole.handleToolRoleHandoff;
  }, [toolRole.handleToolRoleRequest, toolRole.handleToolRoleResponse, toolRole.handleToolRoleHandoff]);

  // Refs to store latest callback versions for use in connection effect
  // This prevents the effect from re-running when callbacks change
  const handleFeedbackFormCallRef = useRef<typeof handleFeedbackFormCall | null>(null);
  const handleFeedbackCustomCallRef = useRef<typeof handleFeedbackCustomCall | null>(null);
  const evalMethodDefRef = useRef<MethodDefinition | null>(null);
  const approvalRef = useRef<typeof approval | null>(null);
  const toolRoleShouldProvideGroupRef = useRef<typeof toolRole.shouldProvideGroup | null>(null);

  // Helper to handle feedback result and update method history
  const handleFeedbackResult = useCallback((callId: string, feedbackResult: FeedbackResult) => {
    if (feedbackResult.type === "submit") {
      updateMethodHistoryEntry(callId, {
        status: "success",
        result: feedbackResult.value,
        completedAt: Date.now(),
      });
    } else if (feedbackResult.type === "cancel") {
      updateMethodHistoryEntry(callId, {
        status: "success",
        result: null,
        completedAt: Date.now(),
      });
    } else {
      // error case
      updateMethodHistoryEntry(callId, {
        status: "error",
        error: feedbackResult.message,
        completedAt: Date.now(),
      });
    }
  }, [updateMethodHistoryEntry]);

  const handleFeedbackFormCall = useCallback(
    async (callId: string, args: FeedbackFormArgs, ctx: MethodExecutionContext) => {
      const entry: MethodHistoryEntry = {
        callId,
        methodName: "feedback_form",
        description: "Display a form to collect user input",
        args,
        status: "pending",
        startedAt: Date.now(),
        callerId: ctx.callerId,
        handledLocally: true,
      };
      try {
        addMethodHistoryEntry(entry);
      } catch (err) {
        console.error("[Chat] Failed to add method history entry:", err);
      }

      return new Promise<FeedbackResult>((resolve, reject) => {
        try {
          const feedback: ActiveFeedbackSchema = {
            type: "schema",
            callId,
            title: args.title,
            fields: args.fields,
            values: args.values ?? {},
            submitLabel: args.submitLabel,
            cancelLabel: args.cancelLabel,
            // New properties for feedback UI
            timeout: args.timeout,
            timeoutAction: args.timeoutAction,
            severity: args.severity,
            hideSubmit: args.hideSubmit,
            hideCancel: args.hideCancel,
            createdAt: Date.now(),
            complete: (feedbackResult: FeedbackResult) => {
              try {
                removeFeedback(callId);
                handleFeedbackResult(callId, feedbackResult);
                resolve(feedbackResult);
              } catch (err) {
                console.error("[Chat] Feedback completion error:", err);
                reject(err);
              }
            },
          };

          addFeedback(feedback);
        } catch (err) {
          console.error("[Chat] Failed to add feedback:", err);
          reject(err);
        }
      });
    },
    [addFeedback, removeFeedback, addMethodHistoryEntry, handleFeedbackResult]
  );

  const handleFeedbackCustomCall = useCallback(
    async (callId: string, args: FeedbackCustomArgs, ctx: MethodExecutionContext) => {
      const entry: MethodHistoryEntry = {
        callId,
        methodName: "feedback_custom",
        description: "Display a custom React component for user interaction",
        args,
        status: "pending",
        startedAt: Date.now(),
        callerId: ctx.callerId,
        handledLocally: true,
      };
      try {
        addMethodHistoryEntry(entry);
      } catch (err) {
        console.error("[Chat] Failed to add method history entry:", err);
      }

      const result = await compileFeedbackComponent({ code: args.code } as FeedbackUiToolArgs);

      if (!result.success) {
        try {
          updateMethodHistoryEntry(callId, {
            status: "error",
            error: result.error,
            completedAt: Date.now(),
          });
        } catch (err) {
          console.error("[Chat] Failed to update method history entry:", err);
        }
        throw new Error(result.error);
      }

      const cacheKey = result.cacheKey!;

      return new Promise<FeedbackResult>((resolve, reject) => {
        try {
          const feedback: ActiveFeedbackTsx = {
            type: "tsx",
            callId,
            Component: result.Component!,
            createdAt: Date.now(),
            cacheKey,
            complete: (feedbackResult: FeedbackResult) => {
              try {
                removeFeedback(callId);
                cleanupFeedbackComponent(cacheKey);
                handleFeedbackResult(callId, feedbackResult);
                resolve(feedbackResult);
              } catch (err) {
                console.error("[Chat] Custom feedback completion error:", err);
                reject(err);
              }
            },
          };

          addFeedback(feedback);
        } catch (err) {
          console.error("[Chat] Failed to add custom feedback:", err);
          reject(err);
        }
      });
    },
    [addFeedback, removeFeedback, addMethodHistoryEntry, updateMethodHistoryEntry, handleFeedbackResult]
  );

  const handleFeedbackDismiss = useCallback((callId: string) => {
    dismissFeedback(callId);
  }, [dismissFeedback]);

  const evalMethodDef = useMemo<MethodDefinition>(
    () => ({
      description: `Execute TypeScript/JavaScript code for side-effects.

Console output is streamed in real-time as code executes.
Async operations (fetch, await, etc.) are automatically awaited.
Top-level await is supported.

Use standard ESM imports - they're transformed to require() automatically:
- import { useState } from "react"
- import { Button } from "@radix-ui/themes"`,
      parameters: z.object({
        code: z.string().describe("The TypeScript/JavaScript code to execute"),
        syntax: z
          .enum(["typescript", "jsx", "tsx"])
          .default("tsx")
          .describe("Target syntax"),
        timeout: z
          .number()
          .default(EVAL_DEFAULT_TIMEOUT_MS)
          .describe(`Timeout in ms for async operations (default: ${EVAL_DEFAULT_TIMEOUT_MS}, max: ${EVAL_MAX_TIMEOUT_MS}). Set to 0 to skip async waiting.`),
      }),
      streaming: true,
      // Framework safety net - should never fire in normal operation
      timeout: EVAL_FRAMEWORK_TIMEOUT_MS,
      execute: async (args, ctx) => {
        const entry: MethodHistoryEntry = {
          callId: ctx.callId,
          methodName: "eval",
          description: "Execute TypeScript/JavaScript code with console streaming",
          args,
          status: "pending",
          startedAt: Date.now(),
          callerId: ctx.callerId,
          handledLocally: true,
        };
        addMethodHistoryEntry(entry);

        let consoleBuffer = "";
        let lastFlush = 0;
        const flushConsole = (force = false) => {
          const now = Date.now();
          if (!force && now - lastFlush < 200) return;
          lastFlush = now;
          updateMethodHistoryEntry(ctx.callId, { consoleOutput: consoleBuffer });
        };

        try {
          const result = await executeEvalTool(args, ctx, {
            onConsoleEntry: (formatted) => {
              consoleBuffer = consoleBuffer ? `${consoleBuffer}\n${formatted}` : formatted;
              flushConsole();
            },
          });
          if (!result.success) {
            if (result.consoleOutput) {
              consoleBuffer = result.consoleOutput;
            }
            flushConsole(true);
            updateMethodHistoryEntry(ctx.callId, {
              status: "error",
              error: result.error || "Eval failed",
              consoleOutput: consoleBuffer,
              completedAt: Date.now(),
            });
            throw new Error(result.error || "Eval failed");
          }
          const payload = {
            consoleOutput: result.consoleOutput || "(no output)",
            returnValue: result.returnValue,
          };
          consoleBuffer = payload.consoleOutput;
          flushConsole(true);
          updateMethodHistoryEntry(ctx.callId, {
            status: "success",
            result: payload,
            consoleOutput: payload.consoleOutput,
            completedAt: Date.now(),
          });
          return payload;
        } catch (err) {
          flushConsole(true);
          updateMethodHistoryEntry(ctx.callId, {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
            consoleOutput: consoleBuffer,
            completedAt: Date.now(),
          });
          throw err;
        }
      },
    }),
    [addMethodHistoryEntry, updateMethodHistoryEntry]
  );

  // Keep callback refs updated so connection effect uses latest versions
  useEffect(() => {
    handleFeedbackFormCallRef.current = handleFeedbackFormCall;
    handleFeedbackCustomCallRef.current = handleFeedbackCustomCall;
    evalMethodDefRef.current = evalMethodDef;
    approvalRef.current = approval;
    toolRoleShouldProvideGroupRef.current = toolRole.shouldProvideGroup;
  }, [handleFeedbackFormCall, handleFeedbackCustomCall, evalMethodDef, approval, toolRole.shouldProvideGroup]);

  // Connect to channel on mount (only once)
  useEffect(() => {
    if (!channelName || !pubsubConfig) return;
    // Prevent reconnection if already connected
    if (hasConnectedRef.current) return;
    hasConnectedRef.current = true;

    async function connect() {
      try {
        const feedbackFormMethodDef: MethodDefinition = {
          description: `Show a form to collect user input.

**Result:** \`{ type: "submit", value: { fieldKey: userValue, ... } }\` or \`{ type: "cancel" }\`

**Example:**
\`\`\`json
{ "title": "Confirm", "fields": [{ "key": "reason", "label": "Reason", "type": "string" }] }
\`\`\`

**Field types:** string, number, boolean, select (needs \`options\`), slider (\`min\`/\`max\`), segmented (\`options\`)
**Field props:** \`key\` (required), \`label\` (required), \`type\` (required), \`default\`, \`required\`, \`description\`
**Pre-populate:** Add \`values: { "key": "existing value" }\``,
          parameters: FeedbackFormArgsSchema,
          // Use ref to get latest callback version
          execute: async (args, ctx) => handleFeedbackFormCallRef.current!(ctx.callId, args as FeedbackFormArgs, ctx),
        };

        const feedbackCustomMethodDef: MethodDefinition = {
          description: `Show a custom React UI. For advanced cases only - prefer feedback_form for standard forms.

**Result:** \`{ type: "submit", value: ... }\` or \`{ type: "cancel" }\`

Component receives \`onSubmit(value)\`, \`onCancel()\`, \`onError(msg)\` props.
Available: \`@radix-ui/themes\`, \`@radix-ui/react-icons\`, \`react\``,
          parameters: FeedbackCustomArgsSchema,
          // Use ref to get latest callback version
          execute: async (args, ctx) => handleFeedbackCustomCallRef.current!(ctx.callId, args as FeedbackCustomArgs, ctx),
        };

        // Create file/search/git tools using workspace root
        // Wrap diagnostics publishing to use clientRef at runtime
        const diagnosticsPublisher = (eventType: string, payload: unknown) => {
          void clientRef.current?.publish(eventType, payload);
        };
        const fileTools = createAllToolMethodDefinitions({
          workspaceRoot,
          diagnosticsPublisher,
        });

        // Wrap tools with approval middleware
        // Use refs for runtime lookup to avoid stale closure issues
        const approvedTools = wrapMethodsWithApproval(
          fileTools,
          {
            isAgentGranted: (...args) => approvalRef.current!.isAgentGranted(...args),
            checkToolApproval: (...args) => approvalRef.current!.checkToolApproval(...args),
            requestApproval: (...args) => approvalRef.current!.requestApproval(...args),
          },
          (agentId) => clientRef.current?.roster[agentId]?.metadata.name ?? agentId,
          // Use getter pattern with ref to avoid stale closure
          () => ({ shouldProvideGroup: toolRoleShouldProvideGroupRef.current! })
        );

        const methods: Record<string, MethodDefinition> = {
          eval: evalMethodDefRef.current!,
          feedback_form: feedbackFormMethodDef,
          feedback_custom: feedbackCustomMethodDef,
          ...approvedTools,
        };

        // Connect using the hook with all methods
        // Use ref for evalMethodDef to get latest version
        await connectToChannel({
          channelId: channelName,
          methods,
          // Pass channel config (set when creating channel, read by joiners from server)
          channelConfig,
          // Pass contextId for channel authorization (separate from channelConfig)
          contextId,
        });

        setStatus("Connected");
      } catch (err) {
        console.error("[Chat] Connection error:", err);
        setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
        hasConnectedRef.current = false; // Allow retry on error
      }
    }

    void connect().catch((err) => {
      // This should not happen as connect() has its own try-catch,
      // but catch any unexpected errors to prevent React unmount
      console.error("[Chat] Unexpected connect error:", err);
    });
  // Minimal dependencies - use refs for callbacks to prevent reconnection loops
  }, [
    channelName,
    channelConfig,
    contextId,
    connectToChannel,
    workspaceRoot,
  ]);

  // Navigate to chat-launcher for new conversation
  const handleNewConversation = useCallback(() => {
    const launcherUrl = buildNsLink("panels/chat-launcher", {
      action: "navigate",
    });
    window.location.href = launcherUrl;
  }, []);

  // Launch chat-launcher as child to add agents to current channel
  const handleAddAgent = useCallback(async () => {
    if (!channelName) return;
    // Pass contextId so new agents join with the correct channel context
    // Note: Use client.contextId (top-level field), NOT channelConfig.contextId
    const launcherContextId = clientRef.current?.contextId;
    await createChild(
      "panels/chat-launcher",
      {
        name: "add-agent",
        focus: true,
        // contextId in options ensures chat-launcher can access channel storage if needed
        contextId: launcherContextId,
      },
      { channelName, contextId: launcherContextId }  // Also in stateArgs for app logic
    );
  }, [channelName, clientRef]);

  const reset = useCallback(() => {
    setMessages([]);
    setInput("");
    // Cleanup pending images
    cleanupPendingImages(pendingImages);
    setPendingImages([]);
    setParticipants({});
    setHistoricalParticipants({});
    clearMethodHistory();
    // Dismiss all active feedbacks (completes them with "cancel")
    // This includes pending tool approvals which now use the feedback system
    for (const callId of activeFeedbacks.keys()) {
      dismissFeedback(callId);
    }
    // Navigate to chat-launcher
    handleNewConversation();
  }, [clearMethodHistory, activeFeedbacks, dismissFeedback, pendingImages, handleNewConversation]);

  const sendMessage = useCallback(async (attachments?: AttachmentInput[]): Promise<void> => {
    const hasText = input.trim().length > 0;
    const hasAttachments = attachments && attachments.length > 0;
    if ((!hasText && !hasAttachments) || !clientRef.current?.connected) return;

    // Stop typing indicator before sending
    await stopTyping();

    const text = input.trim();
    setInput("");

    const { messageId } = await clientRef.current.send(text || "", {
      attachments: hasAttachments ? attachments : undefined,
    });
    const selfId = clientRef.current.clientId ?? panelClientId;

    setMessages((prev) => {
      if (prev.some((m) => m.id === messageId)) return prev;
      return [
        ...prev,
        {
          id: messageId,
          senderId: selfId,
          content: text,
          complete: true,
          pending: true,
          kind: "message",
          // Note: Don't store attachments in optimistic message - they don't have server IDs yet.
          // The server will broadcast back the message with proper attachment IDs.
        },
      ];
    });
  }, [input, panelClientId, clientRef, stopTyping]);

  const handleInterruptAgent = useCallback(
    async (agentId: string, _messageId?: string, agentHandle?: string) => {
      // Note: messageId is optional and unused - we interrupt the agent, not a specific message
      if (!clientRef.current) return;

      const roster = participantsRef.current;
      let targetId = agentId;

      // Validate agent exists, fall back to handle lookup if agentId is stale
      if (!roster[agentId] && agentHandle) {
        const byHandle = Object.values(roster).find(
          p => p.metadata.handle === agentHandle && p.metadata.type !== "panel"
        );
        if (byHandle) {
          targetId = byHandle.id;
        } else {
          console.warn(`Cannot interrupt: agent ${agentHandle} not in roster`);
          return;
        }
      }

      try {
        // Call pause method via RPC - this interrupts the agent
        await clientRef.current.callMethod(targetId, "pause", {
          reason: "User interrupted execution",
        }).result;
      } catch (error) {
        console.error("Failed to interrupt agent:", error);
      }
    },
    [clientRef]
  );

  const handleCallMethod = useCallback(
    (providerId: string, methodName: string, args: unknown) => {
      if (!clientRef.current) return;
      // Fire and forget - results will appear in method history if tracked
      void clientRef.current.callMethod(providerId, methodName, args).result.catch((error: unknown) => {
        console.error(`Failed to call method ${methodName} on ${providerId}:`, error);
      });
    },
    [clientRef]
  );

  // Focus a disconnected agent's panel
  const handleFocusPanel = useCallback((panelId: string) => {
    window.location.href = buildFocusLink(panelId);
  }, []);

  // Reload a disconnected agent's panel
  const handleReloadPanel = useCallback(async (panelId: string) => {
    try {
      const result = await ensurePanelLoaded(panelId);
      if (!result.success) {
        console.error(`Failed to reload panel ${panelId}:`, result.error);
        // If reload fails, focus the panel so user can investigate
        handleFocusPanel(panelId);
      }
    } catch (error) {
      console.error(`Error reloading panel ${panelId}:`, error);
      handleFocusPanel(panelId);
    }
  }, [handleFocusPanel]);

  // Error state: no channel name provided
  if (!channelName) {
    return (
      <ErrorBoundary>
        <Flex direction="column" align="center" justify="center" style={{ height: "100vh", padding: 16 }} gap="3">
          <Card>
            <Flex direction="column" gap="3" p="4" align="center">
              <Text size="4" weight="bold" color="red">
                Missing Channel Name
              </Text>
              <Text size="2" color="gray" style={{ textAlign: "center" }}>
                This panel requires a channelName state arg to connect to a chat channel.
              </Text>
              <Button onClick={handleNewConversation}>
                Start New Conversation
              </Button>
            </Flex>
          </Card>
        </Flex>
      </ErrorBoundary>
    );
  }

  // Chat phase
  return (
    <ErrorBoundary
      onError={(error, errorInfo) => {
        console.error("[Chat] React error boundary caught error:", error);
        console.error("[Chat] Component stack:", errorInfo.componentStack);
      }}
    >
      {/* Tool role conflict modals */}
      {toolRole.pendingConflicts.map((conflict) => (
        <ToolRoleConflictModal
          key={conflict.group}
          conflict={conflict}
          onTakeOver={() => void toolRole.requestTakeOver(conflict.group)}
          onDefer={() => toolRole.acceptExisting(conflict.group)}
          onDismiss={() => toolRole.dismissConflict(conflict.group)}
          isNegotiating={toolRole.groupStates[conflict.group]?.negotiating ?? false}
        />
      ))}
      <ChatPhase
        channelId={channelName}
        connected={connected}
        status={status}
        messages={messages}
        input={input}
        pendingImages={pendingImages}
        participants={allParticipants}
        activeFeedbacks={activeFeedbacks}
        theme={theme}
        sessionEnabled={clientRef.current?.sessionEnabled}
        hasMoreHistory={hasMoreHistory}
        loadingMore={loadingMore}
        inlineUiComponents={inlineUiComponents}
        methodEntries={methodEntries}
        debugEvents={debugEvents}
        debugConsoleAgent={debugConsoleAgent}
        dirtyRepoWarnings={dirtyRepoWarnings}
        pendingAgents={pendingAgents}
        onDebugConsoleChange={setDebugConsoleAgent}
        onLoadEarlierMessages={loadEarlierMessages}
        onInputChange={handleInputChange}
        onSendMessage={sendMessage}
        onImagesChange={setPendingImages}
        onAddAgent={handleAddAgent}
        onReset={reset}
        onFeedbackDismiss={handleFeedbackDismiss}
        onFeedbackError={handleFeedbackError}
        onInterrupt={handleInterruptAgent}
        onCallMethod={handleCallMethod}
        onFocusPanel={handleFocusPanel}
        onReloadPanel={handleReloadPanel}
        onDismissDirtyWarning={handleDismissDirtyWarning}
        toolApproval={{
          settings: approval.settings,
          onSetFloor: approval.setGlobalFloor,
          onGrantAgent: approval.grantAgent,
          onRevokeAgent: approval.revokeAgent,
          onRevokeAll: approval.revokeAll,
        }}
      />
    </ErrorBoundary>
  );
}
