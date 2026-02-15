import type { RpcBridge } from "@natstack/rpc";

/** Services that run on the server process (backend compute) */
const SERVER_SERVICES = new Set(["ai", "db", "typecheck", "agentSettings", "build", "git"]);

type EventListener = (fromId: string, payload: unknown) => void;

/**
 * Create a routing bridge that dispatches calls by service name:
 * - Server services (ai, db, typecheck, agentSettings, build, git) → serverBridge
 * - Everything else (bridge, browser, events, panel-to-panel) → electronBridge
 */
export function createRoutingBridge(electronBridge: RpcBridge, serverBridge: RpcBridge): RpcBridge {
  return {
    get selfId() { return electronBridge.selfId; },

    call<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T> {
      // Only route to server for service calls to "main" — panel-to-panel RPC
      // (targetId is a panel/worker ID) always goes through Electron.
      const service = method.split(".")[0]!;
      const bridge = (targetId === "main" && SERVER_SERVICES.has(service))
        ? serverBridge
        : electronBridge;
      return bridge.call<T>(targetId, method, ...args);
    },

    emit(targetId: string, event: string, payload: unknown): Promise<void> {
      // Events always via Electron (panel-tree, theme changes come from Electron)
      return electronBridge.emit(targetId, event, payload);
    },

    onEvent(event: string, listener: EventListener): () => void {
      // Listen on both bridges: application events (panel-tree, theme) come
      // from Electron, but transport-level events (runtime:connection-error)
      // are emitted by wsTransport on whichever connection fails.
      const wrapWithSource = (source: "electron" | "server"): EventListener =>
        (fromId: string, payload: unknown) => {
          if (event === "runtime:connection-error" && payload && typeof payload === "object") {
            listener(fromId, { ...(payload as Record<string, unknown>), source });
          } else {
            listener(fromId, payload);
          }
        };
      const unsubElectron = electronBridge.onEvent(event, wrapWithSource("electron"));
      const unsubServer = serverBridge.onEvent(event, wrapWithSource("server"));
      return () => { unsubElectron(); unsubServer(); };
    },

    exposeMethod<TArgs extends unknown[], TReturn>(
      method: string,
      handler: (...args: TArgs) => TReturn | Promise<TReturn>
    ): void {
      // Expose on both bridges:
      // - Electron: parent-child RPC, panel-to-panel calls
      // - Server: tool execution requests (ws:tool-exec → synthetic ai.executeTool)
      electronBridge.exposeMethod(method, handler);
      serverBridge.exposeMethod(method, handler);
    },
  };
}
