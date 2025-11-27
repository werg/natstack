/**
 * Git dependency specification in panel manifest.
 * Can be a shorthand string or full object.
 *
 * Shorthand formats:
 * - "panels/shared" - defaults to main branch
 * - "panels/shared#develop" - specific branch
 * - "panels/shared@v1.0.0" - specific tag
 * - "panels/shared@abc123" - specific commit (7+ hex chars)
 */
export type GitDependencySpec =
  | string
  | {
      /** Git repository path relative to workspace (e.g., "panels/shared") */
      repo: string;
      /** Branch name to track */
      branch?: string;
      /** Specific commit hash to pin to */
      commit?: string;
      /** Tag to pin to */
      tag?: string;
    };

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

export interface PanelBuildCache {
  path: string;
  manifest: PanelManifest;
  bundlePath: string;
  htmlPath: string;
  sourceHash: string; // Hash of source files for cache invalidation
  builtAt: number;
  dependencyHash?: string;
  cacheVersion?: number;
}

export type PanelEventPayload =
  | { type: "child-removed"; childId: string }
  | { type: "focus" }
  | { type: "theme"; theme: "light" | "dark" };
