import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  Server,
  ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import type { AuditLog } from "../../../packages/shared/src/credentials/audit.js";
import type {
  AuditEntry,
  Credential,
  CredentialBinding,
  CredentialBindingUse,
  CredentialGrantAction,
  CredentialUseGrant,
} from "../../../packages/shared/src/credentials/types.js";
import {
  credentialCarrierStripHeaders,
  findMatchingUrlAudience,
  renderCredentialBasicAuthValue,
  renderCredentialHeaderValue,
} from "../../../packages/shared/src/credentials/urlAudience.js";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import {
  CredentialSessionGrantStore,
  type CredentialSessionGrantResource,
} from "./credentialSessionGrants.js";
import { CredentialLifecycleError, type CredentialLifecycle } from "./credentialLifecycle.js";
import { deleteDynamicProperty } from "../../lintHelpers";
import type { VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { requestCapabilityPermission } from "./capabilityPermission.js";
import { connect as netConnect, isIP } from "node:net";
import type { ResolvedCodeIdentity } from "./principalIdentity.js";

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Internal headers the dynamic-worker egress path uses for attribution. They
 *  are consumed by the shared listener and MUST be stripped before forwarding
 *  upstream so they never leak to the destination. */
const EGRESS_CALLER_HEADER = "x-natstack-egress-caller";
const EGRESS_SECRET_HEADER = "x-natstack-egress-secret";
const NATSTACK_WS_HEADERS_PARAM = "__natstack_ws_headers";
const INTERNAL_EGRESS_HEADERS = new Set([
  EGRESS_CALLER_HEADER,
  EGRESS_SECRET_HEADER,
  "x-forwarded-proto",
]);

const PASSTHROUGH_PROVIDER_ID = "passthrough";
const PASSTHROUGH_CONNECTION_ID = "passthrough";
const RPC_RUNTIME_ID_HEADER = "x-natstack-runtime-id";
const RAW_EGRESS_CAPABILITY = "external-network-fetch";
const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 100;
const DEFAULT_RETRY_MAX_DELAY_MS = 1_000;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 30_000;
const WEBSOCKET_DIAGNOSTIC_BODY_LIMIT = 512;

export interface CredentialStore {
  loadUrlBound(id: string): Promise<Credential | null> | Credential | null;
  listUrlBound?(): Promise<Credential[]> | Credential[];
  saveUrlBound?(credential: Credential & { id: string }): Promise<void> | void;
}

export interface EgressProxyDeps {
  credentialStore: CredentialStore;
  auditLog: Pick<AuditLog, "append">;
  approvalQueue?: ApprovalQueue;
  grantStore?: CapabilityGrantStore;
  sessionGrantStore?: CredentialSessionGrantStore;
  credentialLifecycle?: Pick<CredentialLifecycle, "refreshIfNeeded" | "refreshCredential">;
}

interface RequestAttribution extends ResolvedCodeIdentity {
  policyKey: string;
}

interface Authorization {
  attribution: RequestAttribution | null;
  credential: Credential | null;
  binding: CredentialBinding | null;
  connectionId: string | null;
  scopes: string[];
}

interface ForwardResult {
  statusCode: number;
  bytesIn: number;
  bytesOut: number;
}

interface RequestExecutionResult<T> extends ForwardResult {
  payload: T;
}

class ForwardRejection extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly capabilityViolation?: string,
    public readonly code: string | undefined = capabilityViolation
  ) {
    super(message);
  }
}

/**
 * Frames emitted by `forwardProxyFetchStream`. The HTTP-stream serializer
 * encodes each one as a length-prefixed binary frame (see frame-codec.ts);
 * the client-side decoder reconstructs them and pipes the bytes into a
 * `Response` body's ReadableStream.
 */
export type StreamFrame =
  | {
      kind: "head";
      status: number;
      statusText: string;
      headerPairs: Array<[string, string]>;
      finalUrl: string;
    }
  | { kind: "chunk"; bytes: Uint8Array }
  | { kind: "end"; bytesIn: number }
  | { kind: "error"; status: number; message: string; code?: string };

interface CircuitState {
  failures: number;
  state: AuditEntry["breakerState"];
  openedAt?: number;
}

export class EgressProxy {
  private server: Server | null = null;
  private readonly attributedServers = new Map<string, { server: Server; port: number }>();
  private readonly circuits = new Map<string, CircuitState>();
  private readonly sessionGrantStore: CredentialSessionGrantStore;
  /** Shared attributed-by-header listener (dynamic worker host). One server for
   *  all dynamically-loaded workers; identity travels in a trusted header
   *  instead of a per-caller port. */
  private sharedServer: { server: Server; port: number } | null = null;
  private sharedSecret: string | null = null;
  private callerResolver: ((callerId: string) => VerifiedCaller | null) | null = null;

  constructor(private readonly deps: EgressProxyDeps) {
    this.sessionGrantStore = deps.sessionGrantStore ?? new CredentialSessionGrantStore();
  }

  /** Wire the resolver that maps an egress-caller id (from the trusted header)
   *  to the live worker's VerifiedCaller. Set by the server at startup. */
  setCallerResolver(fn: (callerId: string) => VerifiedCaller | null): void {
    this.callerResolver = fn;
  }

