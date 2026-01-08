// Re-export types from shared types (canonical definitions)
export type {
  RepoArgSpec,
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
import type { RuntimeType } from "../shared/ipc/types.js";

export interface PanelManifest {
  /**
   * What kind of child this manifest produces.
   * This is the canonical discriminator for child creation (app vs worker).
   */
  type: "app" | "worker";
  title: string;
  entry?: string; // Defaults to "index.ts"
  dependencies?: Record<string, string>; // npm package -> version
  /**
   * Named repo argument slots that callers must provide when creating this panel.
   * Each slot name maps to a directory in OPFS at /args/<name>.
   *
   * Example:
   * ```json
   * "repoArgs": ["history", "components", "scratchpad"]
   * ```
   *
   * Callers then provide values via createChild:
   * ```ts
   * createChild("panels/my-panel", {
   *   repoArgs: {
   *     history: "repos/history#main",
   *     components: { repo: "repos/ui", ref: "v1.0.0" },
   *     scratchpad: "repos/scratch",
   *   },
   * });
   * ```
   */
  repoArgs?: string[];
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
  /**
   * Additional module specifiers to expose via __natstackRequire__.
   * These modules are bundled even if not directly imported by the panel.
   */
  exposeModules?: string[];
  /**
   * Module specifiers that must resolve to a single instance across the bundle.
   * Use this for packages that use React context or other singleton patterns.
   *
   * By default, React, React DOM, and @radix-ui packages are deduplicated.
   * Add other packages here if you encounter context/singleton issues.
   *
   * Example:
   * ```json
   * "dedupeModules": ["@chakra-ui/react", "jotai", "@tanstack/react-query"]
   * ```
   *
   * Patterns supported:
   * - Exact match: "lodash"
   * - Package with subpaths: "lodash" matches "lodash" and "lodash/debounce"
   * - Scoped packages: "@scope/package" matches "@scope/package" and "@scope/package/sub"
   */
  dedupeModules?: string[];
  injectHostThemeVariables?: boolean; // Defaults to true
  template?: "html" | "react"; // Optional: choose template helpers
  singletonState?: boolean; // If true, panel uses a singleton partition/id derived from its path
  /**
   * Runtime type for this manifest.
   * - "panel" (default): Builds for browser, serves via webview
   * - "worker": Builds for isolated-vm, runs in utility process
   * @deprecated Use `type` ("app" | "worker") instead.
   */
  runtime?: RuntimeType;
  /**
   * Run with full Node.js API access instead of sandbox.
   * - For app panels: Enables nodeIntegration, disables browser sandbox, provides real fs module
   * - For workers: Uses full Node.js vm.Context instead of restricted sandbox
   * - `true`: Unsafe mode with default scoped filesystem
   * - `string`: Unsafe mode with custom filesystem root (e.g., "/" for full access)
   *
   * ⚠️ Security Warning: Unsafe mode grants full system access. Use only for trusted first-party code.
   */
  unsafe?: boolean | string;
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
  | { type: "child-creation-error"; url: string; error: string }
  | { type: "focus" }
  | { type: "theme"; theme: "light" | "dark" };
