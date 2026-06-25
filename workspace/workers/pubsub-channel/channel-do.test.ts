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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setRpcCaller(
  instance: PubSubChannel,
  callerId: string | null,
  callerKind: string | null,
  callerPanelId?: string | null
): void {
  (instance as unknown as { _currentRpcCallerId: string | null })._currentRpcCallerId = callerId;
  (instance as unknown as { _currentRpcCallerKind: string | null })._currentRpcCallerKind =
    callerKind;
  (instance as unknown as { _currentRpcCallerPanelId: string | null })._currentRpcCallerPanelId =
    callerPanelId ?? null;
}

function agenticEvent(kind = "message.completed") {
  return {
    kind,
    actor: { kind: "user", id: "panel:user" },
    causality: { messageId: "msg-1" },
    payload: {
      protocol: "agentic.trajectory.v1",
      role: "user",
      blocks: [{ blockId: "msg-1:block:0", type: "text", content: "hello" }],
      outcome: "completed",
    },
    createdAt: new Date().toISOString(),
  };
}

function messageTypeRegisteredEvent(
  typeId: string,
  code = "export default function App() { return null; }"
) {
  // Direct-to-GAD seeds must arrive storage-encoded (the channel DO's encode
  // path spills payload.source before appending; GAD validates at append).
  const encoded = JSON.stringify({ type: "code", code });
  return {
    kind: "messageType.registered",
    actor: { kind: "panel", id: "panel:user" },
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      typeId,
      displayMode: "row",
      source: {
        protocol: "natstack.blob-ref.v1",
        digest: `source-${typeId}`,
        size: encoded.length,
        encoding: "json",
        originalBytes: encoded.length,
      },
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
  // Inject a mock RPC client. The DO base now holds a ConnectionlessRpcClient
  // ({ client, respond, deliver }) behind the `rpc` getter; pre-setting
  // `_connectionless` short-circuits the real (network) client construction.
  const mockClient = {
    emit: vi.fn(async (_target: string, _event: string, payload: unknown) => {
      options.emitted?.push(payload);
    }),
    call: vi.fn(async (target: string, method: string, args: unknown[]) => {
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
      if (
        target === "main" &&
        (method === "workspace-state.alarmSet" || method === "workspace-state.alarmClear")
      ) {
        // DurableBase persists alarm metadata through main; these channel tests
        // exercise channel behavior, so acknowledge the lifecycle write.
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
    expose: () => {},
    exposeAll: () => {},
    on: () => () => {},
  };
  (
    channel.instance as unknown as {
      _connectionless: { client: unknown; respond: unknown; deliver: unknown };
    }
  )._connectionless = {
    client: mockClient,
    respond: async () => null,
    deliver: () => {},
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
        `SELECT seq, envelope_id, payload_kind, payload_ref_json, annotations_json
       FROM log_events ORDER BY seq ASC`
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
    expect(JSON.parse(rows[1]!["annotations_json"] as string)).toMatchObject({
      metadata: { name: "User" },
    });
  });

  it("allows a panel caller to use its stable slot participant id", async () => {
    const { instance } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:nav-current", "panel", "panel:slot-stable");

    await expect(
      instance.subscribe("panel:slot-stable", { contextId: "ctx-1", name: "User", type: "panel" })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      instance.publish("panel:slot-stable", AGENTIC_EVENT_PAYLOAD_KIND, agenticEvent())
    ).resolves.toMatchObject({ id: expect.any(Number) });
    await expect(
      instance.publish("panel:other", AGENTIC_EVENT_PAYLOAD_KIND, agenticEvent())
    ).rejects.toThrow(
      "publish: participant panel:other cannot be used by caller panel:nav-current"
    );
  });

  it("rejects arbitrary participant labels for durable-object callers", async () => {
    const { instance } = await createGadBackedChannel({
      rpcCall: (target, method) => {
        if (target === "main" && method === "workers.resolveDurableObject") return {};
        return undefined;
      },
    });
    const evalDoId = "do:natstack/internal:EvalDO:eval-1";
    const arbitraryLabel = "headless-diagnose-123";
    setRpcCaller(instance, evalDoId, "durable-object");

    await expect(
      instance.subscribe(arbitraryLabel, {
        contextId: "ctx-1",
        name: "Eval client",
        type: "client",
      })
    ).rejects.toThrow(`Participant ${arbitraryLabel} cannot be subscribed by caller ${evalDoId}`);
    await expect(instance.unsubscribe(arbitraryLabel)).rejects.toThrow(
      `unsubscribe: participant ${arbitraryLabel} cannot be used by caller ${evalDoId}`
    );
    await expect(
      instance.publish(arbitraryLabel, AGENTIC_EVENT_PAYLOAD_KIND, agenticEvent())
    ).rejects.toThrow(
      `publish: participant ${arbitraryLabel} cannot be used by caller ${evalDoId}`
    );

    await expect(
      instance.subscribe(evalDoId, {
        contextId: "ctx-1",
        name: "Eval client",
        type: "client",
      })
    ).resolves.toMatchObject({ ok: true });
  });

  it("dedupes concurrent publishes with the same idempotency key before append settles", async () => {
    const appendEntered = deferred();
    const releaseAppend = deferred();
    let appendCalls = 0;
    let blockAppend = false;
    const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "workspace-gad" });
    const { instance } = await createGadBackedChannel({
      gad,
      rpcCall: async (target, method, args) => {
        if (
          target === "do:workers/gad-store:GadWorkspaceDO:workspace-gad" &&
          method === "appendLogEvent" &&
          blockAppend
        ) {
          appendCalls += 1;
          appendEntered.resolve();
          await releaseAppend.promise;
          const callable = gad.instance as unknown as Record<
            string,
            (...methodArgs: unknown[]) => unknown
          >;
          return await callable[method]!(...args);
        }
        return undefined;
      },
    });
    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });
    blockAppend = true;

    const first = instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, agenticEvent(), {
      idempotencyKey: "initial-prompt:chat-race",
    });
    await appendEntered.promise;
    const second = instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, agenticEvent(), {
      idempotencyKey: "initial-prompt:chat-race",
    });
    await Promise.resolve();

    expect(appendCalls).toBe(1);
    releaseAppend.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([{ id: 2 }, { id: 2 }]);

    const rows = gad.sql.exec(`SELECT seq FROM log_events ORDER BY seq ASC`).toArray();
    expect(rows).toHaveLength(2);
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
        `SELECT actor_json, payload_ref_json, annotations_json
         FROM log_events ORDER BY seq ASC`
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
    expect(JSON.parse(rows[1]!["annotations_json"] as string)).toMatchObject({
      metadata: { methods: [{ name: "eval" }] },
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
        // A real agent opts into structured onChannelEnvelope delivery; its
        // missing-DO eviction is driven by that delivery's fatal code.
        receivesChannelEnvelopes: true,
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

  it("delivers onChannelEnvelope only to DO participants that opted in (receivesChannelEnvelopes)", async () => {
    const envelopeTargets: string[] = [];
    const agentDoId = "do:workers/agent-worker:AiChatWorker:agent-x";
    const clientDoId = "do:natstack/internal:EvalDO:client-x";
    const { instance } = await createGadBackedChannel({
      // resolveDurableObject is an existence check (result ignored); onChannelEnvelope
      // is the structured delivery we record per target.
      rpcCall: async (target, method) => {
        if (target === "main" && method === "workers.resolveDurableObject") {
          return {
            kind: "durable-object",
            source: "s",
            className: "C",
            objectKey: "k",
            targetId: target,
          };
        }
        if (method === "onChannelEnvelope") {
          envelopeTargets.push(target);
          return null;
        }
        return undefined;
      },
    });

    // An agent vessel opts into the structured delivery; an rpc-style DO client
    // (the eval running system tests, via connectViaRpc) does NOT.
    setRpcCaller(instance, agentDoId, "durable-object");
    await instance.subscribe(agentDoId, {
      contextId: "ctx-1",
      name: "Agent",
      type: "agent",
      receivesChannelEnvelopes: true,
    });
    setRpcCaller(instance, clientDoId, "durable-object");
    await instance.subscribe(clientDoId, {
      contextId: "ctx-1",
      name: "Eval client",
      type: "client",
    });

    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });
    await instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, agenticEvent());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(envelopeTargets).toContain(agentDoId);
    expect(envelopeTargets).not.toContain(clientDoId);
  });

  it("reports an envelope-only schema", async () => {
    const { instance } = await createGadBackedChannel();
    setRpcCaller(instance, "server:test", "server");

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
    await instance.subscribe(targetPid, {
      contextId: "ctx-1",
      name: "AI Chat",
      type: "agent",
      // Agent vessels implement onMethodCall and opt into structured delivery — the flag that now
      // gates the synchronous deliverDoMethodCall dispatch (vs RPC-style DO clients).
      receivesChannelEnvelopes: true,
    });

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
        `SELECT payload_ref_json FROM log_events WHERE payload_kind = ? ORDER BY seq ASC`,
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
          payload: expect.objectContaining({ terminalOutcome: "success" }),
        }),
      ])
    );
  });

  it("routes method calls to an RPC-style DO client (eval HeadlessSession) via the broadcast, not onMethodCall", async () => {
    // The eval's connectViaRpc / HeadlessSession must subscribe under the EvalDO's own DO id (a
    // do-ref shape ⇒ transport classifies as "do"), but it has NO onMethodCall handler — it settles
    // method calls the RPC way: the broadcast `started` (delivered as channel:message to every
    // participant) + submitMethodResult. It must NOT be routed through deliverDoMethodCall, which
    // would dispatch onMethodCall to a missing handler and never settle the call (the redelivery echo).
    const evalPid = "do:natstack/internal:EvalDO:eval-1";
    const rpcCalls: Array<{ target: string; method: string }> = [];
    const { instance, gad } = await createGadBackedChannel({
      rpcCall: (target, method) => {
        if (target === "main" && method === "workers.resolveDurableObject") return {};
        rpcCalls.push({ target, method });
        return undefined;
      },
    });

    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });
    // RPC-style DO client: subscribes as its own DO id, and (unlike an agent vessel) does NOT set
    // receivesChannelEnvelopes — it has no onMethodCall / onChannelEnvelope handler.
    setRpcCaller(instance, evalPid, "durable-object");
    await instance.subscribe(evalPid, { contextId: "ctx-1", name: "Eval client", type: "client" });

    setRpcCaller(instance, "panel:user", "panel");
    await instance.callMethod(
      "panel:user",
      evalPid,
      "title-call",
      "set_title",
      { title: "Hello" },
      { invocationId: "title-inv", transportCallId: "title-call" }
    );

    // The bug: callMethod must NOT dispatch onMethodCall to a client that can't handle it.
    expect(rpcCalls.some((c) => c.target === evalPid && c.method === "onMethodCall")).toBe(false);

    // The client receives the journaled+broadcast `started` and replies via submitMethodResult, which
    // settles the call cleanly (terminal in the log ⇒ no echo).
    setRpcCaller(instance, evalPid, "durable-object");
    await instance.submitMethodResult(evalPid, "title-call", { ok: true }, false, {
      invocationId: "title-inv",
    });

    const events = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND
      )
      .toArray()
      .map((row: Record<string, unknown>) => JSON.parse(row["payload_ref_json"] as string));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "invocation.started",
          causality: { invocationId: "title-inv", transportCallId: "title-call" },
        }),
        expect.objectContaining({
          kind: "invocation.completed",
          causality: { invocationId: "title-inv", transportCallId: "title-call" },
          payload: expect.objectContaining({ terminalOutcome: "success" }),
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
    // No-copy fork: the child sees the parent prefix verbatim, including the
    // presence envelope, with the original sequence numbers.
    expect(replay.logEvents.map((event) => event.id)).toEqual([1, 2, 3]);
    const messages = replay.logEvents.filter((event) => event.type === AGENTIC_EVENT_PAYLOAD_KIND);
    expect(
      messages.map(
        (event) => (event.payload as { causality: { messageId: string } }).causality.messageId
      )
    ).toEqual(["msg-1", "msg-2"]);
    expect(replay.ready).toMatchObject({
      totalCount: 3,
      envelopeCount: 3,
      firstEnvelopeSeq: 1,
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
        `SELECT payload_ref_json FROM log_events WHERE payload_kind = ? ORDER BY seq ASC`,
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

  it("reconstructs pending_calls during cancelMethodCall before dropping (cache-cold)", async () => {
    const { instance, sql, gad } = await createGadBackedChannel();

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
      "transport-cancel-cold",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-cancel-cold",
        transportCallId: "transport-cancel-cold",
        turnId: "turn-cancel-cold",
      }
    );

    // Simulate a cache-cold row (post-eviction): the durable started survives,
    // the SQLite cache row is gone. A cancel must reconcile and still settle.
    sql.exec(`DELETE FROM pending_calls WHERE transport_call_id = ?`, "transport-cancel-cold");

    await instance.cancelMethodCall("transport-cancel-cold");

    const cancelled = gad.sql
      .exec(
        `SELECT envelope_id FROM log_events WHERE envelope_id = ?`,
        "terminal:transport-cancel-cold"
      )
      .toArray();
    expect(cancelled).toHaveLength(1);
  });

  it("records a deadline_at on a timed call so the sweep can settle a stuck target", async () => {
    const { instance, sql } = await createGadBackedChannel();

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
      "transport-timed",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-timed",
        transportCallId: "transport-timed",
        turnId: "turn-timed",
        timeoutMs: 60_000,
      }
    );

    const row = sql
      .exec(`SELECT deadline_at FROM pending_calls WHERE transport_call_id = ?`, "transport-timed")
      .toArray()[0] as { deadline_at: number | null } | undefined;
    expect(row?.deadline_at).toEqual(expect.any(Number));
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

  it("reconstructs pending_calls during submitMethodResult before dropping a result", async () => {
    const { instance, sql, gad } = await createGadBackedChannel();

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
      "transport-cache-race",
      "eval",
      { code: "1 + 1" },
      {
        invocationId: "invocation-cache-race",
        transportCallId: "transport-cache-race",
        turnId: "turn-cache-race",
      }
    );

    sql.exec(`DELETE FROM pending_calls WHERE transport_call_id = ?`, "transport-cache-race");

    setRpcCaller(instance, "panel:provider", "panel");
    const result = await instance.submitMethodResult(
      "panel:provider",
      "transport-cache-race",
      2,
      false,
      {
        invocationId: "invocation-cache-race",
        turnId: "turn-cache-race",
        terminalOutcome: "success",
      }
    );

    expect(result.id).toEqual(expect.any(Number));
    expect(
      sql
        .exec(
          `SELECT transport_call_id FROM pending_calls WHERE transport_call_id = ?`,
          "transport-cache-race"
        )
        .toArray()
    ).toHaveLength(0);
    const terminals = gad.sql
      .exec(
        `SELECT envelope_id FROM log_events WHERE envelope_id = ?`,
        "terminal:transport-cache-race"
      )
      .toArray();
    expect(terminals).toHaveLength(1);
  });

  it("reconstructs agent-loop channel calls whose transport id lives in payload.transport", async () => {
    const { instance, sql, gad } = await createGadBackedChannel();

    setRpcCaller(instance, "do:agent", "durable-object");
    await instance.subscribe("do:agent", { contextId: "ctx-1", name: "Agent", type: "agent" });
    setRpcCaller(instance, "do:eval", "durable-object");
    await instance.subscribe("do:eval", {
      contextId: "ctx-1",
      name: "Headless",
      type: "headless",
    });

    await gad.instance.appendLogEvent({
      logId: "channel-1",
      head: "main",
      logKind: "channel",
      events: [
        {
          envelopeId: "invocation-agent-loop",
          actor: { kind: "agent", id: "do:agent", participantId: "do:agent" },
          payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: {
            kind: "invocation.started",
            actor: { kind: "agent", id: "do:agent", participantId: "do:agent" },
            turnId: "turn-agent-loop",
            causality: {
              invocationId: "invocation-agent-loop",
              modelToolCallId: "invocation-agent-loop",
            },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              name: "set_title",
              invocationType: "panel",
              request: {
                protocol: "natstack.blob-ref.v1",
                digest: "request-agent-loop",
                size: 35,
                encoding: "json",
                originalBytes: 35,
              },
              transport: {
                kind: "channel",
                channelId: "channel-1",
                target: { kind: "user", id: "do:eval", participantId: "do:eval" },
                transportCallId: "transport-agent-loop",
              },
              userVisible: true,
            },
            createdAt: "2026-06-25T13:28:08.115Z",
          },
        },
      ],
    });

    const { inserted } = await instance.reconcilePendingCalls(true);
    expect(inserted).toBe(1);
    expect(
      sql
        .exec(
          `SELECT transport_call_id, invocation_id, method FROM pending_calls WHERE transport_call_id = ?`,
          "transport-agent-loop"
        )
        .toArray()
    ).toEqual([
      expect.objectContaining({
        transport_call_id: "transport-agent-loop",
        invocation_id: "invocation-agent-loop",
        method: "set_title",
      }),
    ]);

    setRpcCaller(instance, "do:eval", "durable-object");
    const result = await instance.submitMethodResult(
      "do:eval",
      "transport-agent-loop",
      {
        ok: true,
      },
      false,
      {
        invocationId: "invocation-agent-loop",
        turnId: "turn-agent-loop",
        terminalOutcome: "success",
      }
    );

    expect(result).toEqual({ id: expect.any(Number) });
    expect(
      gad.sql
        .exec(`SELECT envelope_id FROM log_events WHERE envelope_id = ?`, "invocation-agent-loop")
        .toArray()
    ).toHaveLength(1);
    expect(
      gad.sql
        .exec(
          `SELECT envelope_id FROM log_events WHERE envelope_id = ?`,
          "terminal:transport-agent-loop"
        )
        .toArray()
    ).toHaveLength(1);
  });

  it("recovers a lost call: appends a terminal when a result has no pending row and no started", async () => {
    const emitted: unknown[] = [];
    const { instance, gad } = await createGadBackedChannel({ emitted });

    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    // No call was ever journaled for this transportCallId (cache-cold / lost
    // started record): reconcile finds nothing and there is no durable terminal.
    // Dropping the result would strand the caller forever — its parked
    // invocation only settles on a terminal carrying the same invocationId. So
    // the channel must ROOT the method and append a real terminal instead of a
    // silent no-op.
    setRpcCaller(instance, "panel:provider", "panel");
    const result = await instance.submitMethodResult(
      "panel:provider",
      "transport-lost-record",
      42,
      false,
      { invocationId: "invocation-lost-record", turnId: "turn-lost-record" }
    );

    // The submitter still gets an observability signal, but it is a RECOVERY,
    // not a drop — a real terminal seq id is returned.
    expect(result).toMatchObject({ id: expect.any(Number), dropped: false, recovered: true });

    // A durable terminal event now exists, keyed on the transportCallId and
    // carrying the caller's invocationId (what routeInvocationTerminal matches).
    const terminalRow = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE envelope_id = ?`,
        "terminal:transport-lost-record"
      )
      .toArray();
    expect(terminalRow).toHaveLength(1);
    expect(JSON.parse(terminalRow[0]!["payload_ref_json"] as string)).toMatchObject({
      kind: "invocation.completed",
      causality: {
        invocationId: "invocation-lost-record",
        transportCallId: "transport-lost-record",
      },
      payload: { result: 42, terminalOutcome: "success" },
    });

    // The synthetic `started` root was appended too (fold invariant: every
    // terminal is paired with a started carrying the same invocation id).
    const rootRow = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE envelope_id = ?`,
        "invocation-lost-record"
      )
      .toArray();
    expect(rootRow).toHaveLength(1);
    expect(JSON.parse(rootRow[0]!["payload_ref_json"] as string)).toMatchObject({
      kind: "invocation.started",
      causality: {
        invocationId: "invocation-lost-record",
        transportCallId: "transport-lost-record",
      },
    });

    // The terminal is broadcast so subscribers (the caller) actually receive it.
    // The wire shape is { channelId, message: { kind: "log", event } } — the
    // invocation payload lives at message.event.payload.
    const broadcastCompleted = emitted
      .map(
        (payload) =>
          (
            payload as {
              message?: {
                event?: {
                  payload?: { kind?: string; causality?: { transportCallId?: string } };
                };
              };
            }
          ).message?.event?.payload
      )
      .find(
        (agentic) =>
          agentic?.kind === "invocation.completed" &&
          agentic?.causality?.transportCallId === "transport-lost-record"
      );
    expect(broadcastCompleted).toBeDefined();
  });

  it("recovers a lost call as invocation.failed when the submission isError", async () => {
    const { instance, gad } = await createGadBackedChannel();

    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    setRpcCaller(instance, "panel:provider", "panel");
    const result = await instance.submitMethodResult(
      "panel:provider",
      "transport-lost-error",
      "boom",
      true,
      { invocationId: "invocation-lost-error" }
    );
    expect(result).toMatchObject({ id: expect.any(Number), dropped: false, recovered: true });

    const terminal = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE envelope_id = ?`,
        "terminal:transport-lost-error"
      )
      .toArray();
    expect(terminal).toHaveLength(1);
    expect(JSON.parse(terminal[0]!["payload_ref_json"] as string)).toMatchObject({
      kind: "invocation.failed",
      causality: { invocationId: "invocation-lost-error" },
      payload: { terminalOutcome: "tool_error" },
    });
  });

  it("settles via the NORMAL path when a result races an in-flight started append (no recovery)", async () => {
    // Root-cause durability case: callMethod journals the `started` to GAD
    // (a cross-DO RPC) BEFORE inserting the cache row. If a submitMethodResult
    // for the same transportCallId arrives WHILE that append is in flight, the
    // call exists in neither the cache (insertRow hasn't run) nor a committed
    // durable log a forced reconcile can re-derive it from. Without the
    // start-journaling barrier the submit fell through to settleMissingCall —
    // synthesizing a SECOND (synthetic) started + terminal instead of settling
    // against the canonical one (the observed "recovered a lost call" log).
    //
    // With the barrier, submit waits for the canonical started to commit, then
    // settles via the normal pending path: exactly one started, one terminal,
    // and result.recovered is never set.
    const blockStarted = deferred();
    let blockedOnce = false;
    const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "workspace-gad" });
    const { instance } = await createGadBackedChannel({
      gad,
      rpcCall: async (target, method, args) => {
        if (
          target === "do:workers/gad-store:GadWorkspaceDO:workspace-gad" &&
          method === "appendLogEvent"
        ) {
          const event = (args[0] as { events?: Array<{ payloadKind?: string; payload?: unknown }> })
            ?.events?.[0];
          const payload = event?.payload as { kind?: string } | undefined;
          if (
            !blockedOnce &&
            event?.payloadKind === AGENTIC_EVENT_PAYLOAD_KIND &&
            payload?.kind === "invocation.started"
          ) {
            blockedOnce = true;
            // Hold the started append open, then let the real append proceed
            // (returning undefined falls through to the default gad handler).
            await blockStarted.promise;
          }
        }
        return undefined;
      },
    });

    setRpcCaller(instance, "panel:caller", "panel");
    await instance.subscribe("panel:caller", { contextId: "ctx-1", name: "Caller", type: "panel" });
    setRpcCaller(instance, "panel:provider", "panel");
    await instance.subscribe("panel:provider", {
      contextId: "ctx-1",
      name: "Provider",
      type: "panel",
    });

    // Fire callMethod; it parks inside the blocked `started` append.
    setRpcCaller(instance, "panel:caller", "panel");
    const callPromise = instance.callMethod(
      "panel:caller",
      "panel:provider",
      "transport-start-race",
      "eval",
      { code: "1 + 1" },
      { invocationId: "invocation-start-race", transportCallId: "transport-start-race" }
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The result arrives while the start is mid-append. It must NOT recover —
    // it parks on the in-flight barrier until the canonical started commits.
    setRpcCaller(instance, "panel:provider", "panel");
    const submitPromise = instance.submitMethodResult(
      "panel:provider",
      "transport-start-race",
      99,
      false,
      { invocationId: "invocation-start-race" }
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Release the started append; both the call and the parked submit drain.
    blockStarted.resolve();
    const result = await submitPromise;
    await callPromise;

    // Settled via the NORMAL path — no lost-call recovery.
    expect(result.id).toEqual(expect.any(Number));
    expect(result.recovered).toBeUndefined();

    // Exactly one canonical started (envelopeId = invocationId) and one
    // terminal; no synthetic root was appended.
    const started = gad.sql
      .exec(`SELECT envelope_id FROM log_events WHERE envelope_id = ?`, "invocation-start-race")
      .toArray();
    expect(started).toHaveLength(1);
    const startedEvents = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND
      )
      .toArray()
      .map((row: Record<string, unknown>) => JSON.parse(row["payload_ref_json"] as string));
    expect(startedEvents.filter((e) => e.kind === "invocation.started")).toHaveLength(1);
    expect(startedEvents.filter((e) => e.kind === "invocation.completed")).toHaveLength(1);
    const terminal = gad.sql
      .exec(
        `SELECT envelope_id FROM log_events WHERE envelope_id = ?`,
        "terminal:transport-start-race"
      )
      .toArray();
    expect(terminal).toHaveLength(1);

    // The cache row is consumed.
    expect(
      (
        instance as unknown as { sql: { exec: (...args: unknown[]) => { toArray(): unknown[] } } }
      ).sql
        .exec(
          `SELECT transport_call_id FROM pending_calls WHERE transport_call_id = ?`,
          "transport-start-race"
        )
        .toArray()
    ).toHaveLength(0);
  });

  it("appends a durable invocation.completed terminal (no method-result envelope)", async () => {
    const emitted: unknown[] = [];
    const { instance, gad } = await createGadBackedChannel({ emitted });

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
      attachments: [{ id: "att-1", data: "AA==", mimeType: "text/plain", size: 1 }],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // No method-* wire envelope is emitted anymore.
    const methodEnvelope = emitted
      .map((payload) => (payload as { message?: { kind?: string } }).message)
      .find((message) => typeof message?.kind === "string" && message.kind.startsWith("method-"));
    expect(methodEnvelope).toBeUndefined();

    // The canonical terminal is a durable invocation.completed log event,
    // carrying the result and the attachment on the envelope.
    const envelopes = gad.sql
      .exec(`SELECT payload_ref_json, annotations_json FROM log_events ORDER BY seq ASC`)
      .toArray();
    const completed = envelopes.find(
      (row) =>
        (JSON.parse(row["payload_ref_json"] as string) as { kind?: string }).kind ===
        "invocation.completed"
    );
    expect(completed).toBeDefined();
    expect(JSON.parse(completed!["payload_ref_json"] as string)).toMatchObject({
      kind: "invocation.completed",
      causality: { transportCallId: "transport-envelope" },
      payload: { result: 2, terminalOutcome: "success" },
    });
    expect(JSON.parse(completed!["annotations_json"] as string)).toMatchObject({
      attachments: [{ id: "att-1", mimeType: "text/plain" }],
    });
  });

  it("appends a durable invocation.cancelled on cancel and drops late submits", async () => {
    const emitted: unknown[] = [];
    const { instance, gad } = await createGadBackedChannel({ emitted });

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

    // No method-* wire envelope — provider abort derives from invocation.cancelled.
    const methodEnvelope = emitted
      .map((payload) => (payload as { message?: { kind?: string } }).message)
      .find((message) => typeof message?.kind === "string" && message.kind.startsWith("method-"));
    expect(methodEnvelope).toBeUndefined();

    // Durable invocation.cancelled terminal.
    const cancelled = gad.sql
      .exec(`SELECT payload_ref_json FROM log_events ORDER BY seq ASC`)
      .toArray()
      .map(
        (row) =>
          JSON.parse(row["payload_ref_json"] as string) as {
            kind?: string;
            causality?: { transportCallId?: string };
          }
      )
      .find((ev) => ev.kind === "invocation.cancelled");
    expect(cancelled).toMatchObject({
      kind: "invocation.cancelled",
      causality: { transportCallId: "transport-cancel-envelope" },
      payload: expect.objectContaining({ terminalOutcome: "cancelled" }),
    });

    // The call is consumed: a late terminal is idempotently acknowledged with
    // the existing terminal id, and late progress is a no-op.
    setRpcCaller(instance, "panel:provider", "panel");
    const terminalCountBefore = gad.sql
      .exec(`SELECT COUNT(*) AS cnt FROM log_events WHERE envelope_id LIKE 'terminal:%'`)
      .toArray()[0]?.["cnt"];
    await expect(
      instance.submitMethodResult("panel:provider", "transport-cancel-envelope", "late", false)
    ).resolves.toEqual({ id: expect.any(Number) });
    expect(
      gad.sql
        .exec(`SELECT COUNT(*) AS cnt FROM log_events WHERE envelope_id LIKE 'terminal:%'`)
        .toArray()[0]?.["cnt"]
    ).toBe(terminalCountBefore);
    await expect(
      instance.submitMethodProgress("panel:provider", "transport-cancel-envelope", "late progress")
    ).resolves.toBeUndefined();
  });

  it("appends a durable invocation.output for a pending call and no-ops once consumed", async () => {
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
      "transport-output",
      "eval",
      { code: "stream()" },
      {
        invocationId: "invocation-output",
        transportCallId: "transport-output",
        turnId: "turn-output",
      }
    );

    setRpcCaller(instance, "panel:provider", "panel");
    await instance.submitMethodProgress("panel:provider", "transport-output", "chunk-1");

    const output = gad.sql
      .exec(`SELECT payload_ref_json FROM log_events ORDER BY seq ASC`)
      .toArray()
      .map(
        (row) =>
          JSON.parse(row["payload_ref_json"] as string) as {
            kind?: string;
            causality?: { transportCallId?: string };
            payload?: { output?: unknown };
          }
      )
      .find((ev) => ev.kind === "invocation.output");
    // Progress chunks are class-REFERENCE (storage classes: fold-opaque
    // streaming bulk is ALWAYS a ref, even when tiny — one code path).
    expect(output).toMatchObject({
      kind: "invocation.output",
      causality: { transportCallId: "transport-output" },
      payload: { output: { protocol: "natstack.blob-ref.v1", encoding: "text" } },
    });

    // Consume the call, then a late progress chunk is a quiet no-op (not appended).
    await instance.submitMethodResult("panel:provider", "transport-output", "done", false);
    await expect(
      instance.submitMethodProgress("panel:provider", "transport-output", "chunk-2")
    ).resolves.toBeUndefined();
    const outputs = gad.sql
      .exec(`SELECT payload_ref_json FROM log_events ORDER BY seq ASC`)
      .toArray()
      .map((row) => JSON.parse(row["payload_ref_json"] as string) as { kind?: string })
      .filter((ev) => ev.kind === "invocation.output");
    expect(outputs).toHaveLength(1);
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

    setRpcCaller(instance, "panel:provider", "panel");
    await expect(
      instance.submitMethodResult("panel:provider", "transport-guarded", 2, false, {
        invocationId: "invocation-guarded",
        turnId: "turn-guarded",
      })
    ).resolves.toEqual({ id: expect.any(Number) });
  });

  // A terminal with no live pending call (already consumed / unknown) is dropped:
  // the canonical terminal is already in the durable log from the original settle.
  it("drops a method result with no live pending call", async () => {
    const { instance, gad } = await createGadBackedChannel();
    const worker = instance as unknown as {
      handleMethodResult(
        callId: string,
        content: unknown,
        isError: boolean,
        outcome?: string,
        reason?: string
      ): Promise<number | undefined>;
    };

    const id = await worker.handleMethodResult("transport-orphan", { value: 42 }, false, "success");
    expect(id).toBeUndefined();

    // No invocation.* terminal is appended for an unknown call.
    const orphan = gad.sql
      .exec(`SELECT payload_ref_json FROM log_events ORDER BY seq ASC`)
      .toArray()
      .map(
        (row) =>
          JSON.parse(row["payload_ref_json"] as string) as {
            causality?: { transportCallId?: string };
          }
      )
      .find((ev) => ev.causality?.transportCallId === "transport-orphan");
    expect(orphan).toBeUndefined();
  });

  // A target leaving appends a durable invocation.abandoned terminal so a
  // hibernated caller recovers the outcome from replay instead of hanging.
  it("appends a durable invocation.abandoned terminal when the target leaves", async () => {
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

    const worker = instance as unknown as {
      failPendingCallsTargeting(
        targetId: string,
        reason: "graceful" | "disconnect" | "replaced"
      ): Promise<void>;
    };
    await worker.failPendingCallsTargeting("panel:provider", "disconnect");

    const abandoned = gad.sql
      .exec(`SELECT payload_ref_json FROM log_events ORDER BY seq ASC`)
      .toArray()
      .map(
        (row) =>
          JSON.parse(row["payload_ref_json"] as string) as {
            kind?: string;
            causality?: { transportCallId?: string };
          }
      )
      .find(
        (ev) =>
          ev.kind === "invocation.abandoned" && ev.causality?.transportCallId === "transport-left"
      );
    expect(abandoned).toBeDefined();
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

    const events = (await instance.getReplayAfter(0)).logEvents.map(
      (event) => event.payload as { kind?: string; payload?: unknown }
    );
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
    const events = (await instance.getReplayAfter(0)).logEvents.map(
      (event) => event.payload as { kind?: string; payload?: unknown }
    );
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
      // Agent vessel: implements onMethodCall + opts into structured delivery (gates deliverDoMethodCall).
      receivesChannelEnvelopes: true,
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
        `SELECT payload_ref_json FROM log_events WHERE payload_kind = ? ORDER BY seq ASC`,
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
        `SELECT payload_ref_json FROM log_events WHERE payload_kind = ? ORDER BY seq ASC`,
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

  it("spills oversized method results to a blob ref on the durable terminal", async () => {
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
        `SELECT payload_ref_json FROM log_events WHERE payload_kind = ? ORDER BY seq ASC`,
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
    // The channel-log store's generic encoder spills the oversized result to a
    // blob ref on the durable event; the blob holds the real content (no
    // method-specific "capped/omitted" wrapper).
    const resultRef = completed?.payload?.result as { digest?: string } | undefined;
    expect(resultRef).toMatchObject({
      protocol: "natstack.blob-ref.v1",
      digest: expect.any(String),
      encoding: "json",
    });
    const storedResult = JSON.parse(blobs.get(resultRef!.digest!)!);
    expect(storedResult).toMatchObject({ text: "x".repeat(80 * 1024) });
    expect(JSON.stringify(completed).length).toBeLessThan(1_000);
  });

  it("reads message types directly from GAD", async () => {
    const { instance, gad } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });

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
    ).rejects.toThrow(/payload invalid/u);

    const rows = gad.sql
      .exec(
        `SELECT payload_ref_json FROM log_events WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND
      )
      .toArray();
    expect(rows.map((row) => JSON.parse(row["payload_ref_json"] as string).kind)).not.toContain(
      "messageType.registered"
    );
  });
});

