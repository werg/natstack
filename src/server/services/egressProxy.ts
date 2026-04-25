import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  Server,
  ServerResponse,
} from "node:http";
import { connect as netConnect } from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import type {
  ConsentGrant,
  Credential,
  ProviderManifest,
  RetryConfig,
} from "../../../packages/shared/src/credentials/types.js";
import type { RateLimiter } from "../../../packages/shared/src/credentials/rateLimit.js";
import type { AuditLog } from "../../../packages/shared/src/credentials/audit.js";
import { calculateBackoff, DEFAULT_RETRY_CONFIG } from "../../../packages/shared/src/credentials/retry.js";
import type { CodeIdentityResolver, ResolvedCodeIdentity } from "./codeIdentityResolver.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CarrierLocation, ResolvedCapability } from "./capabilityBroker.js";
import { credentialMatchesProviderBinding } from "../../../packages/shared/src/credentials/providerBinding.js";

type AuditEntry = Parameters<AuditLog["append"]>[0];
type BreakerState = AuditEntry["breakerState"];

const PASSTHROUGH_PROVIDER_ID = "passthrough";
const PASSTHROUGH_CONNECTION_ID = "passthrough";

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

export interface CredentialStore {
  load(providerId: string, connectionId: string): Promise<Credential | null> | Credential | null;
  list(providerId?: string): Promise<Credential[]> | Credential[];
}

export interface ConsentStore {
  check(query: {
    repoPath: string;
    effectiveVersion: string;
    providerId: string;
    providerFingerprint: string;
  }): Promise<ConsentGrant | null> | ConsentGrant | null;
  grant(grant: ConsentGrant): Promise<void> | void;
}

export interface EgressRateLimiter {
  getLimiter(
    key: string,
    provider?: ProviderManifest,
    connectionId?: string,
  ): Pick<RateLimiter, "tryConsume" | "recordRetryAfter">;
}

export interface CircuitBreaker {
  canRequest(key: string, provider?: ProviderManifest): Promise<boolean> | boolean;
  recordSuccess(key: string, provider?: ProviderManifest): Promise<void> | void;
  recordFailure(key: string, error?: unknown, provider?: ProviderManifest): Promise<void> | void;
  getState(key: string, provider?: ProviderManifest): Promise<BreakerState> | BreakerState;
}

export interface EgressProxyDeps {
  credentialStore: CredentialStore;
  consentStore: ConsentStore;
  auditLog: Pick<AuditLog, "append">;
  rateLimiter: EgressRateLimiter;
  circuitBreaker: CircuitBreaker;
  codeIdentityResolver: Pick<CodeIdentityResolver, "resolveByCallerId">;
  approvalQueue: ApprovalQueue;
  capabilityBroker: import("./capabilityBroker.js").CapabilityBroker;
}

interface RequestAttribution extends ResolvedCodeIdentity {
  rateLimitKey: string;
}

interface CapabilityAuthorization {
  attribution: RequestAttribution | null;
  provider: ProviderManifest | null;
  credential: Credential | null;
  connectionId: string | null;
  scopes: string[];
  carrier?: CarrierLocation;
  capId?: string;
}

interface ForwardResult {
  statusCode: number;
  bytesIn: number;
  bytesOut: number;
  retryAfterMs?: number;
}

interface RequestExecutionResult<T> extends ForwardResult {
  payload: T;
}

class ForwardRejection extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly capabilityViolation?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class EgressProxy {
  private server: Server | null = null;

  constructor(private readonly deps: EgressProxyDeps) {}

