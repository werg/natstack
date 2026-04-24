import type { ProviderManifest } from "../types.js";

export const google: ProviderManifest = {
  id: "google",
  displayName: "Google AI",
  apiBase: [
    "https://generativelanguage.googleapis.com",
  ],
  authInjection: {
    type: "query-param",
    paramName: "key",
    stripHeaders: ["authorization"],
  },
  flows: [
    {
      type: "env-var",
      envVar: "GOOGLE_API_KEY",
    },
  ],
};
