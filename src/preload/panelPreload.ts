import { contextBridge, ipcRenderer } from "electron";
import { PANEL_ENV_ARG_PREFIX } from "../common/panelEnv.js";
import type { Rpc } from "@natstack/core";
import { type AIRoleRecord } from "@natstack/ai";
import { createRpcBridge } from "@natstack/rpc";
import type { ExposedMethods, RpcBridgeInternal } from "@natstack/rpc";
import { createPanelTransport } from "./transport.js";
import {
  type ChildSpec,
  type PanelInfo,
  type ThemeAppearance,
  type StreamTextOptions,
  type StreamTextEvent,
  type ToolExecutionResult,
} from "../shared/ipc/types.js";
type PanelEventName = "child-removed" | "focus";

type PanelEventMessage =
  | { panelId: string; type: "child-removed"; childId: string }
  | { panelId: string; type: "focus" }
  | { panelId: string; type: "theme"; theme: ThemeAppearance };

// Parse panelId from additionalArguments (passed via webPreferences)
const parsePanelId = (): string | null => {
  const arg = process.argv.find((value) => value.startsWith("--natstack-panel-id="));
  return arg ? arg.split("=")[1] ?? null : null;
};

const panelId = parsePanelId();

if (!panelId) {
  throw new Error("Panel ID missing from additionalArguments");
}

const rpc = createRpcBridge({
  selfId: `panel:${panelId}`,
  transport: createPanelTransport(panelId),
}) as RpcBridgeInternal;

const callMainRpc = async <T = unknown>(method: string, ...args: unknown[]): Promise<T> => {
  return rpc.call<T>("main", method, ...args);
};

const parseEnvArg = (): Record<string, string> => {
  const arg = process.argv.find((value) => value.startsWith(PANEL_ENV_ARG_PREFIX));
  if (!arg) {
    return {};
  }

  const encoded = arg.slice(PANEL_ENV_ARG_PREFIX.length);
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const sanitizedEntries = Object.entries(parsed ?? {}).filter(
      ([key, value]) => typeof key === "string" && typeof value === "string"
    ) as Array<[string, string]>;
    return Object.fromEntries(sanitizedEntries);
  } catch (error) {
    console.error("Failed to parse panel env payload", error);
    return {};
  }
};

const syntheticEnv = parseEnvArg();

const parseAuthToken = (): string | undefined => {
  const arg = process.argv.find((value) => value.startsWith("--natstack-auth-token="));
  return arg ? arg.split("=")[1] : undefined;
};

/**
 * Validate and sanitize a repo URL for safe use as cache identifier
 * - Ensures URL is a valid string
 * - Removes query parameters and fragments
 * - Normalizes trailing slashes
 * - Limits length to prevent abuse
 */