  /**
   * Start (once) the shared attributed-by-header egress listener for the
   * dynamic worker host. Requests carry `X-NatStack-Egress-Caller` (the worker
   * identity, stamped non-forgeably by the host's EgressGateway) gated by
   * `X-NatStack-Egress-Secret`. Returns the listener port (memoized).
   */
  async startShared(secret: string): Promise<number> {
    if (this.sharedServer) return this.sharedServer.port;
    this.sharedSecret = secret;

    const server = createServer((req, res) => {
      const caller = this.resolveAttributedCaller(req);
      if (!caller) {
        req.resume();
        this.respondWithError(res, 403, "egress: unattributed request");
        return;
      }
      void this.handleHttpRequest(req, res, caller);
    });
    server.on("connect", (req, socket, head) => {
      const caller = this.resolveAttributedCaller(req);
      if (!caller) {
        (socket as Duplex).end();
        return;
      }
      void this.handleConnect(req, socket as Duplex, head, caller);
    });
    server.on("upgrade", (req, socket, head) => {
      const caller = this.resolveAttributedCaller(req);
      if (!caller) {
        this.rejectUpgrade(socket as Duplex, 403, "egress: unattributed websocket request");
        return;
      }
      void this.handleWebSocketUpgrade(req, socket as Duplex, head, caller);
    });

    return new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address() as AddressInfo | null;
        if (!address) {
          reject(new Error("Egress proxy failed to bind the shared listener"));
          return;
        }
        this.sharedServer = { server, port: address.port };
        resolve(address.port);
      });
    });
  }

  /** Resolve the trusted caller for a shared-listener request, or null if the
   *  secret is missing/wrong or the caller id is unknown. */
  private resolveAttributedCaller(req: IncomingMessage): VerifiedCaller | null {
    const secret = this.readHeader(req, EGRESS_SECRET_HEADER);
    if (!this.sharedSecret || !secret || secret !== this.sharedSecret) return null;
    const callerId = this.readHeader(req, EGRESS_CALLER_HEADER);
    if (!callerId) return null;
    return this.callerResolver?.(callerId) ?? null;
  }

  async start(): Promise<number> {
    if (this.server) {
      const currentAddress = this.server.address();
      if (currentAddress && typeof currentAddress !== "string") {
        return currentAddress.port;
      }
    }

    const server = createServer((req, res) => {
      void this.handleHttpRequest(req, res, null);
    });

    server.on("connect", (req, socket, head) => {
      void this.handleConnect(req, socket as Duplex, head, null);
    });
    server.on("upgrade", (req, socket, head) => {
      void this.handleWebSocketUpgrade(req, socket as Duplex, head, null);
    });

    this.server = server;

    return new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address() as AddressInfo | null;
        if (!address) {
          reject(new Error("Egress proxy failed to bind to an ephemeral port"));
          return;
        }
        resolve(address.port);
      });
    });
  }

  async startForCaller(caller: VerifiedCaller): Promise<number> {
    const key = caller.runtime.id;
    const existing = this.attributedServers.get(key);
    if (existing) return existing.port;

    const server = createServer((req, res) => {
      void this.handleHttpRequest(req, res, caller);
    });
    server.on("connect", (req, socket, head) => {
      void this.handleConnect(req, socket as Duplex, head, caller);
    });
    server.on("upgrade", (req, socket, head) => {
      void this.handleWebSocketUpgrade(req, socket as Duplex, head, caller);
    });

    return new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address() as AddressInfo | null;
        if (!address) {
          reject(new Error("Egress proxy failed to bind an attributed listener"));
          return;
        }
        this.attributedServers.set(key, { server, port: address.port });
        resolve(address.port);
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    const shared = this.sharedServer;
    this.sharedServer = null;
    const attributed = [...this.attributedServers.values()];
    this.attributedServers.clear();
    await Promise.all([
      ...(server ? [new Promise<void>((resolve) => server.close(() => resolve()))] : []),
      ...(shared ? [new Promise<void>((resolve) => shared.server.close(() => resolve()))] : []),
      ...attributed.map(
        ({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))
      ),
    ]);
  }

  /**
   * Cleanup hook called by `runtime.retireEntity`. Drops the per-caller
   * attributed listener (if any) and circuit-breaker state. Best-effort.
   */
  async dropCaller(callerId: string): Promise<void> {
    const entry = this.attributedServers.get(callerId);
    if (entry) {
      this.attributedServers.delete(callerId);
      await new Promise<void>((resolve) => entry.server.close(() => resolve()));
    }
    for (const key of [...this.circuits.keys()]) {
      if (key.startsWith(`${callerId}:`) || key === callerId) {
        this.circuits.delete(key);
      }
    }
  }

  async forwardProxyFetch(params: {
    caller: VerifiedCaller;
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    credentialId?: string;
  }): Promise<{
    status: number;
    statusText: string;
    /**
     * Headers as ordered pairs (not a flat Record) so multiple
     * `Set-Cookie` entries — which the Fetch spec deliberately does
     * NOT combine when iterating — round-trip intact.
     */
    headerPairs: Array<[string, string]>;
    /**
     * Final URL after any redirects the underlying fetch followed.
     * Mirrors `Response.url`. Falls back to the requested URL when
     * the runtime didn't expose it.
     */
    finalUrl: string;
    body: Uint8Array;
  }> {
    const body = params.body;
    const bytesOut =
      body === undefined ? 0 : typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
    return this.executeAuthorizedRequest({
      caller: params.caller,
      method: params.method.toUpperCase(),
      targetUrl: new URL(params.url),
      inputHeaders: params.headers ?? {},
      credentialId: params.credentialId,
      credentialUse: "fetch",
      initialBytesOut: bytesOut,
      replaySafe: true,
      execute: async (targetUrl, headers) => {
        const response = await fetch(targetUrl.toString(), {
          method: params.method,
          headers: headers as HeadersInit,
          body: body as BodyInit | undefined,
        });
        const responseBody = new Uint8Array(await response.arrayBuffer());
        return {
          statusCode: response.status,
          bytesIn: responseBody.byteLength,
          bytesOut,
          payload: {
            status: response.status,
            statusText: response.statusText,
            headerPairs: Array.from(response.headers.entries()) as Array<[string, string]>,
            finalUrl: response.url || targetUrl.toString(),
            body: responseBody,
          },
        };
      },
    });
  }

  /**
   * Streaming variant of `forwardProxyFetch`. Performs the same credential
   * resolution + audit + retry machinery, but instead of buffering the
   * upstream response body it pumps it through a sink one chunk at a
   * time. The sink is called with:
   *
   *   - `{ kind: "head", status, statusText, headerPairs, finalUrl }`
   *     exactly once, as soon as the upstream response headers arrive.
   *   - `{ kind: "chunk", bytes }` zero or more times as response body
   *     chunks arrive from the upstream.
   *   - `{ kind: "end", bytesIn }` exactly once when the upstream body
   *     EOFs cleanly.
   *
   * Retries: only meaningful BEFORE the head frame is emitted. Once
   * downstream consumers have seen the head, the response is committed —
   * a mid-stream upstream error surfaces as a `kind: "error"` frame and
   * is not retried.
   *
   * Audit logging is finalized after the stream completes (or errors),
   * with `bytesIn` totaled across all emitted chunks.
   */
  async forwardProxyFetchStream(
    params: {
      caller: VerifiedCaller;
      url: string;
      method: string;
      headers?: Record<string, string>;
      body?: string | Uint8Array;
      credentialId?: string;
    },
    sink: (frame: StreamFrame) => Promise<void> | void,
    abortSignal?: AbortSignal
  ): Promise<{ status: number; bytesIn: number }> {
    const body = params.body;
    const bytesOut =
      body === undefined ? 0 : typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;

    let bytesInTotal = 0;

    const result = await this.executeAuthorizedRequest({
      caller: params.caller,
      method: params.method.toUpperCase(),
      targetUrl: new URL(params.url),
      inputHeaders: params.headers ?? {},
      credentialId: params.credentialId,
      credentialUse: "fetch",
      initialBytesOut: bytesOut,
      // Retries are unsafe once the head frame has been emitted (the
      // caller has already seen a partial response). Disable retries
      // entirely for the streaming path to keep the contract simple.
      replaySafe: false,
      maxRetries: 0,
      execute: async (targetUrl, headers, authorization) => {
        const upstream = await fetch(targetUrl.toString(), {
          method: params.method,
          headers: headers as HeadersInit,
          body: body as BodyInit | undefined,
          signal: abortSignal,
        });

        if (upstream.status === 401 && this.canForceRefreshCredential(authorization.credential)) {
          const responseBody = new Uint8Array(await upstream.arrayBuffer());
          return {
            statusCode: upstream.status,
            bytesIn: responseBody.byteLength,
            bytesOut,
            payload: {
              status: upstream.status,
              bytesIn: responseBody.byteLength,
            },
          };
        }

        await sink({
          kind: "head",
          status: upstream.status,
          statusText: upstream.statusText,
          headerPairs: Array.from(upstream.headers.entries()) as Array<[string, string]>,
          finalUrl: upstream.url || targetUrl.toString(),
        });

        // Post-HEAD errors are caught INSIDE the execute callback so
        // `executeAuthorizedRequest` records the correct audit entry
        // (real status + accumulated bytesIn). If we let them throw,
        // the audit log would record `status: 500, bytesIn: 0` even
        // for a multi-MB partial response.
        let finalStatus = upstream.status;
        try {
          if (upstream.body) {
            const reader = upstream.body.getReader();
            try {
              while (true) {
                if (abortSignal?.aborted) {
                  await reader.cancel().catch(() => {});
                  throw new Error("Streaming proxy fetch aborted by caller");
                }
                const { value, done } = await reader.read();
                if (done) break;
                if (value && value.byteLength > 0) {
                  bytesInTotal += value.byteLength;
                  await sink({ kind: "chunk", bytes: value });
                }
              }
            } finally {
              reader.releaseLock();
            }
          }
          await sink({ kind: "end", bytesIn: bytesInTotal });
        } catch (err) {
          // Mid-stream upstream failure. Surface as an error frame so
          // the consumer's ReadableStream gets an error rather than a
          // truncated body, and return 502 to the audit log along
          // with the bytes we did manage to forward.
          try {
            const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
            await sink({
              kind: "error",
              status: 502,
              message: err instanceof Error ? err.message : String(err),
              code: typeof code === "string" ? code : undefined,
            });
          } catch {
            // Best-effort — connection may already be torn down.
          }
          finalStatus = 502;
        }

        return {
          statusCode: finalStatus,
          bytesIn: bytesInTotal,
          bytesOut,
          payload: { status: finalStatus, bytesIn: bytesInTotal },
        };
      },
    });

    return result;
  }

  async forwardGitHttp(params: {
    caller: VerifiedCaller;
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: Uint8Array;
    credentialId?: string;
  }): Promise<{
    url: string;
    method: string;
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string>;
    body: Uint8Array;
  }> {
    const body = params.body;
    const bytesOut = body?.byteLength ?? 0;
    return this.executeAuthorizedRequest({
      caller: params.caller,
      method: params.method.toUpperCase(),
      targetUrl: new URL(params.url),
      inputHeaders: params.headers ?? {},
      credentialId: params.credentialId,
      credentialUse: "git-http",
      initialBytesOut: bytesOut,
      replaySafe: false,
      execute: async (targetUrl, headers) => {
        const response = await fetch(targetUrl.toString(), {
          method: params.method,
          headers: headers as HeadersInit,
          body: body as BodyInit | undefined,
        });
        const responseBody = new Uint8Array(await response.arrayBuffer());
        return {
          statusCode: response.status,
          bytesIn: responseBody.byteLength,
          bytesOut,
          payload: {
            url: response.url,
            method: params.method,
            statusCode: response.status,
            statusMessage: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            body: responseBody,
          },
        };
      },
    });
  }

  public prepareForwardRequest(
    targetUrl: URL,
    inputHeaders: IncomingHttpHeaders | Headers | Record<string, string | string[] | undefined>,
    credential?: Credential,
    binding?: CredentialBinding | null,
    method = "GET"
  ): { headers: OutgoingHttpHeaders; targetUrl: URL } {
    const headers: OutgoingHttpHeaders = {};

    for (const [name, value] of this.iterateHeaders(inputHeaders)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP_REQUEST_HEADERS.has(lower) || INTERNAL_EGRESS_HEADERS.has(lower)) {
        continue;
      }
      headers[lower] = value;
    }

    const injection = binding?.injection ?? credential?.bindings?.[0]?.injection;
    if (credential && injection) {
      for (const headerName of credentialCarrierStripHeaders(injection)) {
        deleteDynamicProperty(headers, headerName.toLowerCase());
      }
      if (injection.type === "query-param") {
        const modified = new URL(targetUrl.toString());
        modified.searchParams.delete(injection.name);
        modified.searchParams.set(injection.name, credential.accessToken);
        targetUrl = modified;
      } else if (injection.type === "basic-auth") {
        headers.authorization = renderCredentialBasicAuthValue(injection, credential.accessToken);
      } else if (injection.type === "header") {
        headers[injection.name] = renderCredentialHeaderValue(
          injection.valueTemplate,
          credential.accessToken
        );
      } else if (injection.type === "cookie") {
        headers.cookie = renderCookieSessionHeader(credential, targetUrl);
      } else if (injection.type === "oauth1-signature") {
        if (!credential.oauth1TokenSecret) {
          throw new Error("OAuth1 credential is missing token secret");
        }
        headers.authorization = renderOAuth1AuthorizationHeader({
          method,
          targetUrl,
          consumerKey: credential.metadata?.["oauth1ConsumerKey"] ?? "",
          consumerSecret: credential.oauth1ConsumerSecret ?? "",
          token: credential.accessToken,
          tokenSecret: credential.oauth1TokenSecret,
        });
      } else if (injection.type === "aws-sigv4") {
        if (!credential.awsSecretAccessKey) {
          throw new Error("AWS SigV4 credential is missing secret access key");
        }
        applyAwsSigV4Authorization({
          method,
          targetUrl,
          headers,
          accessKeyId: credential.accessToken,
          secretAccessKey: credential.awsSecretAccessKey,
          sessionToken: credential.awsSessionToken,
          service: injection.service,
          region: injection.region,
        });
      } else {
        throw new Error("Unsupported credential injection type");
      }
    }

    headers.host = targetUrl.host;
    return { headers, targetUrl };
  }

  public resolveTargetUrl(req: IncomingMessage): URL | null {
    const rawUrl = req.url;
    if (!rawUrl) {
      return null;
    }

    try {
      return new URL(rawUrl);
    } catch {
      const host = req.headers.host;
      if (!host) {
        return null;
      }
      const proto = this.readHeader(req, "x-forwarded-proto") ?? "https";
      const normalizedPath = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
      try {
        return new URL(`${proto}://${host}${normalizedPath}`);
      } catch {
        return null;
      }
    }
  }

  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    caller: VerifiedCaller | null
  ): Promise<void> {
    const targetUrl = this.resolveTargetUrl(req);
    if (!targetUrl) {
      this.respondWithError(res, 400, "Proxy request URL is invalid");
      return;
    }

    if (this.isPlatformRpcCallback(req, targetUrl)) {
      try {
        const forwardResult = await this.forwardHttpRequest(
          req,
          res,
          targetUrl,
          this.preparePlatformRpcHeaders(req.headers, targetUrl)
        );
        await this.appendAuditEntry({
          ts: Date.now(),
          workerId: "platform-rpc",
          callerId: this.readHeader(req, RPC_RUNTIME_ID_HEADER) ?? "unknown",
          providerId: PASSTHROUGH_PROVIDER_ID,
          connectionId: PASSTHROUGH_CONNECTION_ID,
          method: req.method ?? "POST",
          url: `${targetUrl.origin}${targetUrl.pathname}`,
          status: forwardResult.statusCode,
          durationMs: 0,
          bytesIn: forwardResult.bytesIn,
          bytesOut: forwardResult.bytesOut,
          scopesUsed: [],
          retries: 0,
          breakerState: "closed",
        });
      } catch {
        if (!res.headersSent) {
          this.respondWithError(res, 502, "Failed to forward platform RPC callback");
        }
      }
      return;
    }

    if (!caller) {
      req.resume();
      this.respondWithError(
        res,
        403,
        "Direct egress proxy HTTP forwarding requires an attributed workerd service"
      );
      return;
    }

    try {
      await this.executeAuthorizedRequest({
        caller,
        method: (req.method ?? "GET").toUpperCase(),
        targetUrl,
        inputHeaders: req.headers,
        credentialUse: "fetch",
        execute: async (preparedUrl, headers) => {
          const forwardResult = await this.forwardHttpRequest(req, res, preparedUrl, headers);
          return { ...forwardResult, payload: undefined };
        },
      });
    } catch (error) {
      if (error instanceof ForwardRejection) {
        this.respondWithError(res, error.statusCode, error.message);
        return;
      }
      if (!res.headersSent) {
        this.respondWithError(res, 502, "Failed to forward proxy request");
      }
    }
  }

  private isPlatformRpcCallback(req: IncomingMessage, targetUrl: URL): boolean {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "POST") return false;
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") return false;
    if (targetUrl.pathname !== "/rpc" && targetUrl.pathname !== "/rpc/stream") return false;
    if (!isLoopbackHostname(targetUrl.hostname)) return false;
    const auth = this.readHeader(req, "authorization");
    if (!auth?.startsWith("Bearer ")) return false;
    return !!this.readHeader(req, RPC_RUNTIME_ID_HEADER);
  }

  private preparePlatformRpcHeaders(
    inputHeaders: IncomingHttpHeaders,
    targetUrl: URL
  ): OutgoingHttpHeaders {
    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of this.iterateHeaders(inputHeaders)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP_REQUEST_HEADERS.has(lower)) continue;
      headers[lower] = value;
    }
    headers.host = targetUrl.host;
    return headers;
  }

  private async executeAuthorizedRequest<T>(params: {
    caller: VerifiedCaller | null;
    method: string;
    targetUrl: URL;
    inputHeaders: IncomingHttpHeaders | Headers | Record<string, string | string[] | undefined>;
    credentialId?: string;
    credentialUse?: CredentialBindingUse;
    initialBytesOut?: number;
    maxRetries?: number;
    replaySafe?: boolean;
    execute: (
      targetUrl: URL,
      headers: OutgoingHttpHeaders,
      authorization: Authorization
    ) => Promise<RequestExecutionResult<T>>;
  }): Promise<T> {
    const startedAt = Date.now();
    let authorization: Authorization | null = null;
    let targetUrl = params.targetUrl;
    let statusCode = 500;
    let bytesIn = 0;
    let bytesOut = params.initialBytesOut ?? 0;
    let capabilityViolation: string | undefined;
    let retries = 0;
    let breakerState: AuditEntry["breakerState"] = "closed";

    try {
      authorization = await this.authorizeRequest({
        caller: params.caller,
        targetUrl,
        method: params.method,
        credentialId: params.credentialId,
        credentialUse: params.credentialUse ?? "fetch",
      });
      const executionKey = executionPolicyKey(authorization, params.targetUrl);
      let maxAttempts =
        (params.maxRetries !== undefined
          ? params.maxRetries
          : shouldRetryRequest(params.method, params.replaySafe)
            ? DEFAULT_RETRY_ATTEMPTS
            : 0) + 1;
      let lastError: unknown;
      let refreshedAfterAuthFailure = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        breakerState = getCircuitState(this.circuits, executionKey);
        if (breakerState === "open") {
          throw new ForwardRejection(503, "Circuit breaker is open");
        }

        const prepared = this.prepareForwardRequest(
          params.targetUrl,
          params.inputHeaders,
          authorization.credential ?? undefined,
          authorization.binding,
          params.method
        );
        targetUrl = prepared.targetUrl;
        try {
          const result = await params.execute(targetUrl, prepared.headers, authorization);
          statusCode = result.statusCode;
          bytesIn = result.bytesIn;
          bytesOut = result.bytesOut;
          if (
            statusCode === 401 &&
            !refreshedAfterAuthFailure &&
            (await this.forceRefreshAuthorizationCredential(authorization))
          ) {
            refreshedAfterAuthFailure = true;
            retries += 1;
            if (attempt === maxAttempts) maxAttempts += 1;
            continue;
          }
          if (isRetryableStatus(statusCode) && attempt < maxAttempts) {
            retries += 1;
            recordCircuitFailure(this.circuits, executionKey);
            await delay(backoffDelayMs(attempt));
            continue;
          }
          if (statusCode >= 500) {
            recordCircuitFailure(this.circuits, executionKey);
          } else {
            recordCircuitSuccess(this.circuits, executionKey);
          }
          breakerState = getCircuitState(this.circuits, executionKey);
          return result.payload;
        } catch (error) {
          lastError = error;
          if (attempt < maxAttempts && !(error instanceof ForwardRejection)) {
            retries += 1;
            recordCircuitFailure(this.circuits, executionKey);
            await delay(backoffDelayMs(attempt));
            continue;
          }
          recordCircuitFailure(this.circuits, executionKey);
          breakerState = getCircuitState(this.circuits, executionKey);
          throw error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Failed to forward proxy request");
    } catch (error) {
      if (error instanceof ForwardRejection) {
        statusCode = error.statusCode;
        capabilityViolation = error.capabilityViolation;
      }
      throw error;
    } finally {
      await this.appendAuditEntry({
        ts: startedAt,
        workerId: authorization?.attribution?.repoPath ?? "unknown",
        callerId: authorization?.attribution?.callerId ?? params.caller?.runtime.id ?? "unknown",
        providerId: authorization?.credential?.providerId ?? PASSTHROUGH_PROVIDER_ID,
        connectionId: authorization?.connectionId ?? PASSTHROUGH_CONNECTION_ID,
        method: params.method,
        url: auditUrlFor(params.targetUrl, authorization?.binding ?? null),
        status: statusCode,
        durationMs: Date.now() - startedAt,
        bytesIn,
        bytesOut,
        scopesUsed: authorization?.scopes ?? [],
        capabilityViolation,
        retries,
        breakerState,
      });
    }
  }

  private async authorizeRequest(params: {
    caller: VerifiedCaller | null;
    targetUrl: URL;
    method: string;
    credentialId?: string;
    credentialUse: CredentialBindingUse;
  }): Promise<Authorization> {
    const caller = params.caller;
    const attribution = caller ? this.resolveAttribution(caller, params.credentialId) : null;
    if (!params.credentialId) {
      const credential = attribution
        ? await this.resolveCredentialForRequest(
            params.targetUrl,
            attribution,
            params.credentialUse,
            params.method
          )
        : null;
      if (caller && attribution && !credential) {
        await this.authorizeRawEgress(caller, attribution, params.targetUrl, params.method);
      }
      return {
        attribution,
        credential,
        binding: credential
          ? this.findCredentialBinding(credential, params.targetUrl, params.credentialUse)
          : null,
        connectionId: credential?.id ?? null,
        scopes: credential?.scopes ?? [],
      };
    }

    let credential = await Promise.resolve(
      this.deps.credentialStore.loadUrlBound(params.credentialId)
    );
    if (!credential || !credential.bindings?.length || credential.revokedAt) {
      throw new ForwardRejection(403, "credential-unavailable", "credential-unavailable");
    }
    credential = await this.refreshCredentialForUse(credential);
    if (credential.expiresAt && credential.expiresAt <= Date.now()) {
      throw new ForwardRejection(403, "credential-expired", "credential-expired");
    }
    const binding = this.findCredentialBinding(credential, params.targetUrl, params.credentialUse);
    if (!binding) {
      throw new ForwardRejection(
        403,
        "credential-audience-mismatch",
        "credential-audience-mismatch"
      );
    }
    const usage = credentialUseResource(binding, params.targetUrl, params.method);
    const callerId = params.caller?.runtime.id;
    if (
      callerId &&
      !this.isCallerAllowed(credential, callerId, attribution, usage.sessionResource)
    ) {
      await this.requestCredentialUseGrant(credential, binding, callerId, attribution, {
        targetUrl: params.targetUrl,
        method: params.method,
      });
    }

    return {
      attribution,
      credential,
      binding,
      connectionId: credential.id ?? credential.connectionId,
      scopes: credential.scopes,
    };
  }

  private async authorizeRawEgress(
    caller: VerifiedCaller,
    attribution: RequestAttribution,
    targetUrl: URL,
    method: string
  ): Promise<void> {
    if (!this.deps.approvalQueue || !this.deps.grantStore) {
      throw new ForwardRejection(403, "Raw network egress approval is unavailable");
    }
    const origin = targetUrl.origin;
    const authorization = await requestCapabilityPermission(
      {
        approvalQueue: this.deps.approvalQueue,
        grantStore: this.deps.grantStore,
      },
      {
        caller,
        capability: RAW_EGRESS_CAPABILITY,
        dedupKey: `raw-egress:${caller.runtime.id}:${origin}`,
        resource: {
          type: "url-origin",
          label: "Target origin",
          value: origin,
          key: origin,
        },
        title: "Allow network access",
        description: "Allow this code version to make raw network requests to this origin.",
        details: [
          { label: "Method", value: method },
          { label: "Target origin", value: origin },
          { label: "Source", value: attribution.repoPath },
        ],
        deniedReason: "Raw network egress denied",
      }
    );
    if (!authorization.allowed) {
      throw new ForwardRejection(403, authorization.reason ?? "Raw network egress denied");
    }
  }

  private async resolveCredentialForRequest(
    targetUrl: URL,
    attribution: RequestAttribution,
    use: CredentialBindingUse = "fetch",
    method = "GET"
  ): Promise<Credential | null> {
    const listUrlBound = this.deps.credentialStore.listUrlBound;
    if (!listUrlBound) {
      return null;
    }
    const credentials = (
      await Promise.resolve(listUrlBound.call(this.deps.credentialStore))
    ).filter(
      (credential) =>
        !credential.revokedAt && !!this.findCredentialBinding(credential, targetUrl, use)
    );
    if (credentials.length === 1) {
      const credential = credentials[0] ?? null;
      if (credential) {
        const binding = this.findCredentialBinding(credential, targetUrl, use);
        if (!binding) {
          throw new ForwardRejection(
            403,
            "credential-audience-mismatch",
            "credential-audience-mismatch"
          );
        }
        const usage = credentialUseResource(binding, targetUrl, method);
        if (
          !this.isCallerAllowed(
            credential,
            attribution.callerId,
            attribution,
            usage.sessionResource
          )
        ) {
          await this.requestCredentialUseGrant(
            credential,
            binding,
            attribution.callerId,
            attribution,
            {
              targetUrl,
              method,
            }
          );
        }
      }
      return credential ? this.refreshCredentialForUse(credential) : null;
    }
    if (credentials.length > 1) {
      throw new ForwardRejection(
        409,
        "credential-selection-required",
        "credential-selection-required"
      );
    }
    return null;
  }

  private async refreshCredentialForUse(credential: Credential): Promise<Credential> {
    if (!credential.id || !credential.expiresAt || credential.expiresAt > Date.now() + 30_000) {
      return credential;
    }
    if (!credential.refreshToken || !this.deps.credentialLifecycle) {
      return credential;
    }
    try {
      return await this.deps.credentialLifecycle.refreshIfNeeded(
        credential as Credential & { id: string }
      );
    } catch (error) {
      if (error instanceof CredentialLifecycleError) {
        throw new ForwardRejection(403, error.code, error.code);
      }
      throw new ForwardRejection(403, "oauth-refresh-failed", "oauth-refresh-failed");
    }
  }

  private canForceRefreshCredential(
    credential: Credential | null
  ): credential is Credential & { id: string; refreshToken: string } {
    return (
      !!credential?.id &&
      !!credential.refreshToken &&
      typeof this.deps.credentialLifecycle?.refreshCredential === "function"
    );
  }

  private async forceRefreshAuthorizationCredential(
    authorization: Authorization
  ): Promise<boolean> {
    const credential = authorization.credential;
    if (!this.canForceRefreshCredential(credential)) return false;
    const lifecycle = this.deps.credentialLifecycle;
    if (!lifecycle?.refreshCredential) return false;
    try {
      const refreshed = await lifecycle.refreshCredential(credential);
      authorization.credential = refreshed;
      authorization.connectionId = refreshed.id ?? refreshed.connectionId;
      authorization.scopes = refreshed.scopes;
      return true;
    } catch (error) {
      if (error instanceof CredentialLifecycleError) {
        throw new ForwardRejection(403, error.code, error.code);
      }
      throw new ForwardRejection(403, "oauth-refresh-failed", "oauth-refresh-failed");
    }
  }

  private async requestCredentialUseGrant(
    credential: Credential,
    binding: CredentialBinding,
    callerId: string,
    attribution: RequestAttribution | null,
    operation: { targetUrl: URL; method: string }
  ): Promise<void> {
    if (!this.deps.approvalQueue || !attribution || !credential.id) {
      throw new ForwardRejection(
        403,
        "credential-caller-not-granted",
        "credential-caller-not-granted"
      );
    }
    const usage = credentialUseResource(binding, operation.targetUrl, operation.method);
    const decision = await this.deps.approvalQueue.request({
      callerId,
      callerKind: attribution.callerKind,
      repoPath: attribution.repoPath,
      effectiveVersion: attribution.effectiveVersion,
      credentialId: credential.id,
      credentialLabel: credential.label ?? credential.connectionLabel,
      audience: binding.audience,
      injection: binding.injection,
      accountIdentity: credential.accountIdentity,
      scopes: credential.scopes,
      credentialUse: binding.use,
      grantResource: usage.sessionResource,
      gitOperation:
        binding.use === "git-http" || binding.use === "git-ssh"
          ? describeGitHttpOperation(operation.targetUrl, operation.method)
          : undefined,
      oauthAuthorizeOrigin: credential.metadata?.["oauthAuthorizeOrigin"],
      oauthTokenOrigin: credential.metadata?.["oauthTokenOrigin"],
      oauthAudienceDomainMismatch: hasOAuthAudienceDomainMismatch(binding.audience, [
        credential.metadata?.["oauthAuthorizeOrigin"],
        credential.metadata?.["oauthTokenOrigin"],
      ]),
    });
    if (decision === "deny") {
      throw new ForwardRejection(
        403,
        "credential-caller-not-granted",
        "credential-caller-not-granted"
      );
    }
    if (decision === "once") {
      return;
    }
    if (decision === "session") {
      this.sessionGrantStore.grant(credential.id, attribution, usage.sessionResource);
      this.resolvePendingCredentialUseGrants(credential.id, attribution, decision, usage);
      return;
    }
    const saveUrlBound = this.deps.credentialStore.saveUrlBound;
    if (saveUrlBound) {
      const now = Date.now();
      await Promise.resolve(
        saveUrlBound.call(this.deps.credentialStore, {
          ...credential,
          grants: upsertCredentialUseGrant(
            credential.grants ?? [],
            grantForDecision(callerId, attribution, decision, now, binding, usage)
          ),
          metadata: {
            ...(credential.metadata ?? {}),
            updatedAt: String(now),
          },
        } as Credential & { id: string })
      );
      this.resolvePendingCredentialUseGrants(credential.id, attribution, decision, usage);
    }
  }

  private resolvePendingCredentialUseGrants(
    credentialId: string,
    attribution: RequestAttribution,
    decision: Exclude<GrantedDecision, "deny" | "once">,
    usage: ReturnType<typeof credentialUseResource>
  ): void {
    if (typeof this.deps.approvalQueue?.resolveMatching !== "function") return;
    this.deps.approvalQueue.resolveMatching((approval) => {
      if (approval.kind !== "credential") return false;
      if (approval.credentialId !== credentialId) return false;
      if (!approval.grantResource) return false;
      if (
        approval.grantResource.bindingId !== usage.sessionResource.bindingId ||
        approval.grantResource.resource !== usage.sessionResource.resource ||
        approval.grantResource.action !== usage.sessionResource.action
      ) {
        return false;
      }
      if (decision === "session") return approval.callerId === attribution.callerId;
      if (decision === "repo") return approval.repoPath === attribution.repoPath;
      return (
        approval.repoPath === attribution.repoPath &&
        approval.effectiveVersion === attribution.effectiveVersion
      );
    }, "once");
  }

  private resolveAttribution(
    caller: VerifiedCaller,
    credentialId?: string
  ): RequestAttribution | null {
    const callerId = caller.runtime.id;
    const identity = caller.code;
    if (!identity && credentialId) {
      return null;
    }
    if (!identity) {
      throw new ForwardRejection(403, `Unknown caller identity: ${callerId}`, "unknown-caller");
    }
    return {
      ...identity,
      policyKey: `${identity.repoPath}:${identity.callerId}`,
    };
  }

  private isCallerAllowed(
    credential: Credential,
    callerId: string,
    attribution: RequestAttribution | null,
    resource: CredentialSessionGrantResource
  ): boolean {
    const credentialId = credential.id ?? credential.connectionId;
    if (
      credentialId &&
      attribution &&
      this.sessionGrantStore.has(credentialId, attribution, resource)
    ) {
      return true;
    }
    return isCallerAllowed(credential, callerId, attribution, resource);
  }

  private credentialBindings(credential: Credential): CredentialBinding[] {
    if (credential.bindings?.length) {
      return credential.bindings;
    }
    return [];
  }

  private findCredentialBinding(
    credential: Credential,
    targetUrl: URL,
    use: CredentialBindingUse
  ): CredentialBinding | null {
    return (
      this.credentialBindings(credential).find(
        (binding) => binding.use === use && !!findMatchingUrlAudience(targetUrl, binding.audience)
      ) ?? null
    );
  }

  private async handleConnect(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    caller: VerifiedCaller | null
  ): Promise<void> {
    const startedAt = Date.now();
    const authority = req.url ?? "";
    const targetUrl = authority ? new URL(`https://${authority}`) : null;
    let authorization: Authorization | null = null;
    let status = 502;
    let settled = false;
    const finishAudit = async () => {
      if (settled) return;
      settled = true;
      await this.appendAuditEntry({
        ts: startedAt,
        workerId: authorization?.attribution?.repoPath ?? "unknown",
        callerId: authorization?.attribution?.callerId ?? caller?.runtime.id ?? "unknown",
        providerId: PASSTHROUGH_PROVIDER_ID,
        connectionId: PASSTHROUGH_CONNECTION_ID,
        method: "CONNECT",
        url: targetUrl?.toString() ?? "CONNECT",
        status,
        durationMs: Date.now() - startedAt,
        bytesIn: 0,
        bytesOut: 0,
        scopesUsed: [],
        retries: 0,
        breakerState: "closed",
      });
    };

    if (!caller || !targetUrl) {
      status = 403;
      await finishAudit();
      const body = "Direct egress proxy CONNECT requires an attributed workerd service";
      socket.end(
        `HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
      );
      return;
    }

    try {
      authorization = await this.authorizeRequest({
        caller,
        targetUrl,
        method: "CONNECT",
        credentialUse: "fetch",
      });
    } catch (error) {
      status = error instanceof ForwardRejection ? error.statusCode : 403;
      await finishAudit();
      const body = error instanceof Error ? error.message : "CONNECT egress denied";
      socket.end(
        `HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
      );
      return;
    }

    const port = targetUrl.port ? Number(targetUrl.port) : 443;
    const upstream = netConnect(port, targetUrl.hostname, () => {
      status = 200;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      void finishAudit();
    });

    upstream.on("error", () => {
      if (!socket.destroyed) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
      void finishAudit();
    });

    socket.on("error", () => {
      upstream.destroy();
      void finishAudit();
    });
  }

  private async handleWebSocketUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    caller: VerifiedCaller | null
  ): Promise<void> {
    const resolvedTargetUrl = this.resolveTargetUrl(req);
    let metadata: { targetUrl: URL; headerPairs: Array<[string, string]> } | null = null;
    try {
      metadata = resolvedTargetUrl ? extractNatStackWebSocketMetadata(resolvedTargetUrl) : null;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid NatStack WebSocket metadata";
      this.logWebSocketUpgradeDiagnostic("reject", {
        reason: "invalid_metadata",
        statusCode: 400,
        message,
        target: resolvedTargetUrl ? diagnosticWebSocketTarget(resolvedTargetUrl) : undefined,
      });
      this.rejectUpgrade(socket, 400, message);
      return;
    }
    const targetUrl = metadata?.targetUrl ?? null;
    if (!caller || !targetUrl) {
      this.logWebSocketUpgradeDiagnostic("reject", {
        reason: !caller ? "missing_attributed_caller" : "missing_target_url",
        statusCode: 403,
        target: targetUrl ? diagnosticWebSocketTarget(targetUrl) : undefined,
      });
      this.rejectUpgrade(socket, 403, "WebSocket egress requires an attributed workerd service");
      return;
    }
    const inputHeaders = mergeWebSocketMetadataHeaders(req.headers, metadata?.headerPairs ?? []);

    const policyUrl = websocketPolicyUrlFor(targetUrl);
    if (!policyUrl) {
      this.logWebSocketUpgradeDiagnostic("reject", {
        reason: "invalid_target_protocol",
        statusCode: 400,
        target: diagnosticWebSocketTarget(targetUrl),
      });
      this.rejectUpgrade(socket, 400, "WebSocket egress target URL is invalid");
      return;
    }

    try {
      await this.executeAuthorizedRequest({
        caller,
        method: "GET",
        targetUrl: policyUrl,
        inputHeaders,
        credentialUse: "fetch",
        replaySafe: false,
        maxRetries: 0,
        execute: async (preparedPolicyUrl, headers) => {
          const upstreamUrl = websocketUpstreamUrlFor(preparedPolicyUrl, targetUrl.protocol);
          const forwardHeaders = this.prepareWebSocketForwardHeaders(inputHeaders, headers);
          const result = await this.forwardWebSocketUpgrade(
            req,
            socket,
            head,
            upstreamUrl,
            forwardHeaders
          );
          return { ...result, payload: undefined };
        },
      });
    } catch (error) {
      if (!socket.destroyed) {
        const status = error instanceof ForwardRejection ? error.statusCode : 502;
        const message = error instanceof Error ? error.message : "WebSocket egress failed";
        this.logWebSocketUpgradeDiagnostic("reject", {
          reason:
            error instanceof ForwardRejection
              ? (error.code ?? "authorization_rejected")
              : "forward_failed",
          statusCode: status,
          message,
          target: diagnosticWebSocketTarget(targetUrl),
        });
        this.rejectUpgrade(socket, status, message);
      }
    }
  }

  private prepareWebSocketForwardHeaders(
    inputHeaders: IncomingHttpHeaders,
    preparedHeaders: OutgoingHttpHeaders
  ): OutgoingHttpHeaders {
    const headers: OutgoingHttpHeaders = { ...preparedHeaders };
    for (const headerName of [
      "sec-websocket-key",
      "sec-websocket-version",
      "sec-websocket-protocol",
      "sec-websocket-extensions",
    ]) {
      deleteDynamicProperty(headers, headerName);
    }
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";

    for (const headerName of [
      "sec-websocket-key",
      "sec-websocket-version",
      "sec-websocket-protocol",
    ]) {
      const value = inputHeaders[headerName];
      if (value !== undefined) {
        headers[headerName] = value;
      }
    }

    return headers;
  }

  private forwardWebSocketUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    targetUrl: URL,
    headers: OutgoingHttpHeaders
  ): Promise<ForwardResult> {
    return new Promise<ForwardResult>((resolve, reject) => {
      const requestUrl = websocketHttpUrlFor(targetUrl);
      const requestFn = requestUrl.protocol === "https:" ? httpsRequest : httpRequest;
      const defaultPort = requestUrl.protocol === "https:" ? 443 : 80;
      const requestHeaders = diagnosticWebSocketRequestHeaders(headers);
      let settled = false;
      let activeRequest: ReturnType<typeof httpRequest> | null = null;

      const settle = (result: ForwardResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const startAttempt = (family?: 4, fallbackFrom?: unknown) => {
        const upstreamRequest = requestFn({
          protocol: requestUrl.protocol,
          hostname: requestUrl.hostname,
          port: requestUrl.port ? Number(requestUrl.port) : defaultPort,
          method: req.method ?? "GET",
          path: `${requestUrl.pathname}${requestUrl.search}`,
          headers,
          ...(family ? { family } : {}),
        });

        activeRequest = upstreamRequest;

        upstreamRequest.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
          const statusCode = upstreamResponse.statusCode ?? 101;
          socket.write(serializeRawHttpResponseHead(statusCode, upstreamResponse.headers));
          if (upstreamHead.length > 0) {
            socket.write(upstreamHead);
          }
          if (head.length > 0) {
            upstreamSocket.write(head);
          }
          upstreamSocket.pipe(socket);
          socket.pipe(upstreamSocket);
          settle({ statusCode, bytesIn: 0, bytesOut: 0 });
        });

        upstreamRequest.on("response", (upstreamResponse) => {
          const statusCode = upstreamResponse.statusCode ?? 502;
          let diagnosticBodyBytes = 0;
          const diagnosticBodyChunks: Buffer[] = [];
          socket.write(
            serializeRawHttpResponseHead(
              statusCode,
              websocketNonUpgradeResponseHeaders(upstreamResponse.headers)
            )
          );
          upstreamResponse.on("data", (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (diagnosticBodyBytes < WEBSOCKET_DIAGNOSTIC_BODY_LIMIT) {
              const remaining = WEBSOCKET_DIAGNOSTIC_BODY_LIMIT - diagnosticBodyBytes;
              diagnosticBodyChunks.push(buffer.subarray(0, remaining));
              diagnosticBodyBytes += Math.min(buffer.byteLength, remaining);
            }
            socket.write(chunk);
          });
          upstreamResponse.on("end", () => {
            this.logWebSocketUpgradeDiagnostic("upstream_response", {
              reason: "upstream_non_upgrade_response",
              statusCode,
              target: diagnosticWebSocketTarget(targetUrl),
              requestHeaders,
              responseHeaders: diagnosticResponseHeaders(upstreamResponse.headers),
              body: Buffer.concat(diagnosticBodyChunks).toString("utf8"),
            });
            socket.end();
            settle({ statusCode, bytesIn: 0, bytesOut: 0 });
          });
          upstreamResponse.on("error", reject);
        });

        upstreamRequest.on("error", (error) => {
          if (settled) return;
          if (
            family === undefined &&
            !socket.destroyed &&
            shouldRetryWebSocketConnectWithIpv4(error, requestUrl)
          ) {
            this.logWebSocketUpgradeFallbackDiagnostic({
              reason: "initial_connect_failed_ipv4_fallback",
              target: diagnosticWebSocketTarget(targetUrl),
              requestHeaders,
              error: diagnosticThrownError(error),
            });
            startAttempt(4, error);
            return;
          }
          this.logWebSocketUpgradeDiagnostic("upstream_error", {
            reason: "upstream_request_error",
            target: diagnosticWebSocketTarget(targetUrl),
            requestHeaders,
            ...(family ? { family } : {}),
            message: error instanceof Error ? error.message : String(error),
            error: diagnosticThrownError(error),
            ...(fallbackFrom !== undefined
              ? { fallbackFrom: diagnosticThrownError(fallbackFrom) }
              : {}),
          });
          reject(error);
        });

        upstreamRequest.end();
      };

      socket.on("error", () => {
        activeRequest?.destroy();
      });
      startAttempt();
    });
  }

  private rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
    const body = message;
    socket.end(
      `HTTP/1.1 ${statusCode} ${httpStatusText(statusCode)}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    );
  }

  private logWebSocketUpgradeDiagnostic(
    phase: "reject" | "upstream_response" | "upstream_error",
    details: Record<string, unknown>
  ): void {
    console.warn("[EgressProxy] WebSocket upgrade failed", { phase, ...details });
  }

  private logWebSocketUpgradeFallbackDiagnostic(details: Record<string, unknown>): void {
    console.warn("[EgressProxy] WebSocket upgrade retrying with IPv4", {
      phase: "fallback",
      ...details,
    });
  }

  private async forwardHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    targetUrl: URL,
    headers: OutgoingHttpHeaders
  ): Promise<ForwardResult> {
    return new Promise<ForwardResult>((resolve, reject) => {
      const requestFn = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
      const defaultPort = targetUrl.protocol === "https:" ? 443 : 80;
      let statusCode = 502;
      let bytesIn = 0;
      let bytesOut = 0;
      let settled = false;

      const upstreamRequest = requestFn(
        {
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port ? Number(targetUrl.port) : defaultPort,
          method: req.method ?? "GET",
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers,
        },
        (upstreamResponse) => {
          statusCode = upstreamResponse.statusCode ?? 502;
          res.writeHead(statusCode, upstreamResponse.headers);
          upstreamResponse.on("data", (chunk: Buffer | string) => {
            bytesIn += Buffer.byteLength(chunk);
          });
          upstreamResponse.on("error", reject);
          res.on("finish", () => {
            if (!settled) {
              settled = true;
              resolve({ statusCode, bytesIn, bytesOut });
            }
          });
          res.on("close", () => {
            if (!settled) {
              settled = true;
              resolve({ statusCode, bytesIn, bytesOut });
            }
          });
          upstreamResponse.pipe(res);
        }
      );

      upstreamRequest.on("error", reject);
      req.on("error", reject);
      req.on("data", (chunk: Buffer | string) => {
        bytesOut += Buffer.byteLength(chunk);
      });
      req.pipe(upstreamRequest);
    });
  }

  private iterateHeaders(
    inputHeaders: IncomingHttpHeaders | Headers | Record<string, string | string[] | undefined>
  ): Array<[string, string | string[]]> {
    if (inputHeaders instanceof Headers) {
      return Array.from(inputHeaders.entries()).map(([name, value]) => [name, value]);
    }
    return Object.entries(inputHeaders).flatMap(([name, value]) => {
      if (value === undefined) {
        return [];
      }
      return [[name, value]];
    });
  }

  private readHeader(req: IncomingMessage, headerName: string): string | null {
    const value = req.headers[headerName];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const first = value.find((entry) => entry.trim());
      return first ? first.trim() : null;
    }
    return null;
  }

  private respondWithError(res: ServerResponse, statusCode: number, message: string): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: message }));
  }

  private async appendAuditEntry(entry: AuditEntry): Promise<void> {
    try {
      await Promise.resolve(this.deps.auditLog.append(entry));
    } catch {
      // Ignore audit write failures so the proxy response path stays reliable.
    }
  }
}

function renderOAuth1AuthorizationHeader(params: {
  method: string;
  targetUrl: URL;
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}): string {
  if (!params.consumerKey || !params.consumerSecret) {
    throw new Error("OAuth1 credential is missing consumer material");
  }
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: params.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: params.token,
    oauth_version: "1.0",
  };
  const signatureParams = new URLSearchParams(params.targetUrl.search);
  for (const [key, value] of Object.entries(oauthParams)) {
    signatureParams.append(key, value);
  }
  const normalizedParams = Array.from(signatureParams.entries())
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
    )
    .map(([key, value]) => `${oauthPercentEncode(key)}=${oauthPercentEncode(value)}`)
    .join("&");
  const baseUrl = new URL(params.targetUrl.toString());
  baseUrl.search = "";
  const signatureBase = [
    params.method.toUpperCase(),
    oauthPercentEncode(baseUrl.toString()),
    oauthPercentEncode(normalizedParams),
  ].join("&");
  const signingKey = `${oauthPercentEncode(params.consumerSecret)}&${oauthPercentEncode(params.tokenSecret)}`;
  oauthParams["oauth_signature"] = createHmac("sha1", signingKey)
    .update(signatureBase)
    .digest("base64");
  return (
    "OAuth " +
    Object.entries(oauthParams)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${oauthPercentEncode(key)}="${oauthPercentEncode(value)}"`)
      .join(", ")
  );
}

function oauthPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function createEgressProxy(deps: EgressProxyDeps): EgressProxy {
  return new EgressProxy(deps);
}

function isCallerAllowed(
  credential: Credential,
  callerId: string,
  attribution: RequestAttribution | null,
  resource: CredentialSessionGrantResource
): boolean {
  return !!credential.grants?.some(
    (grant) =>
      grant.bindingId === resource.bindingId &&
      grant.resource === resource.resource &&
      grant.action === resource.action &&
      ((grant.scope === "caller" && grant.callerId === callerId) ||
        (!!attribution &&
          ((grant.scope === "repo" && grant.repoPath === attribution.repoPath) ||
            (grant.scope === "version" &&
              grant.repoPath === attribution.repoPath &&
              grant.effectiveVersion === attribution.effectiveVersion))))
  );
}

function auditUrlFor(originalTargetUrl: URL, binding: CredentialBinding | null): string {
  if (binding?.injection.type !== "query-param") {
    return originalTargetUrl.toString();
  }
  const redacted = new URL(originalTargetUrl.toString());
  if (redacted.searchParams.has(binding.injection.name)) {
    redacted.searchParams.set(binding.injection.name, "[redacted]");
  }
  return redacted.toString();
}

function websocketPolicyUrlFor(targetUrl: URL): URL | null {
  const policyUrl = new URL(targetUrl.toString());
  if (policyUrl.protocol === "wss:") {
    policyUrl.protocol = "https:";
  } else if (policyUrl.protocol === "ws:") {
    policyUrl.protocol = "http:";
  } else if (policyUrl.protocol !== "https:" && policyUrl.protocol !== "http:") {
    return null;
  }
  return policyUrl;
}

