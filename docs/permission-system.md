# Permission System

NatStack treats runtime tokens as authentication, not authorization. A token
identifies the caller. Sensitive actions must still pass through the server-side
permission system before they run.

## Decision Model

User decisions share the same scope vocabulary:

- `once`: allow this operation only, without storing a grant.
- `session`: allow matching operations until the server process exits.
- `version`: allow matching operations for the same source repo and effective version.
- `repo`: allow matching operations for the same source repo.

The renderer is only a prompt surface. Pending prompts, session grants, and
persistent grants are all held server-side.

## Capability Grants

Use `requestCapabilityPermission()` for host capabilities that are not
credentials. It handles:

- caller identity lookup via `CodeIdentityResolver`
- reusable grant lookup via `CapabilityGrantStore`
- prompt creation via `ApprovalQueue`
- `once` vs persisted grant behavior

Each permission has:

- `capability`: stable permission type, such as `external-browser-open` or
  `internal-git-write`
- `resource.key`: stable grant key
- `resource.value`: human-readable UI value

Do not hand-roll this flow in individual services.

## Git Writes

Internal git writes use the `internal-git-write` capability. The git HTTP token
only identifies the caller. Pushes fail closed if the git server has no write
authorizer configured.

The same gate is also used for RPC-created repositories.
