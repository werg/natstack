import type { ProviderManifest } from "../types.js";

export const slack: ProviderManifest = {
  id: "slack",
  displayName: "Slack",
  clientId: "PLACEHOLDER_SLACK_CLIENT_ID",
  authInjection: {
    type: "header",
    headerName: "Authorization",
    valueTemplate: "Bearer {token}",
  },
  apiBase: [
    "https://slack.com/api",
  ],
  flows: [
    {
      type: "loopback-pkce",
      clientId: "PLACEHOLDER_SLACK_CLIENT_ID",
      authorizeUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
    },
    {
      type: "bot-token",
      probeUrl: "https://slack.com/api/auth.test",
    },
  ],
  scopes: {
    channels_history: "channels:history",
    channels_read: "channels:read",
    chat_write: "chat:write",
    users_read: "users:read",
    files_read: "files:read",
    files_write: "files:write",
    reactions_read: "reactions:read",
    reactions_write: "reactions:write",
  },
  scopeDescriptions: {
    channels_history: "View messages in public channels",
    channels_read: "View basic channel information",
    chat_write: "Send messages",
    users_read: "View people in a workspace",
    files_read: "View files shared in channels",
    files_write: "Upload and manage files",
    reactions_read: "View emoji reactions",
    reactions_write: "Add and remove emoji reactions",
  },
  whoami: {
    url: "https://slack.com/api/auth.test",
    identityPath: {
      username: "user",
      providerUserId: "user_id",
      workspaceName: "team",
    },
  },
  rateLimits: {
    requestsPerSecond: 1,
    burstSize: 5,
    strategy: "delay",
  },
  refreshBufferSeconds: 60,
};
