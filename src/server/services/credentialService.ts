import { createHash, createHmac, createPublicKey, createSign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import * as http from "node:http";
import { z } from "zod";
import type { EventService } from "@natstack/shared/eventsService";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import { buildPublicUrl } from "../publicUrl.js";
import type { AuditLog } from "../../../packages/shared/src/credentials/audit.js";
import { ClientConfigStore, type ClientConfigRecord } from "../../../packages/shared/src/credentials/clientConfigStore.js";
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
  CredentialGrantScope,
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
import type { ServiceContext } from "../../../packages/shared/src/serviceDispatcher.js";
import type { ServiceDefinition } from "../../../packages/shared/src/serviceDefinition.js";
import type { CodeIdentityResolver } from "./codeIdentityResolver.js";
import type { EgressProxy } from "./egressProxy.js";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import { CredentialLifecycle, CredentialLifecycleError } from "./credentialLifecycle.js";
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
  z.object({
    type: z.literal("oauth1-signature"),
  }).strict(),
  z.object({
    type: z.literal("cookie"),
  }).strict(),
  z.object({
    type: z.literal("aws-sigv4"),
    service: identifierSchema,
    region: identifierSchema,
  }).strict(),
  z.object({
    type: z.literal("ssh-key"),
  }).strict(),
]);

const credentialBindingSchema = z.object({
  id: identifierSchema,
  use: z.enum(["fetch", "git-http", "git-ssh"]),
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
    type: z.enum(["bearer-token", "api-key", "oauth1-token", "cookie-session", "saml-session", "aws-sigv4", "ssh-key"]),
    token: z.string().min(1).max(65536),
  }).strict(),
  accountIdentity: accountIdentitySchema.optional(),
  scopes: z.array(z.string().max(256)).optional(),
  expiresAt: z.number().positive().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
}).strict();

const connectCredentialDetailsSchema = z.object({
  label: z.string().min(1).max(256),
  audience: z.array(urlAudienceSchema).min(1).max(16),
  injection: credentialInjectionSchema,
  bindings: z.array(credentialBindingSchema).min(1).max(8).optional(),
  accountIdentity: accountIdentitySchema.optional(),
  scopes: z.array(z.string().max(256)).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
}).strict();

const clientConfigFieldSchema = z.object({
  name: identifierSchema,
  label: z.string().min(1).max(128),
  type: z.enum(["text", "secret"]),
  required: z.boolean().optional(),
  description: z.string().max(512).optional(),
}).strict();

const requestClientConfigParamsSchema = z.object({
  configId: identifierSchema,
  title: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
  authorizeUrl: z.string().url(),
  tokenUrl: z.string().url(),
  fields: z.array(clientConfigFieldSchema).min(1).max(16),
}).strict();

const credentialFlowTypeSchema = z.enum([
  "oauth2-auth-code-pkce",
  "oauth2-auth-code",
  "oauth2-device-code",
  "oauth2-client-credentials",
  "oauth1a",
  "api-key",
  "aws-sigv4",
  "ssh-key",
  "oauth2-jwt-bearer",
  "oauth2-token-exchange",
  "browser-cookie-session",
  "saml-browser-session",
]);

const configureClientParamsSchema = requestClientConfigParamsSchema.extend({
  flowTypes: z.array(credentialFlowTypeSchema).min(1).max(8).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  allowRefreshWhenDisabled: z.boolean().optional(),
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
  fields: z.array(clientConfigFieldSchema).length(1),
  material: z.object({
    type: z.enum(["bearer-token", "api-key"]),
    tokenField: identifierSchema,
  }).strict(),
}).strict();

const getClientConfigStatusParamsSchema = z.object({
  configId: identifierSchema,
  fields: z.array(clientConfigFieldSchema).max(16).optional(),
}).strict();

const oauthRedirectStrategySchema = z.object({
  type: z.enum(["loopback", "public", "client-forwarded"]).optional(),
  host: z.string().optional(),
  port: z.number().int().min(0).max(65535).optional(),
  callbackPath: z.string().optional(),
  callbackUri: z.string().url().optional(),
  fallback: z.literal("dynamic-port").optional(),
}).strict();

const tokenAuthSchema = z.enum(["none", "client_secret_post", "client_secret_basic", "private_key_jwt"]);

const browserHandoffTargetSchema = z.object({
  callerId: z.string().min(1).max(512),
  callerKind: z.enum(["panel", "shell"]),
}).strict();

