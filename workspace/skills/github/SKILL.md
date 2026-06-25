---
name: github
description: Set up broad GitHub access for NatStack with fine-grained or classic personal access tokens, staged local bindings, deep links, and verification helpers.
---

# GitHub Skill

Use this skill when a user wants NatStack to connect to GitHub for repository
metadata, issues, pull requests, contents API calls, Actions-related reads, or
to create the PAT needed for direct GitHub clone/pull/push support.

## Default Approach

Use a GitHub fine-grained personal access token. This is the simplest approach
that requires no centralized NatStack server, no app registration controlled by
NatStack, and no OAuth callback infrastructure. The default helper path is
broad upstream access with local staging: a fine-grained PAT can be valid for
All repositories, while NatStack stores separate bindings for user API,
repository API, release uploads, and git HTTPS. Repository API approvals stage
to `/repos/{owner}/{repo}/`.

If the user wants blanket or higher-trust access instead of least-privilege
setup, say so plainly and offer the broad route:

- Fine-grained PAT: choose **All repositories**, then grant the prefilled broad
  repository permissions needed for durable workspace use.
- Classic PAT: use broader scopes such as `repo` when the user explicitly wants
  broad access and accepts the larger blast radius.

`requestGitHubTokenCredential()` can store either token style. Use
`tokenKind: "classic"` when the user chose a classic PAT so the credential
metadata matches what was saved.

GitHub Apps are more granular for multi-user products, but they require app
registration and installation flows. OAuth apps can work, but for this personal
sandbox they add more moving pieces than a user-owned fine-grained PAT and still
do not avoid broad user authorization concerns.
GitHub App support is the right follow-up for API surfaces that fine-grained
PATs do not cover, such as Checks API writes.

## Workflow

1. Run `getGitHubOnboardingStatus()` from `@workspace-skills/github`.
2. If the stage is `needs-token`, ask the user to choose token style:
   - **Fine-grained PAT (recommended)**: broad-but-staged, can choose All
     repositories, and GitHub requires selecting permission categories.
   - **Classic PAT (broad)**: faster blanket access with broad scopes such as
     `repo`; use only when the user explicitly accepts the larger blast radius.
3. Ask for a broad-strokes access level instead of exposing every GitHub
   permission:
   - **Read Only**: inspect repositories, issues, PRs, Actions, and clone/pull
     repository remotes without changing code.
   - **Collaborate**: normal code/content changes plus issues and PRs.
   - **Code + Workflows**: collaborate plus GitHub Actions workflow edits.
   - **Broad**: high-trust access; pair with All repositories or classic `repo`.
4. Open the chosen GitHub token page and offer both browser options:
   - Internal: `openGitHubTokenSettings({ tokenKind, accessLevel, browser: "internal" })` or
     `openPanel(url, { focus: true })`.
   - External: `openGitHubTokenSettings({ tokenKind, accessLevel, browser: "external" })` or
     `openExternal(url)`.
     If the agent opens an internal browser panel only to guide setup or verify a
     page, keep the handle and close it when that step is complete. Leave it open
     only when the user needs to continue interacting with GitHub in that panel.
5. Call `requestGitHubTokenCredential()` so the shell-owned approval UI collects
   the PAT. Do not ask the user to paste the PAT into chat or a panel-owned form.
   Access levels choose the right mode automatically. Use explicit
   `mode: "api"` only for API-only access, `mode: "git"` only for
   clone/pull/push permissions, or `mode: "api-and-git"` when the user wants
   both.
   If the user chose a broad classic token, pass `tokenKind: "classic"`.
6. Run `verifyGitHubCredential(credentialId)` or
   `getGitHubOnboardingStatus({ verify: true })`.
7. If the user intends to clone/pull/push a specific remote, run
   `verifyGitHubGitRemoteAccess(remoteUrl, credentialId)` before declaring git
   remote access complete.

Only render the full [SETUP.md](SETUP.md) checklist when the user asks for
guided setup or needs help choosing repository access and permissions. Do not
lead with the checklist for routine GitHub access.

## Runtime Helpers

```ts
import {
  getGitHubOnboardingStatus,
  openGitHubTokenSettings,
  requestGitHubTokenCredential,
  verifyGitHubCredential,
  verifyGitHubGitRemoteAccess,
} from "@workspace-skills/github";

const status = await getGitHubOnboardingStatus();
if (status.stage === "needs-token") {
  const tokenKind = "fine-grained"; // or "classic" if the user chose broad access
  const accessLevel = "broad";
  await openGitHubTokenSettings({ tokenKind, accessLevel, browser: "internal" });
  const stored = await requestGitHubTokenCredential({
    tokenKind,
    accessLevel,
  });
  await verifyGitHubCredential(stored.id);
  await verifyGitHubGitRemoteAccess("https://github.com/owner/repo.git", stored.id);
}
```

