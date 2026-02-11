// Shared types used across main, renderer, server, and preload

import type {
  CreateChildOptions,
  ChildCreationResult,
  ChildSpec,
  AppChildSpec,
  WorkerChildSpec,
  BrowserChildSpec,
} from "@natstack/runtime";
import type { RepoArgSpec } from "@natstack/git";
import type { StateArgsSchema, StateArgsValue } from "./stateArgs.js";

// Re-export types for consumers of this module
export type {
  CreateChildOptions,
  ChildCreationResult,
  ChildSpec,
  AppChildSpec,
  WorkerChildSpec,
  BrowserChildSpec,
  RepoArgSpec,
  StateArgsSchema,
  StateArgsValue,
};

// =============================================================================
// Panel Manifest Types
// =============================================================================

/**
 * Schema for declaring environment variable requirements in panel manifests.
 * Enables launcher UI to show appropriate input fields.
 */
export interface EnvArgSchema {
  /** The environment variable name (e.g., "API_KEY") */
  name: string;
  /** Human-readable description for the UI */
  description?: string;
  /** Whether this env var is required (default: true) */
  required?: boolean;
  /** Default value if optional and not provided */
  default?: string;
}

/**
 * Panel manifest from package.json natstack section.
 */
export interface PanelManifest {
  type: "app" | "worker";
  title: string;
  entry?: string;
  dependencies?: Record<string, string>;
  repoArgs?: string[];
  envArgs?: EnvArgSchema[];
  /** JSON Schema for validating panel state arguments */
  stateArgs?: StateArgsSchema;
  externals?: Record<string, string>;
  exposeModules?: string[];
  dedupeModules?: string[];
  injectHostThemeVariables?: boolean;
  template?: "html" | "react";
  runtime?: "panel" | "worker";
  unsafe?: boolean | string;
}

export type ThemeMode = "light" | "dark" | "system";
export type ThemeAppearance = "light" | "dark";

/**
 * Result from ensurePanelLoaded - detailed info about panel load status.
 * Used for agent worker recovery to report errors to the user.
 */
export interface EnsureLoadedResult {
  /** Whether the panel is now loaded and ready */
  success: boolean;
  /** The current build state */
  buildState: string;
  /** Error message if failed */
  error?: string;
  /** Build log if available (for error diagnosis) */
  buildLog?: string;
}

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

/** Tool execution result sent from panel to main */
export interface ToolExecutionResult {
  /** Text content of the result */
  content: Array<{ type: "text"; text: string }>;
  /** Whether the tool execution resulted in an error */
  isError?: boolean;
  /** Optional structured data (e.g., for code execution results with components) */
  data?: unknown;
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
export type ShellPage = "model-provider-config" | "about" | "keyboard-shortcuts" | "help" | "new" | "adblock" | "agents";

/**
 * Browser panel navigation state (for browser webview internal state).
 */
export interface BrowserState {
  pageTitle: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

// =============================================================================
// PanelSnapshot - Unified Panel State (New Architecture)
// =============================================================================

/**
 * Complete panel configuration at one point in history.
 * Explicitly embeds CreateChildOptions to ensure correspondence.
 */
export interface PanelSnapshot {
  // === Required ===
  /** Path or URL - workspace-relative path for app/worker, URL for browser */
  source: string;
  /** Panel type */
  type: PanelType;
  /** Resolved context ID (e.g., "safe_tpl_abc123_instance") - determines storage isolation */
  contextId: string;

  // === Creation options (excluding runtime-only fields) ===
  /** Panel options from CreateChildOptions (excluding eventSchemas, focus) */
  options: Omit<CreateChildOptions, "eventSchemas" | "focus">;

  // === State arguments (separate from options) ===
  /** Validated state args for this snapshot (app/worker panels only) */
  stateArgs?: StateArgsValue;

  // === Type-specific (set during navigation/runtime) ===
  /** browser: actual URL after redirects */
  resolvedUrl?: string;
  /** app: history.pushState (sanitized) */
  pushState?: { state: unknown; path: string };
  /** shell: page name */
  page?: ShellPage;
  /** browser: internal webview navigation state */
  browserState?: BrowserState;
}

/**
 * Panel runtime state. Configuration comes from current snapshot.
 */
export interface Panel {
  id: string;
  title: string;

  // Tree structure
  children: Panel[];
  selectedChildId: string | null;

  // History = array of snapshots
  history: PanelSnapshot[];
  historyIndex: number;

  // Runtime only (not in snapshot)
  artifacts: PanelArtifacts;
}

// =============================================================================
// Isolated Worker Types
// =============================================================================

/**
 * Build state for workers (same as panels).
 */
export type WorkerBuildState = "pending" | "cloning" | "building" | "ready" | "error" | "dirty";

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
export type PanelContextMenuAction = "reload" | "unload" | "archive";

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

// =============================================================================
// Workspace Discovery Types (for git repos and launchable panels)
// =============================================================================

/**
 * A node in the workspace tree.
 * Folders contain children, git repos are leaves (children = []).
 */
export interface WorkspaceNode {
  /** Directory/repo name */
  name: string;
  /**
   * Relative path from workspace root using forward slashes.
   * Example: "panels/editor"
   */
  path: string;
  /** True if this directory is a git repository root */
  isGitRepo: boolean;
  /**
   * If this is a launchable panel/worker (has natstack config).
   * Note: We intentionally include entries even if some fields are missing
   * (e.g., no title) - better to show them in the UI and let panelBuilder
   * report the real error than to silently hide repos with incomplete configs.
   */
  launchable?: {
    type: "app" | "worker";
    title: string;
    repoArgs?: string[];
    envArgs?: EnvArgSchema[];
  };
  /**
   * Package metadata if this repo has a package.json with a name.
   * Used by VerdaccioServer to determine which repos are publishable packages.
   */
  packageInfo?: {
    name: string;
    version?: string;
  };
  /**
   * Skill metadata if this repo has a SKILL.md file with YAML frontmatter.
   * Skills are repos that provide instructions/context for agents.
   */
  skillInfo?: {
    name: string;
    description: string;
  };
  /** Child nodes (empty for git repos since they're leaves) */
  children: WorkspaceNode[];
}

/**
 * Complete workspace tree with root-level children.
 */
export interface WorkspaceTree {
  /** Root children (top-level directories) */
  children: WorkspaceNode[];
}

/**
 * Branch info for a git repository.
 */
export interface BranchInfo {
  name: string;
  current: boolean;
  remote?: string;
}

/**
 * Commit info for git log.
 */
export interface CommitInfo {
  oid: string;
  message: string;
  author: { name: string; timestamp: number };
}

// Shell IPC channels (shell renderer -> main for service calls)
