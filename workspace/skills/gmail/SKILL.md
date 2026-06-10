---
name: gmail
description: Gmail-aware channel agent setup, inbox triage, quick replies, compose flows, and Gmail custom message renderers.
---

# Gmail Skill

Use this skill after Google Workspace OAuth is configured. Gmail reuses the
`google-workspace` credential audience and requires Gmail API access.

## Agent Behavior

The Gmail agent is invoked through action-bar controls, custom message pills,
explicit `@gmail` mentions, and direct user follow-ups immediately after one of
its own messages. It should not start a trajectory on every message in a 1:1
channel; the worker uses `respondPolicy = "mentioned-or-followup"`.

Incoming-mail attention is deterministic and cheap by default. The built-in
rule only starts an agent turn for unread inbox mail from senders the user has
already replied to at least once. Users can add, pause, delete, or replace watch
rules from the Gmail desk without enabling model work over every message.

## Runtime Helpers

```typescript
import {
  callGmailAgent,
  getGmailAgentSetupStatus,
  resolveGmailAgentWorker,
  setupGmailAgent,
} from "@workspace-skills/gmail";
```

Recommended flow:

1. Run `getGmailAgentSetupStatus()`.
2. If Google Workspace is not verified, follow
   `workspace/skills/google-workspace/ONBOARDING.md`.
3. Once Google Workspace is verified, run
   `setupGmailAgent({ channelId: chat.channelId })` from the target chat
   context. Do not start another OAuth flow after verification.

The Gmail worker owns its in-channel UI installation. On subscription it
registers the Gmail custom message renderers, publishes the Gmail action bar,
and starts first-run attention setup when the channel is not configured yet.
The setup helper should only create/subscribe the Gmail worker and persist the
installed-agent record for panel reloads.

If the user configures attention from the Gmail desk UI, the UI calls
`markConfigured` after installing the watch rule so the setup badge clears.

## Attention Rule DX

Attention rules are application state on the Gmail Durable Object, not model
runner tools. The Gmail agent has access to eval and normal workspace tools; it
should edit rules by calling the Gmail DO over RPC from eval. No
`workspace/meta/natstack.yml` service entry is required for this path because
`workers.resolveDurableObject(...)` can resolve the concrete Gmail DO target.
Rule writes are accepted from user-facing callers such as the chat panel; DO
callers may inspect rules but cannot silently rewrite them.

```typescript
import { callGmailAgent } from "@workspace-skills/gmail";

await callGmailAgent(chat.channelId, "upsertAttentionRule", {
  rule: {
    id: "vip-domain",
    name: "VIP domain",
    enabled: true,
    scope: "snippet",
    priority: 200,
    match: { any: [{ field: "fromDomain", op: "equals", value: "vip.example" }] },
    actions: ["surface", "summarize"],
  },
});
```

The public rule methods are:

| Method | Purpose |
|--------|---------|
| `listAttentionRules(channelId)` | Inspect current rules and supported fields/actions |
| `upsertAttentionRule(channelId, { rule })` | Create or replace one rule |
| `setAttentionRuleEnabled(channelId, { id, enabled })` | Pause or resume one rule |
| `deleteAttentionRule(channelId, { id })` | Remove one rule |
| `clearAttentionRules(channelId)` | Quiet mode: remove all wake rules |
| `resetAttentionRules(channelId)` | Restore the default prior-reply rule |

## Channel Method Surface

These methods are callable on the Gmail participant via
`chat.callMethodByHandle("gmail", method, args)` (and from cards/action bar):

| Method | Args | Purpose |
|--------|------|---------|
| `checkNow` | `{}` | Sync now and refresh cards |
| `markConfigured` | `{ summary? }` | Finish first-run setup |
| `reconnect` | `{}` | Re-verify the Google credential; returns `{ ok, auth }` |
| `setAttentionRuleEnabled` | `{ id, enabled }` | Toggle one wake rule (setup card) |
| `search` / `clearSearch` | `{ q, limit? }` | Update the inbox card search section in place |
| `getThread` | `{ threadId }` | Sanitized thread contents (transient) |
| `openThread` | `{ threadId }` | Publish/focus a standalone `gmail.thread` card |
| `compose` | `{ to?, subject?, body?, threadId? }` | New compose card (`drafting`) |
| `draftReply` | `{ threadId }` | Agent-drafted reply card in `review` state |
| `send` | compose payload + `messageId` | Send; user Send click or explicit user request only |
| `saveDraft` / `discardCompose` | compose payload / `{ messageId }` | Save to Gmail drafts / discard. Forgiving: with no resolvable recipient/subject it does NOT error — it parks the draft on a compose card in `drafting` state and returns `{ ok, composeId, cardCreated, note }` |
| `resolveContact` | `{ name, limit? }` | Resolve a name to email candidates (history first, Google contacts fallback) |
| `contactSuggest` | `{ prefix, limit? }` | Fast typeahead over the derived address book (no network) — backs the compose card's To/Cc/Bcc autocomplete |
| `archiveThread` / `markRead` / `categorize` | `{ threadId, ... }` | Triage operations |
| `listActionableThreads` | `{ limit? }` | Current actionable threads |
| `setPollInterval` | `{ pollIntervalMs }` | Configure polling |

