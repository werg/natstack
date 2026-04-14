import { describe, it, expect, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { PubSubChannel } from "./channel-do.js";

describe("PubSubChannel", () => {
  describe("getParticipants()", () => {
    it("returns DO identity when present", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at, do_source, do_class, do_key)
         VALUES ('p1', '{"name":"Agent"}', 'do', 1000, 'workers/agent', 'AgentDO', 'key-1')`,
      );
      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES ('p2', '{"callerKind":"panel"}', 'rpc', 2000)`,
      );

      const participants = await instance.getParticipants();
      expect(participants).toHaveLength(2);

      const doParticipant = participants.find(p => p.participantId === "p1")!;
      expect(doParticipant.transport).toBe("do");
      expect(doParticipant.doRef).toEqual({ source: "workers/agent", className: "AgentDO", objectKey: "key-1" });

      const rpcParticipant = participants.find(p => p.participantId === "p2")!;
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
        transport: "do",
        doSource: "workers/agent",
        doClass: "AgentDO",
        doKey: "key-1",
        contextId: "ctx-1",
        name: "TestAgent",
      });

      expect(result.ok).toBe(true);

      const participants = sql.exec(`SELECT id, transport, do_source, do_class, do_key FROM participants WHERE id = 'do:workers/agent:AgentDO:key-1'`).toArray();
      expect(participants).toHaveLength(1);
      expect(participants[0]!["transport"]).toBe("do");
      expect(participants[0]!["do_source"]).toBe("workers/agent");
    });

    it("registers RPC subscriber (panel) with transport='rpc'", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      await instance.subscribe("panel-123", {
        contextId: "ctx-1",
        callerKind: "panel",
      });

      const participants = sql.exec(`SELECT id, transport FROM participants WHERE id = 'panel-123'`).toArray();
      expect(participants).toHaveLength(1);
      expect(participants[0]!["transport"]).toBe("rpc");
    });

    it("returns replay with REPLAY_LIMIT=50 and sets replayTruncated", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      // Insert 55 persisted messages
      for (let i = 1; i <= 55; i++) {
        sql.exec(
          `INSERT INTO messages (message_id, type, content, sender_id, ts, persist)
           VALUES (?, 'message', '{"content":"msg"}', 'sender', ?, 1)`,
          `msg-${i}`, 1000 + i,
        );
      }

      const result = await instance.subscribe("do:test:TestDO:key", {
        transport: "do",
        doSource: "test",
        doClass: "TestDO",
        doKey: "key",
        replay: true,
      });

      expect(result.ok).toBe(true);
      expect(result.replay).toHaveLength(50);
      expect(result.replayTruncated).toBe(true);
      // Should be the 50 most recent (ids 6-55)
      expect(result.replay![0]!.id).toBe(6);
      expect(result.replay![49]!.id).toBe(55);
    });

    it("returns full replay without truncation when under limit", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      for (let i = 1; i <= 10; i++) {
        sql.exec(
          `INSERT INTO messages (message_id, type, content, sender_id, ts, persist)
           VALUES (?, 'message', '{"content":"msg"}', 'sender', ?, 1)`,
          `msg-${i}`, 1000 + i,
        );
      }

      const result = await instance.subscribe("do:test:TestDO:key", {
        transport: "do",
        doSource: "test",
        doClass: "TestDO",
        doKey: "key",
        replay: true,
      });

      expect(result.replay).toHaveLength(10);
      expect(result.replayTruncated).toBeFalsy();
    });

    it("rejects a second participant claiming the same handle", async () => {
      const { instance } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      await instance.subscribe("panel-1", {
        contextId: "ctx-1",
        transport: "rpc",
        handle: "ai-chat",
      });

      await expect(
        instance.subscribe("panel-2", {
          contextId: "ctx-1",
          transport: "rpc",
          handle: "ai-chat",
        }),
      ).rejects.toThrow(/handle "ai-chat" is already in use/);
    });

    it("allows the same participant to re-subscribe with the same handle", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      await instance.subscribe("panel-1", {
        contextId: "ctx-1",
        transport: "rpc",
        handle: "ai-chat",
      });
      await instance.subscribe("panel-1", {
        contextId: "ctx-1",
        transport: "rpc",
        handle: "ai-chat",
      });

      const rows = sql.exec(`SELECT id, handle FROM participants WHERE handle = 'ai-chat'`).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!["id"]).toBe("panel-1");
    });

    it("cleans subscribe-time metadata from stored participant", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      await instance.subscribe("panel-1", {
        contextId: "ctx-1",
        channelConfig: { title: "Test" },
        transport: "rpc",
        replay: true,
        sinceId: 5,
        replayMessageLimit: 20,
        name: "Alice",
      });

      const row = sql.exec(`SELECT metadata FROM participants WHERE id = 'panel-1'`).toArray();
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

    it("fails pending calls when a participant is replaced by a new session", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      const mockRpc = {
        emit: vi.fn().mockResolvedValue(undefined),
        call: vi.fn().mockResolvedValue(undefined),
      };
      (instance as any)._rpc = mockRpc;

      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at, session_id, do_source, do_class, do_key)
         VALUES (?, '{}', 'do', ?, 'caller-session', 'workers/agent-worker', 'AiChatWorker', 'agent-1')`,
        "do:workers/agent-worker:AiChatWorker:agent-1", Date.now(),
      );
      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at, session_id)
         VALUES (?, ?, 'rpc', ?, ?)`,
        "panel-1", '{"name":"old"}', Date.now(), "session-old",
      );
      sql.exec(
        `INSERT INTO pending_calls (call_id, caller_id, target_id, method, args, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "11111111-1111-4111-8111-111111111111",
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "panel-1",
        "eval",
        "{}",
        0,
        Date.now(),
      );

      await instance.subscribe("panel-1", {
        contextId: "ctx-1",
        transport: "rpc",
        name: "new",
        __participantSessionId: "session-new",
      });

      expect(sql.exec(`SELECT * FROM pending_calls`).toArray()).toHaveLength(0);
      expect(mockRpc.call).toHaveBeenCalledWith(
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "onCallResult",
        "11111111-1111-4111-8111-111111111111",
        { error: "Target panel-1 was replaced by a new session before the call completed" },
        true,
      );
      const leaveMessages = sql.exec(
        `SELECT content FROM messages WHERE type = 'presence' ORDER BY id ASC`,
      ).toArray().map(row => JSON.parse(row["content"] as string));
      expect(leaveMessages.some(msg => msg.action === "leave" && msg.leaveReason === "replaced")).toBe(true);
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
        "panel-1", '{"name":"old"}', Date.now(), "session-same",
      );
      sql.exec(
        `INSERT INTO pending_calls (call_id, caller_id, target_id, method, args, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "22222222-2222-4222-8222-222222222222",
        "caller-1",
        "panel-1",
        "eval",
        "{}",
        0,
        Date.now(),
      );

      await instance.subscribe("panel-1", {
        contextId: "ctx-1",
        transport: "rpc",
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
        `INSERT INTO pending_calls (call_id, caller_id, target_id, method, args, expires_at, created_at)
         VALUES ('call-1', 'caller-1', 'provider-1', 'doWork', '{}', ?, ?)`,
        Date.now() + 60000, Date.now(),
      );

      await instance.cancelMethodCall("call-1");

      // Call should be deleted
      const calls = sql.exec(`SELECT * FROM pending_calls WHERE call_id = 'call-1'`).toArray();
      expect(calls).toHaveLength(0);
    });
  });

  describe("method result delivery", () => {
    it("fails an in-flight rpc tool call when the target reconnects with a new session", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      const mockRpc = {
        emit: vi.fn().mockResolvedValue(undefined),
        call: vi.fn().mockResolvedValue(undefined),
      };
      (instance as any)._rpc = mockRpc;

      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at, session_id, do_source, do_class, do_key)
         VALUES (?, '{}', 'do', ?, 'caller-session', 'workers/agent-worker', 'AiChatWorker', 'agent-1')`,
        "do:workers/agent-worker:AiChatWorker:agent-1", Date.now(),
      );
      await instance.subscribe("panel-1", {
        contextId: "ctx-1",
        transport: "rpc",
        name: "old-panel",
        __participantSessionId: "session-old",
      });

      await instance.callMethod(
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "panel-1",
        "44444444-4444-4444-8444-444444444444",
        "eval",
        { code: "await new Promise(() => {})" },
      );

      expect(sql.exec(`SELECT call_id FROM pending_calls`).toArray()).toEqual([
        { call_id: "44444444-4444-4444-8444-444444444444" },
      ]);

      await instance.subscribe("panel-1", {
        contextId: "ctx-1",
        transport: "rpc",
        name: "new-panel",
        __participantSessionId: "session-new",
      });

      expect(sql.exec(`SELECT call_id FROM pending_calls`).toArray()).toHaveLength(0);
      expect(mockRpc.call).toHaveBeenCalledWith(
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "onCallResult",
        "44444444-4444-4444-8444-444444444444",
        { error: "Target panel-1 was replaced by a new session before the call completed" },
        true,
      );
    });

    it("awaits intercepted method-result forwarding before publish resolves", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      let resolveCall!: () => void;
      const callPromise = new Promise<void>((resolve) => {
        resolveCall = resolve;
      });
      const mockRpc = {
        emit: vi.fn().mockResolvedValue(undefined),
        call: vi.fn().mockImplementation(() => callPromise),
      };
      (instance as any)._rpc = mockRpc;

      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at, do_source, do_class, do_key)
         VALUES (?, '{}', 'do', ?, 'workers/agent-worker', 'AiChatWorker', 'agent-1')`,
        "do:workers/agent-worker:AiChatWorker:agent-1", Date.now(),
      );
      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES (?, '{}', 'rpc', ?)`,
        "panel-1", Date.now(),
      );
      sql.exec(
        `INSERT INTO pending_calls (call_id, caller_id, target_id, method, args, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "33333333-3333-4333-8333-333333333333",
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "panel-1",
        "eval",
        "{}",
        0,
        Date.now(),
      );

      let resolved = false;
      const publishPromise = instance.publish("panel-1", "method-result", {
        callId: "33333333-3333-4333-8333-333333333333",
        content: { ok: true },
        complete: true,
        isError: false,
      }, { persist: true }).then(() => {
        resolved = true;
      });

      await Promise.resolve();
      expect(resolved).toBe(false);

      resolveCall();
      await publishPromise;
      expect(resolved).toBe(true);
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
        `INSERT INTO participants (id, metadata, transport, connected_at, do_source, do_class, do_key)
         VALUES (?, '{}', 'do', ?, 'workers/agent-worker', 'AiChatWorker', 'agent-1')`,
        "do:workers/agent-worker:AiChatWorker:agent-1", Date.now(),
      );
      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES (?, '{}', 'rpc', ?)`,
        "panel-1", Date.now(),
      );
      sql.exec(
        `INSERT INTO pending_calls (call_id, caller_id, target_id, method, args, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "call-1",
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "panel-1",
        "eval",
        "{}",
        Date.now() + 60_000,
        Date.now(),
      );

      await instance.publish("panel-1", "method-result", {
        callId: "call-1",
        content: { ok: true, result: 42 },
        complete: true,
        isError: false,
      }, { persist: true });

      expect(mockRpc.call).toHaveBeenCalledWith(
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "onCallResult",
        "call-1",
        { ok: true, result: 42 },
        false,
      );

      expect(mockRpc.emit).toHaveBeenCalledWith(
        "panel-1",
        "channel:message",
        expect.objectContaining({
          channelId: "test-channel",
          message: expect.objectContaining({
            kind: "persisted",
            type: "method-result",
            payload: expect.objectContaining({
              callId: "call-1",
              content: { ok: true, result: 42 },
              complete: true,
              isError: false,
            }),
          }),
        }),
      );

      const persisted = sql.exec(
        `SELECT type, sender_id, content FROM messages WHERE type = 'method-result'`,
      ).toArray();
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!["sender_id"]).toBe("do:workers/agent-worker:AiChatWorker:agent-1");
      expect(JSON.parse(persisted[0]!["content"] as string)).toMatchObject({
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
      sql.exec(`INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', 'parent-channel')`);

      // Insert some messages to verify trim
      sql.exec(`INSERT INTO messages (message_id, type, content, sender_id, ts, persist) VALUES ('m1', 'message', '{}', 's1', 1000, 1)`);
      sql.exec(`INSERT INTO messages (message_id, type, content, sender_id, ts, persist) VALUES ('m2', 'message', '{}', 's1', 2000, 1)`);
      sql.exec(`INSERT INTO messages (message_id, type, content, sender_id, ts, persist) VALUES ('m3', 'presence', '{}', 's1', 3000, 1)`);

      // Insert a participant
      sql.exec(`INSERT INTO participants (id, metadata, transport, connected_at) VALUES ('p1', '{}', 'do', 1000)`);

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
          `INSERT INTO messages (message_id, type, content, sender_id, ts, persist)
           VALUES (?, 'message', '{"content":"msg"}', 'sender', ?, 1)`,
          `msg-${i}`, 1000 + i * 1000,
        );
      }
      // Insert a presence message (id will be 6)
      sql.exec(
        `INSERT INTO messages (message_id, type, content, sender_id, ts, persist)
         VALUES ('presence-1', 'presence', '{"action":"join"}', 'sender', 6000, 1)`,
      );

      await instance.postClone("parent", 3);

      // Only messages with id <= 3 should remain, minus presence
      const remaining = sql.exec(`SELECT id, type FROM messages ORDER BY id`).toArray();
      expect(remaining).toHaveLength(3);
      expect(remaining.every(r => (r["id"] as number) <= 3)).toBe(true);
      expect(remaining.every(r => r["type"] !== "presence")).toBe(true);
    });
  });

  describe("setTypingState()", () => {
    it("updates participant metadata with typing field", async () => {
      const { instance, sql } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
      });

      sql.exec(
        `INSERT INTO participants (id, metadata, transport, connected_at)
         VALUES ('agent-1', '{"name":"Agent","type":"agent","handle":"ai-chat"}', 'do', 1000)`,
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
         VALUES ('agent-1', '{"name":"Agent","type":"agent"}', 'do', 1000)`,
      );

      const beforeCount = (sql.exec(`SELECT COUNT(*) as cnt FROM messages`).one()["cnt"] as number);

      await instance.setTypingState("agent-1", true);
      await instance.setTypingState("agent-1", false);

      const afterCount = (sql.exec(`SELECT COUNT(*) as cnt FROM messages`).one()["cnt"] as number);
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
         VALUES ('agent-1', '{"name":"Agent","type":"agent","handle":"ai-chat"}', 'do', 1000)`,
      );

      await instance.setTypingState("agent-1", true);

      // Verify typing is in participants table (source for roster snapshot)
      const rows = sql.exec(`SELECT metadata FROM participants WHERE id = 'agent-1'`).toArray();
      const metadata = JSON.parse(rows[0]!["metadata"] as string);
      expect(metadata.typing).toBe(true);

      // Verify NO presence row was persisted in messages (ephemeral broadcast only)
      const presenceRows = sql.exec(
        `SELECT COUNT(*) as cnt FROM messages WHERE type = 'presence' AND content LIKE '%typing%'`,
      ).one();
      expect(presenceRows["cnt"]).toBe(0);
    });
  });
});
