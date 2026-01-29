/**
 * Project Panel
 *
 * Manage an active project, launch chat sessions, and view session history.
 */

import { useState, useEffect, useCallback } from "react";
import { Theme, Box, Flex, Separator, Card } from "@radix-ui/themes";
import { usePanelTheme } from "@natstack/react";
import { rpc, createChild, setStateArgs, useStateArgs } from "@natstack/runtime";

import { useChildSessions } from "./hooks/useChildSessions";
import { getAgentById, getAgentWorkerSource, getAgentHandle } from "./utils/agents";
import { ProjectHeader } from "./components/ProjectHeader";
import { ConfigSection } from "./components/ConfigSection";
import { TemplateSection } from "./components/TemplateSection";
import { LaunchSection } from "./components/LaunchSection";
import { SessionHistory } from "./components/SessionHistory";
import {
  validateProjectConfig,
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
  const [templateExpanded, setTemplateExpanded] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentName, setAgentName] = useState<string | undefined>();

  const { sessions, loadSessions, loading: sessionsLoading } = useChildSessions();

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
    // Encode the session ID in case it contains special characters
    window.location.href = `ns-focus:///${encodeURIComponent(sessionId)}`;
  }, []);

  const launchChat = useCallback(async () => {
    // Validate config before launch
    const validationError = validateProjectConfig(projectConfig);
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsLaunching(true);
    setError(null);

    try {
      // Generate channel ID
      const channelId = `chat-${crypto.randomUUID().slice(0, 8)}`;

      // Get or create context ID
      let sessionContextId = contextId;
      if (!sessionContextId && projectConfig.projectLocation === "managed") {
        // contextTemplateSpec is validated above, safe to use
        sessionContextId = await rpc.call<string>(
          "main",
          "bridge.createContextFromTemplate",
          projectConfig.contextTemplateSpec
        );
      } else if (!sessionContextId) {
        sessionContextId = crypto.randomUUID();
      }

      // Determine working directory based on mode
      const isManaged = projectConfig.projectLocation === "managed";
      const effectiveWorkingDirectory = isManaged
        ? (projectConfig.browserWorkingDirectory ?? PROJECT_DEFAULTS.browserWorkingDirectory)
        : projectConfig.workingDirectory;

      // Create chat panel as child
      const chatHandle = await createChild("panels/chat", { name: `chat-${channelId.slice(0, 8)}` }, {
        channelName: channelId,
        channelConfig: {
          workingDirectory: effectiveWorkingDirectory,
          restrictedMode: isManaged,
        },
        contextId: sessionContextId,
      });

      // Spawn default agent with autonomy setting applied
      if (projectConfig.defaultAgentId) {
        const agentDef = await getAgentById(projectConfig.defaultAgentId);
        if (agentDef) {
          await createChild(
            getAgentWorkerSource(agentDef),
            { name: `agent-${channelId.slice(0, 8)}` },
            {
              channel: channelId,
              handle: getAgentHandle(agentDef),
              workingDirectory: effectiveWorkingDirectory,
              restrictedMode: isManaged,
              contextId: sessionContextId,
              autonomyLevel: projectConfig.defaultAutonomy ?? PROJECT_DEFAULTS.defaultAutonomy,
              ...projectConfig.defaultAgentConfig,
            }
          );
        }
      }

      // Focus the new chat panel
      navigateToSession(chatHandle.id);

      // Refresh session list
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch chat");
    } finally {
      setIsLaunching(false);
    }
  }, [projectConfig, contextId, loadSessions, navigateToSession]);

  return (
    <Theme appearance={theme}>
      <Box p="4" style={{ maxWidth: 600, margin: "0 auto" }}>
        <Flex direction="column" gap="4">
          <ProjectHeader config={projectConfig} />

          {/* Template section for managed projects */}
          {projectConfig.projectLocation === "managed" && projectConfig.includedRepos?.[0] && (
            <>
              <Separator size="4" />
              <TemplateSection
                repoPath={projectConfig.includedRepos[0]}
                expanded={templateExpanded}
                onToggle={() => setTemplateExpanded(!templateExpanded)}
              />
            </>
          )}

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
            expanded={configExpanded}
            onToggle={() => setConfigExpanded(!configExpanded)}
            onUpdate={handleConfigUpdate}
          />
        </Flex>
      </Box>
    </Theme>
  );
}