const connectCredentialSpecSchema = z.object({
  flow: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("oauth2-auth-code-pkce"),
      authorizeUrl: z.string().url().optional(),
      tokenUrl: z.string().url().optional(),
      clientId: z.string().min(1).max(512).optional(),
      clientConfigId: identifierSchema.optional(),
      scopes: z.array(z.string().max(256)).optional(),
      extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
      tokenAuth: tokenAuthSchema.optional(),
      persistRefreshToken: z.boolean().optional(),
      allowMissingExpiry: z.boolean().optional(),
      accountValidation: oauthAccountValidationSchema.optional(),
      revocationUrl: z.string().url().optional(),
    }).strict(),
    z.object({
      type: z.literal("oauth2-auth-code"),
      authorizeUrl: z.string().url().optional(),
      tokenUrl: z.string().url().optional(),
      clientId: z.string().min(1).max(512).optional(),
      clientConfigId: identifierSchema.optional(),
      scopes: z.array(z.string().max(256)).optional(),
      extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
      tokenAuth: tokenAuthSchema.optional(),
      persistRefreshToken: z.boolean().optional(),
      accountValidation: oauthAccountValidationSchema.optional(),
      revocationUrl: z.string().url().optional(),
      pkce: z.literal(false),
      compatibilityReason: z.string().min(1).max(1024),
      requiresConfidentialClient: z.boolean().optional(),
    }).strict(),
    z.object({
      type: z.literal("oauth2-device-code"),
      deviceAuthorizationUrl: z.string().url(),
      tokenUrl: z.string().url(),
      clientId: z.string().min(1).max(512).optional(),
      clientConfigId: identifierSchema.optional(),
      scopes: z.array(z.string().max(256)).optional(),
      tokenAuth: tokenAuthSchema.optional(),
      pollIntervalSeconds: z.number().int().positive().optional(),
      expiresInSeconds: z.number().int().positive().optional(),
      accountValidation: oauthAccountValidationSchema.optional(),
      persistRefreshToken: z.boolean().optional(),
      revocationUrl: z.string().url().optional(),
    }).strict(),
    z.object({
      type: z.literal("oauth2-client-credentials"),
      tokenUrl: z.string().url(),
      clientConfigId: identifierSchema,
      tokenAuth: z.enum(["client_secret_post", "client_secret_basic", "private_key_jwt"]),
      scopes: z.array(z.string().max(256)).optional(),
      audienceParam: z.string().max(512).optional(),
      resourceParam: z.string().max(512).optional(),
      accountValidation: oauthAccountValidationSchema.optional(),
      revocationUrl: z.string().url().optional(),
    }).strict(),
    z.object({
      type: z.literal("oauth2-jwt-bearer"),
      tokenUrl: z.string().url(),
      clientConfigId: identifierSchema,
      issuer: z.string().min(1).max(512).optional(),
      subject: z.string().min(1).max(512).optional(),
      audience: z.string().min(1).max(2048).optional(),
      scopes: z.array(z.string().max(256)).optional(),
      accountValidation: oauthAccountValidationSchema.optional(),
      persistRefreshToken: z.boolean().optional(),
      revocationUrl: z.string().url().optional(),
    }).strict(),
    z.object({
      type: z.literal("oauth2-token-exchange"),
      tokenUrl: z.string().url(),
      clientConfigId: identifierSchema,
      subjectCredentialId: identifierSchema,
      subjectTokenType: z.enum(["access_token", "jwt"]).optional(),
      requestedTokenType: z.string().min(1).max(512).optional(),
      scopes: z.array(z.string().max(256)).optional(),
      audience: z.string().min(1).max(2048).optional(),
      resource: z.string().min(1).max(2048).optional(),
      tokenAuth: z.enum(["client_secret_post", "client_secret_basic", "private_key_jwt"]).optional(),
      accountValidation: oauthAccountValidationSchema.optional(),
      persistRefreshToken: z.boolean().optional(),
      revocationUrl: z.string().url().optional(),
    }).strict(),
    z.object({
      type: z.literal("oauth1a"),
      requestTokenUrl: z.string().url(),
      authorizeUrl: z.string().url(),
      accessTokenUrl: z.string().url(),
      clientConfigId: identifierSchema,
      callbackConfirmedParam: z.string().max(128).optional(),
      signatureMethod: z.literal("HMAC-SHA1").optional(),
      accountValidation: z.enum(["none", "http-probe"]).optional(),
    }).strict(),
    z.object({
      type: z.literal("api-key"),
      title: z.string().min(1).max(256).optional(),
      description: z.string().max(1024).optional(),
      fields: z.array(clientConfigFieldSchema).min(1).max(16),
      materialTemplate: z.object({
        type: z.enum(["bearer-token", "api-key"]),
        valueTemplate: z.string().min(1).max(4096),
      }).strict(),
      accountValidation: z.enum(["http-probe", "none"]).optional(),
    }).strict(),
    z.object({
      type: z.literal("aws-sigv4"),
      title: z.string().min(1).max(256).optional(),
      description: z.string().max(1024).optional(),
      accountValidation: z.enum(["http-probe", "none"]).optional(),
    }).strict(),
    z.object({
      type: z.literal("ssh-key"),
      mode: z.enum(["generate", "import"]).optional(),
      algorithm: z.literal("ed25519").optional(),
      title: z.string().min(1).max(256).optional(),
      description: z.string().max(1024).optional(),
      accountValidation: z.literal("none").optional(),
    }).strict(),
    z.object({
      type: z.literal("browser-cookie-session"),
      signInUrl: z.string().url(),
      capture: z.object({
        cookies: z.array(z.string().min(1).max(256)).min(1).max(64),
        origins: z.array(z.string().url()).min(1).max(16),
      }).strict(),
      completionUrlPattern: z.string().max(1024).optional(),
      accountValidation: z.enum(["http-probe", "none"]).optional(),
      maxTtlSeconds: z.number().int().positive().optional(),
    }).strict(),
    z.object({
      type: z.literal("saml-browser-session"),
      signInUrl: z.string().url(),
      spAudience: z.string().min(1).max(2048),
      capture: z.object({
        cookies: z.array(z.string().min(1).max(256)).min(1).max(64).optional(),
        assertion: z.object({
          issuer: z.string().min(1).max(2048),
          audience: z.string().min(1).max(2048),
          recipient: z.string().min(1).max(2048),
          persistAssertion: z.boolean().optional(),
        }).strict().optional(),
      }).strict(),
      completionUrlPattern: z.string().max(1024).optional(),
      maxTtlSeconds: z.number().int().positive().optional(),
      accountValidation: z.enum(["saml-assertion-claims", "http-probe", "none"]).optional(),
    }).strict(),
  ]),
  credential: connectCredentialDetailsSchema,
  redirect: oauthRedirectStrategySchema.optional(),
  browser: z.enum(["external", "internal"]).optional(),
}).strict();

