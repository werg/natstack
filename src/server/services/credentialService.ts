import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as http from "node:http";
import { z } from "zod";
import type { EventService } from "@natstack/shared/eventsService";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import { buildPublicUrl } from "../publicUrl.js";
import type { AuditLog } from "../../../packages/shared/src/credentials/audit.js";
import { OAuthClientConfigStore, type OAuthClientConfigRecord } from "../../../packages/shared/src/credentials/oauthClientConfigStore.js";
import { CredentialStore } from "../../../packages/shared/src/credentials/store.js";
import type {
  AccountIdentity,
  AuditEntry,
  ConnectOAuthCredentialRequest,
  Credential,
  CredentialAuditEvent,
  CredentialBinding,
  CredentialBindingUse,
  CredentialGrantAction,
  CredentialGrantScope,
  CredentialUseGrant,
  DeleteOAuthClientConfigRequest,
  ForwardOAuthCallbackRequest,
  GetOAuthClientConfigStatusRequest,
  GrantUrlBoundCredentialRequest,
  OAuthClientConfigStatus,
  OAuthConnectionErrorCode,
  OAuthConnectionTransactionState,
  ProxyGitHttpRequest,
  ProxyGitHttpResponse,
  RequestCredentialInputRequest,
  RequestOAuthClientConfigRequest,
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
import type { ServiceContext } from "../../../packages/shared/src/serviceDispatcher.js";
import type { ServiceDefinition } from "../../../packages/shared/src/serviceDefinition.js";
import type { CodeIdentityResolver } from "./codeIdentityResolver.js";
import type { EgressProxy } from "./egressProxy.js";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import { OAuthCredentialLifecycle, OAuthLifecycleError } from "./oauthCredentialLifecycle.js";
import {
  CredentialSessionGrantStore,
  type CredentialSessionGrantResource,
  type CredentialSessionGrantScope,
} from "./credentialSessionGrants.js";

const IDENTIFIER_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/;
const identifierSchema = z
  .string()
  .regex(IDENTIFIER_REGEX, "Invalid identifier (must be a safe path component matching /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/)");
const PENDING_OAUTH_TTL_MS = 10 * 60 * 1000;
const OAUTH_USERINFO_TIMEOUT_MS = 15_000;
const DEFAULT_LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_CALLBACK_PATH = "/oauth/callback";
const RESERVED_OAUTH_AUTHORIZE_PARAMS = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
]);

const urlAudienceSchema = z.object({
  url: z.string().url(),
  match: z.enum(["origin", "path-prefix", "exact"]).optional(),
}).strict();

const credentialInjectionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("header"),
    name: z.string().min(1).max(128),
    valueTemplate: z.string().min(1).max(256),
    stripIncoming: z.array(z.string().min(1).max(128)).optional(),
  }).strict(),
  z.object({
    type: z.literal("query-param"),
    name: z.string().min(1).max(128),
  }).strict(),
  z.object({
    type: z.literal("basic-auth"),
    usernameTemplate: z.string().min(1).max(256),
    passwordTemplate: z.string().min(1).max(256),
    stripIncoming: z.array(z.string().min(1).max(128)).optional(),
  }).strict(),
]);

const credentialBindingSchema = z.object({
  id: identifierSchema,
  use: z.enum(["fetch", "git-http"]),
  audience: z.array(urlAudienceSchema).min(1).max(16),
  injection: credentialInjectionSchema,
}).strict();

const accountIdentitySchema = z.object({
  email: z.string().max(320).optional(),
  username: z.string().max(256).optional(),
  workspaceName: z.string().max(256).optional(),
  providerUserId: z.string().max(256).optional(),
}).strict();

const oauthAccountValidationSchema = z.object({
  userinfo: z.object({
    url: z.string().url(),
    idField: z.string().min(1).max(128).optional(),
    emailField: z.string().min(1).max(128).optional(),
    usernameField: z.string().min(1).max(128).optional(),
    workspaceField: z.string().min(1).max(128).optional(),
  }).strict().optional(),
}).strict();

const storeUrlBoundCredentialParamsSchema = z.object({
  label: z.string().min(1).max(256),
  audience: z.array(urlAudienceSchema).min(1).max(16),
  injection: credentialInjectionSchema,
  bindings: z.array(credentialBindingSchema).min(1).max(8).optional(),
  material: z.object({
    type: z.enum(["bearer-token", "api-key"]),
    token: z.string().min(1).max(65536),
  }).strict(),
  accountIdentity: accountIdentitySchema.optional(),
  scopes: z.array(z.string().max(256)).optional(),
  expiresAt: z.number().positive().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
}).strict();

const createOAuthPkceCredentialParamsSchema = z.object({
  oauth: z.object({
    authorizeUrl: z.string().url(),
    tokenUrl: z.string().url(),
    clientId: z.string().min(1).max(512),
    scopes: z.array(z.string().max(256)).optional(),
    extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
    allowMissingExpiry: z.boolean().optional(),
    persistRefreshToken: z.boolean().optional(),
    accountValidation: oauthAccountValidationSchema.optional(),
  }).strict(),
  credential: z.object({
    label: z.string().min(1).max(256),
    audience: z.array(urlAudienceSchema).min(1).max(16),
    injection: credentialInjectionSchema,
    bindings: z.array(credentialBindingSchema).min(1).max(8).optional(),
    accountIdentity: accountIdentitySchema.optional(),
    scopes: z.array(z.string().max(256)).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  }).strict(),
  redirectUri: z.string().url(),
}).strict();

const oauthClientConfigFieldSchema = z.object({
  name: identifierSchema,
  label: z.string().min(1).max(128),
  type: z.enum(["text", "secret"]),
  required: z.boolean().optional(),
  description: z.string().max(512).optional(),
}).strict();

const requestOAuthClientConfigParamsSchema = z.object({
  configId: identifierSchema,
  title: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
  authorizeUrl: z.string().url(),
  tokenUrl: z.string().url(),
  fields: z.array(oauthClientConfigFieldSchema).min(1).max(16),
}).strict();

const requestCredentialInputParamsSchema = z.object({
  title: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
  credential: z.object({
    label: z.string().min(1).max(256),
    audience: z.array(urlAudienceSchema).min(1).max(16),
    injection: credentialInjectionSchema,
    bindings: z.array(credentialBindingSchema).min(1).max(8).optional(),
    accountIdentity: accountIdentitySchema.optional(),
    scopes: z.array(z.string().max(256)).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  }).strict(),
  fields: z.array(oauthClientConfigFieldSchema).length(1),
  material: z.object({
    type: z.enum(["bearer-token", "api-key"]),
    tokenField: identifierSchema,
  }).strict(),
}).strict();

const getOAuthClientConfigStatusParamsSchema = z.object({
  configId: identifierSchema,
  fields: z.array(oauthClientConfigFieldSchema).max(16).optional(),
}).strict();

const oauthRedirectStrategySchema = z.object({
  type: z.enum(["loopback", "public", "client-forwarded"]).optional(),
  host: z.string().optional(),
  port: z.number().int().min(0).max(65535).optional(),
  callbackPath: z.string().optional(),
  callbackUri: z.string().url().optional(),
  fallback: z.literal("dynamic-port").optional(),
}).strict();

