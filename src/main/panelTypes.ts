export interface PanelManifest {
  title: string;
  entry?: string; // Defaults to "index.ts"
  dependencies?: Record<string, string>; // npm package -> version
  injectHostThemeVariables?: boolean; // Defaults to true
}

export interface PanelBuildResult {
  success: boolean;
  bundlePath?: string;
  htmlPath?: string;
  error?: string;
}

export interface PanelBuildCache {
  path: string;
  manifest: PanelManifest;
  bundlePath: string;
  htmlPath: string;
  sourceHash: string; // Hash of source files for cache invalidation
  builtAt: number;
}

export type PanelEventPayload =
  | { type: "child-removed"; childId: string }
  | { type: "focus" }
  | { type: "theme"; theme: "light" | "dark" };
