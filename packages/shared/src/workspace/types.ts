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
 *    - projects/: Plain editable repositories that are not runtime units
 *    - .cache/: Build cache
 */

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
 * Git server configuration
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

/**
 * Workspace configuration from meta/natstack.yml
 * This is specific to each workspace/project.
 */
export interface WorkspaceConfig {
  /** Resolved workspace identifier. If omitted on disk, derived from the workspace location. */
  id: string;
  /** Git server configuration */
  git?: GitConfig;
  /**
   * Panels to create on first initialization (when panel tree is empty).
   * These panels are created as root panels in the specified order.
   * Example: [{ source: "panels/chat", stateArgs: { initialPrompt: "Hello", systemPrompt: "You are..." } }]
   */
  initPanels?: InitPanelEntry[];
}

/**
 * Resolved workspace with computed paths.
 *
 * Directory layout:
 *   workspaces/{name}/source/   ← path (source root: git repos, meta/natstack.yml)
 *   workspaces/{name}/state/    ← statePath (Electron userData + runtime state)
 */
export interface Workspace {
  /** Absolute path to source directory (git repos, meta/natstack.yml) */
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
  /** Absolute path to git repos directory (= source root) */
  gitReposPath: string;
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
export type {
  WorkspaceEntry,
  SettingsData,
} from "../types.js";

// Import for use in CentralData
import type { WorkspaceEntry } from "../types.js";

/**
 * Central data persisted in ~/.config/natstack/data.json
 */
export interface CentralData {
  /** Managed workspaces (sorted by lastOpened desc) */
  workspaces: WorkspaceEntry[];
}
