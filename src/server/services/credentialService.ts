import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuditLog } from "../../../packages/shared/src/credentials/audit.js";
import { OAuthClientConfigStore } from "../../../packages/shared/src/credentials/oauthClientConfigStore.js";
import { CredentialStore } from "../../../packages/shared/src/credentials/store.js";
import type {
  AccountIdentity,
  AuditEntry,
  BeginOAuthClientPkceCredentialRequest,
  CompleteOAuthPkceCredentialRequest,
  Credential,
  CredentialAuditEvent,
  CreateOAuthPkceCredentialRequest,
  GetOAuthClientConfigStatusRequest,
  GrantUrlBoundCredentialRequest,
  OAuthClientConfigStatus,
  RequestOAuthClientConfigRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
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
import { CredentialSessionGrantStore, type CredentialSessionGrantScope } from "./credentialSessionGrants.js";

const IDENTIFIER_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/;
const identifierSchema = z
  .string()
  .regex(IDENTIFIER_REGEX, "Invalid identifier (must be a safe path component matching /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/)");
const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, "Invalid nonce");
const PENDING_OAUTH_TTL_MS = 10 * 60 * 1000;
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
]);

const accountIdentitySchema = z.object({
  email: z.string().max(320).optional(),
  username: z.string().max(256).optional(),
  workspaceName: z.string().max(256).optional(),
  providerUserId: z.string().max(256).optional(),
}).strict();

const storeUrlBoundCredentialParamsSchema = z.object({
  label: z.string().min(1).max(256),
  audience: z.array(urlAudienceSchema).min(1).max(16),
  injection: credentialInjectionSchema,
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
  }).strict(),
  credential: z.object({
    label: z.string().min(1).max(256),
    audience: z.array(urlAudienceSchema).min(1).max(16),
    injection: credentialInjectionSchema,
    accountIdentity: accountIdentitySchema.optional(),
    scopes: z.array(z.string().max(256)).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  }).strict(),
  redirectUri: z.string().url(),
}).strict();

