import {
  createHash,
  createHmac,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import * as http from "node:http";
import { createDevLogger } from "@natstack/dev-log";
import type { EventName, EventPayloads, EventService } from "@natstack/shared/eventsService";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import { buildPublicUrl, isPublicUrlVerified } from "../publicUrl.js";
import type { AuditLog } from "../../../packages/shared/src/credentials/audit.js";
import {
  ClientConfigStore,
  type ClientConfigRecord,
} from "../../../packages/shared/src/credentials/clientConfigStore.js";
import { CredentialStore } from "../../../packages/shared/src/credentials/store.js";
import type {
  AccountIdentity,
  AuditEntry,
  ClientConfigStatus,
  ConnectCredentialRequest,
  Credential,
  CredentialAuditEvent,
  CredentialBinding,
  CredentialBindingUse,
  CredentialFlowType,
  CredentialGrantAction,
  CredentialUseGrant,
  DeleteClientConfigRequest,
  ForwardOAuthCallbackRequest,
  GetClientConfigStatusRequest,
  GrantUrlBoundCredentialRequest,
  OAuthConnectionErrorCode,
  OAuthConnectionTransactionState,
  OAuthAccountValidationSpec,
  ProxyGitHttpRequest,
  ProxyGitHttpResponse,
  RequestCredentialInputRequest,
  ConfigureClientRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
  UrlAudience,
} from "../../../packages/shared/src/credentials/types.js";
import {
  findMatchingUrlAudience,
  normalizeCredentialInjection,
  normalizeUrlAudiences,
} from "../../../packages/shared/src/credentials/urlAudience.js";
import type {
  CallerKind,
  ServiceContext,
  DeferredResult,
} from "../../../packages/shared/src/serviceDispatcher.js";
import { deferIfNeeded } from "../../../packages/shared/src/serviceDispatcher.js";
import type { ServiceDefinition } from "../../../packages/shared/src/serviceDefinition.js";
import {
  ConnectCredentialParamsSchema,
  credentialsMethods,
  type AuditParams,
  type ConfigureClientParams,
  type ConnectCredentialParams,
  type CredentialIdParams,
  type DeleteClientConfigParams,
  type ForwardOAuthCallbackParams,
  type GetClientConfigStatusParams,
  type GrantCredentialParams,
  type ProxyFetchParams,
  type ProxyGitHttpParams,
  type RequestClientConfigParams,
  type RequestCredentialInputParams,
  type ResolveCredentialParams,
  type StoreUrlBoundCredentialParams,
} from "../../../packages/shared/src/serviceSchemas/credentials.js";
import type { EgressProxy } from "./egressProxy.js";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import { CredentialLifecycle, CredentialLifecycleError } from "./credentialLifecycle.js";
import {
  CredentialSessionGrantStore,
  type CredentialSessionGrantResource,
  type CredentialSessionGrantScope,
} from "./credentialSessionGrants.js";
import { assertPresent } from "../../lintHelpers";

const log = createDevLogger("CredentialService");
type BrowserHandoffCallerKind = "app" | "panel" | "shell";
type BrowserDeliveryCallerKind = "app" | "shell";

/** Connect flows that block on a human (browser auth / device code) — eligible
 * for out-of-band deferral. Machine flows (client-credentials, jwt-bearer,
 * api-key, etc.) complete inline. */
const INTERACTIVE_CONNECT_FLOWS = new Set<string>([
  "oauth2-auth-code-pkce",
  "oauth2-auth-code",
  "oauth2-device-code",
  "oauth1a",
  "browser-cookie-session",
  "saml-browser-session",
]);

const PENDING_OAUTH_TTL_MS = 10 * 60 * 1000;
const OAUTH_USERINFO_TIMEOUT_MS = 15_000;
const DEFAULT_LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_CALLBACK_PATH = "/oauth/callback";
const PUBLIC_OAUTH_CALLBACK_PATH = "/_r/s/credentials/oauth/callback";
const CLIENT_LOOPBACK_TIMEOUT_SKEW_MS = 5_000;
const RESERVED_OAUTH_AUTHORIZE_PARAMS = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
]);

type AuthCodeConnectRequest = {
  flow: {
    authorizeUrl?: string;
    tokenUrl?: string;
    clientId?: string;
    clientConfigId?: string;
    scopes?: string[];
    extraAuthorizeParams?: Record<string, string>;
    allowMissingExpiry?: boolean;
    persistRefreshToken?: boolean;
    accountValidation?: OAuthAccountValidationSpec;
    revocationUrl?: string;
  };
  credential: ConnectCredentialRequest["credential"];
  redirect?: ConnectCredentialRequest["redirect"];
  browser?: ConnectCredentialRequest["browser"];
  pkce: boolean;
  tokenAuth?: "none" | "client_secret_post" | "client_secret_basic" | "private_key_jwt";
};
type InternalOAuthConnectionRequest = {
  flow: {
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    privateKeyPem?: string;
    keyId?: string;
    keyAlgorithm?: string;
    scopes?: string[];
    extraAuthorizeParams?: Record<string, string>;
    allowMissingExpiry?: boolean;
    persistRefreshToken?: boolean;
    accountValidation?: AuthCodeConnectRequest["flow"]["accountValidation"];
    revocationUrl?: string;
  };
  credential: ConnectCredentialRequest["credential"];
  redirectUri: string;
  pkce: boolean;
  tokenAuth: "none" | "client_secret_post" | "client_secret_basic" | "private_key_jwt";
};

interface CredentialUseContext {
  binding: CredentialBinding;
  resource: string;
  action: CredentialGrantAction;
  sessionResource: CredentialSessionGrantResource;
  gitOperation?: {
    action: "read" | "write";
    label: string;
    remote: string;
    service?: string;
  };
}

function canonicalUrl(raw: string): string {
  return new URL(raw).toString();
}

function validateClientConfigUrls(authorizeUrl: string, tokenUrl: string): void {
  const authorize = new URL(authorizeUrl);
  const token = new URL(tokenUrl);
  if (authorize.protocol !== "https:") {
    throw new Error("OAuth authorizeUrl must use https");
  }
  if (token.protocol !== "https:") {
    throw new Error("OAuth tokenUrl must use https");
  }
  if (authorize.hash) {
    throw new Error("OAuth authorizeUrl must not include a fragment");
  }
  if (token.hash) {
    throw new Error("OAuth tokenUrl must not include a fragment");
  }
  if (token.search) {
    throw new Error("OAuth tokenUrl must not include query parameters");
  }
}

function validateOAuthCredentialRequest(request: InternalOAuthConnectionRequest): void {
  validateClientConfigUrls(
    canonicalUrl(request.flow.authorizeUrl),
    canonicalUrl(request.flow.tokenUrl)
  );
  const redirect = new URL(request.redirectUri);
  if (
    !(
      (redirect.protocol === "http:" && isLoopbackHost(redirect.hostname)) ||
      redirect.protocol === "https:"
    )
  ) {
    throw new Error("OAuth redirectUri must be host-created loopback HTTP or public HTTPS");
  }
  if (redirect.hash || redirect.search) {
    throw new Error("OAuth redirectUri must not include query parameters or a fragment");
  }
  const audience = normalizeUrlAudiences(request.credential.audience);
  const injection = normalizeCredentialInjection(request.credential.injection);
  if (injection.type !== "header") {
    throw new Error("OAuth credentials only support constrained header injection");
  }
  normalizeCredentialBindings(request.credential.bindings, { audience, injection });
  if (request.flow.accountValidation?.userinfo?.url) {
    const userinfo = new URL(request.flow.accountValidation.userinfo.url);
    if (userinfo.protocol !== "https:") {
      throw new Error("OAuth userinfo url must use https");
    }
    if (userinfo.hash) {
      throw new Error("OAuth userinfo url must not include a fragment");
    }
  }
}

/**
 * Decide which redirect strategy to use when the caller doesn't specify one.
 *
 * Loopback (browser-on-server) is the safe default for a personal desktop
 * server. When the public URL is verified working — either supplied
 * explicitly by the operator or auto-detected and reachability-tested —
 * default to "public" so OAuth works for mobile and remote-desktop clients
 * without each callsite having to know.
 *
 * Critically, an auto-detected URL that *failed* its reachability check
 * stays loopback by default — desktop in-process panels keep working even
 * when Tailscale serve provisioning fell through.
 */
function resolveDefaultRedirectStrategy(
  requested: OAuthRedirectStrategy | undefined
): OAuthRedirectStrategy {
  if (requested) return requested;
  return isPublicUrlVerified() ? "public" : "loopback";
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") {
    return true;
  }
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return !!ipv4 && Number(ipv4[1]) === 127;
}

type OAuthRedirectStrategy = "loopback" | "public" | "client-forwarded" | "client-loopback";

function buildClientLoopbackRedirectUri(
  redirect: NonNullable<ConnectCredentialRequest["redirect"]>
): string {
  const host = redirect.host ?? "localhost";
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new OAuthConnectionError(
      "redirect_unavailable",
      "client-loopback redirects require localhost or 127.0.0.1"
    );
  }
  const port = redirect.port;
  if (!port || port < 1 || port > 65535) {
    throw new OAuthConnectionError(
      "redirect_unavailable",
      "client-loopback redirects require a fixed port"
    );
  }
  const callbackPath = normalizeCallbackPath(redirect.callbackPath ?? DEFAULT_CALLBACK_PATH);
  return `http://${host}:${port}${callbackPath}`;
}

function buildClientLoopbackHandoff(
  tx: OAuthConnectionTransaction,
  state: string
): {
  transactionId: string;
  redirectUri: string;
  host: string;
  port: number;
  callbackPath: string;
  state: string;
  timeoutMs: number;
} {
  const redirect = new URL(tx.redirectUri);
  return {
    transactionId: tx.id,
    redirectUri: tx.redirectUri,
    host: redirect.hostname,
    port: Number(redirect.port),
    callbackPath: redirect.pathname,
    state,
    timeoutMs: Math.max(1_000, tx.expiresAt - Date.now() - CLIENT_LOOPBACK_TIMEOUT_SKEW_MS),
  };
}

interface CredentialServiceDeps {
  credentialStore?: CredentialStore;
  clientConfigStore?: ClientConfigStore;
  auditLog?: AuditLog;
  eventService?: Pick<EventService, "emit" | "emitToCaller" | "emitToConnection">;
  connectionLookup?: {
    getAuthorizingShell(principalId: string): {
      caller: { runtime: { id: string; kind: string } };
      connectionId: string;
    } | null;
  };
  egressProxy?: Pick<EgressProxy, "forwardProxyFetch" | "forwardGitHttp">;
  approvalQueue?: ApprovalQueue;
  sessionGrantStore?: CredentialSessionGrantStore;
  credentialLifecycle?: CredentialLifecycle;
  sessionCredentialCapture?: SessionCredentialCapture;
}

interface SessionCredentialCapture {
  captureCookies(params: {
    signInUrl: string;
    origins: string[];
    cookieNames: string[];
    completionUrlPattern?: string;
    maxTtlSeconds?: number;
    browser?: "internal" | "external";
    signal?: AbortSignal;
  }): Promise<{
    cookieHeader: string;
    cookieSession?: Credential["cookieSession"];
    expiresAt?: number;
    accountIdentity?: Partial<AccountIdentity>;
  }>;
  captureSamlSession?(params: {
    signInUrl: string;
    spAudience: string;
    cookieNames?: string[];
    assertion?: {
      issuer: string;
      audience: string;
      recipient: string;
      persistAssertion?: boolean;
    };
    completionUrlPattern?: string;
    maxTtlSeconds?: number;
    browser?: "internal" | "external";
    signal?: AbortSignal;
  }): Promise<{
    cookieHeader?: string;
    cookieSession?: Credential["cookieSession"];
    assertion?: string;
    expiresAt?: number;
    accountIdentity?: Partial<AccountIdentity>;
  }>;
}

interface OAuthConnectionTransaction {
  id: string;
  state: OAuthConnectionTransactionState;
  createdAt: number;
  expiresAt: number;
  callerId: string;
  callerKind: CallerKind;
  repoPath: string;
  effectiveVersion: string;
  stateParam: string;
  redirectUri: string;
  redirectStrategy: OAuthRedirectStrategy;
  deliveryCallerId?: string;
  deliveryCallerKind?: BrowserDeliveryCallerKind;
  callbackUsed: boolean;
  resolve: (value: { code: string; state: string; url: string }) => void;
  reject: (error: Error) => void;
  wait: Promise<{ code: string; state: string; url: string }>;
  timer: NodeJS.Timeout;
}

class OAuthConnectionError extends Error {
  code: OAuthConnectionErrorCode;

  constructor(code: OAuthConnectionErrorCode, message: string = code) {
    super(message);
    this.code = code;
  }
}

