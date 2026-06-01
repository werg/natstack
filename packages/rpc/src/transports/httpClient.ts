import type { EnvelopeRpcTransport, RpcEnvelope } from "../types.js";
import { decodeFramedResponseToStreaming } from "../protocol/streamCodec.js";

const rpcFetch = globalThis.fetch.bind(globalThis);

export interface HttpClientTransportConfig {
  selfId: string;
  serverUrl: string;
  authToken: string;
  fetch?: typeof fetch;
  runtimeIdHeader?: string;
}

export function httpClientTransport(config: HttpClientTransportConfig): EnvelopeRpcTransport & {
  deliver(envelope: RpcEnvelope): void;
  stream(envelope: RpcEnvelope, signal?: AbortSignal | null): Promise<Response>;
} {
  const listeners = new Set<(envelope: RpcEnvelope) => void>();
  const fetchImpl = config.fetch ?? rpcFetch;
  const runtimeIdHeader = config.runtimeIdHeader ?? "X-Natstack-Runtime-Id";

  async function postEnvelope(envelope: RpcEnvelope): Promise<unknown> {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(`${config.serverUrl}/rpc`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.authToken}`,
            [runtimeIdHeader]: config.selfId,
          },
          body: JSON.stringify(envelope),
        });
      } catch (error) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
          continue;
        }
        throw error;
      }
      if (response.status >= 500 && attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
        continue;
      }
      if (response.status === 401) throw new Error("RPC authentication failed");
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`RPC endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      return response.json();
    }
    throw new Error("RPC request failed after retries");
  }

  return {
    async send(envelope): Promise<void> {
      const response = (await postEnvelope(envelope)) as unknown;
      const returnedEnvelope =
        response && typeof response === "object" && "envelope" in response
          ? (response as { envelope?: RpcEnvelope }).envelope
          : (response as RpcEnvelope | undefined);
      if (returnedEnvelope && typeof returnedEnvelope === "object" && "message" in returnedEnvelope) {
        for (const listener of listeners) listener(returnedEnvelope);
      }
    },
    onMessage(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    deliver(envelope): void {
      for (const listener of listeners) listener(envelope);
    },
    async stream(envelope, signal): Promise<Response> {
      const response = await fetchImpl(`${config.serverUrl}/__rpc/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.authToken}`,
          [runtimeIdHeader]: config.selfId,
        },
        body: JSON.stringify(envelope),
        signal: signal ?? undefined,
      });
      if (response.status === 401) throw new Error("RPC streaming authentication failed");
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`RPC streaming endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      if (!response.body) throw new Error("RPC streaming response has no body");
      return decodeFramedResponseToStreaming(response.body, "", signal ?? null);
    },
    status: () => "connected",
    ready: () => Promise.resolve(),
    onStatusChange: () => () => {},
  };
}
