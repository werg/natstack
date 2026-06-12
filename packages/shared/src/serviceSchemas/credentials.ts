/**
 * credentials service method schemas.
 *
 * The credentials service has a large request surface. Keep the validation
 * contract here, not in the server registration, so typed clients and service
 * dispatch share one wire schema.
 */

import { z } from "zod";
import type {
  AccountIdentity,
  AuditEntry,
  ClientConfigStatus,
  CredentialBinding,
  ForwardOAuthCallbackRequest,
  ProxyGitHttpResponse,
  StoredCredentialSummary,
  UrlAudience,
} from "../credentials/types.js";
import type { DeferredResult } from "../serviceDispatcher.js";
import { isDeferredResult } from "../serviceDispatcher.js";
import { defineServiceMethods } from "../typedServiceClient.js";

const IDENTIFIER_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/;

export const IdentifierSchema = z
  .string()
  .regex(
    IDENTIFIER_REGEX,
    "Invalid identifier (must be a safe path component matching /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/)"
  );

const UrlAudienceMatchSchema = z.enum(["origin", "path-prefix", "exact"]);

export const UrlAudienceSchema = z
  .object({
    url: z.string().url(),
    match: UrlAudienceMatchSchema.optional(),
  })
  .strict();

export const UrlAudienceOutputSchema = z
  .object({
    url: z.string().url(),
    match: UrlAudienceMatchSchema,
  })
  .strict() satisfies z.ZodType<UrlAudience>;

export const CredentialInjectionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("header"),
      name: z.string().min(1).max(128),
      valueTemplate: z.string().min(1).max(256),
      stripIncoming: z.array(z.string().min(1).max(128)).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("query-param"),
      name: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("basic-auth"),
      usernameTemplate: z.string().min(1).max(256),
      passwordTemplate: z.string().min(1).max(256),
      stripIncoming: z.array(z.string().min(1).max(128)).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("oauth1-signature"),
    })
    .strict(),
  z
    .object({
      type: z.literal("cookie"),
    })
    .strict(),
  z
    .object({
      type: z.literal("aws-sigv4"),
      service: IdentifierSchema,
      region: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("ssh-key"),
    })
    .strict(),
]);

export const CredentialBindingSchema = z
  .object({
    id: IdentifierSchema,
    use: z.enum(["fetch", "git-http", "git-ssh"]),
    audience: z.array(UrlAudienceSchema).min(1).max(16),
    injection: CredentialInjectionSchema,
  })
  .strict();

const CredentialBindingOutputSchema = z
  .object({
    id: IdentifierSchema,
    use: z.enum(["fetch", "git-http", "git-ssh"]),
    audience: z.array(UrlAudienceOutputSchema).min(1).max(16),
    injection: CredentialInjectionSchema,
  })
  .strict() satisfies z.ZodType<CredentialBinding>;

export const AccountIdentityInputSchema = z
  .object({
    email: z.string().max(320).optional(),
    username: z.string().max(256).optional(),
    workspaceName: z.string().max(256).optional(),
    providerUserId: z.string().max(256).optional(),
  })
  .strict();

export const AccountIdentitySchema = z
  .object({
    email: z.string().max(320).optional(),
    username: z.string().max(256).optional(),
    workspaceName: z.string().max(256).optional(),
    providerUserId: z.string().max(256),
  })
  .strict() satisfies z.ZodType<AccountIdentity>;

