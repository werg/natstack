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

## Host-Brokered OAuth PKCE

Use this when userland should initiate OAuth but should not receive the access
token after exchange:

```ts
const begin = await credentials.beginCreateWithOAuthPkce({
  oauth: {
    authorizeUrl: "https://auth.example.com/oauth/authorize",
    tokenUrl: "https://auth.example.com/oauth/token",
    clientId: "public-client-id",
    // Optional. Confidential/native providers that issue one use it only
    // during the host-side token exchange.
    clientSecret: "client-secret",
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
  redirectUri,
});

// Open begin.authorizeUrl, collect the OAuth callback, then:
const stored = await credentials.completeCreateWithOAuthPkce({
  nonce: begin.nonce,
  code,
  state,
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