const completeOAuthPkceCredentialParamsSchema = z.object({
  nonce: nonceSchema,
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(4096),
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

const getOAuthClientConfigStatusParamsSchema = z.object({
  configId: identifierSchema,
  fields: z.array(oauthClientConfigFieldSchema).max(16).optional(),
}).strict();

const beginOAuthClientPkceCredentialParamsSchema = z.object({
  redirectUri: z.string().url(),
  oauth: z.object({
    configId: identifierSchema,
    scopes: z.array(z.string().max(256)).optional(),
    extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
    allowMissingExpiry: z.boolean().optional(),
  }).strict(),
  credential: createOAuthPkceCredentialParamsSchema.shape.credential,
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
}).strict();

const proxyFetchParamsSchema = z.object({
  url: z.string().url(),
  method: z.string().min(1).max(16),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
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
type CreateOAuthPkceCredentialParams = z.infer<typeof createOAuthPkceCredentialParamsSchema>;
type CompleteOAuthPkceCredentialParams = z.infer<typeof completeOAuthPkceCredentialParamsSchema>;
type RequestOAuthClientConfigParams = z.infer<typeof requestOAuthClientConfigParamsSchema>;
type GetOAuthClientConfigStatusParams = z.infer<typeof getOAuthClientConfigStatusParamsSchema>;
type BeginOAuthClientPkceCredentialParams = z.infer<typeof beginOAuthClientPkceCredentialParamsSchema>;
type CredentialIdParams = z.infer<typeof credentialIdParamsSchema>;
type GrantCredentialParams = z.infer<typeof grantCredentialParamsSchema>;
type ResolveCredentialParams = z.infer<typeof resolveCredentialParamsSchema>;
type ProxyFetchParams = z.infer<typeof proxyFetchParamsSchema>;
type AuditParams = z.infer<typeof auditParamsSchema>;
type InternalCreateOAuthPkceCredentialRequest = CreateOAuthPkceCredentialRequest & {
  oauth: CreateOAuthPkceCredentialRequest["oauth"] & { clientSecret?: string };
};

function canonicalUrl(raw: string): string {
  return new URL(raw).toString();
}

function validateOAuthClientConfigUrls(authorizeUrl: string, tokenUrl: string): void {
  const authorize = new URL(authorizeUrl);
  const token = new URL(tokenUrl);
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

interface CredentialServiceDeps {
  credentialStore?: CredentialStore;
  oauthClientConfigStore?: OAuthClientConfigStore;
  auditLog?: AuditLog;
  egressProxy?: Pick<EgressProxy, "forwardProxyFetch">;
  codeIdentityResolver?: Pick<CodeIdentityResolver, "resolveByCallerId">;
  approvalQueue?: ApprovalQueue;
  sessionGrantStore?: CredentialSessionGrantStore;
}

interface PendingOAuthCredentialCreation {
  nonce: string;
  oauth: InternalCreateOAuthPkceCredentialRequest["oauth"];
  credential: CreateOAuthPkceCredentialRequest["credential"];
  redirectUri: string;
  codeVerifier: string;
  createdAt: number;
  initiatorCallerId: string;
}

export function createCredentialService(deps: CredentialServiceDeps = {}): ServiceDefinition {
  const credentialStore = deps.credentialStore ?? new CredentialStore();
  const oauthClientConfigStore = deps.oauthClientConfigStore ?? new OAuthClientConfigStore();
  const auditLog = deps.auditLog;
  const egressProxy = deps.egressProxy;
  const codeIdentityResolver = deps.codeIdentityResolver;
  const approvalQueue = deps.approvalQueue;
  const sessionGrantStore = deps.sessionGrantStore ?? new CredentialSessionGrantStore();
  const pendingOAuthCreations = new Map<string, PendingOAuthCredentialCreation>();

  async function storeCredential(
    ctx: ServiceContext,
    params: StoreUrlBoundCredentialParams,
  ): Promise<StoredCredentialSummary> {
    const request = params as StoreUrlBoundCredentialRequest;
    const id = randomUUID();
    const audience = normalizeUrlAudiences(request.audience);
    const injection = normalizeCredentialInjection(request.injection);
    const identity = codeIdentityResolver?.resolveByCallerId(ctx.callerId) ?? null;
    const now = Date.now();
    const approvalIdentity = resolveApprovalIdentity(ctx);
    const approvalDecision = await requestCredentialApproval(ctx, {
      credentialId: id,
      credentialLabel: request.label,
      audience,
      injection,
      accountIdentity: normalizeAccountIdentity(request.accountIdentity, ctx.callerId),
      scopes: request.scopes ?? [],
      identity: approvalIdentity,
      metadata: request.metadata,
    });
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
      audience,
      injection,
      allowedCallers: approvalDecision === "session" || approvalDecision === "once"
        ? []
        : [grantForDecision(ctx.callerId, approvalIdentity, approvalDecision, now)],
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

    await credentialStore.saveUrlBound(credential as Credential & { id: string });
    if (approvalDecision === "session") {
      grantSessionCredentialUse(id, approvalIdentity);
    }
    await appendAudit({
      type: "connection_credential.created",
      ts: now,
      callerId: ctx.callerId,
      providerId: "url-bound",
      connectionId: id,
      storageKind: "connection-credential",
      fieldNames: ["credential"],
    });
    return summarizeUrlBoundCredential(credential);
  }

  async function beginCreateWithOAuthPkce(
    ctx: ServiceContext,
    params: CreateOAuthPkceCredentialParams | InternalCreateOAuthPkceCredentialRequest,
  ): Promise<{ nonce: string; state: string; authorizeUrl: string }> {
    const request = params as InternalCreateOAuthPkceCredentialRequest;
    normalizeUrlAudiences(request.credential.audience);
    normalizeCredentialInjection(request.credential.injection);
    normalizeUrlAudiences([
      { url: request.oauth.authorizeUrl, match: "exact" },
      { url: request.oauth.tokenUrl, match: "exact" },
      { url: request.redirectUri, match: "exact" },
    ]);

    const nonce = randomBytes(16).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const authorizeUrl = new URL(request.oauth.authorizeUrl);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", request.oauth.clientId);
    authorizeUrl.searchParams.set("redirect_uri", request.redirectUri);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", nonce);
    if (request.oauth.scopes?.length) {
      authorizeUrl.searchParams.set("scope", request.oauth.scopes.join(" "));
    }
    for (const [key, value] of Object.entries(request.oauth.extraAuthorizeParams ?? {})) {
      if (RESERVED_OAUTH_AUTHORIZE_PARAMS.has(key.toLowerCase())) {
        throw new Error(`OAuth extraAuthorizeParams cannot override ${key}`);
      }
      authorizeUrl.searchParams.set(key, value);
    }

    pendingOAuthCreations.set(nonce, {
      nonce,
      oauth: request.oauth,
      credential: request.credential,
      redirectUri: request.redirectUri,
      codeVerifier,
      createdAt: Date.now(),
      initiatorCallerId: ctx.callerId,
    });

    return { nonce, state: nonce, authorizeUrl: authorizeUrl.toString() };
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
    const record = {
      configId: request.configId,
      authorizeUrl,
      tokenUrl,
      fields,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
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
    _ctx: ServiceContext,
    params: GetOAuthClientConfigStatusParams,
  ): Promise<OAuthClientConfigStatus> {
    const request = params as GetOAuthClientConfigStatusRequest;
    const record = await oauthClientConfigStore.load(request.configId);
    return oauthClientConfigStore.summarize(request.configId, record, request.fields);
  }

  async function beginCreateWithOAuthClientPkce(
    ctx: ServiceContext,
    params: BeginOAuthClientPkceCredentialParams,
  ): Promise<{ nonce: string; state: string; authorizeUrl: string }> {
    const request = params as BeginOAuthClientPkceCredentialRequest;
    const config = await oauthClientConfigStore.load(request.oauth.configId);
    if (!config) {
      throw new Error(`OAuth client config is missing: ${request.oauth.configId}`);
    }
    const authorizeUrl = canonicalUrl(config.authorizeUrl);
    const tokenUrl = canonicalUrl(config.tokenUrl);
    const clientId = config.fields["clientId"]?.value;
    const clientSecret = config.fields["clientSecret"]?.value;
    if (!clientId) {
      throw new Error("OAuth client config is missing clientId");
    }
    return beginCreateWithOAuthPkce(ctx, {
      oauth: {
        authorizeUrl,
        tokenUrl,
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
        scopes: request.oauth.scopes,
        extraAuthorizeParams: request.oauth.extraAuthorizeParams,
        allowMissingExpiry: request.oauth.allowMissingExpiry,
      },
      credential: request.credential,
      redirectUri: request.redirectUri,
    });
  }

  async function completeCreateWithOAuthPkce(
    ctx: ServiceContext,
    params: CompleteOAuthPkceCredentialParams,
  ): Promise<StoredCredentialSummary> {
    const request = params as CompleteOAuthPkceCredentialRequest;
    const pending = pendingOAuthCreations.get(request.nonce);
    if (!pending) {
      throw new Error("Unknown or expired OAuth credential nonce");
    }
    if (request.state !== pending.nonce) {
      throw new Error("OAuth state mismatch");
    }
    if (pending.initiatorCallerId !== ctx.callerId) {
      throw new Error("OAuth credential caller mismatch");
    }
    if (Date.now() - pending.createdAt > PENDING_OAUTH_TTL_MS) {
      pendingOAuthCreations.delete(request.nonce);
      throw new Error("OAuth credential nonce expired");
    }
    pendingOAuthCreations.delete(request.nonce);

    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", request.code);
    body.set("code_verifier", pending.codeVerifier);
    body.set("client_id", pending.oauth.clientId);
    if (pending.oauth.clientSecret) {
      body.set("client_secret", pending.oauth.clientSecret);
    }
    body.set("redirect_uri", pending.redirectUri);

    const tokenResponse = await fetch(pending.oauth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const tokenText = await tokenResponse.text();
    const tokenData = parseJsonObject(tokenText, { strict: tokenResponse.ok });
    if (!tokenResponse.ok) {
      throw new Error(formatOAuthTokenExchangeError(tokenResponse.status, tokenData, tokenText));
    }
    if (typeof tokenData?.["error"] === "string") {
      throw new Error(`OAuth token exchange failed: ${tokenData["error"]}`);
    }

    const accessToken = tokenData?.["access_token"];
    const tokenType = tokenData?.["token_type"];
    if (typeof accessToken !== "string") {
      throw new Error("OAuth token exchange did not return an access_token");
    }
    if (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer") {
      throw new Error("OAuth token exchange did not return bearer token_type");
    }
    const expiresIn = readNumericField(tokenData?.["expires_in"]);
    if (expiresIn === undefined && !pending.oauth.allowMissingExpiry) {
      throw new Error("OAuth token exchange did not return expires_in");
    }

    return storeCredential(ctx, {
      label: pending.credential.label,
      audience: pending.credential.audience,
      injection: pending.credential.injection,
      material: { type: "bearer-token", token: accessToken },
      accountIdentity: {
        ...deriveAccountIdentityFromJwt(accessToken, pending.credential.metadata),
        ...(pending.credential.accountIdentity ?? {}),
      },
      scopes: pending.credential.scopes ?? pending.oauth.scopes ?? [],
      expiresAt: typeof expiresIn === "number" ? Date.now() + expiresIn * 1000 : undefined,
      metadata: {
        ...(pending.credential.metadata ?? {}),
        oauthAuthorizeOrigin: new URL(pending.oauth.authorizeUrl).origin,
        oauthTokenOrigin: new URL(pending.oauth.tokenUrl).origin,
        oauthScopes: (pending.oauth.scopes ?? []).join(" "),
      },
    });
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
    const credential = await loadActiveCredential(request.credentialId);
    const now = Date.now();
    await credentialStore.saveUrlBound({
      ...credential,
      allowedCallers: upsertGrant(credential.allowedCallers ?? [], {
        callerId: request.callerId,
        grantedAt: now,
        grantedBy: request.grantedBy ?? ctx.callerId,
      }),
      metadata: {
        ...(credential.metadata ?? {}),
        updatedAt: String(now),
      },
    } as Credential & { id: string });
    return summarizeUrlBoundCredential((await loadActiveCredential(request.credentialId)));
  }

  async function resolveCredential(
    ctx: ServiceContext,
    params: ResolveCredentialParams,
  ): Promise<StoredCredentialSummary | null> {
    const request = params as ResolveUrlBoundCredentialRequest;
    if (request.credentialId) {
      const credential = await loadActiveCredential(request.credentialId);
      if (!findMatchingUrlAudience(request.url, credential.audience ?? [])) {
        throw new Error("Credential audience does not match requested URL");
      }
      await authorizeCredentialUse(ctx, credential);
      return summarizeUrlBoundCredential(credential);
    }

    const credential = await resolveCredentialForUrl(ctx, new URL(request.url));
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

  async function audit(params: AuditParams): Promise<AuditEntry[]> {
    const entries = await auditLog?.query({ filter: params.filter, limit: params.limit, after: params.after }) ?? [];
    return entries.filter((entry): entry is AuditEntry => "workerId" in entry);
  }

  async function appendAudit(entry: CredentialAuditEvent): Promise<void> {
    await auditLog?.append(entry);
  }

  async function loadActiveCredential(credentialId: string): Promise<Credential & { id: string }> {
    const credential = await credentialStore.loadUrlBound(credentialId);
    if (!credential?.id || credential.revokedAt) {
      throw new Error("Credential is unavailable");
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
      audience: Credential["audience"];
      injection: Credential["injection"];
      accountIdentity: Credential["accountIdentity"];
      scopes: string[];
      identity: { repoPath: string; effectiveVersion: string };
      metadata?: Record<string, string>;
    },
  ): Promise<Exclude<GrantedDecision, "deny">> {
    if (!approvalQueue || (ctx.callerKind !== "panel" && ctx.callerKind !== "worker")) {
      return "session";
    }
    const oauthAuthorizeOrigin = params.metadata?.["oauthAuthorizeOrigin"];
    const oauthTokenOrigin = params.metadata?.["oauthTokenOrigin"];
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
      oauthAudienceDomainMismatch: hasOAuthAudienceDomainMismatch(params.audience ?? [], [
        oauthAuthorizeOrigin,
        oauthTokenOrigin,
      ]),
    });
    if (decision === "deny") {
      throw new Error("Credential approval denied");
    }
    return decision;
  }

  async function resolveCredentialForUrl(ctx: ServiceContext, targetUrl: URL): Promise<Credential | null> {
    const credentials = (await credentialStore.listUrlBound()).filter((credential) =>
      !credential.revokedAt
      && !!credential.audience
      && !!findMatchingUrlAudience(targetUrl, credential.audience)
    );
    if (credentials.length === 1) {
      const credential = credentials[0] ?? null;
      if (credential) {
        await authorizeCredentialUse(ctx, credential);
      }
      return credential;
    }
    if (credentials.length > 1) {
      throw new Error("Multiple credentials match requested URL; choose an explicit credential");
    }
    return null;
  }

  async function authorizeCredentialUse(ctx: ServiceContext, credential: Credential): Promise<void> {
    if (canCallerUseStoredCredential(ctx, credential)) {
      return;
    }
    if (!approvalQueue || (ctx.callerKind !== "panel" && ctx.callerKind !== "worker")) {
      throw new Error("Credential caller is not granted");
    }
    if (!credential.id || !credential.injection || !credential.audience) {
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
      audience: credential.audience,
      injection: credential.injection,
      accountIdentity: credential.accountIdentity,
      scopes: credential.scopes,
      oauthAuthorizeOrigin: credential.metadata?.["oauthAuthorizeOrigin"],
      oauthTokenOrigin: credential.metadata?.["oauthTokenOrigin"],
      oauthAudienceDomainMismatch: hasOAuthAudienceDomainMismatch(credential.audience, [
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
      grantSessionCredentialUse(credential.id, identity);
      return;
    }
    await credentialStore.saveUrlBound({
      ...credential,
      allowedCallers: upsertGrant(credential.allowedCallers ?? [], grantForDecision(ctx.callerId, identity, decision, now)),
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
    if (canCallerUseStoredCredential(ctx, credential)) {
      return true;
    }
    const identity = codeIdentityResolver?.resolveByCallerId(ctx.callerId);
    if (!identity) {
      return false;
    }
    if (credential.owner?.sourceId === identity.repoPath) {
      return true;
    }
    return !!credential.allowedCallers?.some((grant) =>
      grant.callerId === `repo:${identity.repoPath}`
      || grant.callerId === `version:${identity.repoPath}:${identity.effectiveVersion}`
    );
  }

  function canCallerUseStoredCredential(ctx: ServiceContext, credential: Credential): boolean {
    if (ctx.callerKind === "shell" || ctx.callerKind === "server") {
      return true;
    }
    return canCallerUseCredential(ctx, credential)
      || hasPersistentCredentialUse(ctx, credential)
      || hasSessionCredentialUse(ctx, credential);
  }

  function canCallerAdministerStoredCredential(ctx: ServiceContext, credential: Credential): boolean {
    if (ctx.callerKind === "shell" || ctx.callerKind === "server") {
      return true;
    }
    return canCallerSeeStoredCredential(ctx, credential);
  }

  function grantSessionCredentialUse(credentialId: string, identity: CredentialSessionGrantScope): void {
    sessionGrantStore.grant(credentialId, identity);
  }

  function hasSessionCredentialUse(ctx: ServiceContext, credential: Credential): boolean {
    const credentialId = credential.id ?? credential.connectionId;
    if (!credentialId) {
      return false;
    }
    return sessionGrantStore.has(credentialId, resolveApprovalIdentity(ctx));
  }

  function hasPersistentCredentialUse(ctx: ServiceContext, credential: Credential): boolean {
    const identity = resolveApprovalIdentity(ctx);
    return !!credential.allowedCallers?.some((grant) =>
      grant.callerId === `repo:${identity.repoPath}`
      || grant.callerId === `version:${identity.repoPath}:${identity.effectiveVersion}`
    );
  }

  return {
    name: "credentials",
    description: "URL-bound userland credential storage and egress",
    policy: { allowed: ["shell", "panel", "server", "worker"] },
    methods: {
      storeCredential: { args: z.tuple([storeUrlBoundCredentialParamsSchema]) },
      beginCreateWithOAuthPkce: { args: z.tuple([createOAuthPkceCredentialParamsSchema]) },
      beginCreateWithOAuthClientPkce: { args: z.tuple([beginOAuthClientPkceCredentialParamsSchema]) },
      completeCreateWithOAuthPkce: { args: z.tuple([completeOAuthPkceCredentialParamsSchema]) },
      requestOAuthClientConfig: { args: z.tuple([requestOAuthClientConfigParamsSchema]) },
      getOAuthClientConfigStatus: { args: z.tuple([getOAuthClientConfigStatusParamsSchema]) },
      listStoredCredentials: { args: z.tuple([]) },
      revokeCredential: { args: z.tuple([credentialIdParamsSchema]) },
      grantCredential: { args: z.tuple([grantCredentialParamsSchema]) },
      resolveCredential: { args: z.tuple([resolveCredentialParamsSchema]) },
      proxyFetch: { args: z.tuple([proxyFetchParamsSchema]) },
      audit: { args: z.tuple([auditParamsSchema]) },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "storeCredential":
          return storeCredential(ctx, (args as [StoreUrlBoundCredentialParams])[0]);
        case "beginCreateWithOAuthPkce":
          return beginCreateWithOAuthPkce(ctx, (args as [CreateOAuthPkceCredentialParams])[0]);
        case "beginCreateWithOAuthClientPkce":
          return beginCreateWithOAuthClientPkce(ctx, (args as [BeginOAuthClientPkceCredentialParams])[0]);
        case "completeCreateWithOAuthPkce":
          return completeCreateWithOAuthPkce(ctx, (args as [CompleteOAuthPkceCredentialParams])[0]);
        case "requestOAuthClientConfig":
          return requestOAuthClientConfig(ctx, (args as [RequestOAuthClientConfigParams])[0]);
        case "getOAuthClientConfigStatus":
          return getOAuthClientConfigStatus(ctx, (args as [GetOAuthClientConfigStatusParams])[0]);
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
        case "audit":
          return audit((args as [AuditParams])[0]);
        default:
          throw new Error(`Unknown credentials method: ${method}`);
      }
    },
  };
}

function normalizeAccountIdentity(input: Partial<AccountIdentity> | undefined, callerId: string): AccountIdentity {
  return {
    providerUserId: input?.providerUserId ?? input?.email ?? input?.username ?? callerId,
    ...(input?.email ? { email: input.email } : {}),
    ...(input?.username ? { username: input.username } : {}),
    ...(input?.workspaceName ? { workspaceName: input.workspaceName } : {}),
  };
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
  if (!credential.id || !credential.label || !credential.audience || !credential.injection) {
    throw new Error("Stored credential is missing URL-bound metadata");
  }
  return {
    id: credential.id,
    label: credential.label,
    accountIdentity: credential.accountIdentity,
    audience: credential.audience,
    injection: credential.injection,
    owner: credential.owner,
    scopes: credential.scopes,
    expiresAt: credential.expiresAt,
    revokedAt: credential.revokedAt,
    metadata: credential.metadata,
  };
}

function requireShellOrServer(ctx: ServiceContext, method: string): void {
  if (ctx.callerKind !== "shell" && ctx.callerKind !== "server") {
    throw new Error(`credentials.${method} is restricted to shell/server callers`);
  }
}

function canCallerUseCredential(ctx: ServiceContext, credential: Credential): boolean {
  if (credential.revokedAt) {
    return false;
  }
  if (credential.allowedCallers?.some((grant) => grant.callerId === ctx.callerId)) {
    return true;
  }
  if (credential.owner?.sourceId === ctx.callerId) {
    return true;
  }
  return false;
}

function grantForDecision(
  callerId: string,
  identity: { repoPath: string; effectiveVersion: string },
  decision: Exclude<GrantedDecision, "deny" | "once" | "session">,
  grantedAt: number,
): { callerId: string; grantedAt: number; grantedBy: string } {
  if (decision === "repo") {
    return { callerId: `repo:${identity.repoPath}`, grantedAt, grantedBy: decision };
  }
  if (decision === "version") {
    return { callerId: `version:${identity.repoPath}:${identity.effectiveVersion}`, grantedAt, grantedBy: decision };
  }
  return { callerId, grantedAt, grantedBy: decision };
}

function upsertGrant<T extends { callerId: string }>(grants: T[], grant: T): T[] {
  return [...grants.filter((entry) => entry.callerId !== grant.callerId), grant];
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