function sanitizeRepoUrl(repoUrl: unknown): string | null {
  if (typeof repoUrl !== "string" || !repoUrl) {
    return null;
  }

  // Limit length to prevent abuse (max 500 chars)
  if (repoUrl.length > 500) {
    console.warn(`[Panel] Repo URL too long (${repoUrl.length} chars), truncating`);
    return null;
  }

  try {
    // For relative paths (workspace-relative repos), just normalize
    if (!repoUrl.includes("://")) {
      // Remove leading/trailing slashes and normalize
      const normalized = repoUrl.replace(/^\/+|\/+$/g, "");
      // Validate it doesn't contain dangerous characters
      if (/[<>"|?*\x00-\x1f]/.test(normalized)) {
        console.warn(`[Panel] Repo path contains invalid characters: ${normalized}`);
        return null;
      }
      return normalized;
    }

    // For full URLs, parse and sanitize
    const url = new URL(repoUrl);

    // Only allow http/https/git protocols
    if (!["http:", "https:", "git:"].includes(url.protocol)) {
      console.warn(`[Panel] Invalid repo URL protocol: ${url.protocol}`);
      return null;
    }

    // Remove query params and fragments (not needed for cache keys)
    url.search = "";
    url.hash = "";

    // Normalize trailing slash
    const sanitized = url.toString().replace(/\/$/, "");

    return sanitized;
  } catch (error) {
    console.warn(`[Panel] Invalid repo URL format: ${repoUrl}`, error);
    return null;
  }
}

const authToken = parseAuthToken();
if (authToken) {
  // Register this panel view with the main process using the secure token
  void ipcRenderer
    .invoke("panel-bridge:register", panelId, authToken)
    .then(async () => {
      // After registration, get panel info to extract source repo for cache warming
      try {
        const gitConfig = await callMainRpc<{
          serverUrl: string;
          token: string;
          sourceRepo: string;
          branch?: string;
          commit?: string;
          tag?: string;
          resolvedRepoArgs: Record<string, unknown>;
        }>("bridge.getGitConfig");

        if (gitConfig.sourceRepo) {
          // Validate and sanitize repo URL before using as cache identifier
          const sanitizedRepoUrl = sanitizeRepoUrl(gitConfig.sourceRepo);
          if (sanitizedRepoUrl) {
            // Set repo URL in globalThis for cache hit tracking
            (globalThis as { __natstackRepoUrl?: string }).__natstackRepoUrl = sanitizedRepoUrl;
            console.log(`[Panel] Set repo URL for cache tracking: ${sanitizedRepoUrl}`);
          } else {
            console.warn(
              `[Panel] Skipping cache tracking - invalid repo URL: ${gitConfig.sourceRepo}`
            );
          }
        }
      } catch (error) {
        console.warn("[Panel] Failed to get git config for cache warming:", error);
      }
    })
    .catch((error: unknown) => {
      console.error("Failed to register panel view", error);
    });
} else {
  console.error("No auth token found for panel", panelId);
}

contextBridge.exposeInMainWorld("process", { env: syntheticEnv });

// Event handling for panel events (one-way events from main)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const eventListeners = new Map<PanelEventName, Set<(payload: any) => void>>();
let currentTheme: ThemeAppearance = "light";
const themeListeners = new Set<(theme: ThemeAppearance) => void>();

// Unified streamText event listeners
const streamTextChunkListeners = new Set<(streamId: string, chunk: StreamTextEvent) => void>();
const streamTextEndListeners = new Set<(streamId: string) => void>();

// Tool callbacks registered by @natstack/ai streamText
// Map from streamId -> Map<toolName, callback>
const registeredToolCallbacks = new Map<
  string,
  Map<string, (args: Record<string, unknown>) => Promise<unknown>>
>();

const updateTheme = (theme: ThemeAppearance) => {
  currentTheme = theme;
  for (const listener of themeListeners) {
    listener(theme);
  }
};

// Global keydown listener for DevTools
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "i") {
    event.preventDefault();
    void ipcRenderer.invoke("panel:open-devtools", panelId).catch((error) => {
      console.error("Failed to open panel devtools", error);
    });
  }
});

ipcRenderer.on("panel:event", (_event, payload: PanelEventMessage) => {
  if (payload.panelId !== panelId) {
    return;
  }

  if (payload.type === "theme") {
    updateTheme(payload.theme);
    return;
  }

  const listeners = eventListeners.get(payload.type);
  if (!listeners) {
    return;
  }

  if (payload.type === "child-removed") {
    listeners.forEach((listener) => listener(payload.childId));
  } else if (payload.type === "focus") {
    listeners.forEach((listener) => listener(undefined));
  }
});

// StreamText event handlers
ipcRenderer.on(
  "ai:stream-text-chunk",
  (_event: Electron.IpcRendererEvent, payload: { panelId: string; streamId: string; chunk: StreamTextEvent }) => {
    if (payload.panelId !== panelId) return;
    streamTextChunkListeners.forEach((listener) => {
      try {
        listener(payload.streamId, payload.chunk);
      } catch (error) {
        console.error("Error in streamText chunk listener:", error);
      }
    });
  }
);

ipcRenderer.on(
  "ai:stream-text-end",
  (_event: Electron.IpcRendererEvent, payload: { panelId: string; streamId: string }) => {
    if (payload.panelId !== panelId) return;
    streamTextEndListeners.forEach((listener) => {
      try {
        listener(payload.streamId);
      } catch (error) {
        console.error("Error in streamText end listener:", error);
      }
    });
  }
);

