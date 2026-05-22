---
name: gmail
description: Gmail-aware channel agent setup, inbox triage, quick replies, compose flows, and Gmail custom message renderers.
---

# Gmail Skill

Use this skill after Google Workspace OAuth is configured. Gmail reuses the
`google-workspace` credential audience and requires Gmail API access.

## Agent Behavior

The Gmail agent is invoked through action-bar controls, custom message pills,
and strict mentions. It should not start a trajectory on every message in a
1:1 channel; the worker uses `respondPolicy = "mentioned-strict"`.

## Runtime Helpers

```typescript
import {
  connectGmail,
  getGmailAgentSetupStatus,
  setupGmailAgent,
} from "@workspace-skills/gmail";
```

Recommended flow:

1. Run `getGmailAgentSetupStatus()`.
2. If Google Workspace is not verified, follow
   `workspace/skills/google-workspace/ONBOARDING.md`.
3. Run `connectGmail()` to connect or verify the Google credential.
4. Run `setupGmailAgent({ channelId: chat.channelId, chat })` from the target chat context.

## Custom Message Types

The skill ships four renderer modules:

| Type | Renderer |
|------|----------|
| `gmail.inbox` | `renderers/gmail-inbox.tsx` |
| `gmail.category` | `renderers/gmail-category.tsx` |
| `gmail.thread` | `renderers/gmail-thread.tsx` |
| `gmail.compose` | `renderers/gmail-compose.tsx` |

`gmail.thread` imports and re-exports its reducer from
`@workspace/gmail/renderers/gmail-thread.reducer`, so the renderer and Gmail DO
fold the same updates.

## Action Bar

`action-bar.tsx` exposes Compose, Search, Check now, and quick-reply controls.
It calls the Gmail agent by handle with `chat.callMethodByHandle("gmail", ...)`.

## Files

| Document | Content |
|----------|---------|
| [ONBOARDING.md](ONBOARDING.md) | Setup flow for agents |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common Gmail setup and sync failures |
| [action-bar.tsx](action-bar.tsx) | Pinned Gmail launcher |
| [system-prompt.md](system-prompt.md) | Gmail agent prompt |
| [index.ts](index.ts) | Importable onboarding helpers |