function extractNatStackWebSocketMetadata(targetUrl: URL): {
  targetUrl: URL;
  headerPairs: Array<[string, string]>;
} {
  const cleanUrl = new URL(targetUrl.toString());
  const encodedHeaders = cleanUrl.searchParams.get(NATSTACK_WS_HEADERS_PARAM);
  cleanUrl.searchParams.delete(NATSTACK_WS_HEADERS_PARAM);
  return {
    targetUrl: cleanUrl,
    headerPairs: decodeNatStackWebSocketHeaderPairs(encodedHeaders),
  };
}

function decodeNatStackWebSocketHeaderPairs(value: string | null): Array<[string, string]> {
  if (!value) return [];
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    const pairs: Array<[string, string]> = [];
    for (const item of parsed) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [name, headerValue] = item;
      if (typeof name !== "string" || typeof headerValue !== "string") continue;
      const lower = name.toLowerCase();
      if (isBlockedNatStackWebSocketMetadataHeader(lower)) continue;
      pairs.push([lower, headerValue]);
    }
    return pairs;
  } catch {
    throw new Error("Invalid NatStack WebSocket metadata");
  }
}

function mergeWebSocketMetadataHeaders(
  inputHeaders: IncomingHttpHeaders,
  metadataHeaderPairs: Array<[string, string]>
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = { ...inputHeaders };
  // Strip any Origin created by the local WebSocket hop to this proxy. If the
  // model provider intended an Origin header, it arrives through metadata and is
  // restored below.
  delete headers.origin;
  if (metadataHeaderPairs.length === 0) return headers;
  for (const [name, value] of metadataHeaderPairs) {
    if (isBlockedNatStackWebSocketMetadataHeader(name)) continue;
    headers[name] = value;
  }
  return headers;
}

