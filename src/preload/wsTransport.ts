/**
 * WebSocket transport bridge for preload scripts.
 */

import type { RpcEvent, RpcMessage } from "@natstack/rpc";
import { BaseWsTransport, type WsLike } from "@natstack/shared/shell/transport";
import type { RecoveryKind } from "@natstack/shared/shell/recoveryCoordinator";

type AnyMessageHandler = (fromId: string, message: unknown) => void;

type PanelInitPayload = {
  gatewayConfig?: {
    token?: unknown;
  };
};

type PanelInitProvider = {
  getPanelInit: () => Promise<PanelInitPayload>;
};

type NatstackTransportGlobals = typeof globalThis & {
  __natstackShell?: PanelInitProvider;
  __natstackElectron?: PanelInitProvider;
  __natstackGatewayToken?: string;
};

export type TransportBridge = {
  send: (targetId: string, message: unknown) => Promise<void>;
  onMessage: (handler: AnyMessageHandler) => () => void;
  onRecovery: (kind: RecoveryKind, handler: () => void | Promise<void>) => () => void;
};

export interface WsTransportConfig {
  viewId: string;
  wsPort: number;
  authToken: string;
  callerKind: string;
  /** Override WebSocket URL. Default: ws://127.0.0.1:{wsPort} */
  wsUrl?: string;
}

class BrowserWsLike implements WsLike {
  constructor(private readonly ws: WebSocket) {}
  get readyState(): number {
    return this.ws.readyState;
  }
  get onopen(): (() => void) | null {
    return this.ws.onopen as (() => void) | null;
  }
  set onopen(handler: (() => void) | null) {
    this.ws.onopen = handler;
  }
  get onmessage(): ((event: { data: unknown }) => void) | null {
    return this.ws.onmessage as ((event: { data: unknown }) => void) | null;
  }
  set onmessage(handler: ((event: { data: unknown }) => void) | null) {
    this.ws.onmessage = handler as ((event: MessageEvent) => void) | null;
  }
  get onclose(): ((event: { code?: number; reason?: string }) => void) | null {
    return this.ws.onclose as ((event: { code?: number; reason?: string }) => void) | null;
  }
  set onclose(handler: ((event: { code?: number; reason?: string }) => void) | null) {
    this.ws.onclose = handler as ((event: CloseEvent) => void) | null;
  }
  get onerror(): ((event: unknown) => void) | null {
    return this.ws.onerror as ((event: unknown) => void) | null;
  }
  set onerror(handler: ((event: unknown) => void) | null) {
    this.ws.onerror = handler as ((event: Event) => void) | null;
  }
  send(data: string): void {
    this.ws.send(data);
  }
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}

const normalizeEndpointId = (targetId: string): string => {
  if (targetId.startsWith("panel:")) return targetId.slice(6);
  return targetId;
};

export function createWsTransport(config: WsTransportConfig): TransportBridge {
  const listeners = new Set<AnyMessageHandler>();
  const bufferedMessages: Array<{ fromId: string; message: RpcMessage }> = [];
  let transportReady = false;
  let authToken = config.authToken;

  const deliver = (fromId: string, message: RpcMessage) => {
    if (!transportReady) {
      bufferedMessages.push({ fromId, message });
      if (bufferedMessages.length > 500) bufferedMessages.shift();
      return;
    }
    for (const listener of listeners) {
      try {
        listener(fromId, message);
      } catch (error) {
        console.error("Error in WS transport message handler:", error);
      }
    }
  };

  const translateEvent = (
    event: string,
    payload: unknown,
    baseDeliver: (message: RpcMessage) => void
  ): boolean => {
    if (event !== "panel:event") return false;
    const record = payload as Record<string, unknown>;
    if (record["panelId"] !== config.viewId) return true;
    if (record["type"] === "focus") {
      baseDeliver({ type: "event", fromId: "main", event: "runtime:focus", payload: null });
    } else if (record["type"] === "theme") {
      baseDeliver({
        type: "event",
        fromId: "main",
        event: "runtime:theme",
        payload: record["theme"],
      });
    } else if (record["type"] === "child-created") {
      baseDeliver({
        type: "event",
        fromId: "main",
        event: "runtime:child-created",
        payload: { childId: record["childId"], url: record["url"] },
      });
    } else if (record["type"] === "child-creation-error") {
      baseDeliver({
        type: "event",
        fromId: "main",
        event: "runtime:child-creation-error",
        payload: { url: record["url"], error: record["error"] },
      });
    }
    return true;
  };

  const refreshAuthToken = async (): Promise<string> => {
    const globals = globalThis as NatstackTransportGlobals;
    const shell = globals.__natstackShell ?? globals.__natstackElectron;
    if (!shell || typeof shell.getPanelInit !== "function") return authToken;
    const panelInit = await shell.getPanelInit();
    const nextToken = panelInit?.gatewayConfig?.token;
    if (typeof nextToken === "string" && nextToken.length > 0) {
      authToken = nextToken;
      globals.__natstackGatewayToken = nextToken;
      try {
        sessionStorage.setItem("__natstackPanelInit", JSON.stringify(panelInit));
      } catch {
        // ignore
      }
    }
    return authToken;
  };

  const base = new BaseWsTransport({
    selfId: config.viewId,
    getWsUrl: () => config.wsUrl ?? `ws://127.0.0.1:${config.wsPort}`,
    routeTarget: normalizeEndpointId,
    terminalCloseCodes: [4001, 4005, 4006],
    translateEvent,
    logPrefix: "WsTransport",
    adapter: {
      now: () => Date.now(),
      getAuthToken: async () => authToken,
      refreshAuthToken,
      createSocket: (url) => new BrowserWsLike(new WebSocket(url)),
    },
  });
  base.onMessage(deliver);
  base.onEvent("runtime:routed-event-error", (fromId, payload) => {
    deliver(fromId, {
      type: "event",
      fromId,
      event: "runtime:routed-event-error",
      payload,
    } as RpcEvent);
  });
  base.onEvent("runtime:routed-response-error", (fromId, payload) => {
    deliver(fromId, {
      type: "event",
      fromId,
      event: "runtime:routed-response-error",
      payload,
    } as RpcEvent);
  });
  base.connect();

  return {
    send(targetId, message) {
      const rpcMessage = message as RpcMessage;
      if (
        !rpcMessage ||
        typeof rpcMessage !== "object" ||
        typeof (rpcMessage as { type?: unknown }).type !== "string"
      ) {
        return Promise.reject(new Error("Invalid RPC message"));
      }
      return base.send(targetId, rpcMessage);
    },
    onMessage(handler) {
      listeners.add(handler);
      queueMicrotask(() => {
        transportReady = true;
        for (const buffered of bufferedMessages.splice(0)) {
          deliver(buffered.fromId, buffered.message);
        }
      });
      return () => listeners.delete(handler);
    },
    onRecovery(kind, handler) {
      return base.onRecovery(kind, handler);
    },
  };
}
