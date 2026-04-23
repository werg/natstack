import type { ProviderManifest } from "../types.js";

export const microsoft: ProviderManifest = {
  id: "microsoft",
  displayName: "Microsoft",
  clientId: "PLACEHOLDER_MICROSOFT_CLIENT_ID",
  apiBase: [
    "https://graph.microsoft.com",
  ],
  flows: [
    {
      type: "device-code",
      clientId: "PLACEHOLDER_MICROSOFT_CLIENT_ID",
      deviceAuthUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    },
    {
      type: "loopback-pkce",
      clientId: "PLACEHOLDER_MICROSOFT_CLIENT_ID",
      authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    },
    {
      type: "cli-piggyback",
      command: "az account get-access-token",
      jsonPath: "accessToken",
    },
  ],
  scopes: {
    mail_read: "Mail.Read",
    mail_send: "Mail.Send",
    calendars_readwrite: "Calendars.ReadWrite",
    files_readwrite: "Files.ReadWrite.All",
    user_read: "User.Read",
    offline_access: "offline_access",
  },
  scopeDescriptions: {
    mail_read: "Read your mail",
    mail_send: "Send mail as you",
    calendars_readwrite: "Read and write your calendars",
    files_readwrite: "Read and write files in OneDrive",
    user_read: "Read your profile",
    offline_access: "Maintain access (refresh tokens)",
  },
  whoami: {
    url: "https://graph.microsoft.com/v1.0/me",
    identityPath: {
      email: "mail",
      username: "userPrincipalName",
      providerUserId: "id",
    },
  },
  rateLimits: {
    requestsPerSecond: 10,
    burstSize: 20,
    strategy: "delay",
  },
  refreshBufferSeconds: 120,
};
