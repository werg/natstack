# GitHub Troubleshooting

## Verification Fails

- `401 Bad credentials`: regenerate the token and save it again.
- `403 Resource not accessible by personal access token`: add repository access
  or the missing fine-grained permission in GitHub.
- Organization repositories may require organization approval for fine-grained
  PAT access.

## Git Clone Or Push Is Needed

Create the PAT with a friendly access level such as
`requestGitHubTokenCredential({ accessLevel: "read-only" })` for clone/pull or
`accessLevel: "collaborate"` for push. Explicit `mode: "git"` and
`mode: "api-and-git"` are still available for lower-level agent flows. Verify a
specific remote with `verifyGitHubGitRemoteAccess(remoteUrl, credentialId)`.

The internal git server does not consume GitHub credentials or transparently
proxy GitHub repositories. Direct clone, pull, push, or fork workflows should
use `git.client()` from `@workspace/runtime`, or `credentials.gitHttp()` with
raw isomorphic-git, so the PAT is not exposed to panels or workers.
