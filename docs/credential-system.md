# Credential System

NatStack credentials are URL-bound. Userland owns provider-specific setup and
OAuth semantics; the host stores encrypted credential material and injects it
only through host-mediated egress when the request URL matches an approved
audience.

Mobile OAuth on `auth.snugenv.com` and public webhook ingress on
`hooks.snugenv.com` are tracked in `docs/credential-system-human-tasks.md`.

## Store Directly

```ts
const stored = await credentials.store({
  label: "Example API",
  audience: [{ url: "https://api.example.com/", match: "origin" }],
  injection: {
    type: "header",
    name: "authorization",
    valueTemplate: "Bearer {token}",
  },
  material: { type: "bearer-token", token },
});
```

## Host-Owned OAuth Connection

Use this for OAuth providers. Userland declares provider metadata; the host
creates the callback, opens the browser for the initiating client, validates the
callback, exchanges the token, stores allowlisted token material, and grants the
initial use scope selected by the user.

```ts
const stored = await credentials.connect({
  flow: {
    type: "oauth2-auth-code-pkce",
    authorizeUrl: "https://auth.example.com/oauth/authorize",
    tokenUrl: "https://auth.example.com/oauth/token",
    clientId: "public-client-id",
    scopes: ["read"],
  },
  credential: {
    label: "Example API",
    audience: [{ url: "https://api.example.com/", match: "origin" }],
    injection: {
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
    },
  },
  browser: "external", // or "internal" for an app browser panel
});
```

Supported OAuth flows include PKCE/auth-code, compatibility auth-code,
device-code, client-credentials, JWT bearer, and token exchange. Stored client
configs support `client_secret_post`, `client_secret_basic`, and
`private_key_jwt`; private keys and client secrets stay in the host config.

### Device-code flow (RFC 8628)

`type: "oauth2-device-code"` is the right choice when a redirect-based flow
can't reach the server — for example, when an OAuth provider rejects the
auto-detected Tailscale `*.ts.net` redirect URI, or when the user wants to
authorize from a different device than the one running natstack. The server:

1. Calls the provider's `device_authorization_url` to obtain a `device_code`,
   `user_code`, and `verification_uri`.
2. Opens the verification URL in the user's browser (using
   `verification_uri_complete` when the provider supplies it, so the page
   pre-fills the code).
3. Presents a **device-code approval bar entry** that displays the
   `user_code` in a large, copyable, monospace surface. The entry persists
   until polling completes; the user can cancel with one click.
4. Polls the token endpoint at the provider-specified interval until either
   a token grant arrives, the user cancels, or the device code expires.

Provider support is partial. Known good: Google, Microsoft / Azure AD,
GitHub, GitLab, Slack, Twitch, Spotify, Dropbox, Atlassian, Discord. **Apple
does not support device code** — for Apple Sign-In, see the redirect-URI
options in `docs/remote-server.md`.

Use device-code as a fallback path in personal-server installs whose public
URL can't be registered with a given provider, since it skips the redirect
URI entirely.

## Trusted URL-Bound OAuth Client Config

Panels and workers can request a shell-owned input prompt for OAuth client
config without receiving the entered values. The stored client material is bound
to the approved authorize and token URLs. Once a `configId` is saved, those URL
bindings are immutable; changing OAuth endpoints requires a new `configId`.

```ts
await credentials.configureClient({
  configId: "google-workspace",
  title: "Configure Google Workspace OAuth",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  fields: [
    { name: "clientId", label: "Client ID", type: "text", required: true },
    { name: "clientSecret", label: "Client secret", type: "secret", required: true },
  ],
});

const status = await credentials.getClientConfigStatus({
  configId: "google-workspace",
});
```

The stored client material can then be injected internally using the stored
URL-bound OAuth endpoints:

```ts
const stored = await credentials.connect({
  flow: {
    type: "oauth2-auth-code-pkce",
    clientConfigId: "google-workspace",
    scopes: ["https://www.googleapis.com/auth/userinfo.email"],
  },
  credential: {
    label: "Google Workspace",
    audience: [{ url: "https://www.googleapis.com/", match: "origin" }],
    injection: {
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
    },
  },
});
```

## Non-OAuth Provider Credentials

API keys, AWS SigV4, SSH keys, OAuth1a, and browser session credentials also go
through `credentials.connect()` so userland never receives the submitted secret.

```ts
const aws = await credentials.connect({
  flow: { type: "aws-sigv4" },
  credential: {
    label: "AWS S3",
    audience: [{ url: "https://s3.us-east-1.amazonaws.com/", match: "origin" }],
    injection: { type: "aws-sigv4", service: "s3", region: "us-east-1" },
  },
});

const git = await credentials.connect({
  flow: { type: "ssh-key" },
  credential: {
    label: "GitHub SSH",
    audience: [{ url: "https://github.com/acme/project", match: "path-prefix" }],
    injection: { type: "ssh-key" },
    bindings: [{
      id: "git",
      use: "git-ssh",
      audience: [{ url: "https://github.com/acme/project", match: "path-prefix" }],
      injection: { type: "ssh-key" },
    }],
  },
});
```

Browser-cookie and SAML cookie-session flows can use `browser: "internal"` or
`browser: "external"`. External mode is backed by the shell-owned browser import
store and captures only the declared origins and cookie names.

## Use

```ts
await fetch("https://api.example.com/v1/items", {
  headers: {
    "X-NatStack-Use-Credential": stored.id,
  },
});
```

The host validates URL audiences, strips common incoming credential carriers,
and injects only the stored carrier shape. Runtime APIs do not expose stored
secret material or reusable credential-bearing headers.
