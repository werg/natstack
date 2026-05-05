import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHmac, randomBytes } from "node:crypto";
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
  CredentialGrantAction,
  CredentialUseGrant,
} from "../../../packages/shared/src/credentials/types.js";
import {
  credentialCarrierStripHeaders,
  findMatchingUrlAudience,
  renderCredentialBasicAuthValue,
  renderCredentialHeaderValue,
} from "../../../packages/shared/src/credentials/urlAudience.js";
import type { CodeIdentityResolver, ResolvedCodeIdentity } from "./codeIdentityResolver.js";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import { CredentialSessionGrantStore, type CredentialSessionGrantResource } from "./credentialSessionGrants.js";
import { CredentialLifecycleError, type CredentialLifecycle } from "./credentialLifecycle.js";

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

export interface CredentialStore {
  loadUrlBound(id: string): Promise<Credential | null> | Credential | null;
  listUrlBound?(): Promise<Credential[]> | Credential[];
  saveUrlBound?(credential: Credential & { id: string }): Promise<void> | void;
}

export interface EgressProxyDeps {
  credentialStore: CredentialStore;
  auditLog: Pick<AuditLog, "append">;
  codeIdentityResolver: Pick<CodeIdentityResolver, "resolveByCallerId">;
  approvalQueue?: ApprovalQueue;
  sessionGrantStore?: CredentialSessionGrantStore;
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
  private readonly sessionGrantStore: CredentialSessionGrantStore;

