import { STATUS_CODES, createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  verifyCallerAssertion,
  type VerifiedAssertion,
} from "../../../packages/shared/src/identity/callerAssertion.js";
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

import type { AuditLog } from "../../../packages/shared/src/credentials/audit.js";
import type {
  AuditEntry,
  Credential,
  CredentialBinding,
  CredentialBindingUse,
} from "../../../packages/shared/src/credentials/types.js";
import {
  credentialCarrierStripHeaders,
  findMatchingUrlAudience,
  renderCredentialBasicAuthValue,
  renderCredentialHeaderValue,
} from "../../../packages/shared/src/credentials/urlAudience.js";
import type { CodeIdentityResolver, ResolvedCodeIdentity } from "./codeIdentityResolver.js";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { CredentialLifecycleError, type CredentialLifecycle } from "./credentialLifecycle.js";
import type { Gateway } from "../gateway.js";

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

const PASSTHROUGH_PROVIDER_ID = "passthrough";
const PASSTHROUGH_CONNECTION_ID = "passthrough";
const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 100;
const DEFAULT_RETRY_MAX_DELAY_MS = 1_000;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 30_000;
const EXPLICIT_CREDENTIAL_HEADER = "x-natstack-use-credential";
const OBJECT_ASSERTION_HEADER = "x-natstack-object-assertion";

export interface CredentialStore {
  loadUrlBound(id: string): Promise<Credential | null> | Credential | null;
  listUrlBound?(): Promise<Credential[]> | Credential[];
  saveUrlBound?(credential: Credential & { id: string }): Promise<void> | void;
}

export interface EgressProxyDeps {
  credentialStore: CredentialStore;
  auditLog: Pick<AuditLog, "append">;
  codeIdentityResolver: Pick<CodeIdentityResolver, "resolveByCallerId">;
  assertionSecret?: Buffer;
  gateway?: Pick<Gateway, "handleHttpRequest" | "handleUpgrade">;
  gatewayPort?: number;
  approvalQueue?: ApprovalQueue;
  capabilityGrantStore?: CapabilityGrantStore;
  credentialLifecycle?: Pick<CredentialLifecycle, "refreshIfNeeded">;
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

interface CredentialCandidate {
  credential: Credential;
  binding: CredentialBinding;
  selectionId: string;
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
    public readonly capabilityViolation?: string
  ) {
    super(message);
  }
}

interface CircuitState {
  failures: number;
  state: AuditEntry["breakerState"];
  openedAt?: number;
}

export class EgressProxy {
  private server: Server | null = null;
  private readonly circuits = new Map<string, CircuitState>();

  constructor(private readonly deps: EgressProxyDeps) {}

  configureGateway(gateway: Pick<Gateway, "handleHttpRequest" | "handleUpgrade">, port: number): void {
    this.deps.gateway = gateway;
    this.deps.gatewayPort = port;
  }

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

