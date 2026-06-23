import { CREDENTIAL_CONNECT_PAYLOAD_KIND } from "@workspace/agentic-protocol";
/**
 * Effect executors (WS1 §2.4) — the impure edge of the event-sourced harness.
 *
 * Each executor consumes a pure EffectDescriptor and produces an
 * EffectOutcome (or `{deferred: true}` when the result arrives later via
 * `deliverEffectOutcome`). Terminal mapping back to events is the pure
 * `outcomeEvents` in @workspace/agent-loop.
 */

import type {
  ChannelCallEffect,
  CredentialWaitEffect,
  EffectDescriptor,
  EffectOutcome,
  HttpCallEffect,
  LocalToolEffect,
  PublishEnvelopeEffect,
} from "@workspace/agent-loop";
import { modelCallExecutor } from "./model-call.js";
import type { EffectExecutor } from "./types.js";

export * from "./types.js";
export { modelCallExecutor, toProtocolBlocks } from "./model-call.js";

/** local_tool (§2.4.2): registry execution with the mutation-replay guard. */
export const localToolExecutor: EffectExecutor<LocalToolEffect> = {
  kind: "local_tool",
  async execute({ descriptor, state, signal, deps, onEphemeral }) {
    // §1.4.2 retry rule: a mutating tool whose state.file_mutation_applied is
    // already folded synthesizes success instead of re-executing.
    if (deps.localTools.alreadyApplied(state, descriptor.invocationId)) {
      return {
        kind: "tool",
        result: { replayed: true, note: "mutation already applied (crash-replay guard)" },
        isError: false,
      } satisfies EffectOutcome;
    }
    try {
      const outcome = await deps.localTools.run({
        channelId: descriptor.channelId,
        tool: descriptor.tool,
        invocationId: descriptor.invocationId,
        args: descriptor.args,
        signal,
        onProgress: (chunk) =>
          onEphemeral({
            kind: "signal-event",
            channelId: descriptor.channelId,
            event: {
              kind: "invocation.progress",
              actor: deps.selfRef,
              causality: { invocationId: descriptor.invocationId as never },
              payload: { protocol: "agentic.trajectory.v1", data: chunk },
              createdAt: new Date().toISOString(),
            } as never,
          }),
      });
      // A deferred local tool (eval) parks: the driver keeps the leased row (deferRedrive backstop)
      // and the result arrives via deliverEffectOutcome (onEvalComplete) — NOT wrapped in kind:"tool".
      if ("deferred" in outcome && outcome.deferred) {
        return { deferred: true };
      }
      const toolOutcome = outcome as { result: unknown; summary?: string; isError: boolean };
      return { kind: "tool", ...toolOutcome } satisfies EffectOutcome;
    } catch (err) {
      return {
        kind: "tool",
        result: err instanceof Error ? err.message : String(err),
        isError: true,
        reason: err instanceof Error ? err.message : String(err),
      } satisfies EffectOutcome;
    }
  },
};

/** channel_call (§2.4.3): journaled call through the channel DO; the result
 *  arrives via the channel's terminal delivery → deliverEffectOutcome. */
export const channelCallExecutor: EffectExecutor<ChannelCallEffect> = {
  kind: "channel_call",
  async execute({ descriptor, deps }) {
    await deps.channel.callMethod({
      channelId: descriptor.channelId,
      targetParticipantId:
        (descriptor.target as { participantId?: string }).participantId ?? descriptor.target.id,
      transportCallId: descriptor.transportCallId,
      method: descriptor.method,
      args: descriptor.args,
      invocationId: descriptor.invocationId,
      ...(descriptor.turnId ? { turnId: descriptor.turnId } : {}),
      ...(descriptor.timeoutMs ? { timeoutMs: descriptor.timeoutMs } : {}),
    });
    // The channel DO settles the call durably (terminal:{transportCallId});
    // the driver maps that delivery to this effect's outcome.
    return { deferred: true };
  },
};

