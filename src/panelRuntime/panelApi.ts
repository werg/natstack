import type { ComponentType, ReactNode } from "react";

type PanelBridgeEvent = "child-removed" | "focus";

type PanelThemeAppearance = "light" | "dark";

export interface PanelTheme {
  appearance: PanelThemeAppearance;
}

interface PanelBridge {
  panelId: string;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(event: PanelBridgeEvent, listener: (payload?: unknown) => void): () => void;
  getTheme(): PanelThemeAppearance;
  onThemeChange(listener: (theme: PanelThemeAppearance) => void): () => void;
  getEnv(): Promise<Record<string, string>>;
  getInfo(): Promise<{ partition?: string }>;
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

export interface CreateChildOptions {
  env?: Record<string, string>;
  partition?: string;
}

const panelAPI = {
  getId(): string {
    return bridge.panelId;
  },

  async createChild(
    path: string,
    options?: Record<string, string> | CreateChildOptions
  ): AsyncResult<string> {
    // Support both old signature (env as second param) and new signature (options object)
    let env: Record<string, string> | undefined;
    let partition: string | undefined;

    if (options) {
      // Check if it's the new options object (has 'env' or 'partition' keys) or old env object
      if ("env" in options || "partition" in options) {
        env = (options as CreateChildOptions).env;
        partition = (options as CreateChildOptions).partition;
      } else {
        // Legacy: treat as env object
        env = options as Record<string, string>;
      }
    }

    return bridge.invoke("panel:create-child", path, env, partition) as Promise<string>;
  },

  async removeChild(childId: string): AsyncResult<void> {
    return bridge.invoke("panel:remove-child", childId) as Promise<void>;
  },

  async setTitle(title: string): AsyncResult<void> {
    return bridge.invoke("panel:set-title", title) as Promise<void>;
  },

  async close(): AsyncResult<void> {
    return bridge.invoke("panel:close") as Promise<void>;
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

  async getInfo(): AsyncResult<{ partition?: string }> {
    return bridge.getInfo();
  },

  async getPartition(): AsyncResult<string | undefined> {
    const info = await bridge.getInfo();
    return info.partition;
  },
};

export type PanelAPI = typeof panelAPI;

export default panelAPI;

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
