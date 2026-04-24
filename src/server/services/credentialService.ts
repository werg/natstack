import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { CredentialStore } from "../../../packages/shared/src/credentials/store.js";
import { ConsentGrantStore } from "../../../packages/shared/src/credentials/consent.js";
import { AuditLog } from "../../../packages/shared/src/credentials/audit.js";
import { ProviderRegistry } from "../../../packages/shared/src/credentials/registry.js";
import { FlowResolver } from "../../../packages/shared/src/credentials/resolver.js";
import { builtinFlows } from "../../../packages/shared/src/credentials/flows/index.js";
import { builtinProviders } from "../../../packages/shared/src/credentials/providers/index.js";
import type { ServiceDefinition } from "../../../packages/shared/src/serviceDefinition.js";
import type {
  AuditEntry,
  ConsentGrant,
  Credential,
  CredentialHandle,
} from "../../../packages/shared/src/credentials/types.js";
import type { WebhookSubscription } from "../../../packages/shared/src/webhooks/types.js";

interface PendingConsent {
  nonce: string;
  providerId: string;
  scopes: string[];
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
  /** Caller-id of the worker / panel / shell that initiated the consent.
   *  `completeConsent` rejects if the completing caller does not match,
   *  preventing cross-caller consent hijack. */
  initiatorCallerId: string;
}

/**
 * Strict charset for user-controlled identifiers crossing the RPC
 * boundary. Mirrors the regex in §6/T6 of the audit (`store.ts` fix is
 * Agent 4's territory; this regex is the boundary defense).
 */
const IDENTIFIER_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/;
const identifierSchema = z
  .string()
  .regex(IDENTIFIER_REGEX, "Invalid identifier (must be a safe path component matching /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/)");
const optionalIdentifierSchema = identifierSchema.optional();
const nonceSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,128}$/, "Invalid nonce");
const uuidSchema = z.string().uuid();

/** Pending-consent TTL — entries older than this are eligible for the
 *  reaper sweep below. Matches the auth-flow TTL constant. */
const PENDING_CONSENT_TTL_MS = 10 * 60 * 1000;
const PENDING_CONSENT_REAP_INTERVAL_MS = 60 * 1000;

interface CredentialServiceDeps {
  credentialStore?: CredentialStore;
  consentStore?: ConsentGrantStore;
  auditLog?: AuditLog;
  providerRegistry?: ProviderRegistry;
  flowResolver?: FlowResolver;
}

const redirectModeSchema = z.enum([
  "server-loopback",
  "client-loopback",
  "mobile-universal",
]);

const beginConsentParamsSchema = z.object({
  providerId: identifierSchema,
  scopes: z.array(z.string().max(256)),
  accountHint: z.string().max(256).optional(),
  role: z.string().max(64).optional(),
  redirect: redirectModeSchema,
}).strict();

const completeConsentParamsSchema = z.object({
  nonce: nonceSchema,
  code: z.string().min(1).max(4096),
}).strict();

const requestConsentParamsSchema = z.object({
  providerId: identifierSchema,
  scopes: z.array(z.string().max(256)).optional(),
  accountHint: z.string().max(256).optional(),
  role: z.string().max(64).optional(),
}).strict();

const revokeConsentParamsSchema = z.object({
  providerId: identifierSchema,
  connectionId: optionalIdentifierSchema,
}).strict();

const listConsentParamsSchema = z.object({ workerId: optionalIdentifierSchema }).strict();

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
  workerId: identifierSchema,
}).strict();

const unsubscribeWebhookParamsSchema = z.object({
  subscriptionId: identifierSchema,
}).strict();

type BeginConsentParams = z.infer<typeof beginConsentParamsSchema>;
type CompleteConsentParams = z.infer<typeof completeConsentParamsSchema>;
type RequestConsentParams = z.infer<typeof requestConsentParamsSchema>;
type RevokeConsentParams = z.infer<typeof revokeConsentParamsSchema>;
type ListConsentParams = z.infer<typeof listConsentParamsSchema>;
type ListConnectionsParams = z.infer<typeof listConnectionsParamsSchema>;
type RenameConnectionParams = z.infer<typeof renameConnectionParamsSchema>;
type AuditParams = z.infer<typeof auditParamsSchema>;
type SubscribeWebhookParams = z.infer<typeof subscribeWebhookParamsSchema>;
type UnsubscribeWebhookParams = z.infer<typeof unsubscribeWebhookParamsSchema>;