/** http_call (§2.4.4): idempotency-keyed server POST with a callback address —
 *  subsumes the deferred-RPC layer. */
export const httpCallExecutor: EffectExecutor<HttpCallEffect> = {
  kind: "http_call",
  async execute({ descriptor, deps }) {
    const response = await deps.http.post({
      ...(descriptor.targetUrl ? { targetUrl: descriptor.targetUrl } : {}),
      ...(descriptor.target ? { target: descriptor.target } : {}),
      idempotencyKey: descriptor.idempotencyKey,
      request: descriptor.request,
      effectId: descriptor.effectId,
      callback: { ...deps.callbackAddress, method: "deliverEffectOutcome" },
    });
    if (response.deferred) return { deferred: true };
    return {
      kind: "tool",
      result: response.result,
      isError: response.isError,
    } satisfies EffectOutcome;
  },
};

/** credential_wait (§2.4.5): publish the connect card + register interest.
 *  Resolution funnels into deliverEffectOutcome; expiry is the outbox
 *  next_attempt_at deadline. */
export const credentialWaitExecutor: EffectExecutor<CredentialWaitEffect> = {
  kind: "credential_wait",
  async execute({ descriptor, deps }) {
    await deps.channel.publish({
      channelId: descriptor.channelId,
      payloadKind: CREDENTIAL_CONNECT_PAYLOAD_KIND,
      payload: {
        credKey: descriptor.credKey,
        providerId: descriptor.providerId,
        connectSpec: descriptor.connectSpec,
        ...(descriptor.modelBaseUrl ? { modelBaseUrl: descriptor.modelBaseUrl } : {}),
        ...(descriptor.waitReason ? { waitReason: descriptor.waitReason } : {}),
        ...(descriptor.reason ? { reason: descriptor.reason } : {}),
        ...(descriptor.failureCode ? { failureCode: descriptor.failureCode } : {}),
        expiresAt: descriptor.expiresAt,
      },
      // Include the occurrence discriminator (startedAtSeq) so a LATER wait for
      // the same credKey publishes a fresh card instead of replaying the first
      // (stale/expired) card via the channel's durable dedup_keys table.
      idempotencyKey: `credcard:${descriptor.credKey}:${descriptor.startedAtSeq}`,
    });
    await deps.credentials.registerCredentialInterest({
      credKey: descriptor.credKey,
      providerId: descriptor.providerId,
      effectId: descriptor.effectId,
      expiresAt: descriptor.expiresAt,
    });
    return { deferred: true };
  },
};

/** publish_envelope (§2.4.6): fire-and-forget; exempt from the reconcile. */
export const publishExecutor: EffectExecutor<PublishEnvelopeEffect> = {
  kind: "publish_envelope",
  async execute({ descriptor, deps }) {
    await deps.channel.publish({
      channelId: descriptor.channelId,
      payloadKind: descriptor.payloadKind,
      payload: descriptor.payload,
      // Forward the idempotency key so duplicate publishes (read acks, etc.)
      // dedupe at the channel — one of the three duplicate guards. The port
      // accepts it; only this executor was dropping it.
      idempotencyKey: descriptor.idempotencyKey,
    });
    return { kind: "tool", result: null, isError: false } satisfies EffectOutcome;
  },
};

export function executorFor(descriptor: EffectDescriptor): EffectExecutor {
  switch (descriptor.kind) {
    case "model_call":
      return modelCallExecutor as EffectExecutor;
    case "local_tool":
      return localToolExecutor as EffectExecutor;
    case "channel_call":
      return channelCallExecutor as EffectExecutor;
    case "http_call":
      return httpCallExecutor as EffectExecutor;
    case "credential_wait":
      return credentialWaitExecutor as EffectExecutor;
    case "publish_envelope":
      return publishExecutor as EffectExecutor;
  }
}
