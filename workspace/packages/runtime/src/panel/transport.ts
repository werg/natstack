import {
  createHandlerRegistry,
  ELECTRON_LOCAL_SERVICE_NAMES,
  type RpcMessage,
  type RpcRequest,
  type RpcTransport,
} from "@natstack/rpc";
import { createRecoveryCoordinator } from "@natstack/shared/shell/recoveryCoordinator";
import type { RecoveryCoordinator, RecoveryKind } from "@natstack/shared/shell/recoveryCoordinator";

type NatstackTransportBridge = {
  send: (targetId: string, message: unknown) => void | Promise<void>;
  onMessage: (handler: (fromId: string, message: unknown) => void) => () => void;
  onRecovery?: (kind: RecoveryKind, handler: () => void | Promise<void>) => () => void;
};

export const recoveryCoordinator: RecoveryCoordinator = createRecoveryCoordinator();

function getTransportBridge(): NatstackTransportBridge {
  const bridge = (globalThis as any).__natstackTransport as NatstackTransportBridge | undefined;
  if (!bridge?.send || !bridge?.onMessage) {
    throw new Error("NatStack transport bridge is not available (missing __natstackTransport)");
  }
  return bridge;
}

/**
 * Services that panels should call through Electron main. `events` is local
 * for the shell, but panel event subscriptions must stay on the panel WS
 * connection so EventService has a delivery session for that caller.
 */
const electronLocalServices: ReadonlySet<string> = new Set(
  ELECTRON_LOCAL_SERVICE_NAMES.filter((service) => service !== "events")
);

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

  bridge.onRecovery?.("resubscribe", () => recoveryCoordinator.run("resubscribe"));
  bridge.onRecovery?.("cold-recover", () => recoveryCoordinator.run("cold-recover"));

  bridge.onMessage((fromId, message) => {
    const msg = message as RpcMessage;
    if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
      return;
    }
    registry.deliver(fromId, msg);
  });

  return {
    async send(targetId: string, message: RpcMessage): Promise<void> {
      // Route RPC requests to "main": Electron-local services go via IPC
      // through __natstackShell.serviceCall. Everything else goes to the
      // server so userland/workerd services do not need static routing edits.
      if (targetId === "main" && message.type === "request") {
        const request = message as RpcRequest;
        const dotIdx = request.method.indexOf(".");
        const service = dotIdx > 0 ? request.method.slice(0, dotIdx) : "";

        if (electronLocalServices.has(service)) {
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
                `and requires the Electron desktop app. It is not available ` +
                `in this context.`,
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

      await bridge.send(targetId, message);
    },

    onMessage(sourceId: string, handler: (message: RpcMessage) => void): () => void {
      return registry.onMessage(sourceId, handler);
    },

    onAnyMessage(handler: (sourceId: string, message: RpcMessage) => void): () => void {
      return registry.onAnyMessage(handler);
    },
  };
}
