import type { ProviderManifest } from "../types.js";

export const anthropic: ProviderManifest = {
  id: "anthropic",
  displayName: "Anthropic",
  apiBase: [
    "https://api.anthropic.com",
  ],
  authInjection: {
    type: "header",
    headerName: "x-api-key",
    valueTemplate: "{token}",
    stripHeaders: ["authorization", "x-api-key"],
  },
  flows: [
    {
      type: "env-var",
      envVar: "ANTHROPIC_API_KEY",
    },
  ],
};
