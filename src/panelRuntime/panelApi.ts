type PanelBridgeEvent = "child-removed" | "focus";

interface PanelBridge {
  panelId: string;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(event: PanelBridgeEvent, listener: (payload?: unknown) => void): () => void;
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

const panelAPI = {
  getId(): string {
    return getBridge().panelId;
  },

  async createChild(path: string): AsyncResult<string> {
    return getBridge().invoke("panel:create-child", path) as Promise<string>;
  },

  async removeChild(childId: string): AsyncResult<void> {
    return getBridge().invoke("panel:remove-child", childId) as Promise<void>;
  },

  async setTitle(title: string): AsyncResult<void> {
    return getBridge().invoke("panel:set-title", title) as Promise<void>;
  },

  async close(): AsyncResult<void> {
    return getBridge().invoke("panel:close") as Promise<void>;
  },

  onChildRemoved(callback: (childId: string) => void): () => void {
    return getBridge().on("child-removed", (payload) => {
      if (typeof payload === "string") {
        callback(payload);
      }
    });
  },

  onFocus(callback: () => void): () => void {
    return getBridge().on("focus", () => callback());
  },
};

export type PanelAPI = typeof panelAPI;

export default panelAPI;
