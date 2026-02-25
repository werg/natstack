/**
 * Project Launcher Panel
 *
 * Configure and create new projects.
 * After configuration, navigates to project-panel with the project config.
 */

import { useState, useCallback, useEffect } from "react";
import { rpc, buildNsLink } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import { Theme, Box, Flex, Heading, Text, TextField, Button, Separator, Card } from "@radix-ui/themes";
import { RocketIcon } from "@radix-ui/react-icons";
import type { AgentManifest } from "@natstack/types";

import { useProjectConfig } from "./hooks/useProjectConfig";
import { ManagedModeConfig } from "./components/ManagedModeConfig";
import { AgentSelector } from "@workspace/agentic-components";
import { AutonomySettings } from "./components/AutonomySettings";
import type { ProjectPanelStateArgs } from "@workspace-panels/project-panel/types";

export default function ProjectLauncher() {
  const theme = usePanelTheme();

  const {
    projectConfig,
    setIncludedRepos,
    setDefaultAgent,
    setDefaultAutonomy,
    setName,
  } = useProjectConfig();

  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentManifest[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);

  // Load agents on mount
  useEffect(() => {
    let mounted = true;
    async function loadAgents() {
      try {
        const manifests = await rpc.call<AgentManifest[]>("main", "bridge.listAgents");
        if (mounted) {
          setAgents(manifests);
          // Auto-select first agent if none selected
          if (!projectConfig.defaultAgentId && manifests.length > 0) {
            setDefaultAgent(manifests[0]!.id);
          }
        }
      } catch (err) {
        console.error("Failed to load agents:", err);
      } finally {
        if (mounted) setAgentsLoading(false);
      }
    }
    void loadAgents();
    return () => { mounted = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreateProject = useCallback(async () => {
    setIsCreating(true);
    setError(null);

    try {
      // Generate a context ID
      const contextId = `ctx_${crypto.randomUUID()}`;

      // Navigate to project-panel with the config
      const stateArgs: ProjectPanelStateArgs = {
        projectConfig,
        contextId,
      };

      const projectPanelUrl = buildNsLink("panels/project-panel", {
        action: "navigate",
        // contextId in options sets storage partition (filesystem and storage sharing)
        contextId,
        stateArgs: stateArgs as unknown as Record<string, unknown>,
      });
      window.location.href = projectPanelUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
      setIsCreating(false);
    }
  }, [projectConfig]);

  return (
    <Theme appearance={theme}>
      <Box p="4" style={{ maxWidth: 600, margin: "0 auto" }}>
        <Flex direction="column" gap="4">
          <Heading size="5">
            <RocketIcon style={{ marginRight: 8, verticalAlign: "middle" }} />
            New Project
          </Heading>

          <Card size="2">
            <Flex direction="column" gap="4">
              {/* Project Name */}
              <Box>
                <Text as="label" size="2" weight="medium" mb="2" style={{ display: "block" }}>
                  Project Name
                </Text>
                <TextField.Root
                  value={projectConfig.name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Project"
                />
              </Box>

              <Separator size="4" />

              {/* Repos config */}
              <ManagedModeConfig
                includedRepos={projectConfig.includedRepos ?? []}
                onIncludedReposChange={setIncludedRepos}
              />

              <Separator size="4" />

              {/* Default Agent */}
              <AgentSelector
                agents={agents}
                loading={agentsLoading}
                defaultAgentId={projectConfig.defaultAgentId}
                onDefaultAgentChange={(id: string | undefined) => setDefaultAgent(id)}
              />

              <Separator size="4" />

              {/* Autonomy Settings */}
              <AutonomySettings
                autonomy={projectConfig.defaultAutonomy ?? 1}
                onAutonomyChange={setDefaultAutonomy}
              />
            </Flex>
          </Card>

          {/* Error Display */}
          {error && (
            <Text size="2" color="red">
              {error}
            </Text>
          )}

          {/* Create Button */}
          <Button
            size="3"
            onClick={handleCreateProject}
            disabled={isCreating}
            style={{ width: "100%" }}
          >
            {isCreating ? "Creating..." : "Create Project"}
          </Button>
        </Flex>
      </Box>
    </Theme>
  );
}
