import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { checkCapability } from "../../../packages/shared/src/credentials/capability.js";
import type {
  ConsentGrant,
  Credential,
  EndpointDeclaration,
  ProviderManifest,
} from "../../../packages/shared/src/credentials/types.js";
import type { RateLimiter } from "../../../packages/shared/src/credentials/rateLimit.js";
import type { AuditLog } from "../../../packages/shared/src/credentials/audit.js";

type AuditEntry = Parameters<AuditLog["append"]>[0];
type BreakerState = AuditEntry["breakerState"];

const WORKER_ID_HEADER = "x-natstack-worker-id";
const PROXY_AUTH_HEADER = "x-natstack-proxy-auth";
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
  WORKER_ID_HEADER,
  PROXY_AUTH_HEADER,
]);

export interface CredentialStore {
  getCredential(connectionId: string): Promise<Credential | null> | Credential | null;
}

export interface ConsentStore {
  list(workerId: string): Promise<ConsentGrant[]> | ConsentGrant[];
}

export interface ProviderRegistry {
  listProviderManifests(): Promise<ProviderManifest[]> | ProviderManifest[];
  getCapabilityDeclarations(
    providerId: string,
    scopes: readonly string[],
  ): Promise<EndpointDeclaration[]> | EndpointDeclaration[];
}

export interface EgressRateLimiter {
  getLimiter(key: string, provider?: ProviderManifest): Pick<RateLimiter, "tryConsume">;
}

export interface CircuitBreaker {
  canRequest(key: string): Promise<boolean> | boolean;
  recordSuccess(key: string): Promise<void> | void;
  recordFailure(key: string, error?: unknown): Promise<void> | void;
  getState(key: string): Promise<BreakerState> | BreakerState;
}

export interface EgressProxyDeps {
  credentialStore: CredentialStore;
  consentStore: ConsentStore;
  providerRegistry: ProviderRegistry;
  auditLog: Pick<AuditLog, "append">;
  rateLimiter: EgressRateLimiter;
  circuitBreaker: CircuitBreaker;
}

interface RequestAttribution {
  workerId: string;
  callerId: string;
  rateLimitKey: string;
}

interface AuthorizationResult {
  grant: ConsentGrant;
  credential: Credential;
}

interface AuthorizationError {
  statusCode: number;
  message: string;
}

interface ForwardResult {
  statusCode: number;
  bytesIn: number;
  bytesOut: number;
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
      void this.handleConnect(req, socket as import("node:stream").Duplex, head);
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

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const method = (req.method ?? "GET").toUpperCase();
    const attribution = this.attributeRequest(req);
    let targetUrl = this.resolveTargetUrl(req);
    let provider: ProviderManifest | null = null;
    let authorization: AuthorizationResult | null = null;
    let statusCode = 500;
    let bytesIn = 0;
    let bytesOut = 0;
    let capabilityViolation: string | undefined;
    let breakerState: BreakerState = "closed";
    let breakerKey: string | null = null;

