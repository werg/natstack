import { ipcRenderer } from "electron";
import { createHandlerRegistry, type RpcMessage, type RpcTransport } from "@natstack/rpc";

type EndpointKind = "panel" | "worker";

const normalizeEndpointId = (targetId: string): string => {
  if (targetId.startsWith("panel:")) return targetId.slice(6);
  if (targetId.startsWith("worker:")) return targetId.slice(7);
  return targetId;
};

export function createPanelTransport(panelId: string): RpcTransport {
  const registry = createHandlerRegistry({ context: "panel" });

  const sourceKinds = new Map<string, EndpointKind>();
  const panelPorts = new Map<string, MessagePort>();

  const pendingConnections = new Map<
    string,
    Array<{
      resolve: (info: { kind: EndpointKind; id: string }) => void;
      reject: (error: Error) => void;
      timeout?: NodeJS.Timeout;
    }>
  >();

  const setupPanelPort = (targetPanelId: string, port: MessagePort) => {
    sourceKinds.set(targetPanelId, "panel");
    port.onmessage = (event) => {
      const message = event.data as RpcMessage;
      if (!message || typeof message !== "object" || typeof message.type !== "string") {
        return;
      }
      registry.deliver(targetPanelId, message);
    };
    port.start();
  };

  ipcRenderer.on("panel-rpc:port", (event, { targetPanelId }: { targetPanelId: string }) => {
    const port = event.ports[0];
    if (!port) return;

    panelPorts.set(targetPanelId, port);
    setupPanelPort(targetPanelId, port);

    const pending = pendingConnections.get(targetPanelId);
    if (!pending) return;

    pending.forEach(({ resolve, timeout }) => {
      if (timeout) clearTimeout(timeout);
      resolve({ kind: "panel", id: targetPanelId });
    });
    pendingConnections.delete(targetPanelId);
  });

  ipcRenderer.on("worker-rpc:message", (_event, payload: { fromId: string; message: unknown }) => {
    const sourceId = normalizeEndpointId(payload.fromId);
    sourceKinds.set(sourceId, "worker");
    const message = payload.message as RpcMessage;
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      return;
    }
    registry.deliver(sourceId, message);
  });

  const connect = async (targetId: string): Promise<{ kind: EndpointKind; id: string }> => {
    const id = normalizeEndpointId(targetId);
    if (id === "main") {
      return { kind: "panel", id: "main" };
    }

    const kind = sourceKinds.get(id);
    if (kind === "panel" && panelPorts.has(id)) return { kind: "panel", id };
    if (kind === "worker") return { kind: "worker", id };

    const existingPending = pendingConnections.get(id);
    if (existingPending) {
      return new Promise((resolve, reject) => {
        existingPending.push({ resolve, reject });
      });
    }

    return new Promise((resolve, reject) => {
      const pending = [{ resolve, reject }] as Array<{
        resolve: (info: { kind: EndpointKind; id: string }) => void;
        reject: (error: Error) => void;
        timeout?: NodeJS.Timeout;
      }>;
      pendingConnections.set(id, pending);

      const timeout = setTimeout(() => {
        const pending = pendingConnections.get(id);
        pending?.forEach(({ reject }) => {
          reject(new Error(`Timed out establishing RPC connection to ${id}`));
        });
        pendingConnections.delete(id);
      }, 60000);
      pending.forEach((entry) => (entry.timeout = timeout));

      ipcRenderer
        .invoke("panel-rpc:connect", panelId, id)
        .then((result: { isWorker: boolean; workerId?: string }) => {
          if (result.isWorker) {
            clearTimeout(timeout);
            sourceKinds.set(id, "worker");
            const pending = pendingConnections.get(id);
            if (pending) {
              pending.forEach(({ resolve, timeout: t }) => {
                if (t) clearTimeout(t);
                resolve({ kind: "worker", id });
              });
              pendingConnections.delete(id);
            }
            return;
          }
          // For panels, we wait for "panel-rpc:port" to resolve the promise.
        })
        .catch((error: unknown) => {
          clearTimeout(timeout);
          const err = error instanceof Error ? error : new Error(String(error));
          const pending = pendingConnections.get(id);
          if (pending) {
            pending.forEach(({ reject }) => reject(err));
            pendingConnections.delete(id);
          }
        });
    });
  };

  const sendToWorker = (workerId: string, message: RpcMessage) => {
    ipcRenderer.send("panel-rpc:to-worker", panelId, workerId, message);
  };

  const sendToPanel = async (targetPanelId: string, message: RpcMessage) => {
    const port = panelPorts.get(targetPanelId);
    if (port) {
      port.postMessage(message);
      return;
    }
    await connect(targetPanelId);
    const connectedPort = panelPorts.get(targetPanelId);
    if (!connectedPort) {
      throw new Error(`RPC port missing for panel ${targetPanelId}`);
    }
    connectedPort.postMessage(message);
  };

  return {
    async send(targetId: string, message: RpcMessage): Promise<void> {
      const normalized = normalizeEndpointId(targetId);

      if (normalized === "main") {
        if (message.type !== "request") {
          throw new Error("Only RPC requests to main are supported");
        }
        try {
          const response = (await ipcRenderer.invoke("rpc:call", panelId, message)) as RpcMessage;
          registry.deliver("main", response);
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          registry.deliver("main", { type: "response", requestId: message.requestId, error: err });
        }
        return;
      }

      const info = await connect(normalized);
      if (info.kind === "worker") {
        sendToWorker(info.id, message);
        return;
      }
      await sendToPanel(info.id, message);
    },

    onMessage(sourceId: string, handler: (message: RpcMessage) => void): () => void {
      const id = normalizeEndpointId(sourceId);
      return registry.onMessage(id, handler);
    },

    onAnyMessage(handler: (sourceId: string, message: RpcMessage) => void): () => void {
      return registry.onAnyMessage(handler);
    },
  };
}