export function createCredentialService(deps: CredentialServiceDeps = {}): ServiceDefinition {
  const credentialStore = deps.credentialStore ?? new CredentialStore();
  const clientConfigStore = deps.clientConfigStore ?? new ClientConfigStore();
  const auditLog = deps.auditLog;
  const eventService = deps.eventService;
  const connectionLookup = deps.connectionLookup;
  const egressProxy = deps.egressProxy;
  const approvalQueue = deps.approvalQueue;
  const sessionGrantStore = deps.sessionGrantStore ?? new CredentialSessionGrantStore();
  const sessionCredentialCapture = deps.sessionCredentialCapture;
  const credentialLifecycle =
    deps.credentialLifecycle ??
    new CredentialLifecycle({
      credentialStore,
      clientConfigStore,
    });
  const oauthTransactions = new Map<string, OAuthConnectionTransaction>();

  type UserlandRuntimeContext = ServiceContext & {
    caller: ServiceContext["caller"] & {
      runtime: ServiceContext["caller"]["runtime"] & {
        kind: "panel" | "app" | "worker" | "do";
      };
    };
  };

  function isUserlandRuntimeCaller(ctx: ServiceContext): ctx is UserlandRuntimeContext {
    return (
      ctx.caller.runtime.kind === "panel" ||
      ctx.caller.runtime.kind === "app" ||
      ctx.caller.runtime.kind === "worker" ||
      ctx.caller.runtime.kind === "do"
    );
  }

  function resolveBrowserHandoffTarget(
    ctx: ServiceContext,
    handoffTarget?: { callerId: string; callerKind: BrowserHandoffCallerKind }
  ): {
    deliveryCallerId: string;
    deliveryCallerKind: BrowserDeliveryCallerKind;
    deliveryConnectionId?: string;
    parentPanelId?: string;
  } | null {
    const targetCallerId = handoffTarget?.callerId ?? ctx.caller.runtime.id;
    const targetCallerKind = handoffTarget?.callerKind ?? ctx.caller.runtime.kind;
    if (targetCallerKind === "shell") {
      return {
        deliveryCallerId: targetCallerId,
        deliveryCallerKind: "shell",
        deliveryConnectionId:
          targetCallerId === ctx.caller.runtime.id ? ctx.connectionId : undefined,
      };
    }
    if (targetCallerKind === "app") {
      return {
        deliveryCallerId: targetCallerId,
        deliveryCallerKind: "app",
        deliveryConnectionId:
          targetCallerId === ctx.caller.runtime.id ? ctx.connectionId : undefined,
      };
    }
    if (targetCallerKind === "panel") {
      const shellConnection = connectionLookup?.getAuthorizingShell(targetCallerId);
      if (!shellConnection) {
        const ownerCallerId = !connectionLookup ? targetCallerId : undefined;
        if (!ownerCallerId) return null;
        return {
          deliveryCallerId: ownerCallerId,
          deliveryCallerKind: "shell",
          parentPanelId: targetCallerId,
        };
      }
      return {
        deliveryCallerId: shellConnection.caller.runtime.id,
        deliveryCallerKind: "shell",
        deliveryConnectionId: shellConnection.connectionId,
        parentPanelId: targetCallerId,
      };
    }
    return null;
  }

  function emitToBrowserTarget<E extends EventName>(
    target: { deliveryCallerId: string; deliveryConnectionId?: string },
    event: E,
    payload?: EventPayloads[E]
  ): boolean {
    if (!eventService) return false;
    if (!target.deliveryConnectionId) {
      return eventService.emitToCaller(target.deliveryCallerId, event, payload);
    }
    if (
      eventService.emitToConnection(
        target.deliveryCallerId,
        target.deliveryConnectionId,
        event,
        payload
      )
    ) {
      return true;
    }
    log.warn("Browser handoff owner connection missing; falling back to caller-wide delivery", {
      callerId: target.deliveryCallerId,
      connectionId: target.deliveryConnectionId,
      event,
    });
    return eventService.emitToCaller(target.deliveryCallerId, event, payload);
  }

  async function storeCredential(
    ctx: ServiceContext,
    params: StoreUrlBoundCredentialParams,
    opts: {
      approvalDecision?: Exclude<GrantedDecision, "deny">;
      preapprovedUseDecision?: Exclude<GrantedDecision, "deny">;
      replaceCredentialId?: string;
      replacementCredentialLabel?: string;
    } = {}
  ): Promise<StoredCredentialSummary> {
    const request = params as StoreUrlBoundCredentialRequest;
    const id = opts.replaceCredentialId ?? randomUUID();
    const audience = normalizeUrlAudiences(request.audience);
    const injection = normalizeCredentialInjection(request.injection);
    const bindings = normalizeCredentialBindings(request.bindings, { audience, injection });
    const identity = ctx.caller.code ?? null;
    const now = Date.now();
    const approvalIdentity = resolveApprovalIdentity(ctx);
    if (!opts.approvalDecision) {
      await requestCredentialApproval(ctx, {
        credentialId: id,
        credentialLabel: request.label,
        audience,
        injection,
        accountIdentity: normalizeAccountIdentity(request.accountIdentity, ctx.caller.runtime.id),
        scopes: request.scopes ?? [],
        identity: approvalIdentity,
        metadata: request.metadata,
        replacementCredentialLabel: opts.replacementCredentialLabel,
      });
    }
    const owner = {
      sourceId: identity?.repoPath ?? ctx.caller.runtime.id,
      sourceKind: identity ? ("workspace" as const) : ("user" as const),
      label: identity?.repoPath ?? ctx.caller.runtime.id,
    };
    const accountIdentity = normalizeAccountIdentity(
      request.accountIdentity,
      ctx.caller.runtime.id
    );
    const credential: Credential = {
      id,
      label: request.label,
      owner,
      bindings,
      grants: [],
      providerId: "url-bound",
      connectionId: id,
      connectionLabel: request.label,
      accountIdentity,
      accessToken: request.material.token,
      scopes: request.scopes ?? [],
      expiresAt: request.expiresAt,
      metadata: {
        ...(request.metadata ?? {}),
        createdAt: String(now),
        updatedAt: String(now),
        materialType: request.material.type,
      },
    };

    if (opts.preapprovedUseDecision) {
      applyPreapprovedCredentialUseGrants(
        ctx,
        credential as Credential & { id: string },
        bindings,
        opts.preapprovedUseDecision,
        now
      );
    }

    await credentialStore.saveUrlBound(credential as Credential & { id: string });
    await appendAudit({
      type: opts.replaceCredentialId
        ? "connection_credential.replaced"
        : "connection_credential.created",
      ts: now,
      callerId: ctx.caller.runtime.id,
      providerId: "url-bound",
      connectionId: id,
      storageKind: "connection-credential",
      fieldNames: ["credential"],
    });
    return summarizeUrlBoundCredential(credential);
  }

  function createOAuthAuthorizeRequest(
    request: InternalOAuthConnectionRequest,
    state: string
  ): { state: string; authorizeUrl: string; codeVerifier?: string } {
    const codeVerifier = request.pkce ? randomBytes(32).toString("base64url") : undefined;
    const codeChallenge = codeVerifier
      ? createHash("sha256").update(codeVerifier).digest("base64url")
      : undefined;
    const authorizeUrl = new URL(request.flow.authorizeUrl);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", request.flow.clientId);
    authorizeUrl.searchParams.set("redirect_uri", request.redirectUri);
    if (codeChallenge) {
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
    }
    authorizeUrl.searchParams.set("state", state);
    if (request.flow.scopes?.length) {
      authorizeUrl.searchParams.set("scope", request.flow.scopes.join(" "));
    }
    for (const [key, value] of Object.entries(request.flow.extraAuthorizeParams ?? {})) {
      if (RESERVED_OAUTH_AUTHORIZE_PARAMS.has(key.toLowerCase())) {
        throw new Error(`OAuth extraAuthorizeParams cannot override ${key}`);
      }
      authorizeUrl.searchParams.set(key, value);
    }
    return { state, authorizeUrl: authorizeUrl.toString(), codeVerifier };
  }

  async function requestClientConfig(
    ctx: ServiceContext,
    params: RequestClientConfigParams
  ): Promise<ClientConfigStatus> {
    const request = params as ConfigureClientRequest;
    if (!approvalQueue || !isUserlandRuntimeCaller(ctx)) {
      throw new Error("client config approval is unavailable");
    }
    const authorizeUrl = canonicalUrl(request.authorizeUrl);
    const tokenUrl = canonicalUrl(request.tokenUrl);
    validateClientConfigUrls(authorizeUrl, tokenUrl);
    normalizeUrlAudiences([
      { url: authorizeUrl, match: "exact" },
      { url: tokenUrl, match: "exact" },
    ]);
    const identity = resolveApprovalIdentity(ctx);
    const result = await approvalQueue.requestClientConfig({
      kind: "client-config",
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      configId: request.configId,
      authorizeUrl,
      tokenUrl,
      title: request.title,
      description: request.description,
      fields: request.fields.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required ?? false,
        description: field.description,
      })),
    });
    if (result.decision !== "submit") {
      throw new Error("client config approval denied");
    }

    const now = Date.now();
    const existing = await clientConfigStore.load(request.configId);
    if (existing) {
      if (canonicalUrl(existing.authorizeUrl) !== authorizeUrl) {
        throw new Error("client config authorizeUrl is immutable for this configId");
      }
      if (canonicalUrl(existing.tokenUrl) !== tokenUrl) {
        throw new Error("client config tokenUrl is immutable for this configId");
      }
    }
    const fields = { ...(existing?.fields ?? {}) };
    for (const field of request.fields) {
      const value = result.values[field.name]?.trim() ?? "";
      if ((field.required ?? false) && !value) {
        throw new Error(`client config field is required: ${field.name}`);
      }
      if (value) {
        fields[field.name] = {
          value,
          type: field.type,
          updatedAt: now,
        };
      }
    }
    const version = randomUUID();
    const versions = { ...(existing?.versions ?? {}) };
    const requestFlowTypes = (params as ConfigureClientRequest).flowTypes;
    const requestStatus = (params as ConfigureClientRequest).status;
    const allowRefreshWhenDisabled = (params as ConfigureClientRequest).allowRefreshWhenDisabled;
    versions[version] = {
      version,
      authorizeUrl,
      tokenUrl,
      status: requestStatus ?? existing?.status ?? "active",
      flowTypes: requestFlowTypes ?? existing?.flowTypes ?? ["oauth2-auth-code-pkce"],
      allowRefreshWhenDisabled: allowRefreshWhenDisabled ?? existing?.allowRefreshWhenDisabled,
      fields,
      createdAt: now,
    };
    const record = {
      configId: request.configId,
      currentVersion: version,
      owner: existing?.owner ?? {
        callerId: ctx.caller.runtime.id,
        callerKind: ctx.caller.runtime.kind,
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
      },
      authorizeUrl,
      tokenUrl,
      status: requestStatus ?? existing?.status ?? "active",
      flowTypes: requestFlowTypes ?? existing?.flowTypes ?? ["oauth2-auth-code-pkce"],
      allowRefreshWhenDisabled: allowRefreshWhenDisabled ?? existing?.allowRefreshWhenDisabled,
      fields,
      versions,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await pruneClientConfigVersions(record);
    await clientConfigStore.save(record);
    await appendAudit({
      type: "client_config.updated",
      ts: now,
      callerId: ctx.caller.runtime.id,
      configId: request.configId,
      authorizeUrl,
      tokenUrl,
      fieldNames: request.fields.map((field) => field.name),
    });
    return clientConfigStore.summarize(request.configId, record, request.fields);
  }

  async function configureClient(
    ctx: ServiceContext,
    params: ConfigureClientParams
  ): Promise<ClientConfigStatus> {
    const request = params as ConfigureClientRequest;
    const status = await requestClientConfig(ctx, request);
    return {
      ...status,
      flowTypes: request.flowTypes ?? status.flowTypes,
      status: request.status ?? status.status ?? "active",
    };
  }

  async function getClientConfigStatus(
    ctx: ServiceContext,
    params: GetClientConfigStatusParams
  ): Promise<ClientConfigStatus> {
    const request = params as GetClientConfigStatusRequest;
    const record = await clientConfigStore.load(request.configId);
    if (
      record?.owner &&
      !isSameConfigTrustScope(
        { ...resolveApprovalIdentity(ctx), callerId: ctx.caller.runtime.id },
        record.owner
      )
    ) {
      throw new OAuthConnectionError("client_not_authorized");
    }
    return clientConfigStore.summarize(request.configId, record, request.fields);
  }

  async function deleteClientConfig(
    ctx: ServiceContext,
    params: DeleteClientConfigParams
  ): Promise<void> {
    const request = params as DeleteClientConfigRequest;
    const existing = await clientConfigStore.load(request.configId);
    if (!existing) return;
    if (
      existing.owner &&
      !isSameConfigTrustScope(
        { ...resolveApprovalIdentity(ctx), callerId: ctx.caller.runtime.id },
        existing.owner
      )
    ) {
      throw new Error("Client config deletion is not authorized for this caller");
    }
    if (approvalQueue && isUserlandRuntimeCaller(ctx)) {
      const identity = resolveApprovalIdentity(ctx);
      const decision = await approvalQueue.request({
        kind: "capability",
        dedupKey: `delete-client-config:${request.configId}`,
        callerId: ctx.caller.runtime.id,
        callerKind: ctx.caller.runtime.kind,
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
        capability: "client-config-delete",
        title: "Disable service configuration",
        description: "Delete this client config for new connections and future refreshes.",
        resource: {
          type: "client-config",
          label: "Config",
          value: request.configId,
        },
        details: [
          { label: "Sign-in origin", value: new URL(existing.authorizeUrl).origin },
          { label: "Token origin", value: new URL(existing.tokenUrl).origin },
        ],
      });
      if (decision === "deny") {
        throw new Error("Client config deletion denied");
      }
    }
    await clientConfigStore.save({
      ...existing,
      status: "deleted",
      updatedAt: Date.now(),
    });
  }

  async function forwardOAuthCallback(
    ctx: ServiceContext,
    params: ForwardOAuthCallbackParams
  ): Promise<void> {
    const request = params as ForwardOAuthCallbackRequest;
    const parsed = request.url ? new URL(request.url) : null;
    const callbackState = request.state ?? parsed?.searchParams.get("state") ?? undefined;
    const tx = request.transactionId
      ? oauthTransactions.get(request.transactionId)
      : findOAuthTransactionByState(callbackState);
    if (!tx) {
      throw new OAuthConnectionError("transaction_expired");
    }
    if (tx.redirectStrategy === "client-loopback") {
      if (!request.transactionId) {
        throw new OAuthConnectionError(
          "client_not_authorized",
          "client-loopback callbacks require a transaction id"
        );
      }
      if (
        tx.deliveryCallerId !== ctx.caller.runtime.id ||
        tx.deliveryCallerKind !== ctx.caller.runtime.kind
      ) {
        throw new OAuthConnectionError("client_not_authorized");
      }
    } else if (tx.redirectStrategy === "client-forwarded") {
      if (tx.callerId !== ctx.caller.runtime.id) {
        throw new OAuthConnectionError("client_not_authorized");
      }
    } else {
      throw new OAuthConnectionError("redirect_mismatch");
    }
    await receiveOAuthCallback(tx, {
      code: request.code ?? parsed?.searchParams.get("code"),
      state: callbackState,
      error: parsed?.searchParams.get("error"),
      url: request.url ?? tx.redirectUri,
    });
  }

  async function requestCredentialInput(
    ctx: ServiceContext,
    params: RequestCredentialInputParams
  ): Promise<StoredCredentialSummary> {
    const request = params as RequestCredentialInputRequest;
    if (!approvalQueue || !isUserlandRuntimeCaller(ctx)) {
      throw new Error("Credential input approval is unavailable");
    }
    if (request.fields.length !== 1) {
      throw new Error("Credential input expects exactly one secret field");
    }
    const tokenField = assertPresent(request.fields[0]);
    if (tokenField.name !== request.material.tokenField) {
      throw new Error("Credential input tokenField must match the submitted secret field");
    }
    if (tokenField.type !== "secret") {
      throw new Error("Credential input tokenField must be a secret field");
    }
    if (tokenField.required !== true) {
      throw new Error("Credential input tokenField must be required");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const accountIdentity = normalizeAccountIdentity(
      request.credential.accountIdentity,
      ctx.caller.runtime.id
    );
    const identity = resolveApprovalIdentity(ctx);
    const result = await approvalQueue.requestCredentialInput({
      kind: "credential-input",
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      title: request.title,
      description: request.description,
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity,
      scopes: request.credential.scopes ?? [],
      fields: request.fields.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required ?? false,
        description: field.description,
      })),
    });
    if (result.decision !== "submit") {
      throw new Error("Credential input approval denied");
    }

    const token = result.values[request.material.tokenField]?.trim() ?? "";
    if (!token) {
      throw new Error(`Credential input field is required: ${request.material.tokenField}`);
    }

    return storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: {
          type: request.material.type,
          token,
        },
        accountIdentity,
        scopes: request.credential.scopes ?? [],
        metadata: request.credential.metadata,
      },
      { approvalDecision: "session" }
    );
  }

  async function connectCredential(
    ctx: ServiceContext,
    params: ConnectCredentialParams
  ): Promise<StoredCredentialSummary | DeferredResult> {
    const parsedParams = ConnectCredentialParamsSchema.parse(params);
    const { request, handoffTarget } = normalizeConnectInvocation(ctx, parsedParams);
    const dispatch = (signal?: AbortSignal): Promise<StoredCredentialSummary> => {
      switch (request.flow.type) {
        case "oauth2-auth-code-pkce":
          return connectOAuth2AuthCode(
            ctx,
            normalizePkceConnectRequest(request),
            handoffTarget,
            signal
          );
        case "oauth2-auth-code":
          return connectOAuth2AuthCode(
            ctx,
            normalizeAuthCodeConnectRequest(request),
            handoffTarget,
            signal
          );
        case "oauth2-device-code":
          return connectOAuthDeviceCode(ctx, request, signal);
        case "oauth2-client-credentials":
          return connectOAuthClientCredentials(ctx, request);
        case "oauth2-jwt-bearer":
          return connectOAuthJwtBearer(ctx, request);
        case "oauth2-token-exchange":
          return connectOAuthTokenExchange(ctx, request);
        case "oauth1a":
          return connectOAuth1a(ctx, request, handoffTarget, signal);
        case "aws-sigv4":
          return connectAwsSigV4(ctx, request);
        case "ssh-key":
          return connectSshKey(ctx, request);
        case "browser-cookie-session":
          return connectBrowserCookieSession(ctx, request, signal);
        case "saml-browser-session":
          return connectSamlBrowserSession(ctx, request, signal);
        case "api-key":
          return connectApiKey(ctx, request);
        default:
          throw new OAuthConnectionError("unsupported_flow");
      }
    };
    // Interactive flows block on a human (browser auth / device code). For a
    // deferrable DO caller, complete them out-of-band so the DO need not hold the
    // request open through the handshake. The delivered result is the credential
    // *summary* — submitted secrets are consumed server-side and never persisted
    // in any deferred-result store. Non-interactive (machine) flows run inline.
    return deferIfNeeded(ctx, INTERACTIVE_CONNECT_FLOWS.has(request.flow.type), (signal) =>
      dispatch(signal)
    );
  }

  function normalizeConnectInvocation(
    ctx: ServiceContext,
    params: ConnectCredentialParams
  ): {
    request: ConnectCredentialRequest;
    handoffTarget?: { callerId: string; callerKind: BrowserHandoffCallerKind };
  } {
    if ("spec" in params) {
      if (ctx.caller.runtime.kind === "panel") {
        throw new OAuthConnectionError(
          "client_not_authorized",
          "Panel callers cannot specify a credential browser handoff target"
        );
      }
      return {
        request: params.spec as ConnectCredentialRequest,
        handoffTarget: params.handoffTarget,
      };
    }
    return { request: params as ConnectCredentialRequest };
  }

  function normalizePkceConnectRequest(request: ConnectCredentialRequest): AuthCodeConnectRequest {
    const flow = request.flow;
    if (flow.type !== "oauth2-auth-code-pkce") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (flow.clientConfigId) {
      return {
        flow: {
          clientConfigId: flow.clientConfigId,
          scopes: flow.scopes,
          extraAuthorizeParams: flow.extraAuthorizeParams,
          allowMissingExpiry: flow.allowMissingExpiry,
          persistRefreshToken: flow.persistRefreshToken,
          accountValidation: flow.accountValidation,
          revocationUrl: flow.revocationUrl,
        },
        credential: request.credential,
        redirect: request.redirect,
        browser: request.browser,
        pkce: true,
        tokenAuth: flow.tokenAuth,
      };
    }
    if (flow.tokenAuth && flow.tokenAuth !== "none") {
      throw new OAuthConnectionError("unsupported_token_auth_method");
    }
    if (!flow.authorizeUrl || !flow.tokenUrl || !flow.clientId) {
      throw new OAuthConnectionError(
        "invalid_connection_spec",
        "oauth2-auth-code-pkce requires authorizeUrl, tokenUrl, and clientId or a clientConfigId"
      );
    }
    return {
      flow: {
        authorizeUrl: flow.authorizeUrl,
        tokenUrl: flow.tokenUrl,
        clientId: flow.clientId,
        scopes: flow.scopes,
        extraAuthorizeParams: flow.extraAuthorizeParams,
        allowMissingExpiry: flow.allowMissingExpiry,
        persistRefreshToken: flow.persistRefreshToken,
        accountValidation: flow.accountValidation,
        revocationUrl: flow.revocationUrl,
      },
      credential: request.credential,
      redirect: request.redirect,
      browser: request.browser,
      pkce: true,
      tokenAuth: flow.tokenAuth ?? "none",
    };
  }

  function normalizeAuthCodeConnectRequest(
    request: ConnectCredentialRequest
  ): AuthCodeConnectRequest {
    const flow = request.flow;
    if (flow.type !== "oauth2-auth-code") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (flow.pkce !== false || !flow.compatibilityReason) {
      throw new OAuthConnectionError("invalid_connection_spec");
    }
    if (!flow.clientConfigId && flow.tokenAuth !== "none") {
      throw new OAuthConnectionError("client_config_unavailable");
    }
    if (flow.clientConfigId) {
      return {
        flow: {
          clientConfigId: flow.clientConfigId,
          scopes: flow.scopes,
          extraAuthorizeParams: flow.extraAuthorizeParams,
          persistRefreshToken: flow.persistRefreshToken,
          accountValidation: flow.accountValidation,
          revocationUrl: flow.revocationUrl,
        },
        credential: request.credential,
        redirect: request.redirect,
        browser: request.browser,
        pkce: false,
        tokenAuth: flow.tokenAuth,
      };
    }
    if (flow.tokenAuth !== "none" || !flow.authorizeUrl || !flow.tokenUrl || !flow.clientId) {
      throw new OAuthConnectionError("invalid_connection_spec");
    }
    return {
      flow: {
        authorizeUrl: flow.authorizeUrl,
        tokenUrl: flow.tokenUrl,
        clientId: flow.clientId,
        scopes: flow.scopes,
        extraAuthorizeParams: flow.extraAuthorizeParams,
        persistRefreshToken: flow.persistRefreshToken,
        accountValidation: flow.accountValidation,
        revocationUrl: flow.revocationUrl,
      },
      credential: request.credential,
      redirect: request.redirect,
      browser: request.browser,
      pkce: false,
      tokenAuth: "none",
    };
  }

  async function connectApiKey(
    ctx: ServiceContext,
    request: ConnectCredentialRequest
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "api-key") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (!approvalQueue || !isUserlandRuntimeCaller(ctx)) {
      throw new Error("Credential input approval is unavailable");
    }
    for (const field of request.flow.fields) {
      if (field.type !== "secret" || field.required !== true) {
        throw new OAuthConnectionError(
          "invalid_connection_spec",
          "api-key fields must be required secret fields"
        );
      }
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const accountIdentity = normalizeAccountIdentity(
      request.credential.accountIdentity,
      ctx.caller.runtime.id
    );
    const identity = resolveApprovalIdentity(ctx);
    validateApiKeyMaterialTemplate(
      request.flow.materialTemplate.valueTemplate,
      request.flow.fields.map((field) => field.name)
    );
    const result = await approvalQueue.requestCredentialInput({
      kind: "credential-input",
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      title: request.flow.title ?? request.credential.label,
      description: request.flow.description,
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity,
      scopes: request.credential.scopes ?? [],
      fields: request.flow.fields.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required ?? false,
        description: field.description,
      })),
    });
    if (result.decision !== "submit") {
      throw new OAuthConnectionError("approval_denied");
    }
    const material = renderApiKeyMaterialTemplate(
      request.flow.materialTemplate.valueTemplate,
      result.values
    );
    if (!material) {
      throw new OAuthConnectionError(
        "invalid_connection_spec",
        "api-key material template produced empty material"
      );
    }
    return storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: {
          type: request.flow.materialTemplate.type,
          token: material,
        },
        accountIdentity,
        scopes: request.credential.scopes ?? [],
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: "api-key",
        },
      },
      { approvalDecision: "session" }
    );
  }

  async function connectAwsSigV4(
    ctx: ServiceContext,
    request: ConnectCredentialRequest
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "aws-sigv4") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (request.credential.injection.type !== "aws-sigv4") {
      throw new OAuthConnectionError("unsupported_injection");
    }
    if (!approvalQueue || !isUserlandRuntimeCaller(ctx)) {
      throw new Error("Credential input approval is unavailable");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const accountIdentity = normalizeAccountIdentity(
      request.credential.accountIdentity,
      ctx.caller.runtime.id
    );
    const identity = resolveApprovalIdentity(ctx);
    const fields = [
      { name: "accessKeyId", label: "Access key ID", type: "secret" as const, required: true },
      {
        name: "secretAccessKey",
        label: "Secret access key",
        type: "secret" as const,
        required: true,
      },
      { name: "sessionToken", label: "Session token", type: "secret" as const, required: false },
    ];
    const result = await approvalQueue.requestCredentialInput({
      kind: "credential-input",
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      title: request.flow.title ?? request.credential.label,
      description: request.flow.description,
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity,
      scopes: request.credential.scopes ?? [],
      fields,
    });
    if (result.decision !== "submit") {
      throw new OAuthConnectionError("approval_denied");
    }
    const accessKeyId = result.values["accessKeyId"]?.trim() ?? "";
    const secretAccessKey = result.values["secretAccessKey"]?.trim() ?? "";
    const sessionToken = result.values["sessionToken"]?.trim() ?? "";
    if (!accessKeyId || !secretAccessKey) {
      throw new OAuthConnectionError(
        "invalid_connection_spec",
        "AWS SigV4 credentials require access key ID and secret access key"
      );
    }
    const stored = await storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: { type: "aws-sigv4", token: accessKeyId },
        accountIdentity: request.credential.accountIdentity ?? {
          providerUserId: `aws:${accessKeyId}`,
        },
        scopes: request.credential.scopes ?? [],
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: "aws-sigv4",
          awsAccessKeyId: accessKeyId,
          awsService: request.credential.injection.service,
          awsRegion: request.credential.injection.region,
        },
      },
      { approvalDecision: "session" }
    );
    const persisted = await credentialStore.loadUrlBound(stored.id);
    if (persisted?.id) {
      await credentialStore.saveUrlBound({
        ...persisted,
        awsSecretAccessKey: secretAccessKey,
        ...(sessionToken ? { awsSessionToken: sessionToken } : {}),
      } as Credential & { id: string });
    }
    return stored;
  }

  async function connectSshKey(
    ctx: ServiceContext,
    request: ConnectCredentialRequest
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "ssh-key") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    const bindings = request.credential.bindings;
    if (!bindings?.length || bindings.some((binding) => binding.use !== "git-ssh")) {
      throw new OAuthConnectionError(
        "invalid_connection_spec",
        "ssh-key credentials require explicit git-ssh bindings"
      );
    }
    if (request.credential.injection.type !== "ssh-key") {
      throw new OAuthConnectionError("unsupported_injection");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const identity = resolveApprovalIdentity(ctx);
    const approvalAccount = normalizeAccountIdentity(
      request.credential.accountIdentity,
      ctx.caller.runtime.id
    );
    const approvalDecision = await requestCredentialApproval(ctx, {
      credentialId: randomUUID(),
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity: approvalAccount,
      scopes: request.credential.scopes ?? [],
      identity,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: "ssh-key",
      },
    });
    const mode = request.flow.mode ?? "generate";
    let privateKey: string;
    let publicKey: string;
    if (mode === "generate") {
      const pair = generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "der" },
      });
      privateKey = pair.privateKey;
      publicKey = openSshEd25519PublicKey(pair.publicKey);
    } else {
      if (!approvalQueue || !isUserlandRuntimeCaller(ctx)) {
        throw new Error("Credential input approval is unavailable");
      }
      const result = await approvalQueue.requestCredentialInput({
        kind: "credential-input",
        callerId: ctx.caller.runtime.id,
        callerKind: ctx.caller.runtime.kind,
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
        title: request.flow.title ?? request.credential.label,
        description: request.flow.description,
        credentialLabel: request.credential.label,
        audience,
        injection,
        accountIdentity: approvalAccount,
        scopes: request.credential.scopes ?? [],
        fields: [{ name: "privateKey", label: "SSH private key", type: "secret", required: true }],
      });
      if (result.decision !== "submit") {
        throw new OAuthConnectionError("approval_denied");
      }
      privateKey = result.values["privateKey"]?.trim() ?? "";
      if (!privateKey) {
        throw new OAuthConnectionError("invalid_connection_spec", "SSH private key is required");
      }
      publicKey = openSshEd25519PublicKey(
        createPublicKey(privateKey).export({ type: "spki", format: "der" })
      );
    }
    const fingerprint = sshPublicKeyFingerprint(publicKey);
    const stored = await storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings,
        material: { type: "ssh-key", token: publicKey },
        accountIdentity: request.credential.accountIdentity ?? {
          providerUserId: `ssh:${fingerprint}`,
        },
        scopes: request.credential.scopes ?? [],
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: "ssh-key",
          sshAlgorithm: "ed25519",
          sshPublicKeyFingerprint: fingerprint,
          sshPublicKey: publicKey,
        },
      },
      {
        approvalDecision,
        preapprovedUseDecision: approvalDecision,
      }
    );
    const persisted = await credentialStore.loadUrlBound(stored.id);
    if (persisted?.id) {
      await credentialStore.saveUrlBound({
        ...persisted,
        sshPrivateKey: privateKey,
        sshPublicKey: publicKey,
      } as Credential & { id: string });
    }
    return stored;
  }

  async function connectOAuthClientCredentials(
    ctx: ServiceContext,
    request: ConnectCredentialRequest
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "oauth2-client-credentials") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    const config = await loadClientConfigForFlow(
      request.flow.clientConfigId,
      "oauth2-client-credentials"
    );
    const clientId = config.fields["clientId"]?.value;
    const clientSecret = config.fields["clientSecret"]?.value;
    const privateKeyPem = config.fields["privateKeyPem"]?.value;
    if (
      !clientId ||
      (request.flow.tokenAuth === "private_key_jwt" ? !privateKeyPem : !clientSecret)
    ) {
      throw new OAuthConnectionError("client_config_unavailable");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const identity = resolveApprovalIdentity(ctx);
    const approvalDecision = await requestCredentialApproval(ctx, {
      credentialId: randomUUID(),
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity: normalizeAccountIdentity(
        request.credential.accountIdentity,
        request.flow.clientConfigId
      ),
      scopes: request.credential.scopes ?? request.flow.scopes ?? [],
      identity,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: request.flow.type,
        oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
      },
    });
    const token = await exchangeClientCredentialsToken({
      tokenUrl: request.flow.tokenUrl,
      clientId,
      clientSecret,
      privateKeyPem,
      keyId: config.fields["keyId"]?.value,
      keyAlgorithm: config.fields["algorithm"]?.value,
      tokenAuth: request.flow.tokenAuth,
      scopes: request.flow.scopes,
      audienceParam: request.flow.audienceParam,
      resourceParam: request.flow.resourceParam,
    });
    return storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: { type: "bearer-token", token: token.accessToken },
        accountIdentity: request.credential.accountIdentity ?? {
          providerUserId: `service:${request.flow.clientConfigId}`,
        },
        scopes: request.credential.scopes ?? request.flow.scopes ?? token.scopes ?? [],
        expiresAt: token.expiresAt,
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: request.flow.type,
          clientConfigId: request.flow.clientConfigId,
          clientConfigVersion: config.currentVersion ?? String(config.updatedAt),
          oauthTokenAuth: request.flow.tokenAuth,
          oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
          ...(request.flow.revocationUrl ? { oauthRevocationUrl: request.flow.revocationUrl } : {}),
        },
      },
      {
        approvalDecision,
        preapprovedUseDecision: approvalDecision,
      }
    );
  }

  async function connectOAuthJwtBearer(
    ctx: ServiceContext,
    request: ConnectCredentialRequest
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "oauth2-jwt-bearer") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    const config = await loadClientConfigForFlow(request.flow.clientConfigId, "oauth2-jwt-bearer");
    const clientId = config.fields["clientId"]?.value;
    const privateKeyPem = config.fields["privateKeyPem"]?.value;
    if (!clientId || !privateKeyPem) {
      throw new OAuthConnectionError("client_config_unavailable");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const identity = resolveApprovalIdentity(ctx);
    const approvalDecision = await requestCredentialApproval(ctx, {
      credentialId: randomUUID(),
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity: normalizeAccountIdentity(
        request.credential.accountIdentity,
        request.flow.subject ?? clientId
      ),
      scopes: request.credential.scopes ?? request.flow.scopes ?? [],
      identity,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: request.flow.type,
        oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
      },
    });
    const token = await exchangeJwtBearerToken({
      tokenUrl: request.flow.tokenUrl,
      clientId,
      privateKeyPem,
      keyId: config.fields["keyId"]?.value,
      keyAlgorithm: config.fields["algorithm"]?.value,
      issuer: request.flow.issuer ?? clientId,
      subject: request.flow.subject ?? clientId,
      audience: request.flow.audience ?? request.flow.tokenUrl,
      scopes: request.flow.scopes,
      persistRefreshToken: request.flow.persistRefreshToken,
    });
    const stored = await storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: { type: "bearer-token", token: token.accessToken },
        accountIdentity: request.credential.accountIdentity ?? {
          providerUserId: request.flow.subject ?? clientId,
        },
        scopes: request.credential.scopes ?? request.flow.scopes ?? token.scopes ?? [],
        expiresAt: token.expiresAt,
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: request.flow.type,
          clientConfigId: request.flow.clientConfigId,
          clientConfigVersion: config.currentVersion ?? String(config.updatedAt),
          oauthTokenAuth: "private_key_jwt",
          oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
          ...(request.flow.revocationUrl ? { oauthRevocationUrl: request.flow.revocationUrl } : {}),
        },
      },
      { approvalDecision, preapprovedUseDecision: approvalDecision }
    );
    if (token.refreshToken) {
      const persisted = await credentialStore.loadUrlBound(stored.id);
      if (persisted?.id) {
        await credentialStore.saveUrlBound({
          ...persisted,
          refreshToken: token.refreshToken,
        } as Credential & { id: string });
      }
    }
    return stored;
  }

  async function connectOAuthTokenExchange(
    ctx: ServiceContext,
    request: ConnectCredentialRequest
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "oauth2-token-exchange") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    const config = await loadClientConfigForFlow(
      request.flow.clientConfigId,
      "oauth2-token-exchange"
    );
    const clientId = config.fields["clientId"]?.value;
    const tokenAuth =
      request.flow.tokenAuth ??
      (config.fields["privateKeyPem"]?.value ? "private_key_jwt" : "client_secret_post");
    const clientSecret = config.fields["clientSecret"]?.value;
    const privateKeyPem = config.fields["privateKeyPem"]?.value;
    if (!clientId || (tokenAuth === "private_key_jwt" ? !privateKeyPem : !clientSecret)) {
      throw new OAuthConnectionError("client_config_unavailable");
    }
    const subject = await loadActiveCredential(request.flow.subjectCredentialId);
    if (subject.revokedAt || !subject.accessToken) {
      throw new OAuthConnectionError("credential_expired_reauth_required");
    }
    const subjectBinding = subject.bindings?.[0];
    const subjectAudience = subjectBinding?.audience[0]?.url;
    if (!subjectBinding || !subjectAudience) {
      throw new OAuthConnectionError(
        "client_not_authorized",
        "Subject credential has no usable binding"
      );
    }
    const subjectUsage = credentialUseContext(
      subject,
      new URL(subjectAudience),
      subjectBinding.use
    );
    if (!subjectUsage) {
      throw new OAuthConnectionError(
        "client_not_authorized",
        "Subject credential binding cannot be authorized"
      );
    }
    await authorizeCredentialUse(ctx, subject, subjectUsage);
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const identity = resolveApprovalIdentity(ctx);
    const approvalDecision = await requestCredentialApproval(ctx, {
      credentialId: randomUUID(),
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity:
        subject.accountIdentity ??
        normalizeAccountIdentity(request.credential.accountIdentity, ctx.caller.runtime.id),
      scopes: request.credential.scopes ?? request.flow.scopes ?? [],
      identity,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: request.flow.type,
        oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
      },
    });
    const token = await exchangeOAuthToken({
      tokenUrl: request.flow.tokenUrl,
      clientId,
      clientSecret,
      privateKeyPem,
      keyId: config.fields["keyId"]?.value,
      keyAlgorithm: config.fields["algorithm"]?.value,
      tokenAuth,
      subjectToken: subject.accessToken,
      subjectTokenType: request.flow.subjectTokenType ?? "access_token",
      requestedTokenType: request.flow.requestedTokenType,
      scopes: request.flow.scopes,
      audience: request.flow.audience,
      resource: request.flow.resource,
      persistRefreshToken: request.flow.persistRefreshToken,
    });
    const stored = await storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: { type: "bearer-token", token: token.accessToken },
        accountIdentity: request.credential.accountIdentity ?? subject.accountIdentity,
        scopes: request.credential.scopes ?? request.flow.scopes ?? token.scopes ?? [],
        expiresAt: token.expiresAt,
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: request.flow.type,
          clientConfigId: request.flow.clientConfigId,
          clientConfigVersion: config.currentVersion ?? String(config.updatedAt),
          subjectCredentialId: request.flow.subjectCredentialId,
          oauthTokenAuth: tokenAuth,
          oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
          ...(request.flow.revocationUrl ? { oauthRevocationUrl: request.flow.revocationUrl } : {}),
        },
      },
      { approvalDecision, preapprovedUseDecision: approvalDecision }
    );
    if (token.refreshToken) {
      const persisted = await credentialStore.loadUrlBound(stored.id);
      if (persisted?.id) {
        await credentialStore.saveUrlBound({
          ...persisted,
          refreshToken: token.refreshToken,
        } as Credential & { id: string });
      }
    }
    return stored;
  }

  async function connectBrowserCookieSession(
    ctx: ServiceContext,
    request: ConnectCredentialRequest,
    signal?: AbortSignal
  ): Promise<StoredCredentialSummary> {
    throwIfAborted(signal);
    if (request.flow.type !== "browser-cookie-session") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (request.credential.injection.type !== "cookie") {
      throw new OAuthConnectionError("unsupported_injection");
    }
    if (!sessionCredentialCapture) {
      throw new OAuthConnectionError(
        "browser_unavailable",
        "Session credential capture is unavailable on this platform"
      );
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const identity = resolveApprovalIdentity(ctx);
    const approvalDecision = await requestCredentialApproval(ctx, {
      credentialId: randomUUID(),
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity: normalizeAccountIdentity(
        request.credential.accountIdentity,
        ctx.caller.runtime.id
      ),
      scopes: request.credential.scopes ?? [],
      identity,
      signal,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: request.flow.type,
        sessionSignInOrigin: new URL(request.flow.signInUrl).origin,
        capturedCookieNames: request.flow.capture.cookies.join(","),
      },
    });
    throwIfAborted(signal);
    const captured = await sessionCredentialCapture.captureCookies({
      signInUrl: request.flow.signInUrl,
      origins: request.flow.capture.origins,
      cookieNames: request.flow.capture.cookies,
      completionUrlPattern: request.flow.completionUrlPattern,
      maxTtlSeconds: request.flow.maxTtlSeconds,
      browser: request.browser ?? "internal",
      signal,
    });
    if (!captured.cookieHeader) {
      throw new OAuthConnectionError("session_capture_failed");
    }
    const stored = await storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: { type: "cookie-session", token: captured.cookieHeader },
        accountIdentity: {
          ...(captured.accountIdentity ?? {}),
          ...(request.credential.accountIdentity ?? {}),
        },
        scopes: request.credential.scopes ?? [],
        expiresAt: captured.expiresAt,
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: request.flow.type,
          sessionSignInOrigin: new URL(request.flow.signInUrl).origin,
          capturedCookieNames: request.flow.capture.cookies.join(","),
        },
      },
      {
        approvalDecision,
        preapprovedUseDecision: approvalDecision,
      }
    );
    const persisted = await credentialStore.loadUrlBound(stored.id);
    if (persisted?.id) {
      await credentialStore.saveUrlBound({
        ...persisted,
        cookieHeader: captured.cookieHeader,
        ...(captured.cookieSession ? { cookieSession: captured.cookieSession } : {}),
      } as Credential & { id: string });
    }
    return stored;
  }

  async function connectSamlBrowserSession(
    ctx: ServiceContext,
    request: ConnectCredentialRequest,
    signal?: AbortSignal
  ): Promise<StoredCredentialSummary> {
    throwIfAborted(signal);
    if (request.flow.type !== "saml-browser-session") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (request.credential.injection.type !== "cookie") {
      throw new OAuthConnectionError("unsupported_injection");
    }
    if (!sessionCredentialCapture?.captureSamlSession) {
      throw new OAuthConnectionError(
        "browser_unavailable",
        "SAML session capture is unavailable on this platform"
      );
    }
    if (!request.flow.capture.cookies?.length && !request.flow.capture.assertion) {
      throw new OAuthConnectionError("invalid_connection_spec");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const identity = resolveApprovalIdentity(ctx);
    const approvalDecision = await requestCredentialApproval(ctx, {
      credentialId: randomUUID(),
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity: normalizeAccountIdentity(
        request.credential.accountIdentity,
        ctx.caller.runtime.id
      ),
      scopes: request.credential.scopes ?? [],
      identity,
      signal,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: request.flow.type,
        sessionSignInOrigin: new URL(request.flow.signInUrl).origin,
        spAudience: request.flow.spAudience,
        capturedCookieNames: request.flow.capture.cookies?.join(",") ?? "",
      },
    });
    throwIfAborted(signal);
    const captured = await sessionCredentialCapture.captureSamlSession({
      signInUrl: request.flow.signInUrl,
      spAudience: request.flow.spAudience,
      cookieNames: request.flow.capture.cookies,
      assertion: request.flow.capture.assertion,
      completionUrlPattern: request.flow.completionUrlPattern,
      maxTtlSeconds: request.flow.maxTtlSeconds,
      browser: request.browser ?? "internal",
      signal,
    });
    if (!captured.cookieHeader && !captured.assertion) {
      throw new OAuthConnectionError("saml_assertion_failed");
    }
    const material = captured.cookieHeader ?? captured.assertion ?? "";
    const stored = await storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: { type: "saml-session", token: material },
        accountIdentity: {
          ...(captured.accountIdentity ?? {}),
          ...(request.credential.accountIdentity ?? {}),
        },
        scopes: request.credential.scopes ?? [],
        expiresAt: captured.expiresAt,
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: request.flow.type,
          sessionSignInOrigin: new URL(request.flow.signInUrl).origin,
          spAudience: request.flow.spAudience,
          capturedCookieNames: request.flow.capture.cookies?.join(",") ?? "",
        },
      },
      {
        approvalDecision,
        preapprovedUseDecision: approvalDecision,
      }
    );
    const persisted = await credentialStore.loadUrlBound(stored.id);
    if (persisted?.id) {
      await credentialStore.saveUrlBound({
        ...persisted,
        ...(captured.cookieHeader ? { cookieHeader: captured.cookieHeader } : {}),
        ...(captured.cookieSession ? { cookieSession: captured.cookieSession } : {}),
        ...(captured.assertion ? { samlAssertion: captured.assertion } : {}),
      } as Credential & { id: string });
    }
    return stored;
  }

  async function connectOAuthDeviceCode(
    ctx: ServiceContext,
    request: ConnectCredentialRequest,
    signal?: AbortSignal
  ): Promise<StoredCredentialSummary> {
    throwIfAborted(signal);
    if (request.flow.type !== "oauth2-device-code") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    const config = request.flow.clientConfigId
      ? await loadClientConfigForFlow(request.flow.clientConfigId, "oauth2-device-code")
      : null;
    const clientId = request.flow.clientId ?? config?.fields["clientId"]?.value;
    const clientSecret = config?.fields["clientSecret"]?.value;
    const privateKeyPem = config?.fields["privateKeyPem"]?.value;
    const tokenAuth = request.flow.tokenAuth ?? (clientSecret ? "client_secret_post" : "none");
    if (!clientId) {
      throw new OAuthConnectionError("client_config_unavailable");
    }
    if (
      tokenAuth !== "none" &&
      (tokenAuth === "private_key_jwt" ? !privateKeyPem : !clientSecret)
    ) {
      throw new OAuthConnectionError("client_config_unavailable");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const identity = resolveApprovalIdentity(ctx);
    const approvalDecision = await requestCredentialApproval(ctx, {
      credentialId: randomUUID(),
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity: normalizeAccountIdentity(
        request.credential.accountIdentity,
        ctx.caller.runtime.id
      ),
      scopes: request.credential.scopes ?? request.flow.scopes ?? [],
      identity,
      signal,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: request.flow.type,
        oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
      },
    });
    throwIfAborted(signal);
    const device = await requestDeviceAuthorization({
      deviceAuthorizationUrl: request.flow.deviceAuthorizationUrl,
      clientId,
      clientSecret,
      privateKeyPem,
      keyId: config?.fields["keyId"]?.value,
      keyAlgorithm: config?.fields["algorithm"]?.value,
      tokenAuth,
      scopes: request.flow.scopes,
      signal,
    });
    const verificationUrl = device.verificationUriComplete ?? device.verificationUri;
    if (!eventService || !verificationUrl) {
      throw new OAuthConnectionError("browser_unavailable");
    }
    if (!device.userCode) {
      // RFC 8628 requires user_code; without it the user has nothing to type
      // and we can't surface the flow meaningfully.
      throw new OAuthConnectionError("invalid_token_response");
    }
    // Present the user_code on the trusted approval bar so the operator
    // sees it even when the provider didn't embed it in
    // verification_uri_complete. Cancelling the bar entry aborts polling.
    const presentation = approvalQueue?.presentDeviceCode({
      kind: "device-code",
      callerId: ctx.caller.runtime.id,
      callerKind: isUserlandRuntimeCaller(ctx) ? ctx.caller.runtime.kind : "panel",
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      credentialLabel: request.credential.label,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      verificationUriComplete: device.verificationUriComplete,
      expiresAt:
        Date.now() + Math.max(1, request.flow.expiresInSeconds ?? device.expiresInSeconds) * 1000,
      oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
    });
    const browserTarget = resolveBrowserHandoffTarget(ctx);
    if (
      !browserTarget ||
      !emitToBrowserTarget(browserTarget, "external-open:open", {
        url: verificationUrl,
        callerId: ctx.caller.runtime.id,
        callerKind: ctx.caller.runtime.kind,
      })
    ) {
      presentation?.dispose();
      throw new OAuthConnectionError("browser_unavailable");
    }
    let token: Awaited<ReturnType<typeof pollDeviceToken>>;
    try {
      token = await pollDeviceToken({
        tokenUrl: request.flow.tokenUrl,
        clientId,
        clientSecret,
        privateKeyPem,
        keyId: config?.fields["keyId"]?.value,
        keyAlgorithm: config?.fields["algorithm"]?.value,
        tokenAuth,
        deviceCode: device.deviceCode,
        intervalSeconds: request.flow.pollIntervalSeconds ?? device.intervalSeconds,
        expiresInSeconds: request.flow.expiresInSeconds ?? device.expiresInSeconds,
        persistRefreshToken: request.flow.persistRefreshToken,
        cancelSignal: anySignal([presentation?.cancelled, signal]),
      });
    } finally {
      presentation?.dispose();
    }
    const stored = await storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: { type: "bearer-token", token: token.accessToken },
        accountIdentity: request.credential.accountIdentity,
        scopes: request.credential.scopes ?? request.flow.scopes ?? token.scopes ?? [],
        expiresAt: token.expiresAt,
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: request.flow.type,
          ...(request.flow.clientConfigId ? { clientConfigId: request.flow.clientConfigId } : {}),
          ...(config?.currentVersion ? { clientConfigVersion: config.currentVersion } : {}),
          oauthTokenAuth: tokenAuth,
          oauthDeviceVerificationOrigin: new URL(verificationUrl).origin,
          oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
          ...(request.flow.revocationUrl ? { oauthRevocationUrl: request.flow.revocationUrl } : {}),
        },
      },
      {
        approvalDecision,
        preapprovedUseDecision: approvalDecision,
      }
    );
    if (token.refreshToken) {
      const persisted = await credentialStore.loadUrlBound(stored.id);
      if (persisted?.id) {
        await credentialStore.saveUrlBound({
          ...persisted,
          refreshToken: token.refreshToken,
        } as Credential & { id: string });
      }
    }
    return stored;
  }

  async function connectOAuth1a(
    ctx: ServiceContext,
    request: ConnectCredentialRequest,
    handoffTarget?: { callerId: string; callerKind: BrowserHandoffCallerKind },
    signal?: AbortSignal
  ): Promise<StoredCredentialSummary> {
    throwIfAborted(signal);
    if (request.flow.type !== "oauth1a") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (request.credential.injection.type !== "oauth1-signature") {
      throw new OAuthConnectionError("unsupported_injection");
    }
    const config = await loadClientConfigForFlow(request.flow.clientConfigId, "oauth1a");
    const consumerKey = config.fields["consumerKey"]?.value ?? config.fields["clientId"]?.value;
    const consumerSecret =
      config.fields["consumerSecret"]?.value ?? config.fields["clientSecret"]?.value;
    if (!consumerKey || !consumerSecret) {
      throw new OAuthConnectionError("client_config_unavailable");
    }
    const redirect = request.redirect ?? {};
    const redirectStrategy = resolveDefaultRedirectStrategy(redirect.type);
    if (redirectStrategy === "client-loopback") {
      throw new OAuthConnectionError(
        "unsupported_flow",
        "client-loopback redirects are only supported for OAuth2 flows"
      );
    }
    let callback: HostOAuthCallback | null = null;
    let tx: OAuthConnectionTransaction | null = null;
    try {
      const stateParam = randomBytes(16).toString("base64url");
      let redirectUri: string;
      let transactionId: string | undefined;
      if (redirectStrategy === "loopback") {
        callback = await createLoopbackOAuthCallback({
          host: redirect.host ?? DEFAULT_LOOPBACK_HOST,
          port: redirect.port ?? 0,
          callbackPath: redirect.callbackPath ?? DEFAULT_CALLBACK_PATH,
          allowDynamicPortFallback: redirect.fallback === "dynamic-port",
          signal,
        });
        redirectUri = callback.redirectUri;
      } else if (redirectStrategy === "public") {
        transactionId = randomUUID();
        redirectUri = buildPublicUrl(PUBLIC_OAUTH_CALLBACK_PATH);
      } else if (redirectStrategy === "client-forwarded") {
        transactionId = randomUUID();
        redirectUri = redirect.callbackUri ?? buildPublicUrl(PUBLIC_OAUTH_CALLBACK_PATH);
      } else {
        throw new OAuthConnectionError("redirect_unavailable");
      }
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("state", stateParam);
      tx = await createOAuthTransaction(ctx, {
        id: transactionId,
        redirectUri,
        redirectStrategy,
        stateParam,
      });
      const audience = normalizeUrlAudiences(request.credential.audience);
      const injection = normalizeCredentialInjection(request.credential.injection);
      const identity = resolveApprovalIdentity(ctx);
      const approvalDecision = await requestCredentialApproval(ctx, {
        credentialId: randomUUID(),
        credentialLabel: request.credential.label,
        audience,
        injection,
        accountIdentity: normalizeAccountIdentity(
          request.credential.accountIdentity,
          ctx.caller.runtime.id
        ),
        scopes: request.credential.scopes ?? [],
        identity,
        signal,
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: request.flow.type,
          oauthAuthorizeOrigin: new URL(request.flow.authorizeUrl).origin,
        },
      });
      throwIfAborted(signal);
      await transitionOAuthTransaction(tx, "approved");
      const requestToken = await exchangeOAuth1RequestToken({
        requestTokenUrl: request.flow.requestTokenUrl,
        consumerKey,
        consumerSecret,
        callbackUrl: callbackUrl.toString(),
      });
      callback?.expectState(stateParam);
      const authorizeUrl = new URL(request.flow.authorizeUrl);
      authorizeUrl.searchParams.set("oauth_token", requestToken.token);
      if (!eventService) {
        throw new OAuthConnectionError("browser_unavailable");
      }
      const browserTarget = resolveBrowserHandoffTarget(ctx, handoffTarget);
      if (
        !browserTarget ||
        !emitToBrowserTarget(browserTarget, "external-open:open", {
          url: authorizeUrl.toString(),
          callerId: ctx.caller.runtime.id,
          callerKind: ctx.caller.runtime.kind,
        })
      ) {
        throw new OAuthConnectionError("browser_unavailable");
      }
      await transitionOAuthTransaction(tx, "handoff_requested");
      if (callback) {
        const callbackResult = await abortable(callback.wait, signal, () => callback?.close());
        await receiveOAuthCallback(tx, callbackResult);
      }
      const result = await abortable(tx.wait, signal);
      await transitionOAuthTransaction(tx, "exchanging");
      const access = await exchangeOAuth1AccessToken({
        accessTokenUrl: request.flow.accessTokenUrl,
        consumerKey,
        consumerSecret,
        requestToken: requestToken.token,
        requestTokenSecret: requestToken.secret,
        verifier: result.code,
      });
      const stored = await storeCredential(
        ctx,
        {
          label: request.credential.label,
          audience,
          injection,
          bindings: request.credential.bindings,
          material: { type: "bearer-token", token: access.token },
          accountIdentity: request.credential.accountIdentity,
          scopes: request.credential.scopes ?? [],
          metadata: {
            ...(request.credential.metadata ?? {}),
            flowType: request.flow.type,
            clientConfigId: request.flow.clientConfigId,
            clientConfigVersion: config.currentVersion ?? String(config.updatedAt),
            oauth1ConsumerKey: consumerKey,
            oauthAuthorizeOrigin: new URL(request.flow.authorizeUrl).origin,
          },
        },
        {
          approvalDecision,
          preapprovedUseDecision: approvalDecision,
        }
      );
      const persisted = await credentialStore.loadUrlBound(stored.id);
      if (persisted?.id) {
        await credentialStore.saveUrlBound({
          ...persisted,
          oauth1ConsumerSecret: consumerSecret,
          oauth1TokenSecret: access.secret,
        } as Credential & { id: string });
      }
      await transitionOAuthTransaction(tx, "stored");
      await transitionOAuthTransaction(tx, "completed");
      oauthTransactions.delete(tx.id);
      return stored;
    } catch (error) {
      if (tx && !["completed", "failed", "expired", "cancelled"].includes(tx.state)) {
        await transitionOAuthTransaction(tx, "failed", errorCodeForOAuthError(error));
      }
      throw error;
    } finally {
      callback?.close();
    }
  }

  async function connectOAuth2AuthCode(
    ctx: ServiceContext,
    request: AuthCodeConnectRequest,
    explicitHandoffTarget?: { callerId: string; callerKind: BrowserHandoffCallerKind },
    signal?: AbortSignal
  ): Promise<StoredCredentialSummary> {
    throwIfAborted(signal);
    const redirect = request.redirect ?? {};
    const redirectStrategy = resolveDefaultRedirectStrategy(redirect.type);
    let callback: HostOAuthCallback | null = null;
    let tx: OAuthConnectionTransaction | null = null;
    try {
      const stateParam = randomBytes(16).toString("base64url");
      let redirectUri: string;
      let transactionId: string | undefined;
      if (redirectStrategy === "loopback") {
        callback = await createLoopbackOAuthCallback({
          host: redirect.host ?? DEFAULT_LOOPBACK_HOST,
          port: redirect.port ?? 0,
          callbackPath: redirect.callbackPath ?? DEFAULT_CALLBACK_PATH,
          allowDynamicPortFallback: redirect.fallback === "dynamic-port",
          signal,
        });
        redirectUri = callback.redirectUri;
      } else if (redirectStrategy === "public") {
        transactionId = randomUUID();
        redirectUri = buildPublicUrl(PUBLIC_OAUTH_CALLBACK_PATH);
      } else if (redirectStrategy === "client-forwarded") {
        transactionId = randomUUID();
        redirectUri = redirect.callbackUri ?? buildPublicUrl(PUBLIC_OAUTH_CALLBACK_PATH);
      } else if (redirectStrategy === "client-loopback") {
        transactionId = randomUUID();
        redirectUri = buildClientLoopbackRedirectUri(redirect);
      } else {
        throw new OAuthConnectionError("redirect_unavailable");
      }
      tx = await createOAuthTransaction(ctx, {
        id: transactionId,
        redirectUri,
        redirectStrategy,
        stateParam,
      });
      const oauthRequest = await resolveAuthCodeConnectionRequest(request, redirectUri);
      validateOAuthCredentialRequest(oauthRequest);
      const identity = resolveApprovalIdentity(ctx);
      const audience = normalizeUrlAudiences(oauthRequest.credential.audience);
      const injection = normalizeCredentialInjection(oauthRequest.credential.injection);
      const metadata = {
        ...(oauthRequest.credential.metadata ?? {}),
        oauthAuthorizeOrigin: new URL(oauthRequest.flow.authorizeUrl).origin,
        oauthTokenOrigin: new URL(oauthRequest.flow.tokenUrl).origin,
        ...(oauthRequest.flow.accountValidation?.userinfo?.url
          ? {
              oauthUserinfoOrigin: new URL(oauthRequest.flow.accountValidation.userinfo.url).origin,
            }
          : {}),
      };
      const approvalDecision = await requestCredentialApproval(ctx, {
        credentialId: randomUUID(),
        credentialLabel: oauthRequest.credential.label,
        audience,
        injection,
        accountIdentity: normalizeAccountIdentity(
          oauthRequest.credential.accountIdentity,
          ctx.caller.runtime.id
        ),
        scopes: oauthRequest.credential.scopes ?? oauthRequest.flow.scopes ?? [],
        identity,
        signal,
        metadata,
      });
      throwIfAborted(signal);
      await transitionOAuthTransaction(tx, "approved");
      const started = createOAuthAuthorizeRequest(oauthRequest, stateParam);
      callback?.expectState(started.state);
      if (!eventService) {
        throw new OAuthConnectionError("browser_unavailable");
      }
      const openMode = request.browser ?? "external";
      if (redirectStrategy === "client-loopback" && openMode !== "external") {
        throw new OAuthConnectionError(
          "unsupported_browser_mode",
          "client-loopback OAuth requires an external browser"
        );
      }
      const browserTarget = resolveBrowserHandoffTarget(ctx, explicitHandoffTarget);
      if (!browserTarget) {
        throw new OAuthConnectionError(
          "browser_unavailable",
          "OAuth browser handoff target is not connected"
        );
      }
      if (redirectStrategy === "client-loopback") {
        tx.deliveryCallerId = browserTarget.deliveryCallerId;
        tx.deliveryCallerKind = browserTarget.deliveryCallerKind;
      }
      const openPayload = {
        url: started.authorizeUrl,
        callerId: ctx.caller.runtime.id,
        callerKind: ctx.caller.runtime.kind,
        ...(redirectStrategy === "client-loopback"
          ? { oauthLoopback: buildClientLoopbackHandoff(tx, started.state) }
          : {}),
      };
      let browserDelivered = false;
      if (openMode === "internal") {
        if (!browserTarget.parentPanelId) {
          throw new OAuthConnectionError(
            "browser_unavailable",
            "Internal OAuth handoff requires a panel target"
          );
        }
        browserDelivered = emitToBrowserTarget(browserTarget, "browser-panel:open", {
          url: started.authorizeUrl,
          parentPanelId: browserTarget.parentPanelId,
          callerId: ctx.caller.runtime.id,
          callerKind: ctx.caller.runtime.kind,
        });
      } else {
        browserDelivered = emitToBrowserTarget(browserTarget, "external-open:open", openPayload);
      }
      if (!browserDelivered) {
        throw new OAuthConnectionError(
          "browser_unavailable",
          "OAuth browser handoff target is not connected"
        );
      }
      await transitionOAuthTransaction(tx, "browser_open_requested");
      if (callback) {
        const callbackResult = await abortable(callback.wait, signal, () => callback?.close());
        await receiveOAuthCallback(tx, callbackResult);
      }
      const result = await abortable(tx.wait, signal);
      await transitionOAuthTransaction(tx, "exchanging");
      const token = await exchangeOAuthCode(oauthRequest, result.code, started.codeVerifier);
      await transitionOAuthTransaction(tx, "validating_account");
      const validatedAccountIdentity = await validateOAuthAccountIdentity(
        oauthRequest,
        token.accessToken
      );
      const accountIdentity = {
        ...deriveAccountIdentityFromJwt(token.accessToken, oauthRequest.credential.metadata),
        ...validatedAccountIdentity,
        ...(oauthRequest.credential.accountIdentity ?? {}),
      };
      const duplicate = await findReplacementCandidate(ctx, {
        label: oauthRequest.credential.label,
        audience: oauthRequest.credential.audience,
        metadata: oauthRequest.credential.metadata,
        accountIdentity,
      });
      const stored = await storeCredential(
        ctx,
        {
          label: oauthRequest.credential.label,
          audience: oauthRequest.credential.audience,
          injection: oauthRequest.credential.injection,
          bindings: oauthRequest.credential.bindings,
          material: { type: "bearer-token", token: token.accessToken },
          accountIdentity,
          scopes: oauthRequest.credential.scopes ?? oauthRequest.flow.scopes ?? token.scopes ?? [],
          expiresAt: token.expiresAt,
          metadata: {
            ...(oauthRequest.credential.metadata ?? {}),
            ...(token.refreshToken ? { oauthRefreshTokenStored: "true" } : {}),
            oauthTokenAuth: oauthRequest.tokenAuth,
            oauthAuthorizeOrigin: new URL(oauthRequest.flow.authorizeUrl).origin,
            oauthTokenOrigin: new URL(oauthRequest.flow.tokenUrl).origin,
            ...(oauthRequest.flow.revocationUrl
              ? { oauthRevocationUrl: oauthRequest.flow.revocationUrl }
              : {}),
            ...(oauthRequest.flow.accountValidation?.userinfo?.url
              ? {
                  oauthUserinfoOrigin: new URL(oauthRequest.flow.accountValidation.userinfo.url)
                    .origin,
                }
              : {}),
            oauthScopes: (oauthRequest.flow.scopes ?? []).join(" "),
          },
        },
        {
          approvalDecision: duplicate ? undefined : approvalDecision,
          preapprovedUseDecision: approvalDecision,
          replaceCredentialId: duplicate?.id,
          replacementCredentialLabel: duplicate?.label ?? duplicate?.connectionLabel,
        }
      );
      if (token.refreshToken) {
        const persisted = await credentialStore.loadUrlBound(stored.id);
        if (persisted?.id) {
          await credentialStore.saveUrlBound({
            ...persisted,
            refreshToken: token.refreshToken,
          } as Credential & { id: string });
        }
      }
      await transitionOAuthTransaction(tx, "stored");
      await transitionOAuthTransaction(tx, "completed");
      oauthTransactions.delete(tx.id);
      return stored;
    } catch (error) {
      if (tx && !["completed", "failed", "expired", "cancelled"].includes(tx.state)) {
        await transitionOAuthTransaction(tx, "failed", errorCodeForOAuthError(error));
      }
      throw error;
    } finally {
      callback?.close();
    }
  }

  async function resolveAuthCodeConnectionRequest(
    request: AuthCodeConnectRequest,
    redirectUri: string
  ): Promise<InternalOAuthConnectionRequest> {
    if (request.flow.clientConfigId) {
      const config = await loadClientConfigForFlow(
        request.flow.clientConfigId,
        request.pkce ? "oauth2-auth-code-pkce" : "oauth2-auth-code"
      );
      const clientId = config.fields["clientId"]?.value;
      const clientSecret = config.fields["clientSecret"]?.value;
      const privateKeyPem = config.fields["privateKeyPem"]?.value;
      const keyId = config.fields["keyId"]?.value;
      const keyAlgorithm = config.fields["algorithm"]?.value;
      const tokenAuth =
        request.tokenAuth ?? (request.pkce && !clientSecret ? "none" : "client_secret_post");
      if (!clientId) {
        throw new OAuthConnectionError("client_config_unavailable");
      }
      if (tokenAuth !== "none" && !clientSecret) {
        if (tokenAuth === "private_key_jwt" && privateKeyPem) {
          return {
            flow: {
              authorizeUrl: canonicalUrl(config.authorizeUrl),
              tokenUrl: canonicalUrl(config.tokenUrl),
              clientId,
              privateKeyPem,
              ...(keyId ? { keyId } : {}),
              ...(keyAlgorithm ? { keyAlgorithm } : {}),
              scopes: request.flow.scopes,
              extraAuthorizeParams: request.flow.extraAuthorizeParams,
              allowMissingExpiry: request.flow.allowMissingExpiry,
              persistRefreshToken: request.flow.persistRefreshToken,
              accountValidation: request.flow.accountValidation,
              revocationUrl: request.flow.revocationUrl,
            },
            credential: {
              ...request.credential,
              metadata: {
                ...(request.credential.metadata ?? {}),
                clientConfigId: request.flow.clientConfigId,
                clientConfigVersion: config.currentVersion ?? String(config.updatedAt),
              },
            },
            redirectUri,
            pkce: request.pkce,
            tokenAuth,
          };
        }
        throw new OAuthConnectionError("client_config_unavailable");
      }
      return {
        flow: {
          authorizeUrl: canonicalUrl(config.authorizeUrl),
          tokenUrl: canonicalUrl(config.tokenUrl),
          clientId,
          ...(clientSecret ? { clientSecret } : {}),
          scopes: request.flow.scopes,
          extraAuthorizeParams: request.flow.extraAuthorizeParams,
          allowMissingExpiry: request.flow.allowMissingExpiry,
          persistRefreshToken: request.flow.persistRefreshToken,
          accountValidation: request.flow.accountValidation,
          revocationUrl: request.flow.revocationUrl,
        },
        credential: {
          ...request.credential,
          metadata: {
            ...(request.credential.metadata ?? {}),
            clientConfigId: request.flow.clientConfigId,
            clientConfigVersion: config.currentVersion ?? String(config.updatedAt),
          },
        },
        redirectUri,
        pkce: request.pkce,
        tokenAuth,
      };
    }
    if (request.tokenAuth !== "none") {
      throw new OAuthConnectionError("unsupported_token_auth_method");
    }
    return {
      flow: {
        authorizeUrl: request.flow.authorizeUrl ?? "",
        tokenUrl: request.flow.tokenUrl ?? "",
        clientId: request.flow.clientId ?? "",
        scopes: request.flow.scopes,
        extraAuthorizeParams: request.flow.extraAuthorizeParams,
        allowMissingExpiry: request.flow.allowMissingExpiry,
        persistRefreshToken: request.flow.persistRefreshToken,
        accountValidation: request.flow.accountValidation,
        revocationUrl: request.flow.revocationUrl,
      },
      credential: request.credential,
      redirectUri,
      pkce: request.pkce,
      tokenAuth: request.tokenAuth,
    };
  }

  async function loadClientConfigForFlow(
    configId: string,
    flowType: CredentialFlowType
  ): Promise<ClientConfigRecord> {
    const config = await clientConfigStore.load(configId);
    if (!config || config.status === "deleted" || config.status === "disabled") {
      throw new OAuthConnectionError("client_config_unavailable");
    }
    if (config.flowTypes?.length && !config.flowTypes.includes(flowType)) {
      throw new OAuthConnectionError("client_not_authorized");
    }
    return config;
  }

  async function exchangeOAuthCode(
    request: InternalOAuthConnectionRequest,
    code: string,
    codeVerifier: string | undefined
  ): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
  }> {
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    if (codeVerifier) {
      body.set("code_verifier", codeVerifier);
    }
    body.set("client_id", request.flow.clientId);
    applyOAuthClientAssertion(body, {
      tokenUrl: request.flow.tokenUrl,
      clientId: request.flow.clientId,
      privateKeyPem: request.flow.privateKeyPem,
      keyId: request.flow.keyId,
      keyAlgorithm: request.flow.keyAlgorithm,
      tokenAuth: request.tokenAuth,
    });
    if (request.flow.clientSecret && request.tokenAuth === "client_secret_post") {
      body.set("client_secret", request.flow.clientSecret);
    }
    body.set("redirect_uri", request.redirectUri);
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (request.flow.clientSecret && request.tokenAuth === "client_secret_basic") {
      headers["authorization"] = basicAuthHeader(request.flow.clientId, request.flow.clientSecret);
    }

    const tokenResponse = await fetch(request.flow.tokenUrl, {
      method: "POST",
      headers,
      body,
    });
    const tokenText = await tokenResponse.text();
    const tokenData = parseJsonObject(tokenText, { strict: tokenResponse.ok });
    if (!tokenResponse.ok) {
      throw oauthConnectionError(
        "token_exchange_failed",
        formatOAuthTokenExchangeError(tokenResponse.status, tokenData, tokenText)
      );
    }
    if (typeof tokenData?.["error"] === "string") {
      throw oauthConnectionError(
        "token_exchange_failed",
        `OAuth token exchange failed: ${tokenData["error"]}`
      );
    }

    return parseBearerTokenResponse(tokenData, {
      allowMissingExpiry: request.flow.allowMissingExpiry,
      persistRefreshToken: request.flow.persistRefreshToken,
    });
  }

  async function exchangeClientCredentialsToken(params: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    privateKeyPem?: string;
    keyId?: string;
    keyAlgorithm?: string;
    tokenAuth: "client_secret_post" | "client_secret_basic" | "private_key_jwt";
    scopes?: string[];
    audienceParam?: string;
    resourceParam?: string;
  }): Promise<{ accessToken: string; expiresAt?: number; scopes?: string[] }> {
    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    body.set("client_id", params.clientId);
    applyOAuthClientAssertion(body, params);
    if (params.tokenAuth === "client_secret_post" && params.clientSecret) {
      body.set("client_secret", params.clientSecret);
    }
    if (params.scopes?.length) {
      body.set("scope", params.scopes.join(" "));
    }
    if (params.audienceParam) {
      body.set("audience", params.audienceParam);
    }
    if (params.resourceParam) {
      body.set("resource", params.resourceParam);
    }
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (params.tokenAuth === "client_secret_basic" && params.clientSecret) {
      headers["authorization"] = basicAuthHeader(params.clientId, params.clientSecret);
    }
    const response = await fetch(params.tokenUrl, { method: "POST", headers, body });
    const text = await response.text();
    const data = parseJsonObject(text, { strict: response.ok });
    if (!response.ok || typeof data?.["error"] === "string") {
      throw oauthConnectionError(
        "token_exchange_failed",
        formatOAuthTokenExchangeError(response.status, data, text)
      );
    }
    const parsed = parseBearerTokenResponse(data, { allowMissingExpiry: false });
    return {
      accessToken: parsed.accessToken,
      expiresAt: parsed.expiresAt,
      scopes: parsed.scopes,
    };
  }

  async function exchangeJwtBearerToken(params: {
    tokenUrl: string;
    clientId: string;
    privateKeyPem: string;
    keyId?: string;
    keyAlgorithm?: string;
    issuer: string;
    subject: string;
    audience: string;
    scopes?: string[];
    persistRefreshToken?: boolean;
  }): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
  }> {
    const assertion = signJwtAssertion({
      issuer: params.issuer,
      subject: params.subject,
      audience: params.audience,
      privateKeyPem: params.privateKeyPem,
      keyId: params.keyId,
      keyAlgorithm: params.keyAlgorithm,
    });
    const body = new URLSearchParams();
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
    body.set("assertion", assertion);
    body.set("client_id", params.clientId);
    if (params.scopes?.length) {
      body.set("scope", params.scopes.join(" "));
    }
    const response = await fetch(params.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await response.text();
    const data = parseJsonObject(text, { strict: response.ok });
    if (!response.ok || typeof data?.["error"] === "string") {
      throw oauthConnectionError(
        "token_exchange_failed",
        formatOAuthTokenExchangeError(response.status, data, text)
      );
    }
    return parseBearerTokenResponse(data, {
      allowMissingExpiry: false,
      persistRefreshToken: params.persistRefreshToken,
    });
  }

  async function exchangeOAuthToken(params: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    privateKeyPem?: string;
    keyId?: string;
    keyAlgorithm?: string;
    tokenAuth: "client_secret_post" | "client_secret_basic" | "private_key_jwt";
    subjectToken: string;
    subjectTokenType: "access_token" | "jwt";
    requestedTokenType?: string;
    scopes?: string[];
    audience?: string;
    resource?: string;
    persistRefreshToken?: boolean;
  }): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
  }> {
    const body = new URLSearchParams();
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange");
    body.set("subject_token", params.subjectToken);
    body.set(
      "subject_token_type",
      params.subjectTokenType === "jwt"
        ? "urn:ietf:params:oauth:token-type:jwt"
        : "urn:ietf:params:oauth:token-type:access_token"
    );
    body.set("client_id", params.clientId);
    if (params.requestedTokenType) body.set("requested_token_type", params.requestedTokenType);
    if (params.scopes?.length) body.set("scope", params.scopes.join(" "));
    if (params.audience) body.set("audience", params.audience);
    if (params.resource) body.set("resource", params.resource);
    applyOAuthClientAssertion(body, params);
    if (params.tokenAuth === "client_secret_post" && params.clientSecret) {
      body.set("client_secret", params.clientSecret);
    }
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (params.tokenAuth === "client_secret_basic" && params.clientSecret) {
      headers["authorization"] = basicAuthHeader(params.clientId, params.clientSecret);
    }
    const response = await fetch(params.tokenUrl, { method: "POST", headers, body });
    const text = await response.text();
    const data = parseJsonObject(text, { strict: response.ok });
    if (!response.ok || typeof data?.["error"] === "string") {
      throw oauthConnectionError(
        "token_exchange_failed",
        formatOAuthTokenExchangeError(response.status, data, text)
      );
    }
    return parseBearerTokenResponse(data, {
      allowMissingExpiry: false,
      persistRefreshToken: params.persistRefreshToken,
    });
  }

  async function requestDeviceAuthorization(params: {
    deviceAuthorizationUrl: string;
    clientId: string;
    clientSecret?: string;
    privateKeyPem?: string;
    keyId?: string;
    keyAlgorithm?: string;
    tokenAuth: "none" | "client_secret_post" | "client_secret_basic" | "private_key_jwt";
    scopes?: string[];
    signal?: AbortSignal;
  }): Promise<{
    deviceCode: string;
    userCode?: string;
    verificationUri: string;
    verificationUriComplete?: string;
    intervalSeconds: number;
    expiresInSeconds: number;
  }> {
    const body = new URLSearchParams();
    body.set("client_id", params.clientId);
    if (params.scopes?.length) {
      body.set("scope", params.scopes.join(" "));
    }
    applyOAuthClientAssertion(body, {
      tokenUrl: params.deviceAuthorizationUrl,
      clientId: params.clientId,
      privateKeyPem: params.privateKeyPem,
      keyId: params.keyId,
      keyAlgorithm: params.keyAlgorithm,
      tokenAuth: params.tokenAuth,
    });
    if (params.clientSecret && params.tokenAuth === "client_secret_post") {
      body.set("client_secret", params.clientSecret);
    }
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (params.clientSecret && params.tokenAuth === "client_secret_basic") {
      headers["authorization"] = basicAuthHeader(params.clientId, params.clientSecret);
    }
    const response = await fetch(params.deviceAuthorizationUrl, {
      method: "POST",
      headers,
      body,
      signal: params.signal,
    });
    const text = await response.text();
    const data = parseJsonObject(text, { strict: response.ok });
    if (!response.ok || typeof data?.["error"] === "string") {
      throw oauthConnectionError(
        "device_authorization_failed",
        formatOAuthTokenExchangeError(response.status, data, text)
      );
    }
    const deviceCode = data?.["device_code"];
    const verificationUri = data?.["verification_uri"] ?? data?.["verification_url"];
    if (typeof deviceCode !== "string" || typeof verificationUri !== "string") {
      throw new OAuthConnectionError("invalid_token_response");
    }
    const userCode = data?.["user_code"];
    const verificationUriComplete = data?.["verification_uri_complete"];
    return {
      deviceCode,
      ...(typeof userCode === "string" ? { userCode } : {}),
      verificationUri,
      ...(typeof verificationUriComplete === "string" ? { verificationUriComplete } : {}),
      intervalSeconds: readNumericField(data?.["interval"]) ?? 5,
      expiresInSeconds: readNumericField(data?.["expires_in"]) ?? 900,
    };
  }

  async function pollDeviceToken(params: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    privateKeyPem?: string;
    keyId?: string;
    keyAlgorithm?: string;
    tokenAuth: "none" | "client_secret_post" | "client_secret_basic" | "private_key_jwt";
    deviceCode: string;
    intervalSeconds: number;
    expiresInSeconds: number;
    persistRefreshToken?: boolean;
    cancelSignal?: AbortSignal;
  }): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
  }> {
    let intervalMs = Math.max(1, params.intervalSeconds) * 1000;
    const deadline = Date.now() + Math.max(1, params.expiresInSeconds) * 1000;
    while (Date.now() < deadline) {
      if (params.cancelSignal?.aborted) {
        throw new OAuthConnectionError("approval_denied");
      }
      await delay(intervalMs, params.cancelSignal);
      if (params.cancelSignal?.aborted) {
        throw new OAuthConnectionError("approval_denied");
      }
      const body = new URLSearchParams();
      body.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
      body.set("device_code", params.deviceCode);
      body.set("client_id", params.clientId);
      applyOAuthClientAssertion(body, params);
      if (params.clientSecret && params.tokenAuth === "client_secret_post") {
        body.set("client_secret", params.clientSecret);
      }
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
      };
      if (params.clientSecret && params.tokenAuth === "client_secret_basic") {
        headers["authorization"] = basicAuthHeader(params.clientId, params.clientSecret);
      }
      const response = await fetch(params.tokenUrl, {
        method: "POST",
        headers,
        body,
        signal: params.cancelSignal,
      });
      const text = await response.text();
      const data = parseJsonObject(text, { strict: response.ok });
      const error = data?.["error"];
      if (response.ok && typeof error !== "string") {
        return parseBearerTokenResponse(data, {
          allowMissingExpiry: false,
          persistRefreshToken: params.persistRefreshToken,
        });
      }
      if (error === "authorization_pending") {
        continue;
      }
      if (error === "slow_down") {
        intervalMs += 5_000;
        continue;
      }
      if (error === "access_denied") {
        throw new OAuthConnectionError("approval_denied");
      }
      if (error === "expired_token") {
        throw new OAuthConnectionError("device_code_expired");
      }
      throw oauthConnectionError(
        "token_exchange_failed",
        formatOAuthTokenExchangeError(response.status, data, text)
      );
    }
    throw new OAuthConnectionError("device_code_expired");
  }

  async function exchangeOAuth1RequestToken(params: {
    requestTokenUrl: string;
    consumerKey: string;
    consumerSecret: string;
    callbackUrl: string;
  }): Promise<{ token: string; secret: string }> {
    const url = new URL(params.requestTokenUrl);
    const auth = oauth1AuthorizationHeader({
      method: "POST",
      url,
      consumerKey: params.consumerKey,
      consumerSecret: params.consumerSecret,
      extraOAuthParams: { oauth_callback: params.callbackUrl },
    });
    const response = await fetch(url, { method: "POST", headers: { authorization: auth } });
    const text = await response.text();
    if (!response.ok) {
      throw oauthConnectionError("token_exchange_failed", sanitizeOAuthErrorText(text));
    }
    const data = new URLSearchParams(text);
    const token = data.get("oauth_token");
    const secret = data.get("oauth_token_secret");
    if (!token || !secret) {
      throw new OAuthConnectionError("invalid_token_response");
    }
    return { token, secret };
  }

  async function exchangeOAuth1AccessToken(params: {
    accessTokenUrl: string;
    consumerKey: string;
    consumerSecret: string;
    requestToken: string;
    requestTokenSecret: string;
    verifier: string;
  }): Promise<{ token: string; secret: string }> {
    const url = new URL(params.accessTokenUrl);
    const auth = oauth1AuthorizationHeader({
      method: "POST",
      url,
      consumerKey: params.consumerKey,
      consumerSecret: params.consumerSecret,
      token: params.requestToken,
      tokenSecret: params.requestTokenSecret,
      extraOAuthParams: { oauth_verifier: params.verifier },
    });
    const response = await fetch(url, { method: "POST", headers: { authorization: auth } });
    const text = await response.text();
    if (!response.ok) {
      throw oauthConnectionError("token_exchange_failed", sanitizeOAuthErrorText(text));
    }
    const data = new URLSearchParams(text);
    const token = data.get("oauth_token");
    const secret = data.get("oauth_token_secret");
    if (!token || !secret) {
      throw new OAuthConnectionError("invalid_token_response");
    }
    return { token, secret };
  }

  async function listStoredCredentials(ctx: ServiceContext): Promise<StoredCredentialSummary[]> {
    const credentials = await credentialStore.listUrlBound();
    return credentials
      .filter((credential) => canCallerSeeStoredCredential(ctx, credential))
      .map(summarizeUrlBoundCredential);
  }

  async function revokeCredential(ctx: ServiceContext, params: CredentialIdParams): Promise<void> {
    const credential = await credentialStore.loadUrlBound(params.credentialId);
    if (!credential) {
      return;
    }
    if (!canCallerAdministerStoredCredential(ctx, credential)) {
      throw new Error("Credential caller is not authorized to revoke");
    }
    try {
      await revokeProviderTokenIfConfigured(credential);
    } catch (error) {
      await appendAudit({
        type: "connection_credential.revocation_failed",
        ts: Date.now(),
        callerId: ctx.caller.runtime.id,
        providerId: credential.providerId,
        connectionId: credential.connectionId,
        storageKind: "connection-credential",
        fieldNames: ["revocation"],
      });
      void error;
    }
    await credentialStore.saveUrlBound({
      ...credential,
      id: credential.id ?? params.credentialId,
      revokedAt: Date.now(),
    } as Credential & { id: string });
  }

  async function revokeProviderTokenIfConfigured(credential: Credential): Promise<void> {
    const revocationUrl = credential.metadata?.["oauthRevocationUrl"];
    if (!revocationUrl) return;
    const token = credential.refreshToken ?? credential.accessToken;
    if (!token) return;
    const body = new URLSearchParams();
    body.set("token", token);
    body.set("token_type_hint", credential.refreshToken ? "refresh_token" : "access_token");
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    const configId = credential.metadata?.["clientConfigId"];
    const configVersion = credential.metadata?.["clientConfigVersion"];
    if (configId) {
      const config = configVersion
        ? await clientConfigStore.loadVersion(configId, configVersion)
        : await clientConfigStore.load(configId);
      const clientId = config?.fields["clientId"]?.value;
      const clientSecret = config?.fields["clientSecret"]?.value;
      const tokenAuth = credential.metadata?.["oauthTokenAuth"];
      if (clientId) body.set("client_id", clientId);
      if (tokenAuth === "client_secret_basic" && clientId && clientSecret) {
        headers["authorization"] = basicAuthHeader(clientId, clientSecret);
      } else if (clientSecret) {
        body.set("client_secret", clientSecret);
      }
    }
    const response = await fetch(revocationUrl, { method: "POST", headers, body });
    if (!response.ok) {
      throw new OAuthConnectionError("token_exchange_failed", "Provider token revocation failed");
    }
  }

  async function grantCredential(
    ctx: ServiceContext,
    params: GrantCredentialParams
  ): Promise<StoredCredentialSummary> {
    requireShellOrServer(ctx, "grantCredential");
    const request = params as GrantUrlBoundCredentialRequest;
    void request.callerId;
    void request.grantedBy;
    throw new Error("credentials.grantCredential was replaced by scoped approval grants");
  }

  async function resolveCredential(
    ctx: ServiceContext,
    params: ResolveCredentialParams
  ): Promise<StoredCredentialSummary | null | DeferredResult> {
    const request = params as ResolveUrlBoundCredentialRequest;
    const use = request.use ?? "fetch";
    let credential: Credential;
    let usage: CredentialUseContext;
    if (request.credentialId) {
      credential = await loadActiveCredential(request.credentialId);
      if (!request.url) {
        const matched = providerCredentialUseContext(credential, request.providerId, use);
        if (!matched) {
          throw new Error("Credential does not match requested provider");
        }
        usage = matched;
      } else {
        const matched = credentialUseContext(credential, new URL(request.url), use);
        if (!matched) {
          throw new Error("Credential audience does not match requested URL");
        }
        usage = matched;
      }
    } else if (request.url) {
      const found = await findUrlBoundCredentialForUrl(new URL(request.url), use);
      if (!found) return null;
      credential = found.credential;
      usage = found.usage;
    } else if (request.providerId) {
      const found = await findUrlBoundCredentialForProvider(request.providerId, use);
      if (!found) return null;
      credential = found.credential;
      usage = found.usage;
    } else {
      return null;
    }

    // Already permitted — summarize inline (fast path, unchanged).
    if (canCallerUseStoredCredential(ctx, credential, usage)) {
      return summarizeUrlBoundCredential(credential);
    }

    // Approval needed. A hibernatable DO caller defers so it need not hold its
    // inbound request open across the (human) approval wait — the summary is
    // delivered out-of-band via onDeferredResult once the user decides.
    const produce = async (signal?: AbortSignal): Promise<StoredCredentialSummary> => {
      await authorizeCredentialUse(ctx, credential, usage, signal);
      return summarizeUrlBoundCredential(credential);
    };
    if (ctx.deferral?.canDefer) {
      return ctx.deferral.run(produce);
    }
    return produce();
  }

  async function proxyFetch(
    ctx: ServiceContext,
    params: ProxyFetchParams
  ): Promise<{
    status: number;
    statusText: string;
    /**
     * Headers as ordered pairs. Preserves duplicate `Set-Cookie`
     * entries (which the Fetch spec doesn't combine on iteration)
     * across the RPC boundary; a flat Record would silently drop all
     * but the last one.
     */
    headerPairs: Array<[string, string]>;
    /** Final URL after any redirects the upstream fetch followed. Mirrors `Response.url`. */
    finalUrl: string;
    /** Response body, base64-encoded. Always set; empty string for zero-byte bodies. */
    bodyBase64: string;
  }> {
    if (!egressProxy) {
      throw new Error("Egress proxy is unavailable");
    }
    const requestBody: string | Uint8Array | undefined =
      params.bodyBase64 !== undefined ? Buffer.from(params.bodyBase64, "base64") : params.body;
    const result = await egressProxy.forwardProxyFetch({
      caller: ctx.caller,
      url: params.url,
      method: params.method,
      headers: params.headers,
      body: requestBody,
      credentialId: params.credentialId,
    });
    return {
      status: result.status,
      statusText: result.statusText,
      headerPairs: result.headerPairs,
      finalUrl: result.finalUrl,
      bodyBase64: Buffer.from(result.body).toString("base64"),
    };
  }

  async function proxyGitHttp(
    ctx: ServiceContext,
    params: ProxyGitHttpParams
  ): Promise<ProxyGitHttpResponse> {
    if (!egressProxy) {
      throw new Error("Egress proxy is unavailable");
    }
    const request = params as ProxyGitHttpRequest;
    const result = await egressProxy.forwardGitHttp({
      caller: ctx.caller,
      url: request.url,
      method: request.method ?? "GET",
      headers: request.headers ?? {},
      body: request.bodyBase64 ? Buffer.from(request.bodyBase64, "base64") : undefined,
      credentialId: request.credentialId,
    });
    return {
      ...result,
      bodyBase64: Buffer.from(result.body).toString("base64"),
    };
  }

  async function audit(params: AuditParams): Promise<AuditEntry[]> {
    const entries =
      (await auditLog?.query({
        filter: params.filter,
        limit: params.limit,
        after: params.after,
      })) ?? [];
    return entries.filter((entry): entry is AuditEntry => "workerId" in entry);
  }

  async function appendAudit(entry: CredentialAuditEvent): Promise<void> {
    await auditLog?.append(entry);
  }

  async function createOAuthTransaction(
    ctx: ServiceContext,
    params: {
      id?: string;
      redirectUri: string;
      redirectStrategy: OAuthConnectionTransaction["redirectStrategy"];
      stateParam: string;
      deliveryCallerId?: string;
      deliveryCallerKind?: BrowserDeliveryCallerKind;
    }
  ): Promise<OAuthConnectionTransaction> {
    const identity = resolveApprovalIdentity(ctx);
    const id = params.id ?? randomUUID();
    let resolve!: OAuthConnectionTransaction["resolve"];
    let reject!: OAuthConnectionTransaction["reject"];
    const wait = new Promise<{ code: string; state: string; url: string }>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void wait.catch(() => undefined);
    const tx: OAuthConnectionTransaction = {
      id,
      state: "created",
      createdAt: Date.now(),
      expiresAt: Date.now() + PENDING_OAUTH_TTL_MS,
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      stateParam: params.stateParam,
      redirectUri: params.redirectUri,
      redirectStrategy: params.redirectStrategy,
      deliveryCallerId: params.deliveryCallerId,
      deliveryCallerKind: params.deliveryCallerKind,
      callbackUsed: false,
      resolve,
      reject,
      wait,
      timer: setTimeout(() => {
        void transitionOAuthTransaction(tx, "expired", "transaction_expired");
        oauthTransactions.delete(tx.id);
        reject(new OAuthConnectionError("callback_timeout"));
      }, PENDING_OAUTH_TTL_MS),
    };
    oauthTransactions.set(id, tx);
    await transitionOAuthTransaction(tx, "created");
    wait.finally(() => clearTimeout(tx.timer)).catch(() => undefined);
    return tx;
  }

  async function transitionOAuthTransaction(
    tx: OAuthConnectionTransaction,
    to: OAuthConnectionTransactionState,
    errorCode?: OAuthConnectionErrorCode
  ): Promise<void> {
    const from = tx.state;
    if (from === to && to !== "created") {
      return;
    }
    tx.state = to;
    await appendAudit({
      type: "oauth_connection_transaction.transition",
      ts: Date.now(),
      callerId: tx.callerId,
      transactionId: tx.id,
      from: from === to ? undefined : from,
      to,
      errorCode,
    });
  }

  async function receiveOAuthCallback(
    tx: OAuthConnectionTransaction,
    callback: { code?: string | null; state?: string | null; error?: string | null; url: string }
  ): Promise<void> {
    if (
      tx.callbackUsed ||
      tx.state === "callback_received" ||
      tx.state === "exchanging" ||
      tx.state === "completed" ||
      tx.state === "failed" ||
      tx.state === "cancelled" ||
      tx.state === "expired"
    ) {
      await transitionOAuthTransaction(tx, "failed", "transaction_replayed");
      tx.reject(new OAuthConnectionError("transaction_replayed"));
      return;
    }
    if (Date.now() > tx.expiresAt) {
      await transitionOAuthTransaction(tx, "expired", "transaction_expired");
      oauthTransactions.delete(tx.id);
      tx.reject(new OAuthConnectionError("transaction_expired"));
      return;
    }
    if (!callback.state || callback.state !== tx.stateParam) {
      await transitionOAuthTransaction(tx, "failed", "state_mismatch");
      tx.reject(new OAuthConnectionError("state_mismatch"));
      return;
    }
    if (!isExpectedRedirectCallback(tx, callback.url)) {
      await transitionOAuthTransaction(tx, "failed", "redirect_mismatch");
      tx.reject(new OAuthConnectionError("redirect_mismatch"));
      return;
    }
    if (callback.error) {
      await transitionOAuthTransaction(tx, "cancelled", "approval_denied");
      tx.reject(new OAuthConnectionError("approval_denied", callback.error));
      return;
    }
    if (!callback.code) {
      await transitionOAuthTransaction(tx, "failed", "invalid_token_response");
      tx.reject(new OAuthConnectionError("invalid_token_response"));
      return;
    }
    tx.callbackUsed = true;
    await transitionOAuthTransaction(tx, "callback_received");
    tx.resolve({ code: callback.code, state: callback.state, url: callback.url });
  }

  function findOAuthTransactionByState(
    state: string | undefined
  ): OAuthConnectionTransaction | undefined {
    if (!state) return undefined;
    for (const tx of oauthTransactions.values()) {
      if (tx.stateParam === state) return tx;
    }
    return undefined;
  }

  async function loadActiveCredential(credentialId: string): Promise<Credential & { id: string }> {
    let credential = await credentialStore.loadUrlBound(credentialId);
    if (!credential?.id || credential.revokedAt) {
      throw new Error("Credential is unavailable");
    }
    if (
      credential.expiresAt &&
      credential.expiresAt <= Date.now() + 30_000 &&
      credential.refreshToken
    ) {
      credential = await credentialLifecycle.refreshCredential(
        credential as Credential & { id: string }
      );
    }
    return credential as Credential & { id: string };
  }

  function resolveApprovalIdentity(ctx: ServiceContext): {
    callerId: string;
    repoPath: string;
    effectiveVersion: string;
  } {
    const identity = ctx.caller.code;
    return {
      callerId: identity?.callerId ?? ctx.caller.runtime.id,
      repoPath: identity?.repoPath ?? ctx.caller.runtime.id,
      effectiveVersion: identity?.effectiveVersion ?? "unknown",
    };
  }

  async function requestCredentialApproval(
    ctx: ServiceContext,
    params: {
      credentialId: string;
      credentialLabel: string;
      audience: UrlAudience[];
      injection: CredentialBinding["injection"];
      accountIdentity: Credential["accountIdentity"];
      scopes: string[];
      identity: { repoPath: string; effectiveVersion: string };
      metadata?: Record<string, string>;
      replacementCredentialLabel?: string;
      signal?: AbortSignal;
    }
  ): Promise<Exclude<GrantedDecision, "deny">> {
    throwIfAborted(params.signal);
    if (!approvalQueue || !isUserlandRuntimeCaller(ctx)) {
      return "session";
    }
    const oauthAuthorizeOrigin = params.metadata?.["oauthAuthorizeOrigin"];
    const oauthTokenOrigin = params.metadata?.["oauthTokenOrigin"];
    const oauthUserinfoOrigin = params.metadata?.["oauthUserinfoOrigin"];
    const decision = await approvalQueue.request({
      ...(params.signal ? { signal: params.signal } : {}),
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      repoPath: params.identity.repoPath,
      effectiveVersion: params.identity.effectiveVersion,
      credentialId: params.credentialId,
      credentialLabel: params.credentialLabel,
      audience: params.audience ?? [],
      injection: params.injection ?? fail("Credential injection is required"),
      accountIdentity: params.accountIdentity,
      scopes: params.scopes,
      oauthAuthorizeOrigin,
      oauthTokenOrigin,
      oauthUserinfoOrigin,
      oauthAudienceDomainMismatch: hasOAuthAudienceDomainMismatch(params.audience ?? [], [
        oauthAuthorizeOrigin,
        oauthTokenOrigin,
      ]),
      replacementCredentialLabel: params.replacementCredentialLabel,
    });
    if (decision === "deny") {
      throw new Error("Credential approval denied");
    }
    return decision;
  }

  /**
   * Locate the single URL-bound credential matching `targetUrl` (lookup only —
   * authorization is applied by the caller, so the call can be deferred). Throws
   * on ambiguity; returns null when nothing matches.
   */
  async function findUrlBoundCredentialForUrl(
    targetUrl: URL,
    use: CredentialBindingUse = "fetch"
  ): Promise<{ credential: Credential; usage: CredentialUseContext } | null> {
    const credentials = (await credentialStore.listUrlBound()).filter(
      (credential) => !credential.revokedAt && !!findCredentialBinding(credential, targetUrl, use)
    );
    if (credentials.length > 1) {
      throw new Error("Multiple credentials match requested URL; choose an explicit credential");
    }
    const credential = credentials[0] ?? null;
    if (!credential) return null;
    const active = credential.id ? await loadActiveCredential(credential.id) : credential;
    const usage = credentialUseContext(active, targetUrl, use);
    if (!usage) {
      throw new Error("Credential audience does not match requested URL");
    }
    return { credential: active, usage };
  }

  async function findUrlBoundCredentialForProvider(
    providerId: string,
    use: CredentialBindingUse = "fetch"
  ): Promise<{ credential: Credential; usage: CredentialUseContext } | null> {
    const credentials = (await credentialStore.listUrlBound()).filter((credential) => {
      if (credential.revokedAt) return false;
      if (
        credential.metadata?.["providerId"] !== providerId &&
        credential.metadata?.["modelProviderId"] !== providerId &&
        credential.providerId !== providerId
      ) {
        return false;
      }
      return credential.bindings?.some((binding) => binding.use === use) ?? false;
    });
    if (credentials.length > 1) {
      throw new Error(
        "Multiple credentials match requested provider; choose an explicit credential"
      );
    }
    const credential = credentials[0] ?? null;
    if (!credential) return null;
    const active = credential.id ? await loadActiveCredential(credential.id) : credential;
    const usage = providerCredentialUseContext(active, providerId, use);
    if (!usage) {
      throw new Error("Credential provider does not match requested provider");
    }
    return { credential: active, usage };
  }

  function providerCredentialUseContext(
    credential: Credential,
    providerId: string | undefined,
    use: CredentialBindingUse
  ): CredentialUseContext | null {
    if (
      providerId &&
      credential.metadata?.["providerId"] !== providerId &&
      credential.metadata?.["modelProviderId"] !== providerId &&
      credential.providerId !== providerId
    ) {
      return null;
    }
    const binding = credential.bindings?.find((candidate) => candidate.use === use);
    const audience = binding?.audience[0];
    if (!binding || !audience) return null;
    const action: CredentialGrantAction = use === "git-http" || use === "git-ssh" ? "read" : "use";
    return {
      binding,
      resource: audience.url,
      action,
      sessionResource: {
        bindingId: binding.id,
        resource: audience.url,
        action,
      },
      gitOperation: undefined,
    };
  }

  async function findReplacementCandidate(
    ctx: ServiceContext,
    candidate: {
      label: string;
      audience: UrlAudience[];
      metadata?: Record<string, string>;
      accountIdentity: Partial<AccountIdentity>;
    }
  ): Promise<(Credential & { id: string }) | null> {
    const account = normalizeAccountIdentity(candidate.accountIdentity, ctx.caller.runtime.id);
    if (!account.providerUserId || account.providerUserId === ctx.caller.runtime.id) {
      return null;
    }
    const identity = ctx.caller.code ?? null;
    const ownerSourceId = identity?.repoPath ?? ctx.caller.runtime.id;
    const providerKey =
      candidate.metadata?.["providerId"] ??
      candidate.metadata?.["modelProviderId"] ??
      candidate.label;
    const audienceKey = normalizedAudienceKey(candidate.audience);
    const existing = await credentialStore.listUrlBound();
    return (
      existing.find(
        (credential): credential is Credential & { id: string } =>
          !!credential.id &&
          !credential.revokedAt &&
          credential.owner?.sourceId === ownerSourceId &&
          credential.accountIdentity?.providerUserId === account.providerUserId &&
          (credential.metadata?.["providerId"] ??
            credential.metadata?.["modelProviderId"] ??
            credential.label) === providerKey &&
          normalizedAudienceKey(summarizeUrlBoundCredential(credential).audience) === audienceKey
      ) ?? null
    );
  }

  async function pruneClientConfigVersions(record: ClientConfigRecord): Promise<void> {
    if (!record.versions) return;
    const keep = new Set<string>();
    if (record.currentVersion) keep.add(record.currentVersion);
    const credentials = await credentialStore.listUrlBound();
    for (const credential of credentials) {
      if (credential.metadata?.["clientConfigId"] === record.configId) {
        const version = credential.metadata["clientConfigVersion"];
        if (version) keep.add(version);
      }
    }
    record.versions = Object.fromEntries(
      Object.entries(record.versions).filter(([version]) => keep.has(version))
    );
  }

  async function authorizeCredentialUse(
    ctx: ServiceContext,
    credential: Credential,
    usage: CredentialUseContext,
    signal?: AbortSignal
  ): Promise<void> {
    if (canCallerUseStoredCredential(ctx, credential, usage)) {
      return;
    }
    if (
      !approvalQueue ||
      (ctx.caller.runtime.kind !== "panel" &&
        ctx.caller.runtime.kind !== "app" &&
        ctx.caller.runtime.kind !== "worker" &&
        ctx.caller.runtime.kind !== "do")
    ) {
      throw new Error("Credential caller is not granted");
    }
    if (!credential.id) {
      throw new Error("Credential is missing URL-bound metadata");
    }
    const identity = resolveApprovalIdentity(ctx);
    const decision = await approvalQueue.request({
      // When the caller deferred, this signal is aborted on TTL expiry so the
      // pending approval is cancelled cleanly instead of leaking a waiter.
      ...(signal ? { signal } : {}),
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      credentialId: credential.id,
      credentialLabel: credential.label ?? credential.connectionLabel,
      audience: usage.binding.audience,
      injection: usage.binding.injection,
      accountIdentity: credential.accountIdentity,
      scopes: credential.scopes,
      credentialUse: usage.binding.use,
      gitOperation: usage.gitOperation,
      grantResource: usage.sessionResource,
      oauthAuthorizeOrigin: credential.metadata?.["oauthAuthorizeOrigin"],
      oauthTokenOrigin: credential.metadata?.["oauthTokenOrigin"],
      oauthUserinfoOrigin: credential.metadata?.["oauthUserinfoOrigin"],
      oauthAudienceDomainMismatch: hasOAuthAudienceDomainMismatch(usage.binding.audience, [
        credential.metadata?.["oauthAuthorizeOrigin"],
        credential.metadata?.["oauthTokenOrigin"],
      ]),
    });
    if (decision === "deny") {
      throw new Error("Credential approval denied");
    }
    const now = Date.now();
    if (decision === "once") {
      if (!ctx.deferral?.canDefer) {
        return;
      }
      // A deferrable caller cannot consume a one-shot grant inline: it parks,
      // returns to the runner, then resolves credentials again during resume.
      // Treat that deferred one-shot approval as a session grant for the same
      // caller/resource so the approved turn can actually continue.
      grantSessionCredentialUse(credential.id, identity, usage.sessionResource);
      resolvePendingCredentialUseGrants(credential.id, identity, "session", usage);
      return;
    }
    if (decision === "session") {
      grantSessionCredentialUse(credential.id, identity, usage.sessionResource);
      resolvePendingCredentialUseGrants(credential.id, identity, decision, usage);
      return;
    }
    await credentialStore.saveUrlBound({
      ...credential,
      grants: upsertCredentialUseGrant(
        credential.grants ?? [],
        grantForDecision(ctx.caller.runtime.id, identity, decision, now, usage)
      ),
      metadata: {
        ...(credential.metadata ?? {}),
        updatedAt: String(now),
      },
    } as Credential & { id: string });
    resolvePendingCredentialUseGrants(credential.id, identity, decision, usage);
  }

  function canCallerSeeStoredCredential(ctx: ServiceContext, credential: Credential): boolean {
    if (ctx.caller.runtime.kind === "shell" || ctx.caller.runtime.kind === "server") {
      return true;
    }
    const identity = ctx.caller.code;
    if (!identity) {
      return false;
    }
    if (credential.owner?.sourceId === identity.repoPath) {
      return true;
    }
    return !!credential.grants?.some((grant) => grantAppliesToIdentity(grant, identity));
  }

  function canCallerUseStoredCredential(
    ctx: ServiceContext,
    credential: Credential,
    usage: CredentialUseContext
  ): boolean {
    if (ctx.caller.runtime.kind === "shell" || ctx.caller.runtime.kind === "server") {
      return true;
    }
    return (
      hasPersistentCredentialUse(ctx, credential, usage) ||
      hasSessionCredentialUse(ctx, credential, usage)
    );
  }

  function canCallerAdministerStoredCredential(
    ctx: ServiceContext,
    credential: Credential
  ): boolean {
    if (ctx.caller.runtime.kind === "shell" || ctx.caller.runtime.kind === "server") {
      return true;
    }
    return canCallerSeeStoredCredential(ctx, credential);
  }

  function grantSessionCredentialUse(
    credentialId: string,
    identity: CredentialSessionGrantScope,
    resource: CredentialSessionGrantResource
  ): void {
    sessionGrantStore.grant(credentialId, identity, resource);
  }

  function resolvePendingCredentialUseGrants(
    credentialId: string,
    identity: { callerId?: string; repoPath: string; effectiveVersion: string },
    decision: Exclude<GrantedDecision, "deny" | "once">,
    usage: CredentialUseContext
  ): void {
    if (typeof approvalQueue?.resolveMatching !== "function") return;
    approvalQueue.resolveMatching((approval) => {
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
      if (decision === "session") return approval.callerId === identity.callerId;
      if (decision === "repo") return approval.repoPath === identity.repoPath;
      return (
        approval.repoPath === identity.repoPath &&
        approval.effectiveVersion === identity.effectiveVersion
      );
    }, "once");
  }

  function applyPreapprovedCredentialUseGrants(
    ctx: ServiceContext,
    credential: Credential & { id: string },
    bindings: CredentialBinding[],
    decision: Exclude<GrantedDecision, "deny">,
    now: number
  ): void {
    const identity = resolveApprovalIdentity(ctx);
    const usageContexts = bindings.flatMap(preapprovedUseContextsForBinding);
    if (decision === "once" || decision === "session") {
      for (const usage of usageContexts) {
        grantSessionCredentialUse(credential.id, identity, usage.sessionResource);
      }
      return;
    }
    credential.grants = usageContexts.reduce(
      (grants, usage) =>
        upsertCredentialUseGrant(
          grants,
          grantForDecision(ctx.caller.runtime.id, identity, decision, now, usage)
        ),
      credential.grants ?? []
    );
  }

  function hasSessionCredentialUse(
    ctx: ServiceContext,
    credential: Credential,
    usage: CredentialUseContext
  ): boolean {
    const credentialId = credential.id ?? credential.connectionId;
    if (!credentialId) {
      return false;
    }
    return sessionGrantStore.has(credentialId, resolveApprovalIdentity(ctx), usage.sessionResource);
  }

  function hasPersistentCredentialUse(
    ctx: ServiceContext,
    credential: Credential,
    usage: CredentialUseContext
  ): boolean {
    const identity = resolveApprovalIdentity(ctx);
    return !!credential.grants?.some(
      (grant) =>
        grant.bindingId === usage.binding.id &&
        grant.use === usage.binding.use &&
        grant.resource === usage.resource &&
        grant.action === usage.action &&
        grantAppliesToIdentity(grant, identity)
    );
  }

  const definition: ServiceDefinition = {
    name: "credentials",
    description: "URL-bound userland credential storage and egress",
    policy: { allowed: ["shell", "app", "panel", "server", "worker", "do", "extension"] },
    methods: credentialsMethods,
    handler: async (ctx, method, args) => {
      switch (method) {
        case "storeCredential":
          return storeCredential(ctx, (args as [StoreUrlBoundCredentialParams])[0]);
        case "connect":
          return connectCredential(ctx, (args as [ConnectCredentialParams])[0]);
        case "configureClient":
          return configureClient(ctx, (args as [ConfigureClientParams])[0]);
        case "requestCredentialInput":
          return requestCredentialInput(ctx, (args as [RequestCredentialInputParams])[0]);
        case "getClientConfigStatus":
          return getClientConfigStatus(ctx, (args as [GetClientConfigStatusParams])[0]);
        case "deleteClientConfig":
          return deleteClientConfig(ctx, (args as [DeleteClientConfigParams])[0]);
        case "forwardOAuthCallback":
          return forwardOAuthCallback(ctx, (args as [ForwardOAuthCallbackParams])[0]);
        case "listStoredCredentials":
          return listStoredCredentials(ctx);
        case "revokeCredential":
          return revokeCredential(ctx, (args as [CredentialIdParams])[0]);
        case "grantCredential":
          return grantCredential(ctx, (args as [GrantCredentialParams])[0]);
        case "resolveCredential":
          return resolveCredential(ctx, (args as [ResolveCredentialParams])[0]);
        case "proxyFetch":
          return proxyFetch(ctx, (args as [ProxyFetchParams])[0]);
        case "proxyGitHttp":
          return proxyGitHttp(ctx, (args as [ProxyGitHttpParams])[0]);
        case "audit":
          return audit((args as [AuditParams])[0]);
        default:
          throw new Error(`Unknown credentials method: ${method}`);
      }
    },
  };

  const publicCallbackHandler: ServiceRouteDecl["handler"] = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const stateParam = url.searchParams.get("state") ?? undefined;
    const tx = findOAuthTransactionByState(stateParam);
    if (!tx) {
      respondOAuthCallback(res, 400, "No matching OAuth connection is waiting for this callback.");
      return;
    }
    const providerError = url.searchParams.get("error");
    const callbackUrl = new URL(req.url ?? "/", tx.redirectUri);
    await receiveOAuthCallback(tx, {
      code: callbackUrl.searchParams.get("code") ?? callbackUrl.searchParams.get("oauth_verifier"),
      state: callbackUrl.searchParams.get("state"),
      error: providerError,
      url: callbackUrl.toString(),
    });
    if (tx.state === "failed" || tx.state === "expired" || tx.state === "cancelled") {
      respondOAuthCallback(
        res,
        400,
        providerError
          ? "The provider denied the connection."
          : "OAuth callback could not be validated."
      );
    } else if (providerError) {
      respondOAuthCallback(res, 400, "The provider denied the connection.");
    } else if (!callbackUrl.searchParams.get("code")) {
      respondOAuthCallback(res, 400, "Missing authorization code.");
    } else {
      respondOAuthCallback(res, 200, "Connection complete. You can close this window.");
    }
  };

  const routes: ServiceRouteDecl[] = [
    {
      serviceName: "credentials",
      path: "/oauth/callback",
      methods: ["GET"],
      auth: "public",
      handler: publicCallbackHandler,
    },
  ];

  return Object.assign(definition, { routes });
}

