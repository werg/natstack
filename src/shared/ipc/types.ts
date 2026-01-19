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
  contextId: string;
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
// Panel interface moved to discriminated union types section below
// See: AppPanel, WorkerPanel, BrowserPanel, Panel

// =============================================================================
// IPC Channel Definitions
// =============================================================================

// Panel-related IPC channels (renderer <-> main)
// Note: Most panel operations now use RPC via shell-rpc:call or rpc:call.
// These are the remaining direct IPC channels.
export interface PanelIpcApi {
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
  /**
   * Open devtools for a panel.
   * Called by panel preload keyboard shortcut (Cmd/Ctrl+Shift+I).
   */
  "panel:open-devtools": (panelId: string) => void;
  /**
   * Push a history entry from an app panel (history.pushState).
   */
  "panel:history-push": (panelId: string, payload: { state: unknown; path: string }) => void;
  /**
   * Replace the current history entry from an app panel (history.replaceState).
   */
  "panel:history-replace": (panelId: string, payload: { state: unknown; path: string }) => void;
  /**
   * Navigate back in unified panel history (history.back).
   */
  "panel:history-back": (panelId: string) => void;
  /**
   * Navigate forward in unified panel history (history.forward).
   */
  "panel:history-forward": (panelId: string) => void;
  /**
   * Navigate by offset in unified panel history (history.go).
   */
  "panel:history-go": (panelId: string, offset: number) => void;
  /**
   * Reload the current history entry (history.go(0)).
   */
  "panel:history-reload": (panelId: string) => void;
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
   */
  "panel-rpc:connect": (fromId: string, toId: string) => void;

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
  /** Enable thinking/reasoning with optional budget */
  thinking?: { type: "enabled" | "disabled"; budgetTokens?: number };
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
 * - "worker": Background process in hidden WebContentsView
 * - "browser": External URL with Playwright automation
 * - "shell": System pages (settings, about, etc.) with full shell access
 */
export type PanelType = "app" | "worker" | "browser" | "shell";

/**
 * Shell panel page types.
 */
export type ShellPage = "model-provider-config" | "about" | "keyboard-shortcuts" | "help";

/**
 * Browser panel navigation state (legacy - for browser webview internal state).
 */
export interface BrowserState {
  pageTitle: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

// =============================================================================
// Panel Navigation State (Unified History)
// =============================================================================

/**
 * Entry in the unified panel navigation history.
 * All navigations (source changes, browser navigations, pushState) are tracked here.
 */
export interface NavigationEntry {
  /** Panel source path or external URL */
  source: string;
  /** Type of content at this entry */
  type: PanelType;
  /** For browser entries, the actual URL (may differ from source after redirects) */
  resolvedUrl?: string;
  /** For app panel pushState entries */
  pushState?: {
    /** The state object passed to pushState */
    state: unknown;
    /** The URL/path passed to pushState */
    path: string;
  };
}

/**
 * Unified navigation state for a panel.
 * Tracks history across source changes, browser navigations, and pushState calls.
 */
export interface NavigationState {
  /** Unified history stack */
  history: NavigationEntry[];
  /** Current position in history (0-indexed) */
  historyIndex: number;
  /** Whether the panel can navigate back */
  canGoBack: boolean;
  /** Whether the panel can navigate forward */
  canGoForward: boolean;
}

/**
 * Base panel fields common to all panel types.
 */
interface PanelBase {
  id: string;
  title: string;
  /** Context ID for storage partition (format: {mode}_{type}_{identifier}) */
  contextId: string;
  children: Panel[];
  selectedChildId: string | null;
  artifacts: PanelArtifacts;
  env?: Record<string, string>;
  /** If true, panel can be closed and is not persisted to SQLite */
  ephemeral?: boolean;
  /** Unified navigation state for browser-like back/forward */
  navigationState?: NavigationState;
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
 * Worker panel - background process in WebContentsView with built-in console UI.
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
  workerOptions?: { unsafe?: boolean | string };
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
 * Shell panel - system pages with full shell access (settings, about, etc.).
 */
export interface ShellPanel extends PanelBase {
  type: "shell";
  /** The shell page being displayed */
  page: ShellPage;
  /** Shell panels always inject host theme */
  injectHostThemeVariables: true;
}

/**
 * Union type of all panel types.
 */
export type Panel = AppPanel | WorkerPanel | BrowserPanel | ShellPanel;

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
 */
export interface WorkerCreateOptions {
  /** Environment variables to pass to the worker */
  env?: Record<string, string>;
  /**
   * Run worker with full Node.js API access instead of browser sandbox.
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

/** Actions available in panel context menus */
export type PanelContextMenuAction = "reload" | "unload" | "pin";

// =============================================================================
// Panel Move/Drag-and-Drop Types
// =============================================================================

/**
 * Request to move a panel to a new parent at a specific position.
 * Used for drag-and-drop reordering and reparenting.
 */
export interface MovePanelRequest {
  panelId: string;
  /** New parent ID, or null to make it a root panel */
  newParentId: string | null;
  /** Target position among siblings (0-indexed) */
  targetPosition: number;
}

/**
 * Request for paginated children.
 */
export interface GetChildrenPaginatedRequest {
  parentId: string;
  offset: number;
  limit: number;
}

/**
 * Response for paginated children.
 */
export interface PaginatedChildren {
  children: PanelSummary[];
  total: number;
  hasMore: boolean;
}

/**
 * Response for paginated root panels.
 */
export interface PaginatedRootPanels {
  panels: PanelSummary[];
  total: number;
  hasMore: boolean;
}

// =============================================================================
// Panel Summary Types (for tree queries and UI)
// =============================================================================

/**
 * Panel summary for tree queries (minimal data for UI).
 */
export interface PanelSummary {
  id: string;
  type: PanelType;
  title: string;
  childCount: number;
  buildState?: string;
  position: number;
  ephemeral?: boolean;
}

/**
 * Panel ancestor for breadcrumb rendering.
 */
export interface PanelAncestor {
  id: string;
  title: string;
  type: PanelType;
  depth: number;
}

/**
 * Sibling group at a descendant level for breadcrumb rendering.
 */
export interface DescendantSiblingGroup {
  depth: number;
  parentId: string;
  selectedId: string;
  siblings: PanelSummary[];
}

// Shell IPC channels (shell renderer -> main for service calls)
// Note: Most shell operations now use RPC via shell-rpc:call.
export interface ShellIpcApi {
  /**
   * RPC call from shell renderer (unified RPC transport).
   * Allows shell to use @natstack/runtime packages directly.
   */
  "shell-rpc:call": (message: RpcMessage) => RpcResponse;
}

// Combined API for type utilities (remaining IPC channels)
export type AllIpcApi = PanelIpcApi & PanelBridgeIpcApi & ShellIpcApi;

// =============================================================================
// Type utilities for extracting channel info
// =============================================================================

export type IpcChannel = keyof AllIpcApi;

export type IpcHandler<C extends IpcChannel> = AllIpcApi[C];

export type IpcParams<C extends IpcChannel> = Parameters<AllIpcApi[C]>;

export type IpcReturn<C extends IpcChannel> = ReturnType<AllIpcApi[C]>;
