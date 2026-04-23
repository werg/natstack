import type { ProviderManifest } from "../types.js";

export const github: ProviderManifest = {
  id: "github",
  displayName: "GitHub",
  clientId: "PLACEHOLDER_GITHUB_CLIENT_ID",
  apiBase: [
    "https://api.github.com",
    "https://uploads.github.com",
  ],
  flows: [
    {
      type: "device-code",
      clientId: "PLACEHOLDER_GITHUB_CLIENT_ID",
      deviceAuthUrl: "https://github.com/login/device/code",
      tokenUrl: "https://github.com/login/oauth/access_token",
    },
    {
      type: "loopback-pkce",
      clientId: "PLACEHOLDER_GITHUB_CLIENT_ID",
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
    },
    {
      type: "pat",
      probeUrl: "https://api.github.com/user",
    },
    {
      type: "cli-piggyback",
      command: "gh auth token",
    },
  ],
  scopes: {
    repo: "repo",
    read_user: "read:user",
    user_email: "user:email",
    gist: "gist",
    workflow: "workflow",
  },
  scopeDescriptions: {
    repo: "Full control of private repositories",
    read_user: "Read user profile data",
    user_email: "Access user email addresses",
    gist: "Create and manage gists",
    workflow: "Update GitHub Actions workflows",
  },
  whoami: {
    url: "https://api.github.com/user",
    identityPath: {
      username: "login",
      email: "email",
      providerUserId: "id",
    },
  },
  rateLimits: {
    requestsPerSecond: 15,
    burstSize: 30,
    strategy: "delay",
  },
  refreshBufferSeconds: 60,
};
