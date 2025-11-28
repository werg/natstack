// Re-export GitDependencySpec from shared types (canonical definition)
export type { GitDependencySpec } from "../shared/ipc/types.js";
import type { GitDependencySpec } from "../shared/ipc/types.js";

export interface PanelManifest {
  title: string;
  entry?: string; // Defaults to "index.ts"
  dependencies?: Record<string, string>; // npm package -> version
  /**
   * Git-based panel dependencies.
   * These are cloned/pulled into OPFS before the panel runs.
   *
   * Example:
   * ```yaml
   * gitDependencies:
   *   shared: "panels/shared"           # shorthand
   *   utils: "panels/utils#develop"     # branch
   *   core:                             # full object
   *     repo: "panels/core"
   *     tag: "v1.0.0"
   * ```
   */
  gitDependencies?: Record<string, GitDependencySpec>;
  injectHostThemeVariables?: boolean; // Defaults to true
  template?: "html" | "react"; // Optional: choose template helpers
  singletonState?: boolean; // If true, panel uses a singleton partition/id derived from its path
}

export interface PanelBuildResult {
  success: boolean;
  bundlePath?: string;
  htmlPath?: string;
  error?: string;
}

// Re-export shared types for backwards compatibility
export type { Panel, PanelArtifacts } from "../shared/ipc/types.js";

export type PanelEventPayload =
  | { type: "child-removed"; childId: string }
  | { type: "focus" }
  | { type: "theme"; theme: "light" | "dark" };
