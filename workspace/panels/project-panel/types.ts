/**
 * Project configuration types for project-panel.
 */

import { AUTONOMY_NOTCHES } from "@workspace/agentic-messaging/config";

// Re-export for convenience
export { AUTONOMY_NOTCHES };

/**
 * Project configuration stored in panel stateArgs.
 */
export interface ProjectConfig {
  /** Unique project ID */
  id: string;
  /** Display name for the project */
  name: string;
  /** Project location mode */
  projectLocation: "managed" | "external";
  /** Working directory for external/native filesystem mode */
  workingDirectory?: string;
  /** Working directory for managed/panel mode (defaults to "/") */
  browserWorkingDirectory?: string;
  /** Repos included in context template */
  includedRepos?: string[];
  /** Default agent to spawn for new sessions */
  defaultAgentId?: string;
  /** Default agent configuration */
  defaultAgentConfig?: Record<string, unknown>;
  /** Default autonomy level for agents (0=manual, 1=semi-auto, 2=full-auto) */
  defaultAutonomy?: 0 | 1 | 2;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
}

/**
 * StateArgs for project-panel.
 */
export interface ProjectPanelStateArgs {
  /** Full project configuration */
  projectConfig: ProjectConfig;
  /** Pre-created context ID (for managed mode) */
  contextId?: string;
}

/**
 * Child session info returned by getChildPanels.
 */
export interface ChildSessionInfo {
  id: string;
  title: string;
  source: string;
  createdAt: number;
}

/**
 * Default values for projects.
 */
export const PROJECT_DEFAULTS = {
  defaultAutonomy: 2 as const, // Full auto
  browserWorkingDirectory: "/" as const, // context root
} satisfies Partial<ProjectConfig>;

/**
 * Validate project configuration.
 */
export function validateProjectConfig(config: ProjectConfig): string | null {
  if (config.projectLocation === "external" && !config.workingDirectory?.trim()) {
    return "External projects require a working directory";
  }
  return null;
}

/**
 * Generate a new project ID.
 */
export function generateProjectId(): string {
  return `proj-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Create a new project config with defaults.
 */
export function createProjectConfig(
  name: string,
  location: "managed" | "external",
  overrides?: Partial<ProjectConfig>
): ProjectConfig {
  const now = Date.now();
  return {
    id: generateProjectId(),
    name,
    projectLocation: location,
    defaultAutonomy: PROJECT_DEFAULTS.defaultAutonomy,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
