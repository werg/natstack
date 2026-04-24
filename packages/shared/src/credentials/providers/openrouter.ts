import type { ProviderManifest } from "../types.js";

export const openrouter: ProviderManifest = {
  id: "openrouter",
  displayName: "OpenRouter",
  apiBase: [
    "https://openrouter.ai/api",
  ],
  authInjection: {
    type: "header",
    headerName: "Authorization",
    valueTemplate: "Bearer {token}",
  },
  flows: [
    {
      type: "env-var",
      envVar: "OPENROUTER_API_KEY",
    },
  ],
};
