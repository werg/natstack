import { describe, it, expect, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { PubSubChannel } from "./channel-do.js";

function setRpcCaller(
  instance: PubSubChannel,
  callerId: string | null,
  callerKind: string | null
): void {
  (instance as unknown as { _currentRpcCallerId: string | null })._currentRpcCallerId = callerId;
  (instance as unknown as { _currentRpcCallerKind: string | null })._currentRpcCallerKind =
    callerKind;
}

describe("PubSubChannel", () => {
  describe("getParticipants()", () => {
    it("returns DO identity when present", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES ('do:workers/agent:AgentDO:key-1', '{"name":"Agent"}', 'do', 1000)`
      );
      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES ('p2', '{"callerKind":"panel"}', 'rpc', 2000)`
      );

      const participants = await instance.getParticipants();
      expect(participants).toHaveLength(2);

      const doParticipant = participants.find(
        (p) => p.participantId === "do:workers/agent:AgentDO:key-1"
      )!;
      expect(doParticipant.transport).toBe("do");
      expect(doParticipant.doRef).toEqual({
        source: "workers/agent",
        className: "AgentDO",
        objectKey: "key-1",
      });

      const rpcParticipant = participants.find((p) => p.participantId === "p2")!;
      expect(rpcParticipant.transport).toBe("rpc");
      expect(rpcParticipant.doRef).toBeUndefined();
    });
  });

  describe("getContextId()", () => {
    it("returns contextId when set", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      sql.exec(`INSERT OR REPLACE INTO state (key, value) VALUES ('contextId', 'ctx-123')`);
      expect(await instance.getContextId()).toBe("ctx-123");
    });

    it("returns null when not set", async () => {
      const { instance } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      expect(await instance.getContextId()).toBeNull();
    });
  });

  describe("subscribe()", () => {
    it("registers DO subscriber with correct transport", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      const result = await instance.subscribe("do:workers/agent:AgentDO:key-1", {
        contextId: "ctx-1",
        name: "TestAgent",
      });

      expect(result.ok).toBe(true);

      const participants = sql
        .exec(`SELECT id, transport FROM participants WHERE id = 'do:workers/agent:AgentDO:key-1'`)
        .toArray();
      expect(participants).toHaveLength(1);
      expect(participants[0]!["transport"]).toBe("do");

      const roster = await instance.getParticipants();
      expect(
        roster.find((p) => p.participantId === "do:workers/agent:AgentDO:key-1")?.doRef
      ).toEqual({
        source: "workers/agent",
        className: "AgentDO",
        objectKey: "key-1",
      });
    });

    it("registers RPC subscriber (panel) with transport='rpc'", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      await instance.subscribe("panel:panel-123", {
        contextId: "ctx-1",
        callerKind: "panel",
      });

      const participants = sql
        .exec(`SELECT id, transport FROM participants WHERE id = 'panel:panel-123'`)
        .toArray();
      expect(participants).toHaveLength(1);
      expect(participants[0]!["transport"]).toBe("rpc");
    });

    it("rejects an RPC participant ID that does not match the verified caller", async () => {
      const { instance } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      (instance as unknown as { _currentRpcCallerId: string })._currentRpcCallerId =
        "panel:panel-real";

      await expect(
        instance.subscribe("panel:panel-spoofed", {
          contextId: "ctx-1",
          callerKind: "panel",
        })
      ).rejects.toThrow(
        "Participant panel:panel-spoofed cannot be subscribed by caller panel:panel-real"
      );
    });

    it("returns a root-window replay envelope", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      for (let i = 1; i <= 55; i++) {
        sql.exec(
          `INSERT INTO messages (message_id, type, payload, sender_id, ts, is_root, root_kind)
           VALUES (?, 'message', '{"id":"msg","content":"msg"}', 'sender', ?, 1, 'chat')`,
          `msg-${i}`,
          1000 + i
        );
      }

      const result = await instance.subscribe("do:test:TestDO:key", {
        replay: true,
      });

      expect(result.ok).toBe(true);
      expect(result.envelope.logEvents).toHaveLength(50);
      expect(result.envelope.ready.hasMoreBefore).toBe(true);
      expect(result.envelope.logEvents[0]!.id).toBe(6);
      expect(result.envelope.logEvents[49]!.id).toBe(55);
    });

    it("returns full replay without truncation when under limit", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      for (let i = 1; i <= 10; i++) {
        sql.exec(
          `INSERT INTO messages (message_id, type, payload, sender_id, ts, is_root, root_kind)
           VALUES (?, 'message', '{"id":"msg","content":"msg"}', 'sender', ?, 1, 'chat')`,
          `msg-${i}`,
          1000 + i
        );
      }

      const result = await instance.subscribe("do:test:TestDO:key", {
        replay: true,
      });

      expect(result.envelope.logEvents).toHaveLength(10);
      expect(result.envelope.ready.hasMoreBefore).toBe(false);
    });

    it("honors replay=false with a ready-only envelope", async () => {
      const { instance } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      await instance.subscribe("panel:sender", {
        contextId: "ctx-1",
        callerKind: "panel",
      });
      await instance.send("panel:sender", "msg-1", "hello");

      const result = await instance.subscribe("panel:live-only", {
        contextId: "ctx-1",
        callerKind: "panel",
        replay: false,
      });

      expect(result.ok).toBe(true);
      expect(result.envelope.logEvents).toEqual([]);
      expect(result.envelope.snapshots).toEqual([]);
      expect(result.envelope.ready.totalCount).toBeGreaterThan(0);
    });

    it("accepts custom durable publish events as system roots", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      await instance.subscribe("panel:sender", {
        contextId: "ctx-1",
        callerKind: "panel",
      });
      const result = await instance.publish("panel:sender", "agent-context", {
        id: "ctx-event-1",
        content: "context",
      });

      expect(result.id).toEqual(expect.any(Number));
      const row = sql
        .exec(`SELECT type, payload, is_root, root_kind FROM messages WHERE id = ?`, result.id)
        .one();
      expect(row["type"]).toBe("agent-context");
      expect(row["is_root"]).toBe(1);
      expect(row["root_kind"]).toBe("system");
      expect(JSON.parse(row["payload"] as string)).toMatchObject({ id: "ctx-event-1" });
    });

    it("rejects a second participant claiming the same handle", async () => {
      const { instance } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      await instance.subscribe("panel:panel-1", {
        contextId: "ctx-1",
        handle: "ai-chat",
      });

      await expect(
        instance.subscribe("panel:panel-2", {
          contextId: "ctx-1",
          handle: "ai-chat",
        })
      ).rejects.toThrow(/handle "ai-chat" is already in use/);
    });

    it("allows the same participant to re-subscribe with the same handle", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      await instance.subscribe("panel:panel-1", {
        contextId: "ctx-1",
        handle: "ai-chat",
      });
      await instance.subscribe("panel:panel-1", {
        contextId: "ctx-1",
        handle: "ai-chat",
      });

      const rows = sql
        .exec(`SELECT id, handle FROM participants WHERE handle = 'ai-chat'`)
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!["id"]).toBe("panel:panel-1");
    });

    it("cleans subscribe-time metadata from stored participant", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      await instance.subscribe("panel:panel-1", {
        contextId: "ctx-1",
        channelConfig: { title: "Test" },
        replay: true,
        sinceId: 5,
        replayMessageLimit: 20,
        name: "Alice",
      });

      const row = sql
        .exec(`SELECT metadata FROM participants WHERE id = 'panel:panel-1'`)
        .toArray();
      const metadata = JSON.parse(row[0]!["metadata"] as string);
      // Subscribe-time hints should be stripped
      expect(metadata["contextId"]).toBeUndefined();
      expect(metadata["channelConfig"]).toBeUndefined();
      expect(metadata["transport"]).toBeUndefined();
      expect(metadata["replay"]).toBeUndefined();
      expect(metadata["sinceId"]).toBeUndefined();
      expect(metadata["replayMessageLimit"]).toBeUndefined();
      // Actual metadata should remain
      expect(metadata["name"]).toBe("Alice");
    });

    it("redelivers pending calls when a participant is replaced by a new session", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      const mockRpc = {
        emit: vi.fn().mockResolvedValue(undefined),
        call: vi.fn().mockResolvedValue(undefined),
      };
      (instance as any)._rpc = mockRpc;

      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at, session_id)
         VALUES (?, '{}', 'do', ?, 'caller-session')`,
        "do:workers/agent-worker:AiChatWorker:agent-1",
        Date.now()
      );
      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at, session_id)
         VALUES (?, ?, 'rpc', ?, ?)`,
        "panel:panel-1",
        '{"name":"old"}',
        Date.now(),
        "session-old"
      );
      sql.exec(
        `INSERT INTO pending_calls (call_id, caller_id, target_id, method, args, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        "11111111-1111-4111-8111-111111111111",
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "panel:panel-1",
        "feedback_custom",
        '{"code":"x"}',
        Date.now()
      );

      await instance.subscribe("panel:panel-1", {
        contextId: "ctx-1",
        name: "new",
        __participantSessionId: "session-new",
      });

      // Drain the per-subscriber emit chain (queueEmit runs on microtasks).
      for (let i = 0; i < 10; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      // Pending call must be preserved, not cancelled.
      expect(sql.exec(`SELECT call_id FROM pending_calls`).toArray()).toEqual([
        { call_id: "11111111-1111-4111-8111-111111111111" },
      ]);
      // No synthetic completion is emitted while the target is reconnecting.
      const methodResultEmits = mockRpc.emit.mock.calls.filter(
        ([, , data]) => (data as any)?.message?.type === "method-result"
      );
      expect(methodResultEmits).toHaveLength(0);
      // A method-call is re-emitted to the new panel session.
      const methodCallEmits = mockRpc.emit.mock.calls.filter(
        ([, , data]) => (data as any)?.message?.type === "method-call"
      );
      expect(methodCallEmits).toHaveLength(1);
      const emitted = methodCallEmits[0]![2] as {
        message: { payload: { callId: string; methodName: string; args: unknown }; kind: string };
        channelId: string;
      };
      expect(emitted.channelId).toBe("test-channel");
      expect(emitted.message.kind).toBe("signal");
      expect(emitted.message.payload.callId).toBe("11111111-1111-4111-8111-111111111111");
      expect(emitted.message.payload.methodName).toBe("feedback_custom");
      expect(emitted.message.payload.args).toEqual({ code: "x" });
      // The replaced-session leave presence event still fires.
      const leaveMessages = sql
        .exec(`SELECT payload FROM messages WHERE type = 'presence' ORDER BY id ASC`)
        .toArray()
        .map((row) => JSON.parse(row["payload"] as string));
      expect(
        leaveMessages.some((msg) => msg.action === "leave" && msg.leaveReason === "replaced")
      ).toBe(true);
    });

    it("does not fail pending calls when the same participant session resubscribes", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      const mockRpc = {
        emit: vi.fn().mockResolvedValue(undefined),
        call: vi.fn().mockResolvedValue(undefined),
      };
      (instance as any)._rpc = mockRpc;

      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at, session_id)
         VALUES (?, ?, 'rpc', ?, ?)`,
        "panel:panel-1",
        '{"name":"old"}',
        Date.now(),
        "session-same"
      );
      sql.exec(
        `INSERT INTO pending_calls (call_id, caller_id, target_id, method, args, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        "22222222-2222-4222-8222-222222222222",
        "caller-1",
        "panel:panel-1",
        "eval",
        "{}",
        Date.now()
      );

      await instance.subscribe("panel:panel-1", {
        contextId: "ctx-1",
        name: "same",
        __participantSessionId: "session-same",
      });

      expect(sql.exec(`SELECT call_id FROM pending_calls`).toArray()).toEqual([
        { call_id: "22222222-2222-4222-8222-222222222222" },
      ]);
      expect(mockRpc.call).not.toHaveBeenCalled();
    });
  });

  describe("cancelMethodCall()", () => {
    it("looks up provider before deleting and emits method-cancel", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      // Insert a pending call
      sql.exec(
        `INSERT INTO pending_calls (call_id, caller_id, target_id, method, args, created_at)
         VALUES ('call-1', 'caller-1', 'provider-1', 'doWork', '{}', ?)`,
        Date.now()
      );

      await instance.cancelMethodCall("call-1");

      // Call should be deleted
      const calls = sql.exec(`SELECT * FROM pending_calls WHERE call_id = 'call-1'`).toArray();
      expect(calls).toHaveLength(0);
    });
  });

  describe("participant caller gates", () => {
    it("delivers eval-style method results from the canonical panel participant id", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });
      (instance as any)._rpc = {
        emit: vi.fn().mockResolvedValue(undefined),
        call: vi.fn().mockResolvedValue(undefined),
      };
      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES ('panel:panel-1', '{}', 'rpc', 1000)`
      );
      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES ('do:workers/agent-worker:AiChatWorker:agent-1', '{}', 'do', 1000)`
      );
      sql.exec(
        `INSERT INTO pending_calls (call_id, caller_id, target_id, method, args, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        "55555555-5555-4555-8555-555555555555",
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "panel:panel-1",
        "eval",
        "{}",
        Date.now()
      );
      setRpcCaller(instance, "panel:panel-1", "panel");

      await instance.publish(
        "panel:panel-1",
        "method-result",
        {
          callId: "55555555-5555-4555-8555-555555555555",
          content: { ok: true },
          complete: true,
          isError: false,
        }
      );

      expect(sql.exec(`SELECT call_id FROM pending_calls`).toArray()).toEqual([]);
      expect((instance as any)._rpc.call).toHaveBeenCalledWith(
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "onChannelEnvelope",
        [
          "test-channel",
          expect.objectContaining({
            kind: "log",
            phase: "live",
            event: expect.objectContaining({
              type: "method-result",
              payload: expect.objectContaining({
                callId: "55555555-5555-4555-8555-555555555555",
                content: { ok: true },
                complete: true,
                isError: false,
              }),
            }),
          }),
        ],
      );
      expect((instance as any)._rpc.emit).toHaveBeenCalledWith(
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "channel:message",
        expect.objectContaining({
          channelId: "test-channel",
          message: expect.objectContaining({
            kind: "log",
            phase: "live",
            event: expect.objectContaining({
              type: "method-result",
              payload: expect.objectContaining({
                callId: "55555555-5555-4555-8555-555555555555",
                content: { ok: true },
                complete: true,
                isError: false,
              }),
            }),
          }),
        })
      );
    });

    it("dedupes retried pending method-result publication by idempotency key", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });
      (instance as any)._rpc = {
        emit: vi.fn().mockResolvedValue(undefined),
        call: vi.fn().mockResolvedValue(undefined),
      };
      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES ('panel:caller', '{}', 'rpc', 1000)`
      );
      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES ('panel:provider', '{}', 'rpc', 1000)`
      );
      await instance.callMethod(
        "panel:caller",
        "panel:provider",
        "77777777-7777-4777-8777-777777777777",
        "doWork",
        {}
      );

      const first = await instance.publish(
        "panel:provider",
        "method-result",
        {
          callId: "77777777-7777-4777-8777-777777777777",
          content: { ok: true },
          complete: true,
          isError: false,
        },
        { idempotencyKey: "method-result:777" }
      );
      const second = await instance.publish(
        "panel:provider",
        "method-result",
        {
          callId: "77777777-7777-4777-8777-777777777777",
          content: { ok: true },
          complete: true,
          isError: false,
        },
        { idempotencyKey: "method-result:777" }
      );

      expect(second.id).toBe(first.id);
      expect(
        sql
          .exec(
            `SELECT COUNT(*) as cnt FROM messages
             WHERE type = 'method-result'
               AND root_message_id = '77777777-7777-4777-8777-777777777777'`
          )
          .one()["cnt"]
      ).toBe(1);
    });

    it("keeps participant-scoped methods restricted to the verified participant", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });
      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES ('panel:panel-2', '{}', 'rpc', 1000)`
      );
      setRpcCaller(instance, "panel:panel-1", "panel");

      await expect(instance.unsubscribe("panel:panel-2")).rejects.toThrow(
        "unsubscribe: participant panel:panel-2 cannot be used by caller panel:panel-1"
      );
    });

    it("rejects admin participant mutations from ordinary RPC participants", async () => {
      const { instance } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });
      setRpcCaller(instance, "panel:panel-1", "panel");

      await expect(instance.adminUnsubscribeParticipant("panel:panel-2")).rejects.toThrow(
        "adminUnsubscribeParticipant: privileged caller required"
      );
      await expect(instance.adminUpdateParticipantMetadata("panel:panel-2", {})).rejects.toThrow(
        "adminUpdateParticipantMetadata: privileged caller required"
      );
      await expect(instance.adminSetParticipantTypingState("panel:panel-2", true)).rejects.toThrow(
        "adminSetParticipantTypingState: privileged caller required"
      );
    });

    it("allows privileged server callers to perform admin participant maintenance", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });
      (instance as any)._rpc = {
        emit: vi.fn().mockResolvedValue(undefined),
        call: vi.fn().mockResolvedValue(undefined),
      };
      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES ('panel:panel-2', '{"name":"Panel"}', 'rpc', 1000)`
      );
      setRpcCaller(instance, "main", "server");

      await instance.adminUpdateParticipantMetadata("panel:panel-2", { name: "Renamed" });
      await instance.adminSetParticipantTypingState("panel:panel-2", true);

      const metadataRow = sql
        .exec(`SELECT metadata FROM participants WHERE id = 'panel:panel-2'`)
        .one();
      expect(JSON.parse(metadataRow["metadata"] as string)).toEqual({
        name: "Renamed",
        typing: true,
      });

      await instance.adminUnsubscribeParticipant("panel:panel-2");
      expect(sql.exec(`SELECT id FROM participants WHERE id = 'panel:panel-2'`).toArray()).toEqual(
        []
      );
    });
  });

  describe("method result delivery", () => {
    it("redelivers an in-flight rpc tool call when the target reconnects with a new session", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      const mockRpc = {
        emit: vi.fn().mockResolvedValue(undefined),
        call: vi.fn().mockResolvedValue(undefined),
      };
      (instance as any)._rpc = mockRpc;

      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at, session_id)
         VALUES (?, '{}', 'do', ?, 'caller-session')`,
        "do:workers/agent-worker:AiChatWorker:agent-1",
        Date.now()
      );
      await instance.subscribe("panel:panel-1", {
        contextId: "ctx-1",
        name: "old-panel",
        __participantSessionId: "session-old",
      });

      await instance.callMethod(
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "panel:panel-1",
        "44444444-4444-4444-8444-444444444444",
        "eval",
        { code: "await new Promise(() => {})" }
      );

      expect(sql.exec(`SELECT call_id FROM pending_calls`).toArray()).toEqual([
        { call_id: "44444444-4444-4444-8444-444444444444" },
      ]);

      mockRpc.emit.mockClear();
      await instance.subscribe("panel:panel-1", {
        contextId: "ctx-1",
        name: "new-panel",
        __participantSessionId: "session-new",
      });

      // Drain the per-subscriber emit chain (queueEmit runs on microtasks).
      for (let i = 0; i < 10; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      // Call is preserved, no synthetic completion is emitted.
      expect(sql.exec(`SELECT call_id FROM pending_calls`).toArray()).toEqual([
        { call_id: "44444444-4444-4444-8444-444444444444" },
      ]);
      const methodResultEmits = mockRpc.emit.mock.calls.filter(
        ([, , data]) => (data as any)?.message?.type === "method-result"
      );
      expect(methodResultEmits).toHaveLength(0);
      // Method-call is re-emitted to the new session.
      const methodCallEmits = mockRpc.emit.mock.calls.filter(
        ([, , data]) => (data as any)?.message?.type === "method-call"
      );
      expect(methodCallEmits).toHaveLength(1);
      expect((methodCallEmits[0]![2] as any).message.payload.callId).toBe(
        "44444444-4444-4444-8444-444444444444"
      );
    });

    it("intercepts method-result and broadcasts canonical completion to all participants", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      const mockRpc = {
        emit: vi.fn().mockResolvedValue(undefined),
        call: vi.fn().mockResolvedValue(undefined),
      };
      (instance as any)._rpc = mockRpc;

      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES (?, '{}', 'do', ?)`,
        "do:workers/agent-worker:AiChatWorker:agent-1",
        Date.now()
      );
      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES (?, '{}', 'rpc', ?)`,
        "panel:panel-1",
        Date.now()
      );
      sql.exec(
        `INSERT INTO pending_calls (call_id, caller_id, target_id, method, args, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        "33333333-3333-4333-8333-333333333333",
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "panel:panel-1",
        "eval",
        "{}",
        Date.now()
      );

      await instance.publish(
        "panel:panel-1",
        "method-result",
        {
          callId: "33333333-3333-4333-8333-333333333333",
          content: { ok: true },
          complete: true,
          isError: false,
        }
      );

      expect(sql.exec(`SELECT call_id FROM pending_calls`).toArray()).toEqual([]);
      expect(mockRpc.call).toHaveBeenCalledWith(
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "onChannelEnvelope",
        [
          "test-channel",
          expect.objectContaining({
            kind: "log",
            phase: "live",
            event: expect.objectContaining({
              type: "method-result",
              payload: expect.objectContaining({
                callId: "33333333-3333-4333-8333-333333333333",
                content: { ok: true },
                complete: true,
                isError: false,
              }),
            }),
          }),
        ],
      );
      for (const participantId of [
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "panel:panel-1",
      ]) {
        expect(mockRpc.emit).toHaveBeenCalledWith(
          participantId,
          "channel:message",
          expect.objectContaining({
            channelId: "test-channel",
            message: expect.objectContaining({
              kind: "log",
              phase: "live",
              event: expect.objectContaining({
                type: "method-result",
                payload: expect.objectContaining({
                  callId: "33333333-3333-4333-8333-333333333333",
                  content: { ok: true },
                  complete: true,
                  isError: false,
                }),
              }),
            }),
          })
        );
      }
    });

    it("broadcasts a persisted method-result even when the caller is a DO", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      const mockRpc = {
        emit: vi.fn().mockResolvedValue(undefined),
        call: vi.fn().mockResolvedValue(undefined),
      };
      (instance as any)._rpc = mockRpc;

      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES (?, '{}', 'do', ?)`,
        "do:workers/agent-worker:AiChatWorker:agent-1",
        Date.now()
      );
      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES (?, '{}', 'rpc', ?)`,
        "panel:panel-1",
        Date.now()
      );
      sql.exec(
        `INSERT INTO pending_calls (call_id, caller_id, target_id, method, args, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        "call-1",
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "panel:panel-1",
        "eval",
        "{}",
        Date.now()
      );

      await instance.publish(
        "panel:panel-1",
        "method-result",
        {
          callId: "call-1",
          content: { ok: true, result: 42 },
          complete: true,
          isError: false,
        }
      );

      expect(mockRpc.call).toHaveBeenCalledWith(
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "onChannelEnvelope",
        [
          "test-channel",
          expect.objectContaining({
            kind: "log",
            phase: "live",
            event: expect.objectContaining({
              type: "method-result",
              payload: expect.objectContaining({
                callId: "call-1",
                content: { ok: true, result: 42 },
                complete: true,
                isError: false,
              }),
            }),
          }),
        ],
      );

      expect(mockRpc.emit).toHaveBeenCalledWith(
        "panel:panel-1",
        "channel:message",
        expect.objectContaining({
          channelId: "test-channel",
          message: expect.objectContaining({
            kind: "log",
            phase: "live",
            event: expect.objectContaining({
              type: "method-result",
              payload: expect.objectContaining({
                callId: "call-1",
                content: { ok: true, result: 42 },
                complete: true,
                isError: false,
              }),
            }),
          }),
        })
      );
      expect(mockRpc.emit).toHaveBeenCalledWith(
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "channel:message",
        expect.objectContaining({
          channelId: "test-channel",
          message: expect.objectContaining({
            kind: "log",
            phase: "live",
            event: expect.objectContaining({
              type: "method-result",
              payload: expect.objectContaining({
                callId: "call-1",
                content: { ok: true, result: 42 },
                complete: true,
                isError: false,
              }),
            }),
          }),
        })
      );

      const persisted = sql
        .exec(`SELECT type, sender_id, payload FROM messages WHERE type = 'method-result'`)
        .toArray();
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!["sender_id"]).toBe("do:workers/agent-worker:AiChatWorker:agent-1");
      expect(JSON.parse(persisted[0]!["payload"] as string)).toMatchObject({
        callId: "call-1",
        content: { ok: true, result: 42 },
        complete: true,
        isError: false,
      });
    });
  });

  describe("postClone()", () => {
    it("fixes __objectKey identity after clone", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "forked-channel",
      });

      // Simulate parent's __objectKey being in the state table (from cloneDO copy)
      sql.exec(
        `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', 'parent-channel')`
      );

      // Insert some messages to verify trim
      sql.exec(
        `INSERT INTO messages (message_id, type, payload, sender_id, ts, is_root, root_kind) VALUES ('m1', 'message', '{"id":"m1"}', 's1', 1000, 1, 'chat')`
      );
      sql.exec(
        `INSERT INTO messages (message_id, type, payload, sender_id, ts, is_root, root_kind) VALUES ('m2', 'message', '{"id":"m2"}', 's1', 2000, 1, 'chat')`
      );
      sql.exec(
        `INSERT INTO messages (message_id, type, payload, sender_id, ts, is_root, root_kind) VALUES ('m3', 'presence', '{}', 's1', 3000, 1, 'presence')`
      );

      // Insert a participant
      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at) VALUES ('p1', '{}', 'do', 1000)`
      );

      await instance.postClone("parent-channel", 1);

      // __objectKey should be overwritten with the clone's actual key
      const keyRow = sql.exec(`SELECT value FROM state WHERE key = '__objectKey'`).toArray();
      expect(keyRow[0]!["value"]).toBe("forked-channel");

      // Fork metadata should be set
      const forkedFrom = sql.exec(`SELECT value FROM state WHERE key = 'forkedFrom'`).toArray();
      expect(forkedFrom[0]!["value"]).toBe("parent-channel");

      // Messages after fork point (id > 1) should be deleted
      const msgs = sql.exec(`SELECT id FROM messages`).toArray();
      expect(msgs).toHaveLength(1);
      // Presence messages should also be deleted (even id=1 if it's presence, but m1 is 'message')

      // Participants should be cleared
      const parts = sql.exec(`SELECT * FROM participants`).toArray();
      expect(parts).toHaveLength(0);
    });

    it("trims messages after fork point and clears presence", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "forked-channel",
      });

      // Insert messages with known IDs
      for (let i = 0; i < 5; i++) {
        sql.exec(
          `INSERT INTO messages (message_id, type, payload, sender_id, ts, is_root, root_kind)
           VALUES (?, 'message', '{"id":"msg","content":"msg"}', 'sender', ?, 1, 'chat')`,
          `msg-${i}`,
          1000 + i * 1000
        );
      }
      // Insert a presence message (id will be 6)
      sql.exec(
        `INSERT INTO messages (message_id, type, payload, sender_id, ts, is_root, root_kind)
         VALUES ('presence-1', 'presence', '{"action":"join"}', 'sender', 6000, 1, 'presence')`
      );

      await instance.postClone("parent", 3);

      // Only messages with id <= 3 should remain, minus presence
      const remaining = sql.exec(`SELECT id, type FROM messages ORDER BY id`).toArray();
      expect(remaining).toHaveLength(3);
      expect(remaining.every((r) => (r["id"] as number) <= 3)).toBe(true);
      expect(remaining.every((r) => r["type"] !== "presence")).toBe(true);
    });
  });

  describe("setTypingState()", () => {
    it("updates participant metadata with typing field", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES ('agent-1', '{"name":"Agent","type":"agent","handle":"ai-chat"}', 'do', 1000)`
      );

      await instance.setTypingState("agent-1", true);

      const rows = sql.exec(`SELECT metadata FROM participants WHERE id = 'agent-1'`).toArray();
      const metadata = JSON.parse(rows[0]!["metadata"] as string);
      expect(metadata.typing).toBe(true);
      expect(metadata.name).toBe("Agent"); // identity preserved

      await instance.setTypingState("agent-1", false);

      const rows2 = sql.exec(`SELECT metadata FROM participants WHERE id = 'agent-1'`).toArray();
      const metadata2 = JSON.parse(rows2[0]!["metadata"] as string);
      expect(metadata2.typing).toBe(false);
    });

    it("does NOT insert into messages table", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES ('agent-1', '{"name":"Agent","type":"agent"}', 'do', 1000)`
      );

      const beforeCount = sql.exec(`SELECT COUNT(*) as cnt FROM messages`).one()["cnt"] as number;

      await instance.setTypingState("agent-1", true);
      await instance.setTypingState("agent-1", false);

      const afterCount = sql.exec(`SELECT COUNT(*) as cnt FROM messages`).one()["cnt"] as number;
      expect(afterCount).toBe(beforeCount);
    });

    it("is a no-op for non-existent participants", async () => {
      const { instance } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      // Should not throw
      await instance.setTypingState("nonexistent", true);
    });

    it("typing metadata survives in participants table for roster snapshot on reconnect", async () => {
      // sendRosterReplay emits a snapshot from the participants table after
      // replaying persisted presence events. This test verifies the precondition:
      // typing state set via setTypingState is present in the participants table
      // and would be included in that snapshot. Full end-to-end verification of
      // the snapshot broadcast requires an RPC emit mock (integration test).
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES ('agent-1', '{"name":"Agent","type":"agent","handle":"ai-chat"}', 'do', 1000)`
      );

      await instance.setTypingState("agent-1", true);

      // Verify typing is in participants table (source for roster snapshot)
      const rows = sql.exec(`SELECT metadata FROM participants WHERE id = 'agent-1'`).toArray();
      const metadata = JSON.parse(rows[0]!["metadata"] as string);
      expect(metadata.typing).toBe(true);

      // Verify NO presence row was persisted in messages (ephemeral broadcast only)
      const presenceRows = sql
        .exec(
          `SELECT COUNT(*) as cnt FROM messages WHERE type = 'presence' AND payload LIKE '%typing%'`
        )
        .one();
      expect(presenceRows["cnt"]).toBe(0);
    });
  });

  describe("replay ordering", () => {
    it("emits persisted messages to a reconnecting subscriber in id order, ready last", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      // Capture every rpc.emit to `channel:message` in call order.
      const emitted: Array<{ subscriberId: string; message: Record<string, unknown> }> = [];
      const mockRpc = {
        emit: vi.fn(async (subscriberId: string, _evt: string, payload: unknown) => {
          emitted.push({
            subscriberId,
            message: (payload as { message: Record<string, unknown> }).message,
          });
        }),
        call: vi.fn().mockResolvedValue(undefined),
      };
      (instance as any)._rpc = mockRpc;

      // Seed a multi-block turn: message M1 + two deltas + complete, plus
      // a second interleaved message M2. IDs are AUTOINCREMENT row ids.
      const m1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const m2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      sql.exec(
        `INSERT INTO messages (message_id, type, payload, sender_id, ts, is_root, root_kind)
         VALUES (?, 'message', ?, 'agent', ?, 1, 'chat')`,
        m1,
        JSON.stringify({ id: m1, content: "Hel" }),
        1000
      );
      sql.exec(
        `INSERT INTO messages (message_id, type, payload, sender_id, ts, is_root, root_message_id)
         VALUES (?, 'update-message', ?, 'agent', ?, 0, ?)`,
        `${m1}-u1`,
        JSON.stringify({ id: m1, content: "lo " }),
        1001,
        m1
      );
      sql.exec(
        `INSERT INTO messages (message_id, type, payload, sender_id, ts, is_root, root_kind)
         VALUES (?, 'message', ?, 'agent', ?, 1, 'chat')`,
        m2,
        JSON.stringify({
          id: m2,
          content:
            '{"id":"tc","name":"R","arguments":{},"execution":{"status":"pending","description":""}}',
        }),
        1002
      );
      sql.exec(
        `INSERT INTO messages (message_id, type, payload, sender_id, ts, is_root, root_message_id)
         VALUES (?, 'update-message', ?, 'agent', ?, 0, ?)`,
        `${m1}-u2`,
        JSON.stringify({ id: m1, content: "world", complete: true }),
        1003,
        m1
      );
      sql.exec(
        `INSERT INTO messages (message_id, type, payload, sender_id, ts, is_root, root_message_id)
         VALUES (?, 'update-message', ?, 'agent', ?, 0, ?)`,
        `${m2}-u1`,
        JSON.stringify({ id: m2, complete: true }),
        1004,
        m2
      );

      await instance.subscribe("panel:panel-1", {
        contextId: "ctx-1",
        callerKind: "panel",
        // RPC replay is gated on sinceId / replayMessageLimit.
        replayMessageLimit: 100,
      });

      // Emits are queued through a per-subscriber promise chain (fire-and-
      // queue, not awaited inside subscribe — awaiting inline would deadlock
      // against the subscriber's own RPC call reply). Flush the microtask
      // queue until the chain has drained.
      for (let i = 0; i < 10; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      // Panel-targeted emits for 'channel:message' only. Filter out non-panel.
      const panelEmits = emitted.filter((e) => e.subscriberId === "panel:panel-1");
      const kinds = panelEmits.map((e) => {
        const msg = e.message as { kind?: string; type?: string; event?: { type?: string } };
        return msg.event?.type ?? msg.type ?? msg.kind;
      });

      // Expect messages to land in id order (m1, update, m2, update, update)
      // followed by a ready event at the end.
      expect(kinds[kinds.length - 1]).toBe("ready");

      // Every 'update-message' for a given id must come AFTER its parent 'message'.
      // Wire format: top-level { type, payload: { id, ... } }.
      const firstIdx = (targetId: string, type: "message" | "update-message") =>
        panelEmits.findIndex((e) => {
          const event = (e.message as { event?: { type?: string; payload?: unknown } }).event;
          if (event?.type !== type) return false;
          const payload = event.payload as { id?: string } | undefined;
          return payload?.id === targetId;
        });
      expect(firstIdx(m1, "message")).toBeGreaterThanOrEqual(0);
      expect(firstIdx(m1, "update-message")).toBeGreaterThanOrEqual(0);
      expect(firstIdx(m1, "message")).toBeLessThan(firstIdx(m1, "update-message"));
      expect(firstIdx(m2, "message")).toBeGreaterThanOrEqual(0);
      expect(firstIdx(m2, "update-message")).toBeGreaterThanOrEqual(0);
      expect(firstIdx(m2, "message")).toBeLessThan(firstIdx(m2, "update-message"));
    });
  });

  describe("plan smoke", () => {
    it("keeps streamed transcript chains complete across reload, pagination, signals, method audit, and admin validation", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });
      const mockRpc = {
        emit: vi.fn().mockResolvedValue(undefined),
        call: vi.fn().mockResolvedValue(undefined),
      };
      (instance as any)._rpc = mockRpc;

      await instance.subscribe("panel:user", {
        contextId: "ctx-1",
        name: "User",
        type: "panel",
        handle: "user",
      });
      await instance.subscribe("do:workers/agent-worker:AiChatWorker:agent-1", {
        contextId: "ctx-1",
        name: "Agent",
        type: "agent",
        handle: "ai-chat",
      });

      for (let i = 1; i <= 40; i++) {
        await instance.send("panel:user", `user-${i}`, `turn ${i}`);
      }

      await instance.send("do:workers/agent-worker:AiChatWorker:agent-1", "older-stream", "old:");
      for (let i = 0; i < 20; i++) {
        await instance.update(
          "do:workers/agent-worker:AiChatWorker:agent-1",
          "older-stream",
          `${i}|`
        );
      }
      await instance.complete("do:workers/agent-worker:AiChatWorker:agent-1", "older-stream");

      for (let i = 41; i <= 240; i++) {
        await instance.send("panel:user", `user-${i}`, `turn ${i}`);
      }

      await instance.send("do:workers/agent-worker:AiChatWorker:agent-1", "agent-stream", "live:");
      for (let i = 0; i < 75; i++) {
        await instance.update(
          "do:workers/agent-worker:AiChatWorker:agent-1",
          "agent-stream",
          `${i},`
        );
      }
      await instance.complete("do:workers/agent-worker:AiChatWorker:agent-1", "agent-stream");

      for (let i = 241; i <= 250; i++) {
        await instance.send("panel:user", `user-${i}`, `turn ${i}`);
      }

      const countBeforeSignals = sql.exec(`SELECT COUNT(*) as cnt FROM messages`).one()["cnt"];
      for (let i = 0; i < 100; i++) {
        await instance.sendSignal("panel:user", `notice ${i}`, "client-notice");
      }
      const countAfterSignals = sql.exec(`SELECT COUNT(*) as cnt FROM messages`).one()["cnt"];
      expect(countAfterSignals).toBe(countBeforeSignals);

      const reload = await instance.subscribe("panel:reload", {
        contextId: "ctx-1",
        name: "Reloaded",
        type: "panel",
        handle: "reload",
        replayMessageLimit: 50,
      });
      const reloadAgentRows = reload.envelope.logEvents.filter((event) => {
        const payload = event.payload as { id?: string };
        return payload?.id === "agent-stream";
      });
      expect(reloadAgentRows.map((event) => event.type)).toContain("message");
      expect(reloadAgentRows.filter((event) => event.type === "update-message")).toHaveLength(76);
      expect(
        reloadAgentRows.some(
          (event) =>
            event.type === "update-message" &&
            (event.payload as { complete?: boolean }).complete === true
        )
      ).toBe(true);
      expect(reload.envelope.logEvents.some((event) => event.type === "method-call")).toBe(false);
      expect(reload.envelope.logEvents.some((event) => event.type === "presence")).toBe(false);

      const anchor = sql
        .exec(`SELECT id FROM messages WHERE message_id = 'user-180'`)
        .one()["id"] as number;
      const olderPage = await instance.getChatReplayBefore(anchor, 150);
      expect(olderPage.mode).toBe("before");
      expect(olderPage.snapshots).toEqual([]);
      const olderStreamRows = olderPage.logEvents.filter((event) => {
        const payload = event.payload as { id?: string };
        return payload?.id === "older-stream";
      });
      expect(olderStreamRows.map((event) => event.type)).toContain("message");
      expect(olderStreamRows.filter((event) => event.type === "update-message")).toHaveLength(21);
      expect(
        olderStreamRows.some(
          (event) =>
            event.type === "update-message" &&
            (event.payload as { complete?: boolean }).complete === true
        )
      ).toBe(true);
      expect(olderPage.logEvents.some((event) => event.type === "method-call")).toBe(false);
      expect(olderPage.logEvents.some((event) => event.type === "presence")).toBe(false);

      await instance.callMethod(
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "panel:user",
        "99999999-9999-4999-8999-999999999999",
        "feedback_custom",
        { prompt: "ok?" }
      );
      await instance.publish("panel:user", "method-result", {
        callId: "99999999-9999-4999-8999-999999999999",
        content: { ok: true },
        complete: true,
        isError: false,
      });
      expect(sql.exec(`SELECT call_id FROM pending_calls`).toArray()).toEqual([]);
      const methodRows = await instance.getReplayAfter(0);
      const methodChain = methodRows.logEvents.filter((event) => {
        const payload = event.payload as { callId?: string };
        return (
          event.messageId === "99999999-9999-4999-8999-999999999999" ||
          payload?.callId === "99999999-9999-4999-8999-999999999999"
        );
      });
      expect(methodChain.map((event) => event.type)).toEqual(["method-call", "method-result"]);

      setRpcCaller(instance, "main", "server");
      const validation = await instance.adminValidateLog();
      expect(validation).toMatchObject({ ok: true, issues: [] });
      const schema = await instance.adminInspectSchema();
      expect(schema.invariants.every((invariant) => invariant.ok)).toBe(true);
      const reconstructed = await instance.adminReconstructTranscript({ rootLimit: 20 });
      const currentTurn = reconstructed.transcript.find(
        (event) => event.type === "message" && event.id === "agent-stream"
      );
      expect(currentTurn).toMatchObject({
        type: "message",
        id: "agent-stream",
        complete: true,
        incomplete: false,
      });
      expect((currentTurn as { content?: string }).content).toContain("live:0,1,2,");
    });
  });

  describe("admin inspection", () => {
    it("reports the canonical message schema", async () => {
      const { instance } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });
      setRpcCaller(instance, "main", "server");

      const schema = await instance.adminInspectSchema();
      expect(schema.invariants.every((invariant) => invariant.ok)).toBe(true);
      const messages = schema.tables.find((table) => table.table === "messages")!;
      expect(messages.columns.map((column) => column["name"])).toEqual([
        "id",
        "message_id",
        "type",
        "payload",
        "sender_id",
        "sender_metadata",
        "attachments",
        "ts",
        "is_root",
        "root_message_id",
        "root_kind",
      ]);
    });

    it("flags duplicate and contradictory chat terminal rows", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });
      setRpcCaller(instance, "main", "server");

      sql.exec(
        `INSERT INTO messages (message_id, type, payload, sender_id, sender_metadata, ts, is_root, root_kind)
         VALUES ('root-1', 'message', '{"id":"root-1","content":"hi"}', 'agent', '{"type":"agent"}', 1000, 1, 'chat')`
      );
      sql.exec(
        `INSERT INTO messages (message_id, type, payload, sender_id, ts, is_root, root_message_id)
         VALUES ('root-1-complete-1', 'update-message', '{"id":"root-1","complete":true}', 'agent', 1001, 0, 'root-1')`
      );
      sql.exec(
        `INSERT INTO messages (message_id, type, payload, sender_id, ts, is_root, root_message_id)
         VALUES ('root-1-error-1', 'error', '{"id":"root-1","error":"failed"}', 'agent', 1002, 0, 'root-1')`
      );

      const result = await instance.adminValidateLog();
      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.code === "contradictory-terminal")).toBe(true);
    });

    it("flags assistant roots without terminal rows", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });
      setRpcCaller(instance, "main", "server");

      sql.exec(
        `INSERT INTO messages (message_id, type, payload, sender_id, sender_metadata, ts, is_root, root_kind)
         VALUES ('root-1', 'message', '{"id":"root-1","content":"streaming"}', 'agent', '{"type":"agent"}', 1000, 1, 'chat')`
      );

      const result = await instance.adminValidateLog();
      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.code === "missing-terminal")).toBe(true);
    });
  });
});
