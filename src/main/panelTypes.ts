export interface PanelManifest {
  title: string;
  entry?: string; // Defaults to "index.ts"
  dependencies?: Record<string, string>; // npm package -> version
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
}

export type PanelEventPayload =
  | { type: "child-removed"; childId: string }
  | { type: "focus" }
  | { type: "theme"; theme: "light" | "dark" };
