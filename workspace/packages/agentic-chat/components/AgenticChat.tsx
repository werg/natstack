import type { ChannelConfig } from "@workspace/agentic-messaging";
import { Theme } from "@radix-ui/themes";
import { ErrorBoundary } from "./ErrorBoundary";
import { ChatLayout } from "./ChatLayout";
import { ChatProvider } from "../context/ChatProvider";
import { useAgenticChat } from "../hooks/useAgenticChat";
import type { ChatParticipantMetadata, ConnectionConfig, AgenticChatActions, ToolProvider } from "../types";
import type { EventMiddleware } from "../hooks/useAgentEvents";

export interface AgenticChatProps {
  /** Connection configuration (server URL, token, client ID) */
  config: ConnectionConfig;
  /** Channel name to connect to */
  channelName: string;
  /** Channel configuration */
  channelConfig?: ChannelConfig;
  /** Context ID for channel authorization */
  contextId?: string;
  /** Participant metadata */
  metadata?: ChatParticipantMetadata;
  /** Tool provider factory */
  tools?: ToolProvider;
  /** Platform-specific actions */
  actions?: AgenticChatActions;
  /** Theme */
  theme?: "light" | "dark";
  /** Agents being spawned */
  pendingAgents?: Array<{ agentId: string; handle: string }>;
  /** Optional event middleware */
  eventMiddleware?: EventMiddleware[];
}

/**
 * High-level drop-in agentic chat component.
 *
 * Composes useAgenticChat() → ErrorBoundary → ChatProvider → ChatLayout.
 *
 * For custom layouts, use useAgenticChat() + ChatProvider + individual components directly.
 */
export function AgenticChat({
  config,
  channelName,
  channelConfig,
  contextId,
  metadata,
  tools,
  actions,
  theme,
  pendingAgents: pendingAgentInfos,
  eventMiddleware,
}: AgenticChatProps) {
  const { contextValue, inputContextValue } = useAgenticChat({
    config,
    channelName,
    channelConfig,
    contextId,
    metadata,
    tools,
    actions,
    theme,
    pendingAgentInfos,
    eventMiddleware,
  });

  return (
    <ErrorBoundary>
      {/* Theme is applied here (above ChatProvider) rather than in ChatLayout
          so that ChatLayout does NOT read from context. This prevents
          keystroke-driven context updates from re-rendering ChatLayout and
          causing layout shifts that break autoscroll. */}
      <Theme appearance={contextValue.theme ?? "dark"}>
        <ChatProvider value={contextValue} inputValue={inputContextValue}>
          <ChatLayout />
        </ChatProvider>
      </Theme>
    </ErrorBoundary>
  );
}
