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
  ManagedCredentialSummary,
  ProxyGitHttpResponse,
  StoredCredentialSummary,
  UrlAudience,
} from "../credentials/types.js";
import type { DeferredResult } from "../serviceDispatcher.js";
import { isDeferredResult } from "../serviceDispatcher.js";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

const IDENTIFIER_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/;

// Access descriptors shared across the credentials method groups. The
// service-level `policy` on the registration is still the enforced caller gate
// (we deliberately omit `access.callers` here); these descriptors carry the
// doc/safety metadata (sensitivity, approval gates) the capability catalog
// reads. `approval` entries declare the human-approval gates the handler may
// open at runtime; the dispatcher guard still performs the actual prompting.

/** Pure read: lists/queries that touch no persistent state (authorization
 *  checks only). */
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};

/** Stores a new URL-bound credential. Userland callers are prompted to approve
 *  the new credential before it is persisted. */
const STORE_CREDENTIAL_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
  approval: [
    {
      when: "caller is a userland runtime (panel/app/worker/do)",
      operation: { kind: "credential", verb: "Store credential" },
      grantScopes: ["once", "session", "version", "repo"],
      reason: "Persisting a credential the agent supplied requires the user to approve it.",
    },
  ],
};

/** Interactive connection flow: may open a browser handoff and prompt the user,
 *  and may return a DeferredResult for hibernatable DO callers. */
const CONNECT_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
  approval: [
    {
      when: "interactive flow / userland runtime caller",
      operation: { kind: "credential", verb: "Connect credential" },
      grantScopes: ["once", "session", "version", "repo"],
      reason:
        "Running an OAuth/browser sign-in flow and storing the result requires the user to authorize the connection.",
    },
  ],
};

/** Prompts the user to enter a secret, then stores the resulting credential. */
const REQUEST_CREDENTIAL_INPUT_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
  approval: [
    {
      operation: { kind: "credential", verb: "Enter credential" },
      grantScopes: ["once", "session", "version", "repo"],
      reason: "Collecting a secret from the user and storing it requires explicit user input.",
    },
  ],
};

/** Persists OAuth client configuration; userland callers are prompted to submit
 *  the client config material. */
const CONFIGURE_CLIENT_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
  approval: [
    {
      when: "caller is a userland runtime (panel/app/worker/do)",
      operation: { kind: "credential", verb: "Configure client" },
      reason: "Submitting OAuth client secrets requires the user to confirm the configuration.",
    },
  ],
};

/** Marks a client config deleted; userland callers are prompted to confirm. */
const DELETE_CLIENT_CONFIG_ACCESS: MethodAccessDescriptor = {
  sensitivity: "destructive",
  approval: [
    {
      when: "caller is a userland runtime (panel/app/worker/do)",
      capability: "client-config-delete",
      operation: { kind: "credential", verb: "Disable client configuration" },
      reason: "Disabling a client config breaks new connections and refreshes for that provider.",
    },
  ],
};

/** Resolves a stored credential for use; prompts for use approval when the
 *  caller is not already granted, and may return a DeferredResult. */
const RESOLVE_CREDENTIAL_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
  approval: [
    {
      when: "caller is not already granted use of the matched credential",
      operation: { kind: "credential", verb: "Use credential" },
      grantScopes: ["once", "session", "version", "repo"],
      reason: "Handing a stored credential to an agent for use requires the user to authorize it.",
    },
  ],
};

/** Revokes a stored credential (and best-effort revokes the upstream token). */
const REVOKE_CREDENTIAL_ACCESS: MethodAccessDescriptor = {
  sensitivity: "destructive",
};

/** Routes an inbound OAuth provider callback to its pending transaction. */
const FORWARD_OAUTH_CALLBACK_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

/** Egress: forwards an outbound request through the credential-injecting proxy. */
const PROXY_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const IdentifierSchema = z
  .string()
  .regex(
    IDENTIFIER_REGEX,
    "Invalid identifier (must be a safe path component matching /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/)"
  );