// Handle tool execution requests from main process (bidirectional RPC)
// Main process sends: sender.postMessage("panel:execute-tool", [streamId, toolName, args], [port])
ipcRenderer.on(
  "panel:execute-tool",
  async (event: Electron.IpcRendererEvent, message: [string, string, Record<string, unknown>]) => {
    const [streamId, toolName, args] = message;
    const streamCallbacks = registeredToolCallbacks.get(streamId);
    const callback = streamCallbacks?.get(toolName);

    let result: ToolExecutionResult;
    if (!callback) {
      result = {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    } else {
      try {
        const toolResult = await callback(args);
        // Check if toolResult is already a proper ToolExecutionResult
        if (
          toolResult &&
          typeof toolResult === "object" &&
          "content" in toolResult &&
          Array.isArray((toolResult as ToolExecutionResult).content)
        ) {
          // Pass through the full result including any data field
          result = toolResult as ToolExecutionResult;
        } else {
          // Wrap primitive/unknown results
          result = {
            content: [{ type: "text", text: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult) }],
          };
        }
      } catch (err) {
        result = {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    }

    // Send response back via the port
    event.ports[0]?.postMessage(result);
  }
);

// =============================================================================
// Database Types and Helper
// =============================================================================

/** Result of a run (INSERT/UPDATE/DELETE) operation */
interface DbRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Database connection with query methods */
interface PanelDatabase {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<DbRunResult>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Create a Database wrapper around a handle.
 */
function createPanelDatabase(handle: string): PanelDatabase {
  let closed = false;

  const assertOpen = () => {
    if (closed) {
      throw new Error("Database connection is closed");
    }
  };

  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      assertOpen();
      return callMainRpc<T[]>("db.query", handle, sql, params);
    },

    async run(sql: string, params?: unknown[]): Promise<DbRunResult> {
      assertOpen();
      return callMainRpc<DbRunResult>("db.run", handle, sql, params);
    },

    async get<T>(sql: string, params?: unknown[]): Promise<T | null> {
      assertOpen();
      return callMainRpc<T | null>("db.get", handle, sql, params);
    },

    async exec(sql: string): Promise<void> {
      assertOpen();
      await callMainRpc("db.exec", handle, sql);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await callMainRpc("db.close", handle);
    },
  };
}

const createChild = (spec: ChildSpec): Promise<string> => {
  return callMainRpc("bridge.createChild", spec);
};

const removeChild = (childId: string): Promise<void> => {
  return callMainRpc("bridge.removeChild", childId);
};

const setTitle = (title: string): Promise<void> => {
  return callMainRpc("bridge.setTitle", title);
};

const close = (): Promise<void> => {
  return callMainRpc("bridge.close");
};

const getEnv = (): Promise<Record<string, string>> => {
  return callMainRpc("bridge.getEnv");
};

const getInfo = (): Promise<PanelInfo> => {
  return callMainRpc("bridge.getInfo");
};

const rpcApi = {
  expose: (methods: Rpc.ExposedMethods): void => {
    rpc.expose(methods as unknown as ExposedMethods);
  },

  call: (targetId: string, method: string, ...args: unknown[]): Promise<unknown> => {
    return rpc.call(targetId, method, ...args);
  },

  emit: (targetId: string, event: string, payload: unknown): Promise<void> => {
    return rpc.emit(targetId, event, payload);
  },

  onEvent: (event: string, listener: (fromPanelId: string, payload: unknown) => void): (() => void) => {
    return rpc.onEvent(event, listener);
  },
};

// Runtime interface exposed to panel code
const panelRuntime = {
  panelId,
  parentId: syntheticEnv["PARENT_ID"] ?? null,

  // ==========================================================================
  // Panel Lifecycle API
  // ==========================================================================

  /**
   * Create a child panel, worker, or browser from a spec.
   * The main process handles git checkout and build for app/worker types.
   * Returns the panel ID immediately; build happens asynchronously.
   *
   * @param spec - Child specification with type discriminator
   * @returns Panel ID that can be used for communication
   */
  createChild,
  removeChild,
  setTitle,
  close,
  getEnv,
  getInfo,

  /**
   * New unified API: ergonomic wrappers grouped under `bridge`.
   * Legacy top-level methods remain for compatibility.
   */
  bridge: {
    createChild,
    removeChild,
    setTitle,
    close,
    getEnv,
    getInfo,
  },

  getTree: (): Promise<PanelInfo> => ipcRenderer.invoke("panel:get-tree"),

  // Event subscription (local event handling for one-way events)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (event: PanelEventName, listener: (payload: any) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listeners = eventListeners.get(event) ?? new Set<(payload: any) => void>();
    listeners.add(listener);
    eventListeners.set(event, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        eventListeners.delete(event);
      }
    };
  },

  // Theme handling
  getTheme: (): ThemeAppearance => currentTheme,
  onThemeChange: (listener: (theme: ThemeAppearance) => void) => {
    themeListeners.add(listener);
    return () => {
      themeListeners.delete(listener);
    };
  },

  // ==========================================================================
  // Panel-to-Panel RPC API
  // ==========================================================================

  rpc: rpcApi,

  // ==========================================================================
  // AI Provider API
  // ==========================================================================

  ai: {
    // =========================================================================
    // Core API
    // =========================================================================

    listRoles: (): Promise<AIRoleRecord> => {
      return callMainRpc("ai.listRoles");
    },

    streamCancel: (streamId: string): Promise<void> => {
      return callMainRpc("ai.streamCancel", streamId);
    },

    // =========================================================================
    // New Unified streamText API
    // =========================================================================

    /**
     * Start a streamText generation - unified API for all model types.
     * The agent loop runs server-side, tool callbacks execute panel-side.
     */
    streamTextStart: (options: StreamTextOptions, streamId: string): Promise<void> => {
      return callMainRpc("ai.streamTextStart", options, streamId);
    },

    /**
     * Listen for streamText chunks (unified format).
     */
    onStreamChunk: (listener: (streamId: string, chunk: StreamTextEvent) => void): (() => void) => {
      streamTextChunkListeners.add(listener);
      return () => {
        streamTextChunkListeners.delete(listener);
      };
    },

    /**
     * Listen for streamText end events.
     */
    onStreamEnd: (listener: (streamId: string) => void): (() => void) => {
      streamTextEndListeners.add(listener);
      return () => {
        streamTextEndListeners.delete(listener);
      };
    },

    /**
     * Register tool callbacks for a stream.
     * Called by @natstack/ai streamText to register tool execute functions.
     * Main process will invoke these via panel:execute-tool.
     *
     * Note: We accept a plain object instead of Map because contextBridge
     * cannot pass Maps with function values across the boundary.
     */
    registerTools: (
      streamId: string,
      callbacks: Record<string, (args: Record<string, unknown>) => Promise<unknown>>
    ): (() => void) => {
      // Convert the plain object to a Map for internal storage
      const callbackMap = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
      for (const [name, fn] of Object.entries(callbacks)) {
        callbackMap.set(name, fn);
      }
      registeredToolCallbacks.set(streamId, callbackMap);
      return () => {
        registeredToolCallbacks.delete(streamId);
      };
    },
  },

  // ==========================================================================
  // Browser Panel API
  // ==========================================================================

  browser: {
    /**
     * Get CDP WebSocket endpoint for Playwright connection.
     * Only the parent panel that created the browser can access this.
     * @param browserId - The browser panel's ID
     * @returns WebSocket URL for CDP connection
     */
    getCdpEndpoint: (browserId: string): Promise<string> => {
      return callMainRpc("browser.getCdpEndpoint", browserId);
    },

    /**
     * Navigate browser panel to a URL (human UI control).
     */
    navigate: (browserId: string, url: string): Promise<void> => {
      return callMainRpc("browser.navigate", browserId, url);
    },

    /**
     * Go back in browser history.
     */
    goBack: (browserId: string): Promise<void> => {
      return callMainRpc("browser.goBack", browserId);
    },

    /**
     * Go forward in browser history.
     */
    goForward: (browserId: string): Promise<void> => {
      return callMainRpc("browser.goForward", browserId);
    },

    /**
     * Reload the current page.
     */
    reload: (browserId: string): Promise<void> => {
      return callMainRpc("browser.reload", browserId);
    },

    /**
     * Stop loading the current page.
     */
    stop: (browserId: string): Promise<void> => {
      return callMainRpc("browser.stop", browserId);
    },
  },

  // ==========================================================================
  // Git API
  // ==========================================================================

  git: {
    /**
     * Get git configuration for this panel.
     * Use with @natstack/git to clone/pull repos into OPFS.
     *
     * Returns:
     * - serverUrl: Git server base URL (e.g., http://localhost:63524)
     * - token: Bearer token for authentication
     * - sourceRepo: This panel's source repo path (e.g., "panels/my-panel")
     * - resolvedRepoArgs: Repo args (name -> spec) provided by parent at createChild time
     */
    getConfig: (): Promise<{
      serverUrl: string;
      token: string;
      sourceRepo: string;
      branch?: string;
      commit?: string;
      tag?: string;
      resolvedRepoArgs: Record<string, string | { repo: string; ref?: string }>;
    }> => {
      return callMainRpc("bridge.getGitConfig");
    },
  },

  // ==========================================================================
  // Database API
  // ==========================================================================

  db: {
    /**
     * Open a panel-scoped database.
     * The database file is stored in the panel's partition directory.
     *
     * @param name - Database name (alphanumeric, underscore, hyphen only)
     * @param readOnly - Open in read-only mode (default: false)
     * @returns Database object with query methods
     */
    open: async (name: string, readOnly?: boolean): Promise<PanelDatabase> => {
      const handle = await callMainRpc<string>("db.open", name, readOnly);
      return createPanelDatabase(handle);
    },

    /**
     * Open a shared workspace database.
     * Shared databases can be accessed by any worker or panel in the workspace.
     *
     * @param name - Database name (alphanumeric, underscore, hyphen only)
     * @param readOnly - Open in read-only mode (default: false)
     * @returns Database object with query methods
     */
    openShared: async (name: string, readOnly?: boolean): Promise<PanelDatabase> => {
      const handle = await callMainRpc<string>("db.openShared", name, readOnly);
      return createPanelDatabase(handle);
    },
  },
};

contextBridge.exposeInMainWorld("__natstackPanelBridge", panelRuntime);
