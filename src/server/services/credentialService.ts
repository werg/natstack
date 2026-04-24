import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { CredentialStore } from "../../../packages/shared/src/credentials/store.js";
import { ConsentGrantStore } from "../../../packages/shared/src/credentials/consent.js";
import { AuditLog } from "../../../packages/shared/src/credentials/audit.js";
import { ProviderRegistry } from "../../../packages/shared/src/credentials/registry.js";
import { builtinProviders } from "../../../packages/shared/src/credentials/providers/index.js";
import type { ServiceDefinition } from "../../../packages/shared/src/serviceDefinition.js";
import type { ServiceContext } from "../../../packages/shared/src/serviceDispatcher.js";
import type {
  AuditEntry,
  ConsentGrant,
  Credential,
  FlowConfig,
} from "../../../packages/shared/src/credentials/types.js";
import type { WebhookSubscriptionStore } from "../../../packages/shared/src/webhooks/subscription.js";
import type { WebhookSubscription } from "../../../packages/shared/src/webhooks/types.js";
import type { EgressProxy } from "./egressProxy.js";
import type { CodeIdentityResolver, ResolvedCodeIdentity } from "./codeIdentityResolver.js";
import type { WebhookWatchManager } from "./webhookWatchManager.js";
import {
  listProviderConnections,
  resolveProviderConnection,
} from "./providerConnections.js";

interface PendingConsent {
  nonce: string;
  providerId: string;
  scopes: string[];
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
  initiatorCallerId: string;
}

interface TokenIdentity {
  email?: string;
  username?: string;
  providerUserId: string;
}

const IDENTIFIER_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/;
const identifierSchema = z
  .string()
  .regex(IDENTIFIER_REGEX, "Invalid identifier (must be a safe path component matching /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/)");
const optionalIdentifierSchema = identifierSchema.optional();
const nonceSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,128}$/, "Invalid nonce");

const PENDING_CONSENT_TTL_MS = 10 * 60 * 1000;
const PENDING_CONSENT_REAP_INTERVAL_MS = 60 * 1000;

interface CredentialServiceDeps {
  credentialStore?: CredentialStore;
  consentStore?: ConsentGrantStore;
  auditLog?: AuditLog;
  providerRegistry?: ProviderRegistry;
  egressProxy?: Pick<EgressProxy, "forwardProxyFetch">;
  codeIdentityResolver?: Pick<CodeIdentityResolver, "resolveByCallerId">;
  webhookStore?: Pick<
    WebhookSubscriptionStore,
    "upsertSubscription" | "deleteSubscription" | "getSubscription"
  >;
  webhookWatchManager?: Pick<WebhookWatchManager, "ensureLease" | "releaseLease">;
}

const redirectModeSchema = z.enum([
  "server-loopback",
  "client-loopback",
  "mobile-universal",
]);

const beginConsentParamsSchema = z.object({
  providerId: identifierSchema,
  scopes: z.array(z.string().max(256)).default([]),
  accountHint: z.string().max(256).optional(),
  role: z.string().max(64).optional(),
  redirect: redirectModeSchema,
  redirectUri: z.string().url().optional(),
}).strict();

const completeConsentParamsSchema = z.object({
  nonce: nonceSchema,
  code: z.string().min(1).max(4096),
}).strict();

const revokeConsentParamsSchema = z.object({
  providerId: identifierSchema,
  connectionId: optionalIdentifierSchema,
}).strict();

const listConsentParamsSchema = z.object({
  repoPath: z.string().optional(),
}).strict();

const listConnectionsParamsSchema = z.object({
  providerId: optionalIdentifierSchema,
}).strict();

const renameConnectionParamsSchema = z.object({
  connectionId: identifierSchema,
  label: z.string().min(1).max(256),
}).strict();

