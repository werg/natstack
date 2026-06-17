/**
 * Configuration types for NatStack.
 *
 * Configuration is split between:
 * 1. Central config (~/.config/natstack/ or equivalent):
 *    - config.yml: Model roles and app-wide settings
 *    - .secrets.yml: API keys (format: `providername: secret`)
 *    - .env: Environment variables
 *
 * 2. Workspace (project directory):
 *    - meta/natstack.yml: Init panels and shared git remotes
 *    - meta/AGENTS.md: Agent system prompt
 *    - panels/: Panel source code
 *    - apps/: Trusted workspace-owned frontend apps
 *    - projects/: Plain editable repositories that are not runtime units
 *    - .cache/: Build cache
 */

import type { AppCapability, WorkspaceAppTarget } from "../unitManifest.js";

export type { AppCapability, WorkspaceAppTarget };

/**
 * Standard model roles with fallback behavior
 */
export type StandardModelRole = "smart" | "coding" | "fast" | "cheap";

/**
 * Extended model configuration for AI SDK.
 * Allows specifying provider, model ID, and additional parameters.
 */
export interface ModelConfig {
  /** Provider ID (e.g., "anthropic", "openai", "groq") */
  provider: string;
  /** Model ID within the provider (e.g., "claude-sonnet-4-20250514") */
  model: string;
  /** Optional temperature (0-2, default varies by model) */
  temperature?: number;
  /** Optional maximum output tokens */
  maxTokens?: number;
  /** Optional top-p sampling (0-1) */
  topP?: number;
  /** Optional top-k sampling */
  topK?: number;
  /** Optional presence penalty (-2 to 2) */
  presencePenalty?: number;
  /** Optional frequency penalty (-2 to 2) */
  frequencyPenalty?: number;
  /** Optional stop sequences */
  stopSequences?: string[];
}

/**
 * Model role value - either a simple string "provider:model" or full config object
 */
export type ModelRoleValue = string | ModelConfig;

/**
 * Model role configuration.
 * The four standard roles (smart, coding, fast, cheap) have fallback behavior:
 * - smart <-> coding (bidirectional fallback)
 * - fast <-> cheap (bidirectional fallback)
 *
 * Values can be:
 * - A simple string like "anthropic:claude-sonnet-4-20250514"
 * - A full config object with provider, model, and optional parameters
 */
export interface ModelRoleConfig {
  smart?: ModelRoleValue;
  coding?: ModelRoleValue;
  fast?: ModelRoleValue;
  cheap?: ModelRoleValue;
  [key: string]: ModelRoleValue | undefined; // Allow custom roles
}

/**
 * Build cache configuration
 */
export interface CacheConfig {
  /** Maximum number of cache entries in main process (default: 100000) */
  maxEntries?: number;
  /** Maximum total cache size in bytes in main process (default: 5GB) */
  maxSize?: number;
  /** Cache expiration in dev mode, in milliseconds (default: 5 minutes) */
  expirationMs?: number;
}

/**
 * Central application configuration from ~/.config/natstack/config.yml
 * This is shared across all workspaces.
 */
export interface CentralConfig {
  /** Model role mappings (e.g., smart -> anthropic:claude-sonnet-4-20250514) */
  models?: ModelRoleConfig;
  /** Build cache configuration */
  cache?: CacheConfig;
  /** Remote server configuration (Electron connects to a standalone server) */
  remote?: {
    /** Full URL to the remote server gateway (e.g., "http://my-server:3000") */
    url?: string;
    /** Admin token for the remote server */
    token?: string;
    /** Path to a CA certificate (PEM) for verifying self-signed HTTPS servers */
    caPath?: string;
    /**
     * SHA-256 fingerprint of the expected server certificate, in colon-separated
     * uppercase hex (e.g., "AB:CD:..."). When set, overrides normal CA verification
     * — the connection succeeds iff the server's leaf cert matches this fingerprint.
     */
    fingerprint?: string;
  };
}

/**
 * Workspace Git remote declarations
 */
export interface GitConfig {
  /**
   * Shared git remotes declared by workspace repo path.
   *
   * Example:
   * git:
   *   remotes:
   *     panels:
   *       chat:
   *         origin: https://github.com/example/chat.git
   *         ci: https://github.com/example/chat-ci.git
   */
  remotes?: WorkspaceGitRemotesConfig;
}