const connectOAuthCredentialSpecSchema = z.object({
  oauth: z.union([
    z.object({
      authorizeUrl: z.string().url(),
      tokenUrl: z.string().url(),
      clientId: z.string().min(1).max(512),
      scopes: z.array(z.string().max(256)).optional(),
      extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
      allowMissingExpiry: z.boolean().optional(),
      persistRefreshToken: z.boolean().optional(),
      accountValidation: oauthAccountValidationSchema.optional(),
    }).strict(),
    z.object({
      clientConfigId: identifierSchema,
      scopes: z.array(z.string().max(256)).optional(),
      extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
      allowMissingExpiry: z.boolean().optional(),
      persistRefreshToken: z.boolean().optional(),
      accountValidation: oauthAccountValidationSchema.optional(),
    }).strict(),
  ]),
  credential: createOAuthPkceCredentialParamsSchema.shape.credential,
  redirect: oauthRedirectStrategySchema.optional(),
  browser: z.enum(["external", "internal"]).optional(),
}).strict();

const oauthBrowserHandoffTargetSchema = z.object({
  callerId: z.string().min(1).max(512),
  callerKind: z.enum(["panel", "shell"]),
}).strict();

const connectOAuthCredentialParamsSchema = z.union([
  connectOAuthCredentialSpecSchema,
  z.object({
    spec: connectOAuthCredentialSpecSchema,
    handoffTarget: oauthBrowserHandoffTargetSchema,
  }).strict(),
]);

const deleteOAuthClientConfigParamsSchema = z.object({
  configId: identifierSchema,
}).strict();

const forwardOAuthCallbackParamsSchema = z.object({
  transactionId: identifierSchema.optional(),
  url: z.string().url().optional(),
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(4096).optional(),
}).strict();

const credentialIdParamsSchema = z.object({
  credentialId: identifierSchema,
}).strict();

const grantCredentialParamsSchema = z.object({
  credentialId: identifierSchema,
  callerId: identifierSchema,
  grantedBy: z.string().min(1).max(128).optional(),
}).strict();

const resolveCredentialParamsSchema = z.object({
  url: z.string().url(),
  credentialId: identifierSchema.optional(),
  use: z.enum(["fetch", "git-http"]).optional(),
}).strict();

const proxyFetchParamsSchema = z.object({
  url: z.string().url(),
  method: z.string().min(1).max(16),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  credentialId: identifierSchema.optional(),
}).strict();

const proxyGitHttpParamsSchema = z.object({
  url: z.string().url(),
  method: z.string().min(1).max(16).optional(),
  headers: z.record(z.string()).optional(),
  bodyBase64: z.string().optional(),
  credentialId: identifierSchema.optional(),
}).strict();

const auditParamsSchema = z.object({
  filter: z.object({
    providerId: z.string().optional(),
    connectionId: z.string().optional(),
    callerId: z.string().optional(),
    since: z.number().optional(),
  }).optional(),
  limit: z.number().int().positive().max(1000).optional(),
  after: z.number().optional(),
}).strict();