    server.on("upgrade", (req, socket, head) => {
      void this.handleUpgrade(req, socket as Duplex, head);
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

  public prepareForwardRequest(
    targetUrl: URL,
    inputHeaders: IncomingHttpHeaders | Headers | Record<string, string | string[] | undefined>,
    credential?: Credential,
    binding?: CredentialBinding | null,
    method = "GET",
    preserveUpgradeHeaders = false
  ): { headers: OutgoingHttpHeaders; targetUrl: URL } {
    const headers: OutgoingHttpHeaders = {};

    for (const [name, value] of this.iterateHeaders(inputHeaders)) {
      const lowerName = name.toLowerCase();
      if (
        (HOP_BY_HOP_REQUEST_HEADERS.has(lowerName) &&
          !(preserveUpgradeHeaders && (lowerName === "connection" || lowerName === "upgrade"))) ||
        lowerName.startsWith("x-natstack-")
      ) {
        continue;
      }
      headers[lowerName] = value;
    }

    const injection = binding?.injection ?? credential?.bindings?.[0]?.injection;
    if (credential && injection) {
      for (const headerName of credentialCarrierStripHeaders(injection)) {
        delete headers[headerName.toLowerCase()];
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

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const assertion = this.verifyProxyAuthorization(req);
    if (!assertion) {
      this.respondProxyAuthRequired(res);
      return;
    }

    const targetUrl = this.resolveTargetUrl(req);
    if (!targetUrl) {
      this.respondWithError(res, 400, "Proxy request URL is invalid");
      return;
    }

    if (this.isInternalGatewayTarget(targetUrl)) {
      if (!isExposedInternalGatewayHttpRoute(req.method ?? "GET", targetUrl.pathname)) {
        this.respondWithError(res, 403, "internal-route-not-exposed");
        return;
      }
      const objectAssertion = this.verifyObjectAssertion(req);
      req.natstackCaller = {
        callerId: objectAssertion?.callerId ?? assertion.callerId,
        callerKind: objectAssertion?.callerKind ?? assertion.callerKind,
      };
      delete req.headers[OBJECT_ASSERTION_HEADER];
      delete req.headers["x-natstack-object-caller-id"];
      req.url = `${targetUrl.pathname}${targetUrl.search}`;
      this.deps.gateway?.handleHttpRequest(req, res);
      return;
    }

    try {
      await this.executeAuthorizedRequest({
        callerId: assertion.callerId,
        callerKind: assertion.callerKind,
        method: (req.method ?? "GET").toUpperCase(),
        targetUrl,
        inputHeaders: req.headers,
        credentialId: this.readHeader(req, EXPLICIT_CREDENTIAL_HEADER) ?? undefined,
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

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer): Promise<void> {
    const assertion = this.verifyProxyAuthorization(req);
    if (!assertion) {
      socket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="NatStack"\r\nConnection: close\r\n\r\n'
      );
      socket.destroy();
      return;
    }
    const targetUrl = this.resolveTargetUrl(req);
    if (!targetUrl) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (this.isInternalGatewayTarget(targetUrl)) {
      if (!isExposedInternalGatewayUpgradeRoute(targetUrl.pathname)) {
        socket.write(
          "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\ninternal-route-not-exposed"
        );
        socket.destroy();
        return;
      }
      req.natstackCaller = {
        callerId: assertion.callerId,
        callerKind: assertion.callerKind,
      };
      req.url = `${targetUrl.pathname}${targetUrl.search}`;
      this.deps.gateway?.handleUpgrade(req, socket, _head);
      return;
    }
    try {
      await this.executeAuthorizedRequest({
        callerId: assertion.callerId,
        callerKind: assertion.callerKind,
        method: (req.method ?? "GET").toUpperCase(),
        targetUrl,
        inputHeaders: req.headers,
        credentialId: this.readHeader(req, EXPLICIT_CREDENTIAL_HEADER) ?? undefined,
        credentialUse: "fetch",
        preserveUpgradeHeaders: true,
        execute: async (preparedUrl, headers) => {
          const result = await this.forwardUpgradeRequest(req, socket, _head, preparedUrl, headers);
          return { ...result, payload: undefined };
        },
      });
    } catch (error) {
      const statusCode = error instanceof ForwardRejection ? error.statusCode : 502;
      const message = error instanceof Error ? error.message : "Failed to forward upgrade request";
      socket.write(
        `HTTP/1.1 ${statusCode} ${statusMessageFor(statusCode)}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${message}`
      );
      socket.destroy();
    }
  }

  public async executeAuthorizedRequest<T>(params: {
    callerId?: string | null;
    callerKind?: string | null;
    method: string;
    targetUrl: URL;
    inputHeaders: IncomingHttpHeaders | Headers | Record<string, string | string[] | undefined>;
    credentialId?: string;
    credentialUse?: CredentialBindingUse;
    initialBytesOut?: number;
    replaySafe?: boolean;
    preserveUpgradeHeaders?: boolean;
    execute: (targetUrl: URL, headers: OutgoingHttpHeaders) => Promise<RequestExecutionResult<T>>;
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
        callerId: params.callerId ?? null,
        callerKind: params.callerKind ?? null,
        targetUrl,
        method: params.method,
        credentialId: params.credentialId,
        credentialUse: params.credentialUse ?? "fetch",
      });
      const executionKey = executionPolicyKey(authorization, params.targetUrl);
      const maxAttempts = shouldRetryRequest(params.method, params.replaySafe)
        ? DEFAULT_RETRY_ATTEMPTS + 1
        : 1;
      let lastError: unknown;
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
          params.method,
          params.preserveUpgradeHeaders ?? false
        );
        targetUrl = prepared.targetUrl;
        try {
          const result = await params.execute(targetUrl, prepared.headers);
          statusCode = result.statusCode;
          bytesIn = result.bytesIn;
          bytesOut = result.bytesOut;
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
        callerId: authorization?.attribution?.callerId ?? params.callerId ?? "unknown",
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
    callerId: string | null;
    callerKind: string | null;
    targetUrl: URL;
    method: string;
    credentialId?: string;
    credentialUse: CredentialBindingUse;
  }): Promise<Authorization> {
    const attribution = params.callerId
      ? this.resolveAttribution(params.callerId, params.credentialId)
      : null;

    if (!params.credentialId) {
      const candidates = await this.resolveCredentialCandidates(
        params.targetUrl,
        params.credentialUse
      );
      const selectedCredentialId = await this.authorizeEgress({
        callerId: params.callerId,
        callerKind: params.callerKind ?? attribution?.callerKind ?? null,
        attribution,
        resourceKey: params.targetUrl.origin,
        resourceLabel: params.targetUrl.origin,
        targetUrl: params.targetUrl,
        method: params.method,
        credential: candidates.length === 1 ? candidates[0]!.credential : null,
        binding: candidates.length === 1 ? candidates[0]!.binding : null,
        credentialCandidates: candidates,
      });
      const candidate =
        selectedCredentialId === null
          ? null
          : candidates.find((entry) => entry.selectionId === selectedCredentialId) ?? null;
      const credential =
        candidate
          ? await this.refreshCredentialForUse(candidate.credential)
          : null;
      const binding = credential && candidate ? candidate.binding : null;
      return {
        attribution,
        credential,
        binding,
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
    const selectionId = credentialSelectionId(credential, binding);
    const allowedSelectionId = await this.authorizeEgress({
      callerId: params.callerId,
      callerKind: params.callerKind ?? attribution?.callerKind ?? null,
      attribution,
      resourceKey: params.targetUrl.origin,
      resourceLabel: params.targetUrl.origin,
      targetUrl: params.targetUrl,
      method: params.method,
      credential,
      binding,
      explicitCredentialId: params.credentialId,
    });
    if (allowedSelectionId !== selectionId) {
      throw new ForwardRejection(
        403,
        "credential-caller-not-granted",
        "credential-caller-not-granted"
      );
    }

    return {
      attribution,
      credential,
      binding,
      connectionId: credential.id ?? credential.connectionId,
      scopes: credential.scopes,
    };
  }

  private async resolveCredentialCandidates(
    targetUrl: URL,
    use: CredentialBindingUse = "fetch"
  ): Promise<CredentialCandidate[]> {
    const listUrlBound = this.deps.credentialStore.listUrlBound;
    if (!listUrlBound) {
      return [];
    }
    return (await Promise.resolve(listUrlBound.call(this.deps.credentialStore)))
      .filter((credential) => !credential.revokedAt)
      .flatMap((credential): CredentialCandidate[] => {
        const binding = this.findCredentialBinding(credential, targetUrl, use);
        return binding ? [{ credential, binding, selectionId: credentialSelectionId(credential, binding) }] : [];
      });
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

  private resolveAttribution(callerId: string, credentialId?: string): RequestAttribution | null {
    const identity = this.deps.codeIdentityResolver.resolveByCallerId(callerId);
    if (!identity && credentialId) {
      throw new ForwardRejection(
        403,
        "credential-caller-not-granted",
        "credential-caller-not-granted"
      );
    }
    if (!identity) {
      throw new ForwardRejection(403, `Unknown caller identity: ${callerId}`, "unknown-caller");
    }
    return {
      ...identity,
      policyKey: `${identity.repoPath}:${identity.callerId}`,
    };
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

  private async handleConnect(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const startedAt = Date.now();
    const assertion = this.verifyProxyAuthorization(req);
    if (!assertion) {
      socket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="NatStack"\r\nConnection: close\r\n\r\n'
      );
      socket.destroy();
      return;
    }
    const authority = req.url ?? "";
    const parsedAuthority = parseConnectAuthority(authority);
    const host = parsedAuthority?.host ?? "";
    const port = parsedAuthority?.port ?? 443;
    let attribution: RequestAttribution | null = null;
    let auditStatus = 502;
    let auditSettled = false;

    const appendConnectAudit = async (): Promise<void> => {
      if (auditSettled) {
        return;
      }
      auditSettled = true;
      await this.appendAuditEntry({
        ts: startedAt,
        workerId: attribution?.repoPath ?? assertion.callerId,
        callerId: assertion.callerId,
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

    if (!parsedAuthority) {
      auditStatus = 400;
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      await appendConnectAudit();
      return;
    }

    if (this.isInternalGatewayAuthority(host || authority, port)) {
      auditStatus = 200;
      this.handleInternalGatewayConnect(assertion, socket, head);
      await appendConnectAudit();
      return;
    }

    try {
      attribution = this.resolveAttribution(assertion.callerId);
      await this.authorizeEgress({
        callerId: assertion.callerId,
        callerKind: assertion.callerKind,
        attribution,
        resourceKey: authority,
        resourceLabel: authority,
        method: "CONNECT",
      });
    } catch (error) {
      auditStatus = error instanceof ForwardRejection ? error.statusCode : 403;
      socket.write(
        `HTTP/1.1 ${auditStatus} ${statusMessageFor(auditStatus)}\r\nConnection: close\r\n\r\n`
      );
      socket.destroy();
      await appendConnectAudit();
      return;
    }

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

  private verifyProxyAuthorization(req: IncomingMessage): VerifiedAssertion | null {
    if (!this.deps.assertionSecret) {
      return null;
    }
    const header = this.readHeader(req, "proxy-authorization");
    const token = parseBasicProxyAuthorization(header);
    if (!token) {
      return null;
    }
    const verified = verifyCallerAssertion(this.deps.assertionSecret, token, "egress-proxy");
    return "error" in verified ? null : verified;
  }

  private verifyObjectAssertion(req: IncomingMessage): VerifiedAssertion | null {
    if (!this.deps.assertionSecret) {
      return null;
    }
    const header = this.readHeader(req, OBJECT_ASSERTION_HEADER);
    if (!header) {
      return null;
    }
    const verified = verifyCallerAssertion(this.deps.assertionSecret, header, "egress-proxy");
    if ("error" in verified || !verified.callerId.startsWith("do:")) {
      return null;
    }
    return verified;
  }

  private respondProxyAuthRequired(res: ServerResponse): void {
    res.writeHead(407, {
      "Content-Type": "text/plain",
      "Proxy-Authenticate": 'Basic realm="NatStack"',
    });
    res.end("Proxy authentication required");
  }

  private isInternalGatewayTarget(targetUrl: URL): boolean {
    if (!this.deps.gateway || !this.deps.gatewayPort) {
      return false;
    }
    const port = Number(targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80));
    if (port !== this.deps.gatewayPort) {
      return false;
    }
    const host = normalizeAuthorityHost(targetUrl.hostname);
    return (
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "localhost" ||
      host.endsWith(".localhost")
    );
  }

  private isInternalGatewayAuthority(host: string, port: number): boolean {
    if (!this.deps.gateway || !this.deps.gatewayPort || port !== this.deps.gatewayPort) {
      return false;
    }
    const normalizedHost = normalizeAuthorityHost(host);
    return (
      normalizedHost === "127.0.0.1" ||
      normalizedHost === "::1" ||
      normalizedHost === "localhost" ||
      normalizedHost.endsWith(".localhost")
    );
  }

  private handleInternalGatewayConnect(
    assertion: VerifiedAssertion,
    socket: Duplex,
    head: Buffer
  ): void {
    const gateway = this.deps.gateway;
    if (!gateway) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const tunnelServer = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!isExposedInternalGatewayHttpRoute(req.method ?? "GET", reqUrl.pathname)) {
        this.respondWithError(res, 403, "internal-route-not-exposed");
        return;
      }
      req.natstackCaller = {
        callerId: assertion.callerId,
        callerKind: assertion.callerKind,
      };
      gateway.handleHttpRequest(req, res);
    });
    tunnelServer.on("upgrade", (req, upgradedSocket, upgradedHead) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!isExposedInternalGatewayUpgradeRoute(reqUrl.pathname)) {
        upgradedSocket.write(
          "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\ninternal-route-not-exposed"
        );
        upgradedSocket.destroy();
        return;
      }
      req.natstackCaller = {
        callerId: assertion.callerId,
        callerKind: assertion.callerKind,
      };
      gateway.handleUpgrade(req, upgradedSocket, upgradedHead);
    });
    tunnelServer.on("clientError", () => {
      if (!socket.destroyed) {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    });
    socket.once("close", () => tunnelServer.close());
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0 && typeof (socket as { unshift?: (chunk: Buffer) => void }).unshift === "function") {
      (socket as { unshift: (chunk: Buffer) => void }).unshift(head);
    }
    tunnelServer.emit("connection", socket);
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

  private async forwardUpgradeRequest(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    targetUrl: URL,
    headers: OutgoingHttpHeaders
  ): Promise<ForwardResult> {
    return new Promise<ForwardResult>((resolve, reject) => {
      const requestFn = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
      const defaultPort = targetUrl.protocol === "https:" ? 443 : 80;
      let settled = false;
      const finish = (result: ForwardResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const upstreamRequest = requestFn({
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port ? Number(targetUrl.port) : defaultPort,
        method: req.method ?? "GET",
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers,
      });

      upstreamRequest.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
        const statusCode = upstreamResponse.statusCode ?? 101;
        socket.write(renderUpgradeResponse(upstreamResponse));
        if (upstreamHead.length > 0) {
          socket.write(upstreamHead);
        }
        if (head.length > 0) {
          upstreamSocket.write(head);
        }
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
        finish({ statusCode, bytesIn: 0, bytesOut: 0 });
      });
      upstreamRequest.on("response", (upstreamResponse) => {
        const statusCode = upstreamResponse.statusCode ?? 502;
        socket.write(renderHttpResponseHead(statusCode, upstreamResponse.rawHeaders));
        upstreamResponse.on("data", (chunk: Buffer | string) => socket.write(chunk));
        upstreamResponse.on("end", () => {
          socket.end();
          finish({ statusCode, bytesIn: 0, bytesOut: 0 });
        });
        upstreamResponse.on("error", reject);
      });
      upstreamRequest.on("error", reject);
      req.on("error", reject);
      upstreamRequest.end();
    });
  }

  private async authorizeEgress(params: {
    callerId: string | null;
    callerKind: string | null;
    attribution: RequestAttribution | null;
    resourceKey: string;
    resourceLabel: string;
    targetUrl?: URL;
    method: string;
    credential?: Credential | null;
    binding?: CredentialBinding | null;
    credentialCandidates?: CredentialCandidate[];
    explicitCredentialId?: string;
  }): Promise<string | null> {
    if (!this.deps.capabilityGrantStore || !this.deps.approvalQueue) {
      return params.credential && params.binding
        ? credentialSelectionId(params.credential, params.binding)
        : null;
    }
    if (!params.callerId || !params.attribution) {
      throw new ForwardRejection(403, "unknown-caller", "unknown-caller");
    }
    const callerKind =
      params.callerKind === "panel" || params.callerKind === "worker"
        ? params.callerKind
        : params.attribution.callerKind === "panel"
          ? "panel"
          : "worker";
    const identity = {
      repoPath: params.attribution.repoPath,
      effectiveVersion: params.attribution.effectiveVersion,
    };
    const existingGrant = this.deps.capabilityGrantStore.getGrant("egress", params.resourceKey, identity);
    const requestedSelectionId =
      params.credential && params.binding
        ? credentialSelectionId(params.credential, params.binding)
        : null;
    if (existingGrant) {
      const grantedSelectionId = existingGrant.credentialSelectionId ?? null;
      if (grantedSelectionId === requestedSelectionId) {
        return grantedSelectionId;
      }
      if (!params.explicitCredentialId && !grantedSelectionId) {
        return null;
      }
    }
    const credentialOptions = params.credentialCandidates?.length
      ? [
          ...params.credentialCandidates.map((candidate) => ({
            selectionId: candidate.selectionId,
            label: credentialSelectionLabel(candidate.credential, candidate.binding),
            description: candidate.binding.id,
          })),
          { selectionId: null, label: "No credential", description: "Send the request without credential injection" },
        ]
      : undefined;
    const credentialDetails =
      params.credential && params.binding && params.targetUrl
        ? credentialApprovalDetails(params.credential, params.binding, params.targetUrl, params.method)
        : [];
    const result = await this.deps.approvalQueue.requestCapability({
      kind: "capability",
      callerId: params.callerId,
      callerKind,
      repoPath: params.attribution.repoPath,
      effectiveVersion: params.attribution.effectiveVersion,
      capability: "egress",
      dedupKey: `egress:${params.resourceKey}`,
      title: `${params.attribution.repoPath} wants to access ${params.resourceLabel}`,
      resource: {
        type: params.method === "CONNECT" ? "host-port" : "origin",
        label: params.method === "CONNECT" ? "Host" : "Origin",
        value: params.resourceLabel,
      },
      details: [{ label: "Method", value: params.method }, ...credentialDetails],
      credentialOptions,
      defaultCredentialSelectionId: params.binding
        ? credentialSelectionId(params.credential!, params.binding)
        : null,
    });
    const decision = result.decision;
    if (decision === "deny") {
      throw new ForwardRejection(403, "egress-denied", "egress-denied");
    }
    const selectedCredentialSelectionId = result.credentialSelectionId ?? null;
    if (decision !== "once") {
      this.deps.capabilityGrantStore.grant("egress", params.resourceKey, identity, decision, {
        credentialSelectionId: selectedCredentialSelectionId,
      });
    }
    return selectedCredentialSelectionId;
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

function describeGitHttpOperation(
  targetUrl: URL,
  method: string
): {
  action: "read" | "write";
  label: string;
  remote: string;
  service?: string;
} {
  const service = targetUrl.searchParams.get("service") ?? gitServiceFromPath(targetUrl.pathname);
  const action = service === "git-receive-pack" ? "write" : "read";
  return {
    action,
    label: action === "write" ? "git push" : gitReadLabel(service, method),
    remote: gitRemoteFromUrl(targetUrl),
    service: service ?? undefined,
  };
}

function gitServiceFromPath(pathname: string): string | null {
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

function isExposedInternalGatewayHttpRoute(method: string, pathname: string): boolean {
  if (method.toUpperCase() === "GET" && pathname === "/healthz") return true;
  if (pathname.startsWith("/_r/")) return true;
  if (pathname.startsWith("/_w/")) return true;
  if (pathname.startsWith("/_git/")) return true;
  return method.toUpperCase() === "POST" && pathname === "/rpc";
}

function isExposedInternalGatewayUpgradeRoute(pathname: string): boolean {
  return (
    pathname === "/rpc" ||
    pathname.startsWith("/_r/") ||
    pathname.startsWith("/_w/") ||
    pathname.startsWith("/cdp/")
  );
}

function credentialSelectionId(credential: Credential, binding: CredentialBinding): string {
  return JSON.stringify([credential.id ?? credential.connectionId, binding.id]);
}

function credentialSelectionLabel(credential: Credential, binding: CredentialBinding): string {
  const label = credential.label ?? credential.connectionLabel ?? credential.id ?? credential.connectionId;
  return `${label} (${binding.id})`;
}

function credentialApprovalDetails(
  credential: Credential,
  binding: CredentialBinding,
  targetUrl: URL,
  method: string
): Array<{ label: string; value: string }> {
  const details = [
    { label: "Credential", value: credential.label ?? credential.connectionLabel ?? binding.id },
    { label: "Credential binding", value: binding.id },
  ];
  if (binding.use === "git-http" || binding.use === "git-ssh") {
    const operation = describeGitHttpOperation(targetUrl, method);
    details.push(
      { label: "Git operation", value: operation.label },
      { label: "Git remote", value: operation.remote }
    );
    if (operation.service) {
      details.push({ label: "Git service", value: operation.service });
    }
  }
  return details;
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

function parseBasicProxyAuthorization(header: string | null): string | null {
  if (!header) return null;
  const [scheme, encoded, ...extra] = header.trim().split(/\s+/);
  if (!scheme || !encoded || extra.length > 0 || scheme.toLowerCase() !== "basic") {
    return null;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  if (username !== "natstack" || password.length === 0) return null;
  return password;
}

function parseConnectAuthority(authority: string): { host: string; port: number } | null {
  if (!authority.trim()) return null;
  try {
    const parsed = new URL(`http://${authority}`);
    const host = normalizeAuthorityHost(parsed.hostname);
    const port = parsed.port ? Number(parsed.port) : 443;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }
    return { host, port };
  } catch {
    return null;
  }
}

function normalizeAuthorityHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function statusMessageFor(statusCode: number): string {
  return STATUS_CODES[statusCode] ?? "Error";
}

function renderUpgradeResponse(upstreamResponse: IncomingMessage): string {
  const statusCode = upstreamResponse.statusCode ?? 101;
  return renderHttpResponseHead(statusCode, upstreamResponse.rawHeaders);
}

function renderHttpResponseHead(statusCode: number, rawHeaders: string[]): string {
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessageFor(statusCode)}`];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (!name || value === undefined) {
      continue;
    }
    lines.push(`${name}: ${value}`);
  }
  lines.push("", "");
  return lines.join("\r\n");
}
