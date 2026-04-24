import type { ProviderManifest } from "../types.js";

export const mistral: ProviderManifest = {
  id: "mistral",
  displayName: "Mistral",
  apiBase: [
    "https://api.mistral.ai",
  ],
  authInjection: {
    type: "header",
    headerName: "Authorization",
    valueTemplate: "Bearer {token}",
  },
  flows: [
    {
      type: "env-var",
      envVar: "MISTRAL_API_KEY",
    },
  ],
};
