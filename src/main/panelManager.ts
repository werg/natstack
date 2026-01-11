import * as path from "path";
import { randomBytes } from "crypto";
import { nativeTheme } from "electron";
import { PanelBuilder } from "./panelBuilder.js";
import type { PanelEventPayload, Panel, PanelManifest, BrowserPanel } from "./panelTypes.js";
import { getActiveWorkspace, getSessionScopePath } from "./paths.js";
import type { GitServer } from "./gitServer.js";
import { normalizeRelativePanelPath } from "./pathUtils.js";
import * as SharedPanel from "../shared/ipc/types.js";
import { getClaudeCodeConversationManager } from "./ai/claudeCodeConversationManager.js";
import {
  storeProtocolPanel,
  removeProtocolPanel,
  isProtocolPanel,
} from "./panelProtocol.js";
import { getCdpServer } from "./cdpServer.js";
import { getPubSubServer } from "./pubsubServer.js";
import { getTokenManager } from "./tokenManager.js";
import type { ViewManager } from "./viewManager.js";
import { parseChildUrl } from "./childProtocol.js";
import { checkWorktreeClean, checkGitRepository } from "./gitProvisioner.js";
import { PANEL_CSP_META } from "../shared/constants.js";

type ChildCreateOptions = {
  name?: string;
  env?: Record<string, string>;
  gitRef?: string;
  repoArgs?: Record<string, SharedPanel.RepoArgSpec>;
  unsafe?: boolean | string;
  sourcemap?: boolean;
  /** Explicit session ID to join (must match panel's safe/unsafe mode) */
  sessionId?: string;
  /** Force creation of a new named session instead of deriving from panel ID */
  newSession?: boolean;
  /** Legacy fields (still supported programmatically) */
  branch?: string;
  commit?: string;
  tag?: string;
};

// =============================================================================
// Session ID Utilities
// =============================================================================

type SessionMode = "safe" | "unsafe";
type SessionType = "auto" | "named";

interface ParsedSessionId {
  mode: SessionMode;
  type: SessionType;
  identifier: string;
}

/**
 * Parse a session ID into its components.
 * Format: {mode}_{type}_{identifier}
 * Examples: safe_auto_tree~panels~editor, unsafe_named_lx8f2k-abc123
 */
function parseSessionId(sessionId: string): ParsedSessionId | null {
  const match = sessionId.match(/^(safe|unsafe)_(auto|named)_(.+)$/);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  return {
    mode: match[1] as SessionMode,
    type: match[2] as SessionType,
    identifier: match[3],
  };
}

/**
 * Derive an auto session ID from a panel's tree path.
 * These are deterministic and resumable - same path = same session.
 */
