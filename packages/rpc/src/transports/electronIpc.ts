import type { EnvelopeRpcTransport, RpcEnvelope, RpcResponse } from "../types.js";
import { ELECTRON_LOCAL_SERVICE_NAMES } from "../types.js";

export interface ElectronIpcBridge {
  serviceCall(method: string, ...args: unknown[]): Promise<unknown>;
}

export interface ElectronIpcTransportConfig {
  bridge: ElectronIpcBridge;
  serviceNames?: Iterable<string>;
}

export function electronIpcTransport(config: ElectronIpcTransportConfig): EnvelopeRpcTransport & {
  matches(envelope: RpcEnvelope): boolean;
} {
  const serviceNames = new Set(config.serviceNames ?? ELECTRON_LOCAL_SERVICE_NAMES);
  const listeners = new Set<(envelope: RpcEnvelope) => void>();

  function serviceName(envelope: RpcEnvelope): string | null {
    const message = envelope.message;
    if (envelope.target !== "main" || message.type !== "request") return null;
    const dotIdx = message.method.indexOf(".");
    return dotIdx > 0 ? message.method.slice(0, dotIdx) : null;
  }

  return {
    matches(envelope): boolean {
      const name = serviceName(envelope);
      return !!name && serviceNames.has(name);
    },
    async send(envelope): Promise<void> {
      const message = envelope.message;
      if (message.type !== "request") return;
      const responseBase = {
        from: "main",
        target: envelope.from,
        delivery: {
          caller: { callerId: "main", callerKind: "shell" as const },
        },
        provenance: envelope.provenance,
      };
      try {
        const result = await config.bridge.serviceCall(message.method, ...(message.args ?? []));
        const response: RpcResponse = { type: "response", requestId: message.requestId, result };
        for (const listener of listeners) listener({ ...responseBase, message: response });
      } catch (error) {
        const response: RpcResponse = {
          type: "response",
          requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error),
        };
        for (const listener of listeners) listener({ ...responseBase, message: response });
      }
    },
    onMessage(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    status: () => "connected",
    ready: () => Promise.resolve(),
    onStatusChange: () => () => {},
  };
}
