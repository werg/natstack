import { contextBridge, ipcRenderer } from "electron";

type PanelEventName = "child-removed" | "focus";

type PanelTheme = "light" | "dark";

type PanelEventMessage =
  | { panelId: string; type: "child-removed"; childId: string }
  | { panelId: string; type: "focus" }
  | { panelId: string; type: "theme"; theme: PanelTheme };

const urlParams = new URLSearchParams(window.location.search);
const panelId = urlParams.get("panelId");

if (!panelId) {
  throw new Error("Panel ID missing from panel URL");
}

void ipcRenderer.invoke("panel:register-view", panelId).catch((error) => {
  console.error("Failed to register panel view", error);
});

const eventListeners = new Map<PanelEventName, Set<(payload: any) => void>>();
let currentTheme: PanelTheme = "light";
const themeListeners = new Set<(theme: PanelTheme) => void>();

const updateTheme = (theme: PanelTheme) => {
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

const bridge = {
  panelId,
  invoke: async (channel: string, ...args: unknown[]) => {
    return ipcRenderer.invoke(channel, panelId, ...args);
  },
  on: (event: PanelEventName, listener: (payload: any) => void) => {
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
  getTheme: (): PanelTheme => currentTheme,
  onThemeChange: (listener: (theme: PanelTheme) => void) => {
    themeListeners.add(listener);
    return () => {
      themeListeners.delete(listener);
    };
  },
};

contextBridge.exposeInMainWorld("__natstackPanelBridge", bridge);
