import { createHandlerRegistry, type RpcMessage, type RpcTransport } from "@natstack/rpc";

declare const __rpcSend: (targetId: string, message: unknown) => void;
declare function __rpcReceive(fromId: string, message: unknown): void;

export function createWorkerTransport(): RpcTransport {
  const registry = createHandlerRegistry({ context: "worker" });

  (globalThis as { __rpcReceive?: typeof __rpcReceive }).__rpcReceive = (fromId, message) => {
    const msg = message as RpcMessage;
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      return;
    }
    registry.deliver(fromId, msg);
  };

  return {
    async send(targetId: string, message: RpcMessage): Promise<void> {
      __rpcSend(targetId, message);
    },

    onMessage(sourceId: string, handler: (message: RpcMessage) => void): () => void {
      return registry.onMessage(sourceId, handler);
    },

    onAnyMessage(handler: (sourceId: string, message: RpcMessage) => void): () => void {
      return registry.onAnyMessage(handler);
    },
  };
}
