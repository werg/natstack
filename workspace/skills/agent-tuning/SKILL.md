---
name: agent-tuning
description: Change the host chat agent's default model/provider, add model credentials, and tune live session effort, approval, and chattiness.
---

# Agent Tuning

Use this skill when a user wants to change the AI chat agent's model, provider,
credential setup, thinking effort, approval behavior, or response policy.

## Two Tiers

Cold-start choices live in `workers/agent-worker/agent-config.ts`:

- `DEFAULT_MODEL` chooses the default `provider:modelId`.
- `PROVIDER_CREDENTIAL_SETUPS` wires OAuth or API-key credential collection.
- These choices apply when a worker boots or when a channel subscribes with an
  `extraConfig.model` override. Do not expect a live `setModel` toggle.

Session knobs are method calls on the agent participant:

- `setThinkingLevel({ level })` where `level` is `minimal`, `low`, `medium`, or `high`.
- `setApprovalLevel({ level })` where `level` is `0`, `1`, or `2`.
- `setRespondPolicy({ policy, from? })` where `policy` is `all`, `mentioned`, `mentioned-strict`, or `from-participants`.
- `getAgentSettings()` returns current values and whether each came from state, subscription config, or defaults.
- `connectModelCredential({ providerId, ... })` starts the provider's OAuth or API-key credential flow. `connectModelCredentialOAuth` remains as a compatibility alias.

## Switching The Default Model

Edit `workers/agent-worker/agent-config.ts` and set `DEFAULT_MODEL`.

Examples:

- OpenAI Codex: `openai-codex:gpt-5.5`
- Anthropic flagship: `anthropic:claude-opus-4-7`
- Anthropic Sonnet: `anthropic:claude-sonnet-4-6`
- Google Vertex flagship: `google-vertex:gemini-3.1-pro`

When editing `agent-config.ts`, prefer the provider's current flagship. If you
do not know what that is, check the provider's announcements page; pi-ai's
catalog (`@earendil-works/pi-ai`'s `models.generated.d.ts`) is the source of
truth for ids wired into the runtime.

## Adding An OAuth Provider

Copy a commented provider template in `PROVIDER_CREDENTIAL_SETUPS`, set the
real provider id, and verify every URL/scope against the provider's current
docs before enabling it. OAuth provider templates intentionally include
`VERIFY` comments because provider endpoints and scopes are product-specific.

If the provider returns account identity in a nonstandard claim, also update
`AiChatWorker.getModelCredentialTokenClaims()` so the model SDK receives the
claims it expects.

## Adding An API-Key Provider

Copy the `__api-key-template__` block in `agent-config.ts`.

Set:

- `providerId` by using the provider id as the map key.
- `DEFAULT_MODEL` to the matching `provider:modelId`.
- `credential.audience` to the provider API origin/base path.
- `credential.injection.name` and `valueTemplate` to the provider's auth header convention.

`materialTemplate` controls what token material is stored. `credential.injection`
controls what is placed on outbound model requests.

## Tuning A Live Session

Use `inline_ui`, `ActionButton`, or a small action bar that calls the agent
participant's methods. A minimal inline UI can call:

```tsx
await chat.callMethod(agentParticipantId, "setThinkingLevel", { level: "high" });
await chat.callMethod(agentParticipantId, "setApprovalLevel", { level: 1 });
await chat.callMethod(agentParticipantId, "setRespondPolicy", {
  policy: "from-participants",
  from: ["participant-id"],
});
const settings = await chat.callMethod(agentParticipantId, "getAgentSettings", {});
```

## Per-Channel Overrides

Headless/session subscribers may pass `extraConfig`:

```ts
{
  model: "anthropic:claude-sonnet-4-6",
  thinkingLevel: "high",
  approvalLevel: 1,
  respondPolicy: "mentioned",
  systemPrompt: "Extra instructions...",
  systemPromptMode: "append",
}
```

Lookup order:

- `model`: subscription config, then default.
- `thinkingLevel`: live state, subscription config, then default.
- `approvalLevel`: live state, subscription config/channel config, then default.
- `respondPolicy` and `respondFrom`: live state, subscription config, then default.
