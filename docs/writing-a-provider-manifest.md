# Provider Manifests Removed

NatStack no longer uses server-owned provider manifests for credentials.
Provider setup lives in userland, with shared provider descriptors where useful.

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

For providers with many services or dynamic resources, request the broad
upstream grant once and store narrow local `bindings`:

- Google Workspace requests the Workspace bundle, then stages Gmail, Calendar,
  Drive, Docs, Sheets, Slides, People, and identity as separate bindings.
- GitHub can request a broad fine-grained PAT, then stages user API, repository
  API, release uploads, and git HTTPS as separate bindings.
- Dynamic APIs should set `grantResource` when one audience covers many
  resources. For example, `https://api.github.com/repos/` uses
  `{ type: "url-path-prefix", segmentCount: 3 }` so approvals are per
  `/repos/{owner}/{repo}/` instead of per whole provider.

Put reusable descriptor data in a package like
`@workspace/integrations/providers`: upstream scopes, binding IDs, audiences,
labels, and injection shapes. Runtime clients should resolve the binding they
need with `credentials.forAudience()` and then use host-mediated egress.

Use stored credentials only through host-mediated egress:

```ts
await credentials.fetch("https://api.example.com/v1/models", undefined, {
  credentialId,
});
```
