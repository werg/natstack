// Shared types for typed IPC communication

import type {
  CreateChildOptions,
  ChildCreationResult,
  ChildSpec,
  AppChildSpec,
  WorkerChildSpec,
  BrowserChildSpec,
} from "@natstack/runtime";
import type { RepoArgSpec } from "@natstack/git";
import type { RpcMessage, RpcResponse } from "@natstack/rpc";

// Re-export types for consumers of this module
export type {
  CreateChildOptions,
  ChildCreationResult,
  ChildSpec,
  AppChildSpec,
  WorkerChildSpec,
  BrowserChildSpec,
  RepoArgSpec,
};

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
export type PanelBuildState = "pending" | "cloning" | "building" | "ready" | "error" | "dirty" | "not-git-repo";

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
  /** Absolute path to dirty repo (when buildState === "dirty") */
  dirtyRepoPath?: string;
  /** Absolute path to non-git directory (when buildState === "not-git-repo") */
  notGitRepoPath?: string;
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
  /** Additional asset files (path -> content + encoding) */
  assets?: Record<string, { content: string; encoding?: "utf8" | "base64" }>;
  /** Whether to inject host theme variables (defaults to true) */
  injectHostThemeVariables?: boolean;
  /** Optional source repo path (workspace-relative) to retain git association */
  sourceRepo?: string;
  /** Repo args declared in manifest (slot names only) */
  repoArgs?: string[];
}

/**
 * A single console log entry from a worker.
 */
export interface WorkerConsoleLogEntry {
  timestamp: number;
  level: string;
  message: string;
}

// Panel interface moved to discriminated union types section below
// See: AppPanel, WorkerPanel, BrowserPanel, Panel

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
  /** Reload a panel's webview */
  "panel:reload": (panelId: string) => void;
  /** Close a panel and its children */
  "panel:close": (panelId: string) => void;
  /** Retry build for a panel that was blocked by dirty worktree */
  "panel:retry-dirty-build": (panelId: string) => void;
  /** Initialize git repo for panel blocked by not-git-repo state */
  "panel:init-git-repo": (panelId: string) => void;
  /**
   * Register a browser panel's webview with the CDP server.
   * Called by renderer when a browser webview's dom-ready fires.
   * @param browserId - The browser panel's ID
   * @param webContentsId - The webContents ID from the webview
   */
  "panel:register-browser-webview": (browserId: string, webContentsId: number) => void;
  /**
   * Update browser panel state (URL, loading, navigation).
   * Called by renderer when webview events fire.
   */
  "panel:update-browser-state": (
    browserId: string,
    state: Partial<BrowserState> & { url?: string }
  ) => void;
}

// View management IPC channels (renderer <-> main for WebContentsView bounds/visibility)
export interface ViewIpcApi {
  /**
   * Set bounds for a WebContentsView.
   * Called from renderer when layout changes (resize, panel switch).
   */
  "view:set-bounds": (
    viewId: string,
    bounds: { x: number; y: number; width: number; height: number }
  ) => void;
  /**
   * Set visibility of a WebContentsView.
   */
  "view:set-visible": (viewId: string, visible: boolean) => void;
  /**
   * Set theme CSS to inject into views that have injectHostThemeVariables enabled.
   */
  "view:set-theme-css": (css: string) => void;
  /**
   * Navigate a browser view to a URL.
   */
  "view:browser-navigate": (browserId: string, url: string) => void;
  /**
   * Go back in browser history.
   */
  "view:browser-go-back": (browserId: string) => void;
  /**
   * Go forward in browser history.
   */
  "view:browser-go-forward": (browserId: string) => void;
  /**
   * Reload a browser view.
   */
  "view:browser-reload": (browserId: string) => void;
  /**
   * Stop loading a browser view.
   */
  "view:browser-stop": (browserId: string) => void;
}

// Panel bridge IPC channels (panel webview <-> main)
export interface PanelBridgeIpcApi {
  /**
   * Initial panel <-> main handshake.
   * After this, panel calls should use `rpc:call` (service.method).
   */
  "panel-bridge:register": (panelId: string, authToken: string) => void;