const UrlAudienceMatchSchema = z.enum(["origin", "path-prefix", "exact"]);

export const UrlAudienceSchema = z
  .object({
    url: z
      .string()
      .url()
      .describe("URL this credential is scoped to (origin/path are normalized)."),
    match: UrlAudienceMatchSchema.optional().describe(
      "How the audience URL is matched against request URLs: 'origin' (same scheme+host+port), 'path-prefix' (origin plus a path prefix), or 'exact'. Defaults to 'origin'."
    ),
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
      name: z.string().min(1).max(128).describe("Header name to inject (e.g. 'Authorization')."),
      valueTemplate: z
        .string()
        .min(1)
        .max(256)
        .describe("Header value template; '{token}' is substituted with the stored secret."),
      stripIncoming: z
        .array(z.string().min(1).max(128))
        .optional()
        .describe("Incoming header names to strip before injecting (prevents header smuggling)."),
    })
    .strict(),
  z
    .object({
      type: z.literal("query-param"),
      name: z.string().min(1).max(128).describe("Query parameter name the secret is appended as."),
    })
    .strict(),
  z
    .object({
      type: z.literal("basic-auth"),
      usernameTemplate: z
        .string()
        .min(1)
        .max(256)
        .describe("HTTP Basic username template ('{token}' substituted)."),
      passwordTemplate: z
        .string()
        .min(1)
        .max(256)
        .describe("HTTP Basic password template ('{token}' substituted)."),
      stripIncoming: z
        .array(z.string().min(1).max(128))
        .optional()
        .describe("Incoming header names to strip before injecting."),
    })
    .strict(),
  z
    .object({
      type: z
        .literal("oauth1-signature")
        .describe("Sign each request with an OAuth 1.0a HMAC-SHA1 signature."),
    })
    .strict(),
  z
    .object({
      type: z
        .literal("cookie")
        .describe("Replay the stored cookie/session header on each request."),
    })
    .strict(),
  z
    .object({
      type: z.literal("aws-sigv4"),
      service: IdentifierSchema.describe("AWS service name for SigV4 signing (e.g. 's3')."),
      region: IdentifierSchema.describe("AWS region for SigV4 signing (e.g. 'us-east-1')."),
    })
    .strict(),
  z
    .object({
      type: z.literal("ssh-key").describe("Authenticate via the stored SSH private key (git-ssh)."),
    })
    .strict(),
]);

export const CredentialBindingSchema = z
  .object({
    id: IdentifierSchema.describe("Stable id for this binding within the credential."),
    label: z.string().min(1).max(128).optional().describe("Human-readable label for the binding."),
    use: z
      .enum(["fetch", "git-http", "git-ssh"])
      .describe("Transport this binding applies to: HTTP fetch, git-over-HTTP, or git-over-SSH."),
    audience: z
      .array(UrlAudienceSchema)
      .min(1)
      .max(16)
      .describe("URLs this binding's credential may be injected into."),
    injection: CredentialInjectionSchema.describe("How the secret is injected for this binding."),
    grantResource: z
      .discriminatedUnion("type", [
        z
          .object({ type: z.literal("audience") })
          .strict()
          .describe("Grant approvals at the whole-audience granularity."),
        z
          .object({
            type: z.literal("url-path-prefix"),
            segmentCount: z
              .number()
              .int()
              .min(1)
              .max(8)
              .describe("Number of leading path segments that define the grant resource."),
          })
          .strict()
          .describe("Grant approvals scoped to a URL path-prefix resource."),
      ])
      .optional()
      .describe("Controls the granularity at which use-approvals are remembered."),
  })
  .strict();

