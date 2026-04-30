# GitHub Troubleshooting

## Verification Fails

- `401 Bad credentials`: regenerate the token and save it again.
- `403 Resource not accessible by personal access token`: add repository access
  or the missing fine-grained permission in GitHub.
- Organization repositories may require organization approval for fine-grained
  PAT access.

## Git Clone Or Push Is Needed

Create the PAT with `requestGitHubTokenCredential({ mode: "git" })` or
`mode: "api-and-git"` so it has repository contents permissions. The internal
git server does not consume GitHub credentials or transparently proxy GitHub
repositories. Direct clone, pull, push, or fork workflows should use
`git.client()` from `@workspace/runtime`, or `credentials.gitHttp()` with raw
isomorphic-git, so the PAT is not exposed to panels or workers.
