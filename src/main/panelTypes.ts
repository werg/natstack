export interface PanelManifest {
  title: string;
  entry?: string; // Defaults to "index.ts"
  dependencies?: Record<string, string>; // npm package -> version
  injectHostThemeVariables?: boolean; // Defaults to true
  template?: "html" | "react"; // Optional: choose template helpers
}

export interface PanelBuildResult {
  success: boolean;
  bundlePath?: string;
  htmlPath?: string;
  error?: string;
}

export interface PanelArtifacts {
  htmlPath?: string;
  bundlePath?: string;
  error?: string;
}

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

export interface Panel {
  id: string;
  title: string;
  path: string;
  children: Panel[];
  selectedChildId: string | null;
  injectHostThemeVariables: boolean;
  artifacts: PanelArtifacts;
}
