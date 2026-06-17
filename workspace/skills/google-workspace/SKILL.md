---
name: google-workspace
description: Set up broad Google Workspace OAuth credentials with staged local bindings for Gmail, Calendar, Drive, Docs, Sheets, Slides, People, and identity.
---

# Google Workspace Skill

Use this skill to configure and verify Google Workspace OAuth for Gmail,
Calendar, Drive, Docs, Sheets, Slides, People, and identity. The goal is not
just "make OAuth work"; guide the user toward a durable setup with a Desktop
app OAuth client, Production publishing, offline refresh tokens, a broad
upstream Workspace grant, staged local bindings, and a verified live API call.

## Onboarding Policy

Be explicit about state and next action. Do not ask the user to paste secrets
into chat. When Google Cloud setup is missing, render the workflow UI from
[SETUP.md](SETUP.md); do not replace it with a plain numbered list.

Use this order:

1. Run `getGoogleOnboardingStatus()` and summarize the stage.
2. If `stage === "needs-setup"`, show the [SETUP.md](SETUP.md) workflow UI.
3. If `stage === "ready-to-connect"`, run `connectGoogle()`.
4. If `stage === "connected"`, run `verifyGoogleConnection(connectionId)`.
5. If `stage === "verified"`, continue onboarding.

`connectGoogle()` must be the connection path for Google Workspace. It requests
Google offline access and opts into NatStack refresh-token persistence. If
status or verification reports `credential-expired`, replace the old credential
with `connectGoogle({ force: true })`.

NatStack intentionally asks Google for a broad Workspace bundle once, then
stores separate local bindings: `google-gmail`, `google-calendar`,
`google-drive`, `google-docs`, `google-sheets`, `google-slides`,
`google-people`, and `google-identity`. Agents should use the service-specific
client/helper instead of asking the user to reconnect when moving from Gmail to
Calendar or Docs.

When the user is setting up Gmail specifically, continue with
`skills/gmail/ONBOARDING.md` after Google Workspace reaches
`verified`.

Never skip the Production publishing step. Testing-mode refresh tokens for
Gmail, Calendar, and Drive expire after 7 days.

## What The User Must Do

1. Create or choose a Google Cloud project.
2. Enable the Gmail, Calendar, Drive, Docs, Sheets, Slides, and People APIs.
3. Configure the OAuth consent screen with the required scopes.
4. Publish the app to Production, even while unverified.
5. Create OAuth credentials with application type **Desktop app**.
6. Run `configureGoogleOAuthClient()` and have the user enter
   `installed.client_id` and `installed.client_secret` in the trusted approval
   UI. Do not ask the user to paste client secrets into chat.
7. Connect the account through NatStack's credential flow.
8. Verify a live Google API call succeeds.

Deep-link every Google Console step where possible. Offer both:

- **Internal**: `openPanel(url, { focus: true })`
- **External**: `openExternal(url)` through the approval-gated browser-open API

If the agent opens an internal browser panel only for setup guidance,
verification, or diagnostics, keep the handle and close it when that step is
complete. Leave it open only when the user needs to continue interacting with
Google Cloud or the OAuth flow in that panel.

Read [SETUP.md](SETUP.md) for the full guided setup and
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common Google OAuth errors.

## Runtime Helpers

The helper package is importable in eval and panels:

```typescript
import {
  checkGoogleConnection,
  configureGoogleOAuthClient,
  connectGoogle,
  formatGoogleOnboardingStatus,
  getGoogleOnboardingStatus,
  verifyGoogleConnection,
} from "@workspace-skills/google-workspace";
```

Recommended onboarding flow:

```typescript
const status = await getGoogleOnboardingStatus();
console.log(formatGoogleOnboardingStatus(status));

if (status.stage === "needs-setup") {
  // Render the workflow UI from SETUP.md. After the user creates the Desktop
  // client, run configureGoogleOAuthClient(); the trusted approval UI collects
  // installed.client_id and installed.client_secret.
  await configureGoogleOAuthClient();
}

if (status.stage === "ready-to-connect") {
  const result = await connectGoogle();
  if (result.success && result.connectionId) {
    await verifyGoogleConnection(result.connectionId);
  }
}
```

Use `checkGoogleConnection()` only for terse status checks. Prefer
`getGoogleOnboardingStatus()` during onboarding because it includes next
actions, warnings, and checklist state.

## Files

| Document | Content |
|----------|---------|
| [ONBOARDING.md](ONBOARDING.md) | Agent-facing guided onboarding flow |
| [SETUP.md](SETUP.md) | Step-by-step Google Cloud setup |
| [TESTING.md](TESTING.md) | Runtime verification snippets |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common errors and fixes |
| [index.ts](index.ts) | Importable onboarding helpers |

## Related Follow-Up

| Skill | When to use |
|-------|-------------|
| `gmail` | Set up the Gmail channel agent, custom message pills, action bar, and Gmail-specific workflows after Google Workspace is verified |