const auditFilterSchema = z.object({
  workerId: optionalIdentifierSchema,
  callerId: optionalIdentifierSchema,
  providerId: optionalIdentifierSchema,
  connectionId: optionalIdentifierSchema,
  method: z.string().max(32).optional(),
  url: z.string().max(2048).optional(),
  status: z.number().optional(),
  capabilityViolation: z.string().max(256).optional(),
  breakerState: z.enum(["closed", "open", "half-open"]).optional(),
}).strict();

const auditParamsSchema = z.object({
  filter: auditFilterSchema.optional(),
  limit: z.number().int().positive().optional(),
  after: z.number().optional(),
}).strict();

const subscribeWebhookParamsSchema = z.object({
  providerId: identifierSchema,
  eventType: z.string().min(1).max(128),
  handler: z.string().min(1),
  connectionId: optionalIdentifierSchema,
}).strict();

const unsubscribeWebhookParamsSchema = z.object({
  subscriptionId: identifierSchema,
}).strict();

const resolveConnectionParamsSchema = z.object({
  providerId: identifierSchema,
  connectionId: optionalIdentifierSchema,
}).strict();

const checkConsentParamsSchema = z.object({
  providerId: identifierSchema,
}).strict();

const grantConsentParamsSchema = z.object({
  providerId: identifierSchema,
  codeIdentityType: z.enum(["repo", "hash"]),
  transient: z.boolean().optional(),
  connectionId: optionalIdentifierSchema,
}).strict();

const proxyFetchParamsSchema = z.object({
  url: z.string().url(),
  method: z.string().min(1).max(16),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  connectionId: optionalIdentifierSchema,
}).strict();

type BeginConsentParams = z.infer<typeof beginConsentParamsSchema>;
type CompleteConsentParams = z.infer<typeof completeConsentParamsSchema>;
type RevokeConsentParams = z.infer<typeof revokeConsentParamsSchema>;
type ListConsentParams = z.infer<typeof listConsentParamsSchema>;
type ListConnectionsParams = z.infer<typeof listConnectionsParamsSchema>;
type RenameConnectionParams = z.infer<typeof renameConnectionParamsSchema>;
type AuditParams = z.infer<typeof auditParamsSchema>;
type SubscribeWebhookParams = z.infer<typeof subscribeWebhookParamsSchema>;
type UnsubscribeWebhookParams = z.infer<typeof unsubscribeWebhookParamsSchema>;
type ResolveConnectionParams = z.infer<typeof resolveConnectionParamsSchema>;
type CheckConsentParams = z.infer<typeof checkConsentParamsSchema>;
type GrantConsentParams = z.infer<typeof grantConsentParamsSchema>;
type ProxyFetchParams = z.infer<typeof proxyFetchParamsSchema>;

type ConsentResult = {
  connectionId: string;
  apiBase: string[];
};
type Connection = Pick<
  Credential,
  "providerId" | "connectionId" | "connectionLabel" | "accountIdentity" | "scopes" | "expiresAt" | "metadata"
>;
type WebhookSubscriptionResult = Pick<WebhookSubscription, "subscriptionId" | "leaseId">;

interface ProviderStatus {
  provider: string;
  displayName: string;
  kind: "oauth" | "env-var";
  status: "connected" | "disconnected" | "configured" | "missing";
  envVar?: string;
}

