/**
 * Parent Port RPC Transport
 *
 * Thin wrapper around process.parentPort that implements the RpcTransport interface.
 * Used by agents running in Electron's utilityProcess to communicate with the host.
 */

import type { RpcTransport, RpcMessage } from "@natstack/rpc";

/**
 * Message envelope for RPC over parentPort.
 * Wraps RPC messages with source/target routing information.
 */
export interface ParentPortEnvelope {
  /** Target endpoint ID (e.g., "main" for host process) */
  targetId: string;
  /** Source endpoint ID (e.g., "agent:my-agent-id") */
  sourceId?: string;
  /** The RPC message payload */
  message: RpcMessage;
}

/**
 * Type guard for ParentPortEnvelope.
 */
export function isParentPortEnvelope(msg: unknown): msg is ParentPortEnvelope {
  if (typeof msg !== "object" || msg === null) return false;
  const envelope = msg as Record<string, unknown>;
  return (
    typeof envelope["targetId"] === "string" &&
    "message" in envelope &&
    typeof envelope["message"] === "object" &&
    envelope["message"] !== null
  );
}

/**
 * Type for Electron's parentPort (from utilityProcess).
 * We define our own type to avoid depending on Electron types at runtime.
 */
export interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): this;
  removeListener(event: "message", listener: (message: unknown) => void): this;
  ref?(): void;
  unref?(): void;
}

/**
 * Create an RPC transport that communicates via process.parentPort.
 *
 * @param parentPort - The parentPort from utilityProcess
 * @param selfId - This endpoint's ID (e.g., "agent:my-agent-id")
 * @returns RpcTransport implementation
 */
export function createParentPortTransport(
  parentPort: ParentPort,
  selfId: string
): RpcTransport {
  const messageHandlers = new Map<string, Set<(message: RpcMessage) => void>>();
  const anyMessageHandlers = new Set<(sourceId: string, message: RpcMessage) => void>();

  // Set up global message listener
  const globalListener = (msg: unknown) => {
    if (!isParentPortEnvelope(msg)) return;

    // Only process messages targeted at us or broadcasts
    const envelope = msg;
    if (envelope.targetId !== selfId && envelope.targetId !== "*") return;

    const sourceId = envelope.sourceId ?? "main";
    const message = envelope.message;

    // Notify specific handlers for this source
    const handlers = messageHandlers.get(sourceId);
    if (handlers) {
      for (const handler of handlers) {
        handler(message);
      }
    }

    // Notify handlers listening to any source
    for (const handler of anyMessageHandlers) {
      handler(sourceId, message);
    }
  };

  parentPort.on("message", globalListener);

  return {
    async send(targetId: string, message: RpcMessage): Promise<void> {
      const envelope: ParentPortEnvelope = {
        targetId,
        sourceId: selfId,
        message,
      };
      parentPort.postMessage(envelope);
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