For broad access, the storage call is still simple:

```ts
const stored = await requestGitHubTokenCredential({
  accessLevel: "broad",
  tokenKind: "classic",
});
```

For setup links, use Internal when the user wants to keep setup inside NatStack;
use External when their normal browser already has GitHub auth, passkeys, or
password-manager state. The full workflow UI in `SETUP.md` is optional guidance,
not the default happy path.

The stored credential is URL-bound through staged bindings:
`github-user`, `github-repos`, `github-uploads`, and `github-git-http`.
API requests should use `credentials.fetch()`. Direct GitHub clone/pull/push
should use `@natstack/git` with `credentials.gitHttp()`. NatStack's
host-mediated isomorphic-git HTTP adapter handles `https://github.com/...` git
remotes without exposing the PAT to panels or workers.

```ts
import { credentials, fs } from "@workspace/runtime";
import { GitClient } from "@natstack/git";

const client = new GitClient(fs, { http: credentials.gitHttp() });
await client.clone({
  url: "https://github.com/owner/repo.git",
  dir: "/repo",
});
const status = await client.status("/repo");
```

For normal runtime code, use the host-mediated HTTP adapter:

```ts
import { credentials, fs } from "@workspace/runtime";
import { GitClient } from "@natstack/git";

const client = new GitClient(fs, { http: credentials.gitHttp() });
await client.clone({ url: "https://github.com/owner/repo.git", dir: "/repo" });
await client.push({ dir: "/repo" });
```

Use `client.status(dir)` for structured status. Use `client.statusMatrix(dir)`
only when raw isomorphic-git HEAD/WORKDIR/STAGE tuples are needed.

To make a GitHub remote available to future workspace contexts, configure it as
a shared remote instead of only editing the current context's `.git/config`.
This records the declaration in `meta/natstack.yml`:

```ts
import { git } from "@workspace/runtime";

await git.setSharedRemote("panels/my-panel", {
  name: "origin",
  url: "https://github.com/owner/my-panel.git",
  branch: "main",
});
```

The durable config shape is:

```yaml
git:
  remotes:
    panels:
      my-panel:
        origin:
          url: https://github.com/owner/my-panel.git
          branch: main
        ci: https://github.com/owner/my-panel-ci.git
```

To import a remote repository into workspace source, use `git.importProject()`
with the destination path where it should live:

```ts
import { git } from "@workspace/runtime";

await git.importProject({
  path: "panels/my-panel",
  remote: {
    name: "origin",
    url: "https://github.com/owner/my-panel.git",
    branch: "feature/workspace-integration",
  },
  branch: "feature/workspace-integration",
  credentialId: "cred_github_...",
});
```

Supported parent directories are `panels`, `packages`, `workers`,
`skills`, `about`, `templates`, and `projects`. `git.importProject()` uses one
workspace config approval showing destination path, remote URL, and branch;
then it records the shared remote in `meta/natstack.yml`, clones into canonical
workspace source, and makes the repo available to future contexts. It may also
prompt to use the selected GitHub credential for the clone.

Repos declared in `meta/natstack.yml` are imported automatically at startup.
Use `git.completeWorkspaceDependencies()` as an explicit retry/backfill when a
configured workspace repo is still missing. For private repos, pass the GitHub
credential id on this retry path because startup auto-import has no interactive
`credentialId` argument:

```ts
const result = await git.completeWorkspaceDependencies({ credentialId: "cred_github_..." });
console.log(result.imported, result.skipped, result.failed);
```

For the full external-project model, including string vs `{ url, branch }`
config declarations, see
`skills/onboarding/EXTERNAL_GIT_PROJECTS.md`.

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
- Statuses: Metadata read, Statuses read/write.
- Deployments: Metadata read, Deployments read/write.
- Discussions: Metadata read, Discussions read/write.

Use Broad when the user wants seamless future repository access. Use the
narrower presets only when the user explicitly wants upstream narrowing. Avoid
workflow write unless the user explicitly wants to edit GitHub Actions workflow
files.

## Troubleshooting

- `401 Bad credentials`: the PAT was revoked, expired, or copied incorrectly.
- `403 Resource not accessible by personal access token`: the token does not
  have access to that repository or the needed permission.
- Git clone or push is requested: use a friendly access level, or explicit
  `mode: "git"` / `mode: "api-and-git"` when creating the PAT. Verify a target
  remote with `verifyGitHubGitRemoteAccess(remoteUrl, credentialId)`. Git
  transport should use `@natstack/git` with `credentials.gitHttp()`.
