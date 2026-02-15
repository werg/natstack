import { createHandlerRegistry, type RpcMessage, type RpcTransport } from "@natstack/rpc";

type NatstackTransportBridge = {
  send: (targetId: string, message: unknown) => void | Promise<void>;
  onMessage: (handler: (fromId: string, message: unknown) => void) => () => void;
};

function getTransportBridge(): NatstackTransportBridge {
  const bridge = (globalThis as any).__natstackTransport as NatstackTransportBridge | undefined;
  if (!bridge?.send || !bridge?.onMessage) {
    throw new Error("NatStack transport bridge is not available (missing __natstackTransport)");
  }
  return bridge;
}

const normalizeEndpointId = (id: string): string => {
  if (id.startsWith("panel:")) return id.slice(6);
  return id;
};

export function createPanelTransport(): RpcTransport {
  const bridge = getTransportBridge();
  const registry = createHandlerRegistry({ context: "panel" });

  bridge.onMessage((fromId, message) => {
    const sourceId = normalizeEndpointId(fromId);
    const msg = message as RpcMessage;
    if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
      return;
    }
    registry.deliver(sourceId, msg);
  });

  return {
    async send(targetId: string, message: RpcMessage): Promise<void> {
      await bridge.send(normalizeEndpointId(targetId), message);
    },

    onMessage(sourceId: string, handler: (message: RpcMessage) => void): () => void {
      return registry.onMessage(normalizeEndpointId(sourceId), handler);
    },

    onAnyMessage(handler: (sourceId: string, message: RpcMessage) => void): () => void {
      return registry.onAnyMessage(handler);
    },
  };
}

function getServerTransportBridge(): NatstackTransportBridge | null {
  const bridge = (globalThis as any).__natstackServerTransport as NatstackTransportBridge | undefined;
  if (!bridge?.send || !bridge?.onMessage) return null;
  return bridge;
}

export function createServerTransport(): RpcTransport | null {
  const bridge = getServerTransportBridge();
  if (!bridge) return null;

  const registry = createHandlerRegistry({ context: "server" });

  bridge.onMessage((fromId, message) => {
    const sourceId = normalizeEndpointId(fromId);
    const msg = message as RpcMessage;
    if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
      return;
    }
    registry.deliver(sourceId, msg);
  });

  return {
    async send(targetId: string, message: RpcMessage): Promise<void> {
      await bridge.send(normalizeEndpointId(targetId), message);
    },
    onMessage(sourceId: string, handler: (message: RpcMessage) => void): () => void {
      return registry.onMessage(normalizeEndpointId(sourceId), handler);
    },
    onAnyMessage(handler: (sourceId: string, message: RpcMessage) => void): () => void {
      return registry.onAnyMessage(handler);
    },
  };
}

