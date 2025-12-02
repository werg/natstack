// Re-export types from shared types (canonical definitions)
export type {
  GitDependencySpec,
  RuntimeType,
  PanelType,
  Panel,
  AppPanel,
  WorkerPanel,
  BrowserPanel,
  BrowserState,
  ChildSpec,
  AppChildSpec,
  WorkerChildSpec,
  BrowserChildSpec,
} from "../shared/ipc/types.js";
import type { GitDependencySpec, RuntimeType } from "../shared/ipc/types.js";

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
  /**
   * External dependencies loaded via import map (CDN).
   * Use this for packages that need browser-specific ESM builds or polyfills.
   *
   * Example:
   * ```json
   * "externals": {
   *   "isomorphic-git": "https://esm.sh/isomorphic-git",
   *   "isomorphic-git/http/web": "https://esm.sh/isomorphic-git/http/web"
   * }
   * ```
   */
  externals?: Record<string, string>;
  injectHostThemeVariables?: boolean; // Defaults to true
  template?: "html" | "react"; // Optional: choose template helpers
  singletonState?: boolean; // If true, panel uses a singleton partition/id derived from its path
  /**
   * Runtime type for this manifest.
   * - "panel" (default): Builds for browser, serves via webview
   * - "worker": Builds for isolated-vm, runs in utility process
   */
  runtime?: RuntimeType;
}

export interface PanelBuildResult {
  success: boolean;
  bundlePath?: string;
  htmlPath?: string;
  error?: string;
}

// Re-export PanelArtifacts for backwards compatibility (Panel is now exported above)
export type { PanelArtifacts } from "../shared/ipc/types.js";

export type PanelEventPayload =
  | { type: "child-removed"; childId: string }
  | { type: "focus" }
  | { type: "theme"; theme: "light" | "dark" };
