---
name: google-workspace
description: Set up Google Workspace (Gmail, Calendar, Drive) OAuth credentials for this NatStack instance
---

# Google Workspace Skill

Use this skill to configure and verify Google Workspace OAuth for Gmail,
Calendar, and Drive. The goal is not just "make OAuth work"; guide the user
toward a durable setup with a Desktop app OAuth client, Production publishing,
offline refresh tokens, and a verified live API call.

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

Never skip the Production publishing step. Testing-mode refresh tokens for
Gmail, Calendar, and Drive expire after 7 days.

## What The User Must Do

1. Create or choose a Google Cloud project.
2. Enable the Gmail, Calendar, and Drive APIs.
3. Configure the OAuth consent screen with the required scopes.
4. Publish the app to Production, even while unverified.
5. Create OAuth credentials with application type **Desktop app**.
6. Save/use the Desktop app `installed.client_id` and
   `installed.client_secret` through the Google credential setup path. Do not
   ask the user to paste client secrets into chat.
7. Connect the account through NatStack's credential flow.
8. Verify a live Google API call succeeds.

Deep-link every Google Console step where possible. Offer both:

- **Internal**: `createBrowserPanel(url, { focus: true })`
- **External**: `openExternal(url)` through the approval-gated browser-open API

Read [SETUP.md](SETUP.md) for the full guided setup and
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common Google OAuth errors.

## Runtime Helpers

The helper package is importable in eval and panels:

```typescript
import {
  checkGoogleConnection,
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
  // Render the workflow UI from SETUP.md, then use the Desktop app client_id
  // and client_secret from the credential setup path.
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