export function createCredentialService(deps: CredentialServiceDeps = {}): ServiceDefinition {
  const credentialStore = deps.credentialStore ?? new CredentialStore();
  const consentStore = deps.consentStore;
  const auditLog = deps.auditLog;
  const registry = deps.providerRegistry ?? new ProviderRegistry();
  const pendingConsents = new Map<string, PendingConsent>();
  const egressProxy = deps.egressProxy;
  const codeIdentityResolver = deps.codeIdentityResolver;
  const webhookStore = deps.webhookStore;
  const webhookWatchManager = deps.webhookWatchManager;

  const reapInterval = setInterval(() => {
    const now = Date.now();
    for (const [nonce, entry] of pendingConsents) {
      if (now - entry.createdAt > PENDING_CONSENT_TTL_MS) {
        pendingConsents.delete(nonce);
      }
    }
  }, PENDING_CONSENT_REAP_INTERVAL_MS);
  if (typeof reapInterval.unref === "function") reapInterval.unref();

  for (const manifest of builtinProviders) {
    registry.register(manifest);
  }

  async function beginConsent(params: BeginConsentParams, callerId: string): Promise<{ nonce: string; authorizeUrl: string }> {
    const manifest = registry.get(params.providerId);
    if (!manifest) {
      throw new Error(`Unknown provider: ${params.providerId}`);
    }

    const pkceFlow = manifest.flows.find((flow) => flow.type === "loopback-pkce");
    if (!pkceFlow?.authorizeUrl || !pkceFlow.clientId) {
      throw new Error(`Provider ${params.providerId} does not support browser-based OAuth`);
    }

    const nonce = randomBytes(16).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

    const authorizeUrl = new URL(pkceFlow.authorizeUrl);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", pkceFlow.clientId);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", nonce);

    const scope = resolveRequestedScope(manifest, pkceFlow, params.scopes);
    if (scope) {
      authorizeUrl.searchParams.set("scope", scope);
    }

    for (const [key, value] of Object.entries(pkceFlow.extraAuthorizeParams ?? {})) {
      authorizeUrl.searchParams.set(key, value);
    }

    const redirectUri = resolveRedirectUri(params.providerId, params.redirect, params.redirectUri);
    if (redirectUri) {
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    }

    pendingConsents.set(nonce, {
      nonce,
      providerId: params.providerId,
      scopes: params.scopes,
      codeVerifier,
      redirectUri,
      createdAt: Date.now(),
      initiatorCallerId: callerId,
    });

    return { nonce, authorizeUrl: authorizeUrl.toString() };
  }

  async function completeConsent(params: CompleteConsentParams, callerId: string): Promise<ConsentResult> {
    const pending = pendingConsents.get(params.nonce);
    if (!pending) {
      throw new Error("Unknown or expired consent nonce");
    }
    if (Date.now() - pending.createdAt > PENDING_CONSENT_TTL_MS) {
      pendingConsents.delete(params.nonce);
      throw new Error("Consent nonce expired");
    }
    if (pending.initiatorCallerId !== callerId) {
      throw new Error("Consent caller mismatch");
    }
    pendingConsents.delete(params.nonce);

    const manifest = registry.get(pending.providerId);
    if (!manifest) {
      throw new Error(`Unknown provider: ${pending.providerId}`);
    }

    const pkceFlow = manifest.flows.find((flow) => flow.type === "loopback-pkce");
    if (!pkceFlow?.tokenUrl || !pkceFlow.clientId) {
      throw new Error(`Provider ${pending.providerId} does not support token exchange`);
    }

    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", params.code);
    body.set("code_verifier", pending.codeVerifier);
    body.set("client_id", pkceFlow.clientId);
    if (pending.redirectUri) {
      body.set("redirect_uri", pending.redirectUri);
    }
    if (pkceFlow.clientSecret) {
      body.set("client_secret", pkceFlow.clientSecret);
    }

    const tokenResponse = await fetch(pkceFlow.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text();
      throw new Error(`Token exchange failed: ${tokenResponse.status} ${errorBody}`);
    }

    const tokenData = await tokenResponse.json() as Record<string, unknown>;
    const accessToken = tokenData["access_token"];
    const refreshToken = tokenData["refresh_token"];
    const expiresIn = readNumericField(tokenData["expires_in"]);

    if (typeof accessToken !== "string") {
      throw new Error("Token exchange did not return an access_token");
    }

    const metadata = extractTokenMetadata(pkceFlow, tokenData, accessToken);
    const accountIdentity = extractAccountIdentity(tokenData, accessToken, metadata);

    const connectionId = randomUUID();
    const credential: Credential = {
      providerId: pending.providerId,
      connectionId,
      connectionLabel: manifest.displayName,
      accountIdentity,
      accessToken,
      refreshToken: typeof refreshToken === "string" ? refreshToken : undefined,
      scopes: pending.scopes,
      expiresAt: typeof expiresIn === "number" ? Date.now() + expiresIn * 1000 : undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };

    await credentialStore.save(credential);

    return { connectionId, apiBase: manifest.apiBase };
  }

  async function revokeConsent(params: RevokeConsentParams): Promise<void> {
    if (params.connectionId) {
      await credentialStore.remove(params.providerId, params.connectionId);
      return;
    }

    const creds = await credentialStore.list(params.providerId);
    for (const cred of creds) {
      await credentialStore.remove(params.providerId, cred.connectionId);
    }
  }

  async function listConsent(ctx: ServiceContext, params: ListConsentParams): Promise<ConsentGrant[]> {
    if (!consentStore) {
      return [];
    }

    const identity = getCallerIdentity(ctx, codeIdentityResolver);
    const repoPath = params.repoPath ?? identity?.repoPath;
    if (!repoPath) {
      return [];
    }
    return consentStore.list(repoPath);
  }

  async function listConnections(params: ListConnectionsParams): Promise<Connection[]> {
    const credentials = params.providerId
      ? await listProviderConnections(credentialStore, registry.get(params.providerId))
      : await listAllConnections(credentialStore, registry);
    return credentials.map((credential) => ({
      providerId: credential.providerId,
      connectionId: credential.connectionId,
      connectionLabel: credential.connectionLabel,
      accountIdentity: credential.accountIdentity,
      scopes: credential.scopes,
      expiresAt: credential.expiresAt,
      metadata: credential.metadata,
    }));
  }

  async function renameConnection(params: RenameConnectionParams): Promise<void> {
    const allCredentials = await credentialStore.list();
    const credential = allCredentials.find((entry) => entry.connectionId === params.connectionId);
    if (!credential) {
      throw new Error(`Connection not found: ${params.connectionId}`);
    }
    await credentialStore.save({ ...credential, connectionLabel: params.label });
  }

  async function audit(params: AuditParams): Promise<AuditEntry[]> {
    if (!auditLog) {
      return [];
    }
    return auditLog.query({ filter: params.filter, limit: params.limit, after: params.after });
  }

  async function resolveConnection(ctx: ServiceContext, params: ResolveConnectionParams): Promise<{
    connectionId: string;
    providerId: string;
  }> {
    const manifest = registry.get(params.providerId);
    if (!manifest) {
      throw new Error(`Unknown provider: ${params.providerId}`);
    }

    const identity = requireCallerIdentity(ctx, codeIdentityResolver);
    const connection = await resolveProviderConnection(
      credentialStore,
      params.providerId,
      manifest,
      params.connectionId,
    );
    if (!connection) {
      throw new Error(`No connection configured for ${params.providerId}`);
    }

    if (!consentStore) {
      throw new Error("Consent store is unavailable");
    }

    const grant = await consentStore.check({
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      providerId: params.providerId,
    });

    if (!grant) {
      throw new Error(`No consent grant for ${params.providerId}`);
    }

    return {
      connectionId: params.connectionId ?? grant.connectionId ?? connection.connectionId,
      providerId: params.providerId,
    };
  }

  async function checkConsent(ctx: ServiceContext, params: CheckConsentParams): Promise<boolean> {
    if (!consentStore) {
      return false;
    }

    const identity = requireCallerIdentity(ctx, codeIdentityResolver);
    const grant = await consentStore.check({
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      providerId: params.providerId,
    });
    return grant !== null;
  }

  async function grantConsent(ctx: ServiceContext, params: GrantConsentParams): Promise<void> {
    if (!consentStore) {
      throw new Error("Consent store is unavailable");
    }

    const identity = requireCallerIdentity(ctx, codeIdentityResolver);
    const manifest = registry.get(params.providerId);
    const connection = await resolveProviderConnection(
      credentialStore,
      params.providerId,
      manifest,
      params.connectionId,
    );
    if (!connection) {
      throw new Error(`No connection configured for ${params.providerId}`);
    }

    const codeIdentity =
      params.codeIdentityType === "repo"
        ? identity.repoPath
        : identity.effectiveVersion;
    if (!codeIdentity) {
      throw new Error(`No ${params.codeIdentityType} identity available for ${identity.repoPath}`);
    }

    await consentStore.grant({
      codeIdentity,
      codeIdentityType: params.codeIdentityType,
      providerId: params.providerId,
      connectionId: connection.connectionId,
      scopes: connection.scopes,
      grantedAt: Date.now(),
      grantedBy: ctx.callerId,
      transient: params.transient,
    });
  }

  async function proxyFetch(ctx: ServiceContext, params: ProxyFetchParams): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
  }> {
    if (!egressProxy) {
      throw new Error("Egress proxy is unavailable");
    }

    return egressProxy.forwardProxyFetch({
      callerId: ctx.callerId,
      url: params.url,
      method: params.method,
      headers: params.headers,
      body: params.body,
      connectionId: params.connectionId,
    });
  }

  async function listProviders(): Promise<ProviderStatus[]> {
    const connections = await listAllConnections(credentialStore, registry);
    const connectedByProvider = new Set(connections.map((credential) => credential.providerId));

    return registry.list().map((manifest) => {
      const envFlow = manifest.flows.find((flow) => flow.type === "env-var" && flow.envVar);
      const hasOAuthFlow = manifest.flows.some((flow) => flow.type === "loopback-pkce" || flow.type === "device-code");
      const kind: ProviderStatus["kind"] = !hasOAuthFlow && envFlow ? "env-var" : "oauth";
      const connected = connectedByProvider.has(manifest.id);

      return {
        provider: manifest.id,
        displayName: manifest.displayName,
        kind,
        status: kind === "env-var"
          ? connected ? "configured" : "missing"
          : connected ? "connected" : "disconnected",
        envVar: envFlow?.envVar,
      };
    });
  }

  async function subscribeWebhook(
    ctx: ServiceContext,
    params: SubscribeWebhookParams,
  ): Promise<WebhookSubscriptionResult> {
    if (!webhookStore || !webhookWatchManager) {
      throw new Error("Webhook subscription store is unavailable");
    }

    const manifest = registry.get(params.providerId);
    const subscriptionConfig = manifest?.webhooks?.subscriptions?.find((entry) => entry.event === params.eventType);
    if (!manifest || !subscriptionConfig) {
      throw new Error(`Provider ${params.providerId} does not declare webhook event ${params.eventType}`);
    }

    const resolvedConnection = await resolveConnection(ctx, {
      providerId: params.providerId,
      connectionId: params.connectionId,
    });
    const lease = subscriptionConfig.watch
      ? await webhookWatchManager.ensureLease({
          providerId: params.providerId,
          eventType: params.eventType,
          connectionId: resolvedConnection.connectionId,
        })
      : null;
    const subscription = webhookStore.upsertSubscription({
      callerId: ctx.callerId,
      providerId: params.providerId,
      eventType: params.eventType,
      connectionId: resolvedConnection.connectionId,
      handler: params.handler,
      delivery: subscriptionConfig.delivery,
      watchType: subscriptionConfig.watch?.type,
      leaseId: lease?.leaseId,
      secret: lease?.secret,
    });
    return {
      subscriptionId: subscription.subscriptionId,
      leaseId: lease?.leaseId,
    };
  }

  async function unsubscribeWebhook(ctx: ServiceContext, params: UnsubscribeWebhookParams): Promise<void> {
    if (!webhookStore || !webhookWatchManager) {
      throw new Error("Webhook subscription store is unavailable");
    }
    const subscription = webhookStore.getSubscription(params.subscriptionId);
    if (!subscription) {
      return;
    }
    if (subscription.callerId !== ctx.callerId) {
      throw new Error("Webhook subscriptions can only be removed by the caller that created them");
    }
    webhookStore.deleteSubscription(params.subscriptionId);
    if (subscription.leaseId) {
      await webhookWatchManager.releaseLease(subscription.leaseId);
    }
  }

  return {
    name: "credentials",
    description: "Credential consent, connection, audit, and webhook management",
    policy: { allowed: ["shell", "panel", "server", "worker"] },
    methods: {
      beginConsent: { args: z.tuple([beginConsentParamsSchema]) },
      completeConsent: { args: z.tuple([completeConsentParamsSchema]) },
      revokeConsent: { args: z.tuple([revokeConsentParamsSchema]) },
      listConsent: { args: z.tuple([listConsentParamsSchema]) },
      listConnections: { args: z.tuple([listConnectionsParamsSchema]) },
      renameConnection: { args: z.tuple([renameConnectionParamsSchema]) },
      audit: { args: z.tuple([auditParamsSchema]) },
      subscribeWebhook: { args: z.tuple([subscribeWebhookParamsSchema]) },
      unsubscribeWebhook: { args: z.tuple([unsubscribeWebhookParamsSchema]) },
      resolveConnection: { args: z.tuple([resolveConnectionParamsSchema]) },
      checkConsent: { args: z.tuple([checkConsentParamsSchema]) },
      grantConsent: { args: z.tuple([grantConsentParamsSchema]) },
      proxyFetch: { args: z.tuple([proxyFetchParamsSchema]) },
      listProviders: { args: z.tuple([]) },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "beginConsent":
          return beginConsent((args as [BeginConsentParams])[0], ctx.callerId);
        case "completeConsent":
          return completeConsent((args as [CompleteConsentParams])[0], ctx.callerId);
        case "revokeConsent":
          return revokeConsent((args as [RevokeConsentParams])[0]);
        case "listConsent":
          return listConsent(ctx, (args as [ListConsentParams])[0]);
        case "listConnections":
          return listConnections((args as [ListConnectionsParams])[0]);
        case "renameConnection":
          return renameConnection((args as [RenameConnectionParams])[0]);
        case "audit":
          return audit((args as [AuditParams])[0]);
        case "subscribeWebhook":
          return subscribeWebhook(ctx, (args as [SubscribeWebhookParams])[0]);
        case "unsubscribeWebhook":
          return unsubscribeWebhook(ctx, (args as [UnsubscribeWebhookParams])[0]);
        case "resolveConnection":
          return resolveConnection(ctx, (args as [ResolveConnectionParams])[0]);
        case "checkConsent":
          return checkConsent(ctx, (args as [CheckConsentParams])[0]);
        case "grantConsent":
          return grantConsent(ctx, (args as [GrantConsentParams])[0]);
        case "proxyFetch":
          return proxyFetch(ctx, (args as [ProxyFetchParams])[0]);
        case "listProviders":
          return listProviders();
        default:
          throw new Error(`Unknown credentials method: ${method}`);
      }
    },
  };
}

