import { describe, expect, it } from "vitest";
import type { LogEnvelope } from "@workspace/agentic-protocol";
import { applyEvent } from "./fold.js";
import {
  initialAgentState,
  type AgentLoopConfig,
  type AgentState,
  type ModelRequestDescriptor,
} from "./state.js";

const config = {
  model: "anthropic:claude-sonnet-4-6",
  thinkingLevel: "medium",
  approvalLevel: 2,
  respondPolicy: "all",
  systemPromptHash: "blob:sys",
  activeToolNames: ["read"],
  roster: { participants: [] },
} as unknown as AgentLoopConfig;

function turnOpened(actorId: string, turnId: string, seq: number): LogEnvelope {
  return envelope(actorId, "turn.opened", {}, { turnId }, seq, `turn:${turnId}:opened`);
}

function envelope(
  actorId: string,
  payloadKind: string,
  payload: Record<string, unknown>,
  causality: Record<string, unknown>,
  seq: number,
  envelopeId = `${payloadKind}:${seq}`
): LogEnvelope {
  return {
    logId: "branch:channel:c",
    head: "branch:channel:c",
    seq,
    envelopeId,
    actor: { kind: "agent", id: actorId, participantId: actorId },
    payloadKind,
    payload,
    causality,
    appendedAt: `2026-05-20T12:00:0${seq}.000Z`,
    prevHash: "p",
    hash: `h${seq}`,
  } as unknown as LogEnvelope;
}

function request(contextThroughSeq: number): ModelRequestDescriptor {
  return {
    provider: "test",
    model: "m",
    thinkingLevel: "medium",
    systemPromptHash: "blob:sys",
    activeToolNames: ["read"],
    contextThroughSeq,
    attemptId: "attempt-own",
  };
}

describe("fold: an agent only owns turns it authored", () => {
  it("ignores another participant's turn.opened but adopts its own (selfId filter)", () => {
    const selfId = "agent:self";
    let state: AgentState = initialAgentState({ channelId: "c", config, selfId });

    // A DIFFERENT agent's turn.opened (from the shared channel log) must NOT become ours —
    // otherwise we'd continue its turn under its turnId → GAD id-collision.
    state = applyEvent(state, turnOpened("agent:other", "t:c:trig:agent:other", 1));
    expect(state.openTurn).toBeNull();
    expect(state.lastSeq).toBe(1); // ...but the fold position still advances over it.

    // Our OWN turn.opened is adopted.
    state = applyEvent(state, turnOpened(selfId, "t:c:trig:agent:self", 2));
    expect(state.openTurn?.turnId).toBe("t:c:trig:agent:self");
  });

  it("without a selfId, folds every author's turns (legacy back-compat)", () => {
    let state: AgentState = initialAgentState({ channelId: "c", config });
    state = applyEvent(state, turnOpened("agent:other", "t:c:trig:agent:other", 1));
    expect(state.openTurn?.turnId).toBe("t:c:trig:agent:other");
  });

  it("keeps another agent's assistant completion as context without settling our in-flight call", () => {
    const selfId = "agent:self";
    const ownRequest = request(3);
    let state: AgentState = {
      ...initialAgentState({ channelId: "c", config, selfId }),
      inFlightModelCall: {
        messageId: "m:own",
        attemptId: "attempt-own",
        contextThroughSeq: 3,
        request: ownRequest,
      },
    };

    state = applyEvent(
      state,
      envelope(
        "agent:other",
        "message.completed",
        { role: "assistant", blocks: [{ type: "text", content: "other agent result" }] },
        { messageId: "m:foreign" },
        1
      )
    );

    expect(state.inFlightModelCall?.messageId).toBe("m:own");
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({
      kind: "assistant",
      messageId: "m:foreign",
      senderRef: { id: "agent:other" },
    });
  });

  it("ignores another agent's invocation lifecycle state", () => {
    const selfId = "agent:self";
    let state: AgentState = initialAgentState({ channelId: "c", config, selfId });

    state = applyEvent(
      state,
      envelope(
        "agent:other",
        "invocation.started",
        {
          name: "read",
          transport: { kind: "local", awaiterId: "inv-foreign" },
          request: { path: "/x" },
        },
        { invocationId: "inv-foreign", turnId: "t:other" },
        1
      )
    );
    expect(state.pendingInvocations).toEqual({});
    expect(state.lastSeq).toBe(1);

    state = applyEvent(
      state,
      envelope(
        "agent:other",
        "invocation.completed",
        { result: "foreign result" },
        { invocationId: "inv-foreign", turnId: "t:other" },
        2
      )
    );
    expect(state.pendingInvocations).toEqual({});
    expect(state.entries).toEqual([]);
    expect(state.lastSeq).toBe(2);
  });
});