function normalizeAccountIdentity(
  input: Partial<AccountIdentity> | undefined,
  callerId: string
): AccountIdentity {
  return {
    providerUserId: input?.providerUserId ?? input?.email ?? input?.username ?? callerId,
    ...(input?.email ? { email: input.email } : {}),
    ...(input?.username ? { username: input.username } : {}),
    ...(input?.workspaceName ? { workspaceName: input.workspaceName } : {}),
  };
}

function validateApiKeyMaterialTemplate(template: string, fieldNames: readonly string[]): void {
  const declared = new Set(fieldNames);
  const placeholders = template.match(/\{[a-zA-Z0-9._@+=:-]+\}/g) ?? [];
  if (placeholders.length === 0) {
    throw new OAuthConnectionError(
      "invalid_connection_spec",
      "api-key materialTemplate must reference at least one field"
    );
  }
  for (const placeholder of placeholders) {
    const name = placeholder.slice(1, -1);
    if (!declared.has(name)) {
      throw new OAuthConnectionError(
        "invalid_connection_spec",
        `api-key materialTemplate references undeclared field: ${name}`
      );
    }
  }
}

function renderApiKeyMaterialTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9._@+=:-]+)\}/g, (_match, name: string) => {
    return values[name]?.trim() ?? "";
  });
}

