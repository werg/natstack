/**
 * Chat Launcher Panel
 *
 * Lightweight panel for agent selection and spawning.
 * Reads agent definitions from SQLite registry and spawns workers directly.
 * In new chat mode: After spawning agents, navigates to the chat panel.
 * In channel mode (channelName set): After spawning agents, closes self or navigates back.
 */

import { useState, useCallback } from "react";
import { pubsubConfig, buildNsLink, closeSelf, getStateArgs, createChild, rpc } from "@natstack/runtime";
import { usePanelTheme } from "@natstack/react";
import { Theme } from "@radix-ui/themes";
import {
  useAgentSelection,
  DEFAULT_SESSION_CONFIG,
  toChannelConfig,
  type SessionConfig,
} from "./hooks/useAgentSelection";
import { AgentSetupPhase } from "./components/AgentSetupPhase";

const generateChannelId = () => `chat-${crypto.randomUUID().slice(0, 8)}`;

/** Type for chat-launcher state args */
interface ChatLauncherStateArgs {
  channelName?: string;
  /** Existing channel's contextId - required when adding agents to an existing channel */
  contextId?: string;
}

/** Get state args for channel mode */
const stateArgs = getStateArgs<ChatLauncherStateArgs>();
const existingChannelName = stateArgs.channelName?.trim() || null;
const existingContextId = stateArgs.contextId?.trim() || null;