function isBlockedNatStackWebSocketMetadataHeader(name: string): boolean {
  return (
    HOP_BY_HOP_REQUEST_HEADERS.has(name) ||
    name === "authorization" ||
    name === "host" ||
    name === "sec-websocket-accept" ||
    name === "sec-websocket-extensions" ||
    name === "sec-websocket-key" ||
    name === "sec-websocket-protocol" ||
    name === "sec-websocket-version" ||
    INTERNAL_EGRESS_HEADERS.has(name)
  );
}

function websocketUpstreamUrlFor(preparedPolicyUrl: URL, originalProtocol: string): URL {
  const upstreamUrl = new URL(preparedPolicyUrl.toString());
  if (originalProtocol === "wss:" || originalProtocol === "ws:") {
    upstreamUrl.protocol = originalProtocol;
  }
  return upstreamUrl;
}

function websocketHttpUrlFor(upstreamUrl: URL): URL {
  const requestUrl = new URL(upstreamUrl.toString());
  if (requestUrl.protocol === "wss:") {
    requestUrl.protocol = "https:";
  } else if (requestUrl.protocol === "ws:") {
    requestUrl.protocol = "http:";
  }
  return requestUrl;
}

function diagnosticWebSocketTarget(targetUrl: URL): string {
  return `${targetUrl.protocol}//${targetUrl.host}${targetUrl.pathname}`;
}

function diagnosticResponseHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const safeHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      lower === "authorization" ||
      lower === "proxy-authorization" ||
      lower === "set-cookie" ||
      lower === "cookie"
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      safeHeaders[lower] = value.join(", ");
    } else if (value !== undefined) {
      safeHeaders[lower] = value;
    }
  }
  return safeHeaders;
}

function diagnosticWebSocketRequestHeaders(headers: OutgoingHttpHeaders): Record<string, string> {
  const safeHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === "proxy-authorization") {
      safeHeaders[lower] = diagnosticAuthorizationHeader(value);
      continue;
    }
    if (lower === "cookie") {
      safeHeaders[lower] = diagnosticCookieHeader(value);
      continue;
    }
    if (
      lower === "sec-websocket-key" ||
      lower === "chatgpt-account-id" ||
      lower === "x-api-key" ||
      lower === "api-key"
    ) {
      safeHeaders[lower] = "[redacted]";
      continue;
    }
    safeHeaders[lower] = diagnosticHeaderValue(value);
  }
  return safeHeaders;
}

const WEBSOCKET_IPV4_FALLBACK_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNREFUSED",
]);

export function shouldRetryWebSocketConnectWithIpv4(error: unknown, requestUrl: URL): boolean {
  if (requestUrl.hostname.length === 0 || isIP(requestUrl.hostname) !== 0) {
    return false;
  }
  if (webSocketConnectErrorCode(error)) return true;
  if (!(error instanceof AggregateError)) return false;
  const aggregateErrors = (error as AggregateError & { errors?: unknown[] })["errors"];
  return Array.isArray(aggregateErrors) && aggregateErrors.some(webSocketConnectErrorCode);
}

function webSocketConnectErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = (error as Error & Record<string, unknown>)["code"];
  return typeof code === "string" && WEBSOCKET_IPV4_FALLBACK_ERROR_CODES.has(code) ? code : null;
}

function diagnosticAuthorizationHeader(value: number | string | string[]): string {
  const normalized = diagnosticHeaderValue(value).trim();
  const scheme = normalized.match(/^([A-Za-z][A-Za-z0-9._~-]*)\s+/)?.[1];
  return scheme ? `${scheme} [redacted]` : "[redacted]";
}

function diagnosticCookieHeader(value: number | string | string[]): string {
  const normalized = diagnosticHeaderValue(value);
  const names = normalized
    .split(";")
    .map((item) => item.trim().split("=")[0]?.trim())
    .filter((name) => !!name);
  return names.length > 0 ? names.join("; ") : "[redacted]";
}

function diagnosticHeaderValue(value: number | string | string[]): string {
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function diagnosticThrownError(error: unknown): Record<string, unknown> | string {
  if (!(error instanceof Error)) return String(error);
  const details: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  const errorRecord = error as Error & Record<string, unknown>;
  const code = errorRecord["code"];
  const syscall = errorRecord["syscall"];
  const address = errorRecord["address"];
  const port = errorRecord["port"];
  if (typeof code === "string") details["code"] = code;
  if (typeof syscall === "string") details["syscall"] = syscall;
  if (typeof address === "string") details["address"] = address;
  if (typeof port === "number") details["port"] = port;
  if (error instanceof AggregateError) {
    const aggregateErrors = (error as AggregateError & { errors?: unknown[] })["errors"];
    if (Array.isArray(aggregateErrors)) {
      details["errors"] = aggregateErrors
        .slice(0, 5)
        .map((item) => diagnosticThrownErrorLine(item));
    }
  }
  const cause = (error as Error & { cause?: unknown })["cause"];
  if (cause !== undefined) details["cause"] = diagnosticThrownError(cause);
  return details;
}

function diagnosticThrownErrorLine(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const errorRecord = error as Error & Record<string, unknown>;
  const parts = [error.name];
  const code = errorRecord["code"];
  const syscall = errorRecord["syscall"];
  const address = errorRecord["address"];
  const port = errorRecord["port"];
  if (typeof code === "string") parts.push(`code=${code}`);
  if (typeof syscall === "string") parts.push(`syscall=${syscall}`);
  if (typeof address === "string") parts.push(`address=${address}`);
  if (typeof port === "number") parts.push(`port=${port}`);
  if (error.message) parts.push(`message=${error.message}`);
  return parts.join(" ");
}

function websocketNonUpgradeResponseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = { ...headers };
  delete forwarded["transfer-encoding"];
  forwarded.connection = "close";
  return forwarded;
}

