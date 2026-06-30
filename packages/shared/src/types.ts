// Shared types used across main, renderer, server, and preload

import type { CreateChildOptions, ChildCreationResult, ChildSpec } from "@natstack/types";
import type { StateArgsSchema, StateArgsValue } from "./stateArgs.js";

// Re-export types for consumers of this module
export type { CreateChildOptions, ChildCreationResult, ChildSpec, StateArgsSchema, StateArgsValue };

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
  /** Human-readable display name shared by all workspace unit kinds. */
  displayName?: string;
  /** Display title (required at runtime for panels; workers don't need it). */
  title?: string;
  /** Optional description shown in the launcher and used as documentation. */
  description?: string;
  /** Entry file relative to the package root (e.g., `"index.tsx"`, `"index.ts"`). */
  entry?: string;
  /** Extension discriminator block. Presence marks this package as an extension unit. */
  extension?: {
    /** v1 accepts only eager activation (`"*"`). */
    activationEvents?: string[];
    /**
     * Extension dependency handling. Defaults to "auto": bundle ordinary JS
     * dependencies and externalize packages that need runtime assets/native code.
     */
    dependencyMode?: "auto" | "bundle" | "external";
    /**
     * API methods that return a streaming `Response` and must be routed through
     * `extensions.invokeStream`. Declared here so consumers never have to know
     * the extension's internals — the client resolves them automatically.
     */
    streamingMethods?: string[];
  };
  /** Future shared manifest discriminator for worker units. */
  worker?: Record<string, unknown>;
  /** Future shared manifest discriminator for panel units. */
  panel?: Record<string, unknown>;
  // ----- Panel-only fields -----
  /** Top-level package.json dependencies merged in by `loadPanelManifest`. */
  dependencies?: Record<string, string>;
  /** JSON Schema for validating panel state arguments. */
  stateArgs?: StateArgsSchema;
  /** Inject the host theme CSS variables into the panel iframe. */
  injectHostThemeVariables?: boolean;
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
  /**
   * Marks this worker as a selectable chat agent and supplies gallery metadata.
   * Presence of this block is what distinguishes chat-agent DOs from service DOs
   * (pubsub-channel, gad-store, fork, …) in the chat panel's agent picker.
   */
  agent?: { displayName?: string; description?: string; icon?: string };
  // Note: userland services and HTTP routes are no longer declared per worker.
  // They live in `workspace/meta/natstack.yml` under `services:` and `routes:`,
  // joined against `singletonObjects:` for DO singleton keys.
}

export type ThemeMode = "light" | "dark" | "system";
export type ThemeAppearance = "light" | "dark";

/**
 * App-wide theme IDENTITY (accent/radius/scaling/surface), distinct from
 * light/dark `ThemeAppearance`. A user setting on the shell, broadcast live to
 * every panel over the runtime bridge (piggybacked on the `runtime:theme`
 * event) so changing the accent propagates everywhere without a reload.
 */
export interface ThemeConfig {
  accentColor: string;
  grayColor: string;
  radius: "none" | "small" | "medium" | "large" | "full";
  scaling: "90%" | "95%" | "100%" | "105%" | "110%";
  panelBackground: "solid" | "translucent";
}

/**
 * A command a panel contributes to the app-level command palette. The shell
 * aggregates these across panels and dispatches the chosen one back to the
 * owning panel over the runtime bridge (`runtime:palette-run`).
 */
export interface PaletteCommand {
  /** Stable id, unique within the contributing panel. */
  id: string;
  label: string;
  /** Optional secondary line. */
  hint?: string;
  /** Group label (e.g. the panel's name); items sharing one render together. */
  section?: string;
}

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
  title?: string;
  source?: string;
  kind?: "workspace" | "browser";
  parentId?: string | null;
  partition: string;
  contextId: string;
  runtimeEntityId?: string | null;
  effectiveVersion?: string | null;
  ref?: string;
  build?: {
    effectiveVersion?: string | null;
    ref?: string;
  };
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
  buildRevision?: number;
  /** Build state for async main-process builds */
  buildState?: PanelBuildState;
  /** Human-readable progress message (e.g., "Installing dependencies...") */
  buildProgress?: string;
  /** Detailed build log (esbuild output, errors, etc.) */
  buildLog?: string;
}

export interface PanelBuildStatus {
  state?: PanelBuildState;
  revision?: number;
  artifactUrl?: string;
  bundlePath?: string;
  error?: string;
  progress?: string;
  log?: string;
}

export interface PanelViewStatus {
  exists: boolean;
  url?: string;
  visible?: boolean;
}

