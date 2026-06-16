import { describe, expect, it } from "vitest";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
} from "@workspace/agentic-protocol";
import {
  conversationV1Policy,
  resolveChannelPolicies,
  getChannelPolicy,
  DEFAULT_CHANNEL_POLICIES,
  type PolicyEnvelopeView,
} from "./index.js";

function completedEnvelope(
  seq: number,
  senderId: string,
  actorKind: "agent" | "user" | "panel",
  appendedAt = `2026-05-20T12:00:0${seq}.000Z`,
  extraCausality: Record<string, unknown> = {}
): PolicyEnvelopeView {
  return {
    envelopeId: `env-${seq}`,
    seq,
    payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
    payload: {
      kind: "message.completed",
      actor: { kind: actorKind, id: senderId },
      causality: { messageId: `msg-${seq}`, ...extraCausality },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant", outcome: "completed" },
      createdAt: appendedAt,
    },
    senderId,
    senderKind: actorKind,
    appendedAt,
  };
}

function opaqueEnvelope(seq: number): PolicyEnvelopeView {
  return {
    envelopeId: `env-${seq}`,
    seq,
    payloadKind: "custom.kind",
    payload: { value: seq },
    senderId: "panel:user",
    senderKind: "panel",
    appendedAt: `2026-05-20T12:00:0${seq}.000Z`,
  };
}

