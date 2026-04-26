import { z } from "zod";

export const flowConfigSchema = z.object({
  type: z.string(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  authorizeUrl: z.string().url().optional(),
  tokenUrl: z.string().url().optional(),
  deviceAuthUrl: z.string().url().optional(),
  command: z.string().optional(),
  jsonPath: z.string().optional(),
  probeUrl: z.string().url().optional(),
  resource: z.string().optional(),
  envVar: z.string().optional(),
  extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
  fixedScope: z.string().optional(),
  loopback: z.object({
    host: z.string().optional(),
    port: z.number().int().positive().optional(),
    callbackPath: z.string().optional(),
  }).optional(),
  tokenMetadata: z.record(z.string(), z.object({
    source: z.enum(["jwt-claim", "response-field"]),
    path: z.string(),
  })).optional(),
}).passthrough();

export const authInjectionSchema = z.object({
  type: z.enum(["header", "query-param"]),
  headerName: z.string().optional(),
  valueTemplate: z.string().optional(),
  paramName: z.string().optional(),
  stripHeaders: z.array(z.string()).optional(),
}).refine((value) => value.type !== "header" || value.headerName || value.valueTemplate || !value.paramName, {
  message: "Header auth injection cannot use paramName",
}).refine((value) => value.type !== "query-param" || value.paramName, {
  message: "Query-param auth injection requires paramName",
});

export const capabilityShapeSchema = z.union([
  z.object({ kind: z.literal("opaque"), totalLength: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("prefixed-opaque"), prefix: z.string(), bodyLength: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("jwt-passthrough") }),
]);

export const providerManifestSchema = z.object({
  id: z.string().min(1).max(128),
  displayName: z.string().min(1).max(256),
  apiBase: z.array(z.string().url()).min(1),
  flows: z.array(flowConfigSchema).default([]),
  authInjection: authInjectionSchema.optional(),
  scopes: z.record(z.string(), z.string()).optional(),
  scopeDescriptions: z.record(z.string(), z.string()).optional(),
  rateLimits: z.object({
    requestsPerSecond: z.number().positive().optional(),
    burstSize: z.number().int().positive().optional(),
    strategy: z.enum(["delay", "fail-fast"]).optional(),
  }).optional(),
  retry: z.object({
    maxAttempts: z.number().int().nonnegative().optional(),
    initialDelayMs: z.number().int().nonnegative().optional(),
    maxDelayMs: z.number().int().nonnegative().optional(),
    idempotentOnly: z.boolean().optional(),
  }).optional(),
  refreshBufferSeconds: z.number().int().nonnegative().optional(),
  capabilityShape: capabilityShapeSchema.optional(),
  whoami: z.object({
    url: z.string().url(),
    identityPath: z.object({
      email: z.string().optional(),
      username: z.string().optional(),
      workspaceName: z.string().optional(),
      providerUserId: z.string(),
    }),
  }).optional(),
  webhooks: z.object({
    subscriptions: z.array(z.object({
      event: z.string(),
      delivery: z.enum(["https-post", "pubsub-push"]),
      verify: z.string().optional(),
      watch: z.object({
        type: z.string(),
        renewEveryHours: z.number().positive().optional(),
      }).optional(),
    })).optional(),
  }).optional(),
}).passthrough();

export type ProviderManifestInput = z.infer<typeof providerManifestSchema>;
