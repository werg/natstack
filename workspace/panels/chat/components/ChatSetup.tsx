/**
 * ChatSetup — Setup phase for agent selection and chat creation.
 *
 * Extracted from the former chat-launcher panel. Handles global settings
 * loading, agent selection, validation, pubsub connection for invites,
 * and transitions to the chat phase on completion.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { pubsubConfig, rpc, db, id } from "@workspace/runtime";
import { setDbOpen, connect, type AgenticClient } from "@workspace/agentic-messaging";
import {
  useAgentSelection,
  DEFAULT_SESSION_CONFIG,
  type SessionConfig,
  type AgentSelectionWithRequirements,
} from "../hooks/useAgentSelection";
import { AgentSetupPhase } from "./AgentSetupPhase";
import { Flex, Spinner, Text } from "@radix-ui/themes";
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
  const [globalSettings, setGlobalSettings] = useState<GlobalAgentSettings | null>(null);
  const [autoStarting, setAutoStarting] = useState(false);
  const autoStartAttempted = useRef(false);

  const [sessionConfig, setSessionConfig] = useState<SessionConfig>(() => ({
    ...DEFAULT_SESSION_CONFIG,
  }));

  // Load global settings on mount
  useEffect(() => {
    if (globalSettingsLoaded) return;

    async function applyGlobalSettings() {
      try {
        const global = await rpc.call<GlobalAgentSettings>("main", "agentSettings.getGlobalSettings");
        setGlobalSettings(global);
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
    isLoading,
    loadError,
    selectionStatus,
    toggleAgentSelection,
    updateAgentConfig,
    buildSpawnConfig,
  } = useAgentSelection({ sessionConfig });

  /**
   * Shared launch path — validates, connects, invites agents, completes.
   * Used by both manual startChat (button) and auto-start effect.
   */
  const launchChat = useCallback(async (agents: AgentSelectionWithRequirements[]) => {
    if (!pubsubConfig) {
      setStatus("Pubsub not configured");
      setIsStarting(false);
      return;
    }

    const agentsWithUnmetReqs = agents.filter((a) => a.unmetRequirements.length > 0);
    if (agentsWithUnmetReqs.length > 0) {
      const details = agentsWithUnmetReqs
        .map((a) => `${a.agent.name}: requires ${a.unmetRequirements.join(", ")}`)
        .join("\n");
      setStatus(`Missing channel configuration:\n${details}`);
      setIsStarting(false);
      return;
    }

    const validationErrors: string[] = [];
    for (const agent of agents) {
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
      setIsStarting(false);
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

      for (const agent of agents) {
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
        pendingAgents: agents.map((a) => ({
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
  }, [buildSpawnConfig, channelId, onComplete]);

  /** Manual start — validates selection, then launches */
  const startChat = useCallback(async () => {
    const selectedAgents = agentsWithRequirements.filter((a) => a.selected);
    if (selectedAgents.length === 0) {
      setStatus("Please select at least one agent");
      return;
    }
    await launchChat(selectedAgents);
  }, [agentsWithRequirements, launchChat]);

  // Auto-start: when both global settings and agents are loaded, try to skip the selection UI
  useEffect(() => {
    if (autoStartAttempted.current) return;
    if (!globalSettingsLoaded || isLoading || loadError) return;

    autoStartAttempted.current = true;

    const eligible = agentsWithRequirements.filter((a) => a.unmetRequirements.length === 0);

    // Fallback chain: explicit default → claude-code-responder → single agent → show UI
    const defaultId = globalSettings?.defaultAgent ?? null;
    const target =
      (defaultId && eligible.find((a) => a.agent.id === defaultId)) ||
      eligible.find((a) => a.agent.id === "claude-code-responder") ||
      (eligible.length === 1 ? eligible[0] : null);

    if (target) {
      setAutoStarting(true);
      setIsStarting(true);
      setStatus("Starting chat...");
      void launchChat([target]).finally(() => setAutoStarting(false));
    }
  }, [globalSettingsLoaded, isLoading, loadError, agentsWithRequirements, globalSettings, launchChat]);

  // Show loading indicator during auto-start only (not manual start)
  if (autoStarting && !status?.startsWith("Error")) {
    return (
      <Flex align="center" justify="center" gap="2" style={{ flex: 1 }}>
        <Spinner />
        <Text size="2" color="gray">{status ?? "Starting chat..."}</Text>
      </Flex>
    );
  }

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