describe("agentic.conversation.v1", () => {
  it("folds completed messages into conversation state with previous-slot shifting", () => {
    const policy = conversationV1Policy;
    let state = policy.init();
    state = policy.reduce(state, opaqueEnvelope(1));
    state = policy.reduce(state, completedEnvelope(2, "user:1", "user"));
    state = policy.reduce(state, completedEnvelope(3, "agent:a", "agent"));
    state = policy.reduce(state, completedEnvelope(4, "agent:a", "agent"));

    expect(state).toEqual({
      lastCompletedSender: "agent:a",
      lastCompletedMessageId: "msg-4",
      lastCompletedSeq: 4,
      lastCompletedAt: "2026-05-20T12:00:04.000Z",
      previousCompletedSender: "agent:a",
      previousCompletedMessageId: "msg-3",
      previousCompletedSeq: 3,
      agentStreak: 2,
    });

    // a user-completed message resets the streak
    const reset = policy.reduce(state, completedEnvelope(5, "user:1", "user"));
    expect(reset.agentStreak).toBe(0);
    expect(reset.previousCompletedSender).toBe("agent:a");
  });

  it("replay-fold equals incremental fold (cache derivation is pure)", () => {
    const policy = conversationV1Policy;
    const script = [
      opaqueEnvelope(1),
      completedEnvelope(2, "user:1", "user"),
      completedEnvelope(3, "agent:a", "agent"),
      opaqueEnvelope(4),
      completedEnvelope(5, "agent:b", "agent"),
    ];
    const oneShot = script.reduce((state, env) => policy.reduce(state, env), policy.init());
    let incremental = policy.init();
    for (const env of script) incremental = policy.reduce(incremental, env);
    expect(incremental).toEqual(oneShot);
    // determinism: same inputs, same output, independent of wall clock
    const again = script.reduce((state, env) => policy.reduce(state, env), policy.init());
    expect(again).toEqual(oneShot);
  });

  it("annotates agent-authored completed drafts with agentHops without touching the payload", () => {
    const policy = conversationV1Policy;
    let state = policy.init();
    state = policy.reduce(state, completedEnvelope(2, "agent:a", "agent"));

    const payload = completedEnvelope(3, "agent:a", "agent").payload as Record<string, unknown>;
    const draft = {
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      payload,
      senderId: "agent:a",
      senderKind: "agent",
    };
    const before = JSON.stringify(payload);
    expect(policy.annotate(state, draft)).toEqual({ agentHops: 2 });
    expect(JSON.stringify(payload)).toBe(before);

    // explicit caller-computed hops win
    const explicit = completedEnvelope(3, "agent:a", "agent", undefined, { agentHops: 7 })
      .payload as Record<string, unknown>;
    expect(
      policy.annotate(state, { ...draft, payload: explicit })
    ).toEqual({ agentHops: 7 });

    // user-authored drafts are not annotated
    expect(
      policy.annotate(state, {
        ...draft,
        payload: completedEnvelope(3, "user:1", "user").payload,
      })
    ).toBeNull();
    // opaque drafts are not annotated
    expect(
      policy.annotate(state, {
        payloadKind: "custom.kind",
        payload: { value: 1 },
        senderId: "agent:a",
        senderKind: "agent",
      })
    ).toBeNull();
  });

  it("builds call-transport events purely from injected timestamps", () => {
    const builders = conversationV1Policy.callEventPayload!;
    const caller = { kind: "panel" as const, id: "panel:caller", participantId: "panel:caller" };
    const target = { kind: "panel" as const, id: "panel:provider", participantId: "panel:provider" };
    const createdAt = "2026-05-20T12:00:00.000Z";

    const started = builders.started({
      channelId: "channel-1",
      caller,
      target,
      invocationId: "inv-1",
      transportCallId: "transport-1",
      turnId: "turn-1",
      method: "eval",
      args: { code: "1 + 1" },
      deadlineAt: 1750000000000,
      createdAt,
    });
    expect(started).toMatchObject({
      kind: "invocation.started",
      actor: caller,
      turnId: "turn-1",
      causality: { invocationId: "inv-1", transportCallId: "transport-1" },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "eval",
        invocationType: "panel",
        request: { code: "1 + 1" },
        transport: {
          kind: "channel",
          channelId: "channel-1",
          target,
          transportCallId: "transport-1",
          deadlineAt: 1750000000000,
        },
        userVisible: false,
      },
      createdAt,
    });

    const descriptor = {
      channelId: "channel-1",
      caller,
      invocationId: "inv-1",
      transportCallId: "transport-1",
      turnId: "turn-1",
    };
    expect(
      builders.terminal({ descriptor, result: 2, isError: false, createdAt })
    ).toMatchObject({
      kind: "invocation.completed",
      payload: { result: 2, terminalOutcome: "success" },
      createdAt,
    });
    expect(
      builders.terminal({
        descriptor,
        result: "boom",
        isError: true,
        terminalOutcome: "infrastructure_error",
        createdAt,
      })
    ).toMatchObject({
      kind: "invocation.failed",
      payload: {
        terminalOutcome: "infrastructure_error",
        terminalReasonCode: "method_failed",
      },
    });
    expect(
      builders.terminal({
        descriptor,
        result: "superseded",
        isError: true,
        terminalOutcome: "stale_dispatch",
        createdAt,
      })
    ).toMatchObject({
      kind: "invocation.cancelled",
      payload: { terminalOutcome: "stale_dispatch", reason: "superseded" },
    });
    expect(
      builders.terminal({
        descriptor,
        result: "target left",
        isError: true,
        terminalOutcome: "abandoned",
        createdAt,
      })
    ).toMatchObject({
      kind: "invocation.abandoned",
      payload: { terminalOutcome: "abandoned", reason: "target left" },
    });
    expect(
      builders.output({ descriptor, output: { pct: 50 }, createdAt })
    ).toMatchObject({
      kind: "invocation.output",
      payload: { output: { pct: 50 } },
    });
    expect(
      builders.cancelled({
        descriptor,
        actor: { kind: "system", id: "system" },
        reason: "timed out",
        createdAt,
      })
    ).toMatchObject({
      kind: "invocation.cancelled",
      actor: { kind: "system", id: "system" },
      payload: { terminalOutcome: "cancelled", reason: "timed out" },
    });
  });

  it("registry resolves defaults and rejects unknown or conflicting policies", () => {
    expect(getChannelPolicy("agentic.conversation.v1").version).toBe(1);
    expect(() => getChannelPolicy("nope")).toThrow(/Unknown channel policy/u);
    const resolved = resolveChannelPolicies(undefined);
    expect(resolved.map((policy) => policy.name)).toEqual([...DEFAULT_CHANNEL_POLICIES]);
  });
});
