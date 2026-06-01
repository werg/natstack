import type { EnvelopeRpcTransport, RpcEnvelope } from "../types.js";

type Handler = (envelope: RpcEnvelope) => void;

export interface InProcessNetwork {
  register(id: string, handler: Handler): () => void;
  send(envelope: RpcEnvelope): Promise<void>;
}

export function createInProcessNetwork(): InProcessNetwork {
  const handlers = new Map<string, Set<Handler>>();
  return {
    register(id, handler) {
      let set = handlers.get(id);
      if (!set) {
        set = new Set();
        handlers.set(id, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
        if (set?.size === 0) handlers.delete(id);
      };
    },
    async send(envelope) {
      const set = handlers.get(envelope.target);
      if (!set?.size) throw new Error(`No in-process RPC target registered for "${envelope.target}"`);
      queueMicrotask(() => {
        for (const handler of set) handler(envelope);
      });
    },
  };
}

export function inProcessTransport(selfId: string, network: InProcessNetwork): EnvelopeRpcTransport {
  const localHandlers = new Set<Handler>();
  const unregister = network.register(selfId, (envelope) => {
    for (const handler of localHandlers) handler(envelope);
  });
  return {
    send(envelope) {
      return network.send(envelope);
    },
    onMessage(handler) {
      localHandlers.add(handler);
      return () => {
        localHandlers.delete(handler);
        if (localHandlers.size === 0) unregister();
      };
    },
    status: () => "connected",
    ready: () => Promise.resolve(),
    onStatusChange: () => () => {},
  };
}