export interface PanelRuntimeStatus {
  leased: boolean;
  holderLabel?: string;
  platform?: "desktop" | "headless" | "mobile";
  hostConnectionId?: string;
  supportsCdp?: boolean;
  clientSessionId?: string;
  connectionId?: string;
}

export type PanelLifecycleOperation =
  | "reload"
  | "rebuild"
  | "rebuildAndReload"
  | "unload"
  | "close";

export interface PanelLifecycleResult {
  panelId: string;
  operation: PanelLifecycleOperation;
  status: string;
  loaded: boolean;
  rebuilt: boolean;
  reloaded: boolean;
  buildRevision?: number;
  effectiveVersion?: string | null;
}

export interface PanelExplicitState {
  build: PanelBuildStatus;
  view: PanelViewStatus;
  runtime?: PanelRuntimeStatus;
}

export type PanelFocusStatus =
  | "missing"
  | "focused"
  | "loaded"
  | "leased_elsewhere"
  | "build_failed"
  | "view_creation_failed";

export interface PanelFocusResult {
  panelId: string;
  status: PanelFocusStatus;
  focused: boolean;
  loaded: boolean;
  message?: string;
  holderLabel?: string;
}

export interface PanelTreeSnapshot {
  revision: number;
  rootPanels: Panel[];
}

export interface PanelRecoverySnapshot {
  revision: number;
  viewRevision: number;
  rootPanels: Panel[];
  collapsedIds: string[];
  focusedPanelId: string | null;
  focus?: PanelFocusResult;
}

// =============================================================================
// Tool Execution Result
// =============================================================================

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
  /** If true, this panel is privileged and approvals targeting it use severe tone. */
  privileged?: boolean;
}

/**
 * Runtime navigation state for the WebContents/WebView that is currently
 * rendering a panel. This is intentionally not persisted as part of the
 * snapshot; it reflects the live browser-like surface.
 */
export interface PanelNavigationState {
  url?: string;
  pageTitle?: string;
  isLoading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export interface PanelSnapshotHistory {
  entries: PanelSnapshot[];
  index: number;
}

/**
 * Panel runtime state. Configuration comes from current snapshot.
 */
export interface Panel {
  id: string;
  title: string;
  runtimeEntityId?: string | null;
  effectiveVersion?: string | null;

  // Tree structure
  children: Panel[];
  positionId?: string;
  selectedChildId?: string | null;
  snapshot: PanelSnapshot;
  history?: PanelSnapshotHistory;

  // Runtime only (not in snapshot)
  artifacts: PanelArtifacts;
  state?: PanelExplicitState;
  navigation?: PanelNavigationState;
}

// =============================================================================
// Workspace & Settings Types
// =============================================================================

export interface WorkspaceEntry {
  name: string;
  lastOpened: number;
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
  modelRoles: ModelRoleConfig;
}

/** Actions available in panel context menus */
export type PanelContextMenuAction =
  | "reload"
  | "reload-panel"
  | "reload-view"
  | "force-reload"
  | "force-reload-view"
  | "rebuild-panel"
  | "stop"
  | "back"
  | "forward"
  | "copy-address"
  | "copy-panel-id"
  | "open-external"
  | "duplicate"
  | "add-child"
  | "toggle-pin"
  | "unload"
  | "archive";

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
// Workspace Discovery Types (for workspace units and launchable panels)
// =============================================================================

/**
 * A node in the workspace tree.
 * Folders contain children, workspace units are leaves (children = []).
 */
export interface WorkspaceNode {
  /** Directory or unit name. */
  name: string;
  /**
   * Relative path from workspace root using forward slashes.
   * Example: "panels/editor"
   */
  path: string;
  /** True if this directory is a workspace unit root. */
  isUnit: boolean;
  /**
   * If this is a launchable panel (has natstack config).
   * Note: We intentionally include entries even if some fields are missing
   * (e.g., no title) - better to show them in the UI and let the build system
   * report the real error than to silently hide repos with incomplete configs.
   */
  launchable?: {
    type: "app";
    title: string;
    hidden?: boolean;
  };
  /**
   * Package metadata if this unit has a package.json with a name.
   */
  packageInfo?: {
    name: string;
    version?: string;
  };
  /**
   * Skill metadata if this unit has a SKILL.md file with YAML frontmatter.
   */
  skillInfo?: {
    name: string;
    description: string;
  };
  /** Child nodes (empty for workspace units since they're leaves). */
  children: WorkspaceNode[];
}

/**
 * Complete workspace tree with root-level children.
 */
export interface WorkspaceTree {
  /** Root children (top-level directories) */
  children: WorkspaceNode[];
}

// Shell IPC channels (shell renderer -> main for service calls)