export default function ChatLauncher() {
  const theme = usePanelTheme();
  const workspaceRoot = process.env["NATSTACK_WORKSPACE"]?.trim();

  // Channel modification mode: existing channel was passed via stateArgs
  const isChannelMode = existingChannelName !== null;

  const [channelId, setChannelId] = useState<string>(existingChannelName ?? generateChannelId);
  const [status, setStatus] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  // Session config - includes channel config (workingDirectory, restrictedMode) and session defaults
  const [sessionConfig, setSessionConfig] = useState<SessionConfig>(() => ({
    ...DEFAULT_SESSION_CONFIG,
    workingDirectory: workspaceRoot ?? "",
  }));

  const {
    agentsWithRequirements,
    selectionStatus,
    toggleAgentSelection,
    updateAgentConfig,
    buildSpawnConfig,
  } = useAgentSelection({ workspaceRoot, sessionConfig });

  const startChat = useCallback(async () => {
    if (!pubsubConfig) return;

    const selectedAgents = agentsWithRequirements.filter((a) => a.selected);
    if (selectedAgents.length === 0) {
      setStatus("Please select at least one agent");
      return;
    }

    // Check for unmet channel requirements (shouldn't happen since agents with unmet requirements can't be selected)
    const agentsWithUnmetReqs = selectedAgents.filter((a) => a.unmetRequirements.length > 0);
    if (agentsWithUnmetReqs.length > 0) {
      const details = agentsWithUnmetReqs
        .map((a) => `${a.agent.name}: requires ${a.unmetRequirements.join(", ")}`)
        .join("\n");
      setStatus(`Missing channel configuration:\n${details}`);
      return;
    }

    // Validate required per-agent parameters (skip channelLevel - validated above)
    const validationErrors: string[] = [];
    for (const agent of selectedAgents) {
      const requiredParams = agent.agent.parameters?.filter((p) => p.required && !p.channelLevel) ?? [];
      for (const param of requiredParams) {
        const value = agent.config[param.key];
        const hasValue = value !== undefined && value !== "";
        const hasDefault = param.default !== undefined;
        if (!hasValue && !hasDefault) {
          validationErrors.push(`${agent.agent.name}: "${param.label}" is required`);
        }
      }
    }

    if (validationErrors.length > 0) {
      setStatus(`Missing required parameters:\n${validationErrors.join("\n")}`);
      return;
    }

    setIsStarting(true);
    setStatus(null);

    // Use the channel ID from state (user may have edited it)
    const targetChannelId = channelId.trim() || generateChannelId();

    try {
      // Determine context ID:
      // 1. Channel mode with existing contextId: use it (adding agents to existing channel)
      // 2. Browser mode with template: create sandbox context
      // 3. Otherwise: generate a new UUID
      let contextId: string;
      if (isChannelMode && existingContextId) {
        // Adding agents to existing channel - must use the channel's contextId
        contextId = existingContextId;
      } else if (sessionConfig.projectLocation === "browser" && sessionConfig.contextTemplateSpec) {
        setStatus("Creating sandbox context...");
        contextId = await rpc.call<string>(
          "main",
          "bridge.createContextFromTemplate",
          sessionConfig.contextTemplateSpec
        );
      } else {
        // New chat in local mode: generate a unique context ID for session persistence
        contextId = crypto.randomUUID();
      }

      // Derive channel config from session config, include contextId
      const channelConfig = {
        ...toChannelConfig(sessionConfig),
        contextId,
      };
      // Spawn all selected agents directly via createChild
      const spawnPromises = selectedAgents.map(async (agent) => {
        const config = buildSpawnConfig(agent);

        try {
          // Spawn worker directly
          // Pass channelConfig values via stateArgs to avoid race condition where workers
          // connect before chat panel and create the channel without config
          await createChild(
            agent.agent.workerSource,
            { name: `${agent.agent.id}-${targetChannelId.slice(0, 8)}` },
            {
              channel: targetChannelId,
              handle: agent.agent.proposedHandle,
              // Channel config values passed directly to avoid timing issues
              workingDirectory: channelConfig.workingDirectory,
              restrictedMode: channelConfig.restrictedMode,
              contextId: channelConfig.contextId,
              ...config,
            }
          );
          return { agent, error: null };
        } catch (err) {
          // Capture spawn errors per-agent
          const errorMsg = err instanceof Error ? err.message : String(err);
          return { agent, error: errorMsg };
        }
      });

      const results = await Promise.all(spawnPromises);

      // Separate successful and failed spawns
      const succeeded = results.filter((r) => r.error === null);
      const failed = results.filter((r) => r.error !== null);

      // Check if all spawns failed - still navigate to chat panel
      // The agent recovery system in chat will show build errors and allow retry
      if (succeeded.length === 0) {
        const errorDetails = failed
          .map((r) => `${r.agent.agent.name}: ${r.error}`)
          .join("\n");
        console.warn(`[Chat Launcher] All agent spawns failed, proceeding to chat anyway:\n${errorDetails}`);
        // Don't return - fall through to navigate to chat panel
      }

      // Log partial failures but continue if at least one succeeded
      if (failed.length > 0) {
        const failedNames = failed.map((r) => r.agent.agent.name).join(", ");
        console.warn(`[Chat Launcher] Some agents failed to spawn: ${failedNames}`);
      }

      // Post-spawn behavior depends on mode
      if (isChannelMode) {
        // Channel modification mode: try to close self, otherwise navigate back
        try {
          await closeSelf();
          return; // Panel closed, done
        } catch (err) {
          console.warn("[Chat Launcher] Failed to close self:", err);
          // Fall through to navigation
        }
        // Fallback: navigate back to the chat panel
        const chatUrl = buildNsLink("panels/chat", {
          action: "navigate",
          stateArgs: { channelName: targetChannelId },
        });
        window.location.href = chatUrl;
      } else {
        // New chat mode: navigate to the chat panel with channel ID and config
        const chatUrl = buildNsLink("panels/chat", {
          action: "navigate",
          stateArgs: { channelName: targetChannelId, channelConfig },
        });
        window.location.href = chatUrl;
      }
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      setIsStarting(false);
    }
  }, [agentsWithRequirements, buildSpawnConfig, channelId, isChannelMode, sessionConfig]);

  return (
    <Theme appearance={theme}>
      <AgentSetupPhase
        selectionStatus={selectionStatus}
        availableAgents={agentsWithRequirements}
        sessionConfig={sessionConfig}
        channelId={channelId}
        status={status}
        isStarting={isStarting}
        isChannelMode={isChannelMode}
        onSessionConfigChange={setSessionConfig}
        onChannelIdChange={setChannelId}
        onToggleAgent={toggleAgentSelection}
        onUpdateConfig={updateAgentConfig}
        onStartChat={() => void startChat()}
      />
    </Theme>
  );
}
