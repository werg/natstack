import { contextBridge, ipcRenderer } from "electron";
import { PANEL_ENV_ARG_PREFIX } from "../common/panelEnv.js";
import type { Rpc } from "@natstack/core";
import { type AIRoleRecord } from "@natstack/ai";
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

interface RpcRequest {
  type: "request";
  requestId: string;
  fromId: string;
  method: string;
  args: unknown[];
}

interface RpcEvent {
  type: "event";
  fromId: string;
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

// Parse panelId from additionalArguments (passed via webPreferences)
const parsePanelId = (): string | null => {
  const arg = process.argv.find((value) => value.startsWith("--natstack-panel-id="));
  return arg ? arg.split("=")[1] ?? null : null;
};

const panelId = parsePanelId();

if (!panelId) {
  throw new Error("Panel ID missing from additionalArguments");
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
        const gitConfig = (await ipcRenderer.invoke("panel-bridge:get-git-config", panelId)) as {
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
// Panel-to-Panel RPC
// =============================================================================

// Methods exposed by this panel that other panels can call
let exposedMethods: Rpc.ExposedMethods = {};

// Active RPC connections (MessagePorts) to other panels
const rpcPorts = new Map<string, MessagePort>();

// Worker RPC connections - uses IPC instead of MessageChannel
interface WorkerRpcConnection {
  workerId: string;
  messageHandlers: Set<(event: { data: unknown }) => void>;
}
const workerRpcConnections = new Map<string, WorkerRpcConnection>();

// Pending requests for ports (can be real MessagePort or RpcPort proxy)
const pendingPortRequests = new Map<
  string,
  {
    resolve: (port: MessagePort | RpcPort) => void;
    reject: (error: Error) => void;
    timeout?: NodeJS.Timeout;
  }[]
>();

// Interface for a MessagePort-like object (works for both real ports and worker proxies)
interface RpcPort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", handler: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", handler: (event: MessageEvent) => void): void;
}

// Event listeners for RPC events from other panels
const rpcEventListeners = new Map<string, Set<(fromPanelId: string, payload: unknown) => void>>();

// Handle incoming RPC messages from workers
// This single handler processes both RPC requests/responses and events
ipcRenderer.on(
  "worker-rpc:message",
  (_event, { fromId, message }: { fromId: string; message: unknown }) => {
    // Worker sends fromId as "worker:xxx" - strip the prefix to match our connection key
    const workerId = fromId.startsWith("worker:") ? fromId.slice(7) : fromId;

    // Type check for message structure
    const msg = message as { type?: string; event?: string; payload?: unknown } | null;

    // Handle events directly to rpcEventListeners
    if (msg && msg.type === "event" && typeof msg.event === "string") {
      const listeners = rpcEventListeners.get(msg.event);
      if (listeners) {
        listeners.forEach((listener) => {
          try {
            listener(fromId, msg.payload);
          } catch (error) {
            console.error(`Error in RPC event listener for "${msg.event}":`, error);
          }
        });
      }
    }

    // Also dispatch to worker RPC connection handlers (for request/response)
    const conn = workerRpcConnections.get(workerId);
    if (conn) {
      for (const handler of conn.messageHandlers) {
        try {
          handler({ data: message });
        } catch (error) {
          console.error(`Error in worker RPC message handler:`, error);
        }
      }
    }
  }
);

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

// Create a fake "port" for worker communication that routes via IPC
function createWorkerRpcPort(workerId: string): RpcPort {
  // Get or create the worker connection
  let conn = workerRpcConnections.get(workerId);
  if (!conn) {
    conn = { workerId, messageHandlers: new Set() };
    workerRpcConnections.set(workerId, conn);
  }

  return {
    postMessage(message: unknown): void {
      // Send via IPC to main process which routes to worker
      ipcRenderer.send("panel-rpc:to-worker", panelId, workerId, message);
    },
    addEventListener(type: "message", handler: (event: MessageEvent) => void): void {
      if (type === "message") {
        // Store handler that receives our simplified event format
        conn!.messageHandlers.add(handler as (event: { data: unknown }) => void);
      }
    },
    removeEventListener(type: "message", handler: (event: MessageEvent) => void): void {
      if (type === "message") {
        conn!.messageHandlers.delete(handler as (event: { data: unknown }) => void);
      }
    },
  };
}

// Cache of worker ports (fake ports that route via IPC)
const workerRpcPorts = new Map<string, RpcPort>();

async function getRpcPort(targetPanelId: string): Promise<RpcPort> {
  // Check for existing real MessagePort (panel connection)
  const existingPort = rpcPorts.get(targetPanelId);
  if (existingPort) return existingPort;

  // Check for existing worker port
  const existingWorkerPort = workerRpcPorts.get(targetPanelId);
  if (existingWorkerPort) return existingWorkerPort;

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
      resolve: (port: RpcPort) => void;
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

    ipcRenderer
      .invoke("panel-rpc:connect", panelId, targetPanelId)
      .then((result: { isWorker: boolean; workerId?: string }) => {
        if (result.isWorker && result.workerId) {
          // Target is a worker - create IPC-based proxy port
          clearTimeout(timeout);
          const port = createWorkerRpcPort(result.workerId);
          workerRpcPorts.set(targetPanelId, port);

          // Resolve all pending requests
          const pending = pendingPortRequests.get(targetPanelId);
          if (pending) {
            pending.forEach(({ resolve, timeout: t }) => {
              if (t) clearTimeout(t);
              resolve(port);
            });
            pendingPortRequests.delete(targetPanelId);
          }
        }
        // For panels, we wait for the "panel-rpc:port" event which delivers the MessagePort
      })
      .catch((error) => {
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
  createChild: (spec: ChildSpec): Promise<string> => {
    return ipcRenderer.invoke("panel-bridge:create-child", panelId, spec);
  },

  removeChild: (childId: string): Promise<void> => {
    return ipcRenderer.invoke("panel-bridge:remove-child", panelId, childId);
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
          fromId: panelId,
          method,
          args,
        });
      });
    },

    emit: async (targetPanelId: string, event: string, payload: unknown): Promise<void> => {
      const port = await getRpcPort(targetPanelId);
      port.postMessage({
        type: "event",
        fromId: panelId,
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
    // =========================================================================
    // Core API
    // =========================================================================

    listRoles: (): Promise<AIRoleRecord> => {
      return ipcRenderer.invoke("ai:list-roles");
    },

    streamCancel: (streamId: string): Promise<void> => {
      return ipcRenderer.invoke("ai:stream-cancel", streamId);
    },

    // =========================================================================
    // New Unified streamText API
    // =========================================================================

    /**
     * Start a streamText generation - unified API for all model types.
     * The agent loop runs server-side, tool callbacks execute panel-side.
     */
    streamTextStart: (options: StreamTextOptions, streamId: string): Promise<void> => {
      // Debug: Log what we're about to send via IPC
      console.log("[Preload AI] streamTextStart called:", {
        model: options.model,
        messageCount: options.messages?.length,
        toolCount: options.tools?.length,
        streamId,
      });

      // Debug: Try JSON stringify to catch serialization issues
      try {
        JSON.stringify(options);
        console.log("[Preload AI] options is JSON-serializable");
      } catch (e) {
        console.error("[Preload AI] options failed JSON.stringify:", e);
        console.error("[Preload AI] options detail:", options);
      }

      return ipcRenderer.invoke("ai:stream-text-start", options, streamId);
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
      return ipcRenderer.invoke("panel-bridge:browser-get-cdp-endpoint", browserId);
    },

    /**
     * Navigate browser panel to a URL (human UI control).
     */
    navigate: (browserId: string, url: string): Promise<void> => {
      return ipcRenderer.invoke("panel-bridge:browser-navigate", browserId, url);
    },

    /**
     * Go back in browser history.
     */
    goBack: (browserId: string): Promise<void> => {
      return ipcRenderer.invoke("panel-bridge:browser-go-back", browserId);
    },

    /**
     * Go forward in browser history.
     */
    goForward: (browserId: string): Promise<void> => {
      return ipcRenderer.invoke("panel-bridge:browser-go-forward", browserId);
    },

    /**
     * Reload the current page.
     */
    reload: (browserId: string): Promise<void> => {
      return ipcRenderer.invoke("panel-bridge:browser-reload", browserId);
    },

    /**
     * Stop loading the current page.
     */
    stop: (browserId: string): Promise<void> => {
      return ipcRenderer.invoke("panel-bridge:browser-stop", browserId);
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
      gitDependencies: Record<
        string,
        string | { repo: string; branch?: string; commit?: string; tag?: string }
      >;
    }> => {
      return ipcRenderer.invoke("panel-bridge:get-git-config", panelId);
    },
  },
};

contextBridge.exposeInMainWorld("__natstackPanelBridge", bridge);
