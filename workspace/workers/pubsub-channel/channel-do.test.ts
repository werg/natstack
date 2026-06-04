import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  invocationAbandonedPayload,
  invocationCompletedPayload,
} from "@workspace/agentic-protocol";
import { GadWorkspaceDO } from "../gad-store/index.js";
import { PubSubChannel } from "./channel-do.js";

type TestDO<T> = Awaited<ReturnType<typeof createTestDO<T>>>;

function setRpcCaller(
  instance: PubSubChannel,
  callerId: string | null,
  callerKind: string | null
): void {
  (instance as unknown as { _currentRpcCallerId: string | null })._currentRpcCallerId = callerId;
  (instance as unknown as { _currentRpcCallerKind: string | null })._currentRpcCallerKind =
    callerKind;
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

function messageTypeRegisteredEvent(
  typeId: string,
  code = "export default function App() { return null; }"
) {
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

async function createGadBackedChannel(
  options: {
    emitted?: unknown[];
    channelKey?: string;
    gad?: TestDO<GadWorkspaceDO>;
    blobstorePutText?: (value: string) => Promise<{ digest: string; size: number }>;
    rpcCall?: (target: string, method: string, args: unknown[]) => Promise<unknown> | unknown;
  } = {}
) {
  const gad = options.gad ?? (await createTestDO(GadWorkspaceDO, { __objectKey: "workspace-gad" }));
  const channel = await createTestDO(PubSubChannel, {
    __objectKey: options.channelKey ?? "channel-1",
  });
  const gadTarget = "do:workers/gad-store:GadWorkspaceDO:workspace-gad";
  const blobs = new Map<string, string>();
  (
    channel.instance as unknown as {
      _rpc: {
        emit: (target: string, event: string, payload: unknown) => Promise<void>;
        call: (target: string, method: string, args: unknown[]) => Promise<unknown>;
      };
    }
  )._rpc = {
    emit: vi.fn(async (_target, _event, payload) => {
      options.emitted?.push(payload);
    }),
    call: vi.fn(async (target, method, args) => {
      const custom = await options.rpcCall?.(target, method, args);
      if (custom !== undefined) return custom;
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
      if (target === "main" && method === "blobstore.putText") {
        const value = String(args[0] ?? "");
        const blob = options.blobstorePutText
          ? await options.blobstorePutText(value)
          : { digest: `test-digest-${blobs.size + 1}`, size: value.length };
        blobs.set(blob.digest, value);
        return blob;
      }
      if (target === "main" && method === "blobstore.getText") {
        return blobs.get(String(args[0] ?? "")) ?? null;
      }
      if (target === gadTarget) {
        const callable = gad.instance as unknown as Record<
          string,
          (...methodArgs: unknown[]) => unknown
        >;
        return await callable[method]!(...args);
      }
      throw new Error(`unexpected rpc call ${target}.${method}`);
    }),
  };
  return { gad, blobs, ...channel };
}

describe("PubSubChannel", () => {
  it("stores durable publishes as opaque channel envelopes", async () => {
    const { instance, gad } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");

    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });
    const result = await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent(),
      {
        idempotencyKey: "publish-1",
      }
    );

    expect(result.id).toBe(2);
    const rows = gad.sql
      .exec(
        `SELECT seq, envelope_id, payload_kind, payload_ref_json, metadata_json
       FROM channel_envelopes ORDER BY seq ASC`
      )
      .toArray();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      seq: 2,
      payload_kind: AGENTIC_EVENT_PAYLOAD_KIND,
    });
    expect(JSON.parse(rows[1]!["payload_ref_json"] as string)).toMatchObject({
      kind: "message.completed",
    });
    expect(JSON.parse(rows[1]!["metadata_json"] as string)).toMatchObject({ name: "User" });
  });

  it("does not persist full method schemas in durable participant metadata", async () => {
    const { instance, gad } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");

    await instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
      handle: "user",
      methods: [
        {
          name: "eval",
          description: "x".repeat(4096),
          parameters: {
            type: "object",
            properties: {
              code: { type: "string", description: "y".repeat(4096) },
            },
          },
          returns: { type: "object", description: "z".repeat(4096) },
        },
      ],
    });
    await instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, agenticEvent(), {
      idempotencyKey: "publish-with-methods",
    });

    const rows = gad.sql
      .exec(
        `SELECT from_json, payload_ref_json, metadata_json
         FROM channel_envelopes ORDER BY seq ASC`
      )
      .toArray();
    const durableJson = JSON.stringify(rows);

    expect(durableJson).not.toContain("properties");
    expect(durableJson).not.toContain("returns");
    expect(durableJson).not.toContain("description");
    expect(durableJson).not.toContain("yyyy");
    expect(JSON.parse(rows[0]!["payload_ref_json"] as string)).toMatchObject({
      metadata: { methods: [{ name: "eval" }] },
    });
    expect(JSON.parse(rows[1]!["metadata_json"] as string)).toMatchObject({
      methods: [{ name: "eval" }],
    });
  });

  it("fails durable publishes when blobstore storage fails", async () => {
    const { instance } = await createGadBackedChannel({
      blobstorePutText: async (value) => {
        if (!value.includes("must be stored")) {
          return { digest: "setup-digest", size: value.length };
        }
        throw new Error("blobstore unavailable");
      },
    });
    setRpcCaller(instance, "panel:user", "panel");

    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });
    let error: unknown;
    try {
      await instance.publish("panel:user", "custom.large", {
        value: `must be stored ${"x".repeat(160 * 1024)}`,
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("blobstore unavailable");
  });

  it("spills large durable payloads to blobstore and replays hydrated payloads", async () => {
    const blobs = new Map<string, string>();
    const { instance } = await createGadBackedChannel({
      blobstorePutText: async (value) => {
        const digest = `digest-${blobs.size + 1}`;
        blobs.set(digest, value);
        return { digest, size: value.length };
      },
    });
    setRpcCaller(instance, "panel:user", "panel");
    const largeResult = "x".repeat(140 * 1024);

    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      {
        ...agenticEvent("invocation.completed"),
        causality: { invocationId: "inv-large", transportCallId: "call-large" },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          result: { text: largeResult },
          terminalOutcome: "success",
        },
      },
      { idempotencyKey: "large-publish" }
    );

    const replay = await instance.getReplayAfter(1);
    const event = replay.logEvents.find((item) => item.type === AGENTIC_EVENT_PAYLOAD_KIND);
    const payload = ((event?.payload as { payload?: unknown })?.payload ?? {}) as Record<
      string,
      unknown
    >;
    expect(blobs.size).toBeGreaterThan(0);
    expect(payload["result"]).toEqual({ text: largeResult });
  });

  it("replays envelopes by sequence and paginates before a sequence", async () => {
    const { instance } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");

    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent("message.completed")
    );
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent("message.completed")
    );

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

    expect(
      emitted.some((payload) => {
        const message = (payload as { message?: { kind?: string; event?: { type?: string } } })
          .message;
        return message?.kind === "log" && message.event?.type === AGENTIC_EVENT_PAYLOAD_KIND;
      })
    ).toBe(true);
  });

  it("evicts missing DO subscribers during replay delivery without noisy fatal logs", async () => {
    const missingDoId = "do:workers/agent-worker:AiChatWorker:headless-missing";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { instance, sql } = await createGadBackedChannel({
      rpcCall: async (target, method) => {
        if (target === "main" && method === "workers.resolveDurableObject") {
          return {
            kind: "durable-object",
            source: "workers/agent-worker",
            className: "AiChatWorker",
            objectKey: "headless-missing",
            targetId: missingDoId,
          };
        }
        if (target === missingDoId && method === "onChannelEnvelope") {
          const err = new Error("runtime entity not registered") as Error & { code?: string };
          err.code = "DO_NOT_CREATED";
          throw err;
        }
        return undefined;
      },
    });

    try {
      setRpcCaller(instance, "panel:user", "panel");
      await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });
      await instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, agenticEvent());

      setRpcCaller(instance, missingDoId, "durable-object");
      await instance.subscribe(missingDoId, {
        contextId: "ctx-1",
        name: "Missing agent",
        type: "agent",
      });
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(sql.exec(`SELECT id FROM participants WHERE id = ?`, missingDoId).toArray()).toEqual(
        []
      );
      expect(consoleError).not.toHaveBeenCalledWith(
        expect.stringContaining("[Channel] delivery failed"),
        expect.anything()
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("reports an envelope-only schema", async () => {
    const { instance } = await createGadBackedChannel();
    setRpcCaller(instance, "harness:test", "harness");

    const schema = await instance.adminInspectSchema();
    const envelopeTable = schema.tables.find((table) => table.table === "channel_envelopes");

    expect(envelopeTable).toBeUndefined();
    expect(schema.invariants.every((invariant) => invariant.ok)).toBe(true);
  });

  it("routes pause method calls through visible method invocation transport", async () => {
    const targetPid = "do:workers/agent-worker:AiChatWorker:agent-1";
    const rpcCalls: Array<{ target: string; method: string; args: unknown[] }> = [];
    const { instance, gad } = await createGadBackedChannel({
      rpcCall: (target, method, args) => {
        if (target === "main" && method === "workers.resolveDurableObject") return {};
        if (target === targetPid && method === "onChannelEnvelope") return null;
        if (target === targetPid && method === "onMethodCall") {
          rpcCalls.push({ target, method, args });
          return { result: { paused: true } };
        }
        return undefined;
      },
    });

    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });
    setRpcCaller(instance, targetPid, "durable-object");
    await instance.subscribe(targetPid, { contextId: "ctx-1", name: "AI Chat", type: "agent" });

    setRpcCaller(instance, "panel:user", "panel");
    await instance.callMethod(
      "panel:user",
      targetPid,
      "pause-call",
      "pause",
      { reason: "User interrupted execution" },
      { invocationId: "pause-invocation", transportCallId: "pause-call" }
    );

    expect(rpcCalls).toEqual([
      {
        target: targetPid,
        method: "onMethodCall",
        args: [
          "channel-1",
          "pause-call",
          "pause",
          { reason: "User interrupted execution" },
          { invocationId: "pause-invocation", turnId: undefined },
        ],
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const events = gad.sql
      .exec(
        `SELECT payload_ref_json FROM channel_envelopes WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND
      )
      .toArray()
      .map((row: Record<string, unknown>) => JSON.parse(row["payload_ref_json"] as string));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "invocation.started",
          causality: { invocationId: "pause-invocation", transportCallId: "pause-call" },
        }),
        expect.objectContaining({
          kind: "invocation.completed",
          causality: { invocationId: "pause-invocation", transportCallId: "pause-call" },
        }),
      ])
    );
  });

  it("uses GAD as the durable channel log backend without changing replay shape", async () => {
    const { instance, sql } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");

    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });
    await instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent("message.completed")
    );

    expect(
      sql
        .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_envelopes'`)
        .toArray()
    ).toEqual([]);
    const replay = await instance.getReplayAfter(1);
    expect(
      replay.logEvents.map((event) => ({
        id: event.id,
        type: event.type,
        senderId: event.senderId,
      }))
    ).toEqual([{ id: 2, type: AGENTIC_EVENT_PAYLOAD_KIND, senderId: "panel:user" }]);
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
    await parent.instance.subscribe("panel:user", {
      contextId: "ctx-1",
      name: "User",
      type: "panel",
    });
    await parent.instance.publish(
      "panel:user",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agenticEvent("message.completed")
    );
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
    expect(
      messages.map(
        (event) => (event.payload as { causality: { messageId: string } }).causality.messageId
      )
    ).toEqual(["msg-1", "msg-2"]);
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
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-1",
      "eval",
      { code: "1 + 1" },
      { invocationId: "invocation-1", transportCallId: "transport-1", turnId: "turn-1" }
    );

    await instance.cancelMethodCall("transport-1");

    const rows = gad.sql
      .exec(
        `SELECT payload_ref_json FROM channel_envelopes WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND
      )
      .toArray();
    const events = rows.map((row: Record<string, unknown>) =>
      JSON.parse(row["payload_ref_json"] as string)
    );
    const started = events.find((event: { kind?: string }) => event.kind === "invocation.started");
    const cancelled = events.find(
      (event: { kind?: string }) => event.kind === "invocation.cancelled"
    );

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

  it("settles pending method calls as an error from malformed terminal invocation events", async () => {
    const { instance } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", { contextId: "ctx-1", name: "Caller", type: "panel" });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-malformed",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-malformed",
        transportCallId: "transport-malformed",
        turnId: "turn-malformed",
      }
    );

    // The publish is still rejected loudly so the producer sees its bug...
    setRpcCaller(instance, "panel:provider", "panel");
    await expect(
      instance.publish("panel:provider", AGENTIC_EVENT_PAYLOAD_KIND, {
        kind: "invocation.failed",
        actor: { kind: "panel", id: "panel:provider" },
        turnId: "turn-malformed",
        causality: {
          invocationId: "invocation-malformed",
          transportCallId: "transport-malformed",
        },
        // schema rejection fixture: terminalOutcome is intentionally omitted
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          reason: "malformed terminal event",
        },
        createdAt: new Date().toISOString(),
      })
    ).rejects.toThrow(/terminalOutcome/u);

    // Invocation events are display/history only now; malformed terminal logs
    // are rejected but no longer settle method transport.
    const pending = (
      instance as unknown as { sql: { exec: (...args: unknown[]) => { toArray(): unknown[] } } }
    ).sql
      .exec(
        `SELECT transport_call_id FROM pending_calls WHERE transport_call_id = ?`,
        "transport-malformed"
      )
      .toArray();
    expect(pending).toHaveLength(1);
  });

  it("settles pending method calls from submitMethodResult", async () => {
    const { instance } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", { contextId: "ctx-1", name: "Caller", type: "panel" });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-ok",
      "eval",
      { code: "1 + 1" },
      { invocationId: "invocation-ok", transportCallId: "transport-ok", turnId: "turn-ok" }
    );

    setRpcCaller(instance, "panel:provider", "panel");
    await instance.submitMethodResult("panel:provider", "transport-ok", 2, false, {
      invocationId: "invocation-ok",
      turnId: "turn-ok",
      terminalOutcome: "success",
    });

    const pending = (
      instance as unknown as { sql: { exec: (...args: unknown[]) => { toArray(): unknown[] } } }
    ).sql
      .exec(
        `SELECT transport_call_id FROM pending_calls WHERE transport_call_id = ?`,
        "transport-ok"
      )
      .toArray();
    expect(pending).toHaveLength(0);
  });

  it("broadcasts submitted method results as provider-sent method-result envelopes", async () => {
    const emitted: unknown[] = [];
    const { instance } = await createGadBackedChannel({ emitted });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", { contextId: "ctx-1", name: "Caller", type: "panel" });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-envelope",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-envelope",
        transportCallId: "transport-envelope",
        turnId: "turn-envelope",
      }
    );

    setRpcCaller(instance, "panel:provider", "panel");
    await instance.submitMethodResult("panel:provider", "transport-envelope", 2, false, {
      invocationId: "invocation-envelope",
      turnId: "turn-envelope",
      terminalOutcome: "success",
      contentType: "application/json",
      attachments: [{ id: "att-1", data: "AA==", mimeType: "text/plain", size: 1 }],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const methodResult = emitted
      .map((payload) => (payload as { message?: unknown }).message)
      .find(
        (message): message is {
          kind: "method-result";
          callId: string;
          senderId: string;
          contentType?: string;
        } =>
          !!message &&
          typeof message === "object" &&
          (message as { kind?: string }).kind === "method-result"
      );
    expect(methodResult).toMatchObject({
      kind: "method-result",
      callId: "transport-envelope",
      senderId: "panel:provider",
      contentType: "application/json",
    });
    expect(instance.getSettledResult("transport-envelope")).toMatchObject({
      content: 2,
      contentType: "application/json",
      attachmentsReplayable: false,
    });
  });

  it("broadcasts dedicated method-cancel envelopes and counts duplicate terminal drops", async () => {
    const emitted: unknown[] = [];
    const { instance } = await createGadBackedChannel({ emitted });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", { contextId: "ctx-1", name: "Caller", type: "panel" });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-cancel-envelope",
      "eval",
      { code: "await forever()" },
      {
        invocationId: "invocation-cancel-envelope",
        transportCallId: "transport-cancel-envelope",
        turnId: "turn-cancel-envelope",
      }
    );

    await instance.cancelMethodCall("transport-cancel-envelope");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const methodCancel = emitted
      .map((payload) => (payload as { message?: unknown }).message)
      .find(
        (message): message is { kind: "method-cancel"; callId: string; reason?: string } =>
          !!message &&
          typeof message === "object" &&
          (message as { kind?: string }).kind === "method-cancel"
      );
    expect(methodCancel).toMatchObject({
      kind: "method-cancel",
      callId: "transport-cancel-envelope",
      targetId: "panel:provider",
      reason: "cancelled",
    });
    const rpcEmit = (
      instance as unknown as {
        _rpc: { emit: ReturnType<typeof vi.fn> };
      }
    )._rpc.emit;
    const cancelEmitCalls = rpcEmit.mock.calls.filter(
      (call) =>
        call[1] === "channel:message" &&
        ((call[2] as { message?: { kind?: string } }).message?.kind === "method-cancel")
    );
    expect(cancelEmitCalls.map((call) => call[0])).toEqual(["panel:provider"]);

    setRpcCaller(instance, "panel:provider", "panel");
    await expect(
      instance.submitMethodResult("panel:provider", "transport-cancel-envelope", "late", false)
    ).resolves.toEqual({ id: undefined });
    await expect(
      instance.submitMethodProgress("panel:provider", "transport-cancel-envelope", "late progress")
    ).resolves.toBeUndefined();

    setRpcCaller(instance, "panel:intruder", "panel");
    await expect(
      instance.submitMethodResult("panel:intruder", "transport-cancel-envelope", "intrude", false)
    ).rejects.toThrow(/not settled target/u);
    await expect(
      instance.submitMethodProgress("panel:intruder", "transport-cancel-envelope", "intrude")
    ).rejects.toThrow(/not settled target/u);

    const stats = (
      instance as unknown as { getMethodTransportStats(): Record<string, number> }
    ).getMethodTransportStats();
    expect(stats["providerCancelBroadcasts"]).toBe(1);
    expect(stats["resultBroadcasts"]).toBe(1);
    expect(stats["duplicateTerminalDrops"]).toBe(1);
    expect(stats["lateProgressDrops"]).toBe(1);
    expect(stats["rejectedTerminalSubmissions"]).toBe(1);
    expect(stats["rejectedProgressSubmissions"]).toBe(1);
  });

  it("rejects method result and progress submissions from non-target participants", async () => {
    const { instance } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", { contextId: "ctx-1", name: "Caller", type: "panel" });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });
    setRpcCaller(instance, "panel:intruder", "panel");
    await instance.subscribe("panel:intruder", {
      contextId: "ctx-1",
      name: "Intruder",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-guarded",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-guarded",
        transportCallId: "transport-guarded",
        turnId: "turn-guarded",
      }
    );

    setRpcCaller(instance, "panel:intruder", "panel");
    await expect(
      instance.submitMethodResult("panel:intruder", "transport-guarded", 99, false)
    ).rejects.toThrow(/not target/u);
    await expect(
      instance.submitMethodProgress("panel:intruder", "transport-guarded", "still working")
    ).rejects.toThrow(/not target/u);

    const stats = (
      instance as unknown as { getMethodTransportStats(): Record<string, number> }
    ).getMethodTransportStats();
    expect(stats["rejectedTerminalSubmissions"]).toBe(1);
    expect(stats["rejectedProgressSubmissions"]).toBe(1);

    setRpcCaller(instance, "panel:provider", "panel");
    await expect(
      instance.submitMethodResult("panel:provider", "transport-guarded", 2, false, {
        invocationId: "invocation-guarded",
        turnId: "turn-guarded",
      })
    ).resolves.toEqual({ id: expect.any(Number) });
  });

  // Phase 2: the channel DO is the canonical, terminal-once recovery authority.
  it("records a canonical settled result that can be replayed and is terminal-once", async () => {
    const { instance } = await createGadBackedChannel();
    const worker = instance as unknown as {
      handleMethodResult(
        callId: string,
        content: unknown,
        isError: boolean,
        outcome?: string,
        reason?: string
      ): Promise<number | undefined>;
      getSettledResult(callId: string): {
        content: unknown;
        isError: boolean;
        terminalOutcome: string | null;
        terminalReasonCode: string | null;
      } | null;
      getMethodTransportStats(): Record<string, number>;
    };

    // A result with no live pending call is still recorded for replay.
    await worker.handleMethodResult("transport-replay", { value: 42 }, false, "success");
    expect(worker.getSettledResult("transport-replay")).toMatchObject({
      content: { value: 42 },
      isError: false,
      terminalOutcome: "success",
    });

    // Terminal-once: a competing later terminal does NOT overwrite the canonical one.
    await worker.handleMethodResult("transport-replay", { value: 99 }, true, "tool_error");
    expect(worker.getSettledResult("transport-replay")).toMatchObject({
      content: { value: 42 },
      isError: false,
      terminalOutcome: "success",
    });

    // An unsettled call has no canonical record.
    expect(worker.getSettledResult("transport-never")).toBeNull();
    expect(worker.getMethodTransportStats()).toMatchObject({
      settledRecoveryHits: 2,
      duplicateTerminalDrops: 1,
    });
  });

  // Phase 2: a target leaving must record the canonical terminal so a hibernated
  // caller can recover the "abandoned" outcome on wake instead of hanging.
  it("records a settled result when the target leaves before the call completes", async () => {
    const { instance } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", { contextId: "ctx-1", name: "Caller", type: "panel" });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-left",
      "eval",
      { code: "1 + 1" },
      { invocationId: "invocation-left", transportCallId: "transport-left", turnId: "turn-left" }
    );

    const worker = instance as unknown as {
      failPendingCallsTargeting(
        targetId: string,
        reason: "graceful" | "disconnect" | "replaced"
      ): Promise<void>;
      getSettledResult(callId: string): {
        content: unknown;
        isError: boolean;
        terminalOutcome: string | null;
        terminalReasonCode: string | null;
      } | null;
    };
    await worker.failPendingCallsTargeting("panel:provider", "disconnect");

    const settled = worker.getSettledResult("transport-left");
    expect(settled).toMatchObject({
      isError: true,
      terminalOutcome: "abandoned",
      terminalReasonCode: "disconnect",
    });
  });

  // Phase 2: a fork must not inherit the parent's terminal records — otherwise a
  // forked child's agent could reconcile an inherited suspension against a
  // parent-era result and wrongly resume.
  it("clears settled_results on postClone so a fork cannot resurrect parent calls", async () => {
    const parent = await createGadBackedChannel({ channelKey: "channel-parent" });
    const parentWorker = parent.instance as unknown as {
      handleMethodResult(
        callId: string,
        content: unknown,
        isError: boolean,
        outcome?: string
      ): Promise<number | undefined>;
      getSettledResult(callId: string): unknown | null;
    };
    await parentWorker.handleMethodResult("transport-parent", { value: 7 }, false, "success");
    expect(parentWorker.getSettledResult("transport-parent")).not.toBeNull();

    const fork = await createGadBackedChannel({ channelKey: "channel-fork", gad: parent.gad });
    await fork.instance.postClone("channel-parent", 3);

    const forkWorker = fork.instance as unknown as {
      getSettledResult(callId: string): unknown | null;
    };
    expect(forkWorker.getSettledResult("transport-parent")).toBeNull();
  });

  it("settles pending method calls from abandoned method results", async () => {
    const { instance } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", { contextId: "ctx-1", name: "Caller", type: "panel" });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-abandoned",
      "eval",
      { code: "await forever()" },
      {
        invocationId: "invocation-abandoned",
        transportCallId: "transport-abandoned",
        turnId: "turn-abandoned",
      }
    );

    setRpcCaller(instance, "panel:provider", "panel");
    const result = await instance.submitMethodResult(
      "panel:provider",
      "transport-abandoned",
      "runner restarted",
      true,
      {
        invocationId: "invocation-abandoned",
        turnId: "turn-abandoned",
        terminalOutcome: "abandoned",
        terminalReasonCode: "runner_restarted_before_invocation_completed",
      }
    );

    expect(result.id).toBeTypeOf("number");
    const pending = (
      instance as unknown as { sql: { exec: (...args: unknown[]) => { toArray(): unknown[] } } }
    ).sql
      .exec(
        `SELECT transport_call_id FROM pending_calls WHERE transport_call_id = ?`,
        "transport-abandoned"
      )
      .toArray();
    expect(pending).toHaveLength(0);

    const events = (
      await instance.getReplayAfter(0)
    ).logEvents.map((event) => event.payload as { kind?: string; payload?: unknown });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "invocation.abandoned",
          payload: expect.objectContaining({
            terminalOutcome: "abandoned",
            terminalReasonCode: "runner_restarted_before_invocation_completed",
          }),
        }),
      ])
    );
    expect(events.some((event) => event.kind === "invocation.failed")).toBe(false);
  });

  it("preserves cancelled outcome when provider cancellation settles a pending method call", async () => {
    const { instance } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", { contextId: "ctx-1", name: "Caller", type: "panel" });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-cancelled",
      "eval",
      { code: "await forever()" },
      {
        invocationId: "invocation-cancelled",
        transportCallId: "transport-cancelled",
        turnId: "turn-cancelled",
      }
    );

    setRpcCaller(instance, "panel:provider", "panel");
    const result = await instance.submitMethodResult(
      "panel:provider",
      "transport-cancelled",
      "cancelled",
      true,
      {
        invocationId: "invocation-cancelled",
        turnId: "turn-cancelled",
        terminalOutcome: "cancelled",
        terminalReasonCode: "cancelled",
      }
    );

    expect(result.id).toBeTypeOf("number");
    const events = (
      await instance.getReplayAfter(0)
    ).logEvents.map((event) => event.payload as { kind?: string; payload?: unknown });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "invocation.cancelled",
          payload: expect.objectContaining({
            terminalOutcome: "cancelled",
            terminalReasonCode: "cancelled",
          }),
        }),
      ])
    );
    expect(events.some((event) => event.kind === "invocation.failed")).toBe(false);
  });

  it("does not block channel cancellation behind an in-flight DO method call", async () => {
    let resolveMethod!: (value: unknown) => void;
    let resolveMethodStarted!: () => void;
    const methodStarted = new Promise<void>((resolve) => {
      resolveMethodStarted = resolve;
    });
    const methodResult = new Promise<unknown>((resolve) => {
      resolveMethod = resolve;
    });
    let methodStartedRecorded = false;
    const targetPid = "do:workers/agent-worker:AiChatWorker:agent-1";
    const { instance, gad } = await createGadBackedChannel({
      rpcCall: (target, method) => {
        if (target === "main" && method === "workers.resolveDurableObject") return {};
        if (target === targetPid && method === "onChannelEnvelope") return null;
        if (target === targetPid && method === "onMethodCall") {
          if (!methodStartedRecorded) {
            methodStartedRecorded = true;
            resolveMethodStarted();
          }
          return methodResult;
        }
        return undefined;
      },
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", { contextId: "ctx-1", name: "Caller", type: "panel" });
    setRpcCaller(instance, null, null);
    await instance.subscribe(targetPid, {
      contextId: "ctx-1",
      name: "Agent",
      type: "agent",
      handle: "agent",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await expect(
      Promise.race([
        instance
          .callMethod(
            "panel:caller",
            targetPid,
            "transport-do",
            "eval",
            { code: "while (true) {}" },
            {
              invocationId: "invocation-do",
              transportCallId: "transport-do",
              turnId: "turn-do",
            }
          )
          .then(() => "returned"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 25)),
      ])
    ).resolves.toBe("returned");
    await methodStarted;

    await instance.cancelMethodCall("transport-do");
    resolveMethod({ result: { ok: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const events = gad.sql
      .exec(
        `SELECT payload_ref_json FROM channel_envelopes WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND
      )
      .toArray()
      .map((row: Record<string, unknown>) => JSON.parse(row["payload_ref_json"] as string));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "invocation.started",
          causality: { invocationId: "invocation-do", transportCallId: "transport-do" },
        }),
        expect.objectContaining({
          kind: "invocation.cancelled",
          causality: { invocationId: "invocation-do", transportCallId: "transport-do" },
          payload: expect.objectContaining({
            terminalOutcome: "cancelled",
            terminalReasonCode: "cancelled",
          }),
        }),
      ])
    );
    expect(events.some((event: { kind?: string }) => event.kind === "invocation.completed")).toBe(
      false
    );
  });

  it("persists method terminal events even when the caller participant has left", async () => {
    const { instance, gad } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", { contextId: "ctx-1", name: "Caller", type: "panel" });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-left",
      "eval",
      { code: "1 + 1" },
      { invocationId: "invocation-left", transportCallId: "transport-left", turnId: "turn-left" }
    );
    await instance.unsubscribe("panel:caller");

    const resultId = await instance.handleMethodResult("transport-left", { ok: true }, false);

    expect(resultId).toBeTypeOf("number");
    const rows = gad.sql
      .exec(
        `SELECT payload_ref_json FROM channel_envelopes WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND
      )
      .toArray();
    const events = rows.map((row: Record<string, unknown>) =>
      JSON.parse(row["payload_ref_json"] as string)
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "invocation.started",
          turnId: "turn-left",
          causality: { invocationId: "invocation-left", transportCallId: "transport-left" },
        }),
        expect.objectContaining({
          kind: "invocation.completed",
          turnId: "turn-left",
          causality: { invocationId: "invocation-left", transportCallId: "transport-left" },
          payload: expect.objectContaining({
            protocol: AGENTIC_PROTOCOL_VERSION,
            terminalOutcome: "success",
          }),
        }),
      ])
    );
  });

  it("caps oversized method results before publishing terminal invocation events", async () => {
    const { instance, gad, blobs } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", { contextId: "ctx-1", name: "Caller", type: "panel" });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-large",
      "eval",
      { code: "huge()" },
      { invocationId: "invocation-large", transportCallId: "transport-large", turnId: "turn-large" }
    );

    await instance.handleMethodResult("transport-large", { text: "x".repeat(80 * 1024) }, false);

    const rows = gad.sql
      .exec(
        `SELECT payload_ref_json FROM channel_envelopes WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND
      )
      .toArray();
    const events = rows.map((row: Record<string, unknown>) =>
      JSON.parse(row["payload_ref_json"] as string)
    );
    const completed = events.find(
      (event: { kind?: string; causality?: { invocationId?: string } }) =>
        event.kind === "invocation.completed" &&
        event.causality?.invocationId === "invocation-large"
    );
    const resultRef = completed?.payload?.result as { digest?: string } | undefined;
    expect(resultRef).toMatchObject({
      protocol: "natstack.blob-ref.v1",
      digest: expect.any(String),
      encoding: "json",
    });
    const cappedResult = JSON.parse(blobs.get(resultRef!.digest!)!);
    expect(cappedResult).toMatchObject({
      omitted: true,
      reason: "method result exceeds durable inline budget",
      method: "eval",
      transportCallId: "transport-large",
      stored: expect.objectContaining({ digest: expect.any(String), encoding: "json" }),
    });
    const settled = instance.getSettledResult("transport-large");
    expect(settled?.content).toMatchObject({
      omitted: true,
      reason: "method result exceeds durable inline budget",
      method: "eval",
      transportCallId: "transport-large",
      stored: expect.objectContaining({ digest: expect.any(String), encoding: "json" }),
    });
    expect(JSON.stringify(completed).length).toBeLessThan(1_000);
  });

  it("hydrates the message type registry from GAD instead of trusting a partial local cache", async () => {
    const { instance, gad } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });

    (
      instance as unknown as {
        cacheMessageTypeMutation: (
          seq: number,
          mutation: {
            kind: "upsertMessageType";
            typeId: string;
            row: { displayMode: "row"; source: { type: "code"; code: string } };
          }
        ) => void;
      }
    ).cacheMessageTypeMutation(1, {
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

    await expect(
      instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, {
        kind: "messageType.registered",
        actor: { kind: "panel", id: "panel:user" },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          typeId: "broken",
          displayMode: "bad",
          source: { type: "code", code: "export default function Broken() { return null; }" },
        },
        createdAt: new Date().toISOString(),
      })
    ).rejects.toThrow(/Invalid registry payload/);

    const rows = gad.sql
      .exec(
        `SELECT payload_ref_json FROM channel_envelopes WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND
      )
      .toArray();
    expect(rows.map((row) => JSON.parse(row["payload_ref_json"] as string).kind)).not.toContain(
      "messageType.registered"
    );
  });
});
