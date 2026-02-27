/**
 * useAgenticChat — Thin composer hook.
 *
 * Composes useChatCore + all feature hooks (roster tracking, pending agents,
 * feedback, tools, debug, inline UI) into the full ChatContextValue.
 *
 * For minimal chat (no tools, no feedback, no debug), use useChatCore directly.
 */

import { useCallback, useMemo, useRef, useEffect } from "react";
import type { ChannelConfig, MethodDefinition } from "@workspace/agentic-messaging";
import { useChatCore, type FeatureEventHandlers, type RosterExtension, type ReconnectExtension } from "./core/useChatCore";
import { useRosterTracking } from "./features/useRosterTracking";
import { usePendingAgents } from "./features/usePendingAgents";
import { useChatFeedback } from "./features/useChatFeedback";
import { useChatTools } from "./features/useChatTools";
import { useChatDebug } from "./features/useChatDebug";
import { useInlineUi } from "./features/useInlineUi";
import type { EventMiddleware } from "./useAgentEvents";
import type {
  ConnectionConfig,
  AgenticChatActions,
  ToolProvider,
  ChatParticipantMetadata,
  ChatContextValue,
  ChatInputContextValue,
} from "../types";

/** Pending agent info passed from launcher */
interface PendingAgentInfo {
  agentId: string;
  handle: string;
}