function serializeRawHttpResponseHead(statusCode: number, headers: IncomingHttpHeaders): string {
  const lines = [`HTTP/1.1 ${statusCode} ${httpStatusText(statusCode)}`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function httpStatusText(statusCode: number): string {
  if (statusCode === 101) return "Switching Protocols";
  if (statusCode === 400) return "Bad Request";
  if (statusCode === 403) return "Forbidden";
  if (statusCode === 502) return "Bad Gateway";
  return "Error";
}

function describeGitHttpOperation(
  targetUrl: URL,
  method: string
): {
  action: "read" | "write";
  label: string;
  remote: string;
  service?: string;
} {
  const service =
    targetUrl.searchParams.get("service") ?? gitHostServiceFromPath(targetUrl.pathname);
  const action = service === "git-receive-pack" ? "write" : "read";
  return {
    action,
    label: action === "write" ? "git push" : gitReadLabel(service, method),
    remote: gitRemoteFromUrl(targetUrl),
    service: service ?? undefined,
  };
}

function gitHostServiceFromPath(pathname: string): string | null {
  if (pathname.endsWith("/git-receive-pack")) return "git-receive-pack";
  if (pathname.endsWith("/git-upload-pack")) return "git-upload-pack";
  return null;
}

function gitReadLabel(service: string | null, method: string): string {
  if (service === "git-upload-pack") {
    return method.toUpperCase() === "POST" ? "git fetch" : "git clone or pull";
  }
  return "git clone or pull";
}

function gitRemoteFromUrl(targetUrl: URL): string {
  const remote = new URL(targetUrl.origin);
  let pathname = targetUrl.pathname;
  pathname = pathname.replace(/\/(?:info\/refs|git-upload-pack|git-receive-pack)$/, "");
  remote.pathname = pathname || "/";
  return remote.toString();
}

function credentialUseResource(
  binding: CredentialBinding,
  targetUrl: URL,
  method: string
): {
  resource: string;
  action: CredentialGrantAction;
  sessionResource: CredentialSessionGrantResource;
} {
  const resource =
    binding.use === "git-http" || binding.use === "git-ssh"
      ? gitRemoteFromUrl(targetUrl)
      : (findMatchingUrlAudience(targetUrl, binding.audience)?.url ?? targetUrl.origin);
  const action: CredentialGrantAction =
    binding.use === "git-http" || binding.use === "git-ssh"
      ? describeGitHttpOperation(targetUrl, method).action
      : "use";
  return {
    resource,
    action,
    sessionResource: {
      bindingId: binding.id,
      resource,
      action,
    },
  };
}

function hasOAuthAudienceDomainMismatch(
  audiences: readonly { url: string }[],
  oauthOrigins: readonly (string | undefined)[]
): boolean | undefined {
  const oauthDomains = oauthOrigins
    .filter((origin): origin is string => typeof origin === "string" && origin.length > 0)
    .map(registrableDomainForUrl)
    .filter((domain): domain is string => !!domain);
  if (oauthDomains.length === 0) {
    return undefined;
  }
  const audienceDomains = audiences
    .map((audience) => registrableDomainForUrl(audience.url))
    .filter((domain): domain is string => !!domain);
  if (audienceDomains.length === 0) {
    return undefined;
  }
  return oauthDomains.some((oauthDomain) => !audienceDomains.includes(oauthDomain));
}

function registrableDomainForUrl(raw: string): string | null {
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    if (hostname === "localhost" || /^[\d.]+$/.test(hostname) || hostname.includes(":")) {
      return hostname;
    }
    const parts = hostname.split(".").filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join(".") : hostname;
  } catch {
    return null;
  }
}

function executionPolicyKey(authorization: Authorization | null, targetUrl: URL): string {
  const caller = authorization?.attribution?.policyKey ?? "anonymous";
  const credential = authorization?.connectionId ?? targetUrl.origin;
  return `${caller}:${credential}`;
}

function shouldRetryRequest(method: string, replaySafe = false): boolean {
  return replaySafe || ["GET", "HEAD", "OPTIONS", "TRACE"].includes(method.toUpperCase());
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 429 || statusCode === 502 || statusCode === 503 || statusCode === 504;
}

function backoffDelayMs(attempt: number): number {
  const jitter = Math.floor(Math.random() * 25);
  return (
    Math.min(DEFAULT_RETRY_MAX_DELAY_MS, DEFAULT_RETRY_INITIAL_DELAY_MS * 2 ** (attempt - 1)) +
    jitter
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCircuitState(
  circuits: Map<string, CircuitState>,
  key: string
): AuditEntry["breakerState"] {
  const state = circuits.get(key);
  if (!state) {
    return "closed";
  }
  if (state.state === "open" && state.openedAt && Date.now() - state.openedAt >= CIRCUIT_OPEN_MS) {
    state.state = "half-open";
  }
  return state.state;
}

function recordCircuitSuccess(circuits: Map<string, CircuitState>, key: string): void {
  circuits.set(key, { failures: 0, state: "closed" });
}

function recordCircuitFailure(circuits: Map<string, CircuitState>, key: string): void {
  const current = circuits.get(key) ?? { failures: 0, state: "closed" as const };
  const failures = current.failures + 1;
  circuits.set(
    key,
    failures >= CIRCUIT_FAILURE_THRESHOLD
      ? { failures, state: "open", openedAt: Date.now() }
      : {
          failures,
          state: current.state === "half-open" ? "open" : "closed",
          openedAt: current.openedAt,
        }
  );
}

function renderCookieSessionHeader(credential: Credential, targetUrl: URL): string {
  if (!credential.cookieSession?.cookies?.length) {
    return credential.cookieHeader ?? credential.accessToken;
  }
  const nowSeconds = Date.now() / 1000;
  const pairs = credential.cookieSession.cookies
    .filter((cookie) => {
      if (!cookie.name || !cookie.value) return false;
      if (cookie.secure && targetUrl.protocol !== "https:") return false;
      if (
        typeof cookie.expirationDate === "number" &&
        cookie.expirationDate > 0 &&
        cookie.expirationDate <= nowSeconds
      ) {
        return false;
      }
      return (
        cookieDomainMatches(cookie.domain, targetUrl.hostname) &&
        cookiePathMatches(cookie.path, targetUrl.pathname)
      );
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`);
  return pairs.join("; ");
}

function cookieDomainMatches(domain: string | undefined, hostname: string): boolean {
  if (!domain) return true;
  const normalizedDomain = domain.replace(/^\./, "").toLowerCase();
  const normalizedHost = hostname.toLowerCase();
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function cookiePathMatches(cookiePath: string | undefined, requestPath: string): boolean {
  const normalizedCookiePath = cookiePath && cookiePath.startsWith("/") ? cookiePath : "/";
  if (normalizedCookiePath === "/") return true;
  return (
    requestPath === normalizedCookiePath ||
    requestPath.startsWith(
      normalizedCookiePath.endsWith("/") ? normalizedCookiePath : `${normalizedCookiePath}/`
    )
  );
}

function applyAwsSigV4Authorization(params: {
  method: string;
  targetUrl: URL;
  headers: OutgoingHttpHeaders;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  service: string;
  region: string;
}): void {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  params.headers.host = params.targetUrl.host;
  params.headers["x-amz-date"] = amzDate;
  params.headers["x-amz-content-sha256"] = "UNSIGNED-PAYLOAD";
  if (params.sessionToken) {
    params.headers["x-amz-security-token"] = params.sessionToken;
  }
  const canonicalHeaders = canonicalAwsHeaders(params.headers);
  const canonicalQuery = Array.from(params.targetUrl.searchParams.entries())
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
    )
    .map(([key, value]) => `${awsPercentEncode(key)}=${awsPercentEncode(value)}`)
    .join("&");
  const canonicalRequest = [
    params.method.toUpperCase(),
    params.targetUrl.pathname || "/",
    canonicalQuery,
    canonicalHeaders.headerBlock,
    canonicalHeaders.signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const credentialScope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const signingKey = awsSigningKey(
    params.secretAccessKey,
    dateStamp,
    params.region,
    params.service
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  params.headers.authorization = [
    `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${canonicalHeaders.signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");
}

function canonicalAwsHeaders(headers: OutgoingHttpHeaders): {
  headerBlock: string;
  signedHeaders: string;
} {
  const entries = Object.entries(headers)
    .flatMap(([name, value]) => {
      if (value === undefined) return [];
      const rendered = Array.isArray(value) ? value.join(",") : String(value);
      return [[name.toLowerCase(), rendered.trim().replace(/\s+/g, " ")] as const];
    })
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    headerBlock: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signedHeaders: entries.map(([name]) => name).join(";"),
  };
}

function awsSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
): Buffer {
  const dateKey = createHmac("sha256", `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const regionKey = createHmac("sha256", dateKey).update(region).digest();
  const serviceKey = createHmac("sha256", regionKey).update(service).digest();
  return createHmac("sha256", serviceKey).update("aws4_request").digest();
}

function awsPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function grantForDecision(
  callerId: string,
  attribution: RequestAttribution,
  decision: Exclude<GrantedDecision, "deny" | "once" | "session">,
  grantedAt: number,
  binding: CredentialBinding,
  usage: ReturnType<typeof credentialUseResource>
): CredentialUseGrant {
  const base = {
    bindingId: binding.id,
    use: binding.use,
    resource: usage.resource,
    action: usage.action,
    grantedAt,
    grantedBy: decision,
  };
  if (decision === "repo") {
    return { ...base, scope: "repo", repoPath: attribution.repoPath };
  }
  if (decision === "version") {
    return {
      ...base,
      scope: "version",
      repoPath: attribution.repoPath,
      effectiveVersion: attribution.effectiveVersion,
    };
  }
  return { ...base, scope: "caller", callerId };
}

function upsertCredentialUseGrant(
  grants: CredentialUseGrant[],
  grant: CredentialUseGrant
): CredentialUseGrant[] {
  return [
    ...grants.filter((entry) => credentialUseGrantKey(entry) !== credentialUseGrantKey(grant)),
    grant,
  ];
}

function credentialUseGrantKey(grant: CredentialUseGrant): string {
  return [
    grant.bindingId,
    grant.use,
    grant.resource,
    grant.action,
    grant.scope,
    grant.callerId ?? "",
    grant.repoPath ?? "",
    grant.effectiveVersion ?? "",
  ].join("\x00");
}
