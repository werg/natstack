import type { RpcMessage } from "./types.js";

type AnyHandler = (sourceId: string, message: RpcMessage) => void;
type SourceHandler = (message: RpcMessage) => void;

export function createHandlerRegistry(options?: { context?: string }) {
  const anyHandlers = new Set<AnyHandler>();
  const sourceHandlers = new Map<string, Set<SourceHandler>>();

  const contextPrefix = options?.context ? `${options.context} ` : "";

  const deliver = (sourceId: string, message: RpcMessage) => {
    for (const handler of anyHandlers) {
      try {
        handler(sourceId, message);
      } catch (error) {
        console.error(`Error in ${contextPrefix}RPC onAnyMessage handler:`, error);
      }
    }

    const handlers = sourceHandlers.get(sourceId);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(message);
      } catch (error) {
        console.error(`Error in ${contextPrefix}RPC onMessage handler:`, error);
      }
    }
  };

  const onMessage = (sourceId: string, handler: (message: RpcMessage) => void): (() => void) => {
    let handlers = sourceHandlers.get(sourceId);
    if (!handlers) {
      handlers = new Set();
      sourceHandlers.set(sourceId, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        sourceHandlers.delete(sourceId);
      }
    };
  };

  const onAnyMessage = (handler: AnyHandler): (() => void) => {
    anyHandlers.add(handler);
    return () => {
      anyHandlers.delete(handler);
    };
  };

  return { deliver, onMessage, onAnyMessage };
}