    try {
      if (!attribution) {
        statusCode = 407;
        this.respondWithError(res, statusCode, "Missing proxy attribution headers");
        return;
      }

      if (!targetUrl) {
        statusCode = 400;
        this.respondWithError(res, statusCode, "Proxy request URL is invalid");
        return;
      }

      provider = await this.routeProvider(targetUrl);

      if (provider) {
        const authorizationResult = await this.authorizeRequest(
          attribution.workerId,
          targetUrl,
          method,
          provider,
        );

        if ("error" in authorizationResult) {
          statusCode = authorizationResult.error.statusCode;
          capabilityViolation = authorizationResult.error.statusCode === 403
            ? authorizationResult.error.message
            : undefined;
          this.respondWithError(res, statusCode, authorizationResult.error.message);
          return;
        }

        authorization = authorizationResult;
        breakerKey = `${provider.id}:${authorization.grant.connectionId}`;
      }

      const limiter = this.deps.rateLimiter.getLimiter(attribution.rateLimitKey, provider ?? undefined);
      const rateLimitResult = limiter.tryConsume();
      if (!rateLimitResult.allowed) {
        statusCode = 429;
        this.respondWithError(res, statusCode, "Rate limit exceeded", {
          "Retry-After": Math.max(1, Math.ceil(rateLimitResult.retryAfterMs / 1000)).toString(),
        });
        return;
      }

      if (breakerKey) {
        const canRequest = await Promise.resolve(this.deps.circuitBreaker.canRequest(breakerKey));
        breakerState = await Promise.resolve(this.deps.circuitBreaker.getState(breakerKey));
        if (!canRequest) {
          statusCode = 503;
          this.respondWithError(res, statusCode, "Circuit breaker is open");
          return;
        }
      }

      if (targetUrl.protocol !== "http:") {
        statusCode = 501;
        this.respondWithError(res, statusCode, "HTTPS proxying is not implemented yet");
        return;
      }

      const forwardHeaders = this.buildForwardHeaders(req, targetUrl, authorization?.credential);
      const forwardResult = await this.forwardHttpRequest(req, res, targetUrl, forwardHeaders);
      statusCode = forwardResult.statusCode;
      bytesIn = forwardResult.bytesIn;
      bytesOut = forwardResult.bytesOut;

      if (breakerKey) {
        if (statusCode >= 500) {
          await Promise.resolve(
            this.deps.circuitBreaker.recordFailure(
              breakerKey,
              new Error(`Upstream request failed with status ${statusCode}`),
            ),
          );
        } else {
          await Promise.resolve(this.deps.circuitBreaker.recordSuccess(breakerKey));
        }
        breakerState = await Promise.resolve(this.deps.circuitBreaker.getState(breakerKey));
      }
    } catch (error) {
      if (breakerKey) {
        await Promise.resolve(this.deps.circuitBreaker.recordFailure(breakerKey, error));
        breakerState = await Promise.resolve(this.deps.circuitBreaker.getState(breakerKey));
      }

      if (!res.headersSent) {
        statusCode = 502;
        this.respondWithError(res, statusCode, "Failed to forward proxy request");
      } else {
        statusCode = res.statusCode || 502;
      }
    } finally {
      if (!targetUrl) {
        targetUrl = this.resolveTargetUrl(req);
      }

      await this.appendAuditEntry({
        ts: startedAt,
        workerId: attribution?.workerId ?? "unknown",
        callerId: attribution?.callerId ?? "unknown",
        providerId: provider?.id ?? PASSTHROUGH_PROVIDER_ID,
        connectionId: authorization?.grant.connectionId ?? PASSTHROUGH_CONNECTION_ID,
        method,
        url: targetUrl?.toString() ?? (req.url ?? ""),
        status: statusCode,
        durationMs: Date.now() - startedAt,
        bytesIn,
        bytesOut,
        scopesUsed: authorization?.grant.scopes ?? [],
        capabilityViolation,
        retries: 0,
        breakerState,
      });
    }
  }

  private async handleConnect(
    req: IncomingMessage,
    socket: Duplex,
    _head: Buffer,
  ): Promise<void> {
    const startedAt = Date.now();
    const attribution = this.attributeRequest(req);
    const authority = req.url ?? "";

    socket.write(
      "HTTP/1.1 501 Not Implemented\r\n" +
        "Connection: close\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        "\r\n" +
        "HTTPS CONNECT tunneling is not implemented yet",
    );
    socket.destroy();

    await this.appendAuditEntry({
      ts: startedAt,
      workerId: attribution?.workerId ?? "unknown",
      callerId: attribution?.callerId ?? "unknown",
      providerId: PASSTHROUGH_PROVIDER_ID,
      connectionId: PASSTHROUGH_CONNECTION_ID,
      method: "CONNECT",
      url: authority ? `https://${authority}` : "CONNECT",
      status: 501,
      durationMs: Date.now() - startedAt,
      bytesIn: 0,
      bytesOut: 0,
      scopesUsed: [],
      retries: 0,
      breakerState: "closed",
    });
  }

  private attributeRequest(req: IncomingMessage): RequestAttribution | null {
    const workerId = this.readHeader(req, WORKER_ID_HEADER);
    const callerId = this.readHeader(req, PROXY_AUTH_HEADER);

    if (!workerId || !callerId) {
      return null;
    }

    return {
      workerId,
      callerId,
      rateLimitKey: `${workerId}:${callerId}`,
    };
  }

  private async routeProvider(targetUrl: URL): Promise<ProviderManifest | null> {
    const manifests = await Promise.resolve(this.deps.providerRegistry.listProviderManifests());

    for (const manifest of manifests) {
      if (this.matchesProvider(targetUrl, manifest)) {
        return manifest;
      }
    }

    return null;
  }

  private async authorizeRequest(
    workerId: string,
    targetUrl: URL,
    method: string,
    provider: ProviderManifest,
  ): Promise<AuthorizationResult | { error: AuthorizationError }> {
    const grants = await Promise.resolve(this.deps.consentStore.list(workerId));
    const providerGrants = grants.filter((grant) => grant.providerId === provider.id);

    if (providerGrants.length === 0) {
      return {
        error: {
          statusCode: 403,
          message: `No consent grant found for provider ${provider.id}`,
        },
      };
    }

    for (const grant of providerGrants) {
      const declarations = await Promise.resolve(
        this.deps.providerRegistry.getCapabilityDeclarations(provider.id, grant.scopes),
      );
      const capability = checkCapability(targetUrl.toString(), method, declarations);

      if (capability !== "allow") {
        continue;
      }

      const credential = await Promise.resolve(
        this.deps.credentialStore.getCredential(grant.connectionId),
      );
      if (!credential) {
        return {
          error: {
            statusCode: 502,
            message: `No credential found for connection ${grant.connectionId}`,
          },
        };
      }

      return { grant, credential };
    }

    return {
      error: {
        statusCode: 403,
        message: `Request ${method} ${targetUrl.toString()} is not allowed by granted capabilities`,
      },
    };
  }

  private buildForwardHeaders(
    req: IncomingMessage,
    targetUrl: URL,
    credential?: Credential,
  ): OutgoingHttpHeaders {
    const headers: OutgoingHttpHeaders = {};

    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) {
        continue;
      }

      if (HOP_BY_HOP_REQUEST_HEADERS.has(name.toLowerCase())) {
        continue;
      }

      headers[name] = value;
    }

    headers.host = targetUrl.host;

    if (credential) {
      headers.authorization = `Bearer ${credential.accessToken}`;
    }

    return headers;
  }

  private async forwardHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    targetUrl: URL,
    headers: OutgoingHttpHeaders,
  ): Promise<ForwardResult> {
    return new Promise<ForwardResult>((resolve, reject) => {
      let statusCode = 502;
      let bytesIn = 0;
      let bytesOut = 0;
      let settled = false;

      const finalize = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({ statusCode, bytesIn, bytesOut });
      };

      const upstreamRequest = httpRequest(
        {
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port ? Number(targetUrl.port) : 80,
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
          res.on("finish", finalize);
          res.on("close", finalize);
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

  private resolveTargetUrl(req: IncomingMessage): URL | null {
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

      const normalizedPath = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
      try {
        return new URL(`http://${host}${normalizedPath}`);
      } catch {
        return null;
      }
    }
  }

  private matchesProvider(targetUrl: URL, manifest: ProviderManifest): boolean {
    return manifest.apiBase.some((apiBase) => {
      try {
        const baseUrl = new URL(apiBase);
        const normalizedBasePath = trimTrailingSlash(baseUrl.pathname);
        const normalizedTargetPath = trimTrailingSlash(targetUrl.pathname);
        const hostMatches = baseUrl.host === targetUrl.host;
        const pathMatches =
          normalizedBasePath === "" ||
          normalizedBasePath === "/" ||
          normalizedTargetPath === normalizedBasePath ||
          normalizedTargetPath.startsWith(`${normalizedBasePath}/`);

        return hostMatches && pathMatches;
      } catch {
        return apiBase === targetUrl.host || targetUrl.toString().startsWith(apiBase);
      }
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

function trimTrailingSlash(value: string): string {
  if (value.length <= 1) {
    return value;
  }

  return value.endsWith("/") ? value.slice(0, -1) : value;
}
