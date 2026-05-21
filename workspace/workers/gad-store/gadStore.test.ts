import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  type AgenticEvent,
} from "@workspace/agentic-protocol";
import { GadWorkspaceDO } from "./index.js";

const owner = { kind: "agent" as const, id: "agent-1" };

function event<K extends AgenticEvent["kind"]>(
  kind: K,
  patch: Omit<AgenticEvent<K>, "kind" | "actor" | "createdAt"> & { createdAt?: string },
): AgenticEvent<K> {
  return {
    kind,
    actor: owner,
    createdAt: patch.createdAt ?? "2026-05-20T12:00:00.000Z",
    ...patch,
  } as AgenticEvent<K>;
}

describe("GadWorkspaceDO trajectory persistence", () => {
  it("creates only canonical trajectory/channel tables, not Pi/session dispatch tables", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const tables = await call<{ rows: Array<{ name: string }> }>(
      "query",
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      [],
    );
    expect(tables.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "trajectory_events",
        "trajectory_branches",
        "trajectory_messages",
        "trajectory_invocations",
        "channel_envelopes",
        "gad_worktree_states",
        "gad_claims",
      ]),
    );
    const allowedPrefixes = ["trajectory_", "channel_", "gad_"];
    const allowedExact = new Set(["blobs", "state"]);
    expect(
      tables.rows
        .map((row) => row.name)
        .filter((name) => allowedPrefixes.every((prefix) => !name.startsWith(prefix)))
        .filter((name) => !allowedExact.has(name)),
    ).toEqual([]);
  });

  it("atomically appends trajectory events and strips storage fields from published channel payloads", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const result = await call<any>("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-message-1",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              role: "assistant",
              content: "hello from trajectory",
            },
          }),
          publish: { channelIds: ["channel-1"] },
        },
      ],
    });

    expect(result.events).toHaveLength(2);
    expect(result.events[1]).toMatchObject({
      kind: "external.envelope_published",
      prevEventHash: result.events[0].eventHash,
    });
    expect(result.headEventId).toBe(result.events[1].eventId);
    expect(result.headEventHash).toBe(result.events[1].eventHash);
    expect(result.published).toEqual([
      expect.objectContaining({ eventId: "event-message-1", channelId: "channel-1" }),
    ]);

    const events = await call<any[]>("listTrajectoryEvents", {
      trajectoryId: "traj-1",
      branchId: "main",
    });
    expect(events.map((row) => row.kind)).toEqual([
      "message.completed",
      "external.envelope_published",
    ]);
    expect(events[0]).toMatchObject({
      eventId: "event-message-1",
      seq: 0,
      prevEventHash: "0000000000000000000000000000000000000000000000000000000000000000",
    });

    const envelopes = await call<any[]>("listChannelEnvelopes", {
      channelId: "channel-1",
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
    });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      seq: 1,
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind: "message.completed",
        causality: { messageId: "msg-1" },
      },
    });
    expect(envelopes[0].payload.eventId).toBeUndefined();
    expect(envelopes[0].payload.branchId).toBeUndefined();

    const lineage = await call<any>("getTrajectoryForEnvelope", {
      envelopeId: result.published[0].envelopeId,
    });
    expect(lineage).toMatchObject({
      publication: {
        eventId: "event-message-1",
        trajectoryId: "traj-1",
        branchId: "main",
        channelId: "channel-1",
        channelSeq: 1,
        envelopeId: result.published[0].envelopeId,
      },
      envelope: {
        seq: 1,
        payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      },
      trajectoryEvent: {
        eventId: "event-message-1",
        kind: "message.completed",
        branchId: "main",
      },
    });

    const turnPublications = await call<any[]>("listPublishedEnvelopesForTrajectory", {
      branchId: "main",
      turnId: "turn-1",
    });
    expect(turnPublications).toHaveLength(1);
    expect(turnPublications[0]).toMatchObject({
      publication: {
        eventId: "event-message-1",
        channelId: "channel-1",
        channelSeq: 1,
      },
      trajectoryEvent: {
        causality: { messageId: "msg-1" },
      },
    });

    const envelopesForTrajectory = await call<any[]>("getEnvelopesForTrajectory", {
      branchId: "main",
      eventId: "event-message-1",
    });
    expect(envelopesForTrajectory).toHaveLength(1);

    const artifacts = await call<any[]>("getPublishedArtifactsForTurn", {
      turnId: "turn-1",
    });
    expect(artifacts).toEqual([
      expect.objectContaining({
        lineage: expect.objectContaining({
          publication: expect.objectContaining({ eventId: "event-message-1" }),
        }),
      }),
    ]);

    const privateLineage = await call<any>("getPrivateLineageForPublishedEnvelope", {
      envelopeId: result.published[0].envelopeId,
    });
    expect(privateLineage.branchEvents.map((row: any) => row.eventId)).toEqual(["event-message-1"]);

    const projection = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT message_id, body_assembled, status FROM trajectory_messages",
      [],
    );
    expect(projection.rows).toEqual([
      expect.objectContaining({
        message_id: "msg-1",
        body_assembled: "hello from trajectory",
        status: "completed",
      }),
    ]);
  });

  it("indexes transport call ids on projected invocations for channel/trajectory joins", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-invocation-1",
          event: event("invocation.started", {
            turnId: "turn-1" as never,
            causality: {
              invocationId: "tool-1" as never,
              transportCallId: "transport-1",
            },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              name: "eval",
              request: { code: "1 + 1" },
            },
          }),
        },
      ],
    });

    const projected = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT invocation_id, transport_call_id FROM trajectory_invocations WHERE branch_id = ?",
      ["main"],
    );
    expect(projected.rows).toEqual([
      { invocation_id: "tool-1", transport_call_id: "transport-1" },
    ]);
  });

  it("stores generic opaque channel envelopes and exposes replay windows", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-1",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: 1 },
      metadata: { name: "User" },
      attachments: [{ id: "att-1", mimeType: "text/plain", data: "aGVsbG8=", size: 5 }],
      publishedAt: "2026-05-20T12:00:00.000Z",
    });
    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-2",
      from: { kind: "agent", id: "agent:one", participantId: "agent:one" },
      payloadKind: "custom.kind",
      payload: { value: 2 },
      publishedAt: "2026-05-20T12:00:01.000Z",
    });

    expect(await call<any[]>("listChannelEnvelopesAfter", { channelId: "channel-1", seq: 1 })).toEqual([
      expect.objectContaining({ envelopeId: "env-2", seq: 2, payload: { value: 2 } }),
    ]);
    expect(await call<any[]>("listChannelEnvelopesBefore", { channelId: "channel-1", seq: 2, limit: 1 })).toEqual([
      expect.objectContaining({
        envelopeId: "env-1",
        seq: 1,
        payloadKind: "custom.kind",
        metadata: { name: "User" },
      }),
    ]);
    const initial = await call<any>("getInitialChannelWindow", { channelId: "channel-1", limit: 1 });
    expect(initial).toMatchObject({
      totalCount: 2,
      replayFromId: 2,
      replayToId: 2,
      hasMoreBefore: true,
      envelopes: [expect.objectContaining({ envelopeId: "env-2" })],
    });
  });

  it("keeps side trajectory events private while joining a published summary back to downstream consumers", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-main",
      branchId: "side-task",
      owner,
      events: [
        {
          eventId: "side-private-observation",
          event: event("system.event", {
            turnId: "turn-side" as never,
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              kind: "side-search-result",
              details: { privateFinding: "keep this out of PubSub" },
            },
          }),
        },
        {
          eventId: "side-summary",
          event: event("message.completed", {
            turnId: "turn-side" as never,
            causality: { messageId: "side-summary-message" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              role: "assistant",
              content: "Side task summary for the main session",
            },
          }),
          publish: { channelIds: ["main-channel"] },
        },
      ],
    });

    const sideEnvelopes = await call<any[]>("getEnvelopesForTrajectory", {
      branchId: "side-task",
    });
    expect(sideEnvelopes).toHaveLength(1);
    expect(sideEnvelopes[0]).toMatchObject({
      publication: {
        eventId: "side-summary",
        branchId: "side-task",
        channelId: "main-channel",
      },
      envelope: {
        payload: {
          kind: "message.completed",
          payload: { content: "Side task summary for the main session" },
        },
      },
    });

    const publishedEnvelopeId = sideEnvelopes[0].publication.envelopeId;
    const publicChannel = await call<any[]>("listChannelEnvelopes", {
      channelId: "main-channel",
    });
    expect(publicChannel.map((envelope) => envelope.payload.payload.content)).toEqual([
      "Side task summary for the main session",
    ]);
    expect(JSON.stringify(publicChannel)).not.toContain("keep this out of PubSub");

    const privateLineage = await call<any>("getPrivateLineageForPublishedEnvelope", {
      envelopeId: publishedEnvelopeId,
    });
    expect(privateLineage.branchEvents.map((row: any) => row.eventId)).toEqual([
      "side-private-observation",
      "side-summary",
    ]);
    expect(JSON.stringify(privateLineage.branchEvents)).toContain("keep this out of PubSub");

    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-main",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "main-consumes-side-summary",
          event: event("knowledge.claim_recorded", {
            turnId: "turn-main" as never,
            causality: { parentEventId: "side-summary" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              claimId: "claim-consumed-side-summary",
              subject: "main-session",
              predicate: "consumed-published-envelope",
              object: publishedEnvelopeId,
            },
          }),
        },
      ],
    });

    const consumers = await call<any[]>("getDownstreamConsumers", {
      envelopeId: publishedEnvelopeId,
    });
    expect(consumers.map((row) => row.eventId)).toEqual(["main-consumes-side-summary"]);
    expect(consumers[0]).toMatchObject({
      branchId: "main",
      payload: {
        object: publishedEnvelopeId,
      },
    });
  });

  it("enforces terminal invocation idempotency at append time", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-inv-start",
          event: event("invocation.started", {
            turnId: "turn-1" as never,
            causality: { invocationId: "inv-1" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, name: "read_file" },
          }),
        },
        {
          eventId: "event-inv-complete",
          event: event("invocation.completed", {
            turnId: "turn-1" as never,
            causality: { invocationId: "inv-1" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, result: "ok" },
          }),
        },
      ],
    });

    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        events: [
          {
            eventId: "event-inv-failed",
            event: event("invocation.failed", {
              turnId: "turn-1" as never,
              causality: { invocationId: "inv-1" as never },
              payload: { protocol: AGENTIC_PROTOCOL_VERSION, reason: "too late" },
            }),
          },
        ],
      }),
    ).rejects.toThrow(/duplicate terminal invocation/u);
  });

  it("projects file intent/apply events into content-addressed state provenance", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const appendResult = await call<Record<string, unknown>>("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "intent-1",
          event: event("state.file_mutation_intended", {
            causality: { invocationId: "inv-write" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              mutationId: "mut-1",
              path: "src/index.ts",
              operation: "write",
              inputStateHash:
                "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7" as never,
              rationale: "write planned",
            },
          }),
        },
        {
          eventId: "apply-1",
          event: event("state.file_mutation_applied", {
            causality: { invocationId: "inv-write" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              mutationId: "mut-1",
              path: "src/index.ts",
              operation: "write",
              inputStateHash:
                "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7" as never,
              afterHash: "blob:v1",
              hunks: [
                {
                  oldStartLine: 4,
                  oldLineCount: 2,
                  newStartLine: 4,
                  newLineCount: 3,
                  oldTextHash: "blob:old-lines",
                  newTextHash: "blob:new-lines",
                },
              ],
            } as never,
          }),
        },
      ],
    });

    const mutation = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT output_state_hash FROM gad_file_mutations WHERE mutation_id = ?",
      ["mut-1"],
    );
    const outputStateHash = String(mutation.rows[0]?.["output_state_hash"]);
    expect(outputStateHash).toMatch(/^state:/);
    expect(appendResult["headStateHash"]).toBe(outputStateHash);

    const producer = await call<Record<string, unknown> | null>("getGadStateProducer", {
      stateHash: outputStateHash,
    });
    expect(producer).toMatchObject({
      event_id: "apply-1",
      invocation_id: "inv-write",
      produced_by_mutation_id: "mut-1",
    });

    const file = await call<Record<string, unknown> | null>("readGadFileAtState", {
      stateHash: outputStateHash,
      path: "src/index.ts",
    });
    expect(file).toMatchObject({ path: "src/index.ts", content_hash: "blob:v1" });

    const diff = await call<{
      added: Array<Record<string, unknown>>;
      removed: unknown[];
      changed: unknown[];
    }>("diffGadStates", {
      leftStateHash: "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7",
      rightStateHash: outputStateHash,
    });
    expect(diff.added).toEqual([expect.objectContaining({ path: "src/index.ts" })]);

    const blame = await call<Array<Record<string, unknown>>>("blameGadFileSnippet", {
      stateHash: outputStateHash,
      path: "src/index.ts",
    });
    expect(blame[0]).toMatchObject({
      mutation_id: "mut-1",
      old_start_line: 4,
      old_line_count: 2,
      new_start_line: 4,
      new_line_count: 3,
      old_text_hash: "blob:old-lines",
      new_text_hash: "blob:new-lines",
    });
  });

  it("rebuilds projections from trajectory_events", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "msg-start",
          event: event("message.started", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant", content: "" },
          }),
        },
        {
          eventId: "msg-delta",
          event: event("message.delta", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, delta: "hello" },
          }),
        },
      ],
    });

    const replay = await call<{ replayed: number }>("rebuildTrajectoryProjections", {});
    expect(replay.replayed).toBe(2);
    const messages = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT message_id, body_assembled, status FROM trajectory_messages",
      [],
    );
    expect(messages.rows).toEqual([
      expect.objectContaining({ message_id: "msg-1", body_assembled: "hello", status: "streaming" }),
    ]);
  });

  it("projects replayable knowledge events", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "claim-1-event",
          event: event("knowledge.claim_recorded", {
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              claimId: "claim-1",
              subject: "system",
              predicate: "uses",
              object: "trajectory_events",
            },
          }),
        },
      ],
    });
    const claims = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT claim_id, subject, predicate, object, status FROM gad_claims",
      [],
    );
    expect(claims.rows).toEqual([
      expect.objectContaining({
        claim_id: "claim-1",
        subject: "system",
        predicate: "uses",
        object: "trajectory_events",
        status: "active",
      }),
    ]);
  });

  it("detects trajectory hash and state projection corruption", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "msg-1",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant", content: "hello" },
          }),
        },
      ],
    });

    sql.exec("UPDATE trajectory_events SET payload_json = ? WHERE event_id = ?", "{}", "msg-1");
    sql.exec(
      "INSERT INTO gad_state_transitions (event_id, input_state_hash, output_state_hash, created_at) VALUES (?, ?, ?, ?)",
      "missing-event",
      "state:missing-input",
      "state:missing-output",
      "2026-05-20T12:00:00.000Z",
    );

    const integrity = await call<{ ok: boolean; errors: Array<Record<string, unknown>> }>(
      "checkGadIntegrity",
      {},
    );
    expect(integrity.ok).toBe(false);
    expect(integrity.errors.map((error) => error["type"])).toEqual(
      expect.arrayContaining(["trajectory-event", "state-transition"]),
    );
  });
});
