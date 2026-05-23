# Agent Debug Port

NatStack agents expose a read-only debug method named `getDebugState`.

Call it through the agent participant:

```ts
const debug = await chat.callMethod(agentParticipantId, "getDebugState", {});
```

The result is a JSON snapshot. It does not mutate the agent and it does not use
timers or timeout recovery. Open work stays open until an explicit completion,
abort, unsubscribe, or user interruption changes state.

## Top-Level Shape

- `schemaVersion`: debug payload schema.
- `generatedAt`: snapshot time.
- `requestedChannelId`: channel filter used by the method.
- `branchInfo`: per-channel trajectory branch ids, context id, participant id,
  and clone/fork metadata.
- `persisted`: Durable Object SQLite tables relevant to agent ownership:
  `state`, `do_identity`, `subscriptions`, `delivery_cursor`, and
  `model_credential_interruptions`.
- `persisted.methodSuspensions` / `persisted.methodSuspensionUpdates`:
  durable external-tool suspension ledger and bounded partial-update log used
  to recover channel method, approval, UI prompt, and ask-user waits after
  hibernation.
- `persisted.recoveryContinuations`: channels with a recovered tool result
  already in the transcript but whose follow-up model continuation still needs
  to start after activation.
- `volatile`: process-local state that is lost on hibernation/restart.

## Volatile State

`volatile.runners[channelId]` includes the Pi runner view:

- `running` and `currentTurnId`.
- `phase.currentOperation`: active `prompt` or `continue` call.
- `phase.awaitingProviderFirstEvent`: true after the provider request hook until
  the first subsequent harness event arrives.
- `phase.checkpoints`: recent prompt/continue, context, provider, and credential
  checkpoints.
- `openInvocationIds` and `openToolInvocations`.
- `recentHarnessEvents` and `recentTrajectoryEvents`.
- `pendingProvenance`, `pendingMutations`, `channelPublicationBroadcasts`.
- `sessionLeafId`, `sessionEntries`, and `contextMessages`.
- `branchInfo` for the runner's GAD trajectory/branch.
- `lastErrors`.

`volatile.dispatchers[channelId]` includes the turn dispatcher queue:

- pending prompt/continue items.
- pending steered user messages.
- active drain generation and lifecycle observations.
- typing/busy flags.

`volatile.methodResultWaiters` lists channel method/tool calls currently waiting
for canonical `invocation.completed`, `invocation.failed`, or cancellation:

- `callId`: transport call id.
- `invocationId`: model/tool invocation id.
- `method`, `participantHandle`, `targetParticipantId`.
- `turnId`, `createdAt`, and summarized args.

There is intentionally no local timeout field. A stuck dispatch remains visible
here until a real channel result or explicit abort arrives.

`volatile.recentPhases` records worker-owned credential/fetch phases, including
model credential resolution and URL-bound model fetch proxy dispatch/response.

`volatile.recentChannelEvents` records recently observed channel events by id,
type, sender, agentic kind, and dispatch mode.

`volatile.lastErrors` records recent worker-owned errors.

## Common Reads

Open turn stuck before provider output:

```ts
debug.volatile.runners[channelId].currentTurnId
debug.volatile.runners[channelId].phase.awaitingProviderFirstEvent
debug.volatile.runners[channelId].phase.checkpoints
```

Open channel tool call:

```ts
debug.volatile.methodResultWaiters
debug.volatile.runners[channelId].openToolInvocations
```

Credential or credentialed fetch stall:

```ts
debug.volatile.recentPhases
debug.persisted.modelCredentialInterruptions
debug.volatile.runners[channelId].phase.checkpoints
```

Replay or dispatcher queue issue:

```ts
debug.volatile.recentChannelEvents
debug.volatile.dispatchers[channelId]
debug.persisted.deliveryCursor
```
