import { z } from "zod";
import type { ServiceDefinition } from "../../../packages/shared/src/serviceDefinition.js";
import type {
  AuditEntry,
  ConsentGrant,
  Credential,
  CredentialHandle,
} from "../../../packages/shared/src/credentials/types.js";
import type { WebhookSubscription } from "../../../packages/shared/src/webhooks/types.js";

class NotImplemented extends Error {
  constructor(method: string) {
    super(`${method} is not implemented`);
    this.name = "NotImplemented";
  }
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

async function beginConsent(_params: BeginConsentParams): Promise<{ nonce: string; authorizeUrl: string }> {
  throw new NotImplemented("credentials.beginConsent");
}

async function completeConsent(_params: CompleteConsentParams): Promise<ConsentResult> {
  throw new NotImplemented("credentials.completeConsent");
}

async function requestConsent(_params: RequestConsentParams): Promise<CredentialHandle> {
  throw new NotImplemented("credentials.requestConsent");
}

async function revokeConsent(_params: RevokeConsentParams): Promise<void> {
  throw new NotImplemented("credentials.revokeConsent");
}

async function listConsent(_params: ListConsentParams): Promise<ConsentGrant[]> {
  throw new NotImplemented("credentials.listConsent");
}

async function listConnections(_params: ListConnectionsParams): Promise<Connection[]> {
  throw new NotImplemented("credentials.listConnections");
}

async function renameConnection(_params: RenameConnectionParams): Promise<void> {
  throw new NotImplemented("credentials.renameConnection");
}

async function audit(_params: AuditParams): Promise<AuditEntry[]> {
  throw new NotImplemented("credentials.audit");
}

async function subscribeWebhook(_params: SubscribeWebhookParams): Promise<WebhookSubscriptionResult> {
  throw new NotImplemented("credentials.subscribeWebhook");
}

async function unsubscribeWebhook(_params: UnsubscribeWebhookParams): Promise<void> {
  throw new NotImplemented("credentials.unsubscribeWebhook");
}

export function createCredentialService(): ServiceDefinition {
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
