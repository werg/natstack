# Provider Manifests Removed

NatStack no longer uses server-owned provider manifests for credentials.

Userland should run provider-specific setup or OAuth, then store the resulting
access token/API key as a URL-bound credential:

```ts
await credentials.store({
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

Use stored credentials only through host-mediated egress:

```ts
await credentials.fetch("https://api.example.com/v1/models", undefined, {
  credentialId,
});
```