type StoreUrlBoundCredentialParams = z.infer<typeof storeUrlBoundCredentialParamsSchema>;
type RequestOAuthClientConfigParams = z.infer<typeof requestOAuthClientConfigParamsSchema>;
type RequestCredentialInputParams = z.infer<typeof requestCredentialInputParamsSchema>;
type GetOAuthClientConfigStatusParams = z.infer<typeof getOAuthClientConfigStatusParamsSchema>;
type ConnectOAuthCredentialParams = z.infer<typeof connectOAuthCredentialParamsSchema>;
type DeleteOAuthClientConfigParams = z.infer<typeof deleteOAuthClientConfigParamsSchema>;
type ForwardOAuthCallbackParams = z.infer<typeof forwardOAuthCallbackParamsSchema>;
type CredentialIdParams = z.infer<typeof credentialIdParamsSchema>;
type GrantCredentialParams = z.infer<typeof grantCredentialParamsSchema>;
type ResolveCredentialParams = z.infer<typeof resolveCredentialParamsSchema>;
type ProxyFetchParams = z.infer<typeof proxyFetchParamsSchema>;
type ProxyGitHttpParams = z.infer<typeof proxyGitHttpParamsSchema>;
type AuditParams = z.infer<typeof auditParamsSchema>;
type InternalOAuthConnectionRequest = {
  oauth: Extract<ConnectOAuthCredentialRequest["oauth"], { authorizeUrl: string }> & { clientSecret?: string };
  credential: ConnectOAuthCredentialRequest["credential"];
  redirectUri: string;
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

function validateOAuthClientConfigUrls(authorizeUrl: string, tokenUrl: string): void {
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
  validateOAuthClientConfigUrls(canonicalUrl(request.oauth.authorizeUrl), canonicalUrl(request.oauth.tokenUrl));
  const redirect = new URL(request.redirectUri);
  if (!((redirect.protocol === "http:" && isLoopbackHost(redirect.hostname)) || redirect.protocol === "https:")) {
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
  if (request.oauth.accountValidation?.userinfo?.url) {
    const userinfo = new URL(request.oauth.accountValidation.userinfo.url);
    if (userinfo.protocol !== "https:") {
      throw new Error("OAuth userinfo url must use https");
    }
    if (userinfo.hash) {
      throw new Error("OAuth userinfo url must not include a fragment");
    }
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") {
    return true;
  }
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return !!ipv4 && Number(ipv4[1]) === 127;
}

interface CredentialServiceDeps {
  credentialStore?: CredentialStore;
  oauthClientConfigStore?: OAuthClientConfigStore;
  auditLog?: AuditLog;
  eventService?: Pick<EventService, "emit" | "emitTo">;
  tokenManager?: Pick<TokenManager, "getPanelOwner">;
  egressProxy?: Pick<EgressProxy, "forwardProxyFetch" | "forwardGitHttp">;
  codeIdentityResolver?: Pick<CodeIdentityResolver, "resolveByCallerId">;
  approvalQueue?: ApprovalQueue;
  sessionGrantStore?: CredentialSessionGrantStore;
  oauthLifecycle?: OAuthCredentialLifecycle;
}

interface OAuthConnectionTransaction {
  id: string;
  state: OAuthConnectionTransactionState;
  createdAt: number;
  expiresAt: number;
  callerId: string;
  callerKind: ServiceContext["callerKind"];
  repoPath: string;
  effectiveVersion: string;
  stateParam: string;
  redirectUri: string;
  redirectStrategy: "loopback" | "public" | "client-forwarded";
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
  const oauthClientConfigStore = deps.oauthClientConfigStore ?? new OAuthClientConfigStore();
  const auditLog = deps.auditLog;
  const eventService = deps.eventService;
  const tokenManager = deps.tokenManager;
  const egressProxy = deps.egressProxy;
  const codeIdentityResolver = deps.codeIdentityResolver;
  const approvalQueue = deps.approvalQueue;
  const sessionGrantStore = deps.sessionGrantStore ?? new CredentialSessionGrantStore();
  const oauthLifecycle = deps.oauthLifecycle ?? new OAuthCredentialLifecycle({
    credentialStore,
    oauthClientConfigStore,
  });
  const oauthTransactions = new Map<string, OAuthConnectionTransaction>();

  function resolveBrowserHandoffTarget(
    ctx: ServiceContext,
    handoffTarget?: { callerId: string; callerKind: "panel" | "shell" },
  ): {
    deliveryCallerId: string;
    deliveryCallerKind: "shell";
    parentPanelId?: string;
  } | null {
    const targetCallerId = handoffTarget?.callerId ?? ctx.callerId;
    const targetCallerKind = handoffTarget?.callerKind ?? ctx.callerKind;
    if (targetCallerKind === "shell") {
      return { deliveryCallerId: targetCallerId, deliveryCallerKind: "shell" };
    }
    if (targetCallerKind === "panel") {
      const ownerCallerId = tokenManager?.getPanelOwner(targetCallerId) ?? (!tokenManager ? targetCallerId : undefined);
      if (!ownerCallerId) return null;
      return {
        deliveryCallerId: ownerCallerId,
        deliveryCallerKind: "shell",
        parentPanelId: targetCallerId,
      };
    }
    return null;
  }

  async function storeCredential(
    ctx: ServiceContext,
    params: StoreUrlBoundCredentialParams,
    opts: {
      approvalDecision?: Exclude<GrantedDecision, "deny">;
      preapprovedUseDecision?: Exclude<GrantedDecision, "deny">;
      replaceCredentialId?: string;
      replacementCredentialLabel?: string;
    } = {},
  ): Promise<StoredCredentialSummary> {
    const request = params as StoreUrlBoundCredentialRequest;
    const id = opts.replaceCredentialId ?? randomUUID();
    const audience = normalizeUrlAudiences(request.audience);
    const injection = normalizeCredentialInjection(request.injection);
    const bindings = normalizeCredentialBindings(request.bindings, { audience, injection });
    const identity = codeIdentityResolver?.resolveByCallerId(ctx.callerId) ?? null;
    const now = Date.now();
    const approvalIdentity = resolveApprovalIdentity(ctx);
    const approvalDecision = opts.approvalDecision ?? (await requestCredentialApproval(ctx, {
      credentialId: id,
      credentialLabel: request.label,
      audience,
      injection,
      accountIdentity: normalizeAccountIdentity(request.accountIdentity, ctx.callerId),
      scopes: request.scopes ?? [],
      identity: approvalIdentity,
      metadata: request.metadata,
      replacementCredentialLabel: opts.replacementCredentialLabel,
    }));
    const owner = {
      sourceId: identity?.repoPath ?? ctx.callerId,
      sourceKind: identity ? "workspace" as const : "user" as const,
      label: identity?.repoPath ?? ctx.callerId,
    };
    const accountIdentity = normalizeAccountIdentity(request.accountIdentity, ctx.callerId);
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
      applyPreapprovedCredentialUseGrants(ctx, credential as Credential & { id: string }, bindings, opts.preapprovedUseDecision, now);
    }

    await credentialStore.saveUrlBound(credential as Credential & { id: string });
    await appendAudit({
      type: opts.replaceCredentialId ? "connection_credential.replaced" : "connection_credential.created",
      ts: now,
      callerId: ctx.callerId,
      providerId: "url-bound",
      connectionId: id,
      storageKind: "connection-credential",
      fieldNames: ["credential"],
    });
    return summarizeUrlBoundCredential(credential);
  }

  function createOAuthAuthorizeRequest(
    request: InternalOAuthConnectionRequest,
    state: string,
  ): { state: string; authorizeUrl: string; codeVerifier: string } {
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const authorizeUrl = new URL(request.oauth.authorizeUrl);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", request.oauth.clientId);
    authorizeUrl.searchParams.set("redirect_uri", request.redirectUri);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);
    if (request.oauth.scopes?.length) {
      authorizeUrl.searchParams.set("scope", request.oauth.scopes.join(" "));
    }
    for (const [key, value] of Object.entries(request.oauth.extraAuthorizeParams ?? {})) {
      if (RESERVED_OAUTH_AUTHORIZE_PARAMS.has(key.toLowerCase())) {
        throw new Error(`OAuth extraAuthorizeParams cannot override ${key}`);
      }
      authorizeUrl.searchParams.set(key, value);
    }
    return { state, authorizeUrl: authorizeUrl.toString(), codeVerifier };
  }

  async function requestOAuthClientConfig(
    ctx: ServiceContext,
    params: RequestOAuthClientConfigParams,
  ): Promise<OAuthClientConfigStatus> {
    const request = params as RequestOAuthClientConfigRequest;
    if (!approvalQueue || (ctx.callerKind !== "panel" && ctx.callerKind !== "worker")) {
      throw new Error("OAuth client config approval is unavailable");
    }
    const authorizeUrl = canonicalUrl(request.authorizeUrl);
    const tokenUrl = canonicalUrl(request.tokenUrl);
    validateOAuthClientConfigUrls(authorizeUrl, tokenUrl);
    normalizeUrlAudiences([
      { url: authorizeUrl, match: "exact" },
      { url: tokenUrl, match: "exact" },
    ]);
    const identity = resolveApprovalIdentity(ctx);
    const result = await approvalQueue.requestOAuthClientConfig({
      kind: "oauth-client-config",
      callerId: ctx.callerId,
      callerKind: ctx.callerKind,
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
      throw new Error("OAuth client config approval denied");
    }

    const now = Date.now();
    const existing = await oauthClientConfigStore.load(request.configId);
    if (existing) {
      if (canonicalUrl(existing.authorizeUrl) !== authorizeUrl) {
        throw new Error("OAuth client config authorizeUrl is immutable for this configId");
      }
      if (canonicalUrl(existing.tokenUrl) !== tokenUrl) {
        throw new Error("OAuth client config tokenUrl is immutable for this configId");
      }
    }
    const fields = { ...(existing?.fields ?? {}) };
    for (const field of request.fields) {
      const value = result.values[field.name]?.trim() ?? "";
      if ((field.required ?? false) && !value) {
        throw new Error(`OAuth client config field is required: ${field.name}`);
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
    versions[version] = {
      version,
      authorizeUrl,
      tokenUrl,
      fields,
      createdAt: now,
    };
    const record = {
      configId: request.configId,
      currentVersion: version,
      owner: existing?.owner ?? {
        callerId: ctx.callerId,
        callerKind: ctx.callerKind,
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
      },
      authorizeUrl,
      tokenUrl,
      fields,
      versions,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await pruneOAuthClientConfigVersions(record);
    await oauthClientConfigStore.save(record);
    await appendAudit({
      type: "oauth_client_config.updated",
      ts: now,
      callerId: ctx.callerId,
      configId: request.configId,
      authorizeUrl,
      tokenUrl,
      fieldNames: request.fields.map((field) => field.name),
    });
    return oauthClientConfigStore.summarize(request.configId, record, request.fields);
  }

  async function getOAuthClientConfigStatus(
    ctx: ServiceContext,
    params: GetOAuthClientConfigStatusParams,
  ): Promise<OAuthClientConfigStatus> {
    const request = params as GetOAuthClientConfigStatusRequest;
    const record = await oauthClientConfigStore.load(request.configId);
    if (record?.owner && !isSameConfigTrustScope({ ...resolveApprovalIdentity(ctx), callerId: ctx.callerId }, record.owner)) {
      throw new OAuthConnectionError("client_not_authorized");
    }
    return oauthClientConfigStore.summarize(request.configId, record, request.fields);
  }

  async function deleteOAuthClientConfig(
    ctx: ServiceContext,
    params: DeleteOAuthClientConfigParams,
  ): Promise<void> {
    const request = params as DeleteOAuthClientConfigRequest;
    const existing = await oauthClientConfigStore.load(request.configId);
    if (existing?.owner && !isSameConfigTrustScope({ ...resolveApprovalIdentity(ctx), callerId: ctx.callerId }, existing.owner)) {
      throw new Error("OAuth client config deletion is not authorized for this caller");
    }
    if (existing && approvalQueue && (ctx.callerKind === "panel" || ctx.callerKind === "worker")) {
      const identity = resolveApprovalIdentity(ctx);
      const decision = await approvalQueue.request({
        kind: "capability",
        dedupKey: `delete-oauth-client-config:${request.configId}`,
        callerId: ctx.callerId,
        callerKind: ctx.callerKind,
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
        capability: "oauth-client-config-delete",
        title: "Disable service configuration",
        description: "Disable this OAuth client config for new connections and future refreshes.",
        resource: {
          type: "oauth-client-config",
          label: "Config",
          value: request.configId,
        },
        details: [
          { label: "Sign-in origin", value: new URL(existing.authorizeUrl).origin },
          { label: "Token origin", value: new URL(existing.tokenUrl).origin },
        ],
      });
      if (decision === "deny") {
        throw new Error("OAuth client config deletion denied");
      }
    }
    await oauthClientConfigStore.remove(request.configId);
    if (existing) {
      await appendAudit({
        type: "oauth_client_config.revoked",
        ts: Date.now(),
        callerId: ctx.callerId,
        configId: request.configId,
        authorizeUrl: existing.authorizeUrl,
        tokenUrl: existing.tokenUrl,
        fieldNames: Object.keys(existing.fields),
      });
    }
  }

  async function forwardOAuthCallback(
    ctx: ServiceContext,
    params: ForwardOAuthCallbackParams,
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
    if (tx.callerId !== ctx.callerId) {
      throw new OAuthConnectionError("client_not_authorized");
    }
    if (tx.redirectStrategy !== "client-forwarded") {
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
    params: RequestCredentialInputParams,
  ): Promise<StoredCredentialSummary> {
    const request = params as RequestCredentialInputRequest;
    if (!approvalQueue || (ctx.callerKind !== "panel" && ctx.callerKind !== "worker")) {
      throw new Error("Credential input approval is unavailable");
    }
    if (request.fields.length !== 1) {
      throw new Error("Credential input expects exactly one secret field");
    }
    const tokenField = request.fields[0]!;
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
    const accountIdentity = normalizeAccountIdentity(request.credential.accountIdentity, ctx.callerId);
    const identity = resolveApprovalIdentity(ctx);
    const result = await approvalQueue.requestCredentialInput({
      kind: "credential-input",
      callerId: ctx.callerId,
      callerKind: ctx.callerKind,
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

    return storeCredential(ctx, {
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
    }, { approvalDecision: "session" });
  }

  async function connectOAuth(
    ctx: ServiceContext,
    params: ConnectOAuthCredentialParams,
  ): Promise<StoredCredentialSummary> {
    const parsedParams = connectOAuthCredentialParamsSchema.parse(params);
    const { request, handoffTarget } = normalizeConnectOAuthInvocation(ctx, parsedParams);
    const redirect = request.redirect ?? {};
    const redirectStrategy = redirect.type ?? "loopback";
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
        });
        redirectUri = callback.redirectUri;
      } else if (redirectStrategy === "public") {
        transactionId = randomUUID();
        redirectUri = buildPublicUrl(`/_r/s/credentials/oauth/callback/${transactionId}`);
      } else if (redirectStrategy === "client-forwarded") {
        transactionId = randomUUID();
        redirectUri = redirect.callbackUri ?? buildPublicUrl(`/_r/s/credentials/oauth/callback/${transactionId}`);
      } else {
        throw new OAuthConnectionError("redirect_unavailable");
      }
      tx = await createOAuthTransaction(ctx, {
        id: transactionId,
        redirectUri,
        redirectStrategy,
        stateParam,
      });
      const oauthRequest = await resolveConnectOAuthRequest(request, redirectUri);
      validateOAuthCredentialRequest(oauthRequest);
      const identity = resolveApprovalIdentity(ctx);
      const audience = normalizeUrlAudiences(oauthRequest.credential.audience);
      const injection = normalizeCredentialInjection(oauthRequest.credential.injection);
      const metadata = {
        ...(oauthRequest.credential.metadata ?? {}),
        oauthAuthorizeOrigin: new URL(oauthRequest.oauth.authorizeUrl).origin,
        oauthTokenOrigin: new URL(oauthRequest.oauth.tokenUrl).origin,
        ...(oauthRequest.oauth.accountValidation?.userinfo?.url
          ? { oauthUserinfoOrigin: new URL(oauthRequest.oauth.accountValidation.userinfo.url).origin }
          : {}),
      };
      const approvalDecision = await requestCredentialApproval(ctx, {
        credentialId: randomUUID(),
        credentialLabel: oauthRequest.credential.label,
        audience,
        injection,
        accountIdentity: normalizeAccountIdentity(oauthRequest.credential.accountIdentity, ctx.callerId),
        scopes: oauthRequest.credential.scopes ?? oauthRequest.oauth.scopes ?? [],
        identity,
        metadata,
      });
      await transitionOAuthTransaction(tx, "approved");
      const started = createOAuthAuthorizeRequest(oauthRequest, stateParam);
      callback?.expectState(started.state);
      if (!eventService) {
        throw new OAuthConnectionError("browser_unavailable");
      }
      const openMode = request.browser ?? "external";
      const browserTarget = resolveBrowserHandoffTarget(ctx, handoffTarget);
      if (!browserTarget) {
        throw new OAuthConnectionError("browser_unavailable", "OAuth browser handoff target is not connected");
      }
      const openPayload = {
        url: started.authorizeUrl,
        callerId: ctx.callerId,
        callerKind: ctx.callerKind,
      };
      let browserDelivered = false;
      if (openMode === "internal") {
        if (!browserTarget.parentPanelId) {
          throw new OAuthConnectionError("browser_unavailable", "Internal OAuth handoff requires a panel target");
        }
        browserDelivered = eventService.emitTo(browserTarget.deliveryCallerId, "browser-panel:open", {
          url: started.authorizeUrl,
          parentPanelId: browserTarget.parentPanelId,
          callerId: ctx.callerId,
          callerKind: ctx.callerKind,
        });
      } else {
        browserDelivered = eventService.emitTo(browserTarget.deliveryCallerId, "external-open:open", openPayload);
      }
      if (!browserDelivered) {
        throw new OAuthConnectionError("browser_unavailable", "OAuth browser handoff target is not connected");
      }
      await transitionOAuthTransaction(tx, "browser_open_requested");
      if (callback) {
        const callbackResult = await callback.wait;
        await receiveOAuthCallback(tx, callbackResult);
      }
      const result = await tx.wait;
      await transitionOAuthTransaction(tx, "exchanging");
      const token = await exchangeOAuthCode(oauthRequest, result.code, started.codeVerifier);
      await transitionOAuthTransaction(tx, "validating_account");
      const validatedAccountIdentity = await validateOAuthAccountIdentity(oauthRequest, token.accessToken);
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
      const stored = await storeCredential(ctx, {
        label: oauthRequest.credential.label,
        audience: oauthRequest.credential.audience,
        injection: oauthRequest.credential.injection,
        bindings: oauthRequest.credential.bindings,
        material: { type: "bearer-token", token: token.accessToken },
        accountIdentity,
        scopes: oauthRequest.credential.scopes ?? oauthRequest.oauth.scopes ?? token.scopes ?? [],
        expiresAt: token.expiresAt,
        metadata: {
          ...(oauthRequest.credential.metadata ?? {}),
          ...(token.refreshToken ? { oauthRefreshTokenStored: "true" } : {}),
          oauthAuthorizeOrigin: new URL(oauthRequest.oauth.authorizeUrl).origin,
          oauthTokenOrigin: new URL(oauthRequest.oauth.tokenUrl).origin,
          ...(oauthRequest.oauth.accountValidation?.userinfo?.url
            ? { oauthUserinfoOrigin: new URL(oauthRequest.oauth.accountValidation.userinfo.url).origin }
            : {}),
          oauthScopes: (oauthRequest.oauth.scopes ?? []).join(" "),
        },
      }, {
        approvalDecision: duplicate ? undefined : approvalDecision,
        preapprovedUseDecision: approvalDecision,
        replaceCredentialId: duplicate?.id,
        replacementCredentialLabel: duplicate?.label ?? duplicate?.connectionLabel,
      });
      if (token.refreshToken) {
        const persisted = await credentialStore.loadUrlBound(stored.id);
        if (persisted?.id) {
          await credentialStore.saveUrlBound({ ...persisted, refreshToken: token.refreshToken } as Credential & { id: string });
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

  function normalizeConnectOAuthInvocation(
    ctx: ServiceContext,
    params: ConnectOAuthCredentialParams,
  ): {
    request: ConnectOAuthCredentialRequest;
    handoffTarget?: { callerId: string; callerKind: "panel" | "shell" };
  } {
    if ("spec" in params) {
      if (ctx.callerKind === "panel") {
        throw new OAuthConnectionError(
          "client_not_authorized",
          "Panel callers cannot specify an OAuth browser handoff target",
        );
      }
      return {
        request: params.spec as ConnectOAuthCredentialRequest,
        handoffTarget: params.handoffTarget,
      };
    }
    return { request: params as ConnectOAuthCredentialRequest };
  }

  async function resolveConnectOAuthRequest(
    request: ConnectOAuthCredentialRequest,
    redirectUri: string,
  ): Promise<InternalOAuthConnectionRequest> {
    if ("clientConfigId" in request.oauth) {
      const config = await oauthClientConfigStore.load(request.oauth.clientConfigId);
      if (!config) {
        throw new Error("client_not_authorized");
      }
      const clientId = config.fields["clientId"]?.value;
      const clientSecret = config.fields["clientSecret"]?.value;
      if (!clientId) {
        throw new Error("client_not_authorized");
      }
      return {
        oauth: {
          authorizeUrl: canonicalUrl(config.authorizeUrl),
          tokenUrl: canonicalUrl(config.tokenUrl),
          clientId,
          ...(clientSecret ? { clientSecret } : {}),
          scopes: request.oauth.scopes,
          extraAuthorizeParams: request.oauth.extraAuthorizeParams,
          allowMissingExpiry: request.oauth.allowMissingExpiry,
          persistRefreshToken: request.oauth.persistRefreshToken,
          accountValidation: request.oauth.accountValidation,
        },
        credential: {
          ...request.credential,
          metadata: {
            ...(request.credential.metadata ?? {}),
            oauthClientConfigId: request.oauth.clientConfigId,
            oauthClientConfigVersion: config.currentVersion ?? String(config.updatedAt),
          },
        },
        redirectUri,
      };
    }
    return {
      oauth: request.oauth,
      credential: request.credential,
      redirectUri,
    };
  }

  async function exchangeOAuthCode(
    request: InternalOAuthConnectionRequest,
    code: string,
    codeVerifier: string,
  ): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number; scopes?: string[] }> {
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("code_verifier", codeVerifier);
    body.set("client_id", request.oauth.clientId);
    if (request.oauth.clientSecret) {
      body.set("client_secret", request.oauth.clientSecret);
    }
    body.set("redirect_uri", request.redirectUri);

    const tokenResponse = await fetch(request.oauth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const tokenText = await tokenResponse.text();
    const tokenData = parseJsonObject(tokenText, { strict: tokenResponse.ok });
    if (!tokenResponse.ok) {
      throw oauthConnectionError("token_exchange_failed", formatOAuthTokenExchangeError(tokenResponse.status, tokenData, tokenText));
    }
    if (typeof tokenData?.["error"] === "string") {
      throw oauthConnectionError("token_exchange_failed", `OAuth token exchange failed: ${tokenData["error"]}`);
    }

    const accessToken = tokenData?.["access_token"];
    const tokenType = tokenData?.["token_type"];
    if (typeof accessToken !== "string") {
      throw oauthConnectionError("invalid_token_response", "OAuth token exchange did not return an access_token");
    }
    if (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer") {
      throw oauthConnectionError("invalid_token_response", "OAuth token exchange did not return bearer token_type");
    }
    const expiresIn = readNumericField(tokenData?.["expires_in"]);
    if (expiresIn === undefined && !request.oauth.allowMissingExpiry) {
      throw oauthConnectionError("invalid_token_response", "OAuth token exchange did not return expires_in");
    }
    const refreshToken = tokenData?.["refresh_token"];
    const scope = tokenData?.["scope"];
    return {
      accessToken,
      ...(request.oauth.persistRefreshToken && typeof refreshToken === "string" && refreshToken.length > 0 ? { refreshToken } : {}),
      ...(typeof expiresIn === "number" ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
      ...(typeof scope === "string" && scope.trim() ? { scopes: scope.trim().split(/\s+/) } : {}),
    };
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
    await credentialStore.saveUrlBound({
      ...credential,
      id: credential.id ?? params.credentialId,
      revokedAt: Date.now(),
    } as Credential & { id: string });
  }

  async function grantCredential(ctx: ServiceContext, params: GrantCredentialParams): Promise<StoredCredentialSummary> {
    requireShellOrServer(ctx, "grantCredential");
    const request = params as GrantUrlBoundCredentialRequest;
    void request.callerId;
    void request.grantedBy;
    throw new Error("credentials.grantCredential was replaced by scoped approval grants");
  }

  async function resolveCredential(
    ctx: ServiceContext,
    params: ResolveCredentialParams,
  ): Promise<StoredCredentialSummary | null> {
    const request = params as ResolveUrlBoundCredentialRequest;
    const use = request.use ?? "fetch";
    if (request.credentialId) {
      const credential = await loadActiveCredential(request.credentialId);
      const usage = credentialUseContext(credential, new URL(request.url), use);
      if (!usage) {
        throw new Error("Credential audience does not match requested URL");
      }
      await authorizeCredentialUse(ctx, credential, usage);
      return summarizeUrlBoundCredential(credential);
    }

    const credential = await resolveCredentialForUrl(ctx, new URL(request.url), use);
    return credential ? summarizeUrlBoundCredential(credential) : null;
  }

  async function proxyFetch(
    ctx: ServiceContext,
    params: ProxyFetchParams,
  ): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }> {
    if (!egressProxy) {
      throw new Error("Egress proxy is unavailable");
    }
    return egressProxy.forwardProxyFetch({
      callerId: ctx.callerId,
      url: params.url,
      method: params.method,
      headers: params.headers,
      body: params.body,
      credentialId: params.credentialId,
    });
  }

  async function proxyGitHttp(
    ctx: ServiceContext,
    params: ProxyGitHttpParams,
  ): Promise<ProxyGitHttpResponse> {
    if (!egressProxy) {
      throw new Error("Egress proxy is unavailable");
    }
    const request = params as ProxyGitHttpRequest;
    const result = await egressProxy.forwardGitHttp({
      callerId: ctx.callerId,
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
    const entries = await auditLog?.query({ filter: params.filter, limit: params.limit, after: params.after }) ?? [];
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
    },
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
      callerId: ctx.callerId,
      callerKind: ctx.callerKind,
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      stateParam: params.stateParam,
      redirectUri: params.redirectUri,
      redirectStrategy: params.redirectStrategy,
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
    errorCode?: OAuthConnectionErrorCode,
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
    callback: { code?: string | null; state?: string | null; error?: string | null; url: string },
  ): Promise<void> {
    if (
      tx.callbackUsed
      || tx.state === "callback_received"
      || tx.state === "exchanging"
      || tx.state === "completed"
      || tx.state === "failed"
      || tx.state === "cancelled"
      || tx.state === "expired"
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

  function findOAuthTransactionByState(state: string | undefined): OAuthConnectionTransaction | undefined {
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
    if (credential.expiresAt && credential.expiresAt <= Date.now() + 30_000 && credential.refreshToken) {
      credential = await oauthLifecycle.refreshOAuthCredential(credential as Credential & { id: string });
    }
    return credential as Credential & { id: string };
  }

  function resolveApprovalIdentity(ctx: ServiceContext): { repoPath: string; effectiveVersion: string } {
    const identity = codeIdentityResolver?.resolveByCallerId(ctx.callerId);
    return {
      repoPath: identity?.repoPath ?? ctx.callerId,
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
    },
  ): Promise<Exclude<GrantedDecision, "deny">> {
    if (!approvalQueue || (ctx.callerKind !== "panel" && ctx.callerKind !== "worker")) {
      return "session";
    }
    const oauthAuthorizeOrigin = params.metadata?.["oauthAuthorizeOrigin"];
    const oauthTokenOrigin = params.metadata?.["oauthTokenOrigin"];
    const oauthUserinfoOrigin = params.metadata?.["oauthUserinfoOrigin"];
    const decision = await approvalQueue.request({
      callerId: ctx.callerId,
      callerKind: ctx.callerKind,
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

  async function resolveCredentialForUrl(
    ctx: ServiceContext,
    targetUrl: URL,
    use: CredentialBindingUse = "fetch",
  ): Promise<Credential | null> {
    const credentials = (await credentialStore.listUrlBound()).filter((credential) =>
      !credential.revokedAt
      && !!findCredentialBinding(credential, targetUrl, use)
    );
    if (credentials.length === 1) {
      const credential = credentials[0] ?? null;
      if (credential) {
        const active = credential.id ? await loadActiveCredential(credential.id) : credential;
        const usage = credentialUseContext(active, targetUrl, use);
        if (!usage) {
          throw new Error("Credential audience does not match requested URL");
        }
        await authorizeCredentialUse(ctx, active, usage);
        return active;
      }
      return credential;
    }
    if (credentials.length > 1) {
      throw new Error("Multiple credentials match requested URL; choose an explicit credential");
    }
    return null;
  }

  async function findReplacementCandidate(
    ctx: ServiceContext,
    candidate: {
      label: string;
      audience: UrlAudience[];
      metadata?: Record<string, string>;
      accountIdentity: Partial<AccountIdentity>;
    },
  ): Promise<(Credential & { id: string }) | null> {
    const account = normalizeAccountIdentity(candidate.accountIdentity, ctx.callerId);
    if (!account.providerUserId || account.providerUserId === ctx.callerId) {
      return null;
    }
    const identity = codeIdentityResolver?.resolveByCallerId(ctx.callerId) ?? null;
    const ownerSourceId = identity?.repoPath ?? ctx.callerId;
    const providerKey = candidate.metadata?.["providerId"]
      ?? candidate.metadata?.["modelProviderId"]
      ?? candidate.label;
    const audienceKey = normalizedAudienceKey(candidate.audience);
    const existing = await credentialStore.listUrlBound();
    return existing.find((credential): credential is Credential & { id: string } =>
      !!credential.id
      && !credential.revokedAt
      && credential.owner?.sourceId === ownerSourceId
      && credential.accountIdentity?.providerUserId === account.providerUserId
      && (credential.metadata?.["providerId"] ?? credential.metadata?.["modelProviderId"] ?? credential.label) === providerKey
      && normalizedAudienceKey(summarizeUrlBoundCredential(credential).audience) === audienceKey
    ) ?? null;
  }

  async function pruneOAuthClientConfigVersions(record: OAuthClientConfigRecord): Promise<void> {
    if (!record.versions) return;
    const keep = new Set<string>();
    if (record.currentVersion) keep.add(record.currentVersion);
    const credentials = await credentialStore.listUrlBound();
    for (const credential of credentials) {
      if (credential.metadata?.["oauthClientConfigId"] === record.configId) {
        const version = credential.metadata["oauthClientConfigVersion"];
        if (version) keep.add(version);
      }
    }
    record.versions = Object.fromEntries(
      Object.entries(record.versions).filter(([version]) => keep.has(version)),
    );
  }

  async function authorizeCredentialUse(
    ctx: ServiceContext,
    credential: Credential,
    usage: CredentialUseContext,
  ): Promise<void> {
    if (canCallerUseStoredCredential(ctx, credential, usage)) {
      return;
    }
    if (!approvalQueue || (ctx.callerKind !== "panel" && ctx.callerKind !== "worker")) {
      throw new Error("Credential caller is not granted");
    }
    if (!credential.id) {
      throw new Error("Credential is missing URL-bound metadata");
    }
    const identity = resolveApprovalIdentity(ctx);
    const decision = await approvalQueue.request({
      callerId: ctx.callerId,
      callerKind: ctx.callerKind,
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
    if (decision === "once") {
      return;
    }
    const now = Date.now();
    if (decision === "session") {
      grantSessionCredentialUse(credential.id, identity, usage.sessionResource);
      return;
    }
    await credentialStore.saveUrlBound({
      ...credential,
      grants: upsertCredentialUseGrant(
        credential.grants ?? [],
        grantForDecision(ctx.callerId, identity, decision, now, usage),
      ),
      metadata: {
        ...(credential.metadata ?? {}),
        updatedAt: String(now),
      },
    } as Credential & { id: string });
  }

  function canCallerSeeStoredCredential(ctx: ServiceContext, credential: Credential): boolean {
    if (ctx.callerKind === "shell" || ctx.callerKind === "server") {
      return true;
    }
    const identity = codeIdentityResolver?.resolveByCallerId(ctx.callerId);
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
    usage: CredentialUseContext,
  ): boolean {
    if (ctx.callerKind === "shell" || ctx.callerKind === "server") {
      return true;
    }
    return hasPersistentCredentialUse(ctx, credential, usage)
      || hasSessionCredentialUse(ctx, credential, usage);
  }

  function canCallerAdministerStoredCredential(ctx: ServiceContext, credential: Credential): boolean {
    if (ctx.callerKind === "shell" || ctx.callerKind === "server") {
      return true;
    }
    return canCallerSeeStoredCredential(ctx, credential);
  }

  function grantSessionCredentialUse(
    credentialId: string,
    identity: CredentialSessionGrantScope,
    resource: CredentialSessionGrantResource,
  ): void {
    sessionGrantStore.grant(credentialId, identity, resource);
  }

  function applyPreapprovedCredentialUseGrants(
    ctx: ServiceContext,
    credential: Credential & { id: string },
    bindings: CredentialBinding[],
    decision: Exclude<GrantedDecision, "deny">,
    now: number,
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
      (grants, usage) => upsertCredentialUseGrant(
        grants,
        grantForDecision(ctx.callerId, identity, decision, now, usage),
      ),
      credential.grants ?? [],
    );
  }

  function hasSessionCredentialUse(
    ctx: ServiceContext,
    credential: Credential,
    usage: CredentialUseContext,
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
    usage: CredentialUseContext,
  ): boolean {
    const identity = resolveApprovalIdentity(ctx);
    return !!credential.grants?.some((grant) =>
      grant.bindingId === usage.binding.id
      && grant.use === usage.binding.use
      && grant.resource === usage.resource
      && grant.action === usage.action
      && grantAppliesToIdentity(grant, identity)
    );
  }

  const definition: ServiceDefinition = {
    name: "credentials",
    description: "URL-bound userland credential storage and egress",
    policy: { allowed: ["shell", "panel", "server", "worker"] },
    methods: {
      storeCredential: { args: z.tuple([storeUrlBoundCredentialParamsSchema]) },
      connectOAuth: { args: z.tuple([connectOAuthCredentialParamsSchema]) },
      configureOAuthClient: { args: z.tuple([requestOAuthClientConfigParamsSchema]) },
      requestCredentialInput: { args: z.tuple([requestCredentialInputParamsSchema]) },
      getOAuthClientConfigStatus: { args: z.tuple([getOAuthClientConfigStatusParamsSchema]) },
      deleteOAuthClientConfig: { args: z.tuple([deleteOAuthClientConfigParamsSchema]) },
      forwardOAuthCallback: { args: z.tuple([forwardOAuthCallbackParamsSchema]) },
      listStoredCredentials: { args: z.tuple([]) },
      revokeCredential: { args: z.tuple([credentialIdParamsSchema]) },
      grantCredential: { args: z.tuple([grantCredentialParamsSchema]) },
      resolveCredential: { args: z.tuple([resolveCredentialParamsSchema]) },
      proxyFetch: { args: z.tuple([proxyFetchParamsSchema]) },
      proxyGitHttp: { args: z.tuple([proxyGitHttpParamsSchema]) },
      audit: { args: z.tuple([auditParamsSchema]) },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "storeCredential":
          return storeCredential(ctx, (args as [StoreUrlBoundCredentialParams])[0]);
        case "connectOAuth":
          return connectOAuth(ctx, (args as [ConnectOAuthCredentialParams])[0]);
        case "configureOAuthClient":
          return requestOAuthClientConfig(ctx, (args as [RequestOAuthClientConfigParams])[0]);
        case "requestCredentialInput":
          return requestCredentialInput(ctx, (args as [RequestCredentialInputParams])[0]);
        case "getOAuthClientConfigStatus":
          return getOAuthClientConfigStatus(ctx, (args as [GetOAuthClientConfigStatusParams])[0]);
        case "deleteOAuthClientConfig":
          return deleteOAuthClientConfig(ctx, (args as [DeleteOAuthClientConfigParams])[0]);
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

  const routes: ServiceRouteDecl[] = [{
    serviceName: "credentials",
    path: "/oauth/callback/:transactionId",
    methods: ["GET"],
    auth: "public",
    handler: async (req, res, routeParams) => {
      const tx = oauthTransactions.get(routeParams["transactionId"] ?? "");
      if (!tx) {
        respondOAuthCallback(res, 400, "No matching OAuth connection is waiting for this callback.");
        return;
      }
      const url = new URL(req.url ?? "/", tx.redirectUri);
      const providerError = url.searchParams.get("error");
      await receiveOAuthCallback(tx, {
        code: url.searchParams.get("code"),
        state: url.searchParams.get("state"),
        error: providerError,
        url: url.toString(),
      });
      if (tx.state === "failed" || tx.state === "expired" || tx.state === "cancelled") {
        respondOAuthCallback(res, providerError ? 400 : 400, providerError
          ? "The provider denied the connection."
          : "OAuth callback could not be validated.");
      } else if (providerError) {
        respondOAuthCallback(res, 400, "The provider denied the connection.");
      } else if (!url.searchParams.get("code")) {
        respondOAuthCallback(res, 400, "Missing authorization code.");
      } else {
        respondOAuthCallback(res, 200, "Connection complete. You can close this window.");
      }
    },
  }];

  return Object.assign(definition, { routes });
}

function normalizeAccountIdentity(input: Partial<AccountIdentity> | undefined, callerId: string): AccountIdentity {
  return {
    providerUserId: input?.providerUserId ?? input?.email ?? input?.username ?? callerId,
    ...(input?.email ? { email: input.email } : {}),
    ...(input?.username ? { username: input.username } : {}),
    ...(input?.workspaceName ? { workspaceName: input.workspaceName } : {}),
  };
}

function isSameConfigTrustScope(
  identity: { repoPath: string; effectiveVersion: string; callerId: string },
  owner: { repoPath: string; effectiveVersion: string; callerId: string },
): boolean {
  return identity.repoPath === owner.repoPath
    && (identity.effectiveVersion === owner.effectiveVersion || identity.callerId === owner.callerId);
}

function deriveAccountIdentityFromJwt(
  accessToken: string,
  metadata: Record<string, string> | undefined,
): Partial<AccountIdentity> {
  const root = metadata?.["oauthAccountIdentityJwtClaimRoot"];
  const field = metadata?.["oauthAccountIdentityJwtClaimField"];
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
  return typeof providerUserId === "string" && providerUserId.length > 0
    ? { providerUserId }
    : {};
}

async function validateOAuthAccountIdentity(
  request: InternalOAuthConnectionRequest,
  accessToken: string,
): Promise<Partial<AccountIdentity>> {
  const spec = request.oauth.accountValidation?.userinfo;
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
      throw new OAuthConnectionError("account_validation_failed", "OAuth account validation timed out");
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
  const workspaceName = spec.workspaceField ? readStringClaim(data, spec.workspaceField) : undefined;
  if (idValue) identity.providerUserId = idValue;
  if (email) identity.email = email;
  if (username) identity.username = username;
  if (workspaceName) identity.workspaceName = workspaceName;
  if (!identity.providerUserId && (identity.email || identity.username)) {
    identity.providerUserId = identity.email ?? identity.username;
  }
  if (!identity.providerUserId) {
    throw new OAuthConnectionError("account_validation_failed", "OAuth account validation did not return an account identity");
  }
  return identity;
}

function readStringClaim(data: Record<string, unknown>, path: string | undefined): string | undefined {
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
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
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
  fallback: { audience: UrlAudience[]; injection: CredentialBinding["injection"] },
): CredentialBinding[] {
  if (!fallback.audience || !fallback.injection) {
    throw new Error("Credential fallback binding is missing URL-bound metadata");
  }
  const rawBindings = bindings?.length
    ? bindings
    : [{ id: "fetch", use: "fetch" as const, audience: fallback.audience, injection: fallback.injection }];
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
  use: CredentialBindingUse,
): CredentialBinding | null {
  return credentialBindings(credential).find((binding) =>
    binding.use === use && !!findMatchingUrlAudience(targetUrl, binding.audience)
  ) ?? null;
}

function credentialUseContext(
  credential: Credential,
  targetUrl: URL,
  use: CredentialBindingUse,
): CredentialUseContext | null {
  const binding = findCredentialBinding(credential, targetUrl, use);
  if (!binding) {
    return null;
  }
  const resource = binding.use === "git-http"
    ? gitRemoteFromUrl(targetUrl)
    : findMatchingUrlAudience(targetUrl, binding.audience)?.url ?? targetUrl.origin;
  const gitOperation = binding.use === "git-http" ? describeGitHttpOperation(targetUrl, "GET") : undefined;
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
    const action: CredentialGrantAction = binding.use === "git-http" ? "read" : "use";
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

function describeGitHttpOperation(targetUrl: URL, method: string): CredentialUseContext["gitOperation"] {
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

function requireShellOrServer(ctx: ServiceContext, method: string): void {
  if (ctx.callerKind !== "shell" && ctx.callerKind !== "server") {
    throw new Error(`credentials.${method} is restricted to shell/server callers`);
  }
}

function grantForDecision(
  callerId: string,
  identity: { repoPath: string; effectiveVersion: string },
  decision: Exclude<GrantedDecision, "deny" | "once" | "session">,
  grantedAt: number,
  usage: CredentialUseContext,
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

function grantAppliesToIdentity(
  grant: CredentialUseGrant,
  identity: { callerId?: string; repoPath: string; effectiveVersion: string },
): boolean {
  if (grant.scope === "caller") {
    return !!identity.callerId && grant.callerId === identity.callerId;
  }
  if (grant.scope === "repo") {
    return grant.repoPath === identity.repoPath;
  }
  return grant.repoPath === identity.repoPath && grant.effectiveVersion === identity.effectiveVersion;
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
}): Promise<HostOAuthCallback> {
  try {
    return await bindLoopbackOAuthCallback(opts.host, opts.port, normalizeCallbackPath(opts.callbackPath));
  } catch (error) {
    if (
      opts.port > 0
      && opts.allowDynamicPortFallback
      && error instanceof Error
      && /address in use|EADDRINUSE|already in use/i.test(error.message)
    ) {
      return bindLoopbackOAuthCallback(opts.host, 0, normalizeCallbackPath(opts.callbackPath));
    }
    if (error instanceof Error && /address in use|EADDRINUSE|already in use/i.test(error.message)) {
      throw new Error("redirect_unavailable");
    }
    throw error;
  }
}

async function bindLoopbackOAuthCallback(host: string, port: number, callbackPath: string): Promise<HostOAuthCallback> {
  let expectedState: string | undefined;
  let settled = false;
  let redirectUri = "";
  let resolve!: (value: { code?: string; state: string; url: string; error?: string }) => void;
  let reject!: (error: Error) => void;
  const wait = new Promise<{ code?: string; state: string; url: string; error?: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
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
    const code = url.searchParams.get("code");
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
  const address = server.address();
  if (!address || typeof address === "string") {
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
  wait.finally(() => {
    clearTimeout(timer);
    server.close();
  }).catch(() => undefined);
  return {
    redirectUri,
    wait,
    expectState(state: string) {
      expectedState = state;
    },
    close() {
      clearTimeout(timer);
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

function isExpectedRedirectCallback(
  tx: { redirectUri: string },
  callbackUrl: string,
): boolean {
  try {
    const expected = new URL(tx.redirectUri);
    const actual = new URL(callbackUrl);
    return actual.protocol === expected.protocol
      && actual.host === expected.host
      && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function errorCodeForOAuthError(error: unknown): OAuthConnectionErrorCode {
  if (error instanceof OAuthConnectionError) {
    return error.code;
  }
  if (error instanceof OAuthLifecycleError) {
    return error.code;
  }
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  if (typeof code === "string" && isOAuthConnectionErrorCode(code)) {
    return code;
  }
  return "token_exchange_failed";
}

function oauthConnectionError(code: OAuthConnectionErrorCode, message: string): Error & { code: OAuthConnectionErrorCode } {
  return Object.assign(new Error(message), { code });
}

function isOAuthConnectionErrorCode(value: string): value is OAuthConnectionErrorCode {
  return [
    "approval_denied",
    "browser_unavailable",
    "callback_timeout",
    "state_mismatch",
    "redirect_mismatch",
    "token_exchange_failed",
    "invalid_token_response",
    "account_validation_failed",
    "transaction_replayed",
    "transaction_expired",
    "client_not_authorized",
    "redirect_unavailable",
  ].includes(value);
}

function fail(message: string): never {
  throw new Error(message);
}

function parseJsonObject(text: string, opts: { strict?: boolean } = {}): Record<string, unknown> | null {
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
  text: string,
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
    .replace(/("(?:access_token|refresh_token|id_token|client_secret)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
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