const connectCredentialParamsSchema = z.union([
  connectCredentialSpecSchema,
  z.object({
    spec: connectCredentialSpecSchema,
    handoffTarget: browserHandoffTargetSchema,
  }).strict(),
]);

const deleteClientConfigParamsSchema = z.object({
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
  use: z.enum(["fetch", "git-http", "git-ssh"]).optional(),
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
type RequestClientConfigParams = z.infer<typeof requestClientConfigParamsSchema>;
type ConfigureClientParams = z.infer<typeof configureClientParamsSchema>;
type RequestCredentialInputParams = z.infer<typeof requestCredentialInputParamsSchema>;
type GetClientConfigStatusParams = z.infer<typeof getClientConfigStatusParamsSchema>;
type ConnectCredentialParams = z.infer<typeof connectCredentialParamsSchema>;
type DeleteClientConfigParams = z.infer<typeof deleteClientConfigParamsSchema>;
type ForwardOAuthCallbackParams = z.infer<typeof forwardOAuthCallbackParamsSchema>;
type CredentialIdParams = z.infer<typeof credentialIdParamsSchema>;
type GrantCredentialParams = z.infer<typeof grantCredentialParamsSchema>;
type ResolveCredentialParams = z.infer<typeof resolveCredentialParamsSchema>;
type ProxyFetchParams = z.infer<typeof proxyFetchParamsSchema>;
type ProxyGitHttpParams = z.infer<typeof proxyGitHttpParamsSchema>;
type AuditParams = z.infer<typeof auditParamsSchema>;
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
  tokenAuth: "none" | "client_secret_post" | "client_secret_basic" | "private_key_jwt";
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
  validateClientConfigUrls(canonicalUrl(request.flow.authorizeUrl), canonicalUrl(request.flow.tokenUrl));
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
  clientConfigStore?: ClientConfigStore;
  auditLog?: AuditLog;
  eventService?: Pick<EventService, "emit" | "emitTo">;
  tokenManager?: Pick<TokenManager, "getPanelOwner">;
  egressProxy?: Pick<EgressProxy, "forwardProxyFetch" | "forwardGitHttp">;
  codeIdentityResolver?: Pick<CodeIdentityResolver, "resolveByCallerId">;
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
  const clientConfigStore = deps.clientConfigStore ?? new ClientConfigStore();
  const auditLog = deps.auditLog;
  const eventService = deps.eventService;
  const tokenManager = deps.tokenManager;
  const egressProxy = deps.egressProxy;
  const codeIdentityResolver = deps.codeIdentityResolver;
  const approvalQueue = deps.approvalQueue;
  const sessionGrantStore = deps.sessionGrantStore ?? new CredentialSessionGrantStore();
  const sessionCredentialCapture = deps.sessionCredentialCapture;
  const credentialLifecycle = deps.credentialLifecycle ?? new CredentialLifecycle({
    credentialStore,
    clientConfigStore,
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
  ): { state: string; authorizeUrl: string; codeVerifier?: string } {
    const codeVerifier = request.pkce ? randomBytes(32).toString("base64url") : undefined;
    const codeChallenge = codeVerifier ? createHash("sha256").update(codeVerifier).digest("base64url") : undefined;
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
    params: RequestClientConfigParams,
  ): Promise<ClientConfigStatus> {
    const request = params as ConfigureClientRequest;
    if (!approvalQueue || (ctx.callerKind !== "panel" && ctx.callerKind !== "worker")) {
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
        callerId: ctx.callerId,
        callerKind: ctx.callerKind,
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
      callerId: ctx.callerId,
      configId: request.configId,
      authorizeUrl,
      tokenUrl,
      fieldNames: request.fields.map((field) => field.name),
    });
    return clientConfigStore.summarize(request.configId, record, request.fields);
  }

  async function configureClient(
    ctx: ServiceContext,
    params: ConfigureClientParams,
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
    params: GetClientConfigStatusParams,
  ): Promise<ClientConfigStatus> {
    const request = params as GetClientConfigStatusRequest;
    const record = await clientConfigStore.load(request.configId);
    if (record?.owner && !isSameConfigTrustScope({ ...resolveApprovalIdentity(ctx), callerId: ctx.callerId }, record.owner)) {
      throw new OAuthConnectionError("client_not_authorized");
    }
    return clientConfigStore.summarize(request.configId, record, request.fields);
  }

  async function deleteClientConfig(
    ctx: ServiceContext,
    params: DeleteClientConfigParams,
  ): Promise<void> {
    const request = params as DeleteClientConfigRequest;
    const existing = await clientConfigStore.load(request.configId);
    if (!existing) return;
    if (existing.owner && !isSameConfigTrustScope({ ...resolveApprovalIdentity(ctx), callerId: ctx.callerId }, existing.owner)) {
      throw new Error("Client config deletion is not authorized for this caller");
    }
    if (approvalQueue && (ctx.callerKind === "panel" || ctx.callerKind === "worker")) {
      const identity = resolveApprovalIdentity(ctx);
      const decision = await approvalQueue.request({
        kind: "capability",
        dedupKey: `delete-client-config:${request.configId}`,
        callerId: ctx.callerId,
        callerKind: ctx.callerKind,
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

  async function connectCredential(
    ctx: ServiceContext,
    params: ConnectCredentialParams,
  ): Promise<StoredCredentialSummary> {
    const parsedParams = connectCredentialParamsSchema.parse(params);
    const { request, handoffTarget } = normalizeConnectInvocation(ctx, parsedParams);
      switch (request.flow.type) {
      case "oauth2-auth-code-pkce":
        return connectOAuth2AuthCode(ctx, normalizePkceConnectRequest(request), handoffTarget);
      case "oauth2-auth-code":
        return connectOAuth2AuthCode(ctx, normalizeAuthCodeConnectRequest(request), handoffTarget);
      case "oauth2-device-code":
        return connectOAuthDeviceCode(ctx, request);
      case "oauth2-client-credentials":
        return connectOAuthClientCredentials(ctx, request);
      case "oauth2-jwt-bearer":
        return connectOAuthJwtBearer(ctx, request);
      case "oauth2-token-exchange":
        return connectOAuthTokenExchange(ctx, request);
      case "oauth1a":
        return connectOAuth1a(ctx, request, handoffTarget);
      case "aws-sigv4":
        return connectAwsSigV4(ctx, request);
      case "ssh-key":
        return connectSshKey(ctx, request);
      case "browser-cookie-session":
        return connectBrowserCookieSession(ctx, request);
      case "saml-browser-session":
        return connectSamlBrowserSession(ctx, request);
      case "api-key":
        return connectApiKey(ctx, request);
      default:
        throw new OAuthConnectionError("unsupported_flow");
    }
  }

  function normalizeConnectInvocation(
    ctx: ServiceContext,
    params: ConnectCredentialParams,
  ): {
    request: ConnectCredentialRequest;
    handoffTarget?: { callerId: string; callerKind: "panel" | "shell" };
  } {
    if ("spec" in params) {
      if (ctx.callerKind === "panel") {
        throw new OAuthConnectionError(
          "client_not_authorized",
          "Panel callers cannot specify a credential browser handoff target",
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
        tokenAuth: flow.tokenAuth ?? "none",
      };
    }
    if (flow.tokenAuth && flow.tokenAuth !== "none") {
      throw new OAuthConnectionError("unsupported_token_auth_method");
    }
    if (!flow.authorizeUrl || !flow.tokenUrl || !flow.clientId) {
      throw new OAuthConnectionError(
        "invalid_connection_spec",
        "oauth2-auth-code-pkce requires authorizeUrl, tokenUrl, and clientId or a clientConfigId",
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

  function normalizeAuthCodeConnectRequest(request: ConnectCredentialRequest): AuthCodeConnectRequest {
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
        tokenAuth: flow.tokenAuth ?? "client_secret_post",
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
    request: ConnectCredentialRequest,
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "api-key") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (!approvalQueue || (ctx.callerKind !== "panel" && ctx.callerKind !== "worker")) {
      throw new Error("Credential input approval is unavailable");
    }
    for (const field of request.flow.fields) {
      if (field.type !== "secret" || field.required !== true) {
        throw new OAuthConnectionError(
          "invalid_connection_spec",
          "api-key fields must be required secret fields",
        );
      }
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const accountIdentity = normalizeAccountIdentity(request.credential.accountIdentity, ctx.callerId);
    const identity = resolveApprovalIdentity(ctx);
    validateApiKeyMaterialTemplate(request.flow.materialTemplate.valueTemplate, request.flow.fields.map((field) => field.name));
    const result = await approvalQueue.requestCredentialInput({
      kind: "credential-input",
      callerId: ctx.callerId,
      callerKind: ctx.callerKind,
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
    const material = renderApiKeyMaterialTemplate(request.flow.materialTemplate.valueTemplate, result.values);
    if (!material) {
      throw new OAuthConnectionError("invalid_connection_spec", "api-key material template produced empty material");
    }
    return storeCredential(ctx, {
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
    }, { approvalDecision: "session" });
  }

  async function connectAwsSigV4(
    ctx: ServiceContext,
    request: ConnectCredentialRequest,
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "aws-sigv4") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (request.credential.injection.type !== "aws-sigv4") {
      throw new OAuthConnectionError("unsupported_injection");
    }
    if (!approvalQueue || (ctx.callerKind !== "panel" && ctx.callerKind !== "worker")) {
      throw new Error("Credential input approval is unavailable");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const accountIdentity = normalizeAccountIdentity(request.credential.accountIdentity, ctx.callerId);
    const identity = resolveApprovalIdentity(ctx);
    const fields = [
      { name: "accessKeyId", label: "Access key ID", type: "secret" as const, required: true },
      { name: "secretAccessKey", label: "Secret access key", type: "secret" as const, required: true },
      { name: "sessionToken", label: "Session token", type: "secret" as const, required: false },
    ];
    const result = await approvalQueue.requestCredentialInput({
      kind: "credential-input",
      callerId: ctx.callerId,
      callerKind: ctx.callerKind,
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
      throw new OAuthConnectionError("invalid_connection_spec", "AWS SigV4 credentials require access key ID and secret access key");
    }
    const stored = await storeCredential(ctx, {
      label: request.credential.label,
      audience,
      injection,
      bindings: request.credential.bindings,
      material: { type: "aws-sigv4", token: accessKeyId },
      accountIdentity: request.credential.accountIdentity ?? { providerUserId: `aws:${accessKeyId}` },
      scopes: request.credential.scopes ?? [],
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: "aws-sigv4",
        awsAccessKeyId: accessKeyId,
        awsService: request.credential.injection.service,
        awsRegion: request.credential.injection.region,
      },
    }, { approvalDecision: "session" });
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
    request: ConnectCredentialRequest,
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "ssh-key") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    const bindings = request.credential.bindings;
    if (!bindings?.length || bindings.some((binding) => binding.use !== "git-ssh")) {
      throw new OAuthConnectionError("invalid_connection_spec", "ssh-key credentials require explicit git-ssh bindings");
    }
    if (request.credential.injection.type !== "ssh-key") {
      throw new OAuthConnectionError("unsupported_injection");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const identity = resolveApprovalIdentity(ctx);
    const approvalAccount = normalizeAccountIdentity(request.credential.accountIdentity, ctx.callerId);
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
      if (!approvalQueue || (ctx.callerKind !== "panel" && ctx.callerKind !== "worker")) {
        throw new Error("Credential input approval is unavailable");
      }
      const result = await approvalQueue.requestCredentialInput({
        kind: "credential-input",
        callerId: ctx.callerId,
        callerKind: ctx.callerKind,
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
        title: request.flow.title ?? request.credential.label,
        description: request.flow.description,
        credentialLabel: request.credential.label,
        audience,
        injection,
        accountIdentity: approvalAccount,
        scopes: request.credential.scopes ?? [],
        fields: [
          { name: "privateKey", label: "SSH private key", type: "secret", required: true },
        ],
      });
      if (result.decision !== "submit") {
        throw new OAuthConnectionError("approval_denied");
      }
      privateKey = result.values["privateKey"]?.trim() ?? "";
      if (!privateKey) {
        throw new OAuthConnectionError("invalid_connection_spec", "SSH private key is required");
      }
      publicKey = openSshEd25519PublicKey(createPublicKey(privateKey).export({ type: "spki", format: "der" }));
    }
    const fingerprint = sshPublicKeyFingerprint(publicKey);
    const stored = await storeCredential(ctx, {
      label: request.credential.label,
      audience,
      injection,
      bindings,
      material: { type: "ssh-key", token: publicKey },
      accountIdentity: request.credential.accountIdentity ?? { providerUserId: `ssh:${fingerprint}` },
      scopes: request.credential.scopes ?? [],
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: "ssh-key",
        sshAlgorithm: "ed25519",
        sshPublicKeyFingerprint: fingerprint,
        sshPublicKey: publicKey,
      },
    }, {
      approvalDecision,
      preapprovedUseDecision: approvalDecision,
    });
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
    request: ConnectCredentialRequest,
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "oauth2-client-credentials") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    const config = await loadClientConfigForFlow(request.flow.clientConfigId, "oauth2-client-credentials");
    const clientId = config.fields["clientId"]?.value;
    const clientSecret = config.fields["clientSecret"]?.value;
    const privateKeyPem = config.fields["privateKeyPem"]?.value;
    if (!clientId || (request.flow.tokenAuth === "private_key_jwt" ? !privateKeyPem : !clientSecret)) {
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
      accountIdentity: normalizeAccountIdentity(request.credential.accountIdentity, request.flow.clientConfigId),
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
    return storeCredential(ctx, {
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
    }, {
      approvalDecision,
      preapprovedUseDecision: approvalDecision,
    });
  }

  async function connectOAuthJwtBearer(
    ctx: ServiceContext,
    request: ConnectCredentialRequest,
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
      accountIdentity: normalizeAccountIdentity(request.credential.accountIdentity, request.flow.subject ?? clientId),
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
    const stored = await storeCredential(ctx, {
      label: request.credential.label,
      audience,
      injection,
      bindings: request.credential.bindings,
      material: { type: "bearer-token", token: token.accessToken },
      accountIdentity: request.credential.accountIdentity ?? { providerUserId: request.flow.subject ?? clientId },
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
    }, { approvalDecision, preapprovedUseDecision: approvalDecision });
    if (token.refreshToken) {
      const persisted = await credentialStore.loadUrlBound(stored.id);
      if (persisted?.id) {
        await credentialStore.saveUrlBound({ ...persisted, refreshToken: token.refreshToken } as Credential & { id: string });
      }
    }
    return stored;
  }

  async function connectOAuthTokenExchange(
    ctx: ServiceContext,
    request: ConnectCredentialRequest,
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "oauth2-token-exchange") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    const config = await loadClientConfigForFlow(request.flow.clientConfigId, "oauth2-token-exchange");
    const clientId = config.fields["clientId"]?.value;
    const tokenAuth = request.flow.tokenAuth ?? (config.fields["privateKeyPem"]?.value ? "private_key_jwt" : "client_secret_post");
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
      throw new OAuthConnectionError("client_not_authorized", "Subject credential has no usable binding");
    }
    const subjectUsage = credentialUseContext(subject, new URL(subjectAudience), subjectBinding.use);
    if (!subjectUsage) {
      throw new OAuthConnectionError("client_not_authorized", "Subject credential binding cannot be authorized");
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
      accountIdentity: subject.accountIdentity ?? normalizeAccountIdentity(request.credential.accountIdentity, ctx.callerId),
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
    const stored = await storeCredential(ctx, {
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
    }, { approvalDecision, preapprovedUseDecision: approvalDecision });
    if (token.refreshToken) {
      const persisted = await credentialStore.loadUrlBound(stored.id);
      if (persisted?.id) {
        await credentialStore.saveUrlBound({ ...persisted, refreshToken: token.refreshToken } as Credential & { id: string });
      }
    }
    return stored;
  }

  async function connectBrowserCookieSession(
    ctx: ServiceContext,
    request: ConnectCredentialRequest,
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "browser-cookie-session") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (request.credential.injection.type !== "cookie") {
      throw new OAuthConnectionError("unsupported_injection");
    }
    if (!sessionCredentialCapture) {
      throw new OAuthConnectionError("browser_unavailable", "Session credential capture is unavailable on this platform");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const identity = resolveApprovalIdentity(ctx);
    const approvalDecision = await requestCredentialApproval(ctx, {
      credentialId: randomUUID(),
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity: normalizeAccountIdentity(request.credential.accountIdentity, ctx.callerId),
      scopes: request.credential.scopes ?? [],
      identity,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: request.flow.type,
        sessionSignInOrigin: new URL(request.flow.signInUrl).origin,
        capturedCookieNames: request.flow.capture.cookies.join(","),
      },
    });
    const captured = await sessionCredentialCapture.captureCookies({
      signInUrl: request.flow.signInUrl,
      origins: request.flow.capture.origins,
      cookieNames: request.flow.capture.cookies,
      completionUrlPattern: request.flow.completionUrlPattern,
      maxTtlSeconds: request.flow.maxTtlSeconds,
      browser: request.browser ?? "internal",
    });
    if (!captured.cookieHeader) {
      throw new OAuthConnectionError("session_capture_failed");
    }
    const stored = await storeCredential(ctx, {
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
    }, {
      approvalDecision,
      preapprovedUseDecision: approvalDecision,
    });
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
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "saml-browser-session") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (request.credential.injection.type !== "cookie") {
      throw new OAuthConnectionError("unsupported_injection");
    }
    if (!sessionCredentialCapture?.captureSamlSession) {
      throw new OAuthConnectionError("browser_unavailable", "SAML session capture is unavailable on this platform");
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
      accountIdentity: normalizeAccountIdentity(request.credential.accountIdentity, ctx.callerId),
      scopes: request.credential.scopes ?? [],
      identity,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: request.flow.type,
        sessionSignInOrigin: new URL(request.flow.signInUrl).origin,
        spAudience: request.flow.spAudience,
        capturedCookieNames: request.flow.capture.cookies?.join(",") ?? "",
      },
    });
    const captured = await sessionCredentialCapture.captureSamlSession({
      signInUrl: request.flow.signInUrl,
      spAudience: request.flow.spAudience,
      cookieNames: request.flow.capture.cookies,
      assertion: request.flow.capture.assertion,
      completionUrlPattern: request.flow.completionUrlPattern,
      maxTtlSeconds: request.flow.maxTtlSeconds,
      browser: request.browser ?? "internal",
    });
    if (!captured.cookieHeader && !captured.assertion) {
      throw new OAuthConnectionError("saml_assertion_failed");
    }
    const material = captured.cookieHeader ?? captured.assertion ?? "";
    const stored = await storeCredential(ctx, {
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
    }, {
      approvalDecision,
      preapprovedUseDecision: approvalDecision,
    });
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
  ): Promise<StoredCredentialSummary> {
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
    if (tokenAuth !== "none" && (tokenAuth === "private_key_jwt" ? !privateKeyPem : !clientSecret)) {
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
      accountIdentity: normalizeAccountIdentity(request.credential.accountIdentity, ctx.callerId),
      scopes: request.credential.scopes ?? request.flow.scopes ?? [],
      identity,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: request.flow.type,
        oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
      },
    });
    const device = await requestDeviceAuthorization({
      deviceAuthorizationUrl: request.flow.deviceAuthorizationUrl,
      clientId,
      clientSecret,
      privateKeyPem,
      keyId: config?.fields["keyId"]?.value,
      keyAlgorithm: config?.fields["algorithm"]?.value,
      tokenAuth,
      scopes: request.flow.scopes,
    });
    const verificationUrl = device.verificationUriComplete ?? device.verificationUri;
    if (!eventService || !verificationUrl) {
      throw new OAuthConnectionError("browser_unavailable");
    }
    const browserTarget = resolveBrowserHandoffTarget(ctx);
    if (!browserTarget || !eventService.emitTo(browserTarget.deliveryCallerId, "external-open:open", {
      url: verificationUrl,
      callerId: ctx.callerId,
      callerKind: ctx.callerKind,
    })) {
      throw new OAuthConnectionError("browser_unavailable");
    }
    const token = await pollDeviceToken({
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
    });
    const stored = await storeCredential(ctx, {
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
    }, {
      approvalDecision,
      preapprovedUseDecision: approvalDecision,
    });
    if (token.refreshToken) {
      const persisted = await credentialStore.loadUrlBound(stored.id);
      if (persisted?.id) {
        await credentialStore.saveUrlBound({ ...persisted, refreshToken: token.refreshToken } as Credential & { id: string });
      }
    }
    return stored;
  }

  async function connectOAuth1a(
    ctx: ServiceContext,
    request: ConnectCredentialRequest,
    handoffTarget?: { callerId: string; callerKind: "panel" | "shell" },
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "oauth1a") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (request.credential.injection.type !== "oauth1-signature") {
      throw new OAuthConnectionError("unsupported_injection");
    }
    const config = await loadClientConfigForFlow(request.flow.clientConfigId, "oauth1a");
    const consumerKey = config.fields["consumerKey"]?.value ?? config.fields["clientId"]?.value;
    const consumerSecret = config.fields["consumerSecret"]?.value ?? config.fields["clientSecret"]?.value;
    if (!consumerKey || !consumerSecret) {
      throw new OAuthConnectionError("client_config_unavailable");
    }
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
        accountIdentity: normalizeAccountIdentity(request.credential.accountIdentity, ctx.callerId),
        scopes: request.credential.scopes ?? [],
        identity,
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: request.flow.type,
          oauthAuthorizeOrigin: new URL(request.flow.authorizeUrl).origin,
        },
      });
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
      if (!browserTarget || !eventService.emitTo(browserTarget.deliveryCallerId, "external-open:open", {
        url: authorizeUrl.toString(),
        callerId: ctx.callerId,
        callerKind: ctx.callerKind,
      })) {
        throw new OAuthConnectionError("browser_unavailable");
      }
      await transitionOAuthTransaction(tx, "handoff_requested");
      if (callback) {
        const callbackResult = await callback.wait;
        await receiveOAuthCallback(tx, callbackResult);
      }
      const result = await tx.wait;
      await transitionOAuthTransaction(tx, "exchanging");
      const access = await exchangeOAuth1AccessToken({
        accessTokenUrl: request.flow.accessTokenUrl,
        consumerKey,
        consumerSecret,
        requestToken: requestToken.token,
        requestTokenSecret: requestToken.secret,
        verifier: result.code,
      });
      const stored = await storeCredential(ctx, {
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
      }, {
        approvalDecision,
        preapprovedUseDecision: approvalDecision,
      });
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
    explicitHandoffTarget?: { callerId: string; callerKind: "panel" | "shell" },
  ): Promise<StoredCredentialSummary> {
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
          ? { oauthUserinfoOrigin: new URL(oauthRequest.flow.accountValidation.userinfo.url).origin }
          : {}),
      };
      const approvalDecision = await requestCredentialApproval(ctx, {
        credentialId: randomUUID(),
        credentialLabel: oauthRequest.credential.label,
        audience,
        injection,
        accountIdentity: normalizeAccountIdentity(oauthRequest.credential.accountIdentity, ctx.callerId),
        scopes: oauthRequest.credential.scopes ?? oauthRequest.flow.scopes ?? [],
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
      const browserTarget = resolveBrowserHandoffTarget(ctx, explicitHandoffTarget);
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
        scopes: oauthRequest.credential.scopes ?? oauthRequest.flow.scopes ?? token.scopes ?? [],
        expiresAt: token.expiresAt,
        metadata: {
          ...(oauthRequest.credential.metadata ?? {}),
          ...(token.refreshToken ? { oauthRefreshTokenStored: "true" } : {}),
          oauthTokenAuth: oauthRequest.tokenAuth,
          oauthAuthorizeOrigin: new URL(oauthRequest.flow.authorizeUrl).origin,
          oauthTokenOrigin: new URL(oauthRequest.flow.tokenUrl).origin,
          ...(oauthRequest.flow.revocationUrl ? { oauthRevocationUrl: oauthRequest.flow.revocationUrl } : {}),
          ...(oauthRequest.flow.accountValidation?.userinfo?.url
            ? { oauthUserinfoOrigin: new URL(oauthRequest.flow.accountValidation.userinfo.url).origin }
            : {}),
          oauthScopes: (oauthRequest.flow.scopes ?? []).join(" "),
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

  async function resolveAuthCodeConnectionRequest(
    request: AuthCodeConnectRequest,
    redirectUri: string,
  ): Promise<InternalOAuthConnectionRequest> {
    if (request.flow.clientConfigId) {
      const config = await loadClientConfigForFlow(request.flow.clientConfigId, request.pkce ? "oauth2-auth-code-pkce" : "oauth2-auth-code");
      const clientId = config.fields["clientId"]?.value;
      const clientSecret = config.fields["clientSecret"]?.value;
      const privateKeyPem = config.fields["privateKeyPem"]?.value;
      const keyId = config.fields["keyId"]?.value;
      const keyAlgorithm = config.fields["algorithm"]?.value;
      if (!clientId) {
        throw new OAuthConnectionError("client_config_unavailable");
      }
      if (request.tokenAuth !== "none" && !clientSecret) {
        if (request.tokenAuth === "private_key_jwt" && privateKeyPem) {
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
            tokenAuth: request.tokenAuth,
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
        tokenAuth: request.tokenAuth,
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
    flowType: CredentialFlowType,
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
    codeVerifier: string | undefined,
  ): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number; scopes?: string[] }> {
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
      throw oauthConnectionError("token_exchange_failed", formatOAuthTokenExchangeError(tokenResponse.status, tokenData, tokenText));
    }
    if (typeof tokenData?.["error"] === "string") {
      throw oauthConnectionError("token_exchange_failed", `OAuth token exchange failed: ${tokenData["error"]}`);
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
      throw oauthConnectionError("token_exchange_failed", formatOAuthTokenExchangeError(response.status, data, text));
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
  }): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number; scopes?: string[] }> {
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
      throw oauthConnectionError("token_exchange_failed", formatOAuthTokenExchangeError(response.status, data, text));
    }
    return parseBearerTokenResponse(data, { allowMissingExpiry: false, persistRefreshToken: params.persistRefreshToken });
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
  }): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number; scopes?: string[] }> {
    const body = new URLSearchParams();
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange");
    body.set("subject_token", params.subjectToken);
    body.set(
      "subject_token_type",
      params.subjectTokenType === "jwt"
        ? "urn:ietf:params:oauth:token-type:jwt"
        : "urn:ietf:params:oauth:token-type:access_token",
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
      throw oauthConnectionError("token_exchange_failed", formatOAuthTokenExchangeError(response.status, data, text));
    }
    return parseBearerTokenResponse(data, { allowMissingExpiry: false, persistRefreshToken: params.persistRefreshToken });
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
    const response = await fetch(params.deviceAuthorizationUrl, { method: "POST", headers, body });
    const text = await response.text();
    const data = parseJsonObject(text, { strict: response.ok });
    if (!response.ok || typeof data?.["error"] === "string") {
      throw oauthConnectionError("device_authorization_failed", formatOAuthTokenExchangeError(response.status, data, text));
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
  }): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number; scopes?: string[] }> {
    let intervalMs = Math.max(1, params.intervalSeconds) * 1000;
    const deadline = Date.now() + Math.max(1, params.expiresInSeconds) * 1000;
    while (Date.now() < deadline) {
      await delay(intervalMs);
      const body = new URLSearchParams();
      body.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
      body.set("device_code", params.deviceCode);
      body.set("client_id", params.clientId);
      applyOAuthClientAssertion(body, params);
      if (params.clientSecret && params.tokenAuth === "client_secret_post") {
        body.set("client_secret", params.clientSecret);
      }
      const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
      if (params.clientSecret && params.tokenAuth === "client_secret_basic") {
        headers["authorization"] = basicAuthHeader(params.clientId, params.clientSecret);
      }
      const response = await fetch(params.tokenUrl, { method: "POST", headers, body });
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
      throw oauthConnectionError("token_exchange_failed", formatOAuthTokenExchangeError(response.status, data, text));
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
        callerId: ctx.callerId,
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
      credential = await credentialLifecycle.refreshCredential(credential as Credential & { id: string });
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
      connect: { args: z.tuple([connectCredentialParamsSchema]) },
      configureClient: { args: z.tuple([configureClientParamsSchema]) },
      requestCredentialInput: { args: z.tuple([requestCredentialInputParamsSchema]) },
      getClientConfigStatus: { args: z.tuple([getClientConfigStatusParamsSchema]) },
      deleteClientConfig: { args: z.tuple([deleteClientConfigParamsSchema]) },
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
        code: url.searchParams.get("code") ?? url.searchParams.get("oauth_verifier"),
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

function validateApiKeyMaterialTemplate(template: string, fieldNames: readonly string[]): void {
  const declared = new Set(fieldNames);
  const placeholders = template.match(/\{[a-zA-Z0-9._@+=:-]+\}/g) ?? [];
  if (placeholders.length === 0) {
    throw new OAuthConnectionError("invalid_connection_spec", "api-key materialTemplate must reference at least one field");
  }
  for (const placeholder of placeholders) {
    const name = placeholder.slice(1, -1);
    if (!declared.has(name)) {
      throw new OAuthConnectionError(
        "invalid_connection_spec",
        `api-key materialTemplate references undeclared field: ${name}`,
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
  options: { allowMissingExpiry?: boolean; persistRefreshToken?: boolean },
): { accessToken: string; refreshToken?: string; expiresAt?: number; scopes?: string[] } {
  const accessToken = tokenData?.["access_token"];
  const tokenType = tokenData?.["token_type"];
  if (typeof accessToken !== "string") {
    throw oauthConnectionError("invalid_token_response", "OAuth token exchange did not return an access_token");
  }
  if (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer") {
    throw oauthConnectionError("invalid_token_response", "OAuth token exchange did not return bearer token_type");
  }
  const expiresIn = readNumericField(tokenData?.["expires_in"]);
  if (expiresIn === undefined && !options.allowMissingExpiry) {
    throw oauthConnectionError("invalid_token_response", "OAuth token exchange did not return expires_in");
  }
  const refreshToken = tokenData?.["refresh_token"];
  const scope = tokenData?.["scope"];
  return {
    accessToken,
    ...(options.persistRefreshToken && typeof refreshToken === "string" && refreshToken.length > 0 ? { refreshToken } : {}),
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
  },
): void {
  if (params.tokenAuth !== "private_key_jwt") {
    return;
  }
  if (!params.privateKeyPem) {
    throw new OAuthConnectionError("client_config_unavailable", "private_key_jwt requires a configured private key");
  }
  body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
  body.set("client_assertion", signJwtAssertion({
    issuer: params.clientId,
    subject: params.clientId,
    audience: params.tokenUrl,
    privateKeyPem: params.privateKeyPem,
    keyId: params.keyId,
    keyAlgorithm: params.keyAlgorithm,
  }));
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
    throw new OAuthConnectionError("unsupported_token_auth_method", "Only RS256 JWT client assertions are supported");
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
    throw new OAuthConnectionError("invalid_connection_spec", "Unable to derive Ed25519 public key");
  }
  const type = Buffer.from("ssh-ed25519");
  const wire = Buffer.concat([
    uint32(type.length),
    type,
    uint32(keyBytes.length),
    keyBytes,
  ]);
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
  return "OAuth " + Object.entries(oauthParams)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${oauthPercentEncode(key)}="${oauthPercentEncode(value)}"`)
    .join(", ");
}

function createHmacSha1(key: string, value: string): string {
  return createHmac("sha1", key).update(value).digest("base64");
}

function oauthPercentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return typeof providerUserId === "string" && providerUserId.length > 0
    ? { providerUserId }
    : {};
}

async function validateOAuthAccountIdentity(
  request: InternalOAuthConnectionRequest,
  accessToken: string,
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
  const resource = binding.use === "git-http" || binding.use === "git-ssh"
    ? gitRemoteFromUrl(targetUrl)
    : findMatchingUrlAudience(targetUrl, binding.audience)?.url ?? targetUrl.origin;
  const gitOperation = binding.use === "git-http" || binding.use === "git-ssh" ? describeGitHttpOperation(targetUrl, "GET") : undefined;
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
    const action: CredentialGrantAction = binding.use === "git-http" || binding.use === "git-ssh" ? "read" : "use";
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
  if (error instanceof CredentialLifecycleError) {
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
