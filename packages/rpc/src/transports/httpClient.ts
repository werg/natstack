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

function describeFetchFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  if (!cause) return message;
  return `${message} (cause: ${describeFetchCause(cause)})`;
}

function describeFetchCause(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const fields = cause as Error & {
    code?: unknown;
    errno?: unknown;
    syscall?: unknown;
    address?: unknown;
    port?: unknown;
  };
  const parts = [`${cause.name}: ${cause.message}`];
  for (const key of ["code", "errno", "syscall", "address", "port"] as const) {
    const value = fields[key];
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join(" ");
}

function rpcFetchError(url: string, error: unknown, attempts?: number): Error {
  const retryText = attempts && attempts > 1 ? ` after ${attempts} attempts` : "";
  const wrapped = new Error(
    `RPC fetch to ${url} failed${retryText}: ${describeFetchFailure(error)}`
  ) as Error & { cause?: unknown };
  wrapped.cause = error;
  return wrapped;
}

export function httpClientTransport(config: HttpClientTransportConfig): EnvelopeRpcTransport & {
  deliver(envelope: RpcEnvelope): void;
  stream(envelope: RpcEnvelope, signal?: AbortSignal | null): Promise<Response>;
} {
  const listeners = new Set<(envelope: RpcEnvelope) => void>();
  const fetchImpl = config.fetch ?? rpcFetch;
  const runtimeIdHeader = config.runtimeIdHeader ?? "X-Natstack-Runtime-Id";
  const rpcUrl = `${config.serverUrl}/rpc`;
  const streamUrl = `${config.serverUrl}/__rpc/stream`;

  async function postEnvelope(envelope: RpcEnvelope): Promise<unknown> {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(rpcUrl, {
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
        throw rpcFetchError(rpcUrl, error, maxRetries);
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
      let response: Response;
      try {
        response = await fetchImpl(streamUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.authToken}`,
            [runtimeIdHeader]: config.selfId,
          },
          body: JSON.stringify(envelope),
          signal: signal ?? undefined,
        });
      } catch (error) {
        throw rpcFetchError(streamUrl, error);
      }
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
