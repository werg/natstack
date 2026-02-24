/**
 * Project Panel
 *
 * Manage an active project, launch chat sessions, and view session history.
 */

import { useState, useEffect, useCallback } from "react";
import { Theme, Box, Flex, Separator, Card } from "@radix-ui/themes";
import { usePanelTheme } from "@workspace/react";
import { pubsubConfig, rpc, createChild, setStateArgs, useStateArgs, buildFocusLink, db, id as panelClientId } from "@workspace/runtime";
import { setDbOpen, connect, type AgenticClient } from "@workspace/agentic-messaging";
import type { AgentManifest } from "@natstack/types";

// Configure agentic-messaging to use runtime's db
setDbOpen(db.open);

import { useChildSessions } from "./hooks/useChildSessions";
import { getAgentById, getAgentHandle } from "./utils/agents";
import type { AgentInfo } from "@workspace/agentic-components/types";
import { ProjectHeader } from "./components/ProjectHeader";
import { ConfigSection } from "./components/ConfigSection";
import { LaunchSection } from "./components/LaunchSection";
import { SessionHistory } from "./components/SessionHistory";
import {
  PROJECT_DEFAULTS,
  type ProjectConfig,
  type ProjectPanelStateArgs,
} from "./types";

export default function ProjectPanel() {
  const stateArgs = useStateArgs<ProjectPanelStateArgs>();
  const theme = usePanelTheme();

  // Guard against missing stateArgs (shouldn't happen in normal flow)
  if (!stateArgs?.projectConfig) {
    return (
      <Theme appearance={theme}>
        <Box p="4">
          <Card size="2" style={{ backgroundColor: "var(--red-3)" }}>
            <Box p="4" style={{ color: "var(--red-11)" }}>
              Error: No project configuration provided. Please create a project from the launcher.
            </Box>
          </Card>
        </Box>
      </Theme>
    );
  }

  const { projectConfig, contextId } = stateArgs;

  const [configExpanded, setConfigExpanded] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentName, setAgentName] = useState<string | undefined>();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);

  const { sessions, loadSessions, loading: sessionsLoading } = useChildSessions();

  // Load agents on mount
  useEffect(() => {
    let mounted = true;
    async function loadAgents() {
      try {
        const manifests = await rpc.call<AgentManifest[]>("main", "bridge.listAgents");
        if (mounted) {
          // Map to AgentInfo (minimal interface for selector)
          setAgents(manifests.map((m) => ({ id: m.id, name: m.name, description: m.description })));
        }
      } catch (err) {
        console.error("Failed to load agents:", err);
      } finally {
        if (mounted) setAgentsLoading(false);
      }
    }
    void loadAgents();
    return () => { mounted = false; };
  }, []);

  // Load child panels on mount and when panel becomes visible
  useEffect(() => {
    void loadSessions();

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void loadSessions();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadSessions]);

  // Load agent name for display
  useEffect(() => {
    if (projectConfig.defaultAgentId) {
      getAgentById(projectConfig.defaultAgentId)
        .then((agent) => {
          setAgentName(agent?.name);
        })
        .catch((err) => {
          console.warn("Failed to load agent info:", err);
          setAgentName(undefined);
        });
    } else {
      setAgentName(undefined);
    }
  }, [projectConfig.defaultAgentId]);

  // Update panel title with project name
  useEffect(() => {
    document.title = projectConfig.name || "Project";
  }, [projectConfig.name]);

  // Handle config updates and persist via stateArgs
  const handleConfigUpdate = useCallback(
    async (updates: Partial<ProjectConfig>) => {
      const updatedConfig = { ...projectConfig, ...updates, updatedAt: Date.now() };
      await setStateArgs({ ...stateArgs, projectConfig: updatedConfig });
    },
    [projectConfig, stateArgs]
  );

  // Navigate to a child chat session
  const navigateToSession = useCallback((sessionId: string) => {
    window.location.href = buildFocusLink(sessionId);
  }, []);

  const launchChat = useCallback(async () => {
    if (!pubsubConfig) {
      setError("Pubsub not configured");
      return;
    }

    setIsLaunching(true);
    setError(null);

    let client: AgenticClient | null = null;

    try {
      // Generate channel ID
      const channelId = `chat-${crypto.randomUUID().slice(0, 8)}`;

      // Get or create context ID
      let sessionContextId = contextId;
      if (!sessionContextId) {
        sessionContextId = crypto.randomUUID();
      }

      // Create chat panel as child
      // contextId in options sets storage partition, in stateArgs tells app which context
      const chatHandle = await createChild("panels/chat", {
        name: `chat-${channelId.slice(0, 8)}`,
        contextId: sessionContextId,
      }, {
        channelName: channelId,
        contextId: sessionContextId,
      });

      // Invite default agent via pubsub API (new agent system)
      if (projectConfig.defaultAgentId) {
        const agentDef = await getAgentById(projectConfig.defaultAgentId);
        if (agentDef) {
          // Connect to pubsub to invite the agent
          client = await connect({
            serverUrl: pubsubConfig.serverUrl,
            token: pubsubConfig.token,
            channel: channelId,
            contextId: sessionContextId,
            handle: `project-launcher-${panelClientId}`,
            name: "Project Panel",
            type: "panel",
            replayMode: "skip",
          });

          // Invite the agent via AgentHost - fire and forget
          // Agent will join the channel asynchronously via presence events
          client.inviteAgent(agentDef.id, {
            handle: getAgentHandle(agentDef),
            config: {
              contextId: sessionContextId,
              autonomyLevel: projectConfig.defaultAutonomy ?? PROJECT_DEFAULTS.defaultAutonomy,
              ...projectConfig.defaultAgentConfig,
            },
          }).catch((err) => {
            console.warn(`[ProjectPanel] Failed to invite agent:`, err);
          });

          // Close pubsub connection
          await client.close();
          client = null;
        }
      }

      // Focus the new chat panel
      navigateToSession(chatHandle.id);

      // Refresh session list
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch chat");
    } finally {
      // Ensure pubsub connection is closed on error
      if (client) {
        try {
          await client.close();
        } catch {
          // Ignore close errors
        }
      }
      setIsLaunching(false);
    }
  }, [projectConfig, contextId, loadSessions, navigateToSession]);

  return (
    <Theme appearance={theme}>
      <Box p="4" style={{ maxWidth: 600, margin: "0 auto" }}>
        <Flex direction="column" gap="4">
          <ProjectHeader config={projectConfig} />

          <Separator size="4" />

          <LaunchSection
            onLaunch={launchChat}
            isLaunching={isLaunching}
            agentName={agentName}
          />

          {error && (
            <Card size="1" style={{ backgroundColor: "var(--red-3)" }}>
              <Box p="2" style={{ color: "var(--red-11)" }}>
                {error}
              </Box>
            </Card>
          )}

          <Separator size="4" />

          <SessionHistory
            sessions={sessions}
            loading={sessionsLoading}
            onNavigate={navigateToSession}
            onRefresh={loadSessions}
          />

          <Separator size="4" />

          <ConfigSection
            config={projectConfig}
            agents={agents}
            agentsLoading={agentsLoading}
            expanded={configExpanded}
            onToggle={() => setConfigExpanded(!configExpanded)}
            onUpdate={handleConfigUpdate}
          />
        </Flex>
      </Box>
    </Theme>
  );
}
