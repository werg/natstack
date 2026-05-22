# Gmail Agent Onboarding

## Detect State

```typescript
import { getGmailAgentSetupStatus } from "@workspace-skills/gmail";

const status = await getGmailAgentSetupStatus();
return status;
```

Stages:

| Stage | Meaning | Next Action |
|-------|---------|-------------|
| `needs-google-workspace` | Google OAuth is missing or unverified | Complete the Google Workspace skill |
| `needs-channel-setup` | Google Workspace is verified, but Gmail is not registered in this workspace | Run `setupGmailAgent({ channelId: chat.channelId, chat })` |
| `ready` | Gmail agent is registered for this workspace | Use the Gmail action bar or `@gmail` |

## Setup

After Google Workspace reports verified, run:

```typescript
import { connectGmail, setupGmailAgent } from "@workspace-skills/gmail";

await connectGmail();
await setupGmailAgent({ channelId: chat.channelId, chat });
```

The setup flow registers the Gmail custom message types, loads the action bar,
and prepares the channel for the Gmail worker.

## Completion Criteria

- Google Workspace credential is verified.
- Gmail custom message renderers are registered in the channel.
- The Gmail action bar is loaded.
- The Gmail agent participant is present with handle `gmail`.
