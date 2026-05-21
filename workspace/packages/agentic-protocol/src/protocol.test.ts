import { describe, expect, it } from "vitest";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  GENESIS_EVENT_HASH,
  agenticSlice,
  agenticEventSchema,
  brandId,
  checkTrajectoryIntegrity,
  computeEventHash,
  createInitialChannelViewState,
  createInitialTrajectoryState,
  reduceChannelView,
  reduceTrajectory,
  trajectoryEventSchema,
  userVisibleTrajectoryProjection,
  type AgenticEvent,
  type BranchId,
  type ChannelEnvelope,
  type ChannelId,
  type EnvelopeId,
  type EventId,
  type InvocationId,
  type MessageId,
  type TrajectoryEvent,
  type TrajectoryId,
  type TurnId,
} from "./index.js";

const agent = { kind: "agent" as const, id: "agent-1" };
const user = { kind: "user" as const, id: "user-1" };
const agentParticipant = { ...agent, participantId: "participant-agent-1" };
const userParticipant = { ...user, participantId: "participant-user-1" };

function messageEvent(overrides: Partial<AgenticEvent<"message.completed">> = {}): AgenticEvent<"message.completed"> {
  return {
    kind: "message.completed",
    actor: user,
    causality: { messageId: brandId<MessageId>("msg-1") },
    payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "user", content: "hello" },
    createdAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

async function trajectoryEvent(
  event: AgenticEvent,
  overrides: Partial<TrajectoryEvent> = {},
): Promise<TrajectoryEvent> {
  const base = {
    ...event,
    eventId: brandId<EventId>(overrides.eventId ?? "evt-1"),
    trajectoryId: brandId<TrajectoryId>(overrides.trajectoryId ?? "traj-1"),
    branchId: brandId<BranchId>(overrides.branchId ?? "branch-1"),
    seq: overrides.seq ?? 0,
    prevEventHash: overrides.prevEventHash ?? GENESIS_EVENT_HASH,
    eventHash: "",
  } as TrajectoryEvent;
  return {
    ...base,
    eventHash: overrides.eventHash ?? await computeEventHash({
      prevEventHash: base.prevEventHash,
      branchId: base.branchId,
      seq: base.seq,
      event,
    }),
  };
}

function envelope(
  payload: AgenticEvent,
  seq = 1,
): ChannelEnvelope<AgenticEvent> {
  return {
    envelopeId: brandId<EnvelopeId>(`env-${seq}`),
    channelId: brandId<ChannelId>("channel-1"),
    seq,
    from: payload.actor.kind === "user" ? userParticipant : agentParticipant,
    payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
    payload,
    publishedAt: payload.createdAt,
  };
}

describe("@workspace/agentic-protocol schemas", () => {
  it("accepts human vocabulary events without turnId", () => {
    expect(agenticEventSchema.parse(messageEvent()).turnId).toBeUndefined();
  });

  it("rejects message events without a messageId", () => {
    const result = agenticEventSchema.safeParse(messageEvent({ causality: undefined }));
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toContain("messageId");
  });

  it("requires turnId for owner-authored turn-scoped trajectory events", async () => {
    const event = await trajectoryEvent(messageEvent({ actor: agent }));
    const result = trajectoryEventSchema.safeParse(event);
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toContain("turnId");
  });

  it("accepts owner-authored turn-scoped trajectory events with turnId", async () => {
    const event = await trajectoryEvent(messageEvent({
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
    }));
    expect(trajectoryEventSchema.parse(event)["turnId"]).toBe("turn-1");
  });
});

describe("@workspace/agentic-protocol reducers", () => {
  it("supports replacement assistant message deltas", () => {
    const started: AgenticEvent<"message.started"> = {
      kind: "message.started",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      causality: { messageId: brandId<MessageId>("msg-replace") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant", content: "hello worl" },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const replacement: AgenticEvent<"message.delta"> = {
      kind: "message.delta",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      causality: { messageId: brandId<MessageId>("msg-replace") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, delta: "hello world", replace: true },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [started, replacement]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(state.messages["msg-replace"]?.content).toBe("hello world");
  });

  it("drops malformed agentic envelopes without stopping transcript reduction", () => {
    const malformed = {
      envelopeId: brandId<EnvelopeId>("env-bad"),
      channelId: brandId<ChannelId>("channel-1"),
      seq: 1,
      from: agentParticipant,
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: { kind: "message.completed", payload: { content: "missing required fields" } },
      publishedAt: "2026-05-20T12:00:00.000Z",
    } as ChannelEnvelope<AgenticEvent>;
    const valid = envelope(messageEvent({
      causality: { messageId: brandId<MessageId>("msg-good") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "user", content: "kept" },
      createdAt: "2026-05-20T12:00:01.000Z",
    }), 2);

    const state = [malformed, valid].reduce(reduceChannelView, createInitialChannelViewState());

    expect(state.ignoredEnvelopeIds).toEqual(["env-bad"]);
    expect(state.messages["msg-good"]?.content).toBe("kept");
  });

  it("keeps channel view and trajectory visible projection aligned for a single-agent visible stream", async () => {
    const turnOpened = await trajectoryEvent({
      kind: "turn.opened",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    }, { eventId: brandId<EventId>("evt-turn"), seq: 0 });
    const started = await trajectoryEvent({
      kind: "message.started",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      causality: { messageId: brandId<MessageId>("msg-1") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant", content: "" },
      createdAt: "2026-05-20T12:00:01.000Z",
    }, { eventId: brandId<EventId>("evt-start"), seq: 1, prevEventHash: turnOpened.eventHash });
    const completed = await trajectoryEvent({
      kind: "message.completed",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      causality: { messageId: brandId<MessageId>("msg-1") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant", content: "done" },
      createdAt: "2026-05-20T12:00:02.000Z",
    }, { eventId: brandId<EventId>("evt-complete"), seq: 2, prevEventHash: started.eventHash });

    const trajectory = [turnOpened, started, completed].reduce(reduceTrajectory, createInitialTrajectoryState());
    const channel = [started, completed]
      .map((event, index) => envelope(agenticSlice(event), index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(channel.messages).toEqual(userVisibleTrajectoryProjection(trajectory).messages);
  });

  it("updates invocation cards when intermediate progress is missing", () => {
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-1") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, name: "read_file", userVisible: true },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const completed: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-1") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, result: "contents" },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [envelope(started, 1), envelope(completed, 2)]
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(state.invocations["inv-1"]?.status).toBe("completed");
    expect(state.invocations["inv-1"]?.result).toBe("contents");
  });

  it("merges invocation updates by invocation id across participant envelopes", () => {
    const output: AgenticEvent<"invocation.output"> = {
      kind: "invocation.output",
      actor: { kind: "panel", id: "provider-1" },
      causality: { invocationId: brandId<InvocationId>("inv-cross") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, output: "streamed line" },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const completed: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-cross") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, result: "done" },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const providerEnvelope = {
      ...envelope(output, 1),
      from: {
        kind: "panel" as const,
        id: "provider-1",
        participantId: "provider-1",
      },
    };
    const state = [providerEnvelope, envelope(completed, 2)]
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(Object.keys(state.invocations)).toEqual(["inv-cross"]);
    expect(state.invocations["inv-cross"]).toMatchObject({
      status: "completed",
      outputs: ["streamed line"],
      result: "done",
    });
  });

  it("ignores duplicate channel envelopes during replay backfill", () => {
    const event: AgenticEvent<"invocation.output"> = {
      kind: "invocation.output",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-1") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, output: "line 1" },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const duplicatedEnvelope = envelope(event, 1);

    const state = [duplicatedEnvelope, duplicatedEnvelope]
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(state.timeline).toHaveLength(1);
    expect(state.invocations["inv-1"]?.outputs).toEqual(["line 1"]);
  });

  it("reduces typed UI events into channel UI state", () => {
    const inline: AgenticEvent<"ui.inline_rendered"> = {
      kind: "ui.inline_rendered",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "inline",
        id: "inline-1",
        source: { type: "code", code: "export default function App() { return null; }" },
        props: { ok: true },
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const actionBar: AgenticEvent<"ui.action_bar.updated"> = {
      kind: "ui.action_bar.updated",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "action_bar",
        id: "bar-1",
        source: { type: "file", path: "ActionBar.tsx" },
        result: { ok: true },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [envelope(inline, 1), envelope(actionBar, 2)]
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(state.inlineUi["participant-agent-1"]?.["inline-1"]?.props).toEqual({ ok: true });
    expect(state.actionBars["participant-agent-1"]?.source).toEqual({ type: "file", path: "ActionBar.tsx" });
  });
});

describe("@workspace/agentic-protocol hash helpers", () => {
  it("detects tampering in a per-branch hash chain", async () => {
    const first = await trajectoryEvent(messageEvent(), { eventId: brandId<EventId>("evt-1"), seq: 0 });
    const second = await trajectoryEvent(messageEvent({
      causality: { messageId: brandId<MessageId>("msg-2") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "user", content: "next" },
    }), { eventId: brandId<EventId>("evt-2"), seq: 1, prevEventHash: first.eventHash });

    await expect(checkTrajectoryIntegrity([first, second])).resolves.toEqual({ ok: true, errors: [] });

    const tampered = {
      ...second,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "user", content: "changed" },
    } as TrajectoryEvent;
    const result = await checkTrajectoryIntegrity([first, tampered]);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("eventHash mismatch");
  });
});
