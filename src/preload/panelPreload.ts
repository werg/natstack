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
} from "@natstack/ai";
import { PanelInfo, ThemeAppearance } from "../shared/ipc/types.js";
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

const authToken = parseAuthToken();
if (authToken) {
  // Register this panel view with the main process using the secure token
  void ipcRenderer.invoke("panel-bridge:register", panelId, authToken).catch((error: unknown) => {
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

  // IPC methods via ipcRenderer.invoke
  createChild: (
    path: string,
    env?: Record<string, string>,
    requestedPanelId?: string
  ): Promise<string> => {
    return ipcRenderer.invoke("panel-bridge:create-child", panelId, path, env, requestedPanelId);
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
  },
};

contextBridge.exposeInMainWorld("__natstackPanelBridge", bridge);
