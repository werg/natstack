import type { EnvelopeRpcTransport, RpcEnvelope, RpcRequest } from "../types.js";
import { decodeFramedResponseToStreaming } from "../protocol/streamCodec.js";

const rpcFetch = globalThis.fetch.bind(globalThis);

/** How long `respond()` waits for the core to produce a response envelope. */
const RESPOND_TIMEOUT_MS = 120_000;

export interface HttpClientTransportConfig {
  selfId: string;
  serverUrl: string;
  authToken: string;
  fetch?: typeof fetch;
  runtimeIdHeader?: string;
  /**
   * How long `respond()` waits for the handler before giving up (default 120s). A DO that runs
   * legitimately long HELD handlers (the EvalDO's `executeRun`) sets this very high / disables it
   * (`<= 0` ⇒ no reaper) — the held connection itself, plus the run's opt-in `timeoutMs`, bound it.
   */
  respondTimeoutMs?: number;
}

/**
 * The connectionless transport surface: the standard `EnvelopeRpcTransport`
 * plus the off-socket extras a Durable Object base needs.
 *
 * - `request(envelope)` — POST an envelope to `/rpc` and return the RAW server
 *   JSON (a response envelope, or a `{deferred,requestId}` ack). Used by the
 *   `callDeferred` extension, which must inspect the deferral discriminator
 *   that `send()` swallows.
 * - `deliver(envelope)` — feed an inbound envelope to the core's listeners
 *   (server→DO event push, deferred replies) with no response expected.
 * - `respond(envelope)` — feed an inbound REQUEST and capture the response
 *   envelope the core produces, so the DO's `fetch` can return it synchronously
 *   in the HTTP body (the server's relay reads the result from that body).
 */
export type ConnectionlessTransport = EnvelopeRpcTransport & {
  request(envelope: RpcEnvelope): Promise<unknown>;
  deliver(envelope: RpcEnvelope): void;
  respond(envelope: RpcEnvelope): Promise<RpcEnvelope | null>;
  stream(envelope: RpcEnvelope, signal?: AbortSignal | null): Promise<Response>;
};

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

export function httpClientTransport(config: HttpClientTransportConfig): ConnectionlessTransport {
  const listeners = new Set<(envelope: RpcEnvelope) => void>();
  // One-shot captures for inbound requests delivered via `respond()`: the core
  // produces a response envelope by calling `send()`, which resolves the
  // matching capture instead of POSTing it back to the server.
  const captures = new Map<string, (envelope: RpcEnvelope) => void>();
  const fetchImpl = config.fetch ?? rpcFetch;
  const runtimeIdHeader = config.runtimeIdHeader ?? "X-Natstack-Runtime-Id";
  const rpcUrl = `${config.serverUrl}/rpc`;
  const streamUrl = `${config.serverUrl}/rpc/stream`;

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

  function deliverToListeners(envelope: RpcEnvelope): void {
    for (const listener of listeners) listener(envelope);
  }

  return {
    async send(envelope): Promise<void> {
      // A response envelope whose requestId matches a pending inbound `respond`
      // is the answer to a request the server POSTed to us — resolve the capture
      // locally instead of POSTing it back to the server.
      const message = envelope.message;
      if (message.type === "response") {
        const capture = captures.get(message.requestId);
        if (capture) {
          captures.delete(message.requestId);
          capture(envelope);
          return;
        }
      }
      const response = (await postEnvelope(envelope)) as unknown;
      const returnedEnvelope =
        response && typeof response === "object" && "envelope" in response
          ? (response as { envelope?: RpcEnvelope }).envelope
          : (response as RpcEnvelope | undefined);
      if (returnedEnvelope && typeof returnedEnvelope === "object" && "message" in returnedEnvelope) {
        deliverToListeners(returnedEnvelope);
      }
    },
    onMessage(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    request(envelope): Promise<unknown> {
      return postEnvelope(envelope);
    },
    deliver(envelope): void {
      deliverToListeners(envelope);
    },
    respond(inbound): Promise<RpcEnvelope | null> {
      const message = inbound.message;
      if (message.type !== "request" && message.type !== "stream-request") {
        // Events / frames / cancels expect no response — just deliver them.
        deliverToListeners(inbound);
        return Promise.resolve(null);
      }
      const requestId = (message as RpcRequest).requestId;
      const timeoutMs = config.respondTimeoutMs ?? RESPOND_TIMEOUT_MS;
      return new Promise<RpcEnvelope | null>((resolve) => {
        // `<= 0` disables the reaper (the EvalDO's held `executeRun`); the handler resolves only
        // when it really finishes (or the held connection drops).
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                captures.delete(requestId);
                // Resolve with a REJECTING response envelope, not `null`. The
                // server's relay reads this body and delivers it to the original
                // caller; a `null` here was unwrapped downstream to `undefined`,
                // silently handing the caller a wrong (empty) result instead of
                // an error (silent-drop class). The held exemption above (`<= 0`)
                // is untouched.
                console.warn(
                  `[httpClientTransport:${config.selfId}] respond() timed out after ${timeoutMs}ms ` +
                    `for "${(message as RpcRequest).method}" (requestId=${requestId})`,
                );
                resolve({
                  from: inbound.target,
                  target: inbound.from,
                  delivery: { caller: { callerId: inbound.target, callerKind: "unknown" } },
                  provenance: inbound.provenance ?? [],
                  message: {
                    type: "response",
                    requestId,
                    error: `Handler timed out after ${timeoutMs}ms`,
                    errorCode: "RESPOND_TIMEOUT",
                  },
                });
              }, timeoutMs)
            : null;
        captures.set(requestId, (responseEnvelope) => {
          if (timer) clearTimeout(timer);
          resolve(responseEnvelope);
        });
        deliverToListeners(inbound);
      });
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
