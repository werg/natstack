# Runtime Credential API

Credentials are URL-bound and may only be used through host-mediated egress.

## Store

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

## OAuth PKCE Without Returning Tokens

```ts
const begin = await credentials.beginCreateWithOAuthPkce({
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
  redirectUri,
});

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
```
