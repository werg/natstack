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
         VALUES ('p2', '{"callerKind":"panel"}', 'ws', 2000)`,
      );

      const participants = await instance.getParticipants();
      expect(participants).toHaveLength(2);

      const doParticipant = participants.find(p => p.participantId === "p1")!;
      expect(doParticipant.transport).toBe("do");
      expect(doParticipant.doRef).toEqual({ source: "workers/agent", className: "AgentDO", objectKey: "key-1" });

      const wsParticipant = participants.find(p => p.participantId === "p2")!;
      expect(wsParticipant.transport).toBe("ws");
      expect(wsParticipant.doRef).toBeUndefined();
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
});
