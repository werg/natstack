/**
 * Project configuration state management hook.
 */

import { useState, useCallback } from "react";
import type { ProjectConfig } from "@workspace-panels/project-panel/types";
import { createProjectConfig, PROJECT_DEFAULTS } from "@workspace-panels/project-panel/types";

export interface UseProjectConfigOptions {
  workspaceRoot?: string;
}

export function useProjectConfig({ workspaceRoot }: UseProjectConfigOptions = {}) {
  const [projectConfig, setProjectConfig] = useState<ProjectConfig>(() =>
    createProjectConfig("New Project", "external", {
      workingDirectory: workspaceRoot ?? "",
      defaultAutonomy: PROJECT_DEFAULTS.defaultAutonomy,
    })
  );

  const updateConfig = useCallback((updates: Partial<ProjectConfig>) => {
    setProjectConfig((prev) => ({
      ...prev,
      ...updates,
      updatedAt: Date.now(),
    }));
  }, []);

  const setLocation = useCallback((location: "managed" | "external") => {
    updateConfig({ projectLocation: location });
  }, [updateConfig]);

  const setWorkingDirectory = useCallback((dir: string) => {
    updateConfig({ workingDirectory: dir });
  }, [updateConfig]);

  const setIncludedRepos = useCallback((repos: string[]) => {
    updateConfig({ includedRepos: repos });
  }, [updateConfig]);

  const setDefaultAgent = useCallback(
    (agentId: string | undefined, agentConfig?: Record<string, unknown>) => {
      updateConfig({
        defaultAgentId: agentId,
        defaultAgentConfig: agentConfig,
      });
    },
    [updateConfig]
  );

  const setDefaultAutonomy = useCallback((autonomy: 0 | 1 | 2) => {
    updateConfig({ defaultAutonomy: autonomy });
  }, [updateConfig]);

  const setName = useCallback((name: string) => {
    updateConfig({ name });
  }, [updateConfig]);

  return {
    projectConfig,
    updateConfig,
    setLocation,
    setWorkingDirectory,
    setIncludedRepos,
    setDefaultAgent,
    setDefaultAutonomy,
    setName,
  };
}
