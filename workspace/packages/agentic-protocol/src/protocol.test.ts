import { describe, expect, it } from "vitest";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  GENESIS_EVENT_HASH,
  MAX_INLINE_TRAJECTORY_EVENT_BYTES,
  assertNoStoredValueRefs,
  agenticSlice,
  agenticEventSchema,
  brandId,
  checkTrajectoryIntegrity,
  computeEventHash,
  createInitialChannelViewState,
  createInitialTrajectoryState,
  encodeAgenticEventStoredValues,
  hydrateStoredValueRefs,
  reduceChannelView,
  reduceTrajectory,
  sanitizeAgenticEventParticipantRefs,
  storedAgenticEventSchema,
  isStoredValueRef,
  trajectoryEventSchema,
  userVisibleTrajectoryProjection,
  type AgenticEvent,
  type BlockId,
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

  it("rejects unknown stored event kinds before reducer use", () => {
    const result = storedAgenticEventSchema.safeParse({
      kind: "invocation.typo",
      actor: agent,
      causality: { invocationId: "inv-1" },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, reason: "bad kind" },
      createdAt: "2026-05-20T12:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-object stored event payloads unless the whole payload is a stored ref", () => {
    expect(storedAgenticEventSchema.safeParse({
      kind: "turn.closed",
      actor: agent,
      payload: null,
      createdAt: "2026-05-20T12:00:00.000Z",
    }).success).toBe(false);

    expect(storedAgenticEventSchema.parse({
      kind: "turn.closed",
      actor: agent,
      payload: {
        protocol: "natstack.blob-ref.v1",
        digest: "payload-digest",
        size: 64,
        encoding: "json",
        originalBytes: 64,
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    }).payload).toMatchObject({ digest: "payload-digest" });
  });

  it("rejects stored events missing reducer-critical payload fields", () => {
    const result = storedAgenticEventSchema.safeParse({
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: "inv-1" },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, request: { code: "run()" } },
      createdAt: "2026-05-20T12:00:00.000Z",
    });

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toContain("payload.name");
  });

  it("spills oversized message blocks and metadata while preserving compact inline summaries", async () => {
    const blobs = new Map<string, string>();
    const large = "x".repeat(80 * 1024);
    const event = messageEvent({
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        content: "done",
        blocks: Array.from({ length: 8 }, (_, index) => ({
          type: "text",
          content: large,
          metadata: {
            index,
            raw: large,
            nested: { value: large },
          },
        })),
      },
    });

    const encoded = await encodeAgenticEventStoredValues(event, {
      putText: async (value) => {
        const digest = `digest-${blobs.size + 1}`;
        blobs.set(digest, value);
        return { digest, size: value.length };
      },
    });

    expect(encoded.eventBytes).toBeLessThan(MAX_INLINE_TRAJECTORY_EVENT_BYTES);
    expect(storedAgenticEventSchema.parse(encoded.event).payload).toMatchObject({
      blocks: { protocol: "natstack.blob-ref.v1", encoding: "json" },
    });
    expect(JSON.stringify(encoded.event.payload)).not.toContain(large);
    expect(blobs.size).toBeGreaterThan(1);
  });

  it("hydrates refs nested inside hydrated json blobs", async () => {
    const blobs = new Map<string, string>();
    const innerRef = {
      protocol: "natstack.blob-ref.v1" as const,
      digest: "inner",
      size: 14,
      encoding: "json" as const,
      originalBytes: 14,
    };
    const outerRef = {
      protocol: "natstack.blob-ref.v1" as const,
      digest: "outer",
      size: 32,
      encoding: "json" as const,
      originalBytes: 32,
    };
    blobs.set("inner", JSON.stringify({ text: "hydrated" }));
    blobs.set("outer", JSON.stringify({ blocks: [innerRef] }));

    await expect(
      hydrateStoredValueRefs(outerRef, {
        getText: async (digest) => blobs.get(digest) ?? null,
      })
    ).resolves.toEqual({ blocks: [{ text: "hydrated" }] });
  });

  it("sanitizes participant refs without persisting method schemas", () => {
    const fullMetadata = {
      type: "panel",
      name: "Panel",
      handle: "panel",
      methods: [{
        name: "eval",
        description: "large method description",
        parameters: { type: "object", properties: { code: { type: "string" } } },
        returns: { type: "object" },
      }],
      arbitraryLargeField: "x".repeat(1024),
    };
    const event: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: { kind: "agent", id: "agent-1", metadata: fullMetadata },
      turnId: brandId<TurnId>("turn-1"),
      causality: { invocationId: brandId<InvocationId>("inv-1") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "eval",
        transport: {
          kind: "channel",
          channelId: brandId<ChannelId>("channel-1"),
          target: { kind: "panel", id: "panel-1", participantId: "panel-1", metadata: fullMetadata },
        },
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };

    const sanitized = sanitizeAgenticEventParticipantRefs(event);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain("parameters");
    expect(serialized).not.toContain("returns");
    expect(serialized).not.toContain("description");
    expect(serialized).not.toContain("arbitraryLargeField");
    expect(sanitized.actor.metadata).toEqual({
      type: "panel",
      name: "Panel",
      handle: "panel",
      methods: [{ name: "eval" }],
    });
    expect("transport" in sanitized.payload ? sanitized.payload.transport?.kind : undefined).toBe("channel");
    if ("transport" in sanitized.payload && sanitized.payload.transport?.kind === "channel") {
      expect(sanitized.payload.transport.target.metadata).toEqual({
        type: "panel",
        name: "Panel",
        handle: "panel",
        methods: [{ name: "eval" }],
      });
    }
  });
});

