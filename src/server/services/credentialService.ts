import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { CredentialStore } from "../../../packages/shared/src/credentials/store.js";
import { ConsentGrantStore } from "../../../packages/shared/src/credentials/consent.js";
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
}

interface CredentialServiceDeps {
  credentialStore?: CredentialStore;
  consentStore?: ConsentGrantStore;
  providerRegistry?: ProviderRegistry;
  flowResolver?: FlowResolver;
}

const redirectModeSchema = z.enum([
  "server-loopback",
  "client-loopback",
  "mobile-universal",
]);

const beginConsentParamsSchema = z.object({
  providerId: z.string(),
  scopes: z.array(z.string()),
  accountHint: z.string().optional(),
  role: z.string().optional(),
  redirect: redirectModeSchema,
}).strict();

const completeConsentParamsSchema = z.object({
  nonce: z.string(),
  code: z.string(),
}).strict();

const requestConsentParamsSchema = z.object({
  providerId: z.string(),
  scopes: z.array(z.string()).optional(),
  accountHint: z.string().optional(),
  role: z.string().optional(),
}).strict();

const revokeConsentParamsSchema = z.object({
  providerId: z.string(),
  connectionId: z.string().optional(),
}).strict();

const listConsentParamsSchema = z.object({}).strict();

const listConnectionsParamsSchema = z.object({
  providerId: z.string().optional(),
}).strict();

const renameConnectionParamsSchema = z.object({
  connectionId: z.string(),
  label: z.string(),
}).strict();

const auditFilterSchema = z.object({
  workerId: z.string().optional(),
  callerId: z.string().optional(),
  providerId: z.string().optional(),
  connectionId: z.string().optional(),
  method: z.string().optional(),
  url: z.string().optional(),
  status: z.number().optional(),
  capabilityViolation: z.string().optional(),
  breakerState: z.enum(["closed", "open", "half-open"]).optional(),
}).strict();

const auditParamsSchema = z.object({
  filter: auditFilterSchema.optional(),
  limit: z.number().int().positive().optional(),
  after: z.number().optional(),
}).strict();

const subscribeWebhookParamsSchema = z.object({
  providerId: z.string(),
  eventType: z.string(),
  workerId: z.string(),
}).strict();

const unsubscribeWebhookParamsSchema = z.object({
  subscriptionId: z.string(),
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
  const registry = deps.providerRegistry ?? new ProviderRegistry();
  const flowResolver = deps.flowResolver ?? new FlowResolver(builtinFlows);
  const pendingConsents = new Map<string, PendingConsent>();

  for (const manifest of builtinProviders) {
    registry.register(manifest);
  }

  async function beginConsent(params: BeginConsentParams): Promise<{ nonce: string; authorizeUrl: string }> {
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

    pendingConsents.set(nonce, {
      nonce,
      providerId: params.providerId,
      scopes: params.scopes,
      codeVerifier,
      redirectUri: "",
      createdAt: Date.now(),
    });

    return { nonce, authorizeUrl: authorizeUrl.toString() };
  }

  async function completeConsent(params: CompleteConsentParams): Promise<ConsentResult> {
    const pending = pendingConsents.get(params.nonce);
    if (!pending) {
      throw new Error("Unknown or expired consent nonce");
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
    if (params.connectionId) {
      await credentialStore.remove(params.providerId, params.connectionId);
    } else {
      const creds = await credentialStore.list(params.providerId);
      for (const cred of creds) {
        await credentialStore.remove(params.providerId, cred.connectionId);
      }
    }
  }

  async function listConsent(_params: ListConsentParams): Promise<ConsentGrant[]> {
    return [];
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

  async function audit(_params: AuditParams): Promise<AuditEntry[]> {
    return [];
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
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "beginConsent":
          return beginConsent((args as [BeginConsentParams])[0]);
        case "completeConsent":
          return completeConsent((args as [CompleteConsentParams])[0]);
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
