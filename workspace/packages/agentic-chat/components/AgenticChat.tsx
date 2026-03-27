import type { ChannelConfig } from "@natstack/pubsub";
import { Theme } from "@radix-ui/themes";
import { ErrorBoundary } from "./ErrorBoundary";
import { ChatLayout } from "./ChatLayout";
import { ChatProvider } from "../context/ChatProvider";
import { useAgenticChat } from "../hooks/useAgenticChat";
import type { ChatParticipantMetadata, ConnectionConfig, AgenticChatActions, ToolProvider, SandboxConfig } from "../types";
import type { EventMiddleware } from "@workspace/agentic-core";

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
  /** If set, automatically sent as the first user message once connected */
  initialPrompt?: string;
  /** Sandbox config — provides RPC and import loading */
  sandbox: SandboxConfig;
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
  initialPrompt,
  sandbox,
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
    initialPrompt,
    sandbox,
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
