/**
 * useAgenticChat — Thin composer hook.
 *
 * Composes useChatCore + all feature hooks (roster tracking, pending agents,
 * feedback, tools, debug, inline UI) into the full ChatContextValue.
 *
 * For minimal chat (no tools, no feedback, no debug), use useChatCore directly.
 */

import { useCallback, useMemo, useRef, useEffect } from "react";
import { z } from "zod";
import type { ChannelConfig, MethodDefinition } from "@natstack/pubsub";
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
        const approvalMethod = chatToolsRef.current.buildApprovalMethod();

        const methods: Record<string, MethodDefinition> = {
          ...feedbackMethods,
          ...toolMethods,
          ...approvalMethod,
          set_title: {
            description: "Set the conversation title",
            parameters: z.object({ title: z.string().describe("The new title") }),
            execute: async (args: unknown) => {
              const { title } = args as { title: string };
              if (!title) return { ok: false, error: "Missing title" };
              document.title = title;
              const client = core.clientRef.current;
              if (client) {
                try { await client.updateChannelConfig({ title }); } catch { /* best-effort */ }
              }
              return { ok: true };
            },
          },
          inline_ui: {
            description: `Render a persistent interactive UI component inline in the chat. Use for:

1. **Rich data presentation** — tables, charts, interactive visualizations, formatted output that plain text can't capture well.
2. **User-triggered actions** — buttons/controls that let the user trigger side-effects in their environment on demand (copy to clipboard, open files, run scripts, apply changes). The user decides when and whether to act.

**Contrast with other tools:**
- \`eval\`: Agent-triggered side-effects. The agent runs code immediately. Use eval when the agent should act now.
- \`inline_ui\`: User-triggered side-effects. The agent renders controls, the user clicks when ready. Use inline_ui when the user should decide when to act.
- \`feedback_form\`/\`feedback_custom\`: Blocks and waits for the user to respond. Use when the agent needs information back before continuing.

**inline_ui is non-blocking** — returns immediately after rendering. The component stays in chat history. Results do NOT flow back to the agent.

**Component receives** \`{ props }\` — pass data via the \`props\` parameter.
**Available imports**: \`react\`, \`@radix-ui/themes\`, \`@radix-ui/react-icons\`
**Must use** \`export default\`

**Example — interactive data with action button:**
\`\`\`tsx
import { useState } from "react";
import { Button, Flex, Text, Table } from "@radix-ui/themes";
import { CopyIcon, CheckIcon } from "@radix-ui/react-icons";

export default function App({ props }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(props.data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Flex direction="column" gap="2">
      <Table.Root size="1">
        <Table.Header>
          <Table.Row>
            {props.columns.map(c => <Table.ColumnHeaderCell key={c}>{c}</Table.ColumnHeaderCell>)}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {props.data.map((row, i) => (
            <Table.Row key={i}>
              {props.columns.map(c => <Table.Cell key={c}>{row[c]}</Table.Cell>)}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      <Button size="1" variant="soft" onClick={handleCopy}>
        {copied ? <><CheckIcon /> Copied</> : <><CopyIcon /> Copy as JSON</>}
      </Button>
    </Flex>
  );
}
\`\`\``,
            parameters: z.object({
              code: z.string().describe("TSX source code for the component"),
              props: z.record(z.unknown()).optional().describe("Props passed to the component as { props }"),
            }),
            execute: async (args: unknown) => {
              const { code, props } = args as { code: string; props?: Record<string, unknown> };
              if (!code) return { ok: false, error: "Missing code" };
              const client = core.clientRef.current;
              if (!client) return { ok: false, error: "Not connected" };
              const id = crypto.randomUUID();
              const data = JSON.stringify({ id, code, props });
              await client.publish("message", { id, content: data, contentType: "inline_ui" }, { persist: true });
              return { ok: true, id };
            },
          },
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

  // --- Wrap platform actions ---
  const handleAddAgent = useCallback(async (agentId?: string) => {
    if (!actions?.onAddAgent) return;
    const launcherContextId = core.clientRef.current?.contextId;
    const result = await actions.onAddAgent(channelName, launcherContextId, agentId);
    // If the callback returns agent info, track it as pending for badge/timeout feedback
    if (result?.agentId && result?.handle) {
      pending.setPendingAgents(prev => {
        const next = new Map(prev);
        next.set(result.handle, { agentId: result.agentId, status: "starting" });
        return next;
      });
    }
  }, [channelName, core.clientRef, actions, pending.setPendingAgents]);

  const handleRemoveAgent = useCallback(async (handle: string) => {
    if (!actions?.onRemoveAgent) return;
    await actions.onRemoveAgent(channelName, handle);
  }, [channelName, actions]);

  const sessionEnabled = true; // Always persistent — messages stored in PubSub messageStore
  const onAddAgent = actions?.onAddAgent ? handleAddAgent : undefined;
  const availableAgents = actions?.availableAgents;
  const onRemoveAgent = actions?.onRemoveAgent ? handleRemoveAgent : undefined;
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
    onAddAgent,
    availableAgents,
    onRemoveAgent,
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
    feedback.onFeedbackDismiss, feedback.onFeedbackError, debug.setDebugConsoleAgent, debug.onDismissDirtyWarning,
    onAddAgent, availableAgents, onRemoveAgent, onFocusPanel, onReloadPanel,
    chatTools.toolApprovalValue,
  ]);

  return { contextValue, inputContextValue: core.inputContextValue };
}
