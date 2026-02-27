/**
 * AddAgentDialog — Centered modal for adding agents to an existing channel.
 *
 * Uses Radix Dialog to overlay the agent setup UI on top of the chat.
 */

import { useState, useCallback, useEffect } from "react";
import { Dialog, Flex } from "@radix-ui/themes";
import { pubsubConfig, rpc, id } from "@workspace/runtime";
import { connect, type AgenticClient } from "@workspace/agentic-messaging";
import {
  useAgentSelection,
  DEFAULT_SESSION_CONFIG,
  type SessionConfig,
} from "../hooks/useAgentSelection";
import { AgentSetupPhase } from "./AgentSetupPhase";
import type { GlobalAgentSettings } from "@natstack/types";

interface AddAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelName: string;
  contextId?: string;
}

export function AddAgentDialog({ open, onOpenChange, channelName, contextId }: AddAgentDialogProps) {
  const [status, setStatus] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [globalSettingsLoaded, setGlobalSettingsLoaded] = useState(false);

  const [sessionConfig, setSessionConfig] = useState<SessionConfig>(() => ({
    ...DEFAULT_SESSION_CONFIG,
  }));

  // Reset transient state when dialog opens
  useEffect(() => {
    if (open) {
      setIsStarting(false);
      setStatus(null);
    }
  }, [open]);

  // Load global settings when dialog opens
  useEffect(() => {
    if (!open || globalSettingsLoaded) return;

    async function applyGlobalSettings() {
      try {
        const global = await rpc.call<GlobalAgentSettings>("main", "agentSettings.getGlobalSettings");
        setSessionConfig((prev) => ({
          ...prev,
          defaultAutonomy: global.defaultAutonomy,
        }));
      } catch (err) {
        console.warn("[AddAgentDialog] Failed to load global settings:", err);
      } finally {
        setGlobalSettingsLoaded(true);
      }
    }

    void applyGlobalSettings();
  }, [open, globalSettingsLoaded]);

  const {
    agentsWithRequirements,
    selectionStatus,
    toggleAgentSelection,
    updateAgentConfig,
    buildSpawnConfig,
    deselectAll,
  } = useAgentSelection({ sessionConfig });

  // Reset selections when dialog opens to prevent accidental duplicate invites
  useEffect(() => {
    if (open) {
      deselectAll();
    }
  }, [open, deselectAll]);

  const addAgents = useCallback(async () => {
    if (!pubsubConfig) return;

    const selectedAgents = agentsWithRequirements.filter((a) => a.selected);
    if (selectedAgents.length === 0) {
      setStatus("Please select at least one agent");
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

    let client: AgenticClient | null = null;

    try {
      client = await connect({
        serverUrl: pubsubConfig.serverUrl,
        token: pubsubConfig.token,
        channel: channelName,
        contextId,
        handle: `launcher-${id}`,
        name: "Add Agent",
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
          console.warn(`[AddAgentDialog] Failed to invite agent ${agent.agent.name}:`, err);
        });
      }

      await client.close();
      client = null;
      onOpenChange(false);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      setIsStarting(false);
      if (client) {
        try { await client.close(); } catch { /* ignore */ }
      }
    }
  }, [agentsWithRequirements, buildSpawnConfig, channelName, contextId, onOpenChange]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        style={{
          maxWidth: 600,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Flex direction="column" style={{ flex: 1, overflow: "hidden" }}>
          <AgentSetupPhase
            selectionStatus={selectionStatus}
            availableAgents={agentsWithRequirements}
            sessionConfig={sessionConfig}
            channelId={channelName}
            status={status}
            isStarting={isStarting}
            isChannelMode={true}
            onSessionConfigChange={setSessionConfig}
            onChannelIdChange={() => {}}
            onToggleAgent={toggleAgentSelection}
            onUpdateConfig={updateAgentConfig}
            onStartChat={() => void addAgents()}
          />
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
