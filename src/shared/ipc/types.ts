// Shared types for typed IPC communication

import type { AICallOptions, AIGenerateResult, AIRoleRecord, AIToolDefinition } from "@natstack/ai";

export type ThemeMode = "light" | "dark" | "system";
export type ThemeAppearance = "light" | "dark";

export interface AppInfo {
  version: string;
}

export interface PanelInfo {
  panelId: string;
  partition: string;
}

// Panel-related types (shared between main and renderer)

/**
 * Build state for panels built by main process.
 * Used to show placeholder UI during build.
 */
export type PanelBuildState = "pending" | "cloning" | "building" | "ready" | "error";

export interface PanelArtifacts {
  htmlPath?: string;
  bundlePath?: string;
  error?: string;
  /** Build state for async main-process builds */
  buildState?: PanelBuildState;
  /** Human-readable progress message (e.g., "Installing dependencies...") */
  buildProgress?: string;
  /** Detailed build log (esbuild output, errors, etc.) */
  buildLog?: string;
}

/**
 * Build artifacts for protocol-served panels via natstack-panel://.
 * All panels (root and child) are now served this way.
 */
export interface ProtocolBuildArtifacts {
  /** The bundled JavaScript code */
  bundle: string;
  /** Generated or provided HTML template */
  html: string;
  /** Panel title from manifest */
  title: string;
  /** Whether this panel should use a singleton partition/id */
  singletonState?: boolean;
  /** CSS bundle if any */
  css?: string;
  /** Whether to inject host theme variables (defaults to true) */
  injectHostThemeVariables?: boolean;
  /** Optional source repo path (workspace-relative) to retain git association */
  sourceRepo?: string;
  /** Git dependencies from manifest */
  gitDependencies?: Record<string, GitDependencySpec>;
}

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

/**
 * Options for creating a child panel.
 * Version specifiers are mutually exclusive; priority: commit > tag > branch
 */
export interface CreateChildOptions {
  /** Environment variables to pass to the child panel */
  env?: Record<string, string>;
  /** Custom panel ID (only used for tree panels, ignored for singletons) */
  panelId?: string;
  /** Branch name to track (e.g., "develop") */
  branch?: string;
  /** Specific commit hash to pin to (e.g., "abc123...") */
  commit?: string;
  /** Tag to pin to (e.g., "v1.0.0") */
  tag?: string;
}

export interface Panel {
  id: string;
  title: string;
  path: string;
  children: Panel[];
  selectedChildId: string | null;
  injectHostThemeVariables: boolean;
  artifacts: PanelArtifacts;
  env?: Record<string, string>;
  /** Optional source repo when served from in-memory artifacts */
  sourceRepo?: string;
  /** Git dependencies from manifest (to clone into OPFS) */
  gitDependencies?: Record<string, GitDependencySpec>;
}

// =============================================================================
// IPC Channel Definitions
// =============================================================================

// App-related IPC channels (renderer <-> main)
export interface AppIpcApi {
  "app:get-info": () => AppInfo;
  "app:get-system-theme": () => ThemeAppearance;
  "app:set-theme-mode": (mode: ThemeMode) => void;
  "app:open-devtools": () => void;
  "app:get-panel-preload-path": () => string;
  "app:clear-build-cache": () => void;
}

// Panel-related IPC channels (renderer <-> main)
export interface PanelIpcApi {
  "panel:get-tree": () => Panel[];
  "panel:notify-focus": (panelId: string) => void;
  "panel:update-theme": (theme: ThemeAppearance) => void;
  "panel:open-devtools": (panelId: string) => void;
}

// Panel bridge IPC channels (panel webview <-> main)
export interface PanelBridgeIpcApi {
  /**
   * Create a child panel from a workspace path.
   * Main process handles git checkout and build.
   * Returns panel ID immediately; build happens async.
   */
  "panel-bridge:create-child": (
    parentId: string,
    childPath: string,
    options?: CreateChildOptions
  ) => string;

  "panel-bridge:remove-child": (parentId: string, childId: string) => void;
  "panel-bridge:set-title": (panelId: string, title: string) => void;
  "panel-bridge:close": (panelId: string) => void;
  "panel-bridge:register": (panelId: string, authToken: string) => void;
  "panel-bridge:get-env": (panelId: string) => Record<string, string>;
  "panel-bridge:get-info": (panelId: string) => PanelInfo;

  /**
   * Get git configuration for a panel.
   * Used by panels to clone/pull their source and dependencies via @natstack/git.
   */
  "panel-bridge:get-git-config": (panelId: string) => {
    serverUrl: string;
    token: string;
    sourceRepo: string;
    gitDependencies: Record<string, GitDependencySpec>;
  };

  // Panel-to-panel RPC
  // Request a direct MessagePort connection to another panel
  "panel-rpc:connect": (fromPanelId: string, toPanelId: string) => void;
}

// AI provider IPC channels (panel webview <-> main)
// Note: panelId is derived from the IPC sender identity for security
export interface AIProviderIpcApi {
  /** Non-streaming text generation */
  "ai:generate": (modelId: string, options: AICallOptions) => AIGenerateResult;

  /** Start a streaming generation - chunks sent via ai:stream-chunk events */
  "ai:stream-start": (modelId: string, options: AICallOptions, streamId: string) => void;

  /** Cancel an active streaming generation */
  "ai:stream-cancel": (streamId: string) => void;

  /** Get record of configured roles and their assigned models */
  "ai:list-roles": () => AIRoleRecord;

