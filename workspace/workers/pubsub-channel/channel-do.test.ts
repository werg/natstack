import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { AGENTIC_EVENT_PAYLOAD_KIND, AGENTIC_PROTOCOL_VERSION } from "@workspace/agentic-protocol";
import { GadWorkspaceDO } from "../gad-store/index.js";
import { PubSubChannel } from "./channel-do.js";

type TestDO<T> = Awaited<ReturnType<typeof createTestDO<T>>>;

function setRpcCaller(instance: PubSubChannel, callerId: string | null, callerKind: string | null): void {
  (instance as unknown as { _currentRpcCallerId: string | null })._currentRpcCallerId = callerId;
  (instance as unknown as { _currentRpcCallerKind: string | null })._currentRpcCallerKind = callerKind;
}

function agenticEvent(kind = "message.completed") {
  return {
    kind,
    actor: { kind: "user", id: "panel:user" },
    causality: { messageId: "msg-1" },
    payload: { protocol: "agentic.trajectory.v1", role: "user", content: "hello" },
    createdAt: new Date().toISOString(),
  };
}

function messageTypeRegisteredEvent(typeId: string, code = "export default function App() { return null; }") {
  return {
    kind: "messageType.registered",
    actor: { kind: "panel", id: "panel:user" },
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      typeId,
      displayMode: "row",
      source: { type: "code", code },
    },
    createdAt: new Date().toISOString(),
  };
}

async function createGadBackedChannel(options: {
  emitted?: unknown[];
  channelKey?: string;
  gad?: TestDO<GadWorkspaceDO>;
} = {}) {
  const gad = options.gad ?? await createTestDO(GadWorkspaceDO, { __objectKey: "workspace-gad" });
  const channel = await createTestDO(PubSubChannel, { __objectKey: options.channelKey ?? "channel-1" });
  const gadTarget = "do:workers/gad-store:GadWorkspaceDO:workspace-gad";
  (channel.instance as unknown as {
    _rpc: {
      emit: (target: string, event: string, payload: unknown) => Promise<void>;
      call: (target: string, method: string, args: unknown[]) => Promise<unknown>;
    };
  })._rpc = {
    emit: vi.fn(async (_target, _event, payload) => {
      options.emitted?.push(payload);
    }),
    call: vi.fn(async (target, method, args) => {
      if (target === "main" && method === "workers.resolveService") {
        return {
          kind: "durable-object",
          source: "workers/gad-store",
          className: "GadWorkspaceDO",
          objectKey: "workspace-gad",
          targetId: gadTarget,
        };
      }
      if (target === "main" && method === "runtime.setTitle") {
        // Title registry isn't relevant in unit tests; treat as a no-op.
        return undefined;
      }
      if (target === gadTarget) {
        const callable = gad.instance as unknown as Record<string, (...methodArgs: unknown[]) => unknown>;
        return await callable[method]!(...args);
      }
      throw new Error(`unexpected rpc call ${target}.${method}`);
    }),
  };
  return { gad, ...channel };
}

