// Re-export types from shared types (canonical definitions)
export type {
  RepoArgSpec,
  PanelType,
  Panel,
  PanelSnapshot,
  PanelManifest,
  BrowserState,
  ChildSpec,
  AppChildSpec,
  WorkerChildSpec,
  BrowserChildSpec,
  EnvArgSchema,
  ShellPage,
} from "../shared/ipc/types.js";

export interface PanelBuildResult {
  success: boolean;
  bundlePath?: string;
  htmlPath?: string;
  error?: string;
}

// Re-export PanelArtifacts for backwards compatibility
export type { PanelArtifacts } from "../shared/ipc/types.js";

export type PanelEventPayload =
  | { type: "child-creation-error"; url: string; error: string }
  | { type: "focus" }
  | { type: "theme"; theme: "light" | "dark" };

// Re-export accessor functions for panel state
export {
  getCurrentSnapshot,
  getPanelType,
  getPanelSource,
  getPanelOptions,
  getPanelEnv,
  getPanelGitRef,
  getPanelRepoArgs,
  getPanelUnsafe,
  getPanelSourcemap,
  getPanelBranch,
  getPanelCommit,
  getPanelTag,
  isPanelEphemeral,
  getPanelContextId,
  canGoBack,
  canGoForward,
  getInjectHostThemeVariables,
  getShellPage,
  getBrowserResolvedUrl,
  getPushState,
  createSnapshot,
  createNavigationSnapshot,
} from "../shared/panel/accessors.js";
