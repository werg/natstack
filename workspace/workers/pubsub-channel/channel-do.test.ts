import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { PubSubChannel } from "./channel-do.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch(responses: Array<{ ok: boolean; status?: number; json?: unknown }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex++] ?? { ok: false, status: 500 };
    return {
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 500),
      headers: { get: (h: string) => h === "content-type" ? "application/json" : null },
      json: async () => resp.json,
      text: async () => JSON.stringify(resp.json ?? {}),
    };
  });
}

describe("PubSubChannel", () => {
  describe("fork()", () => {
    it("calls cloneDO then postClone on the forked channel", async () => {
      const clonedRef = {
        source: "workers/pubsub-channel",
        className: "PubSubChannel",
        objectKey: "fork:test-channel:abcd1234",
      };

      // Two fetch calls: 1) POST /do/clone, 2) postToDO to forked channel
      const fetchMock = mockFetch([
        { ok: true, json: clonedRef },  // cloneDO response
        { ok: true, json: null },        // postToDO postClone response
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const { instance } = await createTestDO(PubSubChannel, {
        __objectKey: "test-channel",
        WORKERD_URL: "http://workerd.test",
      });

      const result = await instance.fork(42);

      expect(result.forkedChannelId).toMatch(/^fork:test-channel:/);

      // First call: POST /do/clone to server
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const calls = fetchMock.mock.calls as unknown as Array<[string, { body: string }]>;
      expect(calls[0]![0]).toBe("http://test-server.invalid/do/clone");
      const cloneBody = JSON.parse(calls[0]![1].body);
      expect(cloneBody.ref).toEqual({
        source: "workers/pubsub-channel",
        className: "PubSubChannel",
        objectKey: "test-channel",
      });
      expect(cloneBody.newObjectKey).toBe(result.forkedChannelId);

      // Second call: postToDO to the forked channel
      expect(calls[1]![0]).toContain("/_w/workers/pubsub-channel/PubSubChannel/");
      expect(calls[1]![0]).toContain("/postClone");
      const postCloneBody = JSON.parse(calls[1]![1].body);
      expect(postCloneBody).toEqual(["test-channel", 42]);

      vi.unstubAllGlobals();
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
