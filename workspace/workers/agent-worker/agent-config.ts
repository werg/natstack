import type { ModelCredentialSetupProps } from "@workspace/agentic-do";

const OPENAI_CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";

/** Default model in "provider:modelId" form. pi-ai owns the provider registry. */
export const DEFAULT_MODEL = "openai-codex:gpt-5.5";

/** Default effort. One of: "minimal" | "low" | "medium" | "high". */
export const DEFAULT_THINKING_LEVEL = "medium" as const;

/** Default approval: 0=manual, 1=auto-safe, 2=full-auto. */
export const DEFAULT_APPROVAL_LEVEL = 2 as const;

/** Default chat response policy. */
export const DEFAULT_RESPOND_POLICY = "all" as const;

/**
 * Per-provider credential setup.
 *
 * Edit this file to change the default model, swap providers, or wire up a
 * new OAuth/API-key integration. These are cold-start choices: reload or
 * resubscribe the worker for model/provider changes. Live session knobs are
 * exposed as AiChatWorker methods.
 */
export const PROVIDER_CREDENTIAL_SETUPS: Record<string, ModelCredentialSetupProps> = {
  "openai-codex": {
    credentialLabel: "ChatGPT Codex model credential",
    accountIdentityJwtClaimRoot: OPENAI_CODEX_ACCOUNT_CLAIM,
    accountIdentityJwtClaimField: "chatgpt_account_id",
    redirectPolicy: "loopback-required",
    redirect: {
      type: "loopback",
      host: "localhost",
      port: 1455,
      callbackPath: "/auth/callback",
    },
    clientLoopbackRedirect: {
      type: "client-loopback",
      host: "localhost",
      port: 1455,
      callbackPath: "/auth/callback",
    },
    flow: {
      type: "oauth2-auth-code-pkce",
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      tokenUrl: "https://auth.openai.com/oauth/token",
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      scopes: ["openid", "profile", "email", "offline_access"],
      extraAuthorizeParams: {
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "codex_cli_rs",
      },
    },
  },

  // VERIFY before enabling: confirm Anthropic's current OAuth URLs/scopes.
  // Recommended flagship as of May 2026: anthropic:claude-opus-4-7
  // Sonnet tier: anthropic:claude-sonnet-4-6
  // "anthropic": {
  //   credentialLabel: "Anthropic model credential",
  //   flow: {
  //     type: "oauth2-auth-code-pkce",
  //     authorizeUrl: "https://example.invalid/oauth/authorize",
  //     tokenUrl: "https://example.invalid/oauth/token",
  //     clientId: "replace-me",
  //     scopes: ["openid", "profile", "offline_access"],
  //   },
  // },

  // VERIFY before enabling: confirm URLs/scopes against
  // https://developers.google.com/identity/protocols/oauth2 and
  // https://developers.google.com/identity/protocols/oauth2/native-app.
  // Recommended flagship as of May 2026: google-vertex:gemini-3.1-pro
  // "google-vertex": {
  //   credentialLabel: "Google Vertex model credential",
  //   flow: {
  //     type: "oauth2-auth-code-pkce",
  //     authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  //     tokenUrl: "https://oauth2.googleapis.com/token",
  //     clientId: "replace-me.apps.googleusercontent.com",
  //     scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/cloud-platform"],
  //     // For oauth2-auth-code instead of PKCE, also set:
  //     // pkce: false,
  //     // compatibilityReason: "Provider requires a non-PKCE installed-app flow.",
  //   },
  // },

  // API-key provider template. Copy this entry to a real provider id and set
  // DEFAULT_MODEL to the matching "provider:modelId".
  // "__api-key-template__": {
  //   credentialLabel: "Provider API key",
  //   flow: {
  //     type: "api-key",
  //     title: "Provider API key",
  //     fields: [
  //       { name: "apiKey", label: "API key", type: "secret", required: true },
  //     ],
  //     materialTemplate: {
  //       type: "bearer-token",
  //       valueTemplate: "{apiKey}",
  //     },
  //   },
  //   credential: {
  //     injection: {
  //       type: "header",
  //       name: "Authorization",
  //       valueTemplate: "Bearer {token}",
  //     },
  //     audience: [{ url: "https://api.provider.example/v1/", match: "path-prefix" }],
  //   },
  // },
};

export { OPENAI_CODEX_ACCOUNT_CLAIM };