async function listAllConnections(
  credentialStore: CredentialStore,
  registry: ProviderRegistry,
): Promise<Credential[]> {
  const connections = await credentialStore.list();
  const byKey = new Set(connections.map((credential) => `${credential.providerId}:${credential.connectionId}`));

  for (const manifest of registry.list()) {
    const envCredential = manifest.flows.find((flow) => flow.type === "env-var" && flow.envVar)
      ? await resolveProviderConnection(credentialStore, manifest.id, manifest)
      : null;
    if (!envCredential) {
      continue;
    }
    const key = `${envCredential.providerId}:${envCredential.connectionId}`;
    if (!byKey.has(key)) {
      byKey.add(key);
      connections.push(envCredential);
    }
  }

  return connections;
}

function resolveRedirectUri(
  providerId: string,
  redirect: BeginConsentParams["redirect"],
  redirectUriOverride?: string,
): string {
  if (redirect === "client-loopback" && redirectUriOverride) {
    return redirectUriOverride;
  }
  if (redirect === "server-loopback") {
    return "http://127.0.0.1:0/oauth/callback";
  }
  if (redirect === "mobile-universal") {
    return "natstack://oauth/callback";
  }
  if (providerId === "openai-codex") {
    return "http://localhost:1455/auth/callback";
  }
  return "http://127.0.0.1/oauth/callback";
}

