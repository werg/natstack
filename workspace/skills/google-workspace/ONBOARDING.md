# Google Workspace Onboarding Flow

This document is for onboarding agents. It describes how to guide a user from
no Google configuration to a verified NatStack Google Workspace connection.

## Principles

- Keep the user in control of secrets. They should import or paste OAuth client
  fields into NatStack's provider setup UI/API; they should not paste client
  secrets into chat.
- Keep the Google Cloud project consistent. APIs, OAuth consent, and OAuth
  credentials must all belong to the same project.
- Require Desktop app credentials. Web application credentials are the wrong
  client type for loopback PKCE.
- Require Production publishing before connecting. Testing mode causes 7-day
  refresh-token expiry for Google user-data scopes.
- Verify with a live API call before declaring onboarding complete.

## Detect State

Run:

```typescript
import {
  formatGoogleOnboardingStatus,
  getGoogleOnboardingStatus,
} from "@workspace-skills/google-workspace";

const status = await getGoogleOnboardingStatus();
console.log(formatGoogleOnboardingStatus(status));
return status;
```

Stages:

| Stage | Meaning | Agent Action |
|-------|---------|--------------|
| `needs-setup` | Google OAuth client fields are not saved | Walk through SETUP.md and save the Desktop app fields through provider setup |
| `ready-to-connect` | Env vars are present but no credential is stored | Run `connectGoogle()` |
| `connected` | Credential exists but live verification has not run | Run `verifyGoogleConnection(connectionId)` |
| `verified` | A live Google userinfo request succeeded | Continue onboarding |
| `error` | Status check failed | Resolve the error and rerun status |

## User Script

When setup is missing, tell the user:

1. "Create or select one Google Cloud project. Keep it selected for every step."
2. "Enable Gmail API, Google Calendar API, and Google Drive API."
3. "Configure OAuth consent with app name, support email, developer contact, and Workspace scopes."
4. "Publish the app to Production. This prevents 7-day refresh-token expiry."
5. "Create OAuth credentials with application type Desktop app."
6. "From the downloaded JSON, save `installed.client_id` and `installed.client_secret` with `saveGoogleOAuthClient()` or the provider setup UI."

Do not say that Google verification is required for local development. It is
not required while under Google's unverified-app user cap. Do say that users may
see Google's unverified-app warning and can continue through **Advanced**.

## Connect

After `getGoogleOnboardingStatus()` reports
`ready-to-connect`, run:

```typescript
import { connectGoogle } from "@workspace-skills/google-workspace";

const result = await connectGoogle();
console.log(result);
return result;
```

If the browser flow succeeds, keep the returned `connectionId`.

## Verify

Run:

```typescript
import { verifyGoogleConnection } from "@workspace-skills/google-workspace";

const verification = await verifyGoogleConnection(connectionId);
console.log(verification);
return verification;
```

If verification fails, consult [TROUBLESHOOTING.md](TROUBLESHOOTING.md). Do not
continue onboarding until the live API call is valid.

## Completion Criteria

Onboarding is complete only when:

- Google OAuth client setup is saved.
- At least one `google-workspace` connection exists.
- `verifyGoogleConnection(connectionId)` returns `{ valid: true }`.
- The user understands the app should remain published to Production.
