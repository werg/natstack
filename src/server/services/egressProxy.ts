import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import { isIP } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { lookup as dnsLookup } from "node:dns/promises";
import { timingSafeEqual } from "node:crypto";

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
const AUTHORIZATION_HEADER = "authorization";
const PASSTHROUGH_PROVIDER_ID = "passthrough";
const PASSTHROUGH_CONNECTION_ID = "passthrough";
const BYPASS_PROVIDER_ID = "bypass";
const BYPASS_CONNECTION_ID = "bypass";

/**
 * Ports the proxy will permit a CONNECT tunnel to. 443 is the default; 80
 * is included only because some self-hosted providers expose plain HTTP
 * APIs and would request a CONNECT for completeness — but capability
 * matching still gates access (S2 in audit-05).
 */
const ALLOWED_CONNECT_PORTS = new Set<number>([443]);

/**
 * IP CIDR deny list applied to the resolved address of every CONNECT
 * target, post-DNS, pre-connect. Closes audit-05 S2 (loopback / IMDS /
 * RFC1918 reachable through the proxy CONNECT path).
 */
const DENY_CIDRS_V4: ReadonlyArray<readonly [string, number]> = [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["169.254.0.0", 16],
  ["0.0.0.0", 8],
  ["100.64.0.0", 10],
];

const DENY_IPV6_PREFIXES: ReadonlyArray<string> = [
  "::1",
  "fe80:",
  "fc00:",
  "fd00:",
];

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
  AUTHORIZATION_HEADER,
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

/**
 * Per-worker proxy auth token registry.
 *
 * `WorkerdManager` mints a fresh token for every worker / DO service when
 * it generates the workerd config and binds it as the `PROXY_AUTH_TOKEN`
 * env var inside the worker. The proxy validates inbound requests
 * against this registry: a request claiming `X-NatStack-Worker-Id: foo`
 * is only honoured when its bearer token equals the registered token
 * for `foo`. Closes audit finding #11 / 03-F-03.
 */
export interface WorkerTokenStore {
  getToken(workerId: string): string | null | undefined;
}

/**
 * Optional per-worker-id bypass list. Workers in this set are NOT
 * required to have a matching consent grant; their requests pass through
 * with attribution but no provider gating. Intended ONLY as an emergency
 * rollback knob for migration-period failures (see
 * `STRICT_EGRESS_BYPASS_WORKERS` env var). Every bypass use is logged at
 * `warn` level by the proxy.
 */
export interface BypassRegistry {
  has(workerId: string): boolean;
}

export interface EgressProxyLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
}

export interface EgressProxyDeps {
  credentialStore: CredentialStore;
  consentStore: ConsentStore;
  providerRegistry: ProviderRegistry;
  auditLog: Pick<AuditLog, "append">;
  rateLimiter: EgressRateLimiter;
  circuitBreaker: CircuitBreaker;
  /** Per-worker `PROXY_AUTH_TOKEN` lookup (audit #11). */
  workerTokenStore: WorkerTokenStore;
  /** Optional list of worker IDs allowed to bypass provider gating
   *  (emergency rollback). */
  bypassWorkerIds?: BypassRegistry;
  /** Optional logger; defaults to `console`. */
  logger?: EgressProxyLogger;
}

interface RequestAttribution {
  workerId: string;
  callerId: string;
  rateLimitKey: string;
  /** True when the worker matched the bypass list. */
  bypass: boolean;
}