  // Claude Code conversation management (for tool callback support)

  /**
   * Start a Claude Code conversation with tools.
   * Returns a conversationId that must be passed to subsequent calls.
   */
  "ai:cc-conversation-start": (
    modelId: string,
    tools: AIToolDefinition[]
  ) => ClaudeCodeConversationInfo;

  /**
   * Generate with an existing Claude Code conversation.
   * Tools are executed via ai:cc-tool-execute events.
   */
  "ai:cc-generate": (conversationId: string, options: AICallOptions) => AIGenerateResult;

  /**
   * Stream with an existing Claude Code conversation.
   * Tools are executed via ai:cc-tool-execute events.
   */
  "ai:cc-stream-start": (conversationId: string, options: AICallOptions, streamId: string) => void;

  /** End a Claude Code conversation and clean up resources */
  "ai:cc-conversation-end": (conversationId: string) => void;

  /** Response from panel after executing a tool (called by panel) */
  "ai:cc-tool-result": (executionId: string, result: ClaudeCodeToolResult) => void;
}

// =============================================================================
// Claude Code Conversation Types
// =============================================================================

/** Information about a started Claude Code conversation */
export interface ClaudeCodeConversationInfo {
  conversationId: string;
  /** MCP tool names that were registered (for debugging) */
  registeredTools: string[];
}

/** Tool execution request sent from main to panel (via IPC event) */
export interface ClaudeCodeToolExecuteRequest {
  /** Panel ID for security validation (receivers must check this matches their panelId) */
  panelId: string;
  /** Unique ID for this execution (for matching result) */
  executionId: string;
  /** Conversation this tool call belongs to */
  conversationId: string;
  /** Name of the tool to execute */
  toolName: string;
  /** Arguments for the tool */
  args: Record<string, unknown>;
}

/** Tool execution result sent from panel to main */
export interface ClaudeCodeToolResult {
  /** Text content of the result */
  content: Array<{ type: "text"; text: string }>;
  /** Whether the tool execution resulted in an error */
  isError?: boolean;
}

// =============================================================================
// Workspace & Settings Types
// =============================================================================

/**
 * Application mode for startup flow:
 * - chooser: Show workspace chooser (with setup modal if no providers)
 * - main: Has workspace - show main panel UI
 */
export type AppMode = "chooser" | "main";

export interface RecentWorkspace {
  path: string;
  name: string;
  lastOpened: number;
}

export interface WorkspaceValidation {
  path: string;
  name: string;
  isValid: boolean;
  hasConfig: boolean;
  error?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  hasApiKey: boolean;
  models: string[];
  /** True if provider uses CLI authentication instead of API key */
  usesCliAuth?: boolean;
  /** True if provider is enabled (for CLI auth providers) */
  isEnabled?: boolean;
}

export interface AvailableProvider {
  id: string;
  name: string;
  envVar: string;
  /** True if provider uses CLI authentication instead of API key */
  usesCliAuth?: boolean;
}

/**
 * Simplified model role config for IPC (string format only).
 * Full ModelConfig objects are converted to "provider:model" strings.
 */
export interface ModelRoleConfig {
  smart?: string;
  coding?: string;
  fast?: string;
  cheap?: string;
  [key: string]: string | undefined;
}

export interface SettingsData {
  providers: ProviderInfo[];
  modelRoles: ModelRoleConfig;
  availableProviders: AvailableProvider[];
  /** Whether at least one provider has an API key */
  hasConfiguredProviders: boolean;
}

// =============================================================================
// Workspace & Settings IPC Channels
// =============================================================================

// Central data IPC channels (workspace chooser, recent workspaces)
export interface CentralDataIpcApi {
  "central:get-recent-workspaces": () => RecentWorkspace[];
  "central:add-recent-workspace": (path: string) => void;
  "central:remove-recent-workspace": (path: string) => void;
}

// Workspace management IPC channels
export interface WorkspaceIpcApi {
  "workspace:validate-path": (path: string) => WorkspaceValidation;
  "workspace:open-folder-dialog": () => string | null;
  "workspace:create": (path: string, name: string) => WorkspaceValidation;
  "workspace:select": (path: string) => void;
}

// Settings IPC channels
export interface SettingsIpcApi {
  "settings:get-data": () => SettingsData;
  "settings:set-api-key": (providerId: string, apiKey: string) => void;
  "settings:remove-api-key": (providerId: string) => void;
  "settings:set-model-role": (role: string, modelSpec: string) => void;
  /** Enable a CLI-auth provider (like claude-code) */
  "settings:enable-provider": (providerId: string) => void;
  /** Disable a CLI-auth provider */
  "settings:disable-provider": (providerId: string) => void;
}

// App mode IPC channels
export interface AppModeIpcApi {
  "app:get-mode": () => AppMode;
}

// Combined API for type utilities
export type AllIpcApi = AppIpcApi &
  PanelIpcApi &
  PanelBridgeIpcApi &
  AIProviderIpcApi &
  CentralDataIpcApi &
  WorkspaceIpcApi &
  SettingsIpcApi &
  AppModeIpcApi;

// =============================================================================
// Type utilities for extracting channel info
// =============================================================================

export type IpcChannel = keyof AllIpcApi;

export type IpcHandler<C extends IpcChannel> = AllIpcApi[C];

export type IpcParams<C extends IpcChannel> = Parameters<AllIpcApi[C]>;

export type IpcReturn<C extends IpcChannel> = ReturnType<AllIpcApi[C]>;