function resolveRequestedScope(
  manifest: ReturnType<ProviderRegistry["get"]> extends infer T ? NonNullable<T> : never,
  flow: FlowConfig,
  scopes: string[],
): string | null {
  if (flow.fixedScope) {
    return flow.fixedScope;
  }
  if (scopes.length === 0) {
    return null;
  }
  return scopes.map((scope) => manifest.scopes?.[scope] ?? scope).join(" ");
}

function extractTokenMetadata(
  flow: FlowConfig,
  tokenData: Record<string, unknown>,
  accessToken: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, spec] of Object.entries(flow.tokenMetadata ?? {})) {
    const sourceValue = spec.source === "response-field"
      ? getDotPath(tokenData, spec.path)
      : getDotPath(readJwtClaims(tokenData, accessToken), spec.path);
    if (typeof sourceValue === "string" && sourceValue.length > 0) {
      result[key] = sourceValue;
    }
  }
  return result;
}

function extractAccountIdentity(
  tokenData: Record<string, unknown>,
  accessToken: string,
  metadata: Record<string, string>,
): TokenIdentity {
  return {
    email: readJwtString(tokenData, accessToken, "email") ?? undefined,
    username: readJwtString(tokenData, accessToken, "preferred_username") ?? undefined,
    providerUserId: metadata["accountId"]
      ?? metadata["sub"]
      ?? readJwtString(tokenData, accessToken, "sub")
      ?? randomUUID(),
  };
}