  constructor(private readonly deps: EgressProxyDeps) {
    this.sessionGrantStore = deps.sessionGrantStore ?? new CredentialSessionGrantStore();
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
    credentialId?: string;
  }): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }> {
    const body = params.body;
    const bytesOut = body ? Buffer.byteLength(body) : 0;
    return this.executeAuthorizedRequest({
      callerId: params.callerId,
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
          body,
        });
        const responseBody = await response.text();
        return {
          statusCode: response.status,
          bytesIn: Buffer.byteLength(responseBody),
          bytesOut,
          payload: {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            body: responseBody,
          },
        };
      },
    });
  }

  async forwardGitHttp(params: {
    callerId: string;
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
      callerId: params.callerId,
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
    method = "GET",
  ): { headers: OutgoingHttpHeaders; targetUrl: URL } {
    const headers: OutgoingHttpHeaders = {};

    for (const [name, value] of this.iterateHeaders(inputHeaders)) {
      if (HOP_BY_HOP_REQUEST_HEADERS.has(name.toLowerCase())) {
        continue;
      }
      headers[name.toLowerCase()] = value;
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
          credential.accessToken,
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
    const targetUrl = this.resolveTargetUrl(req);
    if (!targetUrl) {
      this.respondWithError(res, 400, "Proxy request URL is invalid");
      return;
    }

    try {
      await this.executeAuthorizedRequest({
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

  private async executeAuthorizedRequest<T>(params: {
    callerId?: string | null;
    method: string;
    targetUrl: URL;
    inputHeaders: IncomingHttpHeaders | Headers | Record<string, string | string[] | undefined>;
    credentialId?: string;
    credentialUse?: CredentialBindingUse;
    initialBytesOut?: number;
    replaySafe?: boolean;
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
    targetUrl: URL;
    method: string;
    credentialId?: string;
    credentialUse: CredentialBindingUse;
  }): Promise<Authorization> {
    const attribution = params.callerId ? this.resolveAttribution(params.callerId, params.credentialId) : null;
    if (!params.credentialId) {
      const credential = attribution
        ? await this.resolveCredentialForRequest(params.targetUrl, attribution, params.credentialUse, params.method)
        : null;
      return {
        attribution,
        credential,
        binding: credential ? this.findCredentialBinding(credential, params.targetUrl, params.credentialUse) : null,
        connectionId: credential?.id ?? null,
        scopes: credential?.scopes ?? [],
      };
    }

    let credential = await Promise.resolve(this.deps.credentialStore.loadUrlBound(params.credentialId));
    if (!credential || !credential.bindings?.length || credential.revokedAt) {
      throw new ForwardRejection(403, "credential-unavailable", "credential-unavailable");
    }
    credential = await this.refreshCredentialForUse(credential);
    if (credential.expiresAt && credential.expiresAt <= Date.now()) {
      throw new ForwardRejection(403, "credential-expired", "credential-expired");
    }
    const binding = this.findCredentialBinding(credential, params.targetUrl, params.credentialUse);
    if (!binding) {
      throw new ForwardRejection(403, "credential-audience-mismatch", "credential-audience-mismatch");
    }
    const usage = credentialUseResource(binding, params.targetUrl, params.method);
    if (params.callerId && !this.isCallerAllowed(credential, params.callerId, attribution, usage.sessionResource)) {
      await this.requestCredentialUseGrant(credential, binding, params.callerId, attribution, {
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

  private async resolveCredentialForRequest(
    targetUrl: URL,
    attribution: RequestAttribution,
    use: CredentialBindingUse = "fetch",
    method = "GET",
  ): Promise<Credential | null> {
    const listUrlBound = this.deps.credentialStore.listUrlBound;
    if (!listUrlBound) {
      return null;
    }
    const credentials = (await Promise.resolve(listUrlBound.call(this.deps.credentialStore)))
      .filter((credential) =>
        !credential.revokedAt
        && !!this.findCredentialBinding(credential, targetUrl, use)
      );
    if (credentials.length === 1) {
      const credential = credentials[0] ?? null;
      if (credential) {
        const binding = this.findCredentialBinding(credential, targetUrl, use);
        if (!binding) {
          throw new ForwardRejection(403, "credential-audience-mismatch", "credential-audience-mismatch");
        }
        const usage = credentialUseResource(binding, targetUrl, method);
        if (!this.isCallerAllowed(credential, attribution.callerId, attribution, usage.sessionResource)) {
          await this.requestCredentialUseGrant(credential, binding, attribution.callerId, attribution, {
            targetUrl,
            method,
          });
        }
      }
      return credential ? this.refreshCredentialForUse(credential) : null;
    }
    if (credentials.length > 1) {
      throw new ForwardRejection(409, "credential-selection-required", "credential-selection-required");
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
      return await this.deps.credentialLifecycle.refreshIfNeeded(credential as Credential & { id: string });
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
    operation: { targetUrl: URL; method: string },
  ): Promise<void> {
    if (!this.deps.approvalQueue || !attribution || !credential.id) {
      throw new ForwardRejection(403, "credential-caller-not-granted", "credential-caller-not-granted");
    }
    const decision = await this.deps.approvalQueue.request({
      callerId,
      callerKind: attribution.callerKind === "panel" ? "panel" : "worker",
      repoPath: attribution.repoPath,
      effectiveVersion: attribution.effectiveVersion,
      credentialId: credential.id,
      credentialLabel: credential.label ?? credential.connectionLabel,
      audience: binding.audience,
      injection: binding.injection,
      accountIdentity: credential.accountIdentity,
      scopes: credential.scopes,
      credentialUse: binding.use,
      gitOperation: binding.use === "git-http"
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
      throw new ForwardRejection(403, "credential-caller-not-granted", "credential-caller-not-granted");
    }
    if (decision === "once") {
      return;
    }
    const usage = credentialUseResource(binding, operation.targetUrl, operation.method);
    if (decision === "session") {
      this.sessionGrantStore.grant(credential.id, attribution, usage.sessionResource);
      return;
    }
    const saveUrlBound = this.deps.credentialStore.saveUrlBound;
    if (saveUrlBound) {
      const now = Date.now();
      await Promise.resolve(saveUrlBound.call(this.deps.credentialStore, {
        ...credential,
        grants: upsertCredentialUseGrant(
          credential.grants ?? [],
          grantForDecision(callerId, attribution, decision, now, binding, usage),
        ),
        metadata: {
          ...(credential.metadata ?? {}),
          updatedAt: String(now),
        },
      } as Credential & { id: string }));
    }
  }

  private resolveAttribution(callerId: string, credentialId?: string): RequestAttribution | null {
    const identity = this.deps.codeIdentityResolver.resolveByCallerId(callerId);
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
    resource: CredentialSessionGrantResource,
  ): boolean {
    const credentialId = credential.id ?? credential.connectionId;
    if (credentialId && attribution && this.sessionGrantStore.has(credentialId, attribution, resource)) {
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
    use: CredentialBindingUse,
  ): CredentialBinding | null {
    return this.credentialBindings(credential).find((binding) =>
      binding.use === use && !!findMatchingUrlAudience(targetUrl, binding.audience)
    ) ?? null;
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
  oauthParams["oauth_signature"] = createHmac("sha1", signingKey).update(signatureBase).digest("base64");
  return "OAuth " + Object.entries(oauthParams)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${oauthPercentEncode(key)}="${oauthPercentEncode(value)}"`)
    .join(", ");
}

function oauthPercentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function createEgressProxy(deps: EgressProxyDeps): EgressProxy {
  return new EgressProxy(deps);
}

function isCallerAllowed(
  credential: Credential,
  callerId: string,
  attribution: RequestAttribution | null,
  resource: CredentialSessionGrantResource,
): boolean {
  return !!credential.grants?.some((grant) =>
    grant.bindingId === resource.bindingId
    && grant.resource === resource.resource
    && grant.action === resource.action
    && (
      (grant.scope === "caller" && grant.callerId === callerId)
      || (
        !!attribution
        && (
          (grant.scope === "repo" && grant.repoPath === attribution.repoPath)
          || (
            grant.scope === "version"
            && grant.repoPath === attribution.repoPath
            && grant.effectiveVersion === attribution.effectiveVersion
          )
        )
      )
    )
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

function describeGitHttpOperation(targetUrl: URL, method: string): {
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

function credentialUseResource(
  binding: CredentialBinding,
  targetUrl: URL,
  method: string,
): {
  resource: string;
  action: CredentialGrantAction;
  sessionResource: CredentialSessionGrantResource;
} {
  const resource = binding.use === "git-http"
    ? gitRemoteFromUrl(targetUrl)
    : findMatchingUrlAudience(targetUrl, binding.audience)?.url ?? targetUrl.origin;
  const action: CredentialGrantAction = binding.use === "git-http"
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
  oauthOrigins: readonly (string | undefined)[],
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
  return Math.min(DEFAULT_RETRY_MAX_DELAY_MS, DEFAULT_RETRY_INITIAL_DELAY_MS * 2 ** (attempt - 1)) + jitter;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCircuitState(circuits: Map<string, CircuitState>, key: string): AuditEntry["breakerState"] {
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
  circuits.set(key, failures >= CIRCUIT_FAILURE_THRESHOLD
    ? { failures, state: "open", openedAt: Date.now() }
    : { failures, state: current.state === "half-open" ? "open" : "closed", openedAt: current.openedAt });
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
      if (typeof cookie.expirationDate === "number" && cookie.expirationDate > 0 && cookie.expirationDate <= nowSeconds) {
        return false;
      }
      return cookieDomainMatches(cookie.domain, targetUrl.hostname) && cookiePathMatches(cookie.path, targetUrl.pathname);
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
  return requestPath === normalizedCookiePath || requestPath.startsWith(
    normalizedCookiePath.endsWith("/") ? normalizedCookiePath : `${normalizedCookiePath}/`,
  );
}

function grantForDecision(
  callerId: string,
  attribution: RequestAttribution,
  decision: Exclude<GrantedDecision, "deny" | "once" | "session">,
  grantedAt: number,
  binding: CredentialBinding,
  usage: ReturnType<typeof credentialUseResource>,
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

function upsertCredentialUseGrant(grants: CredentialUseGrant[], grant: CredentialUseGrant): CredentialUseGrant[] {
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