function parseBearerTokenResponse(
  tokenData: Record<string, unknown> | null,
  options: { allowMissingExpiry?: boolean; persistRefreshToken?: boolean }
): { accessToken: string; refreshToken?: string; expiresAt?: number; scopes?: string[] } {
  const accessToken = tokenData?.["access_token"];
  const tokenType = tokenData?.["token_type"];
  if (typeof accessToken !== "string") {
    throw oauthConnectionError(
      "invalid_token_response",
      "OAuth token exchange did not return an access_token"
    );
  }
  if (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer") {
    throw oauthConnectionError(
      "invalid_token_response",
      "OAuth token exchange did not return bearer token_type"
    );
  }
  const expiresIn = readNumericField(tokenData?.["expires_in"]);
  if (expiresIn === undefined && !options.allowMissingExpiry) {
    throw oauthConnectionError(
      "invalid_token_response",
      "OAuth token exchange did not return expires_in"
    );
  }
  const refreshToken = tokenData?.["refresh_token"];
  const scope = tokenData?.["scope"];
  return {
    accessToken,
    ...(options.persistRefreshToken && typeof refreshToken === "string" && refreshToken.length > 0
      ? { refreshToken }
      : {}),
    ...(typeof expiresIn === "number" ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    ...(typeof scope === "string" && scope.trim() ? { scopes: scope.trim().split(/\s+/) } : {}),
  };
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(username)}:${encodeURIComponent(password)}`).toString("base64")}`;
}

