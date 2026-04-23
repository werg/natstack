import type { ProviderManifest } from "../types.js";

export const openai: ProviderManifest = {
  id: "openai",
  displayName: "OpenAI",
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
      type: "env-var",
      envVar: "OPENAI_API_KEY",
    },
  ],
};