interface AttributionFailure {
  statusCode: number;
  message: string;
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
    const attributionResult = this.attributeRequest(req);
    const attribution = isAttributionFailure(attributionResult) ? null : attributionResult;
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
        const failure = attributionResult as AttributionFailure;
        statusCode = failure.statusCode;
        this.respondWithError(res, statusCode, failure.message);
        return;
      }

      if (!targetUrl) {
        statusCode = 400;
        this.respondWithError(res, statusCode, "Proxy request URL is invalid");
        return;
      }

      provider = await this.routeProvider(targetUrl);

      if (!provider && !attribution.bypass) {
        // STRICT MODE: every outbound must match a declared provider OR
        // come from a worker on the bypass list. Otherwise the worker has
        // not declared its egress need and we refuse the request. This is
        // the central invariant the strict-mode rewrite enforces.
        statusCode = 403;
        capabilityViolation = `No provider matches ${targetUrl.host} — worker must declare a provider that owns this host`;
        this.respondWithError(res, statusCode, capabilityViolation);
        return;
      }

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
        providerId: provider?.id ?? (attribution?.bypass ? BYPASS_PROVIDER_ID : PASSTHROUGH_PROVIDER_ID),
        connectionId: authorization?.grant.connectionId ?? (attribution?.bypass ? BYPASS_CONNECTION_ID : PASSTHROUGH_CONNECTION_ID),
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

  /**
   * Hardened CONNECT handler (audit-05 S2 — Critical).
   *
   * Pipeline:
   *   1. Attribution + per-worker token validation (same as HTTP path).
   *   2. Parse the `host:port` authority, refuse missing port.
   *   3. Port allow-list (default: 443 only). 80 is permitted only when
   *      a matched provider explicitly declares `apiBase` with `http://`.
   *   4. Provider routing — the host:port MUST match a provider's
   *      `apiBase` host; bypass workers are exempt.
   *   5. Consent check for the provider for this worker.
   *   6. Rate limit + circuit breaker.
   *   7. DNS resolve the host once; refuse if the resolved IP is in any
   *      private / loopback / link-local / IMDS range, or matches the
   *      egress proxy's own bound port. Connect to the resolved IP (not
   *      the hostname) — this pins the address for the tunnel lifetime
   *      and forecloses DNS-rebinding races between resolve and connect.
   *
   * Failure modes return a one-line HTTP/1.1 status response on the raw
   * socket; the audit log captures the reason in `capabilityViolation`.
   */
  private async handleConnect(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const startedAt = Date.now();
    const attributionResult = this.attributeRequest(req);
    const authority = req.url ?? "";
    let auditStatus = 502;
    let auditSettled = false;
    let capabilityViolation: string | undefined;
    let provider: ProviderManifest | null = null;
    let connectionId = PASSTHROUGH_CONNECTION_ID;
    let providerId = PASSTHROUGH_PROVIDER_ID;
    let breakerKey: string | null = null;
    let breakerState: BreakerState = "closed";

    const attribution = isAttributionFailure(attributionResult) ? null : attributionResult;
    if (attribution?.bypass) {
      providerId = BYPASS_PROVIDER_ID;
      connectionId = BYPASS_CONNECTION_ID;
    }

    const appendConnectAudit = async (): Promise<void> => {
      if (auditSettled) return;
      auditSettled = true;
      await this.appendAuditEntry({
        ts: startedAt,
        workerId: attribution?.workerId ?? "unknown",
        callerId: attribution?.callerId ?? "unknown",
        providerId,
        connectionId,
        method: "CONNECT",
        url: authority ? `https://${authority}` : "CONNECT",
        status: auditStatus,
        durationMs: Date.now() - startedAt,
        bytesIn: 0,
        bytesOut: 0,
        scopesUsed: [],
        capabilityViolation,
        retries: 0,
        breakerState,
      });
    };

    const rejectAndClose = (statusCode: number, message: string): void => {
      auditStatus = statusCode;
      capabilityViolation = message;
      try {
        if (!socket.destroyed) {
          // `end(...)` flushes then half-closes — vs `write` + `destroy`
          // which can drop the buffered payload before the kernel sends.
          socket.end(
            `HTTP/1.1 ${statusCode} ${shortReason(statusCode)}\r\n` +
              `Connection: close\r\n` +
              `Content-Length: ${Buffer.byteLength(message)}\r\n` +
              `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
              message,
          );
        }
      } catch {
        /* socket already gone */
      }
      void appendConnectAudit();
    };

    try {
      // 1. Attribution
      if (!attribution) {
        const failure = attributionResult as AttributionFailure;
        rejectAndClose(failure.statusCode, failure.message);
        return;
      }

      // 2. Parse authority
      const lastColon = authority.lastIndexOf(":");
      if (lastColon <= 0 || lastColon === authority.length - 1) {
        rejectAndClose(400, "CONNECT requires host:port authority");
        return;
      }
      const host = authority.slice(0, lastColon).replace(/^\[|\]$/g, "");
      const portStr = authority.slice(lastColon + 1);
      const port = Number.parseInt(portStr, 10);
      if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        rejectAndClose(400, `CONNECT port is invalid: ${portStr}`);
        return;
      }

      // 3. Port allow-list
      if (!ALLOWED_CONNECT_PORTS.has(port)) {
        rejectAndClose(403, `CONNECT to port ${port} is not allowed (only 443)`);
        return;
      }

      // 4. Provider routing — bypass workers skip provider gating but still
      //    pay all the address / port / DNS rebinding checks.
      if (!attribution.bypass) {
        const target = new URL(`https://${host}:${port}`);
        provider = await this.routeProvider(target);
        if (!provider) {
          rejectAndClose(403, `CONNECT to ${authority} not allowed: no provider declares this host`);
          return;
        }
        providerId = provider.id;

        // 5. Consent check (using a synthetic GET probe — CONNECT itself
        //    has no method-shaped capability check; treat the tunnel as a
        //    GET against the host root for capability evaluation).
        const probeUrl = new URL(`https://${host}/`);
        const authorizationResult = await this.authorizeRequest(
          attribution.workerId,
          probeUrl,
          "GET",
          provider,
        );
        if ("error" in authorizationResult) {
          capabilityViolation = authorizationResult.error.statusCode === 403
            ? authorizationResult.error.message
            : undefined;
          rejectAndClose(authorizationResult.error.statusCode, authorizationResult.error.message);
          return;
        }
        connectionId = authorizationResult.grant.connectionId;
        breakerKey = `${provider.id}:${connectionId}`;
      }

      // 6. Rate limit + breaker
      const limiter = this.deps.rateLimiter.getLimiter(
        attribution.rateLimitKey,
        provider ?? undefined,
      );
      const rate = limiter.tryConsume();
      if (!rate.allowed) {
        rejectAndClose(429, `Rate limit exceeded for CONNECT ${authority}`);
        return;
      }

      if (breakerKey) {
        const ok = await Promise.resolve(this.deps.circuitBreaker.canRequest(breakerKey));
        breakerState = await Promise.resolve(this.deps.circuitBreaker.getState(breakerKey));
        if (!ok) {
          rejectAndClose(503, `Circuit breaker is open for CONNECT ${authority}`);
          return;
        }
      }

      // 7. DNS resolve + IP deny list + DNS-rebinding pin.
      let resolvedAddress: string;
      try {
        const looked = await dnsLookup(host);
        resolvedAddress = looked.address;
      } catch (err) {
        rejectAndClose(502, `CONNECT DNS lookup for ${host} failed: ${(err as Error).message}`);
        return;
      }

      if (this.isDeniedAddress(resolvedAddress, port)) {
        rejectAndClose(
          403,
          `CONNECT to ${authority} resolves to denied address ${resolvedAddress}`,
        );
        return;
      }

      // Connect by IP — pins the address for the lifetime of the tunnel.
      const upstream = netConnect({ host: resolvedAddress, port }) as Socket;
      let connected = false;

      upstream.once("connect", () => {
        connected = true;
        auditStatus = 200;
        try {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        } catch {
          upstream.destroy();
          void appendConnectAudit();
          return;
        }
        if (head.length > 0) {
          upstream.write(head);
        }
        upstream.pipe(socket);
        socket.pipe(upstream);
        void appendConnectAudit();
      });

      upstream.on("error", (err) => {
        if (breakerKey) {
          void Promise.resolve(this.deps.circuitBreaker.recordFailure(breakerKey, err));
        }
        if (!connected) {
          rejectAndClose(502, `CONNECT upstream error: ${err.message}`);
        } else if (!socket.destroyed) {
          socket.destroy();
        }
        void appendConnectAudit();
      });

      socket.on("error", () => {
        upstream.destroy();
        void appendConnectAudit();
      });

      upstream.on("close", () => {
        if (connected && breakerKey) {
          void Promise.resolve(this.deps.circuitBreaker.recordSuccess(breakerKey));
        }
        void appendConnectAudit();
      });
    } catch (err) {
      rejectAndClose(500, `CONNECT handler error: ${(err as Error).message}`);
    }
  }

  /**
   * Reject IP addresses that the proxy must never tunnel to.
   * Covers loopback, link-local (incl. AWS / GCP IMDS), CGNAT,
   * RFC1918, IPv6 ULA, and the proxy's own listening port (so a worker
   * cannot tunnel back through itself).
   */
  private isDeniedAddress(address: string, port: number): boolean {
    const ipKind = isIP(address);
    if (ipKind === 0) {
      // Not an IP literal — should not happen post-dnsLookup, but bail safe.
      return true;
    }

    // Refuse the proxy's own listening port on every address.
    const proxyAddress = this.server?.address();
    if (proxyAddress && typeof proxyAddress !== "string" && proxyAddress.port === port) {
      // Same port — only refuse if the host is loopback (any worker
      // tunneling to a non-loopback peer on the same port number is fine).
      if (this.isIpv4InCidr(address, "127.0.0.0", 8) || address === "::1") {
        return true;
      }
    }

    if (ipKind === 4) {
      for (const [base, bits] of DENY_CIDRS_V4) {
        if (this.isIpv4InCidr(address, base, bits)) return true;
      }
      return false;
    }

    // IPv6
    const lower = address.toLowerCase();
    for (const prefix of DENY_IPV6_PREFIXES) {
      if (lower === prefix || lower.startsWith(prefix.endsWith(":") ? prefix : prefix + ":")) {
        return true;
      }
    }
    // IPv4-mapped IPv6 (::ffff:1.2.3.4)
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice(7);
      if (isIP(v4) === 4) {
        return this.isDeniedAddress(v4, port);
      }
    }
    return false;
  }

  private isIpv4InCidr(address: string, base: string, bits: number): boolean {
    const a = ipv4ToInt(address);
    const b = ipv4ToInt(base);
    if (a === null || b === null) return false;
    if (bits === 0) return true;
    const mask = bits >= 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
    return (a & mask) === (b & mask);
  }

  /**
   * Authenticate a proxy request.
   *
   * Worker identity is taken from `X-NatStack-Worker-Id`. The bearer
   * token is read from `Authorization: Bearer <token>` (preferred — what
   * workerd-bound clients use) or from `X-NatStack-Proxy-Auth` as a
   * fallback for legacy callers. The token is compared against the
   * `WorkerTokenStore` registry via `crypto.timingSafeEqual` after a
   * length check.
   *
   * Returns the attribution on success, or an `AttributionFailure` (with
   * statusCode + message) on missing-header / unknown-worker /
   * token-mismatch. Closes audit findings #11 and 03-F-03.
   */
  private attributeRequest(req: IncomingMessage): RequestAttribution | AttributionFailure {
    const workerId = this.readHeader(req, WORKER_ID_HEADER);
    if (!workerId) {
      return {
        statusCode: 407,
        message: `Missing ${WORKER_ID_HEADER} header`,
      };
    }

    // Look up the per-worker proxy auth token registered by
    // WorkerdManager when it generated the workerd config.
    const expectedToken = this.deps.workerTokenStore.getToken(workerId);
    if (!expectedToken) {
      return {
        statusCode: 401,
        message: `Unknown worker id ${JSON.stringify(workerId)}`,
      };
    }

    // Accept either `Authorization: Bearer <token>` or the legacy
    // `X-NatStack-Proxy-Auth` header.
    const authHeader = this.readHeader(req, AUTHORIZATION_HEADER);
    const presentedToken = authHeader && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : (this.readHeader(req, PROXY_AUTH_HEADER) ?? "");

    if (!presentedToken || !constantTimeStringEqual(presentedToken, expectedToken)) {
      return {
        statusCode: 401,
        message: "Invalid proxy auth token",
      };
    }

    const bypass = this.deps.bypassWorkerIds?.has(workerId) === true;
    if (bypass) {
      this.getLogger().warn(
        `[EgressProxy] Worker "${workerId}" using STRICT_EGRESS_BYPASS_WORKERS bypass — provider gating SKIPPED`,
        { workerId },
      );
    }

    return {
      workerId,
      callerId: workerId,
      rateLimitKey: `${workerId}:proxy`,
      bypass,
    };
  }

  private getLogger(): EgressProxyLogger {
    return this.deps.logger ?? {
      warn: (msg, meta) => console.warn(msg, meta ?? {}),
      info: (msg, meta) => console.info(msg, meta ?? {}),
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
      const requestFn = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
      const defaultPort = targetUrl.protocol === "https:" ? 443 : 80;
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

function isAttributionFailure(
  value: RequestAttribution | AttributionFailure,
): value is AttributionFailure {
  return (value as AttributionFailure).statusCode !== undefined &&
    (value as RequestAttribution).workerId === undefined;
}

/**
 * Constant-time string compare. Two-step:
 *   1. Length-tag the strings into Buffers and compare lengths first
 *      (timingSafeEqual itself throws on length mismatch — wrap it).
 *   2. timingSafeEqual the equal-length buffers.
 *
 * NOTE: we intentionally do NOT short-circuit on the length check —
 * the `timingSafeEqual` call ALWAYS happens, just over a sentinel of
 * length zero, so the wall-clock for "wrong length" matches "right
 * length but wrong bytes" closely enough that the side-channel does
 * not leak the secret length.
 */
function constantTimeStringEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Pad the shorter buffer so timingSafeEqual doesn't throw. We then
  // require equal length AND equal bytes.
  const len = Math.max(a.length, b.length, 1);
  const aPad = Buffer.alloc(len);
  const bPad = Buffer.alloc(len);
  a.copy(aPad);
  b.copy(bPad);
  const bytesEqual = timingSafeEqual(aPad, bPad);
  return bytesEqual && a.length === b.length;
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    acc = (acc << 8) | n;
  }
  return acc >>> 0;
}

function shortReason(statusCode: number): string {
  switch (statusCode) {
    case 200: return "OK";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 407: return "Proxy Authentication Required";
    case 429: return "Too Many Requests";
    case 500: return "Internal Server Error";
    case 502: return "Bad Gateway";
    case 503: return "Service Unavailable";
    default: return "Error";
  }
}