describe("PubSubChannel policy folds and cache amnesia (WS2)", () => {
  function agentCompleted(messageId: string, extraCausality: Record<string, unknown> = {}) {
    return {
      kind: "message.completed",
      actor: { kind: "agent", id: "agent:one" },
      causality: { messageId, ...extraCausality },
      payload: {
        protocol: "agentic.trajectory.v1",
        role: "assistant",
        blocks: [{ blockId: `${messageId}:block:0`, type: "text", content: "reply" }],
        outcome: "completed",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
  }

  it("stamps agentHops into annotations without mutating the payload", async () => {
    const { instance, gad } = await createGadBackedChannel();
    setRpcCaller(instance, "agent:one", "server");
    await instance.subscribe("agent:one", { contextId: "ctx-1", name: "Agent", type: "agent" });

    await instance.publish("agent:one", AGENTIC_EVENT_PAYLOAD_KIND, agentCompleted("msg-a1"));
    await instance.publish("agent:one", AGENTIC_EVENT_PAYLOAD_KIND, agentCompleted("msg-a2"));

    const rows = gad.sql
      .exec(
        `SELECT payload_ref_json, annotations_json FROM log_events
         WHERE payload_kind = ? ORDER BY seq ASC`,
        AGENTIC_EVENT_PAYLOAD_KIND
      )
      .toArray();
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!["annotations_json"] as string)).toMatchObject({ agentHops: 1 });
    // agent:one's 2nd consecutive message (same author, one turn) is NOT a new hop → still 1.
    expect(JSON.parse(rows[1]!["annotations_json"] as string)).toMatchObject({ agentHops: 1 });
    // the payload itself is never mutated by the transport
    for (const row of rows) {
      const payload = JSON.parse(row["payload_ref_json"] as string) as {
        causality?: { agentHops?: number };
      };
      expect(payload.causality?.agentHops).toBeUndefined();
    }

    // explicit caller-computed hops win
    await instance.publish(
      "agent:one",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agentCompleted("msg-a3", { agentHops: 9 })
    );
    const explicit = gad.sql
      .exec(
        `SELECT annotations_json FROM log_events WHERE payload_kind = ? ORDER BY seq DESC LIMIT 1`,
        AGENTIC_EVENT_PAYLOAD_KIND
      )
      .toArray();
    expect(JSON.parse(explicit[0]!["annotations_json"] as string)).toMatchObject({ agentHops: 9 });
  });

  it("rebuilds conversation policy state across a fork (the fork-wipe bug fix)", async () => {
    const parent = await createGadBackedChannel({ channelKey: "channel-policy-parent" });
    setRpcCaller(parent.instance, "agent:one", "server");
    await parent.instance.subscribe("agent:one", {
      contextId: "ctx-1",
      name: "Agent",
      type: "agent",
    });
    await parent.instance.publish(
      "agent:one",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agentCompleted("msg-p1")
    );
    await parent.instance.publish(
      "agent:one",
      AGENTIC_EVENT_PAYLOAD_KIND,
      agentCompleted("msg-p2")
    );
    const parentState = await parent.instance.getPolicyState();
    expect(parentState.state).toMatchObject({ agentStreak: 1, lastCompletedSender: "agent:one" });

    const fork = await createGadBackedChannel({
      channelKey: "channel-policy-fork",
      gad: parent.gad,
    });
    await fork.instance.postClone("channel-policy-parent", 3);

    // conversation state SURVIVES the fork — rebuilt by replaying the lineage
    const forkState = await fork.instance.getPolicyState();
    expect(forkState.state).toMatchObject({ agentStreak: 1, lastCompletedSender: "agent:one" });

    setRpcCaller(fork.instance, "agent:one", "server");
    await fork.instance.subscribe("agent:one", {
      contextId: "ctx-1",
      name: "Agent",
      type: "agent",
    });
    await fork.instance.publish("agent:one", AGENTIC_EVENT_PAYLOAD_KIND, agentCompleted("msg-f1"));
    const stamped = parent.gad.sql
      .exec(
        `SELECT annotations_json FROM log_events
         WHERE log_id = 'channel-policy-fork' AND payload_kind = ? ORDER BY seq DESC LIMIT 1`,
        AGENTIC_EVENT_PAYLOAD_KIND
      )
      .toArray();
    // msg-f1 is agent:one again (same author across the fork) → still 1 hop, not 3.
    expect(JSON.parse(stamped[0]!["annotations_json"] as string)).toMatchObject({ agentHops: 1 });
  });

  it("dedupes idempotent publishes durably across a dedup_keys wipe", async () => {
    const { instance, gad, sql } = await createGadBackedChannel();
    setRpcCaller(instance, "panel:user", "panel");
    await instance.subscribe("panel:user", { contextId: "ctx-1", name: "User", type: "panel" });

    const payload = agenticEvent();
    const first = await instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, payload, {
      idempotencyKey: "durable-key-1",
    });

    // wipe the latency cache — the durable dedupe is the ik:{key} envelope id
    sql.exec(`DELETE FROM dedup_keys`);

    const second = await instance.publish("panel:user", AGENTIC_EVENT_PAYLOAD_KIND, payload, {
      idempotencyKey: "durable-key-1",
    });
    expect(second.id).toBe(first.id);
    const rows = gad.sql
      .exec(`SELECT envelope_id FROM log_events WHERE envelope_id = ?`, "ik:durable-key-1")
      .toArray();
    expect(rows).toHaveLength(1);
  });

  it("treats duplicate pending callMethod as a durable redrive", async () => {
    const { instance, gad, sql } = await createGadBackedChannel();
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
      "call-redrive",
      "eval",
      { code: "first" },
      { invocationId: "inv-redrive", transportCallId: "call-redrive", turnId: "turn-redrive" }
    );
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "call-redrive",
      "mutated_eval",
      { code: "second" },
      { invocationId: "inv-redrive", transportCallId: "call-redrive", turnId: "turn-redrive" }
    );

    const starts = gad.sql
      .exec(`SELECT envelope_id FROM log_events WHERE envelope_id = ?`, "inv-redrive")
      .toArray();
    expect(starts).toHaveLength(1);

    const pending = sql
      .exec(`SELECT method FROM pending_calls WHERE transport_call_id = ?`, "call-redrive")
      .toArray();
    expect(pending).toEqual([expect.objectContaining({ method: "eval" })]);
  });

  it("reconstructs pending_calls from the log after cache amnesia", async () => {
    const { instance, sql, gad } = await createGadBackedChannel();
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
      "call-keep",
      "slow_method",
      { input: 1 },
      { invocationId: "inv-keep", transportCallId: "call-keep", turnId: "turn-1", timeoutMs: 60000 }
    );
    await instance.callMethod(
      "panel:caller",
      "panel:provider",
      "call-settle",
      "fast_method",
      { input: 2 },
      { invocationId: "inv-settle", transportCallId: "call-settle" }
    );

    setRpcCaller(instance, "panel:provider", "panel");
    await instance.submitMethodResult("panel:provider", "call-settle", { ok: true }, false);

    // P3: derived state is deletable at any time
    sql.exec(`DELETE FROM pending_calls`);
    const { inserted } = await instance.reconcilePendingCalls(true);
    expect(inserted).toBe(1);

    const rows = sql.exec(`SELECT * FROM pending_calls`).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      transport_call_id: "call-keep",
      invocation_id: "inv-keep",
      caller_id: "panel:caller",
      target_id: "panel:provider",
      method: "slow_method",
      turn_id: "turn-1",
    });
    // args come back in journal form — $.payload.request is blob-spilled by
    // the storage boundary, so the rebuilt row carries the blob ref
    expect(JSON.parse(rows[0]!["args"] as string)).toMatchObject({
      protocol: "natstack.blob-ref.v1",
    });
    expect(Number(rows[0]!["deadline_at"])).toBeGreaterThan(0);

    // the rebuilt row settles normally, with the deterministic terminal id
    await instance.submitMethodResult("panel:provider", "call-keep", { ok: 1 }, false);
    const terminals = gad.sql
      .exec(`SELECT envelope_id FROM log_events WHERE envelope_id LIKE 'terminal:%'`)
      .toArray();
    expect(terminals.map((row) => row["envelope_id"])).toEqual(
      expect.arrayContaining(["terminal:call-settle", "terminal:call-keep"])
    );
    expect(sql.exec(`SELECT COUNT(*) AS cnt FROM pending_calls`).toArray()[0]?.["cnt"]).toBe(0);
  });

  it("does not busy-loop the alarm on a long-running pending call (CH-4)", async () => {
    const { instance, sql } = await createGadBackedChannel();
    const internal = instance as unknown as {
      nextPendingRedeliveryAt(now: number): number | null;
      getStateValue(key: string): string | null;
      setStateValue(key: string, value: string): void;
    };

    const now = Date.now();
    // A pending call created 60s ago (handler is genuinely slow, deadline 5min).
    const createdAt = now - 60_000;
    sql.exec(
      `INSERT INTO pending_calls (transport_call_id, invocation_id, turn_id, caller_id,
        target_id, method, args, created_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "tc-slow",
      "inv-slow",
      null,
      "agent:self",
      "panel:user",
      "longMethod",
      null,
      createdAt,
      now + 5 * 60_000
    );

    // First redelivery is anchored to creation (it may be in the past — that's
    // fine, it fires once); critically it is NOT pinned to created_at+10s
    // forever.
    const first = internal.nextPendingRedeliveryAt(now);
    expect(first).toBe(createdAt + 10_000);

    // Simulate a sweep advancing the marker (what alarm() does).
    internal.setStateValue("pendingRedeliverySweptAt", String(now));

    // The next deadline is now anchored to the LAST sweep + interval — a real
    // future time, so scheduleNextAlarm cannot clamp to now+100ms repeatedly.
    const second = internal.nextPendingRedeliveryAt(now);
    expect(second).toBe(now + 15_000);
    expect(second!).toBeGreaterThan(now);
  });
});