export const OAuthAccountValidationSchema = z
  .object({
    userinfo: z
      .object({
        url: z.string().url(),
        idField: z.string().min(1).max(128).optional(),
        emailField: z.string().min(1).max(128).optional(),
        usernameField: z.string().min(1).max(128).optional(),
        workspaceField: z.string().min(1).max(128).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const StoreUrlBoundCredentialParamsSchema = z
  .object({
    label: z.string().min(1).max(256),
    audience: z.array(UrlAudienceSchema).min(1).max(16),
    injection: CredentialInjectionSchema,
    bindings: z.array(CredentialBindingSchema).min(1).max(8).optional(),
    material: z
      .object({
        type: z.enum([
          "bearer-token",
          "api-key",
          "oauth1-token",
          "cookie-session",
          "saml-session",
          "aws-sigv4",
          "ssh-key",
        ]),
        token: z.string().min(1).max(65536),
      })
      .strict(),
    accountIdentity: AccountIdentityInputSchema.optional(),
    scopes: z.array(z.string().max(256)).optional(),
    expiresAt: z.number().positive().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const ConnectCredentialDetailsSchema = z
  .object({
    label: z.string().min(1).max(256),
    audience: z.array(UrlAudienceSchema).min(1).max(16),
    injection: CredentialInjectionSchema,
    bindings: z.array(CredentialBindingSchema).min(1).max(8).optional(),
    accountIdentity: AccountIdentityInputSchema.optional(),
    scopes: z.array(z.string().max(256)).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const ClientConfigFieldSchema = z
  .object({
    name: IdentifierSchema,
    label: z.string().min(1).max(128),
    type: z.enum(["text", "secret"]),
    required: z.boolean().optional(),
    description: z.string().max(512).optional(),
  })
  .strict();

export const RequestClientConfigParamsSchema = z
  .object({
    configId: IdentifierSchema,
    title: z.string().min(1).max(256),
    description: z.string().max(1024).optional(),
    authorizeUrl: z.string().url(),
    tokenUrl: z.string().url(),
    fields: z.array(ClientConfigFieldSchema).min(1).max(16),
  })
  .strict();

export const CredentialFlowTypeSchema = z.enum([
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

export const ConfigureClientParamsSchema = RequestClientConfigParamsSchema.extend({
  flowTypes: z.array(CredentialFlowTypeSchema).min(1).max(8).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  allowRefreshWhenDisabled: z.boolean().optional(),
}).strict();

export const RequestCredentialInputParamsSchema = z
  .object({
    title: z.string().min(1).max(256),
    description: z.string().max(1024).optional(),
    credential: ConnectCredentialDetailsSchema,
    fields: z.array(ClientConfigFieldSchema).length(1),
    material: z
      .object({
        type: z.enum(["bearer-token", "api-key"]),
        tokenField: IdentifierSchema,
      })
      .strict(),
  })
  .strict();

export const GetClientConfigStatusParamsSchema = z
  .object({
    configId: IdentifierSchema,
    fields: z.array(ClientConfigFieldSchema).max(16).optional(),
  })
  .strict();

export const OAuthRedirectStrategySchema = z
  .object({
    type: z.enum(["loopback", "public", "client-forwarded", "client-loopback"]).optional(),
    host: z.string().optional(),
    port: z.number().int().min(0).max(65535).optional(),
    callbackPath: z.string().optional(),
    callbackUri: z.string().url().optional(),
    fallback: z.literal("dynamic-port").optional(),
  })
  .strict();

export const TokenAuthSchema = z.enum([
  "none",
  "client_secret_post",
  "client_secret_basic",
  "private_key_jwt",
]);

export const BrowserHandoffTargetSchema = z
  .object({
    callerId: z.string().min(1).max(512),
    callerKind: z.enum(["app", "panel", "shell"]),
  })
  .strict();

export const ConnectCredentialSpecSchema = z
  .object({
    flow: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("oauth2-auth-code-pkce"),
          authorizeUrl: z.string().url().optional(),
          tokenUrl: z.string().url().optional(),
          clientId: z.string().min(1).max(512).optional(),
          clientConfigId: IdentifierSchema.optional(),
          scopes: z.array(z.string().max(256)).optional(),
          extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
          tokenAuth: TokenAuthSchema.optional(),
          persistRefreshToken: z.boolean().optional(),
          allowMissingExpiry: z.boolean().optional(),
          accountValidation: OAuthAccountValidationSchema.optional(),
          revocationUrl: z.string().url().optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("oauth2-auth-code"),
          authorizeUrl: z.string().url().optional(),
          tokenUrl: z.string().url().optional(),
          clientId: z.string().min(1).max(512).optional(),
          clientConfigId: IdentifierSchema.optional(),
          scopes: z.array(z.string().max(256)).optional(),
          extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
          tokenAuth: TokenAuthSchema.optional(),
          persistRefreshToken: z.boolean().optional(),
          accountValidation: OAuthAccountValidationSchema.optional(),
          revocationUrl: z.string().url().optional(),
          pkce: z.literal(false),
          compatibilityReason: z.string().min(1).max(1024),
          requiresConfidentialClient: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("oauth2-device-code"),
          deviceAuthorizationUrl: z.string().url(),
          tokenUrl: z.string().url(),
          clientId: z.string().min(1).max(512).optional(),
          clientConfigId: IdentifierSchema.optional(),
          scopes: z.array(z.string().max(256)).optional(),
          tokenAuth: TokenAuthSchema.optional(),
          pollIntervalSeconds: z.number().int().positive().optional(),
          expiresInSeconds: z.number().int().positive().optional(),
          accountValidation: OAuthAccountValidationSchema.optional(),
          persistRefreshToken: z.boolean().optional(),
          revocationUrl: z.string().url().optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("oauth2-client-credentials"),
          tokenUrl: z.string().url(),
          clientConfigId: IdentifierSchema,
          tokenAuth: z.enum(["client_secret_post", "client_secret_basic", "private_key_jwt"]),
          scopes: z.array(z.string().max(256)).optional(),
          audienceParam: z.string().max(512).optional(),
          resourceParam: z.string().max(512).optional(),
          accountValidation: OAuthAccountValidationSchema.optional(),
          revocationUrl: z.string().url().optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("oauth2-jwt-bearer"),
          tokenUrl: z.string().url(),
          clientConfigId: IdentifierSchema,
          issuer: z.string().min(1).max(512).optional(),
          subject: z.string().min(1).max(512).optional(),
          audience: z.string().min(1).max(2048).optional(),
          scopes: z.array(z.string().max(256)).optional(),
          accountValidation: OAuthAccountValidationSchema.optional(),
          persistRefreshToken: z.boolean().optional(),
          revocationUrl: z.string().url().optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("oauth2-token-exchange"),
          tokenUrl: z.string().url(),
          clientConfigId: IdentifierSchema,
          subjectCredentialId: IdentifierSchema,
          subjectTokenType: z.enum(["access_token", "jwt"]).optional(),
          requestedTokenType: z.string().min(1).max(512).optional(),
          scopes: z.array(z.string().max(256)).optional(),
          audience: z.string().min(1).max(2048).optional(),
          resource: z.string().min(1).max(2048).optional(),
          tokenAuth: z
            .enum(["client_secret_post", "client_secret_basic", "private_key_jwt"])
            .optional(),
          accountValidation: OAuthAccountValidationSchema.optional(),
          persistRefreshToken: z.boolean().optional(),
          revocationUrl: z.string().url().optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("oauth1a"),
          requestTokenUrl: z.string().url(),
          authorizeUrl: z.string().url(),
          accessTokenUrl: z.string().url(),
          clientConfigId: IdentifierSchema,
          callbackConfirmedParam: z.string().max(128).optional(),
          signatureMethod: z.literal("HMAC-SHA1").optional(),
          accountValidation: z.enum(["none", "http-probe"]).optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("api-key"),
          title: z.string().min(1).max(256).optional(),
          description: z.string().max(1024).optional(),
          fields: z.array(ClientConfigFieldSchema).min(1).max(16),
          materialTemplate: z
            .object({
              type: z.enum(["bearer-token", "api-key"]),
              valueTemplate: z.string().min(1).max(4096),
            })
            .strict(),
          accountValidation: z.enum(["http-probe", "none"]).optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("aws-sigv4"),
          title: z.string().min(1).max(256).optional(),
          description: z.string().max(1024).optional(),
          accountValidation: z.enum(["http-probe", "none"]).optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("ssh-key"),
          mode: z.enum(["generate", "import"]).optional(),
          algorithm: z.literal("ed25519").optional(),
          title: z.string().min(1).max(256).optional(),
          description: z.string().max(1024).optional(),
          accountValidation: z.literal("none").optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("browser-cookie-session"),
          signInUrl: z.string().url(),
          capture: z
            .object({
              cookies: z.array(z.string().min(1).max(256)).min(1).max(64),
              origins: z.array(z.string().url()).min(1).max(16),
            })
            .strict(),
          completionUrlPattern: z.string().max(1024).optional(),
          accountValidation: z.enum(["http-probe", "none"]).optional(),
          maxTtlSeconds: z.number().int().positive().optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("saml-browser-session"),
          signInUrl: z.string().url(),
          spAudience: z.string().min(1).max(2048),
          capture: z
            .object({
              cookies: z.array(z.string().min(1).max(256)).min(1).max(64).optional(),
              assertion: z
                .object({
                  issuer: z.string().min(1).max(2048),
                  audience: z.string().min(1).max(2048),
                  recipient: z.string().min(1).max(2048),
                  persistAssertion: z.boolean().optional(),
                })
                .strict()
                .optional(),
            })
            .strict(),
          completionUrlPattern: z.string().max(1024).optional(),
          maxTtlSeconds: z.number().int().positive().optional(),
          accountValidation: z.enum(["saml-assertion-claims", "http-probe", "none"]).optional(),
        })
        .strict(),
    ]),
    credential: ConnectCredentialDetailsSchema,
    redirect: OAuthRedirectStrategySchema.optional(),
    browser: z.enum(["external", "internal"]).optional(),
  })
  .strict();

export const ConnectCredentialParamsSchema = z.union([
  ConnectCredentialSpecSchema,
  z
    .object({
      spec: ConnectCredentialSpecSchema,
      handoffTarget: BrowserHandoffTargetSchema,
    })
    .strict(),
]);

export const DeleteClientConfigParamsSchema = z
  .object({
    configId: IdentifierSchema,
  })
  .strict();

export const ForwardOAuthCallbackParamsSchema = z
  .object({
    transactionId: IdentifierSchema.optional(),
    url: z.string().url().optional(),
    code: z.string().min(1).max(4096).optional(),
    state: z.string().min(1).max(4096).optional(),
  })
  .strict() satisfies z.ZodType<ForwardOAuthCallbackRequest>;

export const CredentialIdParamsSchema = z
  .object({
    credentialId: IdentifierSchema,
  })
  .strict();

export const GrantCredentialParamsSchema = z
  .object({
    credentialId: IdentifierSchema,
    callerId: IdentifierSchema,
    grantedBy: z.string().min(1).max(128).optional(),
  })
  .strict();

export const ResolveCredentialParamsSchema = z
  .object({
    url: z.string().url(),
    credentialId: IdentifierSchema.optional(),
    use: z.enum(["fetch", "git-http", "git-ssh"]).optional(),
  })
  .strict();

export const ProxyFetchParamsSchema = z
  .object({
    url: z.string().url(),
    method: z.string().min(1).max(16),
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
    bodyBase64: z.string().optional(),
    credentialId: IdentifierSchema.optional(),
  })
  .strict()
  .refine((p) => !(p.body !== undefined && p.bodyBase64 !== undefined), {
    message: "credentials.proxyFetch: provide either `body` or `bodyBase64`, not both",
  });

export const ProxyGitHttpParamsSchema = z
  .object({
    url: z.string().url(),
    method: z.string().min(1).max(16).optional(),
    headers: z.record(z.string()).optional(),
    bodyBase64: z.string().optional(),
    credentialId: IdentifierSchema.optional(),
  })
  .strict();

export const AuditParamsSchema = z
  .object({
    filter: z
      .object({
        providerId: z.string().optional(),
        connectionId: z.string().optional(),
        callerId: z.string().optional(),
        since: z.number().optional(),
      })
      .optional(),
    limit: z.number().int().positive().max(1000).optional(),
    after: z.number().optional(),
  })
  .strict();

const CredentialOwnerSchema = z
  .object({
    userProfileId: z.string().optional(),
    sourceId: z.string(),
    sourceKind: z.enum(["workspace", "package", "plugin", "user"]),
    label: z.string(),
  })
  .strict();

const StoredCredentialSummarySchema = z
  .object({
    id: z.string(),
    label: z.string(),
    accountIdentity: AccountIdentitySchema.optional(),
    audience: z.array(UrlAudienceOutputSchema),
    injection: CredentialInjectionSchema,
    bindings: z.array(CredentialBindingOutputSchema).optional(),
    owner: CredentialOwnerSchema.optional(),
    scopes: z.array(z.string()),
    expiresAt: z.number().optional(),
    revokedAt: z.number().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict() satisfies z.ZodType<StoredCredentialSummary>;

const ClientConfigFieldStatusSchema = z
  .object({
    configured: z.boolean(),
    type: z.enum(["text", "secret"]),
    updatedAt: z.number().optional(),
  })
  .strict();

const ClientConfigStatusSchema = z
  .object({
    configId: z.string(),
    configured: z.boolean(),
    authorizeUrl: z.string().url().optional(),
    tokenUrl: z.string().url().optional(),
    status: z.enum(["active", "disabled", "deleted"]).optional(),
    flowTypes: z.array(CredentialFlowTypeSchema).optional(),
    fields: z.record(ClientConfigFieldStatusSchema),
    updatedAt: z.number().optional(),
  })
  .strict() satisfies z.ZodType<ClientConfigStatus>;

const DeferredResultSchema = z.custom<DeferredResult>((value) => isDeferredResult(value), {
  message: "expected deferred result sentinel",
});

const CredentialProxyFetchResponseSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    statusText: z.string(),
    headerPairs: z.array(z.tuple([z.string(), z.string()])),
    finalUrl: z.string(),
    bodyBase64: z.string(),
  })
  .strict();

const ProxyGitHttpResponseSchema = z
  .object({
    url: z.string(),
    method: z.string(),
    statusCode: z.number().int(),
    statusMessage: z.string(),
    headers: z.record(z.string()),
    bodyBase64: z.string(),
  })
  .strict() satisfies z.ZodType<ProxyGitHttpResponse>;

const AuditEntrySchema = z
  .object({
    ts: z.number(),
    workerId: z.string(),
    callerId: z.string(),
    providerId: z.string(),
    connectionId: z.string(),
    method: z.string(),
    url: z.string(),
    status: z.number(),
    durationMs: z.number(),
    bytesIn: z.number(),
    bytesOut: z.number(),
    scopesUsed: z.array(z.string()),
    capabilityViolation: z.string().optional(),
    retries: z.number(),
    breakerState: z.enum(["closed", "open", "half-open"]),
  })
  .strict() satisfies z.ZodType<AuditEntry>;

const MaybeDeferredStoredCredentialSchema = z.union([
  StoredCredentialSummarySchema,
  DeferredResultSchema,
]);

export type StoreUrlBoundCredentialParams = z.infer<typeof StoreUrlBoundCredentialParamsSchema>;
export type RequestClientConfigParams = z.infer<typeof RequestClientConfigParamsSchema>;
export type ConfigureClientParams = z.infer<typeof ConfigureClientParamsSchema>;
export type RequestCredentialInputParams = z.infer<typeof RequestCredentialInputParamsSchema>;
export type GetClientConfigStatusParams = z.infer<typeof GetClientConfigStatusParamsSchema>;
export type ConnectCredentialParams = z.infer<typeof ConnectCredentialParamsSchema>;
export type DeleteClientConfigParams = z.infer<typeof DeleteClientConfigParamsSchema>;
export type ForwardOAuthCallbackParams = z.infer<typeof ForwardOAuthCallbackParamsSchema>;
export type CredentialIdParams = z.infer<typeof CredentialIdParamsSchema>;
export type GrantCredentialParams = z.infer<typeof GrantCredentialParamsSchema>;
export type ResolveCredentialParams = z.infer<typeof ResolveCredentialParamsSchema>;
export type ProxyFetchParams = z.infer<typeof ProxyFetchParamsSchema>;
export type ProxyGitHttpParams = z.infer<typeof ProxyGitHttpParamsSchema>;
export type AuditParams = z.infer<typeof AuditParamsSchema>;
export type CredentialProxyFetchRequest = ProxyFetchParams;
export type CredentialProxyFetchResponse = z.infer<typeof CredentialProxyFetchResponseSchema>;
export type CredentialAuditParams = AuditParams;

export const credentialsMethods = defineServiceMethods({
  storeCredential: {
    args: z.tuple([StoreUrlBoundCredentialParamsSchema]),
    returns: StoredCredentialSummarySchema,
  },
  connect: {
    args: z.tuple([ConnectCredentialParamsSchema]),
    returns: MaybeDeferredStoredCredentialSchema,
  },
  configureClient: {
    args: z.tuple([ConfigureClientParamsSchema]),
    returns: ClientConfigStatusSchema,
  },
  requestCredentialInput: {
    args: z.tuple([RequestCredentialInputParamsSchema]),
    returns: StoredCredentialSummarySchema,
  },
  getClientConfigStatus: {
    args: z.tuple([GetClientConfigStatusParamsSchema]),
    returns: ClientConfigStatusSchema,
  },
  deleteClientConfig: {
    args: z.tuple([DeleteClientConfigParamsSchema]),
    returns: z.void(),
  },
  forwardOAuthCallback: {
    args: z.tuple([ForwardOAuthCallbackParamsSchema]),
    returns: z.void(),
  },
  listStoredCredentials: {
    args: z.tuple([]),
    returns: z.array(StoredCredentialSummarySchema),
  },
  revokeCredential: {
    args: z.tuple([CredentialIdParamsSchema]),
    returns: z.void(),
  },
  grantCredential: {
    args: z.tuple([GrantCredentialParamsSchema]),
    returns: StoredCredentialSummarySchema,
  },
  resolveCredential: {
    args: z.tuple([ResolveCredentialParamsSchema]),
    returns: z.union([StoredCredentialSummarySchema, z.null(), DeferredResultSchema]),
  },
  proxyFetch: {
    args: z.tuple([ProxyFetchParamsSchema]),
    returns: CredentialProxyFetchResponseSchema,
  },
  proxyGitHttp: {
    args: z.tuple([ProxyGitHttpParamsSchema]),
    returns: ProxyGitHttpResponseSchema,
  },
  audit: {
    args: z.tuple([AuditParamsSchema]),
    returns: z.array(AuditEntrySchema),
  },
});
