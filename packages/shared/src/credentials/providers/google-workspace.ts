import type { ProviderManifest } from "../types.js";

export const googleWorkspace: ProviderManifest = {
  id: "google-workspace",
  displayName: "Google Workspace",
  apiBase: [
    "https://gmail.googleapis.com",
    "https://www.googleapis.com",
    "https://oauth2.googleapis.com",
  ],
  authInjection: {
    type: "header",
    headerName: "Authorization",
    valueTemplate: "Bearer {token}",
  },
  flows: [
    {
      type: "composio-bridge",
    },
    {
      type: "loopback-pkce",
      clientId: "PLACEHOLDER_GOOGLE_CLIENT_ID",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
    },
    {
      type: "device-code",
      clientId: "PLACEHOLDER_GOOGLE_CLIENT_ID",
      deviceAuthUrl: "https://oauth2.googleapis.com/device/code",
      tokenUrl: "https://oauth2.googleapis.com/token",
    },
    {
      type: "service-account",
    },
  ],
  scopes: {
    gmail_readonly: "https://www.googleapis.com/auth/gmail.readonly",
    gmail_send: "https://www.googleapis.com/auth/gmail.send",
    gmail_modify: "https://www.googleapis.com/auth/gmail.modify",
    calendar_readonly: "https://www.googleapis.com/auth/calendar.readonly",
    calendar_events: "https://www.googleapis.com/auth/calendar.events",
    drive_readonly: "https://www.googleapis.com/auth/drive.readonly",
    drive_file: "https://www.googleapis.com/auth/drive.file",
    userinfo_email: "https://www.googleapis.com/auth/userinfo.email",
  },
  scopeDescriptions: {
    gmail_readonly: "Read your Gmail messages",
    gmail_send: "Send email on your behalf",
    gmail_modify: "Read, send, and manage your Gmail",
    calendar_readonly: "View your calendar events",
    calendar_events: "Create and edit calendar events",
    drive_readonly: "View files in Google Drive",
    drive_file: "View and manage files created by this app",
    userinfo_email: "View your email address",
  },
  whoami: {
    url: "https://www.googleapis.com/oauth2/v2/userinfo",
    identityPath: {
      email: "email",
      providerUserId: "id",
    },
  },
  webhooks: {
    subscriptions: [
      {
        event: "message.new",
        delivery: "pubsub-push",
        watch: {
          type: "gmail-watch",
          renewEveryHours: 24,
        },
      },
      {
        event: "events.changed",
        delivery: "https-post",
        watch: {
          type: "calendar-watch",
          renewEveryHours: 24,
        },
      },
    ],
  },
  rateLimits: {
    requestsPerSecond: 10,
    burstSize: 20,
    strategy: "delay",
  },
  refreshBufferSeconds: 120,
};
