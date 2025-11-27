import { contextBridge, ipcRenderer } from "electron";
import { PANEL_ENV_ARG_PREFIX } from "../common/panelEnv.js";
import type { Rpc } from "@natstack/core";
import {
  type AICallOptions,
  type AIGenerateResult,
  type AIRoleRecord,
  type AIStreamChunkEvent,
  type AIStreamEndEvent,
  type AIStreamPart,
  type AIToolDefinition,
} from "@natstack/ai";
import {
  type InMemoryBuildArtifacts,
  type PanelInfo,
  type ThemeAppearance,
  type ClaudeCodeConversationInfo,
  type ClaudeCodeToolExecuteRequest,
  type ClaudeCodeToolResult,
} from "../shared/ipc/types.js";
type PanelEventName = "child-removed" | "focus";

type PanelEventMessage =
  | { panelId: string; type: "child-removed"; childId: string }
  | { panelId: string; type: "focus" }
  | { panelId: string; type: "theme"; theme: ThemeAppearance };

interface RpcRequest {
  type: "request";
  requestId: string;
  fromPanelId: string;
  method: string;
  args: unknown[];
}

interface RpcEvent {
  type: "event";
  fromPanelId: string;
  event: string;
  payload: unknown;
}

type RpcResponse =
  | {
    type: "response";
    requestId: string;
    result: unknown;
  }
  | {
    type: "response";
    requestId: string;
    error: string;
  };

const urlParams = new URLSearchParams(window.location.search);
const panelId = urlParams.get("panelId");

if (!panelId) {
  throw new Error("Panel ID missing from panel URL");
}

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
  if (typeof repoUrl !== 'string' || !repoUrl) {
    return null;
  }

  // Limit length to prevent abuse (max 500 chars)
  if (repoUrl.length > 500) {
    console.warn(`[Panel] Repo URL too long (${repoUrl.length} chars), truncating`);
    return null;
  }

  try {
    // For relative paths (workspace-relative repos), just normalize
    if (!repoUrl.includes('://')) {
      // Remove leading/trailing slashes and normalize
      const normalized = repoUrl.replace(/^\/+|\/+$/g, '');
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
    if (!['http:', 'https:', 'git:'].includes(url.protocol)) {
      console.warn(`[Panel] Invalid repo URL protocol: ${url.protocol}`);
      return null;
    }

    // Remove query params and fragments (not needed for cache keys)
    url.search = '';
    url.hash = '';

    // Normalize trailing slash
    const sanitized = url.toString().replace(/\/$/, '');

    return sanitized;
  } catch (error) {
    console.warn(`[Panel] Invalid repo URL format: ${repoUrl}`, error);
    return null;
  }
}

