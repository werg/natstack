import type { ProviderManifest } from "../types.js";

export const groq: ProviderManifest = {
  id: "groq",
  displayName: "Groq",
  apiBase: [
    "https://api.groq.com",
  ],
  authInjection: {
    type: "header",
    headerName: "Authorization",
    valueTemplate: "Bearer {token}",
  },
  flows: [
    {
      type: "env-var",
      envVar: "GROQ_API_KEY",
    },
  ],
};