const CredentialBindingOutputSchema = z
  .object({
    id: IdentifierSchema,
    label: z.string().min(1).max(128).optional(),
    use: z.enum(["fetch", "git-http", "git-ssh"]),
    audience: z.array(UrlAudienceOutputSchema).min(1).max(16),
    injection: CredentialInjectionSchema,
    grantResource: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("audience") }).strict(),
        z
          .object({
            type: z.literal("url-path-prefix"),
            segmentCount: z.number().int().min(1).max(8),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict() satisfies z.ZodType<CredentialBinding>;

export const AccountIdentityInputSchema = z
  .object({
    email: z.string().max(320).optional().describe("Account email, if known."),
    username: z.string().max(256).optional().describe("Account username/handle, if known."),
    workspaceName: z
      .string()
      .max(256)
      .optional()
      .describe("Workspace/tenant name for multi-tenant providers, if known."),
    providerUserId: z
      .string()
      .max(256)
      .optional()
      .describe("Stable provider-side user id; derived from the caller when omitted."),
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
    label: z.string().min(1).max(256).describe("Display label for the stored credential."),
    audience: z
      .array(UrlAudienceSchema)
      .min(1)
      .max(16)
      .describe("URLs the credential is allowed to be injected into."),
    injection: CredentialInjectionSchema.describe("How the secret is injected into requests."),
    bindings: z
      .array(CredentialBindingSchema)
      .min(1)
      .max(8)
      .optional()
      .describe("Optional explicit bindings; derived from audience+injection when omitted."),
    material: z
      .object({
        type: z
          .enum([
            "bearer-token",
            "api-key",
            "oauth1-token",
            "cookie-session",
            "saml-session",
            "aws-sigv4",
            "ssh-key",
          ])
          .describe("Kind of secret material being stored."),
        token: z
          .string()
          .min(1)
          .max(65536)
          .describe("The raw secret material; never echoed back in summaries."),
      })
      .strict()
      .describe("The secret material to persist."),
    accountIdentity: AccountIdentityInputSchema.optional().describe(
      "Optional account identity associated with the credential."
    ),
    scopes: z
      .array(z.string().max(256))
      .optional()
      .describe("Provider scopes the credential carries (informational)."),
    expiresAt: z
      .number()
      .positive()
      .optional()
      .describe("Epoch-ms expiry of the credential, if known."),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .describe("Arbitrary string metadata (e.g. providerId)."),
  })
  .strict();

const ConnectCredentialDetailsSchema = z
  .object({
    label: z.string().min(1).max(256).describe("Display label for the credential that results."),
    audience: z
      .array(UrlAudienceSchema)
      .min(1)
      .max(16)
      .describe("URLs the resulting credential is allowed to be injected into."),
    injection: CredentialInjectionSchema.describe("How the resulting secret is injected."),
    bindings: z
      .array(CredentialBindingSchema)
      .min(1)
      .max(8)
      .optional()
      .describe("Optional explicit bindings; derived from audience+injection when omitted."),
    accountIdentity: AccountIdentityInputSchema.optional().describe(
      "Optional account identity to associate with the credential."
    ),
    scopes: z
      .array(z.string().max(256))
      .optional()
      .describe("Provider scopes to record on the credential (informational)."),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .describe("Arbitrary string metadata to persist on the credential."),
  })
  .strict();

export const ClientConfigFieldSchema = z
  .object({
    name: IdentifierSchema.describe("Field key the submitted value is stored under."),
    label: z.string().min(1).max(128).describe("Human-readable field label shown to the user."),
    type: z
      .enum(["text", "secret"])
      .describe("'secret' fields are masked and never returned in status."),
    required: z.boolean().optional().describe("Whether the user must supply this field."),
    description: z.string().max(512).optional().describe("Optional help text for the field."),
  })
  .strict();

export const RequestClientConfigParamsSchema = z
  .object({
    configId: IdentifierSchema.describe("Stable id identifying this client config."),
    title: z.string().min(1).max(256).describe("Title shown in the configuration prompt."),
    description: z.string().max(1024).optional().describe("Optional description for the prompt."),
    authorizeUrl: z.string().url().describe("Provider OAuth authorization endpoint."),
    tokenUrl: z.string().url().describe("Provider OAuth token endpoint."),
    fields: z
      .array(ClientConfigFieldSchema)
      .min(1)
      .max(16)
      .describe("Fields (e.g. client id/secret) the user is asked to supply."),
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
  flowTypes: z
    .array(CredentialFlowTypeSchema)
    .min(1)
    .max(8)
    .optional()
    .describe("Credential flow types this client config supports."),
  status: z
    .enum(["active", "disabled"])
    .optional()
    .describe("Whether the config is usable for new connections."),
  allowRefreshWhenDisabled: z
    .boolean()
    .optional()
    .describe("Permit token refresh on existing credentials even while disabled."),
}).strict();

export const RequestCredentialInputParamsSchema = z
  .object({
    title: z.string().min(1).max(256).describe("Title shown in the credential-input prompt."),
    description: z.string().max(1024).optional().describe("Optional prompt description."),
    credential: ConnectCredentialDetailsSchema.describe(
      "Shape of the credential to store once the secret is entered."
    ),
    fields: z
      .array(ClientConfigFieldSchema)
      .length(1)
      .describe("Exactly one secret field to collect from the user."),
    material: z
      .object({
        type: z.enum(["bearer-token", "api-key"]).describe("Kind of secret being collected."),
        tokenField: IdentifierSchema.describe("Which field name carries the secret token."),
      })
      .strict()
      .describe("Maps the collected field to stored credential material."),
  })
  .strict();

export const GetClientConfigStatusParamsSchema = z
  .object({
    configId: IdentifierSchema.describe("Client config id to inspect."),
    fields: z
      .array(ClientConfigFieldSchema)
      .max(16)
      .optional()
      .describe("Optional field set to report configured-status for."),
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
    callerId: z
      .string()
      .min(1)
      .max(512)
      .describe("Caller id that should receive the browser handoff."),
    callerKind: z
      .enum(["app", "panel", "shell"])
      .describe("Runtime kind of the handoff target that opens the sign-in browser."),
  })
  .strict();

export const ConnectCredentialSpecSchema = z
  .object({
    flow: z
      .discriminatedUnion("type", [
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
      ])
      .describe("The connection flow to run (OAuth2/OAuth1a/API-key/SSH/browser-session/etc.)."),
    credential: ConnectCredentialDetailsSchema.describe(
      "Shape of the credential to store once the flow completes."
    ),
    redirect: OAuthRedirectStrategySchema.optional().describe(
      "OAuth redirect/loopback strategy for browser flows."
    ),
    browser: z
      .enum(["external", "internal"])
      .optional()
      .describe("Whether the sign-in browser opens externally or in an internal window."),
  })
  .strict();

export const ConnectCredentialParamsSchema = z.union([
  ConnectCredentialSpecSchema,
  z
    .object({
      spec: ConnectCredentialSpecSchema.describe("The connection spec to run."),
      handoffTarget: BrowserHandoffTargetSchema.describe(
        "Caller that should receive the browser handoff for the sign-in flow."
      ),
    })
    .strict(),
]);

export const DeleteClientConfigParamsSchema = z
  .object({
    configId: IdentifierSchema.describe("Client config id to disable/delete."),
  })
  .strict();

export const ForwardOAuthCallbackParamsSchema = z
  .object({
    transactionId: IdentifierSchema.optional().describe(
      "Pending OAuth transaction id to resume (required for client-loopback callbacks)."
    ),
    url: z
      .string()
      .url()
      .optional()
      .describe("Full callback URL; code/state are parsed from it when not given explicitly."),
    code: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe("Authorization code returned by the provider."),
    state: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe("OAuth state value used to locate the pending transaction."),
  })
  .strict() satisfies z.ZodType<ForwardOAuthCallbackRequest>;

export const CredentialIdParamsSchema = z
  .object({
    credentialId: IdentifierSchema.describe("Id of the stored credential to act on."),
  })
  .strict();

export const ResolveCredentialParamsSchema = z
  .object({
    url: z.string().url().optional().describe("Target URL to match a stored credential against."),
    providerId: IdentifierSchema.optional().describe("Provider id to match (alternative to url)."),
    credentialId: IdentifierSchema.optional().describe(
      "Resolve a specific credential by id instead of by url/provider."
    ),
    use: z
      .enum(["fetch", "git-http", "git-ssh"])
      .optional()
      .describe("Transport the credential will be used for. Defaults to 'fetch'."),
  })
  .strict()
  .refine((value) => !!value.url || !!value.providerId, {
    message: "resolveCredential requires url or providerId",
  });

export const ProxyFetchParamsSchema = z
  .object({
    url: z.string().url().describe("Target URL to fetch through the credential-injecting proxy."),
    method: z.string().min(1).max(16).describe("HTTP method (e.g. 'GET', 'POST')."),
    headers: z.record(z.string()).optional().describe("Request headers to send."),
    body: z
      .string()
      .optional()
      .describe("Request body as a string (mutually exclusive with bodyBase64)."),
    bodyBase64: z
      .string()
      .optional()
      .describe("Request body as base64 for binary payloads (mutually exclusive with body)."),
    credentialId: IdentifierSchema.optional().describe(
      "Explicit credential to inject; resolved from the URL when omitted."
    ),
  })
  .strict()
  .refine((p) => !(p.body !== undefined && p.bodyBase64 !== undefined), {
    message: "credentials.proxyFetch: provide either `body` or `bodyBase64`, not both",
  });

export const ProxyGitHttpParamsSchema = z
  .object({
    url: z.string().url().describe("Git smart-HTTP URL to proxy."),
    method: z.string().min(1).max(16).optional().describe("HTTP method; defaults to 'GET'."),
    headers: z.record(z.string()).optional().describe("Request headers to send."),
    bodyBase64: z
      .string()
      .optional()
      .describe("Request body as base64 (e.g. git-upload-pack payload)."),
    credentialId: IdentifierSchema.optional().describe(
      "Explicit credential to inject; resolved from the URL when omitted."
    ),
  })
  .strict();

export const AuditParamsSchema = z
  .object({
    filter: z
      .object({
        providerId: z.string().optional().describe("Filter to entries for this provider id."),
        connectionId: z.string().optional().describe("Filter to entries for this connection id."),
        callerId: z.string().optional().describe("Filter to entries for this caller id."),
        since: z
          .number()
          .optional()
          .describe("Only include entries at/after this epoch-ms timestamp."),
      })
      .optional()
      .describe("Optional filters narrowing the audit query."),
    limit: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe("Max entries to return (≤1000)."),
    after: z.number().optional().describe("Cursor: return entries after this timestamp/position."),
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

const EntitySourceSchema = z
  .object({
    repoPath: z.string(),
    effectiveVersion: z.string(),
  })
  .strict();

const CredentialAccessSubjectSummarySchema = z
  .object({
    id: z.string(),
    kind: z.enum(["panel", "worker", "do", "app", "unknown"]),
    active: z.boolean(),
    title: z.string().optional(),
    source: EntitySourceSchema.optional(),
    contextId: z.string().optional(),
    parentId: z.string().optional(),
    focusPanelId: z.string().optional(),
    focusPanelTitle: z.string().optional(),
    focusPanelSource: z.string().optional(),
    focusUnavailableReason: z.string().optional(),
  })
  .strict();

const CredentialAccessGrantSummarySchema = z
  .object({
    id: z.string(),
    bindingId: z.string(),
    bindingLabel: z.string().optional(),
    use: z.enum(["fetch", "git-http", "git-ssh"]),
    resource: z.string(),
    action: z.enum(["read", "write", "use"]),
    scope: z.enum(["caller", "version", "repo"]),
    callerId: z.string().optional(),
    repoPath: z.string().optional(),
    effectiveVersion: z.string().optional(),
    grantedAt: z.number(),
    grantedBy: z.string(),
    subjects: z.array(CredentialAccessSubjectSummarySchema),
  })
  .strict();

const ManagedCredentialSummarySchema = StoredCredentialSummarySchema.extend({
  grants: z.array(CredentialAccessGrantSummarySchema),
}).strict() satisfies z.ZodType<ManagedCredentialSummary>;

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
export type ResolveCredentialParams = z.infer<typeof ResolveCredentialParamsSchema>;
export type ProxyFetchParams = z.infer<typeof ProxyFetchParamsSchema>;
export type ProxyGitHttpParams = z.infer<typeof ProxyGitHttpParamsSchema>;
export type AuditParams = z.infer<typeof AuditParamsSchema>;
export type CredentialProxyFetchRequest = ProxyFetchParams;
export type CredentialProxyFetchResponse = z.infer<typeof CredentialProxyFetchResponseSchema>;
export type CredentialAuditParams = AuditParams;

export const credentialsMethods = defineServiceMethods({
  storeCredential: {
    description:
      "Persist a URL-bound credential (label, audience, injection, secret material); userland callers are prompted to approve it before it is stored, and the returned summary never echoes the secret.",
    args: z.tuple([StoreUrlBoundCredentialParamsSchema]),
    returns: StoredCredentialSummarySchema,
    access: STORE_CREDENTIAL_ACCESS,
    examples: [
      {
        args: [
          {
            label: "Example API",
            audience: [{ url: "https://api.example.com/v1", match: "path-prefix" }],
            injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
            material: { type: "bearer-token", token: "secret-token" },
            accountIdentity: { providerUserId: "acct-1" },
          },
        ],
      },
    ],
  },
  connect: {
    description:
      "Run a connection flow (OAuth2/OAuth1a/API-key/SSH/browser-session) to obtain and store a credential; interactive flows open a browser sign-in and may return a DeferredResult for hibernatable DO callers.",
    args: z.tuple([ConnectCredentialParamsSchema]),
    returns: MaybeDeferredStoredCredentialSchema,
    access: CONNECT_ACCESS,
  },
  configureClient: {
    description:
      "Store (versioned) OAuth client configuration — authorize/token URLs and client fields such as client id/secret; userland callers are prompted to submit the material, and secrets are never returned in the status.",
    args: z.tuple([ConfigureClientParamsSchema]),
    returns: ClientConfigStatusSchema,
    access: CONFIGURE_CLIENT_ACCESS,
    examples: [
      {
        args: [
          {
            configId: "google-workspace",
            title: "Configure Google Workspace OAuth",
            authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
            tokenUrl: "https://oauth2.googleapis.com/token",
            fields: [
              { name: "clientId", label: "Client ID", type: "text", required: true },
              { name: "clientSecret", label: "Client secret", type: "secret", required: true },
            ],
          },
        ],
      },
    ],
  },
  requestCredentialInput: {
    description:
      "Prompt the user to enter exactly one secret field, then store the resulting credential; the submitted secret is never returned in the summary.",
    args: z.tuple([RequestCredentialInputParamsSchema]),
    returns: StoredCredentialSummarySchema,
    access: REQUEST_CREDENTIAL_INPUT_ACCESS,
    examples: [
      {
        args: [
          {
            title: "Add GitHub",
            credential: {
              label: "GitHub",
              audience: [{ url: "https://api.github.com/", match: "origin" }],
              injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
              accountIdentity: { providerUserId: "github-pat" },
              metadata: { providerId: "github" },
            },
            fields: [{ name: "token", label: "Fine-grained PAT", type: "secret", required: true }],
            material: { type: "bearer-token", tokenField: "token" },
          },
        ],
      },
    ],
  },
  getClientConfigStatus: {
    description:
      "Return the configured status of an OAuth client config (which fields are set, URLs, status) without revealing secret values; rejects callers outside the config's trust scope.",
    args: z.tuple([GetClientConfigStatusParamsSchema]),
    returns: ClientConfigStatusSchema,
    access: READ_ACCESS,
    examples: [{ args: [{ configId: "google-workspace" }] }],
  },
  deleteClientConfig: {
    description:
      "Disable a client config (marks it deleted so it is no longer used for new connections or refreshes); userland callers are prompted to confirm and only the config's owner may delete it.",
    args: z.tuple([DeleteClientConfigParamsSchema]),
    returns: z.void(),
    access: DELETE_CLIENT_CONFIG_ACCESS,
    examples: [{ args: [{ configId: "google-workspace" }] }],
  },
  forwardOAuthCallback: {
    description:
      "Deliver an inbound OAuth provider callback (code/state, or a full callback URL) to its pending connection transaction, validating the caller against the transaction's redirect strategy.",
    args: z.tuple([ForwardOAuthCallbackParamsSchema]),
    returns: z.void(),
    access: FORWARD_OAUTH_CALLBACK_ACCESS,
  },
  listStoredCredentials: {
    description:
      "List summaries of stored URL-bound credentials visible to the caller; secret material is never included.",
    args: z.tuple([]),
    returns: z.array(StoredCredentialSummarySchema),
    access: READ_ACCESS,
    examples: [{ args: [] }],
  },
  inspectStoredCredentials: {
    description:
      "List administrator-facing credential summaries with runtime usage metadata; secret material is never included.",
    args: z.tuple([]),
    returns: z.array(ManagedCredentialSummarySchema),
    access: READ_ACCESS,
  },
  revokeCredential: {
    description:
      "Revoke a stored credential by id (marks it revoked and best-effort revokes the upstream provider token); only an authorized administrator of the credential may call it.",
    args: z.tuple([CredentialIdParamsSchema]),
    returns: z.void(),
    access: REVOKE_CREDENTIAL_ACCESS,
    examples: [{ args: [{ credentialId: "cred-123" }] }],
  },
  resolveCredential: {
    description:
      "Locate a stored credential by url/provider/id and authorize its use for the caller, returning a summary, null when nothing matches, or a DeferredResult while a use-approval prompt is awaited.",
    args: z.tuple([ResolveCredentialParamsSchema]),
    returns: z.union([StoredCredentialSummarySchema, z.null(), DeferredResultSchema]),
    access: RESOLVE_CREDENTIAL_ACCESS,
    examples: [{ args: [{ url: "https://api.example.test/v1" }] }],
  },
  proxyFetch: {
    description:
      "Forward an outbound HTTP request through the egress proxy, injecting the resolved credential; returns status, ordered header pairs, final URL, and a base64 body.",
    args: z.tuple([ProxyFetchParamsSchema]),
    returns: CredentialProxyFetchResponseSchema,
    access: PROXY_ACCESS,
    examples: [{ args: [{ url: "https://api.example.com/v1/me", method: "GET" }] }],
  },
  proxyGitHttp: {
    description:
      "Forward a Git smart-HTTP request through the egress proxy with credential injection; the request/response bodies are base64-encoded.",
    args: z.tuple([ProxyGitHttpParamsSchema]),
    returns: ProxyGitHttpResponseSchema,
    access: PROXY_ACCESS,
    examples: [
      { args: [{ url: "https://github.com/owner/repo.git/info/refs?service=git-upload-pack" }] },
    ],
  },
  audit: {
    description:
      "Query the credential egress audit log (optionally filtered by provider/connection/caller/since, paged by limit/after).",
    args: z.tuple([AuditParamsSchema]),
    returns: z.array(AuditEntrySchema),
    access: READ_ACCESS,
    examples: [{ args: [{ limit: 50 }] }],
  },
});
