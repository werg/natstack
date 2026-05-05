# Google Workspace Onboarding Flow

This document is for onboarding agents. It describes how to guide a user from
no Google configuration to a verified NatStack Google Workspace connection.

## Principles

- Keep the user in control of secrets. They should import or paste OAuth client
  fields into a trusted setup UI/API; they should not paste client secrets into
  chat.
- Keep the Google Cloud project consistent. APIs, OAuth consent, and OAuth
  credentials must all belong to the same project.
- Require Desktop app credentials. Web application credentials are the wrong
  client type for loopback PKCE.
- Require Production publishing before connecting. Testing mode causes 7-day
  refresh-token expiry for Google user-data scopes.
- Verify with a live API call before declaring onboarding complete.
- Prefer workflow UI over prose. Use the setup UI in [SETUP.md](SETUP.md) so
  the user gets checkboxes and deep links that can open internally or
  externally.

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
| `needs-setup` | Google OAuth client fields are not saved | Render the SETUP.md workflow UI, then run `configureGoogleOAuthClient()` |
| `ready-to-connect` | Trusted URL-bound client config is present but no credential is stored | Run `connectGoogle()` |
| `connected` | Credential exists but live verification has not run | Run `verifyGoogleConnection(connectionId)` |
| `verified` | A live Google userinfo request succeeded | Continue onboarding |
| `error` | Status check failed | Resolve the error and rerun status |

## Missing Setup UX

When setup is missing, render the `feedback_custom` workflow UI from
[SETUP.md](SETUP.md). Do not send only this list as chat prose. The UI must
include these deep-linked actions:

1. Create/select one Google Cloud project.
2. Enable Gmail API, Google Calendar API, and Google Drive API.
3. Configure OAuth branding.
4. Open OAuth audience and publish to Production.
5. Create OAuth credentials with application type Desktop app.
6. Return to NatStack and run `configureGoogleOAuthClient()` so the trusted
   approval UI can collect `installed.client_id` and `installed.client_secret`.

Do not say that Google verification is required for local development. It is
not required while under Google's unverified-app user cap. Do say that users may
see Google's unverified-app warning and can continue through **Advanced**.

Use `createBrowserPanel(url, { focus: true })` for **Internal** link buttons
and `openExternal(url)` for **External** link buttons. If opening an OAuth
authorize URL, pass `{ expectedRedirectUri }` to `openExternal` so the host
validates the callback binding.

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
