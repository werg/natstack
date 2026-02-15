/**
 * IPC Transport
 *
 * RPC transport implementation that works with AgentIpcChannel.
 * Same ParentPortEnvelope routing logic as the old createParentPortTransport,
 * but the {data:...} unwrapping is handled by the channel layer.
 */

import type { RpcTransport, RpcMessage } from "@natstack/rpc";
import { isParentPortEnvelope, type ParentPortEnvelope } from "./transport.js";
import type { AgentIpcChannel } from "./ipc-channel.js";

/**
 * Create an RPC transport that communicates via an AgentIpcChannel.
 *
 * @param ipc - The IPC channel (Electron parentPort or Node.js fork)
 * @param selfId - This endpoint's ID (e.g., "agent:my-agent-id")
 * @returns RpcTransport implementation
 */
export function createIpcTransport(
  ipc: AgentIpcChannel,
  selfId: string
): RpcTransport {
  const messageHandlers = new Map<string, Set<(message: RpcMessage) => void>>();
  const anyMessageHandlers = new Set<(sourceId: string, message: RpcMessage) => void>();

  const globalListener = (msg: unknown) => {
    // No {data:...} unwrapping needed — handled by AgentIpcChannel
    if (!isParentPortEnvelope(msg)) return;

    const envelope = msg;
    if (envelope.targetId !== selfId && envelope.targetId !== "*") return;

    const sourceId = envelope.sourceId ?? "main";
    const message = envelope.message;

    const handlers = messageHandlers.get(sourceId);
    if (handlers) {
      for (const handler of handlers) {
        handler(message);
      }
    }

    for (const handler of anyMessageHandlers) {
      handler(sourceId, message);
    }
  };

  ipc.on("message", globalListener);

  return {
    async send(targetId: string, message: RpcMessage): Promise<void> {
      const envelope: ParentPortEnvelope = {
        targetId,
        sourceId: selfId,
        message,
      };
      ipc.postMessage(envelope);
    },

    onMessage(sourceId: string, handler: (message: RpcMessage) => void): () => void {
      let handlers = messageHandlers.get(sourceId);
      if (!handlers) {
        handlers = new Set();
        messageHandlers.set(sourceId, handlers);
      }
      handlers.add(handler);

      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) {
          messageHandlers.delete(sourceId);
        }
      };
    },

    onAnyMessage(handler: (sourceId: string, message: RpcMessage) => void): () => void {
      anyMessageHandlers.add(handler);
      return () => {
        anyMessageHandlers.delete(handler);
      };
    },
  };
}
