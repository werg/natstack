// Shared types used across main, renderer, server, and preload

import type {
  CreateChildOptions,
  ChildCreationResult,
  ChildSpec,
} from "@natstack/types";
import type { StateArgsSchema, StateArgsValue } from "./stateArgs.js";

// Re-export types for consumers of this module
export type {
  CreateChildOptions,
  ChildCreationResult,
  ChildSpec,
  StateArgsSchema,
  StateArgsValue,
};

// =============================================================================
// Package Manifest
// =============================================================================

/**
 * The `natstack` block of a workspace package's package.json.
 *
 * One canonical shape for panels, about pages, and workers. The build pipeline
 * (`src/server/buildV2`) and the runtime panel loader (`panelTypes.ts`) both
 * read from this same type. Each consumer uses the fields it cares about and
 * ignores the rest — workers ignore `dependencies` / `stateArgs`; panels ignore
 * `durable` / `framework`. `loadPanelManifest` enforces panel-specific
 * requirements (e.g., a non-empty `title`) at runtime, so all fields stay
 * optional in the type.
 */
export interface PackageManifest {
  /** Display title (required at runtime for panels; workers don't need it). */
  title?: string;
  /** Optional description shown in the launcher and used as documentation. */
  description?: string;
  /** Entry file relative to the package root (e.g., `"index.tsx"`, `"index.ts"`). */
  entry?: string;
  // ----- Panel-only fields -----
  /** Top-level package.json dependencies merged in by `loadPanelManifest`. */
  dependencies?: Record<string, string>;
  /** JSON Schema for validating panel state arguments. */
  stateArgs?: StateArgsSchema;
  /** Inject the host theme CSS variables into the panel iframe. */
  injectHostThemeVariables?: boolean;
  /** True for system "shell" panels (about pages); grants shell service access. */
  shell?: boolean;
  /** Hide this panel from the launcher UI. */
  hiddenInLauncher?: boolean;
  /** Auto-archive a panel when it has no children at startup. */
  autoArchiveWhenEmpty?: boolean;
  // ----- Build-pipeline fields -----
  /** Whether to include inline source maps in the build. */
  sourcemap?: boolean;
  /** Import-map externals (panels: produces `<script type="importmap">`). */
  externals?: Record<string, string>;
  /**
   * Modules registered on `globalThis.__natstackModuleMap__` so eval'd code
   * can `require()` them by canonical specifier without an explicit import.
   */
  exposeModules?: string[];
  /** Additional packages to deduplicate beyond the framework defaults. */
  dedupeModules?: string[];
  /** Name of a workspace template directory in `workspace/templates/`. */
  template?: string;
  /** Resolved framework ID — set at graph time from template, or at build time from extracted source. */
  framework?: string;
  // ----- Worker-only fields -----
  /** Durable Object classes exported by this worker (workers only). */
  durable?: { classes: Array<{ className: string }> };
}

export type ThemeMode = "light" | "dark" | "system";
export type ThemeAppearance = "light" | "dark";

export interface AppInfo {
  version: string;
  /** Connection mode: "local" (child process) or "remote" (standalone server) */
  connectionMode: "local" | "remote";
  /** Remote server hostname (only when connectionMode is "remote") */
  remoteHost?: string;
  /** Current connection status */
  connectionStatus: "connected" | "connecting" | "disconnected";
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

// =============================================================================
// StreamText Types (Unified AI API)
// =============================================================================

// Import types from @natstack/types to avoid duplication
// These are the canonical message types used by both panels and IPC
import type { Message as AIMessage } from "@natstack/types";

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
  /** Context ID for scoping AI working directory to the panel's context folder */
  contextId?: string;
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

// =============================================================================
// PanelSnapshot - Unified Panel State (New Architecture)
// =============================================================================

/**
 * Complete panel configuration at one point in history.
 * Explicitly embeds CreateChildOptions to ensure correspondence.
 */
export interface PanelSnapshot {
  /** Workspace-relative source path (e.g., "panels/chat", "about/new") */
  source: string;
  /** Resolved context ID (e.g., "ctx-panels-editor") - determines storage isolation */
  contextId: string;
  /** Panel options from CreateChildOptions (excluding eventSchemas, focus) */
  options: Omit<CreateChildOptions, "eventSchemas" | "focus">;
  /** Validated state args for this snapshot */
  stateArgs?: StateArgsValue;
  /** Actual URL after redirects (when applicable) */
  resolvedUrl?: string;
  /** If true, panel is auto-archived when it has no children (e.g., launcher panels) */
  autoArchiveWhenEmpty?: boolean;
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

  // Single current snapshot (replaces history array — browser handles history natively)
  snapshot: PanelSnapshot;

  // Runtime only (not in snapshot)
  artifacts: PanelArtifacts;
}

// =============================================================================
// Workspace & Settings Types
// =============================================================================


export interface WorkspaceEntry {
  name: string;
  lastOpened: number;
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
   * If this is a launchable panel (has natstack config).
   * Note: We intentionally include entries even if some fields are missing
   * (e.g., no title) - better to show them in the UI and let the build system
   * report the real error than to silently hide repos with incomplete configs.
   */
  launchable?: {
    title: string;
    hidden?: boolean;
  };
  /**
   * Package metadata if this repo has a package.json with a name.
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
