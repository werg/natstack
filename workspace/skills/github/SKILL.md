---
name: github
description: Set up GitHub access for NatStack with fine-grained personal access tokens, URL-bound credentials, deep links, and verification helpers.
---

# GitHub Skill

Use this skill when a user wants NatStack to connect to GitHub for repository
metadata, issues, pull requests, contents API calls, Actions-related reads, or
to create the PAT needed for direct GitHub clone/pull/push support.

## Default Approach

Use a GitHub fine-grained personal access token. This is the simplest approach
that requires no centralized NatStack server, no app registration controlled by
NatStack, and no OAuth callback infrastructure.

GitHub Apps are more granular for multi-user products, but they require app
registration and installation flows. OAuth apps can work, but for this personal
sandbox they add more moving pieces than a user-owned fine-grained PAT and still
do not avoid broad user authorization concerns.

## Workflow

1. Run `getGitHubOnboardingStatus()` from `@workspace-skills/github`.
2. If the stage is `needs-token`, render the setup workflow from `SETUP.md`.
3. Send users to GitHub's fine-grained token creation page with the deep links
   in `getGitHubTokenSetupLinks()` or `openGitHubTokenSettings()`.
4. Call `requestGitHubTokenCredential()` so the shell-owned approval UI collects
   the PAT. Do not ask the user to paste the PAT into chat or a panel-owned form.
   Use `mode: "api"` for API-only access, `mode: "git"` for clone/pull/push
   permissions, or `mode: "api-and-git"` when the user wants both.
5. Run `verifyGitHubCredential(credentialId)` or
   `getGitHubOnboardingStatus({ verify: true })`.

## Runtime Helpers

```ts
import {
  getGitHubOnboardingStatus,
  requestGitHubTokenCredential,
  verifyGitHubCredential,
} from "@workspace-skills/github";

const status = await getGitHubOnboardingStatus();
if (status.stage === "needs-token") {
  const stored = await requestGitHubTokenCredential({
    mode: "api",
    presets: ["contents-read", "issues", "pull-requests"],
  });
  await verifyGitHubCredential(stored.id);
}
```

The stored credential is URL-bound to `https://api.github.com/`. API requests
should use `credentials.fetch()`. For direct GitHub clone/pull/push, request
`mode: "git"` or `mode: "api-and-git"` so the saved PAT has repository contents
permissions. The internal git server no longer consumes GitHub credentials; a
host-mediated isomorphic-git HTTP adapter should use the stored PAT for
`https://github.com/...` git remotes without exposing it to panels or workers.

## Permission Presets

- Clone: Metadata read, Contents read.
- Pull: Metadata read, Contents read.
- Push: Metadata read, Contents write.
- Contents read: Metadata read, Contents read.
- Contents write: Metadata read, Contents write.
- Issues: Metadata read, Issues read/write.
- Pull requests: Metadata read, Pull requests read/write.
- Actions read: Metadata read, Actions read.
- Workflows: Metadata read, Contents write, Workflows write.

Use the narrowest set that supports the requested workflow. Avoid workflow
write unless the user explicitly wants to edit GitHub Actions workflow files.

## Troubleshooting

- `401 Bad credentials`: the PAT was revoked, expired, or copied incorrectly.
- `403 Resource not accessible by personal access token`: the token does not
  have access to that repository or the needed permission.
- Git clone or push is requested: use `mode: "git"` or `mode: "api-and-git"`
  when creating the PAT. Git transport should be wired through the host
  isomorphic-git credential adapter, not the internal git server.
