import { ipcRenderer } from "electron";
import type { RpcMessage, RpcRequest, RpcResponse } from "@natstack/rpc";
import type {
  StreamTextChunkEvent,
  StreamTextEndEvent,
  ThemeAppearance,
  ToolExecutionResult as IPCToolExecutionResult,
} from "../shared/ipc/types.js";

type AnyMessageHandler = (fromId: string, message: unknown) => void;

type TransportBridge = {
  send: (targetId: string, message: unknown) => Promise<void>;
  onMessage: (handler: AnyMessageHandler) => () => void;
};

const normalizeEndpointId = (targetId: string): string => {
  // Strip "panel:" or "worker:" prefix if present (workers now use same transport as panels)
  if (targetId.startsWith("panel:")) return targetId.slice(6);
  if (targetId.startsWith("worker:")) return targetId.slice(7);
  return targetId;
};

/**
 * Create a transport bridge for RPC communication.
 * Used by both panels and workers to communicate with main process and other views.
 */
export function createTransportBridge(viewId: string): TransportBridge {
  const listeners = new Set<AnyMessageHandler>();
  const bufferedMessages: Array<{ fromId: string; message: RpcMessage }> = [];
  let transportReady = false;
  let flushScheduled = false;

  const panelPorts = new Map<string, MessagePort>();

  const pendingConnections = new Map<
    string,
    Array<{
      resolve: (id: string) => void;
      reject: (error: Error) => void;
      timeout?: NodeJS.Timeout;
    }>
  >();

  const pendingToolExecPorts = new Map<string, MessagePort>();

  const deliver = (fromId: string, message: RpcMessage) => {
    if (!transportReady) {
      bufferedMessages.push({ fromId, message });
      // Hard cap to avoid unbounded growth if something goes wrong.
      if (bufferedMessages.length > 500) bufferedMessages.shift();
      return;
    }
    for (const listener of listeners) {
      try {
        listener(fromId, message);
      } catch (error) {
        console.error("Error in panel transport message handler:", error);
      }
    }
  };

  const setupPanelPort = (targetPanelId: string, port: MessagePort) => {
    port.onmessage = (event) => {
      const message = event.data as RpcMessage;
      if (!message || typeof message !== "object" || typeof (message as { type?: unknown }).type !== "string") {
        return;
      }
      deliver(targetPanelId, message);
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
      resolve(targetPanelId);
    });
    pendingConnections.delete(targetPanelId);
  });

  ipcRenderer.on("panel:event", (_event, payload: unknown) => {
    const msg = payload as {
      panelId?: string;
      type?: string;
      childId?: string;
      theme?: ThemeAppearance;
      url?: string;
      error?: string;
    };
    if (msg.panelId !== viewId) return;

    if (msg.type === "child-creation-error") {
      deliver("main", {
        type: "event",
        fromId: "main",
        event: "runtime:child-creation-error",
        payload: { url: msg.url, error: msg.error },
      });
      return;
    }

    if (msg.type === "focus") {
      deliver("main", { type: "event", fromId: "main", event: "runtime:focus", payload: null });
      return;
    }

    if (msg.type === "theme") {
      deliver("main", { type: "event", fromId: "main", event: "runtime:theme", payload: msg.theme });
      return;
    }
  });

  ipcRenderer.on("ai:stream-text-chunk", (_event, payload: StreamTextChunkEvent) => {
    if (payload.panelId !== viewId) return;
    deliver("main", {
      type: "event",
      fromId: "main",
      event: "ai:stream-text-chunk",
      payload: { streamId: payload.streamId, chunk: payload.chunk },
    });
  });

  ipcRenderer.on("ai:stream-text-end", (_event, payload: StreamTextEndEvent) => {
    if (payload.panelId !== viewId) return;
    deliver("main", {
      type: "event",
      fromId: "main",
      event: "ai:stream-text-end",
      payload: { streamId: payload.streamId },
    });
  });

  ipcRenderer.on(
    "panel:execute-tool",
    (event: Electron.IpcRendererEvent, message: [string, string, Record<string, unknown>]) => {
      const port = event.ports[0];
      if (!port) return;

      const [streamId, toolName, args] = message;
      const requestId = crypto.randomUUID();
      pendingToolExecPorts.set(requestId, port);

      const rpcRequest: RpcRequest = {
        type: "request",
        requestId,
        fromId: "main",
        method: "ai.executeTool",
        args: [streamId, toolName, args],
      };

      deliver("main", rpcRequest);
    }
  );

  const connect = async (targetId: string): Promise<string> => {
    const id = normalizeEndpointId(targetId);
    if (id === "main") return "main";

    // Already have a port for this target
    if (panelPorts.has(id)) return id;

    // Check if already waiting for this connection
    const existingPending = pendingConnections.get(id);
    if (existingPending) {
      return new Promise((resolve, reject) => {
        existingPending.push({ resolve, reject });
      });
    }

    // Start new connection request
    return new Promise((resolve, reject) => {
      const pending = [{ resolve, reject }] as Array<{
        resolve: (id: string) => void;
        reject: (error: Error) => void;
        timeout?: NodeJS.Timeout;
      }>;
      pendingConnections.set(id, pending);

      const timeout = setTimeout(() => {
        const p = pendingConnections.get(id);
        p?.forEach(({ reject }) => reject(new Error(`Timed out establishing RPC connection to ${id}`)));
        pendingConnections.delete(id);
      }, 60000);
      pending.forEach((entry) => (entry.timeout = timeout));

      // Request connection - port will arrive via panel-rpc:port handler
      ipcRenderer.invoke("panel-rpc:connect", viewId, id).catch((error: unknown) => {
        clearTimeout(timeout);
        const err = error instanceof Error ? error : new Error(String(error));
        const p = pendingConnections.get(id);
        if (p) {
          p.forEach(({ reject }) => reject(err));
          pendingConnections.delete(id);
        }
      });
    });
  };

  const sendToPanel = async (targetPanelId: string, message: RpcMessage) => {
    const port = panelPorts.get(targetPanelId);
    if (port) {
      port.postMessage(message);
      return;
    }
    await connect(targetPanelId);
    const connectedPort = panelPorts.get(targetPanelId);
    if (!connectedPort) throw new Error(`RPC port missing for panel ${targetPanelId}`);
    connectedPort.postMessage(message);
  };

  const send: TransportBridge["send"] = async (targetId, message) => {
    const rpcMessage = message as RpcMessage;
    if (!rpcMessage || typeof rpcMessage !== "object" || typeof (rpcMessage as { type?: unknown }).type !== "string") {
      throw new Error("Invalid RPC message");
    }
    const normalized = normalizeEndpointId(targetId);

    if (normalized === "main") {
      if (rpcMessage.type === "request") {
        try {
          const response = (await ipcRenderer.invoke("rpc:call", viewId, rpcMessage)) as RpcResponse;
          deliver("main", response);
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          deliver("main", { type: "response", requestId: rpcMessage.requestId, error: err });
        }
        return;
      }

      if (rpcMessage.type === "response") {
        const port = pendingToolExecPorts.get(rpcMessage.requestId);
        if (!port) return;
        pendingToolExecPorts.delete(rpcMessage.requestId);

        // Handle RPC-level errors (e.g., method not found, RPC timeout)
        if ("error" in rpcMessage) {
          port.postMessage({ content: [{ type: "text", text: rpcMessage.error }], isError: true });
          port.close();
          return;
        }

        // Validate that we got a proper tool execution result
        const result = rpcMessage.result as IPCToolExecutionResult | null | undefined;
        if (!result || !Array.isArray(result.content)) {
          port.postMessage({
            content: [{ type: "text", text: "Tool execution failed: no valid response from panel" }],
            isError: true,
          });
          port.close();
          return;
        }

        port.postMessage(result);
        port.close();
        return;
      }

      return;
    }

    await sendToPanel(normalized, rpcMessage);
  };

  return {
    send,
    onMessage(handler) {
      listeners.add(handler);
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(() => {
          transportReady = true;
          for (const buffered of bufferedMessages) {
            for (const listener of listeners) {
              try {
                listener(buffered.fromId, buffered.message);
              } catch (error) {
                console.error("Error delivering buffered panel transport message:", error);
              }
            }
          }
          bufferedMessages.length = 0;
        });
      }
      return () => listeners.delete(handler);
    },
  };
}