function deriveAutoSessionId(mode: SessionMode, panelId: string): string {
  const escaped = panelId.replace(/\//g, "~");
  return `${mode}_auto_${escaped}`;
}

/**
 * Generate a random named session ID.
 * These are non-resumable - each call creates a new unique session.
 */
function generateNamedSessionId(mode: SessionMode): string {
  const id = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  return `${mode}_named_${id}`;
}

/**
 * Validate an explicit session ID from user input.
 * Throws if the session ID is invalid or mode doesn't match.
 */
function validateSessionId(sessionId: string, expectedMode: SessionMode): void {
  const parsed = parseSessionId(sessionId);
  if (!parsed) {
    throw new Error(`Invalid session ID format: ${sessionId}`);
  }
  if (parsed.mode !== expectedMode) {
    throw new Error(
      `Session mode mismatch: ${sessionId} is ${parsed.mode}, expected ${expectedMode}`
    );
  }
}

export class PanelManager {
  private builder: PanelBuilder;
  private viewManager: ViewManager | null = null;
  private panels: Map<string, Panel> = new Map();
  private reservedPanelIds: Set<string> = new Set();
  private rootPanels: Panel[] = [];
  private currentTheme: "light" | "dark" = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  private panelsRoot: string;
  private gitServer: GitServer;

  // Debounce state for panel tree updates
  private treeUpdatePending = false;
  private treeUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly TREE_UPDATE_DEBOUNCE_MS = 16; // ~1 frame at 60fps

  private initialRootPanelPath: string | null = null;

  constructor(initialRootPanelPath: string, gitServer: GitServer) {
    this.gitServer = gitServer;
    const workspace = getActiveWorkspace();
    this.panelsRoot = workspace?.path ?? path.resolve(process.cwd());
    this.builder = new PanelBuilder();
    // Defer root panel initialization until ViewManager is set
    this.initialRootPanelPath = initialRootPanelPath;
  }

  /**
   * Set the ViewManager for creating and managing panel views.
   * Must be called after window creation. This triggers deferred root panel initialization.
   */
  setViewManager(vm: ViewManager): void {
    this.viewManager = vm;

    // Now that ViewManager is set, initialize the root panel if deferred
    if (this.initialRootPanelPath) {
      const rootPath = this.initialRootPanelPath;
      this.initialRootPanelPath = null; // Clear to prevent re-initialization
      this.initializeRootPanel(rootPath).catch((error) => {
        console.error("[PanelManager] Failed to initialize root panel:", error);
        // Notify shell about the failure so user sees feedback
        const shellContents = vm.getShellWebContents();
        if (!shellContents.isDestroyed()) {
          shellContents.send("panel:initialization-error", {
            path: rootPath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }
  }

  /**
   * Get the ViewManager (throws if not set).
   */
  getViewManager(): ViewManager {
    if (!this.viewManager) {
      throw new Error("ViewManager not set - call setViewManager first");
    }
    return this.viewManager;
  }

  /**
   * Create a WebContentsView for a panel or browser.
   * Called when panel build is ready or browser is created.
   * @param panelId - The panel's tree ID
   * @param url - The URL to load
   * @param type - The view type
   * @param sessionId - The session ID for partition (required for panel/worker, ignored for browser)
   * @throws Error if ViewManager is not set
   */
  createViewForPanel(panelId: string, url: string, type: "panel" | "browser" | "worker", sessionId?: string): void {
    if (!this.viewManager) {
      throw new Error(`[PanelManager] ViewManager not set, cannot create view for ${panelId}`);
    }

    if (this.viewManager.hasView(panelId)) {
      // View already exists, navigate if URL changed
      const currentUrl = this.viewManager.getViewUrl(panelId);
      if (currentUrl !== url) {
        void this.viewManager.navigateView(panelId, url);
      }
      return; // View exists and is handled
    }

    const panel = this.panels.get(panelId);
    const parentId = this.findParentId(panelId);

    if (type === "browser") {
      // Browser panels: no preload, shared session for cookies/auth
      const view = this.viewManager.createView({
        id: panelId,
        type: "browser",
        // No partition = default session (shared across browsers)
        preload: null, // No preload for browsers
        url: url,
        parentId: parentId ?? undefined,
        injectHostThemeVariables: false,
      });

      // Register with CDP server when dom-ready
      if (parentId) {
        view.webContents.on("dom-ready", () => {
          getCdpServer().registerBrowser(panelId, view.webContents.id, parentId);
        });
      }

      // Track browser state changes
      this.setupBrowserStateTracking(panelId, view.webContents);

      // Intercept natstack-child:// and new-window navigations for child creation
      this.setupChildLinkInterception(panelId, view.webContents, "browser");
    } else if (type === "worker") {
      // Worker panels: isolated partition, worker preload with auth token and env
      const authToken = randomBytes(32).toString("hex");
      this.pendingAuthTokens.set(panelId, { token: authToken, createdAt: Date.now() });
      this.cleanupExpiredAuthTokens();

      // Build additional arguments for preload
      const additionalArgs: string[] = [
        `--natstack-panel-id=${panelId}`,
        `--natstack-auth-token=${authToken}`,
        `--natstack-theme=${this.currentTheme}`,
        `--natstack-kind=worker`,
        `--natstack-session-id=${sessionId ?? ""}`,
      ];

      // Add worker env if available
      if (panel?.env && Object.keys(panel.env).length > 0) {
        try {
          const encodedEnv = Buffer.from(JSON.stringify(panel.env), "utf-8").toString("base64");
          additionalArgs.push(`--natstack-panel-env=${encodedEnv}`);
        } catch (error) {
          console.error(`[PanelManager] Failed to encode env for worker ${panelId}`, error);
        }
      }

      // Get unsafe flag for workers (undefined = safe worker using ZenFS)
      const unsafeFlag = panel?.type === "worker" ? (panel as SharedPanel.WorkerPanel).workerOptions?.unsafe : undefined;

      // Calculate and add scope path for unsafe workers.
      // Safe workers (unsafeFlag === undefined) use ZenFS and don't need a scope path.
      // Unsafe workers get either a custom root (string) or the default scoped path (true).
      if (unsafeFlag) {
        const workspace = getActiveWorkspace();
        if (workspace) {
          const scopePath =
            typeof unsafeFlag === "string"
              ? unsafeFlag // Custom root (e.g., "/" for full access)
              : getSessionScopePath(workspace.config.id, sessionId ?? panelId); // Session-based scope
          additionalArgs.push(`--natstack-scope-path=${scopePath}`);
        }
      }

      this.viewManager.createView({
        id: panelId,
        type: "worker",
        partition: `persist:${sessionId ?? panelId}`, // Session-based partition
        url: url,
        parentId: parentId ?? undefined,
        injectHostThemeVariables: true,
        additionalArguments: additionalArgs,
        unsafe: unsafeFlag,
      });
    } else {
      // App panels: isolated partition, panel preload with auth token and env
      const authToken = randomBytes(32).toString("hex");
      this.pendingAuthTokens.set(panelId, { token: authToken, createdAt: Date.now() });

      // Periodic cleanup of expired tokens (runs lazily on each panel creation)
      this.cleanupExpiredAuthTokens();

      // Build additional arguments for preload
      const additionalArgs: string[] = [
        `--natstack-panel-id=${panelId}`,
        `--natstack-auth-token=${authToken}`,
        `--natstack-theme=${this.currentTheme}`,
        `--natstack-kind=panel`,
        `--natstack-session-id=${sessionId ?? ""}`,
      ];

      // Add panel env if available
      if (panel?.env && Object.keys(panel.env).length > 0) {
        try {
          const encodedEnv = Buffer.from(JSON.stringify(panel.env), "utf-8").toString("base64");
          additionalArgs.push(`--natstack-panel-env=${encodedEnv}`);
        } catch (error) {
          console.error(`[PanelManager] Failed to encode env for panel ${panelId}`, error);
        }
      }

      // Get unsafe flag for app panels
      const unsafeFlag = panel?.type === "app" ? (panel as SharedPanel.AppPanel).unsafe : undefined;

      // Calculate and add scope path for unsafe panels
      if (unsafeFlag !== undefined) {
        const workspace = getActiveWorkspace();
        if (workspace) {
          const scopePath =
            typeof unsafeFlag === "string"
              ? unsafeFlag // Custom root (e.g., "/" for full access)
              : getSessionScopePath(workspace.config.id, sessionId ?? panelId); // Session-based scope
          additionalArgs.push(`--natstack-scope-path=${scopePath}`);
        }
      }

      const view = this.viewManager.createView({
        id: panelId,
        type: "panel",
        partition: `persist:${sessionId ?? panelId}`, // Session-based partition
        url: url,
        parentId: parentId ?? undefined,
        injectHostThemeVariables: panel?.type === "app" ? (panel as SharedPanel.AppPanel).injectHostThemeVariables : true,
        additionalArguments: additionalArgs,
        unsafe: unsafeFlag,
      });

      // Register app panels with CDP server for automation/testing (like browsers)
      if (parentId) {
        view.webContents.on("dom-ready", () => {
          getCdpServer().registerBrowser(panelId, view.webContents.id, parentId);
        });
      }

      // Intercept natstack-child:// and http(s) link clicks to create children
      this.setupChildLinkInterception(panelId, view.webContents, "panel");
    }
  }

  /**
   * Setup webContents event tracking for browser state (URL, loading, navigation).
   */
  private setupBrowserStateTracking(browserId: string, contents: Electron.WebContents): void {
    let pendingState: Partial<SharedPanel.BrowserState & { url?: string }> = {};
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    const flushPendingState = () => {
      if (destroyed) return; // Don't update after destruction
      if (Object.keys(pendingState).length > 0) {
        this.updateBrowserState(browserId, pendingState);
        pendingState = {};
      }
      debounceTimer = null;
    };

    const queueStateUpdate = (update: typeof pendingState) => {
      if (destroyed) return; // Don't queue after destruction
      Object.assign(pendingState, update);
      if (!debounceTimer) {
        debounceTimer = setTimeout(flushPendingState, 50);
      }
    };

    // Clean up debounce timer when webContents is destroyed
    contents.once("destroyed", () => {
      destroyed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    });

    contents.on("did-navigate", (_event, url) => {
      queueStateUpdate({ url });
    });

    contents.on("did-navigate-in-page", (_event, url) => {
      queueStateUpdate({ url });
    });

    contents.on("did-start-loading", () => {
      queueStateUpdate({ isLoading: true });
    });

    contents.on("did-stop-loading", () => {
      // Guard against destroyed webContents (can happen if event fires during destruction)
      if (contents.isDestroyed()) return;
      queueStateUpdate({
        isLoading: false,
        canGoBack: contents.canGoBack(),
        canGoForward: contents.canGoForward(),
      });
    });

    contents.on("page-title-updated", (_event, title) => {
      queueStateUpdate({ pageTitle: title });
    });
  }

  private handleChildCreationError(parentId: string, error: unknown, url: string): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[PanelManager] Failed to create child from ${url}:`, error);
    this.sendPanelEvent(parentId, { type: "child-creation-error", url, error: message });
  }

  private setupChildLinkInterception(
    panelId: string,
    contents: Electron.WebContents,
    viewType: "panel" | "browser"
  ): void {
    // Intercept new-window requests (middle click / ctrl+click / target="_blank").
    contents.setWindowOpenHandler((details) => {
      const url = details.url;

      if (url.startsWith("natstack-child:")) {
        try {
          const { source, gitRef, sessionId } = parseChildUrl(url);
          this.createChild(panelId, source, { gitRef, sessionId }).catch((err) =>
            this.handleChildCreationError(panelId, err, url)
          );
        } catch (err) {
          this.handleChildCreationError(panelId, err, url);
        }
        return { action: "deny" };
      }

      if (/^https?:/i.test(url)) {
        this.createBrowserChild(panelId, url).catch((err) =>
          this.handleChildCreationError(panelId, err, url)
        );
        return { action: "deny" };
      }

      return { action: "deny" };
    });

    // Intercept in-place navigations to natstack-child:// (and http(s) for app panels).
    contents.on("will-navigate", (event, url) => {
      if (url.startsWith("natstack-child:")) {
        event.preventDefault();
        try {
          const { source, gitRef, sessionId } = parseChildUrl(url);
          this.createChild(panelId, source, { gitRef, sessionId }).catch((err) =>
            this.handleChildCreationError(panelId, err, url)
          );
        } catch (err) {
          this.handleChildCreationError(panelId, err, url);
        }
        return;
      }

      if (viewType === "panel" && /^https?:/i.test(url)) {
        event.preventDefault();
        this.createBrowserChild(panelId, url).catch((err) =>
          this.handleChildCreationError(panelId, err, url)
        );
      }
      // Browser views: allow normal http(s) navigation in place.
    });
  }

  private normalizePanelPath(panelPath: string): { relativePath: string; absolutePath: string } {
    return normalizeRelativePanelPath(panelPath, this.panelsRoot);
  }

  private sanitizeIdSegment(segment: string): string {
    const trimmed = segment.trim();
    if (!trimmed || trimmed === "." || trimmed.includes("/") || trimmed.includes("\\")) {
      throw new Error(`Invalid panel identifier segment: ${segment}`);
    }
    return trimmed;
  }

  private generatePanelNonce(): string {
    return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  }

  private computePanelId(params: {
    relativePath: string;
    parent?: Panel | null;
    requestedId?: string;
    isRoot?: boolean;
  }): string {
    const { relativePath, parent, requestedId, isRoot } = params;

    // Escape slashes in path to avoid collisions
    const escapedPath = relativePath.replace(/\//g, "~");

    if (isRoot) {
      return `tree/${escapedPath}`;
    }

    // Parent prefix: use parent's full ID, or "tree" for root panels
    const parentPrefix = parent?.id ?? "tree";

    if (requestedId) {
      const segment = this.sanitizeIdSegment(requestedId);
      return `${parentPrefix}/${segment}`;
    }

    const autoSegment = this.generatePanelNonce();
    return `${parentPrefix}/${escapedPath}/${autoSegment}`;
  }

  /**
   * Resolve session ID for a panel based on options and mode.
   * - If explicit sessionId provided: validate and use it
   * - If newSession: generate random named session
   * - Default: derive auto session from panel ID (deterministic, resumable)
   */
  private resolveSession(
    panelId: string,
    options: ChildCreateOptions | undefined,
    isUnsafe: boolean
  ): string {
    const mode: SessionMode = isUnsafe ? "unsafe" : "safe";

    // Explicit session provided - validate and use it
    if (options?.sessionId) {
      validateSessionId(options.sessionId, mode);
      return options.sessionId;
    }

    // Force new isolated session (random named session)
    if (options?.newSession) {
      return generateNamedSessionId(mode);
    }

    // Default: derive from panel ID (deterministic auto session)
    // Same panel path = same session = resumed OPFS state
    return deriveAutoSessionId(mode, panelId);
  }

  // Public methods for RPC services

  /**
   * Build env for a panel or worker, injecting git credentials, pubsub config, etc.
   * The full git config is serialized to JSON so bootstrap can use it without RPC.
   */
  private buildPanelEnv(
    panelId: string,
    baseEnv?: Record<string, string>,
    gitInfo?: {
      sourceRepo: string;
      branch?: string;
      commit?: string;
      tag?: string;
      resolvedRepoArgs?: Record<string, SharedPanel.RepoArgSpec>;
    }
  ): Record<string, string> | undefined {
    const gitToken = this.gitServer.getTokenForPanel(panelId);
    const serverUrl = this.gitServer.getBaseUrl();

    // Build full git config for bootstrap (eliminates need for RPC during bootstrap)
    const gitConfig = gitInfo
      ? JSON.stringify({
          serverUrl,
          token: gitToken,
          sourceRepo: gitInfo.sourceRepo,
          branch: gitInfo.branch,
          commit: gitInfo.commit,
          tag: gitInfo.tag,
          resolvedRepoArgs: gitInfo.resolvedRepoArgs ?? {},
        })
      : "";

    // Build pubsub config for real-time messaging
    const pubsubServer = getPubSubServer();
    const pubsubPort = pubsubServer.getPort();
    const pubsubConfig = pubsubPort
      ? JSON.stringify({
          serverUrl: `ws://127.0.0.1:${pubsubPort}`,
          token: getTokenManager().getOrCreateToken(panelId),
        })
      : "";
    const workspacePath = getActiveWorkspace()?.path;

    // Pass critical environment variables that Node.js APIs depend on
    // (e.g., os.homedir() needs HOME, child processes need PATH)
    // Also include XDG paths used by SDKs on Linux for config/data storage
    const criticalEnv: Record<string, string> = {};
    for (const key of [
      "HOME",
      "USER",
      "PATH",
      "TMPDIR",
      "TEMP",
      "TMP",
      "SHELL",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
      "XDG_RUNTIME_DIR",
    ]) {
      if (process.env[key]) {
        criticalEnv[key] = process.env[key]!;
      }
    }

    return {
      ...criticalEnv,
      ...baseEnv,
      ...(workspacePath ? { NATSTACK_WORKSPACE: workspacePath } : {}),
      __GIT_SERVER_URL: serverUrl,
      __GIT_TOKEN: gitToken,
      __GIT_CONFIG: gitConfig,
      __PUBSUB_CONFIG: pubsubConfig,
    };
  }

  /**
   * Shared creation path for both root and child panels.
   */
  private createPanelFromManifest(params: {
    manifest: PanelManifest;
    relativePath: string;
    parent: Panel | null;
    options?: ChildCreateOptions;
    isRoot?: boolean;
  }): { id: string; type: SharedPanel.PanelType; title: string } {
    const { manifest, relativePath, parent, options, isRoot } = params;

    const isWorker = manifest.type === "worker";
    // Determine unsafe mode from manifest or options
    const unsafeFlag = options?.unsafe ?? manifest.unsafe;

    // Validate repoArgs: caller must provide exactly the args declared in manifest
    const declaredArgs = manifest.repoArgs ?? [];
    const providedArgs = options?.repoArgs ? Object.keys(options.repoArgs) : [];

    if (declaredArgs.length > 0 || providedArgs.length > 0) {
      const missingArgs = declaredArgs.filter((arg) => !providedArgs.includes(arg));
      const extraArgs = providedArgs.filter((arg) => !declaredArgs.includes(arg));

      if (missingArgs.length > 0) {
        throw new Error(
          `Panel "${relativePath}" requires repoArgs: ${missingArgs.join(", ")}`
        );
      }
      if (extraArgs.length > 0) {
        throw new Error(
          `Panel "${relativePath}" does not accept repoArgs: ${extraArgs.join(", ")}` +
          (declaredArgs.length === 0 ? " (manifest declares no repoArgs)" : "")
        );
      }
    }

    const panelId = this.computePanelId({
      relativePath,
      parent,
      requestedId: options?.name,
      isRoot,
    });

    // Resolve session ID based on panel ID and options
    const isUnsafe = unsafeFlag !== undefined;
    const sessionId = this.resolveSession(panelId, options, isUnsafe);

    if (this.panels.has(panelId) || this.reservedPanelIds.has(panelId)) {
      throw new Error(`A panel with id "${panelId}" is already running`);
    }

    this.reservedPanelIds.add(panelId);

    try {
      const branch = options?.gitRef ?? options?.branch;
      const commit = options?.commit;
      const tag = options?.tag;

      const panelEnv = this.buildPanelEnv(panelId, options?.env, {
        sourceRepo: relativePath,
        branch,
        commit,
        tag,
        resolvedRepoArgs: options?.repoArgs,
      });

      // Create the appropriate panel type based on manifest runtime
      const panel: Panel = isWorker
        ? {
            type: "worker",
            id: panelId,
            sessionId,
            title: manifest.title,
            path: relativePath,
            children: [],
            selectedChildId: null,
            artifacts: {
              buildState: "building",
              buildProgress: "Starting worker...",
            },
            env: panelEnv,
            sourceRepo: relativePath,
            branch,
            commit,
            tag,
            resolvedRepoArgs: options?.repoArgs,
            workerOptions: {
              unsafe: options?.unsafe ?? manifest.unsafe,
            },
          }
        : {
            type: "app",
            id: panelId,
            sessionId,
            title: manifest.title,
            path: relativePath,
            children: [],
            selectedChildId: null,
            injectHostThemeVariables: manifest.injectHostThemeVariables !== false,
            unsafe: options?.unsafe ?? manifest.unsafe,
            artifacts: {
              buildState: "building",
              buildProgress: "Starting build...",
            },
            env: panelEnv,
            sourceRepo: relativePath,
            branch,
            commit,
            tag,
            resolvedRepoArgs: options?.repoArgs,
          };

      if (isRoot) {
        this.rootPanels = [panel];
        this.panels = new Map([[panel.id, panel]]);
      } else if (parent) {
        parent.children.push(panel);
        parent.selectedChildId = panel.id;
        this.panels.set(panel.id, panel);
      } else {
        this.panels.set(panel.id, panel);
      }

      this.notifyPanelTreeUpdate();

      if (panel.type === "worker") {
        void this.buildWorkerAsync(panel, { branch, commit, tag });
      } else if (panel.type === "app") {
        void this.buildPanelAsync(panel, { branch, commit, tag, sourcemap: options?.sourcemap });
      }

      return { id: panel.id, type: panel.type, title: panel.title };
    } finally {
      this.reservedPanelIds.delete(panelId);
    }
  }

  /**
   * Create a child app/worker from a manifest source path.
   * Main process handles git checkout and build asynchronously for app/worker types.
   * Returns child info immediately; build happens in background.
   */
  async createChild(
    parentId: string,
    source: string,
    options?: ChildCreateOptions
  ): Promise<{ id: string; type: SharedPanel.PanelType; title: string }> {
    const parent = this.panels.get(parentId);
    if (!parent) {
      throw new Error(`Parent panel not found: ${parentId}`);
    }

    const { relativePath, absolutePath } = this.normalizePanelPath(source);

    // Read manifest to check singleton state and get title
    let manifest: PanelManifest;
    try {
      manifest = this.builder.loadManifest(absolutePath);
    } catch (error) {
      throw new Error(
        `Failed to load manifest for ${source}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return this.createPanelFromManifest({
      manifest,
      relativePath,
      parent,
      options,
    });
  }

  /**
   * Create a browser child panel that loads an external URL.
   * Browser panels don't require manifest or build - they load external content directly.
   */
  async createBrowserChild(
    parentId: string,
    url: string
  ): Promise<{ id: string; type: SharedPanel.PanelType; title: string }> {
    const parent = this.panels.get(parentId);
    if (!parent) {
      throw new Error(`Parent panel not found: ${parentId}`);
    }

    // Validate URL protocol
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid URL format: "${url}"`);
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error(
        `Invalid URL protocol "${parsedUrl.protocol}". Only http: and https: are allowed.`
      );
    }

    // Always generate a unique name (callers can label via UI/title instead).
    const browserName = `browser-${this.generatePanelNonce()}`;

    const panelId = this.computePanelId({
      relativePath: `browser/${browserName}`,
      parent,
      requestedId: browserName,
      isRoot: false,
    });

    // Browser panels are always safe (no Node.js access)
    const sessionId = this.resolveSession(panelId, undefined, false);

    if (this.panels.has(panelId) || this.reservedPanelIds.has(panelId)) {
      throw new Error(`A panel with id "${panelId}" is already running`);
    }

    const panel: SharedPanel.BrowserPanel = {
      type: "browser",
      id: panelId,
      sessionId,
      title: parsedUrl.hostname,
      url,
      children: [],
      selectedChildId: null,
      artifacts: {
        buildState: "ready",
      },
      env: undefined,
      browserState: {
        pageTitle: parsedUrl.hostname,
        isLoading: true,
        canGoBack: false,
        canGoForward: false,
      },
      injectHostThemeVariables: false,
    };

    parent.children.push(panel);
    parent.selectedChildId = panel.id;
    this.panels.set(panel.id, panel);

    // Create WebContentsView for the browser (browsers don't use session-based partitions)
    this.createViewForPanel(panel.id, url, "browser", panel.sessionId);

    this.notifyPanelTreeUpdate();

    return { id: panel.id, type: panel.type, title: panel.title };
  }

  /**
   * Update browser panel state (URL, loading, navigation capabilities).
   * Called when the renderer forwards webview events.
   */
  updateBrowserState(
    browserId: string,
    state: {
      url?: string;
      pageTitle?: string;
      isLoading?: boolean;
      canGoBack?: boolean;
      canGoForward?: boolean;
    }
  ): void {
    const panel = this.panels.get(browserId);
    if (!panel || panel.type !== "browser") {
      console.warn(`[PanelManager] Browser panel not found: ${browserId}`);
      return;
    }

    // Update URL if provided
    if (state.url !== undefined) {
      panel.url = state.url;
    }

    // Update browserState fields
    if (state.pageTitle !== undefined) {
      panel.browserState.pageTitle = state.pageTitle;
      panel.title = state.pageTitle; // Also update the panel title
    }
    if (state.isLoading !== undefined) {
      panel.browserState.isLoading = state.isLoading;
    }
    if (state.canGoBack !== undefined) {
      panel.browserState.canGoBack = state.canGoBack;
    }
    if (state.canGoForward !== undefined) {
      panel.browserState.canGoForward = state.canGoForward;
    }

    this.notifyPanelTreeUpdate();
  }

  /**
   * Build a worker asynchronously and update its state.
   * Workers run as WebContentsView instances with worker host UI.
   */
  private async buildWorkerAsync(
    worker: SharedPanel.WorkerPanel,
    version?: { branch?: string; commit?: string; tag?: string }
  ): Promise<void> {
    try {
      // Check if panel directory is a git repo first (only for non-versioned builds)
      if (!version?.branch && !version?.commit && !version?.tag) {
        const absolutePanelPath = path.resolve(this.panelsRoot, worker.path);

        // Stage 1: Check if it's a git repo
        const { isRepo, path: repoPath } = await checkGitRepository(absolutePanelPath);

        if (!isRepo) {
          worker.artifacts = {
            buildState: "not-git-repo",
            notGitRepoPath: repoPath,
            buildProgress: "Worker folder must be the root of a git repository",
          };
          this.notifyPanelTreeUpdate();
          return;
        }

        // Stage 2: Check for dirty worktree
        const { clean, path: cleanRepoPath } = await checkWorktreeClean(absolutePanelPath);

        if (!clean) {
          worker.artifacts = {
            buildState: "dirty",
            dirtyRepoPath: cleanRepoPath,
            buildProgress: "Uncommitted changes detected",
          };
          this.notifyPanelTreeUpdate();
          return;
        }
      }

      const buildVersion =
        version?.branch || version?.commit || version?.tag
          ? {
              branch: version.branch,
              commit: version.commit,
              tag: version.tag,
            }
          : undefined;

      const result = await this.builder.buildWorker(
        this.panelsRoot,
        worker.path,
        buildVersion,
        (progress) => {
          // Update worker state with progress
          worker.artifacts = {
            ...worker.artifacts,
            buildState: progress.state,
            buildProgress: progress.message,
            buildLog: progress.log,
          };
          this.notifyPanelTreeUpdate();
        },
        { unsafe: worker.workerOptions?.unsafe }
      );

      if (result.success && result.bundle) {
        // Generate worker host HTML that executes the bundle
        const workerHostHtml = this.generateWorkerHostHtml(
          result.manifest?.title ?? worker.title,
          Boolean(worker.workerOptions?.unsafe)
        );

        // Store worker content for protocol serving
        const htmlUrl = storeProtocolPanel(worker.id, {
          bundle: result.bundle,
          html: workerHostHtml,
          title: result.manifest?.title ?? worker.title,
          sourceRepo: worker.path,
        });

        // Update worker with successful build
        worker.artifacts = {
          htmlPath: htmlUrl,
          buildState: "ready",
          buildProgress: "Worker ready",
          buildLog: result.buildLog,
        };

        // Create WebContentsView for this worker
        const srcUrl = new URL(htmlUrl);
        srcUrl.searchParams.set("panelId", worker.id);
        this.createViewForPanel(worker.id, srcUrl.toString(), "worker", worker.sessionId);
      } else {
        // Build failed
        worker.artifacts = {
          error: result.error ?? "Build failed",
          buildState: "error",
          buildProgress: result.error ?? "Build failed",
          buildLog: result.buildLog,
        };
      }

      this.notifyPanelTreeUpdate();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      worker.artifacts = {
        error: errorMsg,
        buildState: "error",
        buildProgress: errorMsg,
      };
      this.notifyPanelTreeUpdate();
    }
  }

  /**
   * Generate worker host HTML that loads and executes the worker bundle.
   */
  private generateWorkerHostHtml(title: string, unsafe: boolean): string {
    // Escape HTML special characters to prevent XSS
    const escapeHtml = (str: string) =>
      str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const safeTitle = escapeHtml(title);

    // Escape for JavaScript context - prevent </script> injection by escaping < characters
    const escapeForJs = (str: string) => JSON.stringify(str).replace(/</g, "\\u003c");
    const jsSafeTitle = escapeForJs(title);

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  ${PANEL_CSP_META}
  <title>${safeTitle}</title>
  <style>
    :root {
      /* Worker console color scheme */
      --worker-bg: #1e1e1e;
      --worker-fg: #d4d4d4;
      --worker-status-bg: #252526;
      --worker-border: #3c3c3c;
      --worker-status-running: #4ec9b0;
      --worker-status-error: #f48771;
      --worker-status-stopped: #808080;
      --worker-log-warn: #dcdcaa;
      --worker-log-error: #f48771;
      --worker-log-info: #9cdcfe;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: var(--worker-bg);
      color: var(--worker-fg);
      height: 100vh;
      overflow: hidden;
    }
    #status {
      position: fixed; top: 0; left: 0; right: 0;
      padding: 4px 8px;
      background: var(--worker-status-bg);
      border-bottom: 1px solid var(--worker-border);
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #status-indicator {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--worker-status-running);
    }
    #console {
      position: fixed; top: 28px; left: 0; right: 0; bottom: 0;
      overflow-y: auto;
      padding: 8px;
      font-family: 'Cascadia Code', 'Fira Code', monospace;
      font-size: 13px;
      line-height: 1.4;
    }
    .log-entry { padding: 2px 0; white-space: pre-wrap; word-break: break-word; }
    .log { color: var(--worker-fg); }
    .warn { color: var(--worker-log-warn); }
    .error { color: var(--worker-log-error); }
    .info { color: var(--worker-log-info); }
  </style>
</head>
<body>
  <div id="status">
    <div id="status-indicator"></div>
    <span id="status-text">Initializing...</span>
  </div>
  <div id="console"></div>
  <script>
    // Worker host - executes the bundle with console output UI
    const statusText = document.getElementById("status-text");
    const statusIndicator = document.getElementById("status-indicator");
    const consoleEl = document.getElementById("console");
    const isUnsafe = ${unsafe ? "true" : "false"};

    // Get CSS variable values for status colors
    const rootStyles = getComputedStyle(document.documentElement);
    const statusColors = {
      running: rootStyles.getPropertyValue("--worker-status-running").trim(),
      error: rootStyles.getPropertyValue("--worker-status-error").trim(),
      stopped: rootStyles.getPropertyValue("--worker-status-stopped").trim()
    };

    function setStatus(status, text) {
      statusText.textContent = text;
      statusIndicator.style.background = statusColors[status] || statusColors.running;
    }

    function appendLog(level, ...args) {
      const entry = document.createElement("div");
      entry.className = "log-entry " + level;
      entry.textContent = args.map(arg =>
        typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
      ).join(" ");
      consoleEl.appendChild(entry);
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }

    // Proxy console to show in UI
    const origConsole = { ...console };
    console.log = (...args) => { appendLog("log", ...args); origConsole.log(...args); };
    console.warn = (...args) => { appendLog("warn", ...args); origConsole.warn(...args); };
    console.error = (...args) => { appendLog("error", ...args); origConsole.error(...args); };
    console.info = (...args) => { appendLog("info", ...args); origConsole.info(...args); };

    // Global error handler to catch bundle initialization errors
    window.onerror = (message, source, lineno, colno, error) => {
      setStatus("error", "Worker crashed");
      appendLog("error", "Uncaught error:", error?.message || message);
      if (source) appendLog("error", "  at " + source + ":" + lineno + ":" + colno);
    };
    window.onunhandledrejection = (event) => {
      setStatus("error", "Worker crashed");
      appendLog("error", "Unhandled rejection:", event.reason?.message || event.reason);
    };

    setStatus("running", ${jsSafeTitle});
  </script>
  ${unsafe ? '<script src="./bundle.js"></script>' : '<script type="module" src="./bundle.js"></script>'}
</body>
</html>`;
  }

  /**
   * Build a panel asynchronously and update its state.
   * Works for both root and child panels (all use protocol serving now).
   */
  private async buildPanelAsync(
    panel: SharedPanel.AppPanel,
    options?: { branch?: string; commit?: string; tag?: string; sourcemap?: boolean }
  ): Promise<void> {
    try {
      // Check if panel directory is a git repo first (only for non-versioned builds)
      if (!options?.branch && !options?.commit && !options?.tag) {
        const absolutePanelPath = path.resolve(this.panelsRoot, panel.path);

        // Stage 1: Check if it's a git repo
        const { isRepo, path: repoPath } = await checkGitRepository(absolutePanelPath);

        if (!isRepo) {
          panel.artifacts = {
            buildState: "not-git-repo",
            notGitRepoPath: repoPath,
            buildProgress: "Panel folder must be the root of a git repository",
          };
          this.notifyPanelTreeUpdate();
          return;
        }

        // Stage 2: Check for dirty worktree
        const { clean, path: cleanRepoPath } = await checkWorktreeClean(absolutePanelPath);

        if (!clean) {
          panel.artifacts = {
            buildState: "dirty",
            dirtyRepoPath: cleanRepoPath,
            buildProgress: "Uncommitted changes detected",
          };
          this.notifyPanelTreeUpdate();
          return;
        }
      }

      const buildVersion =
        options?.branch || options?.commit || options?.tag
          ? {
              branch: options.branch,
              commit: options.commit,
              tag: options.tag,
            }
          : undefined;

      const result = await this.builder.buildPanel(
        this.panelsRoot,
        panel.path,
        buildVersion,
        (progress) => {
          // Update panel state with progress
          panel.artifacts = {
            ...panel.artifacts,
            buildState: progress.state,
            buildProgress: progress.message,
            buildLog: progress.log,
          };
          this.notifyPanelTreeUpdate();
        },
        { sourcemap: options?.sourcemap !== false, unsafe: panel.unsafe }
      );

      if (result.success && result.bundle && result.html) {
        // Store panel content for protocol serving
        const htmlUrl = storeProtocolPanel(panel.id, {
          bundle: result.bundle,
          html: result.html,
          title: result.manifest?.title ?? panel.title,
          css: result.css,
          assets: result.assets,
          injectHostThemeVariables: result.manifest?.injectHostThemeVariables !== false,
          sourceRepo: panel.path,
          repoArgs: result.manifest?.repoArgs,
        });

        // Update panel with successful build
        panel.artifacts = {
          htmlPath: htmlUrl,
          buildState: "ready",
          buildProgress: "Build complete",
          buildLog: result.buildLog,
        };

        // Create WebContentsView for this panel
        const srcUrl = new URL(htmlUrl);
        srcUrl.searchParams.set("panelId", panel.id);
        this.createViewForPanel(panel.id, srcUrl.toString(), "panel", panel.sessionId);
      } else {
        // Build failed
        panel.artifacts = {
          error: result.error ?? "Build failed",
          buildState: "error",
          buildProgress: result.error ?? "Build failed",
          buildLog: result.buildLog,
        };
      }

      this.notifyPanelTreeUpdate();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      panel.artifacts = {
        error: errorMsg,
        buildState: "error",
        buildProgress: errorMsg,
      };
      this.notifyPanelTreeUpdate();
    }
  }

  async removeChild(parentId: string, childId: string): Promise<void> {
    const parent = this.panels.get(parentId);
    if (!parent) {
      throw new Error(`Parent panel not found: ${parentId}`);
    }

    const childIndex = parent.children.findIndex((c) => c.id === childId);
    if (childIndex === -1) {
      throw new Error(`Child panel not found: ${childId}`);
    }

    // Remove child
    parent.children.splice(childIndex, 1);

    // Update selected child
    if (parent.selectedChildId === childId) {
      const firstChild = parent.children[0];
      parent.selectedChildId = firstChild ? firstChild.id : null;
    }

    // Remove from panels map (and all descendants)
    this.removePanelRecursive(childId);

    this.sendPanelEvent(parent.id, { type: "child-removed", childId });

    // Notify renderer
    this.notifyPanelTreeUpdate();
  }

  async setTitle(callerId: string, title: string): Promise<void> {
    console.log(`[PanelManager] setTitle called with callerId="${callerId}", title="${title}"`);
    console.log(`[PanelManager] All panel IDs: ${Array.from(this.panels.keys()).join(", ")}`);

    const panel = this.panels.get(callerId);
    if (!panel) {
      throw new Error(`Panel not found: ${callerId}`);
    }

    panel.title = title;

    // Notify renderer
    this.notifyPanelTreeUpdate();
  }

  async closePanel(panelId: string): Promise<void> {
    // Find parent
    const parent = this.findParentPanel(panelId);
    if (parent) {
      const childIndex = parent.children.findIndex((c) => c.id === panelId);
      if (childIndex !== -1) {
        parent.children.splice(childIndex, 1);

        // Update selected child
        if (parent.selectedChildId === panelId) {
          const firstChild = parent.children[0];
          parent.selectedChildId = firstChild ? firstChild.id : null;
        }

        this.sendPanelEvent(parent.id, { type: "child-removed", childId: panelId });
      }
    }

    // Remove from panels map
    this.removePanelRecursive(panelId);

    // Notify renderer
    this.notifyPanelTreeUpdate();
  }

  /**
   * Retry a build for a panel that was blocked by dirty worktree.
   * Called after user commits or discards changes in the Git UI.
   */
  async retryBuild(panelId: string): Promise<void> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    if (panel.artifacts.buildState !== "dirty") {
      // Not in dirty state, nothing to retry
      return;
    }

    // Reset state and retry build
    panel.artifacts = {
      buildState: "building",
      buildProgress: "Retrying build...",
    };
    this.notifyPanelTreeUpdate();

    // Call appropriate build method based on panel type
    if (panel.type === "worker") {
      await this.buildWorkerAsync(panel as SharedPanel.WorkerPanel, {
        branch: panel.branch,
        commit: panel.commit,
        tag: panel.tag,
      });
    } else if (panel.type === "app") {
      await this.buildPanelAsync(panel as SharedPanel.AppPanel, {
        branch: panel.branch,
        commit: panel.commit,
        tag: panel.tag,
      });
    }
  }

  /**
   * Initialize git repo after user clicks initialize in GitInitView.
   * Re-runs build checks which will now pass git repo check and go to dirty check.
   */
  async initializeGitRepo(panelId: string): Promise<void> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    if (panel.artifacts.buildState !== "not-git-repo") {
      // Not in not-git-repo state, nothing to initialize
      return;
    }

    // Reset state and re-run build
    panel.artifacts = {
      buildState: "building",
      buildProgress: "Checking repository status...",
    };
    this.notifyPanelTreeUpdate();

    try {
      // Call appropriate build method based on panel type
      if (panel.type === "worker") {
        await this.buildWorkerAsync(panel as SharedPanel.WorkerPanel, {
          branch: panel.branch,
          commit: panel.commit,
          tag: panel.tag,
        });
      } else if (panel.type === "app") {
        await this.buildPanelAsync(panel as SharedPanel.AppPanel, {
          branch: panel.branch,
          commit: panel.commit,
          tag: panel.tag,
        });
      }
    } catch (error) {
      // Build failed - set error state and notify
      panel.artifacts = {
        buildState: "error",
        buildProgress: `Build failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      this.notifyPanelTreeUpdate();
      throw error; // Re-throw to notify caller
    }
  }

  getInfo(panelId: string): SharedPanel.PanelInfo {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }
    return {
      panelId: panel.id,
      partition: panel.sessionId, // Partition is now based on session, not panel ID
      sessionId: panel.sessionId,
    };
  }

  getSerializablePanelTree(): Panel[] {
    return this.rootPanels.map((panel) => this.serializePanel(panel));
  }

  /**
   * Find which panel a webContents sender belongs to.
   * Uses ViewManager's reverse lookup from webContents ID to view ID.
   * Returns the panel ID if found, null otherwise.
   */
  findPanelIdBySenderId(senderId: number): string | null {
    if (!this.viewManager) {
      return null;
    }
    return this.viewManager.findViewIdByWebContentsId(senderId);
  }

  setCurrentTheme(theme: "light" | "dark"): void {
    this.currentTheme = theme;
  }

  sendPanelEvent(panelId: string, payload: PanelEventPayload): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;

    // Use ViewManager to get webContents for all panels (app, browser, worker).
    if (!this.viewManager) return;

    const contents = this.viewManager.getWebContents(panelId);
    if (contents && !contents.isDestroyed()) {
      contents.send("panel:event", { panelId, ...payload });
    }
  }

  broadcastTheme(theme: "light" | "dark"): void {
    for (const panelId of this.panels.keys()) {
      this.sendPanelEvent(panelId, { type: "theme", theme });
    }
  }

  // Private methods

  private removePanelRecursive(panelId: string): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;

    // Remove all children first
    for (const child of panel.children) {
      this.removePanelRecursive(child.id);
    }

    // Cleanup based on panel type
    switch (panel.type) {
      case "worker":
        // Worker panels are now WebContentsView-based, cleanup via ViewManager below
        getCdpServer().revokeTokenForPanel(panelId);
        break;

      case "browser":
        // Unregister from CDP server
        getCdpServer().unregisterBrowser(panelId);
        break;

      case "app":
        // App panel cleanup
        // Revoke git token for this panel
        this.gitServer.revokeTokenForPanel(panelId);

        // Revoke CDP token for this panel (cleans up browser ownership)
        getCdpServer().revokeTokenForPanel(panelId);

        // Clean up any Claude Code conversations for this panel
        getClaudeCodeConversationManager().endPanelConversations(panelId);

        // Clean up protocol-served panel content if applicable
        if (isProtocolPanel(panelId)) {
          removeProtocolPanel(panelId);
        }
        break;
    }

    // Destroy the WebContentsView
    if (this.viewManager?.hasView(panelId)) {
      this.viewManager.destroyView(panelId);
    }

    // Remove from panels map
    this.panels.delete(panelId);
  }

  private findParentPanel(childId: string): Panel | null {
    for (const panel of this.panels.values()) {
      if (panel.children.some((c) => c.id === childId)) {
        return panel;
      }
    }
    return null;
  }

  /**
   * Find the parent panel ID for a given child panel ID.
   * Returns null if the panel is a root panel or not found.
   */
  findParentId(childId: string): string | null {
    const parent = this.findParentPanel(childId);
    return parent?.id ?? null;
  }

  /**
   * Find a browser panel by its URL.
   * Used for auto-registering browser webviews when they attach.
   * Returns null if no matching browser panel is found.
   */
  findBrowserPanelByUrl(url: string): Panel | null {
    // Normalize the URL for comparison
    const normalizedUrl = url.toLowerCase();

    for (const panel of this.panels.values()) {
      if (panel.type === "browser") {
        const browserUrl = (panel as BrowserPanel).url?.toLowerCase();
        // Match if URLs are the same or if the browser navigated (URL might have changed)
        if (browserUrl && (normalizedUrl.startsWith(browserUrl) || browserUrl.startsWith(normalizedUrl))) {
          return panel;
        }
      }
    }
    return null;
  }

  /**
   * Notify renderer of panel tree changes.
   * Debounced to batch rapid updates (e.g., worker console logs).
   */
  notifyPanelTreeUpdate(): void {
    // Mark update pending
    this.treeUpdatePending = true;

    // If timer already running, let it handle the update
    if (this.treeUpdateTimer) {
      return;
    }

    // Schedule debounced update
    this.treeUpdateTimer = setTimeout(() => {
      this.treeUpdateTimer = null;
      if (this.treeUpdatePending && this.viewManager) {
        this.treeUpdatePending = false;
        const tree = this.getSerializablePanelTree();
        const shellContents = this.viewManager.getShellWebContents();
        if (!shellContents.isDestroyed()) {
          shellContents.send("panel:tree-updated", tree);
        }
      }
    }, this.TREE_UPDATE_DEBOUNCE_MS);
  }

  private serializePanel(panel: Panel): Panel {
    const { env: _env, children, ...rest } = panel;
    return {
      ...rest,
      children: children.map((child) => this.serializePanel(child)),
    };
  }

  getRootPanels(): Panel[] {
    return this.rootPanels;
  }

  getPanel(id: string): Panel | undefined {
    return this.panels.get(id);
  }

  // Map guestInstanceId (from webContents) to panelId
  private guestInstanceMap: Map<number, string> = new Map();
  // Map panelId -> pending auth token with timestamp for TTL cleanup
  private pendingAuthTokens: Map<string, { token: string; createdAt: number }> = new Map();
  // TTL for pending auth tokens (30 seconds should be plenty for webview init)
  private readonly AUTH_TOKEN_TTL_MS = 30_000;

  getPanelIdForWebContents(contents: Electron.WebContents): string | undefined {
    return this.guestInstanceMap.get(contents.id);
  }

  /**
   * Get WebContents for a panel.
   * Used for sending IPC messages to panels.
   */
  getWebContentsForPanel(panelId: string): Electron.WebContents | undefined {
    if (!this.viewManager) {
      return undefined;
    }
    return this.viewManager.getWebContents(panelId) ?? undefined;
  }

  verifyAndRegister(panelId: string, token: string, senderId: number): void {
    // Check if this is a reload - same webContentsId already registered for this panel.
    // This is safe because:
    // 1. The senderId (webContentsId) is assigned by Electron and cannot be spoofed
    // 2. We only skip token validation if BOTH the senderId AND panelId match existing registration
    // 3. A malicious panel with a different senderId cannot re-register as another panel
    const existingPanelId = this.guestInstanceMap.get(senderId);
    if (existingPanelId === panelId) {
      // Re-registration after reload - panel is re-initializing with same webContents.
      // Re-send theme to ensure panel has current theme after reload.
      this.sendPanelEvent(panelId, { type: "theme", theme: this.currentTheme });
      return;
    }

    const pending = this.pendingAuthTokens.get(panelId);
    if (!pending || pending.token !== token) {
      throw new Error(`Invalid auth token for panel ${panelId}`);
    }

    // Check if token has expired
    if (Date.now() - pending.createdAt > this.AUTH_TOKEN_TTL_MS) {
      this.pendingAuthTokens.delete(panelId);
      throw new Error(`Auth token for panel ${panelId} has expired`);
    }

    // Token is valid and used
    this.pendingAuthTokens.delete(panelId);

    this.guestInstanceMap.set(senderId, panelId);
    this.registerPanelView(panelId, senderId);
  }

  /**
   * Clean up expired auth tokens to prevent memory leaks.
   * Called lazily when new panels are created.
   */
  private cleanupExpiredAuthTokens(): void {
    const now = Date.now();
    for (const [panelId, pending] of this.pendingAuthTokens) {
      if (now - pending.createdAt > this.AUTH_TOKEN_TTL_MS) {
        this.pendingAuthTokens.delete(panelId);
      }
    }
  }

  private registerPanelView(panelId: string, senderId: number): void {
    // ViewManager now tracks the webContents, we just need to set up cleanup for guestInstanceMap
    const contents = this.viewManager?.getWebContents(panelId);
    if (contents && !contents.isDestroyed()) {
      contents.once("destroyed", () => {
        this.guestInstanceMap.delete(senderId);
      });
    }

    this.sendPanelEvent(panelId, { type: "theme", theme: this.currentTheme });
  }

  private async initializeRootPanel(panelPath: string): Promise<void> {
    try {
      const { relativePath, absolutePath } = this.normalizePanelPath(panelPath);
      const manifest = this.builder.loadManifest(absolutePath);
      this.createPanelFromManifest({
        manifest,
        relativePath,
        parent: null,
        isRoot: true,
      });
    } catch (error) {
      console.error("Failed to initialize root panel:", error);
    }
  }
}