function applyOAuthClientAssertion(
  body: URLSearchParams,
  params: {
    tokenUrl: string;
    clientId: string;
    privateKeyPem?: string;
    keyId?: string;
    keyAlgorithm?: string;
    tokenAuth: "none" | "client_secret_post" | "client_secret_basic" | "private_key_jwt";
  }
): void {
  if (params.tokenAuth !== "private_key_jwt") {
    return;
  }
  if (!params.privateKeyPem) {
    throw new OAuthConnectionError(
      "client_config_unavailable",
      "private_key_jwt requires a configured private key"
    );
  }
  body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
  body.set(
    "client_assertion",
    signJwtAssertion({
      issuer: params.clientId,
      subject: params.clientId,
      audience: params.tokenUrl,
      privateKeyPem: params.privateKeyPem,
      keyId: params.keyId,
      keyAlgorithm: params.keyAlgorithm,
    })
  );
}

function signJwtAssertion(params: {
  issuer: string;
  subject: string;
  audience: string;
  privateKeyPem: string;
  keyId?: string;
  keyAlgorithm?: string;
}): string {
  const algorithm = params.keyAlgorithm || "RS256";
  if (algorithm !== "RS256") {
    throw new OAuthConnectionError(
      "unsupported_token_auth_method",
      "Only RS256 JWT client assertions are supported"
    );
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = {
    alg: algorithm,
    typ: "JWT",
    ...(params.keyId ? { kid: params.keyId } : {}),
  };
  const payload = {
    iss: params.issuer,
    sub: params.subject,
    aud: params.audience,
    iat: nowSeconds,
    exp: nowSeconds + 300,
    jti: randomUUID(),
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(params.privateKeyPem).toString("base64url")}`;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sshPublicKeyFingerprint(publicKey: string): string {
  return `SHA256:${createHash("sha256").update(publicKey).digest("base64url")}`;
}

function openSshEd25519PublicKey(spkiDer: Buffer): string {
  const keyBytes = spkiDer.subarray(-32);
  if (keyBytes.length !== 32) {
    throw new OAuthConnectionError(
      "invalid_connection_spec",
      "Unable to derive Ed25519 public key"
    );
  }
  const type = Buffer.from("ssh-ed25519");
  const wire = Buffer.concat([uint32(type.length), type, uint32(keyBytes.length), keyBytes]);
  return `ssh-ed25519 ${wire.toString("base64")}`;
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function oauth1AuthorizationHeader(params: {
  method: string;
  url: URL;
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
  extraOAuthParams?: Record<string, string>;
}): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: params.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...(params.token ? { oauth_token: params.token } : {}),
    ...(params.extraOAuthParams ?? {}),
  };
  const signatureParams = new URLSearchParams(params.url.search);
  for (const [key, value] of Object.entries(oauthParams)) {
    signatureParams.append(key, value);
  }
  const normalizedParams = Array.from(signatureParams.entries())
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
    )
    .map(([key, value]) => `${oauthPercentEncode(key)}=${oauthPercentEncode(value)}`)
    .join("&");
  const baseUrl = new URL(params.url.toString());
  baseUrl.search = "";
  const signatureBase = [
    params.method.toUpperCase(),
    oauthPercentEncode(baseUrl.toString()),
    oauthPercentEncode(normalizedParams),
  ].join("&");
  const signingKey = `${oauthPercentEncode(params.consumerSecret)}&${oauthPercentEncode(params.tokenSecret ?? "")}`;
  oauthParams["oauth_signature"] = createHmacSha1(signingKey, signatureBase);
  return (
    "OAuth " +
    Object.entries(oauthParams)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${oauthPercentEncode(key)}="${oauthPercentEncode(value)}"`)
      .join(", ")
  );
}