  async start(): Promise<number> {
    if (this.server) {
      const currentAddress = this.server.address();
      if (currentAddress && typeof currentAddress !== "string") {
        return currentAddress.port;
      }
    }

    const server = createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    server.on("connect", (req, socket, head) => {
      void this.handleConnect(req, socket as Duplex, head);
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

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;

    if (!server) {
      return;
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  async forwardProxyFetch(params: {
    callerId: string;
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
  }> {
    const body = params.body;
    const bytesOut = body ? Buffer.byteLength(body) : 0;
    const result = await this.executeAuthorizedRequest({
      callerId: params.callerId,
      method: params.method.toUpperCase(),
      targetUrl: new URL(params.url),
      inputHeaders: params.headers ?? {},
      initialBytesOut: bytesOut,
      replaySafe: true,
      execute: async (targetUrl, headers) => {
        const response = await fetch(targetUrl.toString(), {
          method: params.method,
          headers: headers as HeadersInit,
          body,
        });
        const responseBody = await response.text();
        return {
          statusCode: response.status,
          bytesIn: Buffer.byteLength(responseBody),
          bytesOut,
          retryAfterMs: parseRetryAfterHeader(response.headers.get("retry-after")),
          payload: {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            body: responseBody,
          },
        };
      },
    });
    return result;
  }

  public prepareForwardRequest(
    targetUrl: URL,
    inputHeaders: IncomingHttpHeaders | Headers | Record<string, string | string[] | undefined>,
    credential?: Credential,
    manifest?: ProviderManifest,
    carrier?: CarrierLocation,
  ): { headers: OutgoingHttpHeaders; targetUrl: URL } {
    const headers: OutgoingHttpHeaders = {};

    if (carrier?.kind === "query") {
      const modified = new URL(targetUrl.toString());
      modified.searchParams.delete(carrier.name);
      targetUrl = modified;
    }

    for (const [name, value] of this.iterateHeaders(inputHeaders)) {
      if (value === undefined) {
        continue;
      }
      if (HOP_BY_HOP_REQUEST_HEADERS.has(name.toLowerCase())) {
        continue;
      }
      if (carrier?.kind === "header" && name.toLowerCase() === carrier.name.toLowerCase()) {
        continue;
      }
      headers[name.toLowerCase()] = value;
    }

    if (credential) {
      const injection = manifest?.authInjection;
      for (const headerName of injection?.stripHeaders ?? ["authorization"]) {
        delete headers[headerName.toLowerCase()];
      }

      if (injection?.type === "query-param" && injection.paramName) {
        const modified = new URL(targetUrl.toString());
        modified.searchParams.set(injection.paramName, credential.accessToken);
        targetUrl = modified;
      } else {
        const headerName = (injection?.headerName ?? "authorization").toLowerCase();
        const template = injection?.valueTemplate ?? "Bearer {token}";
        headers[headerName] = template.replace("{token}", credential.accessToken);
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

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const targetUrl = this.resolveTargetUrl(req);
    if (!targetUrl) {
      this.respondWithError(res, 400, "Proxy request URL is invalid");
      return;
    }

    // "Client went away before receiving a response." res.on("close") fires
    // iff the response wasn't fully written; we guard with !writableEnded so a
    // normal completed response does not look like an abort. req.on("close")
    // would fire on request-body end even for a pending GET.
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });

    try {
      await this.executeAuthorizedRequest({
        method: (req.method ?? "GET").toUpperCase(),
        targetUrl,
        inputHeaders: req.headers,
        signal: ac.signal,
        execute: async (preparedUrl, headers) => {
          const forwardResult = await this.forwardHttpRequest(req, res, preparedUrl, headers);
          return { ...forwardResult, payload: undefined };
        },
      });
    } catch (error) {
      if (error instanceof ForwardRejection) {
        const headers = error.statusCode === 429 && typeof error.retryAfterMs === "number"
          ? { "Retry-After": String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) }
          : undefined;
        this.respondWithError(res, error.statusCode, error.message, headers);
        return;
      }
      if (!res.headersSent) {
        this.respondWithError(res, 502, "Failed to forward proxy request");
      }
    }
  }

  private async executeAuthorizedRequest<T>(params: {
    callerId?: string | null;
    method: string;
    targetUrl: URL;
    inputHeaders: IncomingHttpHeaders | Headers | Record<string, string | string[] | undefined>;
    initialBytesOut?: number;
    replaySafe?: boolean;
    signal?: AbortSignal;
    execute: (targetUrl: URL, headers: OutgoingHttpHeaders) => Promise<RequestExecutionResult<T>>;
  }): Promise<T> {
    const startedAt = Date.now();
    let provider: ProviderManifest | null = null;
    let authorization: CapabilityAuthorization | null = null;
    let targetUrl = params.targetUrl;
    let statusCode = 500;
    let bytesIn = 0;
    let bytesOut = params.initialBytesOut ?? 0;
    let capabilityViolation: string | undefined;
    let breakerState: BreakerState = "closed";
    let breakerKey: string | null = null;
    let retries = 0;

    try {
      authorization = await this.authorizeCapabilityRequest({
        callerId: params.callerId ?? null,
        targetUrl,
        inputHeaders: params.inputHeaders,
      });
      provider = authorization.provider;
      if (provider && authorization.connectionId) {
        breakerKey = `${provider.id}:${authorization.connectionId}`;
      }

      const limiter = authorization.attribution
        ? this.deps.rateLimiter.getLimiter(
            authorization.attribution.rateLimitKey,
            provider ?? undefined,
            authorization.connectionId ?? undefined,
          )
        : null;
      const maxAttempts = shouldUseSafeRetries(params.replaySafe, params.method, provider?.retry)
        ? Math.max(1, provider?.retry?.maxAttempts ?? DEFAULT_RETRY_CONFIG.maxAttempts)
        : 1;
      const totalAttempts = maxAttempts + 1;
      let credential = authorization.credential ?? undefined;
      let attempted401Recovery = false;

      for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        if (limiter) {
          const rateLimitResult = limiter.tryConsume();
          if (!rateLimitResult.allowed) {
            throw new ForwardRejection(429, "Rate limit exceeded", undefined, rateLimitResult.retryAfterMs);
          }
        }

        if (breakerKey) {
          const canRequest = await Promise.resolve(this.deps.circuitBreaker.canRequest(breakerKey, provider ?? undefined));
          breakerState = await Promise.resolve(this.deps.circuitBreaker.getState(breakerKey, provider ?? undefined));
          if (!canRequest) {
            throw new ForwardRejection(503, "Circuit breaker is open");
          }
        }

        const prepared = this.prepareForwardRequest(
          params.targetUrl,
          params.inputHeaders,
          credential,
          provider ?? undefined,
          authorization.carrier,
        );
        targetUrl = prepared.targetUrl;

        try {
          const result = await params.execute(targetUrl, prepared.headers);
          statusCode = result.statusCode;
          bytesIn = result.bytesIn;
          bytesOut = result.bytesOut;

          if (limiter && statusCode === 429 && typeof result.retryAfterMs === "number") {
            limiter.recordRetryAfter(Math.ceil(result.retryAfterMs / 1000));
          }

          if (
            statusCode === 401 &&
            provider &&
            authorization &&
            !attempted401Recovery
          ) {
            attempted401Recovery = true;
            const refreshed = await this.reloadCredentialIfChanged(
              provider.id,
              authorization.connectionId!,
              credential?.accessToken,
              provider,
            );
            if (refreshed) {
              credential = refreshed;
              retries += 1;
              continue;
            }
          }

          if (statusCode >= 500 && attempt < maxAttempts) {
            retries += 1;
            await sleep(calculateBackoff(attempt, provider?.retry));
            continue;
          }

          if (breakerKey) {
            if (statusCode >= 500) {
              await Promise.resolve(
                this.deps.circuitBreaker.recordFailure(
                  breakerKey,
                  new Error(`Upstream request failed with status ${statusCode}`),
                  provider ?? undefined,
                ),
              );
            } else {
              await Promise.resolve(this.deps.circuitBreaker.recordSuccess(breakerKey, provider ?? undefined));
            }
            breakerState = await Promise.resolve(this.deps.circuitBreaker.getState(breakerKey, provider ?? undefined));
          }

          return result.payload;
        } catch (error) {
          if (attempt < maxAttempts) {
            retries += 1;
            await sleep(calculateBackoff(attempt, provider?.retry));
            continue;
          }
          throw error;
        }
      }

      throw new Error("Request retry loop exhausted unexpectedly");
    } catch (error) {
      if (error instanceof ForwardRejection) {
        statusCode = error.statusCode;
        capabilityViolation = error.capabilityViolation;
        throw error;
      }

      if (breakerKey) {
        await Promise.resolve(this.deps.circuitBreaker.recordFailure(breakerKey, error, provider ?? undefined));
        breakerState = await Promise.resolve(this.deps.circuitBreaker.getState(breakerKey, provider ?? undefined));
      }
      throw error;
    } finally {
      await this.appendAuditEntry({
        ts: startedAt,
        workerId: authorization?.attribution?.repoPath ?? "unknown",
        callerId: authorization?.attribution?.callerId ?? "unknown",
        providerId: provider?.id ?? PASSTHROUGH_PROVIDER_ID,
        connectionId: authorization?.connectionId ?? PASSTHROUGH_CONNECTION_ID,
        method: params.method,
        url: targetUrl.toString(),
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

  private async handleConnect(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const startedAt = Date.now();
    const authority = req.url ?? "";
    const [host, portStr] = authority.split(":");
    const port = parseInt(portStr || "443", 10);
    let auditStatus = 502;
    let auditSettled = false;

    const appendConnectAudit = async (): Promise<void> => {
      if (auditSettled) {
        return;
      }
      auditSettled = true;
      await this.appendAuditEntry({
        ts: startedAt,
        workerId: "unknown",
        callerId: "unknown",
        providerId: PASSTHROUGH_PROVIDER_ID,
        connectionId: PASSTHROUGH_CONNECTION_ID,
        method: "CONNECT",
        url: authority ? `https://${authority}` : "CONNECT",
        status: auditStatus,
        durationMs: Date.now() - startedAt,
        bytesIn: 0,
        bytesOut: 0,
        scopesUsed: [],
        retries: 0,
        breakerState: "closed",
      });
    };

    // Attribution is optional for CONNECT — unattributed tunnels flow through.
    // The proxy cannot inject credentials into a TLS tunnel anyway, so there is
    // no credential-leakage risk in allowing uncredentialed tunnels.

    const upstream = netConnect(port, host || authority, () => {
      auditStatus = 200;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(socket);
      socket.pipe(upstream);
      void appendConnectAudit();
    });

    upstream.on("error", () => {
      if (!socket.destroyed) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
      void appendConnectAudit();
    });

    socket.on("error", () => {
      upstream.destroy();
      void appendConnectAudit();
    });
  }

  private async authorizeCapabilityRequest(params: {
    callerId: string | null;
    targetUrl: URL;
    inputHeaders: IncomingHttpHeaders | Headers | Record<string, string | string[] | undefined>;
  }): Promise<CapabilityAuthorization> {
    const found = this.deps.capabilityBroker.resolveFromRequest(params.inputHeaders, params.targetUrl);

    if (found) {
      return this.authorizeResolvedCapability(found.entry, found.carrier, params.targetUrl);
    }

    const attribution = params.callerId ? this.resolveAttribution(params.callerId) : null;
    return {
      attribution,
      provider: null,
      credential: null,
      connectionId: null,
      scopes: [],
    };
  }

  private async authorizeResolvedCapability(
    entry: ResolvedCapability,
    carrier: CarrierLocation,
    targetUrl: URL,
  ): Promise<CapabilityAuthorization> {
    const attribution = this.resolveAttribution(entry.callerId);

    if (entry.kind === "session") {
      return {
        attribution,
        provider: null,
        credential: null,
        connectionId: null,
        scopes: [],
        carrier,
        capId: entry.capId,
      };
    }

    if (!entry.providerId || !entry.connectionId) {
      throw new ForwardRejection(401, "capability-required", "capability-required");
    }

    const provider = entry.provider;
    if (!provider || !manifestMatchesUrl(provider, targetUrl)) {
      throw new ForwardRejection(403, "capability-provider-mismatch", "capability-provider-mismatch");
    }

    const credential = await Promise.resolve(
      this.deps.credentialStore.load(entry.providerId, entry.connectionId),
    );
    if (!credential) {
      throw new ForwardRejection(403, "consent-revoked", "consent-revoked");
    }
    if (!credentialMatchesProviderBinding(credential, provider)) {
      throw new ForwardRejection(403, "credential-audience-mismatch", "credential-audience-mismatch");
    }

    return {
      attribution,
      provider,
      credential,
      connectionId: entry.connectionId,
      scopes: credential.scopes,
      carrier,
      capId: entry.capId,
    };
  }

  private resolveAttribution(callerId: string): RequestAttribution {
    const identity = this.deps.codeIdentityResolver.resolveByCallerId(callerId);
    if (!identity) {
      throw new ForwardRejection(403, `Unknown caller identity: ${callerId}`, "unknown-caller");
    }
    return {
      ...identity,
      rateLimitKey: `${identity.repoPath}:${identity.callerId}`,
    };
  }

  private async forwardHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    targetUrl: URL,
    headers: OutgoingHttpHeaders,
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
          const retryAfterMs = parseRetryAfterHeader(upstreamResponse.headers["retry-after"]);

          upstreamResponse.on("data", (chunk: Buffer | string) => {
            bytesIn += Buffer.byteLength(chunk);
          });
          upstreamResponse.on("error", reject);
          res.on("finish", () => {
            if (settled) {
              return;
            }
            settled = true;
            resolve({ statusCode, bytesIn, bytesOut, retryAfterMs });
          });
          res.on("close", () => {
            if (settled) {
              return;
            }
            settled = true;
            resolve({ statusCode, bytesIn, bytesOut, retryAfterMs });
          });
          upstreamResponse.pipe(res);
        },
      );

      upstreamRequest.on("error", reject);
      req.on("error", reject);
      req.on("data", (chunk: Buffer | string) => {
        bytesOut += Buffer.byteLength(chunk);
      });
      req.pipe(upstreamRequest);
    });
  }

  private async reloadCredentialIfChanged(
    providerId: string,
    connectionId: string,
    currentAccessToken?: string,
    provider?: ProviderManifest,
  ): Promise<Credential | null> {
    if (connectionId.startsWith("env:")) {
      return null;
    }

    const latest = await Promise.resolve(this.deps.credentialStore.load(providerId, connectionId));
    if (!latest || latest.accessToken === currentAccessToken) {
      return null;
    }
    if (provider && !credentialMatchesProviderBinding(latest, provider)) {
      return null;
    }

    return latest;
  }

  private iterateHeaders(
    inputHeaders: IncomingHttpHeaders | Headers | Record<string, string | string[] | undefined>,
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

  private respondWithError(
    res: ServerResponse,
    statusCode: number,
    message: string,
    headers: Record<string, string> = {},
  ): void {
    if (res.headersSent) {
      res.end();
      return;
    }

    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    });
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

export function createEgressProxy(deps: EgressProxyDeps): EgressProxy {
  return new EgressProxy(deps);
}

function shouldUseSafeRetries(
  replaySafe: boolean | undefined,
  method: string,
  retryConfig?: RetryConfig,
): boolean {
  if (!replaySafe) {
    return false;
  }
  if (retryConfig?.idempotentOnly === false) {
    return true;
  }
  return isIdempotentMethod(method);
}

function isIdempotentMethod(method: string): boolean {
  return method === "GET"
    || method === "HEAD"
    || method === "OPTIONS"
    || method === "PUT"
    || method === "DELETE";
}

function manifestMatchesUrl(manifest: ProviderManifest, targetUrl: URL | string): boolean {
  const target = typeof targetUrl === "string" ? new URL(targetUrl) : targetUrl;
  return manifest.apiBase.some((apiBase) => {
    try {
      const baseUrl = new URL(apiBase);
      const normalizedBasePath = trimTrailingSlash(baseUrl.pathname);
      const normalizedTargetPath = trimTrailingSlash(target.pathname);
      const hostMatches = baseUrl.host === target.host;
      const pathMatches =
        normalizedBasePath === "" ||
        normalizedBasePath === "/" ||
        normalizedTargetPath === normalizedBasePath ||
        normalizedTargetPath.startsWith(`${normalizedBasePath}/`);

      return hostMatches && pathMatches;
    } catch {
      return apiBase === target.host || target.toString().startsWith(apiBase);
    }
  });
}

function trimTrailingSlash(value: string): string {
  if (value.length <= 1) return value;
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parseRetryAfterHeader(value: string | string[] | null | undefined): number | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  if (!header) {
    return undefined;
  }

  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds) * 1000;
  }

  const date = Date.parse(header);
  if (Number.isNaN(date)) {
    return undefined;
  }

  return Math.max(0, date - Date.now());
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
