import type { EnvelopeRpcTransport, RpcEnvelope } from "../types.js";

export interface TransportRoute {
  name?: string;
  transport: EnvelopeRpcTransport;
  matches(envelope: RpcEnvelope): boolean;
}

export function composeTransports(routes: TransportRoute[], fallback: EnvelopeRpcTransport): EnvelopeRpcTransport {
  const all = [...routes.map((route) => route.transport), fallback];
  return {
    send(envelope) {
      const route = routes.find((candidate) => candidate.matches(envelope));
      return (route?.transport ?? fallback).send(envelope);
    },
    onMessage(handler) {
      const unsubs = all.map((transport) => transport.onMessage(handler));
      return () => {
        for (const unsub of unsubs) unsub();
      };
    },
    status() {
      return fallback.status?.() ?? "connected";
    },
    ready() {
      return fallback.ready?.() ?? Promise.resolve();
    },
    onStatusChange(handler) {
      return fallback.onStatusChange?.(handler) ?? (() => {});
    },
  };
}