describe("PubSubChannel", () => {
  it("stores durable publishes as opaque channel envelopes", async () => {
    const { instance, gad } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");

    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });
    const result = await instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, agenticEvent(), {
      idempotencyKey: "publish-1",
    });

    expect(result.id).toBe(2);
    const rows = gad.sql.exec(
      `SELECT seq, envelope_id, payload_kind, payload_json, metadata_json
       FROM channel_envelopes ORDER BY seq ASC`,
    ).toArray();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      seq: 2,
      payload_kind: AGENTIC_EVENT_PAYLOAD_KIND,
    });
    expect(JSON.parse(rows[1]!["payload_json"] as string)).toMatchObject({
      kind: "message.completed",
    });
    expect(JSON.parse(rows[1]!["metadata_json"] as string)).toMatchObject({ name: "User" });
  });

  it("replays envelopes by sequence and paginates before a sequence", async () => {
    const { instance } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");

    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });
    await instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, agenticEvent("message.completed"));
    await instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, agenticEvent("message.completed"));

    const afterOne = await instance.getReplayAfter(1);
    expect(afterOne.logEvents.map((event) => event.id)).toEqual([2, 3]);
    expect(afterOne.ready).toMatchObject({
      totalCount: 3,
      envelopeCount: 3,
      firstEnvelopeSeq: 1,
    });

    const beforeThree = await instance.getReplayBefore(3, 1);
    expect(beforeThree.mode).toBe("before");
    expect(beforeThree.logEvents.map((event) => event.id)).toEqual([2]);
    expect(beforeThree.ready.hasMoreBefore).toBe(true);
  });

  it("delivers live envelopes to RPC subscribers", async () => {
    const emitted: unknown[] = [];
    const { instance } = await createGadBackedChannel({ emitted });
    setRpcCaller(instance, "panel:live", "panel");

    await instance.subscribe("panel:live", { contextId: "ctx-1", name: "User", type: "panel" });
    await instance.publish("panel:live", AGENTIC_EVENT_PAYLOAD_KIND, agenticEvent());
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(emitted.some((payload) => {
      const message = (payload as { message?: { kind?: string; event?: { type?: string } } }).message;
      return message?.kind === "log" && message.event?.type === AGENTIC_EVENT_PAYLOAD_KIND;
    })).toBe(true);
  });

  it("reports an envelope-only schema", async () => {
    const { instance } = await createGadBackedChannel();
    setRpcCaller(instance, "harness:test", "harness");

    const schema = await instance.adminInspectSchema();
    const envelopeTable = schema.tables.find((table) => table.table === "channel_envelopes");

    expect(envelopeTable).toBeUndefined();
    expect(schema.invariants.every((invariant) => invariant.ok)).toBe(true);
  });

  it("uses GAD as the durable channel log backend without changing replay shape", async () => {
    const { instance, sql } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");

    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });
    await instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, agenticEvent("message.completed"));

    expect(sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_envelopes'`).toArray()).toEqual([]);
    const replay = await instance.getReplayAfter(1);
    expect(replay.logEvents.map((event) => ({ id: event.id, type: event.type, senderId: event.senderId }))).toEqual([
      { id: 2, type: AGENTIC_EVENT_PAYLOAD_KIND, senderId: "panel:user" },
    ]);
    expect(replay.ready).toMatchObject({
      totalCount: 2,
      envelopeCount: 2,
      firstEnvelopeSeq: 1,
    });
    expect(replay.snapshots[0]).toMatchObject({
      kind: "roster-snapshot",
      participants: [expect.objectContaining({ id: "panel:user" })],
    });
  });

  it("forks the GAD-backed channel log during postClone", async () => {
    const parent = await createGadBackedChannel({ channelKey: "channel-parent" });
    setRpcCaller(parent.instance, "panel:user", "panel");
    await parent.instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });
    await parent.instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, agenticEvent("message.completed"));
    await parent.instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, {
      ...agenticEvent("message.completed"),
      causality: { messageId: "msg-2" },
    });

    const fork = await createGadBackedChannel({
      channelKey: "channel-fork",
      gad: parent.gad,
    });
    await fork.instance.postClone("channel-parent", 3);

    const replay = await fork.instance.getReplayAfter(0);
    expect(replay.logEvents.map((event) => event.id)).toEqual([2, 3]);
    const messages = replay.logEvents.filter((event) => event.type === AGENTIC_EVENT_PAYLOAD_KIND);
    expect(messages.map((event) => (event.payload as { causality: { messageId: string } }).causality.messageId)).toEqual([
      "msg-1",
      "msg-2",
    ]);
    expect(replay.ready).toMatchObject({
      totalCount: 2,
      envelopeCount: 2,
      firstEnvelopeSeq: 2,
    });

    setRpcCaller(fork.instance, "panel:user", "panel");
    await fork.instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, {
      ...agenticEvent("message.completed"),
      causality: { messageId: "msg-fork" },
    });
    const afterForkAppend = await fork.instance.getReplayAfter(3);
    expect(afterForkAppend.logEvents.map((event) => event.id)).toEqual([4]);
  });

  it("routes by transport id but publishes terminal events under the canonical invocation id", async () => {
    const { instance, gad } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", { contextId: "ctx-1", name: "Caller", type: "panel" });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", { contextId: "ctx-1", name: "Provider", type: "panel" });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-1",
      "eval",
      { code: "1 + 1" },
      { invocationId: "invocation-1", transportCallId: "transport-1", turnId: "turn-1" },
    );

    await instance.cancelMethodCall("transport-1");

    const rows = gad.sql.exec(
      `SELECT payload_json FROM channel_envelopes WHERE payload_kind = ? ORDER BY seq ASC`,
      AGENTIC_EVENT_PAYLOAD_KIND,
    ).toArray();
    const events = rows.map((row: Record<string, unknown>) => JSON.parse(row["payload_json"] as string));
    const started = events.find((event: { kind?: string }) => event.kind === "invocation.started");
    const cancelled = events.find((event: { kind?: string }) => event.kind === "invocation.cancelled");

    expect(started).toMatchObject({
      turnId: "turn-1",
      causality: { invocationId: "invocation-1", transportCallId: "transport-1" },
      payload: { transport: { transportCallId: "transport-1" } },
    });
    expect(cancelled).toMatchObject({
      turnId: "turn-1",
      causality: { invocationId: "invocation-1", transportCallId: "transport-1" },
    });
  });

  it("hydrates the message type registry from GAD instead of trusting a partial local cache", async () => {
    const { instance, gad } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });

    (instance as unknown as {
      cacheMessageTypeMutation: (seq: number, mutation: {
        kind: "upsertMessageType";
        typeId: string;
        row: { displayMode: "row"; source: { type: "code"; code: string } };
      }) => void;
    }).cacheMessageTypeMutation(1, {
      kind: "upsertMessageType",
      typeId: "weather",
      row: {
        displayMode: "row",
        source: { type: "code", code: "export default function Weather() { return null; }" },
      },
    });
    await gad.instance.appendChannelEnvelopeWithRegistryMutation({
      channelId: "channel-1" as never,
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payload: messageTypeRegisteredEvent("weather"),
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      registryMutation: {
        kind: "upsertMessageType",
        typeId: "weather",
        row: {
          displayMode: "row",
          source: { type: "code", code: "export default function Weather() { return null; }" },
        },
      },
    });
    await gad.instance.appendChannelEnvelopeWithRegistryMutation({
      channelId: "channel-1" as never,
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payload: messageTypeRegisteredEvent("calendar"),
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      registryMutation: {
        kind: "upsertMessageType",
        typeId: "calendar",
        row: {
          displayMode: "row",
          source: { type: "code", code: "export default function Calendar() { return null; }" },
        },
      },
    });

    await expect(instance.getMessageTypes()).resolves.toEqual([
      expect.objectContaining({ typeId: "calendar" }),
      expect.objectContaining({ typeId: "weather" }),
    ]);
  });

  it("rejects malformed message type registry events instead of persisting plain log rows", async () => {
    const { instance, gad } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });

    await expect(instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, {
      kind: "messageType.registered",
      actor: { kind: "panel", id: "panel:user" },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        typeId: "broken",
        displayMode: "bad",
        source: { type: "code", code: "export default function Broken() { return null; }" },
      },
      createdAt: new Date().toISOString(),
    })).rejects.toThrow(/Invalid registry payload/);

    const rows = gad.sql.exec(
      `SELECT payload_json FROM channel_envelopes WHERE payload_kind = ? ORDER BY seq ASC`,
      AGENTIC_EVENT_PAYLOAD_KIND,
    ).toArray();
    expect(rows.map((row) => JSON.parse(row["payload_json"] as string).kind)).not.toContain("messageType.registered");
  });
});
