/**
 * Chat Launcher Panel
 *
 * Lightweight panel for agent discovery, selection, and invitation.
 * In new chat mode: After successfully inviting agents, navigates to the chat panel.
 * In channel mode (CHANNEL_NAME set): After inviting agents, closes self (if ephemeral) or navigates back.
 */

import { useState, useCallback } from "react";
import { pubsubConfig, buildNsLink, closeSelf, isEphemeral } from "@natstack/runtime";
import { usePanelTheme } from "@natstack/react";
import { Theme } from "@radix-ui/themes";
import { useDiscovery } from "./hooks/useDiscovery";
import { AgentSetupPhase } from "./components/AgentSetupPhase";

const generateChannelId = () => `chat-${crypto.randomUUID().slice(0, 8)}`;

/** Get existing channel name from env if present (channel modification mode) */
const existingChannelName = process.env["CHANNEL_NAME"]?.trim() || null;

export default function ChatLauncher() {
  const theme = usePanelTheme();
  const workspaceRoot = process.env["NATSTACK_WORKSPACE"]?.trim();

  // Channel modification mode: existing channel was passed via CHANNEL_NAME env var
  const isChannelMode = existingChannelName !== null;

  const [channelId, setChannelId] = useState<string>(existingChannelName ?? generateChannelId);
  const [status, setStatus] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const {
    discoveryRef,
    availableAgents,
    discoveryStatus,
    toggleAgentSelection,
    updateAgentConfig,
    buildInviteConfig,
  } = useDiscovery({ workspaceRoot });

  const startChat = useCallback(async () => {
    const discovery = discoveryRef.current;
    if (!discovery || !pubsubConfig) return;

    // Check connection state before attempting invites
    if (!discovery.connected) {
      setStatus("Not connected to discovery service. Please wait for reconnection.");
      console.warn("[Chat Launcher] Attempted invite while disconnected");
      return;
    }

    const selectedAgents = availableAgents.filter((a) => a.selected);
    if (selectedAgents.length === 0) {
      setStatus("Please select at least one agent");
      return;
    }

    // Validate required parameters before sending invites
    const validationErrors: string[] = [];
    for (const agent of selectedAgents) {
      const requiredParams = agent.agentType.parameters?.filter((p) => p.required) ?? [];
      for (const param of requiredParams) {
        const value = agent.config[param.key];
        const hasValue = value !== undefined && value !== "";
        const hasDefault = param.default !== undefined;
        if (!hasValue && !hasDefault) {
          validationErrors.push(`${agent.agentType.name}: "${param.label}" is required`);
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
      // Invite all selected agents with their configured parameters
      const invitePromises = selectedAgents.map(async (agent) => {
        const filteredConfig = buildInviteConfig(agent);

        try {
          const result = discovery.invite(agent.broker.brokerId, agent.agentType.id, targetChannelId, {
            context: "User wants to chat",
            config: filteredConfig,
          });
          const response = await result.response;
          return { agent, response, error: null };
        } catch (err) {
          // Capture invite errors per-agent
          const errorMsg = err instanceof Error ? err.message : String(err);
          return {
            agent,
            response: null,
            error: errorMsg,
          };
        }
      });

      const results = await Promise.all(invitePromises);

      // Separate successful and failed invites
      const succeeded = results.filter((r) => r.response?.accepted);
      const declined = results.filter((r) => r.response && !r.response.accepted);
      const errored = results.filter((r) => r.error !== null);

      // Check if all invites failed
      if (succeeded.length === 0) {
        // Build detailed error message
        const errorParts: string[] = [];

        if (errored.length > 0) {
          const errorDetails = errored
            .map((r) => `${r.agent.agentType.name}: ${r.error}`)
            .join("\n");
          errorParts.push(`Invite errors:\n${errorDetails}`);
        }

        if (declined.length > 0) {
          const declineDetails = declined
            .map((r) => {
              const reason = r.response?.declineReason || "Unknown reason";
              const code = r.response?.declineCode ? ` (${r.response.declineCode})` : "";
              return `${r.agent.agentType.name}: ${reason}${code}`;
            })
            .join("\n");
          errorParts.push(`Declined:\n${declineDetails}`);
        }

        setStatus(errorParts.length > 0 ? errorParts.join("\n\n") : "All invites failed");
        setIsStarting(false);
        return;
      }

      // Log partial failures but continue if at least one succeeded
      if (declined.length > 0 || errored.length > 0) {
        const failedNames = [...declined, ...errored]
          .map((r) => r.agent.agentType.name)
          .join(", ");
        console.warn(`[Chat Launcher] Some agents failed to join: ${failedNames}`);
      }

      // Post-invite behavior depends on mode
      if (isChannelMode) {
        // Channel modification mode: try to close self if ephemeral, otherwise navigate back
        if (isEphemeral) {
          try {
            await closeSelf();
            return; // Panel closed, done
          } catch (err) {
            console.warn("[Chat Launcher] Failed to close self:", err);
            // Fall through to navigation
          }
        }
        // Fallback: navigate back to the chat panel
        const chatUrl = buildNsLink("panels/chat", {
          action: "navigate",
          env: { CHANNEL_NAME: targetChannelId },
        });
        window.location.href = chatUrl;
      } else {
        // New chat mode: navigate to the chat panel with the channel ID
        const chatUrl = buildNsLink("panels/chat", {
          action: "navigate",
          env: { CHANNEL_NAME: targetChannelId },
        });
        window.location.href = chatUrl;
      }
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      setIsStarting(false);
    }
  }, [availableAgents, buildInviteConfig, discoveryRef, channelId, isChannelMode]);

  return (
    <Theme appearance={theme}>
      <AgentSetupPhase
        discoveryStatus={discoveryStatus}
        availableAgents={availableAgents}
        channelId={channelId}
        status={status}
        isStarting={isStarting}
        isChannelMode={isChannelMode}
        onChannelIdChange={setChannelId}
        onToggleAgent={toggleAgentSelection}
        onUpdateConfig={updateAgentConfig}
        onStartChat={() => void startChat()}
      />
    </Theme>
  );
}