type ConsentResult = Pick<CredentialHandle, "connectionId" | "apiBase">;
type Connection = Pick<
  Credential,
  "providerId" | "connectionId" | "connectionLabel" | "accountIdentity" | "scopes" | "expiresAt"
>;
type WebhookSubscriptionResult = Pick<WebhookSubscription, "subscriptionId">;

export function createCredentialService(deps: CredentialServiceDeps = {}): ServiceDefinition {
  const credentialStore = deps.credentialStore ?? new CredentialStore();
  const consentStore = deps.consentStore;
  const auditLog = deps.auditLog;
  const registry = deps.providerRegistry ?? new ProviderRegistry();
  const flowResolver = deps.flowResolver ?? new FlowResolver(builtinFlows);
  const pendingConsents = new Map<string, PendingConsent>();

  // SECURITY: reap expired pending consents on a fixed cadence so stale
  // entries cannot pile up and so the consent codeVerifier does not
  // outlive its TTL. `unref()` so this timer never holds the event loop
  // alive (matches the same pattern used by authFlowService).
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

    const pkceFlow = manifest.flows.find(f => f.type === "loopback-pkce");
    if (!pkceFlow?.authorizeUrl || !pkceFlow.clientId) {
      throw new Error(`Provider ${params.providerId} does not support browser-based OAuth`);
    }

    const nonce = randomBytes(16).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const { createHash } = await import("node:crypto");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

    const authorizeUrl = new URL(pkceFlow.authorizeUrl);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", pkceFlow.clientId);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", nonce);

    if (params.scopes.length > 0) {
      const resolvedScopes = params.scopes
        .map(s => manifest.scopes?.[s] ?? s)
        .join(" ");
      authorizeUrl.searchParams.set("scope", resolvedScopes);
    }

    let redirectUri = "";
    switch (params.redirect) {
      case "server-loopback":
        redirectUri = "http://127.0.0.1:0/oauth/callback";
        break;
      case "client-loopback":
        redirectUri = "http://127.0.0.1/oauth/callback";
        break;
      case "mobile-universal":
        redirectUri = "natstack://oauth/callback";
        break;
    }
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
    // SECURITY: enforce TTL even if reaper is paused (defense-in-depth).
    if (Date.now() - pending.createdAt > PENDING_CONSENT_TTL_MS) {
      pendingConsents.delete(params.nonce);
      throw new Error("Consent nonce expired");
    }
    // SECURITY: bind state verification to the initiating caller. The
    // 16-byte random nonce already proves possession of the begin-consent
    // response, but we additionally require the completing caller to
    // match the initiator so a token leaked between callers cannot be
    // redeemed by a different caller.
    if (pending.initiatorCallerId !== callerId) {
      throw new Error("Consent caller mismatch");
    }
    pendingConsents.delete(params.nonce);

    const manifest = registry.get(pending.providerId);
    if (!manifest) {
      throw new Error(`Unknown provider: ${pending.providerId}`);
    }

    const pkceFlow = manifest.flows.find(f => f.type === "loopback-pkce");
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

    const tokenResponse = await fetch(pkceFlow.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text();
      throw new Error(`Token exchange failed: ${tokenResponse.status} ${errorBody}`);
    }

    const tokenData = (await tokenResponse.json()) as Record<string, unknown>;
    const accessToken = tokenData["access_token"];
    const refreshToken = tokenData["refresh_token"];
    const expiresIn = tokenData["expires_in"];

    if (typeof accessToken !== "string") {
      throw new Error("Token exchange did not return an access_token");
    }

    const connectionId = randomUUID();
    const credential: Credential = {
      providerId: pending.providerId,
      connectionId,
      connectionLabel: manifest.displayName,
      accountIdentity: { providerUserId: connectionId },
      accessToken,
      refreshToken: typeof refreshToken === "string" ? refreshToken : undefined,
      scopes: pending.scopes,
      expiresAt: typeof expiresIn === "number" ? Date.now() + expiresIn * 1000 : undefined,
    };

    await credentialStore.save(credential);

    return { connectionId, apiBase: manifest.apiBase };
  }

  async function requestConsent(params: RequestConsentParams): Promise<CredentialHandle> {
    const manifest = registry.get(params.providerId);
    if (!manifest) {
      throw new Error(`Unknown provider: ${params.providerId}`);
    }

    const credential = await flowResolver.resolve(manifest.flows);

    const savedCredential: Credential = {
      ...credential,
      providerId: params.providerId,
      scopes: params.scopes ?? credential.scopes,
    };
    await credentialStore.save(savedCredential);

    return {
      connectionId: savedCredential.connectionId,
      apiBase: manifest.apiBase,
      fetch: async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("X-Natstack-Connection", savedCredential.connectionId);
        return globalThis.fetch(url, { ...init, headers });
      },
    };
  }

  async function revokeConsent(params: RevokeConsentParams): Promise<void> {
    // SECURITY (#33 in audit report): reject the "wipe all consents for
    // a provider" branch. Callers MUST specify the exact connectionId
    // they want to revoke; a missing/empty value is no longer a wildcard.
    if (!params.connectionId || params.connectionId.length === 0) {
      throw new Error("revokeConsent requires an explicit connectionId");
    }
    await credentialStore.remove(params.providerId, params.connectionId);
  }

  async function listConsent(params: ListConsentParams): Promise<ConsentGrant[]> {
    if (!consentStore || !params.workerId) {
      return [];
    }
    return consentStore.list(params.workerId);
  }

  async function listConnections(params: ListConnectionsParams): Promise<Connection[]> {
    const credentials = await credentialStore.list(params.providerId);
    return credentials.map(c => ({
      providerId: c.providerId,
      connectionId: c.connectionId,
      connectionLabel: c.connectionLabel,
      accountIdentity: c.accountIdentity,
      scopes: c.scopes,
      expiresAt: c.expiresAt,
    }));
  }

  async function renameConnection(params: RenameConnectionParams): Promise<void> {
    const allCredentials = await credentialStore.list();
    const credential = allCredentials.find(c => c.connectionId === params.connectionId);
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

  async function subscribeWebhook(_params: SubscribeWebhookParams): Promise<WebhookSubscriptionResult> {
    throw new Error("Webhook subscriptions are managed by webhookService");
  }

  async function unsubscribeWebhook(_params: UnsubscribeWebhookParams): Promise<void> {
    throw new Error("Webhook subscriptions are managed by webhookService");
  }

  return {
    name: "credentials",
    description: "Credential consent, connection, audit, and webhook management",
    policy: { allowed: ["shell", "panel", "server", "worker"] },
    methods: {
      beginConsent: {
        args: z.tuple([beginConsentParamsSchema]),
      },
      completeConsent: {
        args: z.tuple([completeConsentParamsSchema]),
      },
      requestConsent: {
        args: z.tuple([requestConsentParamsSchema]),
      },
      revokeConsent: {
        args: z.tuple([revokeConsentParamsSchema]),
      },
      listConsent: {
        args: z.tuple([listConsentParamsSchema]),
      },
      listConnections: {
        args: z.tuple([listConnectionsParamsSchema]),
      },
      renameConnection: {
        args: z.tuple([renameConnectionParamsSchema]),
      },
      audit: {
        args: z.tuple([auditParamsSchema]),
      },
      subscribeWebhook: {
        args: z.tuple([subscribeWebhookParamsSchema]),
      },
      unsubscribeWebhook: {
        args: z.tuple([unsubscribeWebhookParamsSchema]),
      },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "beginConsent":
          return beginConsent((args as [BeginConsentParams])[0], ctx.callerId);
        case "completeConsent":
          return completeConsent((args as [CompleteConsentParams])[0], ctx.callerId);
        case "requestConsent":
          return requestConsent((args as [RequestConsentParams])[0]);
        case "revokeConsent":
          return revokeConsent((args as [RevokeConsentParams])[0]);
        case "listConsent":
          return listConsent((args as [ListConsentParams])[0]);
        case "listConnections":
          return listConnections((args as [ListConnectionsParams])[0]);
        case "renameConnection":
          return renameConnection((args as [RenameConnectionParams])[0]);
        case "audit":
          return audit((args as [AuditParams])[0]);
        case "subscribeWebhook":
          return subscribeWebhook((args as [SubscribeWebhookParams])[0]);
        case "unsubscribeWebhook":
          return unsubscribeWebhook((args as [UnsubscribeWebhookParams])[0]);
        default:
          throw new Error(`Unknown credentials method: ${method}`);
      }
    },
  };
}