  /**
   * Request an RPC connection to another panel or worker.
   * Unified endpoint for panel-to-panel, panel-to-worker, and worker-to-panel RPC.
   * The type (panel vs worker) is determined by looking up the ID in the tree.
   * @param fromId - Source endpoint ID
   * @param toId - Target endpoint ID
   * @returns Info about the connection (whether target is a worker)
   */
  "panel-rpc:connect": (fromId: string, toId: string) => { isWorker: boolean; workerId?: string };

  /**
   * Unified RPC entrypoint for panel -> main service calls.
   * Accepts a standard RpcRequest and returns a matching RpcResponse.
   *
   * Method format: "service.method" (e.g., "db.open", "bridge.createChild", "ai.listRoles").
   *
   * Note: panel registration/handshake remains on "panel-bridge:register".
   */
  "rpc:call": (panelId: string, message: RpcMessage) => RpcResponse;
}

// Main-to-panel IPC channels (main -> panel webview via invoke)
export interface MainToPanelIpcApi {
  /**
   * Execute a tool in the panel (called by main process).
   * This is a bidirectional RPC where main invokes the panel.
   */
  "panel:execute-tool": (
    toolName: string,
    args: Record<string, unknown>
  ) => ToolExecutionResult;
}

// =============================================================================
// StreamText Types (Unified AI API)
// =============================================================================

// Import types from @natstack/ai to avoid duplication
// These are the canonical message types used by both panels and IPC
import type { Message as AIMessage } from "@natstack/ai";

/** Message type for IPC - directly uses AI SDK message format */
export type StreamTextMessage = AIMessage;

/** Tool definition for IPC */
export interface StreamTextToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/** Options for streamText IPC call */
export interface StreamTextOptions {
  model: string;
  messages: StreamTextMessage[];
  tools?: StreamTextToolDefinition[];
  maxSteps?: number;
  maxOutputTokens?: number;
  temperature?: number;
  system?: string;
}

/** Stream event sent from main to panel */
export interface StreamTextEvent {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  stepNumber?: number;
  finishReason?: string;
  totalSteps?: number;
  usage?: { promptTokens: number; completionTokens: number };
  error?: string;
}

/** Tool execution request sent from main to panel (via IPC event) */
export interface ToolExecuteRequest {
  /** Panel ID for security validation */
  panelId: string;
  /** Stream ID this tool execution belongs to */
  streamId: string;
  /** Unique ID for this execution (for matching result) */
  executionId: string;
  /** Name of the tool to execute */
  toolName: string;
  /** Arguments for the tool */
  args: Record<string, unknown>;
}

/** Tool execution result sent from panel to main */
export interface ToolExecutionResult {
  /** Text content of the result */
  content: Array<{ type: "text"; text: string }>;
  /** Whether the tool execution resulted in an error */
  isError?: boolean;
  /** Optional structured data (e.g., for code execution results with components) */
  data?: unknown;
}

/** Event sent from main to panel with stream chunks */
export interface StreamTextChunkEvent {
  panelId: string;
  streamId: string;
  chunk: StreamTextEvent;
}

/** Event sent from main to panel when stream ends */
export interface StreamTextEndEvent {
  panelId: string;
  streamId: string;
}

// =============================================================================
// Panel Type Discriminated Unions
// =============================================================================

/**
 * Panel type discriminator.
 * - "app": Built webview from source code
 * - "worker": Isolated-vm background process
 * - "browser": External URL with Playwright automation
 */
export type PanelType = "app" | "worker" | "browser";

/**
 * Browser panel navigation state.
 */