export interface WorkspaceGitRemoteConfig {
  name: string;
  url: string;
}

export type WorkspaceGitRemotesConfig = Record<
  string,
  Record<string, Record<string, string | null | undefined> | undefined> | undefined
>;

/**
 * An entry in the initPanels array — panel source + optional stateArgs.
 */
export interface InitPanelEntry {
  source: string;
  stateArgs?: Record<string, unknown>;
}

export type PanelRestorePolicy = "focused" | "none";

/**
 * Caller kinds permitted in workspace `services[].policy.allowed`.
 * Kept inline (rather than re-imported from serviceDispatcher) so this types
 * file stays free of runtime-side dependencies.
 */
export type WorkspaceServiceCallerKind =
  | "panel"
  | "app"
  | "shell"
  | "server"
  | "worker"
  | "extension"
  | "harness";

/**
 * A stable Durable Object singleton declared in `workspace/meta/natstack.yml`.
 * Every workspace `services[]` / `routes[]` entry that targets a DO class must
 * resolve to one of these via `(source, className)`.
 */
export interface WorkspaceSingletonObjectDecl {
  /** Worker source path, e.g. `"workers/gad-store"`. */
  source: string;
  /** Durable Object class name as exported from the worker module. */
  className: string;
  /** Stable singleton object key (e.g. `"workspace-gad"`). */
  key: string;
  /** Optional context binding (free-form; e.g. workspace id). */
  contextId?: string;
}

/** Userland service declaration in `workspace/meta/natstack.yml`. */
export type WorkspaceServiceDecl = {
  source: string;
  name: string;
  title?: string;
  description?: string;
  protocols?: string[];
  policy?: { allowed?: WorkspaceServiceCallerKind[] };
} & (
  | { durableObject: { className: string }; worker?: never }
  | { worker: { routePath: string }; durableObject?: never }
);

/**
 * One declarative scheduled job ("cron") in `workspace/meta/natstack.yml`'s
 * `recurring:` section. The server's RecurringRegistry dispatches `method` on
 * the target DO on schedule. Editing the list is a gated meta write: newly
 * declared or changed jobs surface in the meta-push approval as scheduled-job
 * entries before they ever run.
 */
export interface WorkspaceRecurringDecl {
  /** Unique job name within the workspace, e.g. "news-briefing-default". */
  name: string;
  /** Target Durable Object. `objectKey` defaults to the job name. */
  target: { source: string; className: string; objectKey?: string };
  /** DO method to invoke on schedule. */
  method: string;
  /** JSON-serializable arguments passed to the method. */
  args?: unknown[];
  /**
   * Cadence: `every` is a duration ("30m", "6h", "1d"); optional `at` is a
   * local-time anchor "HH:MM" for day-multiple intervals (e.g. daily at 08:00).
   */
  schedule: { every: string; at?: string };
}

/**
 * Extension declaration in `workspace/meta/natstack.yml`. The declared list is
 * the single source of truth for which extensions a workspace uses and the only
 * install/remove surface. Editing it (a gated meta write) triggers the joint
 * unit approval and registry reconciliation.
 */
export interface WorkspaceExtensionDecl {
  /**
   * Extension identity: a workspace-relative repo path
   * (e.g. `"extensions/image-service"`) OR the package
   * name (e.g. `"@workspace-extensions/image-service"`). Both resolve via the
   * build graph.
   */
  source: string;
  /** Git ref the extension floats to. Defaults to `"main"`. */
  ref?: string;
}

/**
 * App declaration in `workspace/meta/natstack.yml`. Apps are the frontend
 * counterpart to extensions: privileged, workspace-coupled units that are
 * build-gated, approval-gated, and hot-loaded onto a shipped host.
 */
export interface WorkspaceAppDecl {
  /**
   * App identity: a workspace-relative repo path
   * (e.g. `"apps/shell"`) OR the package name
   * (e.g. `"@workspace-apps/shell"`). Both resolve via the build graph.
   */
  source: string;
  /** Git ref the app floats to. Defaults to `"main"`. */
  ref?: string;
}

/** HTTP route declaration in `workspace/meta/natstack.yml`. */
export interface WorkspaceRouteDecl {
  source: string;
  path: string;
  methods?: ("GET" | "POST" | "PUT" | "DELETE" | "PATCH")[];
  durableObject?: { className: string };
  /** When true, binds the canonical regular-worker instance's default fetch. */
  worker?: boolean;
  auth?: "public" | "admin-token" | "caller-token";
  websocket?: boolean;
}

