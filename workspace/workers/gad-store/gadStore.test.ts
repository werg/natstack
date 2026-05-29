import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  checkTrajectoryIntegrity,
  type AgenticEvent,
} from "@workspace/agentic-protocol";
import { GadWorkspaceDO } from "./index.js";

const owner = { kind: "agent" as const, id: "agent-1" };

function event<K extends AgenticEvent["kind"]>(
  kind: K,
  patch: Omit<AgenticEvent<K>, "kind" | "actor" | "createdAt"> & { createdAt?: string }
): AgenticEvent<K> {
  return {
    kind,
    actor: owner,
    createdAt: patch.createdAt ?? "2026-05-20T12:00:00.000Z",
    ...patch,
  } as AgenticEvent<K>;
}

function blobRef(digest: string, encoded = "{}") {
  return {
    protocol: "natstack.blob-ref.v1" as const,
    digest,
    size: encoded.length,
    encoding: "json" as const,
    originalBytes: encoded.length,
  };
}

function largeParticipantMetadata() {
  return {
    type: "panel",
    name: "Panel",
    handle: "user",
    methods: [
      {
        name: "eval",
        description: "large method description",
        parameters: { type: "object", properties: { code: { type: "string" } } },
        returns: { type: "object" },
      },
    ],
    arbitraryLargeField: "x".repeat(1024),
  };
}

function expectNoPrivateParticipantMetadata(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain("parameters");
  expect(serialized).not.toContain("returns");
  expect(serialized).not.toContain("description");
  expect(serialized).not.toContain("arbitraryLargeField");
}

