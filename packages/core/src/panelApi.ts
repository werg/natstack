import type { ComponentType, ReactNode } from "react";
import type { GitDependency } from "@natstack/git";
import typia from "typia";
import * as Rpc from "./types.js";

// Helper type for esbuild-wasm dynamic import
interface EsbuildWasm {
  initialize(opts: { wasmURL: string }): Promise<void>;
  version?: string;
}

type PanelBridgeEvent = "child-removed" | "focus";

type PanelThemeAppearance = "light" | "dark";

export interface PanelTheme {
  appearance: PanelThemeAppearance;
}

interface PanelRpcBridge {
  expose(methods: Rpc.ExposedMethods): void;
  call(targetPanelId: string, method: string, ...args: unknown[]): Promise<unknown>;
  emit(targetPanelId: string, event: string, payload: unknown): Promise<void>;
  onEvent(event: string, listener: (fromPanelId: string, payload: unknown) => void): () => void;
}

/**
 * Build artifacts for launching a child panel from in-memory content
 */
export interface InMemoryBuildArtifacts {
  /** The bundled JavaScript code */
  bundle: string;
  /** Generated or provided HTML template */
  html: string;
  /** Panel title from manifest */
  title: string;
  /** CSS bundle if any */
  css?: string;
  /** Whether to inject host theme variables (defaults to true) */
  injectHostThemeVariables?: boolean;
  /** Optional source repo path (workspace-relative) to retain git association */
  sourceRepo?: string;
  /** Git dependencies from manifest */
  gitDependencies?: Record<string, string | GitDependency>;
}

/**
 * Git configuration for a panel
 */
interface GitConfig {
  serverUrl: string;
  token: string;
  sourceRepo: string;
  gitDependencies: Record<string, string | GitDependency>;
}

/**
 * Panel manifest from package.json natstack field (read from OPFS)
 */
interface PanelManifest {
  title: string;
  entry?: string;
  singletonState?: boolean;
  injectHostThemeVariables?: boolean;
  gitDependencies?: Record<string, string | GitDependency>;
}

interface PanelBridge {
  panelId: string;
  /**
   * Launch a child panel from in-memory build artifacts.
   * Use this when you've built the panel in-browser using @natstack/build.
   */
  launchChild(
    artifacts: InMemoryBuildArtifacts,
    env?: Record<string, string>,
    requestedPanelId?: string
  ): Promise<string>;
  removeChild(childId: string): Promise<void>;
  /**
   * Git operations
   */
  git: {
    getConfig(): Promise<GitConfig>;
  };
  /**
   * Get pre-bundled @natstack/* packages for in-panel builds.
   */
  getPrebundledPackages(): Promise<Record<string, string>>;
  /**
   * Get development mode flag.
   */
  getDevMode(): Promise<boolean>;
  setTitle(title: string): Promise<void>;
  close(): Promise<void>;
  getEnv(): Promise<Record<string, string>>;
  getInfo(): Promise<{ panelId: string; partition: string }>;
  // Event handling
  on(event: PanelBridgeEvent, listener: (payload?: unknown) => void): () => void;
  getTheme(): PanelThemeAppearance;
  onThemeChange(listener: (theme: PanelThemeAppearance) => void): () => void;
  // Panel-to-panel RPC
  rpc: PanelRpcBridge;
}

declare global {
  interface Window {
    __natstackPanelBridge?: PanelBridge;
  }
}

const getBridge = (): PanelBridge => {
  const bridge = window.__natstackPanelBridge;
  if (!bridge) {
    throw new Error("NatStack panel bridge is not available");
  }
  return bridge;
};

type AsyncResult<T> = Promise<T>;

const bridge = getBridge();

let currentTheme: PanelTheme = { appearance: bridge.getTheme() };
const themeListeners = new Set<(theme: PanelTheme) => void>();

bridge.onThemeChange((appearance) => {
  currentTheme = { appearance };
  for (const listener of themeListeners) {
    listener(currentTheme);
  }
});

