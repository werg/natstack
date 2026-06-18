import type { ChannelConfig } from "@workspace/pubsub";
import { Theme } from "@radix-ui/themes";
import { ErrorBoundary } from "./ErrorBoundary";
import { ChatLayout } from "./ChatLayout";
import { ChatProvider } from "../context/ChatProvider";
import { useAgenticChat } from "../hooks/useAgenticChat";
import type { ChatParticipantMetadata, ConnectionConfig, AgenticChatActions, ToolProvider, SandboxConfig } from "../types";

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
  /** Agents installed for this channel; shown as pending until they join the roster */
  installedAgents?: Array<{ agentId: string; handle: string }>;
  /** If set, automatically sent as the first user message once connected */
  initialPrompt?: string;
  /** Send initialPrompt even if the channel already has history (idempotent). */
  forceInitialPrompt?: boolean;
  /** Sandbox config — provides RPC and import loading */
  sandbox: SandboxConfig;
  /** Context-relative TSX file to load into the panel-local action bar on mount */
  initialActionBarFile?: string;
  /** Props for initialActionBarFile */
  initialActionBarProps?: Record<string, unknown>;
  /** Preferred max height for initialActionBarFile */
  initialActionBarMaxHeight?: number;
  /** Persist action-bar file changes into the hosting panel state, if supported */
  onActionBarFileChange?: (value: { path: string | null; props?: Record<string, unknown>; maxHeight?: number }) => void | Promise<void>;
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
  installedAgents: installedAgentInfos,
  initialPrompt,
  forceInitialPrompt,
  sandbox,
  initialActionBarFile,
  initialActionBarProps,
  initialActionBarMaxHeight,
  onActionBarFileChange,
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
    installedAgentInfos,
    initialPrompt,
    forceInitialPrompt,
    sandbox,
    initialActionBarFile,
    initialActionBarProps,
    initialActionBarMaxHeight,
    onActionBarFileChange,
  });

  return (
    <ErrorBoundary surfaceName="chat panel">
      {/* Theme is applied here (above ChatProvider) rather than in ChatLayout
          so that ChatLayout does NOT read from context. This prevents
          keystroke-driven context updates from re-rendering ChatLayout and
          causing layout shifts that break autoscroll. */}
      <Theme
        appearance={contextValue.theme ?? "dark"}
        style={{ minWidth: 0, width: "100%", height: "100%" }}
      >
        <ChatProvider value={contextValue} inputValue={inputContextValue}>
          <ChatLayout />
        </ChatProvider>
      </Theme>
    </ErrorBoundary>
  );
}
