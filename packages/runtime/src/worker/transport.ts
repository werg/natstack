import { createHandlerRegistry, type RpcMessage, type RpcTransport } from "@natstack/rpc";

// Access globals via globalThis to support VM sandbox environments
// where globals are set on the context object
const g = globalThis as unknown as {
  __rpcSend?: (targetId: string, message: unknown) => void;
  __rpcReceive?: (fromId: string, message: unknown) => void;
};

export function createWorkerTransport(): RpcTransport {
  const registry = createHandlerRegistry({ context: "worker" });

  g.__rpcReceive = (fromId, message) => {
    const msg = message as RpcMessage;
    if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
      return;
    }
    registry.deliver(fromId, msg);
  };

  return {
    async send(targetId: string, message: RpcMessage): Promise<void> {
      if (!g.__rpcSend) {
        throw new Error("Worker RPC transport not initialized: __rpcSend is undefined");
      }
      g.__rpcSend(targetId, message);
    },

    onMessage(sourceId: string, handler: (message: RpcMessage) => void): () => void {
      return registry.onMessage(sourceId, handler);
    },

    onAnyMessage(handler: (sourceId: string, message: RpcMessage) => void): () => void {
      return registry.onAnyMessage(handler);
    },
  };
}