## Multi-Agent Participant API

Other agents in the channel get a read-mostly surface (same dispatch):

| Method | Args | Purpose |
|--------|------|---------|
| `gmail_query` | `{ q, maxResults? }` | `{ source, query, count, results: [{ threadId, subject, from, fromEmail, snippet, unread, date }] }` — cache-first with API fallback; `from` is the raw display header, `fromEmail` the parsed bare address |
| `gmail_getThread` | `{ threadId }` | Sanitized thread messages |
| `gmail_getOverview` | `{}` | Dashboard snapshot: counts, auth status, actionable list |
| `gmail_requestDraft` | `{ threadId?, to?, subject?, intent }` | Compose card in `review` state |
| `gmail_resolveContact` | `{ name, limit? }` | Read-only contact resolution (same shape as `resolveContact`) |

Agents can prepare mail but never send it: only the user's Send click on the
compose card (or an explicit user instruction to the Gmail agent) sends.
Attention-rule writes remain gated to user-facing callers; reads are open.

## Contact Resolution

`resolveContact` / `gmail_resolveContact` return:

```typescript
{
  query: string,
  candidates: Array<{
    email: string;
    displayName?: string;
    sentTo: number;          // times the user sent mail to this address
    receivedFrom: number;    // times mail arrived from this address
    lastInteractionAt?: number;
    youReplied: boolean;
    source: "history" | "google-contacts";
    score: number;           // sentTo*3 + receivedFrom + youReplied*10 + recency bonus
  }>
}
```

Candidates come from a derived per-channel people store harvested during sync
(From on incoming mail, To/Cc on sent mail). When history yields nothing, the
worker falls back to the Google People API (`people:searchContacts`, then
`otherContacts:search`).

People API fallback requires the `contacts.readonly` and
`contacts.other.readonly` scopes (added to the google-workspace skill's
default scope list). Credentials connected before that addition get a 403;
the worker remembers this per channel, stops calling the API, and surfaces
"Google contacts: unavailable — reconnect Google to enable it" on the
`gmail.setup` card. History-based resolution keeps working regardless.

Compose flows accept `toCandidates` (the candidate array) and store it on the
compose card so the renderer offers one-click recipient selection.

## Wake Batching

Attention hits are queued and debounced (~90s) into one digest turn covering
all queued hits, capped at 4 wake turns per hour per channel. Overflow hits
stay queued and surface as `needsAttentionCount` on the inbox card until the
next allowed digest.

Use workspace code edits for behavior that cannot be expressed as static rule
state. The default static fields are sender, sender domain, recipients,
subject, snippet, label, category, attachments, prior-reply sender, and wake-all.

## Custom Message Types

The skill ships four renderer modules:

| Type | Renderer |
|------|----------|
| `gmail.setup` | `renderers/gmail-setup.tsx` |
| `gmail.inbox` | `renderers/gmail-inbox.tsx` |
| `gmail.thread` | `renderers/gmail-thread.tsx` |
| `gmail.compose` | `renderers/gmail-compose.tsx` |

`gmail.thread` imports and re-exports its reducer from
`@workspace/gmail/renderers/gmail-thread.reducer`, so the renderer and Gmail DO
fold the same updates.

## Action Bar

`action-bar.tsx` exposes Compose, Search, Check now, and quick-reply controls.
It calls the Gmail agent by handle with `chat.callMethodByHandle("gmail", ...)`.
The worker publishes this action bar as channel UI during subscription, so both
manual agent launch and onboarding-driven setup get the same controls.

Compose cards default to review-before-send: agent-generated drafts arrive in
`review` state and only the user's Send button sends them. Cards support
Cc/Bcc, can save Gmail drafts, and can be discarded. Thread and inbox cards expose read/archive/draft
triage actions; the inbox card supports bulk mark-read/archive for selected
threads.

## Files

| Document | Content |
|----------|---------|
| [ONBOARDING.md](ONBOARDING.md) | Setup flow for agents |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common Gmail setup and sync failures |
| [action-bar.tsx](action-bar.tsx) | Pinned Gmail launcher |
| [system-prompt.md](system-prompt.md) | Gmail agent prompt |
| [index.ts](index.ts) | Importable onboarding helpers |