export interface BrowserState {
  pageTitle: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * Base panel fields common to all panel types.
 */
interface PanelBase {
  id: string;
  title: string;
  children: Panel[];
  selectedChildId: string | null;
  artifacts: PanelArtifacts;
  env?: Record<string, string>;
}

/**
 * App panel - built webview from source code.
 */
export interface AppPanel extends PanelBase {
  type: "app";
  path: string; // Workspace-relative source path
  sourceRepo?: string;
  branch?: string;
  commit?: string;
  tag?: string;
  /** Resolved repo args (name -> spec) provided by parent at createChild time */
  resolvedRepoArgs?: Record<string, RepoArgSpec>;
  injectHostThemeVariables: boolean;
  /**
   * Run panel with full Node.js API access instead of browser sandbox.
   * - `true`: Unsafe mode with default scoped filesystem
   * - `string`: Unsafe mode with custom filesystem root (e.g., "/" for full access)
   */
  unsafe?: boolean | string;
}

/**
 * Worker panel - isolated-vm background process.
 */
export interface WorkerPanel extends PanelBase {
  type: "worker";
  path: string; // Workspace-relative source path
  sourceRepo?: string;
  branch?: string;
  commit?: string;
  tag?: string;
  /** Resolved repo args (name -> spec) provided by parent at createChild time */
  resolvedRepoArgs?: Record<string, RepoArgSpec>;
  workerOptions?: { memoryLimitMB?: number; unsafe?: boolean | string };
  consoleLogs?: WorkerConsoleLogEntry[];
}

/**
 * Browser panel - external URL with Playwright control.
 */
export interface BrowserPanel extends PanelBase {
  type: "browser";
  url: string; // Current URL
  browserState: BrowserState;
  /** Browser panels don't inject host theme - external sites have their own styles */
  injectHostThemeVariables: false;
}

/**
 * Union type of all panel types.
 */
export type Panel = AppPanel | WorkerPanel | BrowserPanel;

// =============================================================================
// Isolated Worker Types
// =============================================================================

/**
 * Runtime type for manifests - determines whether to build as panel or worker.
 * @deprecated Use PanelType instead. This is kept for manifest compatibility.
 */
export type RuntimeType = "panel" | "worker";

/**
 * Build state for workers (same as panels).
 */
export type WorkerBuildState = "pending" | "cloning" | "building" | "ready" | "error" | "dirty";

/**
 * Options for creating a worker from a panel.
 * Note: scopePath is auto-generated based on workspace ID and worker ID.
 */
export interface WorkerCreateOptions {
  /** Environment variables to pass to the worker */
  env?: Record<string, string>;
  /** Memory limit in MB (default: 1024) */
  memoryLimitMB?: number;
  /**
   * Run worker with full Node.js API access instead of sandboxed vm.Context.
   * - `true`: Unsafe mode with default scoped filesystem
   * - `string`: Unsafe mode with custom filesystem root (e.g., "/" for full access)
   */
  unsafe?: boolean | string;
  /** Branch name to track (e.g., "develop") */
  branch?: string;
  /** Specific commit hash to pin to */
  commit?: string;
  /** Tag to pin to (e.g., "v1.0.0") */
  tag?: string;
}

/**
 * Information about a created worker.
 */
export interface WorkerInfo {
  /** Worker ID (prefixed with "worker:") */
  workerId: string;
  /** Build state */
  buildState: WorkerBuildState;
  /** Error message if build failed */
  error?: string;
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

// Menu IPC channels (native menus that render above WebContentsViews)
export interface MenuIpcApi {
  /** Show the hamburger menu at the given position */
  "menu:show-hamburger": (position: { x: number; y: number }) => void;
  /** Show a context menu with dynamic items, returns selected item ID or null */
  "menu:show-context": (
    items: Array<{ id: string; label: string }>,
    position: { x: number; y: number }
  ) => string | null;
  /**
   * Show a panel context menu (tab-like) with standard actions.
   * Returns the action that was selected, or null if dismissed.
   */
  "menu:show-panel-context": (
    panelId: string,
    panelType: PanelType,
    position: { x: number; y: number }
  ) => PanelContextMenuAction | null;
}

/** Actions available in panel context menus */
export type PanelContextMenuAction = "reload" | "close" | "close-siblings" | "close-subtree";

// Combined API for type utilities
export type AllIpcApi = AppIpcApi &
  PanelIpcApi &
  ViewIpcApi &
  PanelBridgeIpcApi &
  CentralDataIpcApi &
  WorkspaceIpcApi &
  SettingsIpcApi &
  AppModeIpcApi &
  MenuIpcApi;

// =============================================================================
// Type utilities for extracting channel info
// =============================================================================

export type IpcChannel = keyof AllIpcApi;

export type IpcHandler<C extends IpcChannel> = AllIpcApi[C];

export type IpcParams<C extends IpcChannel> = Parameters<AllIpcApi[C]>;

export type IpcReturn<C extends IpcChannel> = ReturnType<AllIpcApi[C]>;