export interface PanelRpcHandleOptions {
  /**
   * When enabled, validate incoming RPC event payloads with typia.
   * This surfaces schema mismatches early during development.
   */
  validateEvents?: boolean;
}

export interface CreateChildOptions {
  env?: Record<string, string>;
  /** Optional panel ID (only used for tree panels, ignored for singletons) */
  panelId?: string;
}

// Log OPFS quota on initialization (run once when module loads)
if (typeof window !== 'undefined') {
  void (async () => {
    try {
      const { logQuotaInfo } = await import("./opfsQuota.js");
      await logQuotaInfo();
    } catch (err) {
      // Silently fail if quota API not available
    }
  })();
}

const panelAPI = {
  getId(): string {
    return bridge.panelId;
  },

  /**
   * Create a child panel from a workspace path.
   * This method orchestrates:
   * 1. Using this panel's git config to clone the child source to OPFS
   * 2. Reading the manifest from OPFS
   * 3. Building the panel in-browser via @natstack/build
   * 4. Launching the child with the built artifacts
   *
   * The path convention: OPFS paths = workspace paths = git repo paths.
   * The panel uses its own git token (which has read access to all repos).
   *
   * NOTE: This requires @natstack/git and @natstack/build to be available.
   */
  async createChild(childPath: string, options?: CreateChildOptions): AsyncResult<string> {
    try {
      // Validate path format
      if (!childPath || typeof childPath !== 'string') {
        throw new Error('childPath must be a non-empty string');
      }

      // Normalize path and guard against dangerous patterns
      let normalizedPath = childPath.trim().replace(/\\/g, '/'); // Convert backslashes to forward slashes

      // Remove any leading slashes for consistency
      normalizedPath = normalizedPath.replace(/^\/+/, '');

      // Reject empty paths after normalization
      if (!normalizedPath) {
        throw new Error('Invalid path: path cannot be empty');
      }

      // Reject paths with null bytes (path injection)
      if (normalizedPath.includes('\0')) {
        throw new Error('Invalid path: null bytes not allowed');
      }

      // Reject URL-encoded traversal attempts
      if (normalizedPath.includes('%2e') || normalizedPath.includes('%2E')) {
        throw new Error('Invalid path: URL-encoded characters not allowed');
      }

      // Reject absolute paths (Unix/Windows style)
      if (normalizedPath.startsWith('/') || /^[a-zA-Z]:/.test(normalizedPath)) {
        throw new Error('Invalid path: absolute paths not allowed');
      }

      // Reject HTTP(S) URLs
      if (normalizedPath.startsWith('http://') || normalizedPath.startsWith('https://')) {
        throw new Error('Invalid path: URLs not allowed, use relative workspace paths');
      }

      // Reject path traversal (after normalization)
      const pathSegments = normalizedPath.split('/');
      for (const segment of pathSegments) {
        if (segment === '..' || segment === '.') {
          throw new Error('Invalid path: path traversal not allowed (.. or .)');
        }
      }

      // Ensure path starts with an allowed prefix for safety
      const allowedPrefixes = ['panels/', 'workspace/'];
      const hasAllowedPrefix = allowedPrefixes.some(prefix => normalizedPath.startsWith(prefix));
      if (!hasAllowedPrefix) {
        throw new Error(`Invalid path: must start with one of: ${allowedPrefixes.join(', ')}`);
      }

      // Check OPFS quota before starting (import dynamically to avoid circular deps)
      const { ensureSpace, ESTIMATED_CLONE_SIZE, ESTIMATED_BUILD_SIZE } = await import("./opfsQuota.js");
      const estimatedSize = ESTIMATED_CLONE_SIZE + ESTIMATED_BUILD_SIZE;
      await ensureSpace(estimatedSize);

      // Get this panel's git config (same server URL and token work for any repo)
      const gitConfig = await bridge.git.getConfig();

      // Import fs (shimmed to ZenFS/OPFS in panel environment)
      const fsModule = await import("fs");
      const fsPromises = fsModule.promises;

      // Dynamically import @natstack/git (resolved at runtime in browser)
      const gitModule = await import("@natstack/git");
      const { GitClient } = gitModule;

      // Clone/pull child source to OPFS at the same path as workspace
      // e.g., workspace path "panels/child" -> OPFS path "/panels/child"
      // Convention: OPFS paths = workspace paths = git repo paths (for simplicity)
      const opfsPath = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;

      // GitClient auto-adapts fs/promises for isomorphic-git compatibility
      const gitClient = new GitClient(fsPromises as ConstructorParameters<typeof GitClient>[0], {
        serverUrl: gitConfig.serverUrl,
        token: gitConfig.token,
      });

      // Track if we cloned fresh (for cleanup on build failure)
      let freshClone = false;
      let cleanupOnFailure: (() => Promise<void>) | null = null;

      // Step 1: Clone or update git repository
      try {
        // Check if directory exists
        let dirExists = false;
        try {
          await fsPromises.stat(opfsPath);
          dirExists = true;
        } catch {
          // Directory doesn't exist
        }

        // Check if it's a valid git repo
        const isRepo = dirExists && await gitClient.isRepo(opfsPath);

        if (isRepo) {
          // Already a repo - just pull latest
          await gitClient.pull({ dir: opfsPath });
        } else if (dirExists) {
          // Directory exists but isn't a repo - init and set up remote, then pull
          await gitClient.init(opfsPath);
          await gitClient.addRemote(opfsPath, "origin", normalizedPath);
          await gitClient.fetch({ dir: opfsPath, ref: "main" });
          await gitClient.checkout(opfsPath, "origin/main");
        } else {
          // Fresh clone
          freshClone = true;
          await gitClient.clone({ url: normalizedPath, dir: opfsPath });

          // Register cleanup function for fresh clones
          cleanupOnFailure = async () => {
            try {
              await fsPromises.rm(opfsPath, { recursive: true, force: true });
              console.log(`[Panel] Cleaned up failed clone: ${opfsPath}`);
            } catch (cleanupError) {
              console.error('[Panel] Failed to cleanup:', cleanupError);
            }
          };
        }
      } catch (gitError) {
        const errorMessage = gitError instanceof Error ? gitError.message : String(gitError);

        // Clean up fresh clone on git error
        if (cleanupOnFailure) {
          await cleanupOnFailure();
        }

        throw new Error(`Failed to clone/update git repository "${normalizedPath}": ${errorMessage}`);
      }

      // Wrap all subsequent steps in try-catch to ensure cleanup on any failure
      try {
        // Step 2: Get current commit SHA for cache optimization
        let sourceCommit: string | undefined;
        try {
          const commit = await gitClient.getCurrentCommit(opfsPath);
          sourceCommit = commit ?? undefined;
          if (sourceCommit) {
            console.log(`[Panel] Source at commit: ${sourceCommit.slice(0, 8)}`);
          }
        } catch (error) {
          // Commit SHA is optional - continue without it
          console.warn(`[Panel] Could not get source commit SHA:`, error);
        }

        // Step 3: Read and parse manifest
        let manifest: PanelManifest;
        try {
          const packageJsonPath = `${opfsPath}/package.json`;
          const packageJsonContent = await fsPromises.readFile(packageJsonPath, "utf-8");
          const packageJson = JSON.parse(packageJsonContent as string) as { natstack?: PanelManifest };
          manifest = packageJson.natstack ?? { title: normalizedPath.split("/").pop() ?? "Panel" };
        } catch (manifestError) {
          const errorMessage = manifestError instanceof Error ? manifestError.message : String(manifestError);
          throw new Error(`Failed to read panel manifest from "${opfsPath}/package.json": ${errorMessage}`);
        }

      // Step 4: Handle git dependencies if specified in manifest
      const depCommits: Record<string, string> = {};
      if (manifest.gitDependencies && Object.keys(manifest.gitDependencies).length > 0) {
        try {
          const { DependencyResolver } = await import("@natstack/git");
          const depsPath = "/deps";
          const resolver = new DependencyResolver(fsPromises as ConstructorParameters<typeof DependencyResolver>[0], {
            serverUrl: gitConfig.serverUrl,
            token: gitConfig.token,
          }, depsPath);

          console.log(`[Panel] Syncing ${Object.keys(manifest.gitDependencies).length} git dependencies...`);
          const depResults = await resolver.syncAll(manifest.gitDependencies);

          for (const [name, result] of depResults) {
            if (result.commit) {
              depCommits[name] = result.commit;
              console.log(`[Panel] Dependency "${name}" at commit: ${result.commit.slice(0, 8)}`);
            }
          }
        } catch (depError) {
          console.warn(`[Panel] Failed to sync git dependencies:`, depError);
          // Continue without dependencies - they're optional
        }
      }

      // Step 5: Set git commits in globalThis for cache optimization
      const { setGitCommits } = await import("@natstack/git");
      setGitCommits({ sourceCommit, depCommits });

      // Step 6: Build panel
      let artifacts;
      try {
        // Build from OPFS using @natstack/build
        const buildModule = await import("@natstack/build");
        const {
          BrowserPanelBuilder,
          isEsbuildInitialized,
          setEsbuildInstance,
          setDevMode,
          registerPrebundledBatch,
          CDN_DEFAULTS,
        } = buildModule;

        // Also import config for fallback URLs
        const { ESBUILD_CDN_FALLBACKS } = await import("@natstack/build/config");

        // Set development mode for cache expiration
        const devMode = await bridge.getDevMode();
        setDevMode(devMode);

        // Initialize unified cache (with disk persistence)
        try {
          const { initializeCache } = await import("@natstack/build");
          await initializeCache();
        } catch (err) {
          console.warn('[Panel] Failed to initialize unified cache:', err);
        }

        // Initialize esbuild if not already done
        if (!isEsbuildInitialized()) {
          let esbuild: EsbuildWasm | null = null;
          let lastError: Error | null = null;

          // Try each CDN fallback in order
          for (const cdnUrl of ESBUILD_CDN_FALLBACKS) {
            try {
              const esbuildModule = await import(/* @vite-ignore */ cdnUrl);
              esbuild = (esbuildModule.default ?? esbuildModule) as EsbuildWasm;

              if (esbuild && typeof esbuild.initialize === "function") {
                console.log(`[Panel] Loaded esbuild-wasm from ${cdnUrl}`);
                break;
              }
            } catch (err) {
              lastError = err instanceof Error ? err : new Error(String(err));
              console.warn(`[Panel] Failed to load esbuild from ${cdnUrl}:`, lastError.message);
            }
          }

          if (!esbuild || typeof esbuild.initialize !== "function") {
            throw new Error(
              `Failed to load esbuild-wasm from any CDN. Last error: ${lastError?.message ?? "unknown"}`
            );
          }

          await esbuild.initialize({
            wasmURL: CDN_DEFAULTS.ESBUILD_WASM_BINARY,
          });
          // Cast through unknown to satisfy type checker (esbuild type is complex)
          setEsbuildInstance(esbuild as unknown as Parameters<typeof setEsbuildInstance>[0]);
        }

        // Load and register prebundled packages
        const prebundled = await bridge.getPrebundledPackages();
        registerPrebundledBatch(prebundled);

        // Create file system adapter for the builder
        const buildFs = {
          async readFile(p: string): Promise<string> {
            return fsPromises.readFile(p, "utf-8") as Promise<string>;
          },
          async readFileBytes(p: string): Promise<Uint8Array> {
            const buffer = await fsPromises.readFile(p);
            // Validate that we got an ArrayBuffer-like object
            // Cast to unknown first to avoid type errors, then validate at runtime
            const bufferUnknown = buffer as unknown;

            // Check for Uint8Array first (most common case from ZenFS)
            if (bufferUnknown instanceof Uint8Array) {
              return bufferUnknown;
            }
            // Check for ArrayBuffer
            if (bufferUnknown instanceof ArrayBuffer) {
              return new Uint8Array(bufferUnknown);
            }
            // Check if it has byteLength property (buffer-like object)
            if (bufferUnknown && typeof bufferUnknown === 'object' && 'byteLength' in bufferUnknown) {
              try {
                // Try to construct Uint8Array from buffer-like object
                return new Uint8Array(bufferUnknown as ArrayBuffer);
              } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                throw new Error(`readFileBytes: cannot convert buffer to Uint8Array for ${p}: ${errMsg}`);
              }
            }
            // Unexpected type
            throw new Error(`readFileBytes: expected buffer-like object for ${p}, got ${typeof bufferUnknown}`);
          },
          async exists(p: string): Promise<boolean> {
            try {
              await fsPromises.access(p);
              return true;
            } catch {
              return false;
            }
          },
          async readdir(p: string): Promise<string[]> {
            const entries = await fsPromises.readdir(p);
            return entries as string[];
          },
          async isDirectory(p: string): Promise<boolean> {
            try {
              const stat = await fsPromises.stat(p);
              return stat.isDirectory();
            } catch {
              return false;
            }
          },
          async glob(): Promise<string[]> {
            return [];
          },
        };

        const builder = new BrowserPanelBuilder({
          basePath: opfsPath,
          fs: buildFs,
          dependencyResolver: { cdnBaseUrl: CDN_DEFAULTS.ESM_SH },
          // Avoid source maps to prevent noisy fetches of node_modules paths in OPFS
          sourcemap: false,
        });

        const buildResult = await builder.build(opfsPath);

        if (!buildResult.success) {
          throw new Error(`Build failed: ${(buildResult as { error: string }).error}`);
        }
        artifacts = buildResult.artifacts;
      } catch (buildError) {
        // Clean up fresh clone on build failure to save OPFS space
        if (freshClone) {
          try {
            // Recursively remove the cloned directory
            await fsPromises.rmdir(opfsPath, { recursive: true } as never);
            console.log(`[Panel] Cleaned up failed clone at ${opfsPath}`);
          } catch (cleanupError) {
            console.warn(`[Panel] Failed to cleanup ${opfsPath}:`, cleanupError);
          }
        }

        const errorMessage = buildError instanceof Error ? buildError.message : String(buildError);
        throw new Error(`Failed to build panel "${normalizedPath}": ${errorMessage}`);
      }

      // Step 7: Launch with built artifacts
      try {
        return await bridge.launchChild(
          {
            bundle: artifacts.bundle,
            html: artifacts.html,
            title: artifacts.manifest.title,
            css: artifacts.css,
            injectHostThemeVariables: manifest.injectHostThemeVariables,
            sourceRepo: normalizedPath,
            gitDependencies: manifest.gitDependencies,
          },
          options?.env,
          options?.panelId
        );
      } catch (launchError) {
        const errorMessage = launchError instanceof Error ? launchError.message : String(launchError);
        throw new Error(`Failed to launch panel "${normalizedPath}": ${errorMessage}`);
      }
    } catch (error) {
      // Clean up OPFS directory if fresh clone succeeded but subsequent steps failed
      if (cleanupOnFailure) {
        await cleanupOnFailure();
      }
      // All errors are already wrapped with context, just re-throw
      throw error;
    }
  } catch (error) {
    // Function-level error handler - re-throw after any cleanup
    throw error;
  }
},

  /**
   * Launch a child panel from in-memory build artifacts.
   * Use this when you've built the panel in-browser using @natstack/build.
   * Each child gets its own isolated OPFS partition.
   */
  async launchChild(
    artifacts: InMemoryBuildArtifacts,
    options?: CreateChildOptions
  ): AsyncResult<string> {
    try {
      return await bridge.launchChild(artifacts, options?.env, options?.panelId);
    } catch (error) {
      console.error("Failed to launch child panel", error);
      throw error;
    }
  },

  async removeChild(childId: string): AsyncResult<void> {
    return bridge.removeChild(childId);
  },

  /**
   * Get pre-bundled @natstack/* packages for in-panel builds.
   * Use with @natstack/build's registerPrebundledBatch() to enable
   * building child panels that use @natstack packages.
   */
  async getPrebundledPackages(): AsyncResult<Record<string, string>> {
    return bridge.getPrebundledPackages();
  },

  async setTitle(title: string): AsyncResult<void> {
    return bridge.setTitle(title);
  },

  async close(): AsyncResult<void> {
    return bridge.close();
  },

  onChildRemoved(callback: (childId: string) => void): () => void {
    return bridge.on("child-removed", (payload) => {
      if (typeof payload === "string") {
        callback(payload);
      }
    });
  },

  onFocus(callback: () => void): () => void {
    return bridge.on("focus", () => callback());
  },

  getTheme(): PanelTheme {
    return currentTheme;
  },

  onThemeChange(callback: (theme: PanelTheme) => void): () => void {
    callback(currentTheme);
    themeListeners.add(callback);
    return () => {
      themeListeners.delete(callback);
    };
  },

  async getEnv(): AsyncResult<Record<string, string>> {
    return bridge.getEnv();
  },

  async getInfo(): AsyncResult<{ panelId: string; partition: string }> {
    return bridge.getInfo();
  },

  async getPartition(): AsyncResult<string> {
    const info = await bridge.getInfo();
    return info.partition;
  },

  async getPanelId(): AsyncResult<string> {
    const info = await bridge.getInfo();
    return info.panelId;
  },

  // ===========================================================================
  // Git Operations
  // ===========================================================================

  git: {
    /**
     * Get git configuration for this panel.
     * Use with @natstack/git to clone/pull repos into OPFS.
     */
    async getConfig(): AsyncResult<GitConfig> {
      return bridge.git.getConfig();
    },
  },

  // ===========================================================================
  // Panel-to-Panel RPC
  // ===========================================================================

  /**
   * Expose methods that can be called by parent or child panels.
   *
   * @example
   * ```ts
   * // Child panel exposes its API
   * panelAPI.rpc.expose({
   *   async loadFile(path: string) {
   *     // Load file logic
   *   },
   *   async getContent() {
   *     return editorContent;
   *   }
   * });
   * ```
   */
  rpc: {
    /**
     * Expose methods that can be called by parent or child panels.
     */
    expose<T extends Rpc.ExposedMethods>(methods: T): void {
      bridge.rpc.expose(methods);
    },

    /**
     * Get a typed handle to communicate with another panel.
     * The panel must be a direct parent or child.
     *
     * @example
     * ```ts
     * // Define types
     * interface EditorApi {
     *   getContent(): Promise<string>;
     *   setContent(text: string): Promise<void>;
     * }
     *
     * interface EditorEvents extends Rpc.RpcEventMap {
     *   "content-changed": { text: string };
     *   "saved": { path: string };
     * }
     *
     * // Parent panel calls child
     * const childHandle = panelAPI.rpc.getHandle<EditorApi, EditorEvents>(childPanelId);
     * const content = await childHandle.call.getContent();
     *
     * // Listen to typed events
     * childHandle.on("content-changed", (payload) => {
     *   console.log(payload.text); // Fully typed!
     * });
     * ```
     */
    getHandle<
      T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
      E extends Rpc.RpcEventMap = Rpc.RpcEventMap
    >(targetPanelId: string, options?: PanelRpcHandleOptions): Rpc.PanelRpcHandle<T, E> {
      // Create a proxy that allows typed method calls
      const callProxy = new Proxy({} as Rpc.PanelRpcHandle<T>["call"], {
        get(_target, prop: string) {
          return async (...args: unknown[]) => {
            return bridge.rpc.call(targetPanelId, prop, ...args);
          };
        },
      });

      const eventListeners = new Map<string, Set<(payload: any) => void>>();
      const validateEvents = options?.validateEvents ?? false;
      const eventValidators = new Map<string, (payload: any) => void>();

      const getValidator = validateEvents
        ? <EventName extends Extract<keyof E, string>>(event: EventName) => {
            if (!eventValidators.has(event)) {
              let assertPayload: (payload: any) => void;
              try {
                assertPayload = typia.createAssert<E[EventName]>();
              } catch (error) {
                console.warn(
                  `[Panel RPC] Falling back to unvalidated events for "${event}":`,
                  error
                );
                assertPayload = () => {};
              }
              eventValidators.set(event, assertPayload as (payload: any) => void);
            }
            return eventValidators.get(event) as (payload: E[EventName]) => void;
          }
        : null;

      // Create the handle with proper overload support
      const handle: Rpc.PanelRpcHandle<T, E> = {
        panelId: targetPanelId,
        call: callProxy,
        on(event: string, handler: (payload: any) => void): () => void {
          // Track local listeners for this handle
          const listeners = eventListeners.get(event) ?? new Set();
          listeners.add(handler);
          eventListeners.set(event, listeners);

          // Subscribe to RPC events, filtering by source panel
          const unsubscribe = bridge.rpc.onEvent(event, (fromPanelId, payload) => {
            if (fromPanelId === targetPanelId) {
              try {
                if (getValidator) {
                  const assertPayload = getValidator(event as Extract<keyof E, string>);
                  assertPayload(payload as unknown as E[Extract<keyof E, string>]);
                }
              } catch (error) {
                console.error(
                  `[Panel RPC] Event payload validation failed for "${event}" from ${fromPanelId}:`,
                  error
                );
                return;
              }
              handler(payload);
            }
          });

          return () => {
            listeners.delete(handler);
            if (listeners.size === 0) {
              eventListeners.delete(event);
            }
            unsubscribe();
          };
        },
      };

      return handle;
    },

    /**
     * Alias for getHandle to retain existing call sites without schema validation.
     */
    getTypedHandle<
      T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
      E extends Rpc.RpcEventMap = Rpc.RpcEventMap
    >(targetPanelId: string): Rpc.PanelRpcHandle<T, E> {
      return panelAPI.rpc.getHandle<T, E>(targetPanelId);
    },

    /**
     * Convenience helper: get a handle with typia-backed event validation enabled.
     * Useful during development to surface schema drift between panels.
     */
    getValidatedHandle<
      T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
      E extends Rpc.RpcEventMap = Rpc.RpcEventMap
    >(targetPanelId: string): Rpc.PanelRpcHandle<T, E> {
      return panelAPI.rpc.getHandle<T, E>(targetPanelId, { validateEvents: true });
    },

    /**
     * Emit an event to a specific panel (must be parent or direct child).
     *
     * @example
     * ```ts
     * // Child notifies parent of a change
     * panelAPI.rpc.emit(parentPanelId, "contentChanged", { path: "/foo.txt" });
     * ```
     */
    async emit(targetPanelId: string, event: string, payload: unknown): Promise<void> {
      await bridge.rpc.emit(targetPanelId, event, payload);
    },

    /**
     * Subscribe to events from any panel (filtered by event name).
     * Use handle.on() for events from a specific panel.
     *
     * @example
     * ```ts
     * panelAPI.rpc.onEvent("contentChanged", (fromPanelId, payload) => {
     *   console.log(`Panel ${fromPanelId} changed:`, payload);
     * });
     * ```
     */
    onEvent(event: string, listener: (fromPanelId: string, payload: unknown) => void): () => void {
      return bridge.rpc.onEvent(event, listener);
    },
  },
};

export type PanelAPI = typeof panelAPI;

export default panelAPI;

// Re-export types for panel developers
export type { Rpc };
export type { GitConfig };

type ReactNamespace = typeof import("react");
type RadixThemeComponent = ComponentType<{
  appearance: PanelThemeAppearance;
  children?: ReactNode;
}>;

export function createRadixThemeProvider(
  ReactLib: ReactNamespace,
  ThemeComponent: RadixThemeComponent
) {
  return function NatstackRadixThemeProvider({ children }: { children?: ReactNode }): ReactNode {
    const [theme, setTheme] = ReactLib.useState<PanelTheme>(panelAPI.getTheme());

    ReactLib.useEffect(() => {
      let mounted = true;
      const unsubscribe = panelAPI.onThemeChange((nextTheme) => {
        if (mounted) {
          setTheme(nextTheme);
        }
      });
      return () => {
        mounted = false;
        unsubscribe();
      };
    }, []);

    return ReactLib.createElement(ThemeComponent, { appearance: theme.appearance }, children);
  };
}
