---
name: api-integrations
description: Build API integrations with URL-bound credentials, approval-gated browser opens, and workflow UI for provider setup.
---

# API Integrations Skill

Credentials are URL-bound and may only be used through host-mediated egress.
Provider setup should be user-friendly: when a provider requires console work,
OAuth app creation, webhook registration, or API enablement, render a workflow
UI with deep links instead of writing a long plain-text checklist.

## UX Rules

1. Prefer a `feedback_custom` workflow UI for setup flows with multiple steps.
2. Put provider-console links directly beside the step that uses them.
3. Offer both **Internal** and **External** opens when a URL is useful:
   - Internal: `createBrowserPanel(url, { focus: true })`
   - External: `openExternal(url)`
4. Use `openExternal(authorizeUrl, { expectedRedirectUri })` for OAuth
   authorize URLs so the host validates the callback binding.
5. Do not ask the user to paste secrets into chat. Use a trusted provider setup
   UI/API or host-owned credential flow.

## Runtime Credential API

Store static tokens only when the provider does not support a better OAuth flow:

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

When a static token or API key must be entered by the user, do not collect it in
chat or panel-owned React state. Use the host-owned credential input prompt.
This prompt currently supports one required secret field; multi-field setup
material belongs in OAuth client config or another provider-specific setup API.
The secret is entered in NatStack's shell UI and stored encrypted after
submission, but it is not exposed to panels, workers, or chat state.

```ts
const stored = await credentials.requestCredentialInput({
  title: "Add Example API",
  credential: {
    label: "Example API",
    audience: [{ url: "https://api.example.com/", match: "origin" }],
    injection: {
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
    },
    metadata: { providerId: "example" },
  },
  fields: [
    { name: "token", label: "Token", type: "secret", required: true },
  ],
  material: { type: "bearer-token", tokenField: "token" },
});
```

Use host-owned OAuth when userland should connect an OAuth provider but should
not compose redirects or receive the access token. Do not pass client secrets
through userland; use `credentials.configureOAuthClient()` for flows that need
stored OAuth client material. A saved `configId` is bound to its OAuth authorize
and token URLs; use a new `configId` if those endpoints change.

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

Use credentials only through host-mediated egress:

```ts
await credentials.fetch("https://api.example.com/v1/items", undefined, {
  credentialId: stored.id,
});
```

Use `credentials.gitHttp()` for Git smart HTTP traffic. Do not route git
packfiles through `credentials.fetch()`, and do not expose PATs to userland
`onAuth` callbacks:

```ts
import { credentials, fs } from "@workspace/runtime";
import { GitClient } from "@natstack/git";

const git = new GitClient(fs, { http: credentials.gitHttp() });
await git.clone({ url: "https://github.com/owner/repo.git", dir: "/repo" });
```

When the caller just needs a Git client, prefer `git.client()` from the runtime.
It routes relative NatStack repositories to the internal git server and absolute
external remotes through credential-gated host git HTTP.

To share a git remote across future contexts, use the runtime git remote API
instead of editing only the current `.git/config`:

```ts
import { git } from "@workspace/runtime";

await git.setSharedRemote("panels/my-panel", {
  name: "origin",
  url: "https://github.com/owner/my-panel.git",
});
```

For an external repository that should live under workspace source, use
`git.importProject()` with the destination path:

```ts
await git.importProject({
  path: "skills/example",
  remote: { name: "origin", url: "https://github.com/owner/example.git" },
});
```

If the workspace already declares shared remotes in `meta/natstack.yml`, call
`git.completeWorkspaceDependencies()` to import every configured remote whose
workspace repo is missing.

## Provider Setup UI Pattern

```tsx
import { useState } from "react";
import { Button, Checkbox, Flex, Text } from "@radix-ui/themes";
import { GlobeIcon, OpenInNewWindowIcon } from "@radix-ui/react-icons";
import { createBrowserPanel, openExternal } from "@workspace/runtime";

export default function ProviderSetup({ onSubmit, onCancel }) {
  const [done, setDone] = useState(false);
  const consoleUrl = "https://provider.example.com/developer/apps";

  return (
    <Flex direction="column" gap="3" p="2">
      <Text size="2" weight="bold">Provider setup</Text>
      <Flex align="center" justify="between" gap="3" wrap="wrap">
        <Flex align="center" gap="2">
          <Checkbox checked={done} onCheckedChange={(checked) => setDone(checked === true)} />
          <Text size="2">Create an OAuth app and copy the client ID into NatStack.</Text>
        </Flex>
        <Flex gap="2">
          <Button size="1" variant="soft" onClick={() => createBrowserPanel(consoleUrl, { focus: true })}>
            <GlobeIcon /> Internal
          </Button>
          <Button size="1" variant="soft" onClick={() => openExternal(consoleUrl)}>
            <OpenInNewWindowIcon /> External
          </Button>
        </Flex>
      </Flex>
      <Flex justify="end" gap="2">
        <Button variant="soft" color="gray" onClick={onCancel}>Cancel</Button>
        <Button disabled={!done} onClick={() => onSubmit({ ready: true })}>Continue</Button>
      </Flex>
    </Flex>
  );
}
```

For Google Workspace specifically, use the dedicated
`google-workspace` skill and its setup workflow UI.
For GitHub specifically, use the dedicated `github` skill and its fine-grained
PAT setup workflow.