/**
 * Workspace configuration from meta/natstack.yml
 * This is specific to each workspace/project.
 */
export interface WorkspaceConfig {
  /** Resolved workspace identifier. If omitted on disk, derived from the workspace location. */
  id: string;
  /** Workspace Git remote declarations */
  git?: GitConfig;
  /**
   * Panels to create on first initialization (when panel tree is empty).
   * These panels are created as root panels in the specified order.
   * Example: [{ source: "panels/chat", stateArgs: { initialPrompt: "Hello", systemPrompt: "You are..." } }]
   */
  initPanels?: InitPanelEntry[];
  /**
   * Startup/reconnect view restoration policy.
   * - "focused" (default): restore/load only the focused panel view.
   * - "none": restore tree state only; views load when selected.
   */
  panelRestorePolicy?: PanelRestorePolicy;
  /** Workspace-wide default agent model ref ("provider:modelId"). */
  defaultAgentModel?: string;
  /**
   * Stable DO singletons. Any `services[]` / `routes[]` entry referencing a
   * `durableObject.className` MUST have a matching `(source, className)` row
   * here. Workspace load fails otherwise.
   */
  singletonObjects?: WorkspaceSingletonObjectDecl[];
  /** Userland service declarations. */
  services?: WorkspaceServiceDecl[];
  /** HTTP route declarations exposed under `/_r/w/<source>/...`. */
  routes?: WorkspaceRouteDecl[];
  /**
   * Declarative extension set for this workspace — the single source of truth
   * for which extensions are in use. Editing this list is the only way to
   * install or remove an extension; the edit is a gated meta write that
   * triggers the joint approval and reconciliation. Absent or empty means no
   * extensions (reconciliation removes any left in the registry).
   */
  extensions?: WorkspaceExtensionDecl[];
  /**
   * Declarative scheduled jobs ("cron"). The RecurringRegistry syncs this
   * list on startup and after approved meta pushes; absent or empty removes
   * all scheduled jobs.
   */
  recurring?: WorkspaceRecurringDecl[];
  /**
   * Declarative privileged frontend app set for this workspace. Absent or
   * empty means no apps; the reconciler removes anything not declared here.
   */
  apps?: WorkspaceAppDecl[];
}

/**
 * Resolved workspace with computed paths.
 *
 * Directory layout:
 *   workspaces/{name}/source/   ← path (workspace source root, meta/natstack.yml)
 *   workspaces/{name}/state/    ← statePath (Electron userData + runtime state)
 */
export interface Workspace {
  /** Absolute path to workspace source directory (meta/natstack.yml and unit source trees) */
  path: string;
  /** Absolute path to state directory (Electron userData, databases, cache) */
  statePath: string;
  /** Parsed workspace configuration */
  config: WorkspaceConfig;
  /** Absolute path to panels directory (source/panels) */
  panelsPath: string;
  /** Absolute path to packages directory (source/packages) */
  packagesPath: string;
  /** Absolute path to contexts directory (state/.contexts) */
  contextsPath: string;
  /** Absolute path to cache directory (state/.cache) */
  cachePath: string;
  /** Absolute path to agents directory (source/agents) */
  agentsPath: string;
  /** Absolute path to projects directory (source/projects) */
  projectsPath: string;
}

/**
 * Resolved central config location
 */
export interface CentralConfigPaths {
  /** Absolute path to central config directory */
  configDir: string;
  /** Absolute path to config.yml */
  configPath: string;
  /** Absolute path to .secrets.yml */
  secretsPath: string;
  /** Absolute path to .env */
  envPath: string;
  /** Absolute path to data.json (recent workspaces, etc.) */
  dataPath: string;
}

// =============================================================================
// Central Data Types (for persistence)
// =============================================================================

// Re-export shared IPC types for convenience
export type { WorkspaceEntry, SettingsData } from "../types.js";

// Import for use in CentralData
import type { WorkspaceEntry } from "../types.js";

/**
 * Central data persisted in ~/.config/natstack/data.json
 */
export interface CentralData {
  /** Managed workspaces (sorted by lastOpened desc) */
  workspaces: WorkspaceEntry[];
}
