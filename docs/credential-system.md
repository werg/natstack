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
const stored = await credentials.connectOAuth({
  oauth: {
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

## Trusted URL-Bound OAuth Client Config

Panels and workers can request a shell-owned input prompt for OAuth client
config without receiving the entered values. The stored client material is bound
to the approved authorize and token URLs. Once a `configId` is saved, those URL
bindings are immutable; changing OAuth endpoints requires a new `configId`.

```ts
await credentials.configureOAuthClient({
  configId: "google-workspace",
  title: "Configure Google Workspace OAuth",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  fields: [
    { name: "clientId", label: "Client ID", type: "text", required: true },
    { name: "clientSecret", label: "Client secret", type: "secret", required: true },
  ],
});

const status = await credentials.getOAuthClientConfigStatus({
  configId: "google-workspace",
});
```

The stored client material can then be injected internally using the stored
URL-bound OAuth endpoints:

```ts
const stored = await credentials.connectOAuth({
  oauth: {
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

## Use

```ts
await credentials.fetch("https://api.example.com/v1/items", undefined, {
  credentialId: stored.id,
});

const fetchExample = credentials.hookForUrl("https://api.example.com/v1/items", {
  credentialId: stored.id,
});
await fetchExample();
```

The host validates URL audiences, strips common incoming credential carriers,
and injects only the stored carrier shape. Runtime APIs do not expose stored
secret material or reusable credential-bearing headers.
