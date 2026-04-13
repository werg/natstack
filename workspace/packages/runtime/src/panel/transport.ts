import {
  createHandlerRegistry,
  SERVER_SERVICE_NAMES,
  type RpcMessage,
  type RpcRequest,
  type RpcTransport,
} from "@natstack/rpc";

type NatstackTransportBridge = {
  send: (targetId: string, message: unknown) => void | Promise<void>;
  onMessage: (handler: (fromId: string, message: unknown) => void) => () => void;
};

function getTransportBridge(): NatstackTransportBridge {
  const bridge = (globalThis as any).__natstackTransport as NatstackTransportBridge | undefined;
  if (!bridge?.send || !bridge?.onMessage) {
    throw new Error("NatStack transport bridge is not available (missing __natstackTransport)");
  }
  return bridge;
}

const normalizeEndpointId = (id: string): string => {
  if (id.startsWith("panel:")) return id.slice(6);
  return id;
};

/** Services that live on the server. Everything else is Electron-local. */
const serverServices: ReadonlySet<string> = new Set(SERVER_SERVICE_NAMES);

/**
 * Resolve the Electron shell bridge's serviceCall method, if available.
 * Returns undefined when running outside Electron (mobile, headless).
 */
function getElectronServiceCall(): ((method: string, ...args: unknown[]) => Promise<unknown>) | undefined {
  const shell = (globalThis as any).__natstackShell ?? (globalThis as any).__natstackElectron;
  return typeof shell?.serviceCall === "function" ? shell.serviceCall : undefined;
}

export function createPanelTransport(): RpcTransport {
  const bridge = getTransportBridge();
  const registry = createHandlerRegistry({ context: "panel" });
  const electronServiceCall = getElectronServiceCall();

  bridge.onMessage((fromId, message) => {
    const sourceId = normalizeEndpointId(fromId);
    const msg = message as RpcMessage;
    if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
      return;
    }
    registry.deliver(sourceId, msg);
  });

  return {
    async send(targetId: string, message: RpcMessage): Promise<void> {
      // Route RPC requests to "main": server services go over WebSocket,
      // Electron-local services go via IPC through __natstackShell.serviceCall.
      // This mirrors the shell's IpcDispatcher routing (SERVER_SERVICE_NAMES).
      if (targetId === "main" && message.type === "request") {
        const request = message as RpcRequest;
        const dotIdx = request.method.indexOf(".");
        const service = dotIdx > 0 ? request.method.slice(0, dotIdx) : "";

        if (!serverServices.has(service)) {
          if (!electronServiceCall) {
            // Electron-local service called from a non-Electron context
            // (mobile, headless). Fail fast with a clear message instead
            // of sending to the server where it'd fail with a confusing
            // "Unknown service" error.
            registry.deliver("main", {
              type: "response",
              requestId: request.requestId,
              error:
                `Service '${service}' is an Electron-local service ` +
                `(not in SERVER_SERVICE_NAMES) and requires the Electron ` +
                `desktop app. It is not available in this context.`,
            });
            return;
          }

          // Dispatch via Electron IPC and deliver a synthetic response
          void (async () => {
            try {
              const result = await electronServiceCall(
                request.method,
                ...(request.args ?? []),
              );
              registry.deliver("main", {
                type: "response",
                requestId: request.requestId,
                result,
              });
            } catch (err) {
              registry.deliver("main", {
                type: "response",
                requestId: request.requestId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          })();
          return;
        }
      }

      await bridge.send(normalizeEndpointId(targetId), message);
    },

    onMessage(sourceId: string, handler: (message: RpcMessage) => void): () => void {
      return registry.onMessage(normalizeEndpointId(sourceId), handler);
    },

    onAnyMessage(handler: (sourceId: string, message: RpcMessage) => void): () => void {
      return registry.onAnyMessage(handler);
    },
  };
}
