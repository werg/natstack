import type { ProviderManifest } from "../types.js";

export const openaiCodex: ProviderManifest = {
  id: "openai-codex",
  displayName: "ChatGPT",
  apiBase: [
    "https://api.openai.com",
  ],
  authInjection: {
    type: "header",
    headerName: "Authorization",
    valueTemplate: "Bearer {token}",
  },
  flows: [
    {
      type: "loopback-pkce",
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      tokenUrl: "https://auth.openai.com/oauth/token",
      fixedScope: "openid profile email offline_access",
      extraAuthorizeParams: {
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "codex_cli_rs",
      },
      tokenMetadata: {
        accountId: {
          source: "jwt-claim",
          path: "https://api.openai.com/auth.chatgpt_account_id",
        },
      },
    },
  ],
};