describe("GadWorkspaceDO trajectory persistence", () => {
  it("creates only canonical trajectory/channel tables, not Pi/session dispatch tables", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const tables = await call<{ rows: Array<{ name: string }> }>(
      "query",
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      []
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
      ])
    );
    const allowedPrefixes = ["trajectory_", "channel_", "gad_"];
    const allowedExact = new Set(["blobs", "state"]);
    expect(
      tables.rows
        .map((row) => row.name)
        .filter((name) => allowedPrefixes.every((prefix) => !name.startsWith(prefix)))
        .filter((name) => !allowedExact.has(name))
    ).toEqual([]);
  });

  it("allows read-only CTE diagnostics while still blocking writes", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    await expect(
      call<{ rows: Array<{ value: number }> }>(
        "query",
        "WITH nums(value) AS (SELECT 1) SELECT value FROM nums",
        []
      )
    ).resolves.toEqual({ rows: [{ value: 1 }] });

    await expect(
      call(
        "query",
        "WITH doomed(value) AS (SELECT 1) DELETE FROM gad_blobs WHERE digest IN (SELECT value FROM doomed)",
        []
      )
    ).rejects.toThrow("rawSql writes are disabled");
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
      "SELECT message_id, role, status FROM trajectory_messages",
      []
    );
    expect(projection.rows).toEqual([
      expect.objectContaining({
        message_id: "msg-1",
        role: "assistant",
        status: "completed",
      }),
    ]);

    const integrity = await call<{ errors: Array<{ type: string }> }>("checkGadIntegrity", {});
    expect(
      integrity.errors.filter((error) => error.type === "trajectory-channel-publication")
    ).toEqual([]);

    const publicationIntegrity = await call<any>("inspectPublicationIntegrity", {
      channelId: "channel-1",
    });
    expect(publicationIntegrity.summary).toMatchObject({
      expectedMappings: 1,
      missingMappings: 0,
      orphanMappings: 0,
      sequenceMismatches: 0,
      channelOriginAgenticEnvelopes: 0,
    });
  });

  it("rejects duplicate turn.opened events for the same branch turn", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "turn-opened-1",
          event: event("turn.opened", {
            turnId: "turn-1" as never,
            createdAt: "2026-05-20T12:00:00.000Z",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              summary: "first open",
            },
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
            eventId: "turn-opened-2",
            event: event("turn.opened", {
              turnId: "turn-1" as never,
              createdAt: "2026-05-20T12:05:00.000Z",
              payload: {
                protocol: AGENTIC_PROTOCOL_VERSION,
                summary: "duplicate open",
              },
            }),
          },
        ],
      })
    ).rejects.toThrow("duplicate turn.opened for turn turn-1");
  });

  it("rejects duplicate turn.opened events within the same append batch", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        events: [
          {
            eventId: "turn-opened-1",
            event: event("turn.opened", {
              turnId: "turn-1" as never,
              createdAt: "2026-05-20T12:00:00.000Z",
              payload: {
                protocol: AGENTIC_PROTOCOL_VERSION,
                summary: "first open",
              },
            }),
          },
          {
            eventId: "turn-opened-2",
            event: event("turn.opened", {
              turnId: "turn-1" as never,
              createdAt: "2026-05-20T12:05:00.000Z",
              payload: {
                protocol: AGENTIC_PROTOCOL_VERSION,
                summary: "duplicate open",
              },
            }),
          },
        ],
      })
    ).rejects.toThrow("duplicate turn.opened for turn turn-1");
  });

  it("inspects turn and invocation state without hydrating full payloads", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "turn-opened-1",
          event: event("turn.opened", {
            turnId: "turn-1" as never,
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "started" },
          }),
        },
        {
          eventId: "message-started-1",
          event: event("message.started", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant" },
          }),
        },
        {
          eventId: "invocation-started-1",
          event: event("invocation.started", {
            turnId: "turn-1" as never,
            causality: { invocationId: "tool-1" as never, transportCallId: "transport-1" },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              name: "eval",
              request: blobRef("request-1", '{"code":"large"}'),
            },
          }),
        },
        {
          eventId: "turn-opened-2",
          event: event("turn.opened", {
            turnId: "turn-2" as never,
            createdAt: "2026-05-20T12:01:00.000Z",
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "second" },
          }),
        },
        {
          eventId: "message-completed-2",
          event: event("message.completed", {
            turnId: "turn-2" as never,
            causality: { messageId: "msg-2" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant", content: "done" },
          }),
        },
      ],
    });

    const turns = await call<any>("inspectTurnState", { branchId: "main" });
    expect(turns.summary).toMatchObject({
      openTurns: 2,
      streamingMessages: 1,
      nonterminalInvocations: 1,
      duplicateOpenedTurns: 0,
    });
    expect(turns.rows[0]).toMatchObject({
      turn_id: "turn-2",
      streaming_messages: 0,
      nonterminal_invocations: 0,
    });
    expect(turns.rows[1]).toMatchObject({
      turn_id: "turn-1",
      streaming_messages: 1,
      nonterminal_invocations: 1,
    });

    const invocations = await call<any>("inspectInvocationState", {
      transportCallId: "transport-1",
    });
    expect(invocations.summary).toMatchObject({
      projected: 1,
      startedEvents: 1,
      terminalEvents: 0,
      openProjectedInvocations: 1,
    });
    expect(invocations.rows[0]).toMatchObject({
      invocation_id: "tool-1",
      transport_call_id: "transport-1",
      status: "started",
    });
  });

  it("treats replayed matching event ids as idempotent appends", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const input = {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-message-idempotent",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              role: "assistant",
              content: "hello once",
            },
          }),
          publish: { channelIds: ["channel-1"] },
        },
      ],
    };

    const first = await call<any>("appendTrajectoryBatch", input);
    const second = await call<any>("appendTrajectoryBatch", input);

    expect(second.headEventId).toBe(first.headEventId);
    expect(second.headEventHash).toBe(first.headEventHash);
    expect(second.events.map((row: { eventId: string }) => row.eventId)).toEqual([
      "event-message-idempotent",
    ]);
    expect(second.published).toEqual(first.published);

    const count = await call<{ rows: Array<{ cnt: number }> }>(
      "query",
      "SELECT COUNT(*) AS cnt FROM trajectory_events WHERE event_id = ?",
      ["event-message-idempotent"]
    );
    expect(count.rows[0]?.cnt).toBe(1);
  });

  it("continues trajectory append replay from an already-applied prefix", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const first = await call<any>("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-prefix",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-prefix" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              role: "assistant",
              content: "already committed",
            },
          }),
          publish: { channelIds: ["channel-1"] },
        },
      ],
    });

    const replay = await call<any>("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-prefix",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-prefix" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              role: "assistant",
              content: "already committed",
            },
          }),
          publish: { channelIds: ["channel-1"] },
        },
        {
          eventId: "event-suffix",
          event: event("invocation.completed", {
            turnId: "turn-1" as never,
            causality: { invocationId: "call-1" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, result: blobRef("result-ok", '"ok"') },
          }),
        },
      ],
    });

    expect(replay.events.map((row: { eventId: string }) => row.eventId)).toEqual([
      "event-prefix",
      "event-suffix",
    ]);
    expect(replay.published).toEqual(first.published);
    const rows = await call<{ rows: Array<{ event_id: string; kind: string }> }>(
      "query",
      "SELECT event_id, kind FROM trajectory_events WHERE branch_id = ? ORDER BY seq",
      ["main"]
    );
    expect(rows.rows.map((row) => row.event_id)).toEqual([
      "event-prefix",
      expect.any(String),
      "event-suffix",
    ]);
    expect(rows.rows.map((row) => row.kind)).toEqual([
      "message.completed",
      "external.envelope_published",
      "invocation.completed",
    ]);
  });

  it("rejects reused event ids with different event content", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-message-collision",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              role: "assistant",
              content: "first",
            },
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
            eventId: "event-message-collision",
            event: event("message.completed", {
              turnId: "turn-1" as never,
              causality: { messageId: "msg-1" as never },
              payload: {
                protocol: AGENTIC_PROTOCOL_VERSION,
                role: "assistant",
                content: "different",
              },
            }),
          },
        ],
      })
    ).rejects.toThrow(/GAD event id collision with different content/u);
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
              request: blobRef("request-1", '{"code":"1 \+ 1"}'),
            },
          }),
        },
      ],
    });

    const projected = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT invocation_id, transport_call_id FROM trajectory_invocations WHERE branch_id = ?",
      ["main"]
    );
    expect(projected.rows).toEqual([{ invocation_id: "tool-1", transport_call_id: "transport-1" }]);
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

    expect(
      await call<any[]>("listChannelEnvelopesAfter", { channelId: "channel-1", seq: 1 })
    ).toEqual([expect.objectContaining({ envelopeId: "env-2", seq: 2, payload: { value: 2 } })]);
    expect(
      await call<any[]>("listChannelEnvelopesBefore", { channelId: "channel-1", seq: 2, limit: 1 })
    ).toEqual([
      expect.objectContaining({
        envelopeId: "env-1",
        seq: 1,
        payloadKind: "custom.kind",
        metadata: { name: "User" },
      }),
    ]);
    const initial = await call<any>("getInitialChannelWindow", {
      channelId: "channel-1",
      limit: 1,
    });
    expect(initial).toMatchObject({
      totalCount: 2,
      replayFromId: 2,
      replayToId: 2,
      hasMoreBefore: true,
      envelopes: [expect.objectContaining({ envelopeId: "env-2" })],
    });
  });

  it("projects channel presence envelopes into the roster", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-presence-join",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "presence",
      payload: { action: "join", metadata: { name: "User", type: "panel" } },
      publishedAt: "2026-05-20T12:00:00.000Z",
    });
    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-presence-update",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "presence",
      payload: { action: "update", metadata: { name: "Renamed", type: "panel" } },
      publishedAt: "2026-05-20T12:01:00.000Z",
    });
    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-presence-leave",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "presence",
      payload: { action: "leave" },
      publishedAt: "2026-05-20T12:02:00.000Z",
    });

    const rows = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT participant_id, joined_at, left_at, roles_json FROM channel_roster WHERE channel_id = ?",
      ["channel-1"]
    );
    expect(rows.rows).toEqual([
      {
        participant_id: "panel:user",
        joined_at: "2026-05-20T12:00:00.000Z",
        left_at: "2026-05-20T12:02:00.000Z",
        roles_json: JSON.stringify({ name: "Renamed", type: "panel" }),
      },
    ]);

    const roster = await call<any>("inspectChannelRoster", { channelId: "channel-1" });
    expect(roster.summary).toMatchObject({
      rows: 1,
      activeParticipants: 0,
      inactiveParticipants: 1,
    });
    expect(roster.rows[0]).toMatchObject({
      participant_id: "panel:user",
      roles: { name: "Renamed", type: "panel" },
    });
  });

  it("returns a combined agent health diagnostic", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-presence-join",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "presence",
      payload: { action: "join", metadata: { name: "User", type: "panel" } },
      publishedAt: "2026-05-20T12:00:00.000Z",
    });
    await call("appendTrajectoryBatch", {
      trajectoryId: "branch:channel:channel-1",
      branchId: "branch:channel:channel-1",
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
              content: "done",
            },
          }),
          publish: { channelIds: ["channel-1"] },
        },
      ],
    });

    const health = await call<any>("inspectAgentHealth", { channelId: "channel-1" });
    expect(health).toMatchObject({
      channelId: "channel-1",
      branchId: "branch:channel:channel-1",
      summary: {
        ok: true,
        publicationIssues: 0,
        activeParticipants: 1,
      },
    });
    expect(health.publicationIntegrity.summary.expectedMappings).toBe(1);
    expect(health.roster.summary.activeParticipants).toBe(1);
  });

  it("does not fail agent health for expected channel-origin agentic envelopes", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-user-message",
      from: { kind: "user", id: "panel:user", participantId: "panel:user" },
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: event("message.completed", {
        turnId: "turn-1" as never,
        causality: { messageId: "user-msg-1" as never },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          role: "user",
          content: "hello",
        },
      }),
      publishedAt: "2026-05-20T12:00:00.000Z",
    });

    const health = await call<any>("inspectAgentHealth", { channelId: "channel-1" });
    expect(health.publicationIntegrity.summary.channelOriginAgenticEnvelopes).toBe(1);
    expect(health.summary).toMatchObject({
      ok: true,
      publicationIssues: 0,
    });
  });

  it("sanitizes every direct channel envelope append before persistence", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const hugeMetadata = largeParticipantMetadata();

    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-sanitized",
      from: {
        kind: "panel",
        id: "panel:user",
        participantId: "panel:user",
        metadata: hugeMetadata,
      },
      to: [{ kind: "agent", id: "agent:one", participantId: "agent:one", metadata: hugeMetadata }],
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: event("invocation.started", {
        causality: { invocationId: "inv-1" as never },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          name: "eval",
          transport: {
            kind: "channel",
            channelId: "channel-1" as never,
            target: {
              kind: "panel",
              id: "panel:user",
              participantId: "panel:user",
              metadata: hugeMetadata,
            },
          },
        },
      }),
      metadata: hugeMetadata,
    });

    const rows = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT from_json, to_json, payload_ref_json, metadata_json FROM channel_envelopes WHERE envelope_id = ?",
      ["env-sanitized"]
    );
    expectNoPrivateParticipantMetadata(rows.rows);
    expect(JSON.parse(rows.rows[0]?.["metadata_json"] as string)).toEqual({
      type: "panel",
      name: "Panel",
      handle: "user",
      methods: [{ name: "eval" }],
    });
  });

  it("sanitizes registry and trajectory-published channel envelopes before persistence", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const hugeMetadata = largeParticipantMetadata();

    await call("appendChannelEnvelopeWithRegistryMutation", {
      channelId: "channel-1",
      envelopeId: "env-registry",
      from: {
        kind: "panel",
        id: "panel:user",
        participantId: "panel:user",
        metadata: hugeMetadata,
      },
      payloadKind: "messageType.registered",
      payload: { typeId: "x" },
      metadata: hugeMetadata,
      registryMutation: {
        kind: "upsertMessageType",
        typeId: "custom",
        row: {
          displayMode: "inline",
          source: { type: "code", code: "export default null" },
          registeredBy: { kind: "panel", id: "panel:user", metadata: hugeMetadata },
        },
      },
    });

    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner: { kind: "agent", id: "agent-1", metadata: hugeMetadata },
      events: [
        {
          eventId: "event-sanitized",
          event: {
            kind: "invocation.started",
            actor: { kind: "agent", id: "agent-1", metadata: hugeMetadata },
            createdAt: "2026-05-20T12:00:00.000Z",
            turnId: "turn-1" as never,
            causality: { invocationId: "inv-1" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              name: "eval",
              transport: {
                kind: "channel",
                channelId: "channel-1" as never,
                target: {
                  kind: "panel",
                  id: "panel:user",
                  participantId: "panel:user",
                  metadata: hugeMetadata,
                },
              },
            },
          },
          publish: {
            channelIds: ["channel-1"],
            audience: [
              {
                kind: "panel",
                id: "panel:user",
                participantId: "panel:user",
                metadata: hugeMetadata,
              },
            ],
          },
        },
      ],
    });

    const rows = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      `SELECT from_json, to_json, payload_ref_json, metadata_json FROM channel_envelopes
       UNION ALL
       SELECT actor_json AS from_json, NULL AS to_json, payload_ref_json, NULL AS metadata_json FROM trajectory_events`,
      []
    );
    const registered = await call<any[]>("listMessageTypes", { channelId: "channel-1" });

    expectNoPrivateParticipantMetadata(rows.rows);
    expectNoPrivateParticipantMetadata(registered);
  });

  it("provides compact channel envelope inspection for debugging", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-large",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: "x".repeat(4096) },
      metadata: { name: "User" },
    });

    const raw = await call<any[]>("listChannelEnvelopes", { channelId: "channel-1" });
    const inspected = await call<{ rows: Array<Record<string, unknown>> }>(
      "inspectChannelEnvelopes",
      { channelId: "channel-1" }
    );

    expect(JSON.stringify(raw).length).toBeGreaterThan(4000);
    expect(JSON.stringify(inspected).length).toBeLessThan(2000);
    expect(inspected.rows[0]).toMatchObject({
      envelopeId: "env-large",
      payloadKind: "custom.kind",
      bytes: { payload: expect.any(Number) },
      payloadSummary: {
        value: { type: "string", chars: 4096 },
      },
    });
  });

  it("treats replayed matching channel envelope ids as idempotent appends", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const input = {
      channelId: "channel-1",
      envelopeId: "env-idempotent",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: 1 },
      publishedAt: "2026-05-20T12:00:00.000Z",
    };

    const first = await call<any>("appendChannelEnvelope", input);
    const second = await call<any>("appendChannelEnvelope", input);

    expect(second).toEqual(first);
    const count = await call<{ rows: Array<{ cnt: number }> }>(
      "query",
      "SELECT COUNT(*) AS cnt FROM channel_envelopes WHERE envelope_id = ?",
      ["env-idempotent"]
    );
    expect(count.rows[0]?.cnt).toBe(1);
    await expect(
      call("appendChannelEnvelope", {
        ...input,
        payload: { value: 2 },
      })
    ).rejects.toThrow(/GAD channel envelope id collision with different content/u);
  });

  it("bounds replay-after windows and forks channel logs with preserved sequence lineage", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendChannelEnvelope", {
      channelId: "channel-parent",
      envelopeId: "env-1",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: 1 },
      publishedAt: "2026-05-20T12:00:01.000Z",
    });
    await call("appendChannelEnvelope", {
      channelId: "channel-parent",
      envelopeId: "env-presence",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "presence",
      payload: { action: "join" },
      publishedAt: "2026-05-20T12:00:02.000Z",
    });
    await call("appendChannelEnvelope", {
      channelId: "channel-parent",
      envelopeId: "env-2",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: 2 },
      publishedAt: "2026-05-20T12:00:03.000Z",
    });
    await call("appendChannelEnvelope", {
      channelId: "channel-parent",
      envelopeId: "env-3",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: 3 },
      publishedAt: "2026-05-20T12:00:04.000Z",
    });

    const limited = await call<any>("getChannelReplayWindow", {
      channelId: "channel-parent",
      mode: "after",
      sinceSeq: 1,
      limit: 1,
    });
    expect(limited.envelopes.map((envelope: any) => envelope.seq)).toEqual([2]);

    const result = await call<any>("forkChannelLog", {
      fromChannelId: "channel-parent",
      toChannelId: "channel-fork",
      throughSeq: 3,
    });
    expect(result).toMatchObject({
      fromChannelId: "channel-parent",
      toChannelId: "channel-fork",
      copied: 2,
      firstSeq: 1,
      lastSeq: 3,
    });
    expect(result.lineage).toHaveLength(2);
    expect(result.lineage[0]).toMatchObject({
      sourceEnvelopeId: "env-1",
      sourceSeq: 1,
      forkSeq: 1,
    });
    expect(result.lineage[1]).toMatchObject({
      sourceEnvelopeId: "env-2",
      sourceSeq: 3,
      forkSeq: 3,
    });
    expect(result.lineage[0].forkEnvelopeId).not.toBe("env-1");
    await expect(
      call<any>("forkChannelLog", {
        fromChannelId: "channel-parent",
        toChannelId: "channel-fork",
        throughSeq: 3,
      })
    ).resolves.toMatchObject({ lineage: result.lineage, copied: 2 });

    const forked = await call<any[]>("listChannelEnvelopesAfter", {
      channelId: "channel-fork",
      seq: 0,
      limit: 10,
    });
    expect(forked.map((envelope) => [envelope.seq, envelope.payload.value])).toEqual([
      [1, 1],
      [3, 2],
    ]);
    expect(forked.map((envelope) => envelope.envelopeId)).not.toContain("env-1");
    expect(forked.map((envelope) => envelope.payloadKind)).not.toContain("presence");

    await call("appendChannelEnvelope", {
      channelId: "channel-fork",
      envelopeId: "env-fork-new",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: 4 },
    });
    const afterForkAppend = await call<any[]>("listChannelEnvelopesAfter", {
      channelId: "channel-fork",
      seq: 3,
      limit: 10,
    });
    expect(afterForkAppend).toEqual([
      expect.objectContaining({ envelopeId: "env-fork-new", seq: 4 }),
    ]);

    const lineageRows = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT source_envelope_id, fork_envelope_id, source_seq, fork_seq FROM channel_envelope_forks ORDER BY fork_seq",
      []
    );
    expect(lineageRows.rows).toEqual(
      result.lineage.map((row: any) => ({
        source_envelope_id: row.sourceEnvelopeId,
        fork_envelope_id: row.forkEnvelopeId,
        source_seq: row.sourceSeq,
        fork_seq: row.forkSeq,
      }))
    );
  });

  it("forks trajectory branches through a published channel sequence without copying later private state", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const result = await call<any>("appendTrajectoryBatch", {
      trajectoryId: "branch:channel:parent",
      branchId: "branch:channel:parent",
      owner,
      events: [
        {
          eventId: "event-private-before",
          event: event("system.event", {
            turnId: "turn-1" as never,
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              kind: "private-before",
              details: blobRef("details-before", '{"value":1}'),
            },
          }),
        },
        {
          eventId: "event-public-message",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-public" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              role: "assistant",
              content: "visible at fork point",
            },
          }),
          publish: { channelIds: ["channel-parent"] },
        },
        {
          eventId: "event-private-after",
          event: event("system.event", {
            turnId: "turn-2" as never,
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              kind: "private-after",
              details: blobRef("details-after", '{"value":2}'),
            },
          }),
        },
      ],
    });
    const publishedSeq = (
      await call<any[]>("listChannelEnvelopesAfter", {
        channelId: "channel-parent",
        seq: 0,
        limit: 10,
      })
    )[0].seq;
    const channelFork = await call<any>("forkChannelLog", {
      fromChannelId: "channel-parent",
      toChannelId: "channel-fork",
      throughSeq: publishedSeq,
    });

    const fork = await call<any>("forkTrajectoryBranch", {
      fromTrajectoryId: "branch:channel:parent",
      fromBranchId: "branch:channel:parent",
      toTrajectoryId: "branch:channel:fork",
      toBranchId: "branch:channel:fork",
      throughPublishedChannelId: "channel-parent",
      throughPublishedChannelSeq: publishedSeq,
      toPublishedChannelId: "channel-fork",
      owner,
    });
    expect(fork.copied).toBe(2);
    expect(fork.lineage.map((row: any) => row.sourceEventId)).toEqual([
      "event-private-before",
      "event-public-message",
    ]);
    expect(fork.headEventHash).toBe(fork.lineage[1].forkEventHash);
    await expect(
      call<any>("forkTrajectoryBranch", {
        fromTrajectoryId: "branch:channel:parent",
        fromBranchId: "branch:channel:parent",
        toTrajectoryId: "branch:channel:fork",
        toBranchId: "branch:channel:fork",
        throughPublishedChannelId: "channel-parent",
        throughPublishedChannelSeq: publishedSeq,
        toPublishedChannelId: "channel-fork",
        owner,
      })
    ).resolves.toMatchObject({
      lineage: fork.lineage,
      headEventHash: fork.headEventHash,
    });

    const events = await call<any[]>("listTrajectoryEvents", {
      trajectoryId: "branch:channel:fork",
      branchId: "branch:channel:fork",
      limit: 0,
    });
    expect(events.map((row) => row.kind)).toEqual(["system.event", "message.completed"]);
    expect(events.map((row) => row.eventId)).not.toContain("event-private-after");
    expect(() => checkTrajectoryIntegrity(events)).not.toThrow();

    const messages = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT message_id, role, status FROM trajectory_messages WHERE branch_id = ?",
      ["branch:channel:fork"]
    );
    expect(messages.rows).toEqual([
      expect.objectContaining({
        message_id: "msg-public",
        role: "assistant",
        status: "completed",
      }),
    ]);

    const head = await call<any>("getTrajectoryBranchHead", {
      trajectoryId: "branch:channel:fork",
      branchId: "branch:channel:fork",
    });
    expect(head).toMatchObject({
      parent_branch_id: "branch:channel:parent",
      fork_event_id: "event-public-message",
      head_event_hash: fork.headEventHash,
    });
    const forkedPublicLineage = await call<any>("getTrajectoryForEnvelope", {
      envelopeId: channelFork.lineage[0].forkEnvelopeId,
    });
    expect(forkedPublicLineage).toMatchObject({
      publication: {
        eventId: fork.lineage[1].forkEventId,
        trajectoryId: "branch:channel:fork",
        branchId: "branch:channel:fork",
        channelId: "channel-fork",
        channelSeq: publishedSeq,
      },
      trajectoryEvent: {
        eventId: fork.lineage[1].forkEventId,
        kind: "message.completed",
      },
    });
    expect(result.events.map((row: any) => row.eventId)).toContain("event-private-after");
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
              details: blobRef("details-side", '{"privateFinding":"keep this out of PubSub"}'),
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
    expect(JSON.stringify(privateLineage.branchEvents)).not.toContain("keep this out of PubSub");
    expect(privateLineage.branchEvents[0].payload.details).toMatchObject({
      protocol: "natstack.blob-ref.v1",
      digest: "details-side",
    });

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
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, result: blobRef("result-ok", '"ok"') },
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
      })
    ).rejects.toThrow(/duplicate terminal invocation/u);
  });

  it("enforces terminal approval idempotency at projection time", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-approval-request",
          event: event("approval.requested", {
            turnId: "turn-1" as never,
            causality: { approvalId: "appr-1" as never, invocationId: "inv-1" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, question: "Run eval?" },
          }),
        },
        {
          eventId: "event-approval-grant",
          event: event("approval.resolved", {
            turnId: "turn-1" as never,
            causality: { approvalId: "appr-1" as never, invocationId: "inv-1" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, granted: true, resolvedBy: owner },
          }),
        },
      ],
    });

    // A second, different-content resolution (deny) carries a fresh event id,
    // so it is NOT an idempotent retry and must be rejected at projection time
    // rather than silently flipping the recorded decision.
    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        events: [
          {
            eventId: "event-approval-deny",
            event: event("approval.resolved", {
              turnId: "turn-1" as never,
              causality: { approvalId: "appr-1" as never, invocationId: "inv-1" as never },
              payload: { protocol: AGENTIC_PROTOCOL_VERSION, granted: false, resolvedBy: owner },
            }),
          },
        ],
      })
    ).rejects.toThrow(/duplicate terminal approval/u);

    const approval = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT status, resolved_event_id FROM trajectory_approvals WHERE approval_id = ?",
      ["appr-1"]
    );
    expect(approval.rows[0]).toMatchObject({
      status: "granted",
      resolved_event_id: "event-approval-grant",
    });
  });

  it("indexes stored value references from trajectory payloads", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-inv-complete-ref",
          event: event("invocation.completed", {
            turnId: "turn-1" as never,
            causality: { invocationId: "inv-1" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              result: {
                protocol: "natstack.blob-ref.v1",
                digest: "abc123",
                size: 42,
                encoding: "json",
                originalBytes: 42,
              },
            },
          }),
        },
      ],
    });

    const refs = await call<{
      rows: Array<{ event_id: string; field_path: string; digest: string }>;
    }>(
      "query",
      "SELECT event_id, field_path, digest FROM trajectory_blob_refs ORDER BY event_id, field_path",
      []
    );
    expect(refs.rows).toEqual([
      { event_id: "event-inv-complete-ref", field_path: "$.result", digest: "abc123" },
    ]);
  });

  it("rejects raw unbounded trajectory payload fields", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        events: [
          {
            eventId: "event-raw-result",
            event: event("invocation.completed", {
              turnId: "turn-1" as never,
              causality: { invocationId: "inv-1" as never },
              payload: { protocol: AGENTIC_PROTOCOL_VERSION, result: { raw: true } },
            }),
          },
        ],
      })
    ).rejects.toThrow(/unencoded stored values/u);
  });

  it("reports oversized storage rows through diagnostics and integrity checks", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-oversized",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: "x".repeat(530 * 1024) },
    });

    const diagnostics = await call<{ rows: Array<Record<string, unknown>> }>(
      "inspectStorageDiagnostics",
      {}
    );
    expect(diagnostics.rows).toEqual([
      expect.objectContaining({
        scope: "channel_envelopes",
        id: "env-oversized",
      }),
    ]);

    const integrity = await call<{ ok: boolean; errors: Array<Record<string, unknown>> }>(
      "checkGadIntegrity",
      {}
    );
    expect(integrity.ok).toBe(false);
    expect(integrity.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "storage-diagnostic",
          scope: "channel_envelopes",
          id: "env-oversized",
        }),
      ])
    );
  });

  it("flags private participant metadata if storage rows are corrupted", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);
    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-corrupt",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: 1 },
    });
    sql.exec(
      `UPDATE channel_envelopes SET from_json = ? WHERE envelope_id = ?`,
      JSON.stringify({ kind: "panel", id: "panel:user", metadata: largeParticipantMetadata() }),
      "env-corrupt"
    );

    const integrity = await call<{ ok: boolean; errors: Array<Record<string, unknown>> }>(
      "checkGadIntegrity",
      {}
    );

    expect(integrity.ok).toBe(false);
    expect(integrity.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "channel-envelope-shape",
          envelopeId: "env-corrupt",
          field: "from_json",
        }),
      ])
    );
  });

  it("reports storage diagnostics and garbage-collects unreferenced blob metadata", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("ensureBlob", "orphan-digest", 10, "text/plain");
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-ref",
          event: event("invocation.completed", {
            turnId: "turn-1" as never,
            causality: { invocationId: "inv-1" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              result: {
                protocol: "natstack.blob-ref.v1",
                digest: "kept-digest",
                size: 20,
                encoding: "json",
                originalBytes: 20,
              },
            },
          }),
        },
      ],
    });

    const refs = await call<{ rows: Array<{ digest: string }> }>("listStoredValueRefs", {
      eventId: "event-ref",
    });
    expect(refs.rows.map((row) => row.digest)).toEqual(["kept-digest"]);
    const diagnostics = await call<{ rows: unknown[] }>("inspectStorageDiagnostics", {});
    expect(diagnostics.rows).toEqual([]);
    const dryRun = await call<{ deleted: string[]; dryRun: boolean }>("collectGarbageBlobRefs", {});
    expect(dryRun).toMatchObject({ deleted: ["orphan-digest"], dryRun: true });
    const deleted = await call<{ deleted: string[]; dryRun: boolean }>("collectGarbageBlobRefs", {
      dryRun: false,
    });
    expect(deleted).toMatchObject({ deleted: ["orphan-digest"], dryRun: false });
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
      ["mut-1"]
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
      "SELECT message_id, role, status FROM trajectory_messages",
      []
    );
    expect(messages.rows).toEqual([
      expect.objectContaining({
        message_id: "msg-1",
        role: "assistant",
        status: "streaming",
      }),
    ]);
  });

  it("deterministically rebuilds state-transition chains for mutations without explicit state hashes", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    // The real producer (pi-runner) emits file_mutation_applied with only
    // beforeHash/afterHash and no inputStateHash/outputStateHash, so the store
    // derives input state from the branch head. Replay must seed from the
    // empty state so the rebuilt chain matches the original append.
    const appendResult = await call<Record<string, unknown>>("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "apply-a",
          event: event("state.file_mutation_applied", {
            causality: { invocationId: "inv-a" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              mutationId: "mut-a",
              path: "a.ts",
              operation: "write",
              afterHash: "blob:a1",
            } as never,
          }),
        },
        {
          eventId: "apply-b",
          event: event("state.file_mutation_applied", {
            causality: { invocationId: "inv-b" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              mutationId: "mut-b",
              path: "b.ts",
              operation: "write",
              afterHash: "blob:b1",
            } as never,
          }),
        },
      ],
    });

    const transitionsQuery =
      "SELECT produced_by_mutation_id, input_state_hash, output_state_hash FROM gad_state_transitions ORDER BY event_id";
    const before = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      transitionsQuery,
      []
    );
    expect(before.rows).toHaveLength(2);
    // Chain is contiguous, and the first mutation's input is NOT the final head
    // (it is the empty state). This is what a non-reset replay would corrupt.
    expect(before.rows[1]?.["input_state_hash"]).toBe(before.rows[0]?.["output_state_hash"]);
    expect(before.rows[0]?.["input_state_hash"]).not.toBe(appendResult["headStateHash"]);

    const replay = await call<{ replayed: number }>("rebuildTrajectoryProjections", {});
    expect(replay.replayed).toBe(2);

    const after = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      transitionsQuery,
      []
    );
    expect(after.rows).toEqual(before.rows);

    const head = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT head_state_hash FROM trajectory_branches WHERE branch_id = ?",
      ["main"]
    );
    expect(head.rows[0]?.["head_state_hash"]).toBe(appendResult["headStateHash"]);
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
      []
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

    sql.exec("UPDATE trajectory_events SET payload_ref_json = ? WHERE event_id = ?", "{}", "msg-1");
    sql.exec(
      "INSERT INTO gad_state_transitions (event_id, input_state_hash, output_state_hash, created_at) VALUES (?, ?, ?, ?)",
      "missing-event",
      "state:missing-input",
      "state:missing-output",
      "2026-05-20T12:00:00.000Z"
    );

    const integrity = await call<{ ok: boolean; errors: Array<Record<string, unknown>> }>(
      "checkGadIntegrity",
      {}
    );
    expect(integrity.ok).toBe(false);
    expect(integrity.errors.map((error) => error["type"])).toEqual(
      expect.arrayContaining(["trajectory-event", "state-transition"])
    );
  });
});