describe("@workspace/agentic-protocol stored values", () => {
  it("strictly hydrates stored refs and reports missing blob paths", async () => {
    const stored = {
      outer: {
        value: {
          protocol: "natstack.blob-ref.v1" as const,
          digest: "json-digest",
          size: 12,
          encoding: "json" as const,
          originalBytes: 12,
        },
      },
    };

    await expect(
      hydrateStoredValueRefs(
        stored,
        { getText: async () => JSON.stringify({ ok: true }) },
        { strict: true, context: "test payload" }
      )
    ).resolves.toEqual({ outer: { value: { ok: true } } });

    await expect(
      hydrateStoredValueRefs(
        stored,
        { getText: async () => null },
        { strict: true, context: "test payload" }
      )
    ).rejects.toThrow("test payload stored value missing at $.outer.value: json-digest");

    await expect(
      hydrateStoredValueRefs(stored, { getText: async () => null })
    ).resolves.toEqual({ outer: { value: null } });
  });

  it("asserts when stored refs cross forbidden boundaries", () => {
    expect(() =>
      assertNoStoredValueRefs(
        {
          content: [
            {
              type: "text",
              text: {
                protocol: "natstack.blob-ref.v1",
                digest: "digest-1",
                size: 10,
                encoding: "json",
                originalBytes: 10,
              },
            },
          ],
        },
        "toolResult admission"
      )
    ).toThrow("toolResult admission contains unresolved stored value refs: $.content[0].text -> digest-1");
  });

  it("encodes every unbounded agentic payload field as a stored ref", async () => {
    const unboundedFields = [
      "request",
      "result",
      "details",
      "data",
      "output",
      "error",
      "replacement",
      "body",
      "update",
      "initialState",
      "props",
      "imports",
      "schemaSourceOrPath",
      "source",
    ];

    const writes: string[] = [];
    for (const field of unboundedFields) {
      const event: AgenticEvent = {
        kind: "invocation.completed",
        actor: agent,
        causality: { invocationId: brandId<InvocationId>(`inv-${field}`) },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          [field]: { field, nested: ["value"] },
        } as AgenticEvent["payload"],
        createdAt: "2026-05-20T12:00:00.000Z",
      };
      const { event: encoded } = await encodeAgenticEventStoredValues(event, {
        putText: async (value) => {
          writes.push(value);
          return { digest: `digest-${field}`, size: value.length };
        },
      });
      const payload = encoded.payload as Record<string, unknown>;
      expect(isStoredValueRef(payload[field]), field).toBe(true);
      expect((payload[field] as { digest: string }).digest).toBe(`digest-${field}`);
    }

    expect(writes).toHaveLength(unboundedFields.length);
  });

  it("encodes large message content, deltas, and block content as stored refs", async () => {
    const largeText = "x".repeat(140 * 1024);
    const writes: string[] = [];
    const writer = {
      putText: async (value: string) => {
        writes.push(value);
        return { digest: `digest-${writes.length}`, size: value.length };
      },
    };

    const completed = await encodeAgenticEventStoredValues(
      messageEvent({
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          role: "assistant",
          content: largeText,
          blocks: [{ type: "text", content: largeText }],
        },
      }),
      writer
    );
    const completedPayload = completed.event.payload as Record<string, unknown>;
    expect(isStoredValueRef(completedPayload["content"])).toBe(true);
    const block = (completedPayload["blocks"] as Array<Record<string, unknown>>)[0]!;
    expect(isStoredValueRef(block["content"])).toBe(true);

    const delta = await encodeAgenticEventStoredValues(
      {
        kind: "message.delta",
        actor: agent,
        causality: { messageId: brandId<MessageId>("msg-large-delta") },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          delta: largeText,
        },
        createdAt: "2026-05-20T12:00:00.000Z",
      },
      writer
    );
    const deltaPayload = delta.event.payload as Record<string, unknown>;
    expect(isStoredValueRef(deltaPayload["delta"])).toBe(true);
    expect(writes).toHaveLength(3);
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

  it("preserves message blocks and updates streamed blocks", () => {
    const started: AgenticEvent<"message.started"> = {
      kind: "message.started",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      causality: { messageId: brandId<MessageId>("msg-thinking") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        content: "",
        blocks: [{ blockId: brandId<BlockId>("think-1"), type: "thinking", content: "draft" }],
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const replacement: AgenticEvent<"message.delta"> = {
      kind: "message.delta",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      causality: { messageId: brandId<MessageId>("msg-thinking") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        delta: "",
        block: { blockId: brandId<BlockId>("think-1"), type: "thinking", content: "draft updated" },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [started, replacement]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(state.messages["msg-thinking"]?.blocks).toEqual([
      { blockId: "think-1", type: "thinking", content: "draft updated" },
    ]);
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

  it("merges custom message updates before starts and keeps updates sorted by seq", () => {
    const update2: AgenticEvent<"custom.updated"> = {
      kind: "custom.updated",
      actor: agent,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, messageId: brandId<MessageId>("custom-1"), update: { tempF: 72 } },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const duplicateUpdate2: AgenticEvent<"custom.updated"> = {
      ...update2,
      payload: { ...update2.payload, update: { tempF: 999 } },
      createdAt: "2026-05-20T12:00:03.000Z",
    };
    const started: AgenticEvent<"custom.started"> = {
      kind: "custom.started",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: brandId<MessageId>("custom-1"),
        typeId: "weather",
        initialState: { tempF: 70 },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const update1: AgenticEvent<"custom.updated"> = {
      kind: "custom.updated",
      actor: agent,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, messageId: brandId<MessageId>("custom-1"), update: { tempF: 71 } },
      createdAt: "2026-05-20T12:00:01.500Z",
    };

    const state = [
      envelope(update2, 3),
      envelope(started, 1),
      envelope(update1, 2),
      {
        ...envelope(duplicateUpdate2, 3),
        envelopeId: brandId<EnvelopeId>("env-duplicate-seq"),
      },
    ].reduce(reduceChannelView, createInitialChannelViewState());

    expect(state.customMessages["custom-1"]).toMatchObject({
      messageId: "custom-1",
      typeId: "weather",
      startedAtSeq: 1,
      lastSeq: 3,
      updatedAt: "2026-05-20T12:00:02.000Z",
    });
    expect(state.customMessages["custom-1"]?.updates).toEqual([
      { seq: 2, update: { tempF: 71 } },
      { seq: 3, update: { tempF: 72 } },
    ]);
  });

  it("does not resurrect a cleared message type from older registration replay", () => {
    const oldRegister: AgenticEvent<"messageType.registered"> = {
      kind: "messageType.registered",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        typeId: "weather",
        displayMode: "row",
        source: { type: "code", code: "export default function Weather() { return null; }" },
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const currentRegister: AgenticEvent<"messageType.registered"> = {
      ...oldRegister,
      payload: {
        ...oldRegister.payload,
        source: { type: "code", code: "export default function CurrentWeather() { return null; }" },
      },
      createdAt: "2026-05-20T12:00:10.000Z",
    };
    const clear: AgenticEvent<"messageType.cleared"> = {
      kind: "messageType.cleared",
      actor: agent,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, typeId: "weather" },
      createdAt: "2026-05-20T12:00:20.000Z",
    };
    const replayedAfterRegister: AgenticEvent<"messageType.registered"> = {
      ...oldRegister,
      payload: {
        ...oldRegister.payload,
        source: { type: "code", code: "export default function ReplayedWeather() { return null; }" },
      },
      createdAt: "2026-05-20T12:00:15.000Z",
    };

    const state = [
      envelope(currentRegister, 10),
      envelope(clear, 20),
      envelope(replayedAfterRegister, 15),
      envelope(oldRegister, 5),
    ].reduce(reduceChannelView, createInitialChannelViewState());

    expect(state.messageTypes["weather"]?.updatedAtSeq).toBe(10);
    expect(state.messageTypes["weather"]?.clearedAtSeq).toBe(20);
    expect(state.messageTypes["weather"]?.source).toEqual(currentRegister.payload.source);
  });

  it("does not let older custom.started envelopes clobber an existing start", () => {
    const newerStarted: AgenticEvent<"custom.started"> = {
      kind: "custom.started",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: brandId<MessageId>("custom-start-order"),
        typeId: "weather.v2",
        initialState: { city: "Berlin" },
        displayMode: "row",
      },
      createdAt: "2026-05-20T12:00:10.000Z",
    };
    const olderStarted: AgenticEvent<"custom.started"> = {
      kind: "custom.started",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: brandId<MessageId>("custom-start-order"),
        typeId: "weather.v1",
        initialState: { city: "Paris" },
        displayMode: "inline",
      },
      createdAt: "2026-05-20T12:00:05.000Z",
    };

    const state = [
      envelope(newerStarted, 10),
      envelope(olderStarted, 5),
    ].reduce(reduceChannelView, createInitialChannelViewState());

    expect(state.customMessages["custom-start-order"]).toMatchObject({
      typeId: "weather.v2",
      initialState: { city: "Berlin" },
      displayMode: "row",
      startedAtSeq: 10,
      lastSeq: -1,
    });
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
