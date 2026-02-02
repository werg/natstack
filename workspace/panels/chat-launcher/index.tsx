/**
 * Chat Launcher Panel
 *
 * Lightweight panel for agent selection and spawning.
 * Reads agent definitions from SQLite registry and spawns workers directly.
 * In new chat mode: After spawning agents, navigates to the chat panel.
 * In channel mode (channelName set): After spawning agents, closes self or navigates back.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { pubsubConfig, buildNsLink, closeSelf, getStateArgs, rpc, db, id } from "@natstack/runtime";
import { setDbOpen, connect, type AgenticClient, type AgentBuildError } from "@natstack/agentic-messaging";

// Configure agentic-messaging to use runtime's db
setDbOpen(db.open);

import { usePanelTheme } from "@natstack/react";
import { Theme } from "@radix-ui/themes";
import {
  useAgentSelection,
  DEFAULT_SESSION_CONFIG,
  toChannelConfig,
  type SessionConfig,
} from "./hooks/useAgentSelection";
import { AgentSetupPhase } from "./components/AgentSetupPhase";
import {
  loadGlobalSettings,
  type GlobalAgentSettings,
} from "@workspace-panels/agent-manager";

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
  const [globalSettingsLoaded, setGlobalSettingsLoaded] = useState(false);

  // Session config - includes channel config (workingDirectory, restrictedMode) and session defaults
  // Initial values are from DEFAULT_SESSION_CONFIG, then overwritten by global settings
  const [sessionConfig, setSessionConfig] = useState<SessionConfig>(() => ({
    ...DEFAULT_SESSION_CONFIG,
    workingDirectory: workspaceRoot ?? "",
  }));

  // Load global settings and apply to session config (only on first mount)
  useEffect(() => {
    if (globalSettingsLoaded) return;

    async function applyGlobalSettings() {
      try {
        const global = await loadGlobalSettings();
        setSessionConfig((prev) => ({
          ...prev,
          projectLocation: global.defaultProjectLocation,
          defaultAutonomy: global.defaultAutonomy,
        }));
      } catch (err) {
        console.warn("[ChatLauncher] Failed to load global settings:", err);
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

    let client: AgenticClient | null = null;

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

      // Derive channel config from session config (note: contextId is NOT part of channelConfig)
      const channelConfig = toChannelConfig(sessionConfig);

      // Connect to pubsub to invite agents
      setStatus("Connecting to channel...");
      client = await connect({
        serverUrl: pubsubConfig.serverUrl,
        token: pubsubConfig.token,
        channel: targetChannelId,
        contextId,
        channelConfig,
        handle: `launcher-${id}`,
        name: "Chat Launcher",
        type: "panel",
        replayMode: "skip", // Don't need message replay
      });

      // Invite all selected agents via pubsub API
      const invitePromises = selectedAgents.map(async (agent) => {
        const config = buildSpawnConfig(agent);

        try {
          // Invite agent via pubsub - AgentHost will spawn the agent
          const result = await client!.inviteAgent(agent.agent.id, {
            handle: agent.agent.proposedHandle,
            config: {
              // Channel config values passed directly to avoid timing issues
              workingDirectory: channelConfig.workingDirectory,
              restrictedMode: channelConfig.restrictedMode,
              // contextId tells the agent which channel context it belongs to
              contextId,
              ...config,
            },
          });

          if (!result.success) {
            return {
              agent,
              error: result.error ?? "Unknown error",
              buildError: result.buildError,
              instanceId: null,
            };
          }

          return { agent, error: null, buildError: undefined, instanceId: result.instanceId };
        } catch (err) {
          // Capture invite errors per-agent
          const errorMsg = err instanceof Error ? err.message : String(err);
          return { agent, error: errorMsg, buildError: undefined, instanceId: null };
        }
      });

      const results = await Promise.all(invitePromises);

      // Separate successful and failed invites
      const succeeded = results.filter((r) => r.error === null);
      const failed = results.filter((r) => r.error !== null);

      // Collect build errors to pass to chat panel
      const buildErrors: Record<string, AgentBuildError> = {};
      for (const result of failed) {
        if (result.buildError) {
          buildErrors[result.agent.agent.name] = result.buildError;
        }
      }
      const hasBuildErrors = Object.keys(buildErrors).length > 0;

      // Check if all invites failed - still navigate to chat panel
      // Auto-wake will handle recovery when agents crash/timeout
      if (succeeded.length === 0) {
        const errorDetails = failed
          .map((r) => `${r.agent.agent.name}: ${r.error}`)
          .join("\n");
        console.warn(`[Chat Launcher] All agent invites failed, proceeding to chat anyway:\n${errorDetails}`);
        // Don't return - fall through to navigate to chat panel
      }

      // Log partial failures but continue if at least one succeeded
      if (failed.length > 0) {
        const failedNames = failed.map((r) => r.agent.agent.name).join(", ");
        console.warn(`[Chat Launcher] Some agents failed to invite: ${failedNames}`);
      }

      // Close the launcher's pubsub connection before navigating
      await client.close();
      client = null;

      // Post-spawn behavior depends on mode
      if (isChannelMode) {
        // Channel modification mode: agents were invited, now close self or navigate back
        // Note: Auto-wake system handles agent recovery, no need to track instance IDs

        // Try to close self, otherwise navigate back
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
          contextId,
          stateArgs: {
            channelName: targetChannelId,
            contextId,
            ...(hasBuildErrors ? { buildErrors } : {}),
          },
        });
        window.location.href = chatUrl;
      } else {
        // New chat mode: navigate to the chat panel with channel ID, config, and contextId
        const chatUrl = buildNsLink("panels/chat", {
          action: "navigate",
          contextId,
          stateArgs: {
            channelName: targetChannelId,
            channelConfig,
            contextId,
            ...(hasBuildErrors ? { buildErrors } : {}),
          },
        });
        window.location.href = chatUrl;
      }
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      setIsStarting(false);
      // Cleanup on error
      if (client) {
        try {
          await client.close();
        } catch {
          // Ignore cleanup errors
        }
      }
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