function readJwtClaims(tokenData: Record<string, unknown>, accessToken: string): Record<string, unknown> {
  const accessClaims = decodeJwt(accessToken);
  if (accessClaims) {
    return accessClaims;
  }

  const idToken = tokenData["id_token"];
  return typeof idToken === "string" ? decodeJwt(idToken) ?? {} : {};
}

function decodeJwt(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function getDotPath(input: Record<string, unknown>, path: string): unknown {
  if (path in input) {
    return input[path];
  }
  let current: unknown = input;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function extractJwtString(token: string, field: string): string | null {
  const decoded = decodeJwt(token);
  const value = decoded ? decoded[field] : undefined;
  return typeof value === "string" ? value : null;
}

function readJwtString(
  tokenData: Record<string, unknown>,
  accessToken: string,
  field: string,
): string | null {
  return extractJwtString(accessToken, field)
    ?? (() => {
      const idToken = tokenData["id_token"];
      return typeof idToken === "string" ? extractJwtString(idToken, field) : null;
    })();
}

function readNumericField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function getCallerIdentity(
  ctx: ServiceContext,
  codeIdentityResolver?: Pick<CodeIdentityResolver, "resolveByCallerId">,
): ResolvedCodeIdentity | null {
  return codeIdentityResolver?.resolveByCallerId(ctx.callerId) ?? null;
}

function requireCallerIdentity(
  ctx: ServiceContext,
  codeIdentityResolver?: Pick<CodeIdentityResolver, "resolveByCallerId">,
): ResolvedCodeIdentity {
  const identity = getCallerIdentity(ctx, codeIdentityResolver);
  if (!identity) {
    throw new Error(`No code identity registered for ${ctx.callerId}`);
  }
  return identity;
}
