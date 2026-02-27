/**
 * ChatSetup — Setup phase for agent selection and chat creation.
 *
 * Extracted from the former chat-launcher panel. Handles global settings
 * loading, agent selection, validation, pubsub connection for invites,
 * and transitions to the chat phase on completion.
 */

import { useState, useCallback, useEffect } from "react";
import { pubsubConfig, rpc, db, id } from "@workspace/runtime";
import { setDbOpen, connect, type AgenticClient } from "@workspace/agentic-messaging";
import {
  useAgentSelection,
  DEFAULT_SESSION_CONFIG,
  type SessionConfig,
} from "../hooks/useAgentSelection";
import { AgentSetupPhase } from "./AgentSetupPhase";
import type { GlobalAgentSettings } from "@natstack/types";

// Configure agentic-messaging to use runtime's db
setDbOpen(db.open);

const generateChannelId = () => `chat-${crypto.randomUUID().slice(0, 8)}`;

export interface ChatSetupResult {
  channelName: string;
  contextId: string;
  pendingAgents: Array<{ agentId: string; handle: string }>;
}

interface ChatSetupProps {
  onComplete: (result: ChatSetupResult) => void;
}

export function ChatSetup({ onComplete }: ChatSetupProps) {
  const [channelId, setChannelId] = useState<string>(generateChannelId);
  const [status, setStatus] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [globalSettingsLoaded, setGlobalSettingsLoaded] = useState(false);

  const [sessionConfig, setSessionConfig] = useState<SessionConfig>(() => ({
    ...DEFAULT_SESSION_CONFIG,
  }));

  // Load global settings on mount
  useEffect(() => {
    if (globalSettingsLoaded) return;

    async function applyGlobalSettings() {
      try {
        const global = await rpc.call<GlobalAgentSettings>("main", "agentSettings.getGlobalSettings");
        setSessionConfig((prev) => ({
          ...prev,
          defaultAutonomy: global.defaultAutonomy,
        }));
      } catch (err) {
        console.warn("[ChatSetup] Failed to load global settings:", err);
      } finally {
        setGlobalSettingsLoaded(true);
      }
    }

    void applyGlobalSettings();
  }, [globalSettingsLoaded]);

  const {
    agentsWithRequirements,
    selectionStatus,
    toggleAgentSelection,
    updateAgentConfig,
    buildSpawnConfig,
  } = useAgentSelection({ sessionConfig });

  const startChat = useCallback(async () => {
    if (!pubsubConfig) return;

    const selectedAgents = agentsWithRequirements.filter((a) => a.selected);
    if (selectedAgents.length === 0) {
      setStatus("Please select at least one agent");
      return;
    }

    const agentsWithUnmetReqs = selectedAgents.filter((a) => a.unmetRequirements.length > 0);
    if (agentsWithUnmetReqs.length > 0) {
      const details = agentsWithUnmetReqs
        .map((a) => `${a.agent.name}: requires ${a.unmetRequirements.join(", ")}`)
        .join("\n");
      setStatus(`Missing channel configuration:\n${details}`);
      return;
    }

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

    const targetChannelId = channelId.trim() || generateChannelId();
    let client: AgenticClient | null = null;

    try {
      const contextId = crypto.randomUUID();

      setStatus("Connecting to channel...");
      client = await connect({
        serverUrl: pubsubConfig.serverUrl,
        token: pubsubConfig.token,
        channel: targetChannelId,
        contextId,
        handle: `launcher-${id}`,
        name: "Chat Launcher",
        type: "panel",
        replayMode: "skip",
      });

      for (const agent of selectedAgents) {
        const config = buildSpawnConfig(agent);
        client.inviteAgent(agent.agent.id, {
          handle: agent.agent.proposedHandle ?? agent.agent.id,
          config: {
            contextId,
            ...config,
          },
        }).catch((err: unknown) => {
          console.warn(`[ChatSetup] Failed to invite agent ${agent.agent.name}:`, err);
        });
      }

      await client.close();
      client = null;

      onComplete({
        channelName: targetChannelId,
        contextId,
        pendingAgents: selectedAgents.map((a) => ({
          agentId: a.agent.id,
          handle: a.agent.proposedHandle ?? a.agent.id,
        })),
      });
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      setIsStarting(false);
      if (client) {
        try { await client.close(); } catch { /* ignore */ }
      }
    }
  }, [agentsWithRequirements, buildSpawnConfig, channelId, onComplete]);

  return (
    <AgentSetupPhase
      selectionStatus={selectionStatus}
      availableAgents={agentsWithRequirements}
      sessionConfig={sessionConfig}
      channelId={channelId}
      status={status}
      isStarting={isStarting}
      isChannelMode={false}
      onSessionConfigChange={setSessionConfig}
      onChannelIdChange={setChannelId}
      onToggleAgent={toggleAgentSelection}
      onUpdateConfig={updateAgentConfig}
      onStartChat={() => void startChat()}
    />
  );
}