export interface UseAgenticChatOptions {
  config: ConnectionConfig;
  channelName: string;
  channelConfig?: ChannelConfig;
  contextId?: string;
  metadata?: ChatParticipantMetadata;
  tools?: ToolProvider;
  actions?: AgenticChatActions;
  theme?: "light" | "dark";
  pendingAgentInfos?: PendingAgentInfo[];
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
}: UseAgenticChatOptions): { contextValue: ChatContextValue; inputContextValue: ChatInputContextValue } {
  // --- Extension refs (populated below, read by core via refs) ---
  const featureHandlersRef = useRef<FeatureEventHandlers>({});
  const rosterExtensionsRef = useRef<RosterExtension[]>([]);
  const reconnectExtensionsRef = useRef<ReconnectExtension[]>([]);

  // --- Core ---
  const core = useChatCore({
    config,
    channelName,
    channelConfig,
    contextId,
    metadata,
    theme,
    eventMiddleware,
    featureHandlersRef,
    rosterExtensionsRef,
    reconnectExtensionsRef,
  });

  // --- Feature hooks ---
  const roster = useRosterTracking({
    setMessages: core.setMessages,
    configClientId: config.clientId,
  });

  const pending = usePendingAgents({
    initialPendingAgents: pendingAgentInfos,
  });

  const feedback = useChatFeedback({
    addMethodHistoryEntry: core.addMethodHistoryEntry,
    updateMethodHistoryEntry: core.updateMethodHistoryEntry,
  });

  const chatTools = useChatTools({
    clientRef: core.clientRef,
    tools,
    addFeedback: feedback.addFeedback,
    removeFeedback: feedback.removeFeedback,
  });

  const debug = useChatDebug();

  const inlineUi = useInlineUi({ messages: core.messages });

  // --- Combine participants (must happen before wiring refs) ---
  const allParticipants = useMemo(() => {
    return { ...roster.historicalParticipants, ...core.participants };
  }, [roster.historicalParticipants, core.participants]);

  // FIX: participantsRef must include historical participants so that
  // dispatchAgenticEvent can look up method descriptions for agents
  // that have left and rejoined with a different client ID.
  core.participantsRef.current = allParticipants;

  // --- Wire up extension refs (synchronous, during render) ---
  featureHandlersRef.current = {
    setDebugEvents: debug.setDebugEvents,
    setDirtyRepoWarnings: debug.setDirtyRepoWarnings,
    setPendingAgents: pending.setPendingAgents,
    expectedStops: roster.expectedStopsRef.current,
  };

  rosterExtensionsRef.current = [
    roster.rosterExtension,
    pending.rosterExtension,
  ];

  reconnectExtensionsRef.current = [
    roster.onReconnect,
  ];

  // --- Stable refs for connection effect (avoids unstable object deps) ---
  const feedbackRef = useRef(feedback);
  const chatToolsRef = useRef(chatTools);
  feedbackRef.current = feedback;
  chatToolsRef.current = chatTools;

  // --- Connect to channel on mount ---
  useEffect(() => {
    if (!channelName || !config.serverUrl) return;
    if (core.hasConnectedRef.current) return;
    core.hasConnectedRef.current = true;

    async function doConnect() {
      try {
        const feedbackMethods = feedbackRef.current.buildFeedbackMethods();
        const toolMethods = chatToolsRef.current.buildToolMethods();

        const methods: Record<string, MethodDefinition> = {
          ...feedbackMethods,
          ...toolMethods,
        };

        await core.connectToChannel({ channelId: channelName, methods, channelConfig, contextId });
        core.selfIdRef.current = core.clientRef.current?.clientId ?? null;
      } catch (err) {
        console.error("[Chat] Connection error:", err);
        core.hasConnectedRef.current = false;
      }
    }

    void doConnect();
  }, [channelName, channelConfig, contextId, core.connectToChannel, config.serverUrl, core.hasConnectedRef, core.selfIdRef, core.clientRef]);

  // --- Combined reset ---
  const reset = useCallback(() => {
    core.resetCore();
    roster.resetRoster();
    pending.resetPending();
    feedback.dismissAll();
    debug.resetDebug();
    actions?.onNewConversation?.();
  }, [core.resetCore, roster.resetRoster, pending.resetPending, feedback.dismissAll, debug.resetDebug, actions]);

  // --- Wrap platform actions ---
  const handleAddAgent = useCallback(async () => {
    if (!actions?.onAddAgent) return;
    const launcherContextId = core.clientRef.current?.contextId;
    await actions.onAddAgent(channelName, launcherContextId);
  }, [channelName, core.clientRef, actions]);

  const sessionEnabled = core.clientRef.current?.sessionEnabled;
  const onAddAgent = actions?.onAddAgent ? handleAddAgent : undefined;
  const onFocusPanel = actions?.onFocusPanel;
  const onReloadPanel = actions?.onReloadPanel;

  // --- Assemble context values ---
  const contextValue: ChatContextValue = useMemo(() => ({
    connected: core.connected,
    status: core.status,
    channelId: channelName,
    sessionEnabled,
    messages: core.messages,
    methodEntries: core.methodEntries,
    inlineUiComponents: inlineUi.inlineUiComponents,
    hasMoreHistory: core.hasMoreHistory,
    loadingMore: core.loadingMore,
    participants: core.participants,
    allParticipants,
    debugEvents: debug.debugEvents,
    debugConsoleAgent: debug.debugConsoleAgent,
    dirtyRepoWarnings: debug.dirtyRepoWarnings,
    pendingAgents: pending.pendingAgents,
    activeFeedbacks: feedback.activeFeedbacks,
    theme,
    onLoadEarlierMessages: core.loadEarlierMessages,
    onInterrupt: core.handleInterruptAgent,
    onCallMethod: core.handleCallMethod,
    onFeedbackDismiss: feedback.onFeedbackDismiss,
    onFeedbackError: feedback.onFeedbackError,
    onDebugConsoleChange: debug.setDebugConsoleAgent,
    onDismissDirtyWarning: debug.onDismissDirtyWarning,
    onReset: reset,
    onAddAgent,
    onFocusPanel,
    onReloadPanel,
    toolApproval: chatTools.toolApprovalValue,
  }), [
    core.connected, core.status, channelName, sessionEnabled,
    core.messages, core.methodEntries, inlineUi.inlineUiComponents, core.hasMoreHistory, core.loadingMore,
    core.participants, allParticipants,
    debug.debugEvents, debug.debugConsoleAgent, debug.dirtyRepoWarnings, pending.pendingAgents,
    feedback.activeFeedbacks, theme,
    core.loadEarlierMessages, core.handleInterruptAgent, core.handleCallMethod,
    feedback.onFeedbackDismiss, feedback.onFeedbackError, debug.setDebugConsoleAgent, debug.onDismissDirtyWarning, reset,
    onAddAgent, onFocusPanel, onReloadPanel,
    chatTools.toolApprovalValue,
  ]);

  return { contextValue, inputContextValue: core.inputContextValue };
}