function createHmacSha1(key: string, value: string): string {
  return createHmac("sha1", key).update(value).digest("base64");
}

function oauthPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function connectionAbortError(): OAuthConnectionError {
  return new OAuthConnectionError("approval_denied", "Credential connection cancelled");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw connectionAbortError();
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort?.();
      reject(connectionAbortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", abort);
        reject(err);
      }
    );
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(connectionAbortError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  for (const signal of active) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

function isSameConfigTrustScope(
  identity: { repoPath: string; effectiveVersion: string; callerId: string },
  owner: { repoPath: string; effectiveVersion: string; callerId: string }
): boolean {
  return (
    identity.repoPath === owner.repoPath &&
    (identity.effectiveVersion === owner.effectiveVersion || identity.callerId === owner.callerId)
  );
}

function deriveAccountIdentityFromJwt(
  accessToken: string,
  metadata: Record<string, string> | undefined
): Partial<AccountIdentity> {
  const root = metadata?.["accountIdentityJwtClaimRoot"];
  const field = metadata?.["accountIdentityJwtClaimField"];
  if (!field) {
    return {};
  }
  const payload = decodeJwtPayload(accessToken);
  if (!payload) {
    return {};
  }
  const container = root ? payload[root] : payload;
  if (!container || typeof container !== "object") {
    return {};
  }
  const providerUserId = (container as Record<string, unknown>)[field];
  return typeof providerUserId === "string" && providerUserId.length > 0 ? { providerUserId } : {};
}

async function validateOAuthAccountIdentity(
  request: InternalOAuthConnectionRequest,
  accessToken: string
): Promise<Partial<AccountIdentity>> {
  const spec = request.flow.accountValidation?.userinfo;
  if (!spec) {
    return {};
  }
  const userinfoUrl = canonicalUrl(spec.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_USERINFO_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(userinfoUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new OAuthConnectionError(
        "account_validation_failed",
        "OAuth account validation timed out"
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  const data = parseJsonObject(text, { strict: response.ok });
  if (!response.ok || !data) {
    throw new OAuthConnectionError("account_validation_failed", "OAuth account validation failed");
  }
  const identity: Partial<AccountIdentity> = {};
  const idValue = readStringClaim(data, spec.idField ?? "sub");
  const email = readStringClaim(data, spec.emailField ?? "email");
  const username = readStringClaim(data, spec.usernameField ?? "preferred_username");
  const workspaceName = spec.workspaceField
    ? readStringClaim(data, spec.workspaceField)
    : undefined;
  if (idValue) identity.providerUserId = idValue;
  if (email) identity.email = email;
  if (username) identity.username = username;
  if (workspaceName) identity.workspaceName = workspaceName;
  if (!identity.providerUserId && (identity.email || identity.username)) {
    identity.providerUserId = identity.email ?? identity.username;
  }
  if (!identity.providerUserId) {
    throw new OAuthConnectionError(
      "account_validation_failed",
      "OAuth account validation did not return an account identity"
    );
  }
  return identity;
}

function readStringClaim(
  data: Record<string, unknown>,
  path: string | undefined
): string | undefined {
  if (!path) return undefined;
  let current: unknown = data;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" && current.length > 0 ? current : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) {
      return null;
    }
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const payload = JSON.parse(decoded);
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function summarizeUrlBoundCredential(credential: Credential): StoredCredentialSummary {
  const bindings = credentialBindings(credential);
  const primaryBinding = bindings.find((binding) => binding.use === "fetch") ?? bindings[0];
  if (!credential.id || !credential.label || !primaryBinding) {
    throw new Error("Stored credential is missing URL-bound metadata");
  }
  return {
    id: credential.id,
    label: credential.label,
    accountIdentity: credential.accountIdentity,
    audience: primaryBinding.audience,
    injection: primaryBinding.injection,
    bindings,
    owner: credential.owner,
    scopes: credential.scopes,
    expiresAt: credential.expiresAt,
    revokedAt: credential.revokedAt,
    metadata: credential.metadata,
  };
}

function normalizeCredentialBindings(
  bindings: readonly CredentialBinding[] | undefined,
  fallback: { audience: UrlAudience[]; injection: CredentialBinding["injection"] }
): CredentialBinding[] {
  if (!fallback.audience || !fallback.injection) {
    throw new Error("Credential fallback binding is missing URL-bound metadata");
  }
  const rawBindings = bindings?.length
    ? bindings
    : [
        {
          id: "fetch",
          use: "fetch" as const,
          audience: fallback.audience,
          injection: fallback.injection,
        },
      ];
  return rawBindings.map((binding) => ({
    id: binding.id,
    use: binding.use,
    audience: normalizeUrlAudiences(binding.audience),
    injection: normalizeCredentialInjection(binding.injection),
  }));
}

function credentialBindings(credential: Credential): CredentialBinding[] {
  if (credential.bindings?.length) {
    return credential.bindings;
  }
  return [];
}

function findCredentialBinding(
  credential: Credential,
  targetUrl: URL,
  use: CredentialBindingUse
): CredentialBinding | null {
  return (
    credentialBindings(credential).find(
      (binding) => binding.use === use && !!findMatchingUrlAudience(targetUrl, binding.audience)
    ) ?? null
  );
}

function credentialUseContext(
  credential: Credential,
  targetUrl: URL,
  use: CredentialBindingUse
): CredentialUseContext | null {
  const binding = findCredentialBinding(credential, targetUrl, use);
  if (!binding) {
    return null;
  }
  const resource =
    binding.use === "git-http" || binding.use === "git-ssh"
      ? gitRemoteFromUrl(targetUrl)
      : (findMatchingUrlAudience(targetUrl, binding.audience)?.url ?? targetUrl.origin);
  const gitOperation =
    binding.use === "git-http" || binding.use === "git-ssh"
      ? describeGitHttpOperation(targetUrl, "GET")
      : undefined;
  const action: CredentialGrantAction = gitOperation?.action ?? "use";
  return {
    binding,
    resource,
    action,
    sessionResource: {
      bindingId: binding.id,
      resource,
      action,
    },
    gitOperation,
  };
}

function preapprovedUseContextsForBinding(binding: CredentialBinding): CredentialUseContext[] {
  return binding.audience.map((audience) => {
    const action: CredentialGrantAction =
      binding.use === "git-http" || binding.use === "git-ssh" ? "read" : "use";
    return {
      binding,
      resource: audience.url,
      action,
      sessionResource: {
        bindingId: binding.id,
        resource: audience.url,
        action,
      },
      gitOperation: undefined,
    };
  });
}

function describeGitHttpOperation(
  targetUrl: URL,
  method: string
): CredentialUseContext["gitOperation"] {
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

function requireShellOrServer(ctx: ServiceContext, method: string): void {
  if (ctx.caller.runtime.kind !== "shell" && ctx.caller.runtime.kind !== "server") {
    throw new Error(`credentials.${method} is restricted to shell/server callers`);
  }
}

function grantForDecision(
  callerId: string,
  identity: { repoPath: string; effectiveVersion: string },
  decision: Exclude<GrantedDecision, "deny" | "once" | "session">,
  grantedAt: number,
  usage: CredentialUseContext
): CredentialUseGrant {
  const base = {
    bindingId: usage.binding.id,
    use: usage.binding.use,
    resource: usage.resource,
    action: usage.action,
    grantedAt,
    grantedBy: decision,
  };
  if (decision === "repo") {
    return { ...base, scope: "repo", repoPath: identity.repoPath };
  }
  if (decision === "version") {
    return {
      ...base,
      scope: "version",
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
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

function grantAppliesToIdentity(
  grant: CredentialUseGrant,
  identity: { callerId?: string; repoPath: string; effectiveVersion: string }
): boolean {
  if (grant.scope === "caller") {
    return !!identity.callerId && grant.callerId === identity.callerId;
  }
  if (grant.scope === "repo") {
    return grant.repoPath === identity.repoPath;
  }
  return (
    grant.repoPath === identity.repoPath && grant.effectiveVersion === identity.effectiveVersion
  );
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

function normalizedAudienceKey(audience: readonly UrlAudience[]): string {
  return normalizeUrlAudiences(audience)
    .map((entry) => `${entry.match}:${entry.url}`)
    .sort()
    .join("|");
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

interface HostOAuthCallback {
  redirectUri: string;
  wait: Promise<{ code?: string; state: string; url: string; error?: string }>;
  expectState(state: string): void;
  close(): void;
}

async function createLoopbackOAuthCallback(opts: {
  host: string;
  port: number;
  callbackPath: string;
  allowDynamicPortFallback: boolean;
  signal?: AbortSignal;
}): Promise<HostOAuthCallback> {
  try {
    return await bindLoopbackOAuthCallback(
      opts.host,
      opts.port,
      normalizeCallbackPath(opts.callbackPath),
      opts.signal
    );
  } catch (error) {
    if (
      opts.port > 0 &&
      opts.allowDynamicPortFallback &&
      error instanceof Error &&
      /address in use|EADDRINUSE|already in use/i.test(error.message)
    ) {
      return bindLoopbackOAuthCallback(
        opts.host,
        0,
        normalizeCallbackPath(opts.callbackPath),
        opts.signal
      );
    }
    if (error instanceof Error && /address in use|EADDRINUSE|already in use/i.test(error.message)) {
      throw new Error("redirect_unavailable");
    }
    throw error;
  }
}

async function bindLoopbackOAuthCallback(
  host: string,
  port: number,
  callbackPath: string,
  signal?: AbortSignal
): Promise<HostOAuthCallback> {
  let expectedState: string | undefined;
  let settled = false;
  let redirectUri = "";
  let resolve!: (value: { code?: string; state: string; url: string; error?: string }) => void;
  let reject!: (error: Error) => void;
  const wait = new Promise<{ code?: string; state: string; url: string; error?: string }>(
    (res, rej) => {
      resolve = res;
      reject = rej;
    }
  );
  void wait.catch(() => undefined);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    if (url.pathname !== callbackPath) {
      respondOAuthCallback(res, 404, "not found");
      return;
    }
    const state = url.searchParams.get("state");
    if (!state || (expectedState && state !== expectedState)) {
      respondOAuthCallback(res, 400, "OAuth state mismatch.");
      if (!settled) {
        settled = true;
        reject(oauthConnectionError("state_mismatch", "state_mismatch"));
      }
      return;
    }
    const providerError = url.searchParams.get("error");
    if (providerError) {
      respondOAuthCallback(res, 400, "The provider denied the connection.");
      if (!settled) {
        settled = true;
        resolve({ state, error: providerError, url: url.toString() });
      }
      return;
    }
    const code = url.searchParams.get("code") ?? url.searchParams.get("oauth_verifier");
    if (!code) {
      respondOAuthCallback(res, 400, "Missing authorization code.");
      if (!settled) {
        settled = true;
        reject(oauthConnectionError("invalid_token_response", "invalid_token_response"));
      }
      return;
    }
    respondOAuthCallback(res, 200, "Connection complete. You can close this window.");
    if (!settled) {
      settled = true;
      resolve({ code, state, url: url.toString() });
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });
  const abort = () => {
    if (settled) return;
    settled = true;
    reject(oauthConnectionError("approval_denied", "Credential connection cancelled"));
    server.close();
  };
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    signal?.removeEventListener("abort", abort);
    server.close();
    throw new Error("Failed to bind OAuth callback server");
  }
  redirectUri = `http://${host}:${address.port}${callbackPath}`;
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      reject(oauthConnectionError("callback_timeout", "callback_timeout"));
    }
    server.close();
  }, PENDING_OAUTH_TTL_MS);
  wait
    .finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      server.close();
    })
    .catch(() => undefined);
  return {
    redirectUri,
    wait,
    expectState(state: string) {
      expectedState = state;
    },
    close() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      server.close();
    },
  };
}

function normalizeCallbackPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function respondOAuthCallback(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function isExpectedRedirectCallback(tx: { redirectUri: string }, callbackUrl: string): boolean {
  try {
    const expected = new URL(tx.redirectUri);
    const actual = new URL(callbackUrl);
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

function errorCodeForOAuthError(error: unknown): OAuthConnectionErrorCode {
  if (error instanceof OAuthConnectionError) {
    return error.code;
  }
  if (error instanceof CredentialLifecycleError) {
    return error.code;
  }
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  if (typeof code === "string" && isOAuthConnectionErrorCode(code)) {
    return code;
  }
  return "token_exchange_failed";
}

function oauthConnectionError(
  code: OAuthConnectionErrorCode,
  message: string
): Error & { code: OAuthConnectionErrorCode } {
  return Object.assign(new Error(message), { code });
}

function isOAuthConnectionErrorCode(value: string): value is OAuthConnectionErrorCode {
  return [
    "unsupported_flow",
    "invalid_connection_spec",
    "approval_denied",
    "browser_unavailable",
    "unsupported_browser_mode",
    "callback_timeout",
    "state_mismatch",
    "redirect_mismatch",
    "token_exchange_failed",
    "invalid_token_response",
    "unsupported_token_auth_method",
    "account_validation_failed",
    "transaction_replayed",
    "transaction_expired",
    "client_config_unavailable",
    "client_not_authorized",
    "device_authorization_failed",
    "device_code_expired",
    "oauth1_signature_failed",
    "session_capture_failed",
    "saml_assertion_failed",
    "unsupported_account_validation",
    "unsupported_injection",
    "ambiguous_credential",
    "credential_conflict",
    "credential_expired_reauth_required",
    "redirect_unavailable",
  ].includes(value);
}

function fail(message: string): never {
  throw new Error(message);
}

function parseJsonObject(
  text: string,
  opts: { strict?: boolean } = {}
): Record<string, unknown> | null {
  if (!text.trim()) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    if (!opts.strict) {
      return null;
    }
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (!opts.strict) {
      return null;
    }
    throw new Error("OAuth token exchange returned a non-object JSON response");
  }
  return parsed as Record<string, unknown>;
}

function formatOAuthTokenExchangeError(
  status: number,
  data: Record<string, unknown> | null,
  text: string
): string {
  const details: string[] = [];
  const providerError = data?.["error"];
  const providerDescription = data?.["error_description"];
  if (typeof providerError === "string" && providerError.trim()) {
    details.push(providerError.trim());
  }
  if (typeof providerDescription === "string" && providerDescription.trim()) {
    details.push(providerDescription.trim());
  }
  if (details.length) {
    return `OAuth token exchange failed: ${status} ${details.join(": ")}`;
  }
  const sanitizedText = sanitizeOAuthErrorText(text);
  return sanitizedText
    ? `OAuth token exchange failed: ${status}; response: ${sanitizedText}`
    : `OAuth token exchange failed: ${status}`;
}

function sanitizeOAuthErrorText(text: string): string {
  return text
    .replace(
      /("(?:access_token|refresh_token|id_token|client_secret)"\s*:\s*")[^"]*(")/gi,
      "$1[redacted]$2"
    )
    .replace(/((?:access_token|refresh_token|id_token|client_secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function readNumericField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
