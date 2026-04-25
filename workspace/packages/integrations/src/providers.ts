import type { ProviderDescriptor } from "../../runtime/src/shared/credentials.js";

export const githubProvider: ProviderDescriptor = {
  id: "github",
  displayName: "GitHub",
  apiBase: [
    "https://api.github.com",
    "https://uploads.github.com",
  ],
  authInjection: {
    type: "header",
    headerName: "Authorization",
    valueTemplate: "Bearer {token}",
  },
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
};

export const googleWorkspaceProvider: ProviderDescriptor = {
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
};