const authToken = parseAuthToken();
if (authToken) {
  // Register this panel view with the main process using the secure token
  void ipcRenderer.invoke("panel-bridge:register", panelId, authToken)
    .then(async () => {
      // After registration, get panel info to extract source repo for cache warming
      try {
        const gitConfig = await ipcRenderer.invoke("panel-bridge:get-git-config", panelId) as {
          serverUrl: string;
          token: string;
          sourceRepo: string;
          gitDependencies: Record<string, unknown>;
        };

        if (gitConfig.sourceRepo) {
          // Validate and sanitize repo URL before using as cache identifier
          const sanitizedRepoUrl = sanitizeRepoUrl(gitConfig.sourceRepo);
          if (sanitizedRepoUrl) {
            // Set repo URL in globalThis for cache hit tracking
            (globalThis as { __natstackRepoUrl?: string }).__natstackRepoUrl = sanitizedRepoUrl;
            console.log(`[Panel] Set repo URL for cache tracking: ${sanitizedRepoUrl}`);
          } else {
            console.warn(`[Panel] Skipping cache tracking - invalid repo URL: ${gitConfig.sourceRepo}`);
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

// AI stream event listeners
const aiStreamChunkListeners = new Set<(streamId: string, chunk: AIStreamPart) => void>();
const aiStreamEndListeners = new Set<(streamId: string) => void>();

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

// AI stream event handlers
const onChunk = (_event: Electron.IpcRendererEvent, payload: AIStreamChunkEvent) => {
  if (payload.panelId !== panelId) {
    return;
  }
  aiStreamChunkListeners.forEach((listener) => {
    try {
      listener(payload.streamId, payload.chunk);
    } catch (error) {
      console.error("Error in AI stream chunk listener:", error);
    }
  });
};
ipcRenderer.on("ai:stream-chunk", onChunk);

const onEnd = (_event: Electron.IpcRendererEvent, payload: AIStreamEndEvent) => {
  if (payload.panelId !== panelId) {
    return;
  }
  aiStreamEndListeners.forEach((listener) => {
    try {
      listener(payload.streamId);
    } catch (error) {
      console.error("Error in AI stream end listener:", error);
    }
  });
};
ipcRenderer.on("ai:stream-end", onEnd);

// Claude Code tool execution listeners
// Map conversationId -> tool callbacks
const ccToolCallbacks = new Map<
  string,
  Map<string, (args: Record<string, unknown>) => Promise<ClaudeCodeToolResult>>
>();

// Default tool callbacks for inline streaming (when using regular doStream with tools)
// These are used when no conversation-specific callbacks are found
const defaultToolCallbacks = new Map<
  string,
  (args: Record<string, unknown>) => Promise<ClaudeCodeToolResult>
>();

// Handle tool execution requests from main process
ipcRenderer.on(
  "ai:cc-tool-execute",
  async (_event: Electron.IpcRendererEvent, request: ClaudeCodeToolExecuteRequest) => {
    // Security: Only process requests for this panel
    if (request.panelId !== panelId) {
      return;
    }

    const { executionId, conversationId, toolName, args } = request;

    try {
      // First try conversation-specific callbacks
      let callback: ((args: Record<string, unknown>) => Promise<ClaudeCodeToolResult>) | undefined;

      const conversationCallbacks = ccToolCallbacks.get(conversationId);
      if (conversationCallbacks) {
        callback = conversationCallbacks.get(toolName);
      }

      // Fall back to default callbacks (for inline streaming with tools)
      if (!callback) {
        callback = defaultToolCallbacks.get(toolName);
      }

      if (!callback) {
        throw new Error(`No callback registered for tool: ${toolName}`);
      }

      const result = await callback(args);
      void ipcRenderer.invoke("ai:cc-tool-result", executionId, result);
    } catch (error) {
      const errorResult: ClaudeCodeToolResult = {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
      void ipcRenderer.invoke("ai:cc-tool-result", executionId, errorResult);
    }
  }
);

// =============================================================================
// Panel-to-Panel RPC
// =============================================================================

// Methods exposed by this panel that other panels can call
let exposedMethods: Rpc.ExposedMethods = {};

// Active RPC connections (MessagePorts) to other panels
const rpcPorts = new Map<string, MessagePort>();

// Pending requests for ports
const pendingPortRequests = new Map<
  string,
  {
    resolve: (port: MessagePort) => void;
    reject: (error: Error) => void;
    timeout?: NodeJS.Timeout;
  }[]
>();

// Event listeners for RPC events from other panels
const rpcEventListeners = new Map<string, Set<(fromPanelId: string, payload: unknown) => void>>();

// Handle incoming ports from the main process
ipcRenderer.on("panel-rpc:port", (event, { targetPanelId }: { targetPanelId: string }) => {
  const port = event.ports[0];
  if (!port) return;

  rpcPorts.set(targetPanelId, port);
  setupPort(targetPanelId, port);

  // Resolve any pending requests
  const pending = pendingPortRequests.get(targetPanelId);
  if (pending) {
    pending.forEach(({ resolve, timeout }) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(port);
    });
    pendingPortRequests.delete(targetPanelId);
  }
});

function setupPort(targetPanelId: string, port: MessagePort) {
  port.onmessage = (event) => {
    const message = event.data as Partial<RpcRequest | RpcEvent | RpcResponse>;
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      return;
    }

    switch (message.type) {
      case "request":
        handleRpcRequest(targetPanelId, port, message as RpcRequest);
        return;
      case "event":
        handleRpcEvent(targetPanelId, message as RpcEvent);
        return;
      default:
        return;
    }
  };
  port.start();
}

function handleRpcRequest(fromPanelId: string, port: MessagePort, request: RpcRequest) {
  const { requestId, method, args } = request;

  const handler = exposedMethods[method];
  if (!handler) {
    port.postMessage({
      type: "response",
      requestId,
      error: `Method "${method}" is not exposed by this panel`,
    });
    return;
  }

  Promise.resolve(handler(...args))
    .then((result) => {
      port.postMessage({
        type: "response",
        requestId,
        result,
      });
    })
    .catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      port.postMessage({
        type: "response",
        requestId,
        error: errorMessage,
      });
    });
}

function handleRpcEvent(fromPanelId: string, event: RpcEvent) {
  const listeners = rpcEventListeners.get(event.event);
  if (listeners) {
    listeners.forEach((listener) => {
      try {
        listener(fromPanelId, event.payload);
      } catch (error) {
        console.error(`Error in RPC event listener for "${event.event}":`, error);
      }
    });
  }
}

const PORT_TIMEOUT_MS = 60000;

async function getRpcPort(targetPanelId: string): Promise<MessagePort> {
  const existing = rpcPorts.get(targetPanelId);
  if (existing) return existing;

  // If we're already waiting, just add to the list
  if (pendingPortRequests.has(targetPanelId)) {
    return new Promise((resolve, reject) => {
      const pending = pendingPortRequests.get(targetPanelId);
      if (pending) {
        pending.push({ resolve, reject });
      }
    });
  }

  // First request: initialize array and start connection
  return new Promise((resolve, reject) => {
    const pending: {
      resolve: (port: MessagePort) => void;
      reject: (error: Error) => void;
      timeout?: NodeJS.Timeout;
    }[] = [{ resolve, reject }];
    pendingPortRequests.set(targetPanelId, pending);

    const timeout = setTimeout(() => {
      const pending = pendingPortRequests.get(targetPanelId);
      pending?.forEach(({ reject }) =>
        reject(new Error(`Timed out establishing RPC connection to ${targetPanelId}`))
      );
      pendingPortRequests.delete(targetPanelId);
    }, PORT_TIMEOUT_MS);
    // Attach timeout to all waiters so we can clear on success
    pending.forEach((entry) => (entry.timeout = timeout));

    ipcRenderer.invoke("panel-rpc:connect", panelId, targetPanelId).catch((error) => {
      clearTimeout(timeout);
      console.error(`Failed to establish RPC connection to ${targetPanelId}`, error);
      const pending = pendingPortRequests.get(targetPanelId);
      if (pending) {
        pending.forEach(({ reject }) =>
          reject(error instanceof Error ? error : new Error(String(error)))
        );
        pendingPortRequests.delete(targetPanelId);
      }
    });
  });
}

// Bridge interface exposed to panel code
const bridge = {
  panelId,

  // ==========================================================================
  // Panel Lifecycle API
  // ==========================================================================

  /**
   * Launch a child panel from in-memory build artifacts.
   * Use this when you've built the panel in-browser using @natstack/build.
   * Each child gets its own isolated OPFS partition.
   */
  launchChild: (
    artifacts: InMemoryBuildArtifacts,
    env?: Record<string, string>,
    requestedPanelId?: string
  ): Promise<string> => {
    return ipcRenderer.invoke("panel-bridge:launch-child", panelId, artifacts, env, requestedPanelId);
  },

  removeChild: (childId: string): Promise<void> => {
    return ipcRenderer.invoke("panel-bridge:remove-child", panelId, childId);
  },

  /**
   * Get pre-bundled @natstack/* packages for in-panel builds.
   * Use with @natstack/build's registerPrebundledBatch() to enable
   * building child panels that use @natstack packages.
   */
  getPrebundledPackages: (): Promise<Record<string, string>> => {
    return ipcRenderer.invoke("panel-bridge:get-prebundled-packages");
  },

  /**
   * Get development mode flag.
   * Use with @natstack/build's setDevMode() to configure cache expiration.
   */
  getDevMode: (): Promise<boolean> => {
    return ipcRenderer.invoke("panel-bridge:get-dev-mode");
  },

  /**
   * Get cache configuration from central config.
   * Returns panel-specific cache limits.
   */
  getCacheConfig: (): Promise<{
    maxEntriesPerPanel: number;
    maxSizePerPanel: number;
    expirationMs: number;
  }> => {
    return ipcRenderer.invoke("panel-bridge:get-cache-config");
  },

  /**
   * Load cache from disk (shared across all panels).
   * Returns cache entries stored in app data directory.
   */
  loadDiskCache: (): Promise<Record<string, { key: string; value: string; timestamp: number; size: number }>> => {
    return ipcRenderer.invoke("panel-bridge:load-disk-cache", panelId);
  },

  /**
   * Save cache to disk (shared across all panels).
   * Saves cache entries to app data directory.
   */
  saveDiskCache: (entries: Record<string, { key: string; value: string; timestamp: number; size: number }>): Promise<void> => {
    return ipcRenderer.invoke("panel-bridge:save-disk-cache", panelId, entries);
  },

  /**
   * Record cache hits for repo manifest tracking.
   * Tracks which cache entries this repo uses during runtime.
   */
  recordCacheHits: (cacheKeys: string[]): Promise<void> => {
    return ipcRenderer.invoke("panel-bridge:record-cache-hits", panelId, cacheKeys);
  },

  /**
   * Get cache keys for a repo (for pre-population).
   * Returns the list of cache keys this repo has used before.
   */
  getRepoCacheKeys: (): Promise<string[]> => {
    return ipcRenderer.invoke("panel-bridge:get-repo-cache-keys", panelId);
  },

  /**
   * Load specific cache entries by key (selective loading).
   * Returns only the requested cache entries.
   */
  loadCacheEntries: (keys: string[]): Promise<Record<string, { key: string; value: string; timestamp: number; size: number }>> => {
    return ipcRenderer.invoke("panel-bridge:load-cache-entries", keys);
  },

  setTitle: (title: string): Promise<void> => {
    return ipcRenderer.invoke("panel-bridge:set-title", panelId, title);
  },

  close: (): Promise<void> => {
    return ipcRenderer.invoke("panel-bridge:close", panelId);
  },

  getEnv: (): Promise<Record<string, string>> => {
    return ipcRenderer.invoke("panel-bridge:get-env", panelId);
  },

  getInfo: (): Promise<PanelInfo> => {
    return ipcRenderer.invoke("panel-bridge:get-info", panelId);
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

  rpc: {
    expose: (methods: Rpc.ExposedMethods): void => {
      exposedMethods = { ...exposedMethods, ...methods };
    },

    call: async (targetPanelId: string, method: string, ...args: unknown[]): Promise<unknown> => {
      const port = await getRpcPort(targetPanelId);
      const requestId = crypto.randomUUID();

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          port.removeEventListener("message", responseHandler);
          reject(new Error(`RPC call to ${targetPanelId}.${method} timed out`));
        }, 30000);

        const responseHandler = (event: MessageEvent) => {
          const message = event.data as Partial<RpcResponse>;
          if (!message || typeof message !== "object" || message.type !== "response") return;
          if (message.requestId !== requestId) return;

          clearTimeout(timeout);
          port.removeEventListener("message", responseHandler);
          if ("error" in message) {
            reject(new Error(message.error as string));
            return;
          }
          resolve((message as { result?: unknown }).result);
        };

        port.addEventListener("message", responseHandler);

        port.postMessage({
          type: "request",
          requestId,
          fromPanelId: panelId,
          method,
          args,
        });
      });
    },

    emit: async (targetPanelId: string, event: string, payload: unknown): Promise<void> => {
      const port = await getRpcPort(targetPanelId);
      port.postMessage({
        type: "event",
        fromPanelId: panelId,
        event,
        payload,
      });
    },

    onEvent: (
      event: string,
      listener: (fromPanelId: string, payload: unknown) => void
    ): (() => void) => {
      const listeners = rpcEventListeners.get(event) ?? new Set();
      listeners.add(listener);
      rpcEventListeners.set(event, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          rpcEventListeners.delete(event);
        }
      };
    },
  },

  // ==========================================================================
  // AI Provider API
  // ==========================================================================

  ai: {
    generate: (modelId: string, options: AICallOptions): Promise<AIGenerateResult> => {
      return ipcRenderer.invoke("ai:generate", modelId, options);
    },

    streamStart: (modelId: string, options: AICallOptions, streamId: string): Promise<void> => {
      return ipcRenderer.invoke("ai:stream-start", modelId, options, streamId);
    },

    streamCancel: (streamId: string): Promise<void> => {
      return ipcRenderer.invoke("ai:stream-cancel", streamId);
    },

    listRoles: (): Promise<AIRoleRecord> => {
      return ipcRenderer.invoke("ai:list-roles");
    },

    onStreamChunk: (listener: (streamId: string, chunk: AIStreamPart) => void): (() => void) => {
      aiStreamChunkListeners.add(listener);
      return () => {
        aiStreamChunkListeners.delete(listener);
      };
    },

    onStreamEnd: (listener: (streamId: string) => void): (() => void) => {
      aiStreamEndListeners.add(listener);
      return () => {
        aiStreamEndListeners.delete(listener);
      };
    },

    // =========================================================================
    // Claude Code Conversation API
    // =========================================================================

    /**
     * Start a Claude Code conversation with tools.
     * Returns conversation info including the conversationId.
     */
    ccConversationStart: async (
      modelId: string,
      tools: AIToolDefinition[],
      callbacks: Record<string, (args: Record<string, unknown>) => Promise<ClaudeCodeToolResult>>
    ): Promise<ClaudeCodeConversationInfo> => {
      const info = await ipcRenderer.invoke(
        "ai:cc-conversation-start",
        modelId,
        tools
      ) as ClaudeCodeConversationInfo;

      // Register the tool callbacks for this conversation
      const callbackMap = new Map<
        string,
        (args: Record<string, unknown>) => Promise<ClaudeCodeToolResult>
      >();
      for (const [name, callback] of Object.entries(callbacks)) {
        callbackMap.set(name, callback);
      }
      ccToolCallbacks.set(info.conversationId, callbackMap);

      return info;
    },

    /**
     * Generate with an existing Claude Code conversation.
     */
    ccGenerate: (conversationId: string, options: AICallOptions): Promise<AIGenerateResult> => {
      return ipcRenderer.invoke("ai:cc-generate", conversationId, options);
    },

    /**
     * Start streaming with an existing Claude Code conversation.
     */
    ccStreamStart: (
      conversationId: string,
      options: AICallOptions,
      streamId: string
    ): Promise<void> => {
      return ipcRenderer.invoke("ai:cc-stream-start", conversationId, options, streamId);
    },

    /**
     * End a Claude Code conversation and clean up resources.
     */
    ccConversationEnd: (conversationId: string): Promise<void> => {
      // Clean up local callbacks
      ccToolCallbacks.delete(conversationId);
      return ipcRenderer.invoke("ai:cc-conversation-end", conversationId);
    },

    /**
     * Register tool callbacks for inline Claude Code streaming.
     * These callbacks are used when calling doStream with tools on a Claude Code model.
     * This allows tools to be executed without explicitly creating a conversation.
     *
     * @param callbacks - Map of tool name to callback function
     * @returns Cleanup function to unregister the callbacks
     */
    registerToolCallbacks: (
      callbacks: Record<string, (args: Record<string, unknown>) => Promise<ClaudeCodeToolResult>>
    ): (() => void) => {
      // Register each callback
      for (const [name, callback] of Object.entries(callbacks)) {
        defaultToolCallbacks.set(name, callback);
      }

      // Return cleanup function
      return () => {
        for (const name of Object.keys(callbacks)) {
          defaultToolCallbacks.delete(name);
        }
      };
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
     * - gitDependencies: Git dependencies from manifest (to clone into OPFS)
     */
    getConfig: (): Promise<{
      serverUrl: string;
      token: string;
      sourceRepo: string;
      gitDependencies: Record<string, string | { repo: string; branch?: string; commit?: string; tag?: string }>;
    }> => {
      return ipcRenderer.invoke("panel-bridge:get-git-config", panelId);
    },
  },
};

contextBridge.exposeInMainWorld("__natstackPanelBridge", bridge);
