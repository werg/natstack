import { contextBridge, ipcRenderer } from "electron";
import { PANEL_ENV_ARG_PREFIX } from "../common/panelEnv.js";
import type { ThemeAppearance, PanelInfo, ExposedMethods } from "../shared/ipc/index.js";

type PanelEventName = "child-removed" | "focus";

type PanelEventMessage =
  | { panelId: string; type: "child-removed"; childId: string }
  | { panelId: string; type: "focus" }
  | { panelId: string; type: "theme"; theme: ThemeAppearance };

interface RpcRequest {
  requestId: string;
  fromPanelId: string;
  method: string;
  args: unknown[];
}

interface RpcEvent {
  fromPanelId: string;
  event: string;
  payload: unknown;
}

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

contextBridge.exposeInMainWorld("process", { env: syntheticEnv });

// Register this panel view with the main process
void ipcRenderer.invoke("panel-bridge:register-view", panelId).catch((error: unknown) => {
  console.error("Failed to register panel view", error);
});

// Event handling for panel events (one-way events from main)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const eventListeners = new Map<PanelEventName, Set<(payload: any) => void>>();
let currentTheme: ThemeAppearance = "light";
const themeListeners = new Set<(theme: ThemeAppearance) => void>();

const updateTheme = (theme: ThemeAppearance) => {
  currentTheme = theme;
  for (const listener of themeListeners) {
    listener(theme);
  }
};

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

// =============================================================================
// Panel-to-Panel RPC
// =============================================================================

// Methods exposed by this panel that other panels can call
let exposedMethods: ExposedMethods = {};

// Event listeners for RPC events from other panels
const rpcEventListeners = new Map<string, Set<(fromPanelId: string, payload: unknown) => void>>();

// Handle incoming RPC requests from other panels
ipcRenderer.on("panel-rpc:request", async (_event, request: RpcRequest) => {
  const { requestId, fromPanelId, method, args } = request;

  try {
    const handler = exposedMethods[method];
    if (!handler) {
      throw new Error(`Method "${method}" is not exposed by this panel`);
    }

    const result = await handler(...args);
    ipcRenderer.send(`panel-rpc:response:${requestId}`, { result });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    ipcRenderer.send(`panel-rpc:response:${requestId}`, { error: errorMessage });
  }
});

// Handle incoming RPC events from other panels
ipcRenderer.on("panel-rpc:event", (_event, rpcEvent: RpcEvent) => {
  const { fromPanelId, event, payload } = rpcEvent;

  const listeners = rpcEventListeners.get(event);
  if (listeners) {
    for (const listener of listeners) {
      try {
        listener(fromPanelId, payload);
      } catch (error) {
        console.error(`Error in RPC event listener for "${event}":`, error);
      }
    }
  }
});

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

  /**
   * Expose methods that can be called by parent or child panels.
   * Call this once during panel initialization to register your API.
   */
  rpc: {
    /**
     * Expose methods that other panels can call
     */
    expose: (methods: ExposedMethods): void => {
      exposedMethods = { ...exposedMethods, ...methods };
    },

    /**
     * Call a method on another panel (must be parent or direct child)
     */
    call: async (targetPanelId: string, method: string, ...args: unknown[]): Promise<unknown> => {
      return ipcRenderer.invoke("panel-rpc:call", panelId, targetPanelId, method, args);
    },

    /**
     * Emit an event to another panel (must be parent or direct child)
     */
    emit: (targetPanelId: string, event: string, payload: unknown): void => {
      void ipcRenderer.invoke("panel-rpc:emit", panelId, targetPanelId, event, payload);
    },

    /**
     * Subscribe to events from other panels
     */
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
};

contextBridge.exposeInMainWorld("__natstackPanelBridge", bridge);
