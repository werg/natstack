/**
 * Project Launcher Panel
 *
 * Configure and create new projects (managed or external).
 * After configuration, navigates to project-panel with the project config.
 */

import { useState, useCallback } from "react";
import { rpc, buildNsLink } from "@natstack/runtime";
import { usePanelTheme } from "@natstack/react";
import { Theme, Box, Flex, Heading, Text, TextField, Button, Separator, Card } from "@radix-ui/themes";
import { RocketIcon } from "@radix-ui/react-icons";

import { useProjectConfig } from "./hooks/useProjectConfig";
import { LocationSettings } from "./components/LocationSettings";
import { ExternalModeConfig } from "./components/ExternalModeConfig";
import { ManagedModeConfig } from "./components/ManagedModeConfig";
import { DefaultAgentConfig } from "./components/DefaultAgentConfig";
import { AutonomySettings } from "./components/AutonomySettings";
import { validateProjectConfig, type ProjectPanelStateArgs } from "@workspace-panels/project-panel/types";

export default function ProjectLauncher() {
  const theme = usePanelTheme();
  const workspaceRoot = process.env["NATSTACK_WORKSPACE"]?.trim();

  const {
    projectConfig,
    setLocation,
    setWorkingDirectory,
    setContextTemplateSpec,
    setIncludedRepos,
    setDefaultAgent,
    setDefaultAutonomy,
    setName,
  } = useProjectConfig({ workspaceRoot });

  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreateProject = useCallback(async () => {
    // Validate config
    const validationError = validateProjectConfig(projectConfig);
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      // For managed mode, pre-create the context
      let contextId: string | undefined;
      if (projectConfig.projectLocation === "managed" && projectConfig.contextTemplateSpec) {
        contextId = await rpc.call<string>(
          "main",
          "bridge.createContextFromTemplate",
          projectConfig.contextTemplateSpec
        );
      }

      // Navigate to project-panel with the config
      const stateArgs: ProjectPanelStateArgs = {
        projectConfig,
        contextId,
      };

      const projectPanelUrl = buildNsLink("panels/project-panel", {
        action: "navigate",
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

              {/* Location Mode */}
              <LocationSettings
                location={projectConfig.projectLocation}
                onLocationChange={setLocation}
              />

              <Separator size="4" />

              {/* Mode-specific config */}
              {projectConfig.projectLocation === "external" ? (
                <ExternalModeConfig
                  workingDirectory={projectConfig.workingDirectory ?? ""}
                  onWorkingDirectoryChange={setWorkingDirectory}
                />
              ) : (
                <ManagedModeConfig
                  includedRepos={projectConfig.includedRepos ?? []}
                  onIncludedReposChange={setIncludedRepos}
                  onContextTemplateSpecChange={setContextTemplateSpec}
                />
              )}

              <Separator size="4" />

              {/* Default Agent */}
              <DefaultAgentConfig
                defaultAgentId={projectConfig.defaultAgentId}
                onDefaultAgentChange={(id) => setDefaultAgent(id)}
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
