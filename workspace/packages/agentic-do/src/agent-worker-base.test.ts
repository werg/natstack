import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { AgentWorkerBase } from "./agent-worker-base.js";
import type { ChannelEvent, HarnessOutput } from "@natstack/harness/types";

// ─── Minimal concrete subclass for testing ───────────────────────────────────

class TestAgent extends AgentWorkerBase {
  static override schemaVersion = 4;
  postCloneCalled = false;

  async onChannelEvent(_channelId: string, _event: ChannelEvent): Promise<void> {}
  async onHarnessEvent(_harnessId: string, _event: HarnessOutput): Promise<void> {}

  protected override async onPostClone(): Promise<void> {
    this.postCloneCalled = true;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockFetch() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: (h: string) => h === "content-type" ? "application/json" : null },
    json: async () => ({ ok: true, participantId: "p-new", channelConfig: null }),
    text: async () => JSON.stringify({ ok: true, participantId: "p-new", channelConfig: null }),
  }));
}

async function createAgent(objectKey = "agent-1") {
  const fetchMock = mockFetch();
  vi.stubGlobal("fetch", fetchMock);

  const { instance, sql, call } = await createTestDO(TestAgent, {
    __objectKey: objectKey,
    WORKERD_URL: "http://workerd.test",
    WORKER_SOURCE: "workers/test-agent",
    WORKER_CLASS_NAME: "TestAgent",
    WORKERD_SESSION_ID: "session-1",
  });

  return { instance, sql, call, fetchMock };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AgentWorkerBase fork support", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("canFork()", () => {
    it("returns ok with subscriptionCount for 0 or 1 subscriptions", async () => {
      const { instance, sql } = await createAgent();

      const r0 = await instance.canFork();
      expect(r0).toEqual({ ok: true, subscriptionCount: 0 });

      sql.exec(`INSERT INTO subscriptions (channel_id, context_id, subscribed_at) VALUES ('ch-1', 'ctx-1', 1000)`);
      const r1 = await instance.canFork();
      expect(r1).toEqual({ ok: true, subscriptionCount: 1 });

      vi.unstubAllGlobals();
    });

    it("returns ok:false for multi-channel agent", async () => {
      const { instance, sql } = await createAgent();

      sql.exec(`INSERT INTO subscriptions (channel_id, context_id, subscribed_at) VALUES ('ch-1', 'ctx-1', 1000)`);
      sql.exec(`INSERT INTO subscriptions (channel_id, context_id, subscribed_at) VALUES ('ch-2', 'ctx-2', 2000)`);

      const result = await instance.canFork();
      expect(result.ok).toBe(false);
      expect(result.subscriptionCount).toBe(2);
      expect(result.reason).toBe("multi-channel");

      vi.unstubAllGlobals();
    });
  });

  describe("postClone() via fetch path", () => {
    it("records fork metadata in state KV", async () => {
      const { call, sql } = await createAgent("forked-agent");

      sql.exec(`INSERT INTO subscriptions (channel_id, context_id, subscribed_at) VALUES ('old-channel', 'ctx-1', 1000)`);

      await call("postClone", "original-agent", "forked-channel", "old-channel", 42);

      expect(sql.exec(`SELECT value FROM state WHERE key = 'forkedFrom'`).toArray()[0]!["value"]).toBe("original-agent");
      expect(sql.exec(`SELECT value FROM state WHERE key = 'forkPointPubsubId'`).toArray()[0]!["value"]).toBe("42");
      expect(sql.exec(`SELECT value FROM state WHERE key = 'forkSourceChannel'`).toArray()[0]!["value"]).toBe("old-channel");

      vi.unstubAllGlobals();
    });

    it("resolves fork session ID from turn_map", async () => {
      const { call, sql } = await createAgent("forked-agent");

      sql.exec(`INSERT INTO subscriptions (channel_id, context_id, subscribed_at) VALUES ('old-channel', 'ctx-1', 1000)`);
      sql.exec(`INSERT INTO harnesses (id, type, status, created_at) VALUES ('h-1', 'claude-sdk', 'active', 1000)`);
      sql.exec(
        `INSERT INTO turn_map (harness_id, turn_message_id, trigger_pubsub_id, external_session_id, created_at) VALUES ('h-1', 'msg-1', 30, 'session-abc', 1000)`,
      );

      await call("postClone", "original-agent", "forked-channel", "old-channel", 42);

      const sessionId = sql.exec(`SELECT value FROM state WHERE key = 'forkSessionId'`).toArray();
      expect(sessionId[0]!["value"]).toBe("session-abc");

      vi.unstubAllGlobals();
    });

    it("marks all harnesses as stopped", async () => {
      const { call, sql } = await createAgent("forked-agent");

      sql.exec(`INSERT INTO subscriptions (channel_id, context_id, subscribed_at) VALUES ('old-channel', 'ctx-1', 1000)`);
      sql.exec(`INSERT INTO harnesses (id, type, status, created_at) VALUES ('h-1', 'claude-sdk', 'active', 1000)`);
      sql.exec(`INSERT INTO harnesses (id, type, status, created_at) VALUES ('h-2', 'claude-sdk', 'starting', 2000)`);

      await call("postClone", "original-agent", "forked-channel", "old-channel", 42);

      const harnesses = sql.exec(`SELECT id, status FROM harnesses`).toArray();
      expect(harnesses.every(h => h["status"] === "stopped")).toBe(true);

      vi.unstubAllGlobals();
    });

    it("clears ephemeral tables", async () => {
      const { call, sql } = await createAgent("forked-agent");

      sql.exec(`INSERT INTO subscriptions (channel_id, context_id, subscribed_at) VALUES ('old-channel', 'ctx-1', 1000)`);
      sql.exec(`INSERT INTO harnesses (id, type, status, created_at) VALUES ('h-1', 'claude-sdk', 'active', 1000)`);
      sql.exec(`INSERT INTO active_turns (harness_id, channel_id, reply_to_id, started_at) VALUES ('h-1', 'old-channel', 'msg-1', 1000)`);
      sql.exec(`INSERT INTO in_flight_turns (channel_id, harness_id, trigger_message_id, trigger_pubsub_id, turn_input, started_at) VALUES ('old-channel', 'h-1', 'msg-1', 10, '{}', 1000)`);
      sql.exec(`INSERT INTO pending_calls (call_id, channel_id, call_type, context, created_at) VALUES ('call-1', 'old-channel', 'approval', '{}', 1000)`);
      sql.exec(`INSERT INTO checkpoints (channel_id, last_pubsub_id, updated_at) VALUES ('old-channel', 10, 1000)`);
      sql.exec(`INSERT INTO queued_turns (channel_id, harness_id, message_id, pubsub_id, sender_id, turn_input, created_at) VALUES ('old-channel', 'h-1', 'msg-2', 20, 'user-1', '{}', 1000)`);

      await call("postClone", "original-agent", "forked-channel", "old-channel", 42);

      expect(sql.exec(`SELECT COUNT(*) as cnt FROM active_turns`).toArray()[0]!["cnt"]).toBe(0);
      expect(sql.exec(`SELECT COUNT(*) as cnt FROM in_flight_turns`).toArray()[0]!["cnt"]).toBe(0);
      expect(sql.exec(`SELECT COUNT(*) as cnt FROM queued_turns`).toArray()[0]!["cnt"]).toBe(0);
      expect(sql.exec(`SELECT COUNT(*) as cnt FROM pending_calls`).toArray()[0]!["cnt"]).toBe(0);
      expect(sql.exec(`SELECT COUNT(*) as cnt FROM checkpoints`).toArray()[0]!["cnt"]).toBe(0);

      vi.unstubAllGlobals();
    });

    it("renames approval level key from old to new channel", async () => {
      const { call, sql } = await createAgent("forked-agent");

      sql.exec(`INSERT INTO subscriptions (channel_id, context_id, subscribed_at) VALUES ('old-channel', 'ctx-1', 1000)`);
      sql.exec(`INSERT OR REPLACE INTO state (key, value) VALUES ('approvalLevel:old-channel', '2')`);

      await call("postClone", "original-agent", "forked-channel", "old-channel", 42);

      const oldKey = sql.exec(`SELECT value FROM state WHERE key = 'approvalLevel:old-channel'`).toArray();
      expect(oldKey).toHaveLength(0);

      const newKey = sql.exec(`SELECT value FROM state WHERE key = 'approvalLevel:forked-channel'`).toArray();
      expect(newKey[0]!["value"]).toBe("2");

      vi.unstubAllGlobals();
    });

    it("resubscribes to forked channel", async () => {
      const { call, sql, fetchMock } = await createAgent("forked-agent");

      sql.exec(`INSERT INTO subscriptions (channel_id, context_id, subscribed_at, config) VALUES ('old-channel', 'ctx-1', 1000, '{"model":"opus"}')`);

      await call("postClone", "original-agent", "forked-channel", "old-channel", 42);

      const subs = sql.exec(`SELECT channel_id, context_id, config FROM subscriptions`).toArray();
      expect(subs).toHaveLength(1);
      expect(subs[0]!["channel_id"]).toBe("forked-channel");
      expect(subs[0]!["context_id"]).toBe("ctx-1");

      const subscribeCalls = (fetchMock.mock.calls as unknown as Array<[string, { body: string }]>)
        .filter(([url]) => url.includes("/subscribe"));
      expect(subscribeCalls.length).toBeGreaterThan(0);

      vi.unstubAllGlobals();
    });

    it("picks fork-point session, not latest, when turns exist after fork point", async () => {
      const { call, sql } = await createAgent("forked-agent");

      sql.exec(`INSERT INTO subscriptions (channel_id, context_id, subscribed_at) VALUES ('old-channel', 'ctx-1', 1000)`);
      sql.exec(`INSERT INTO harnesses (id, type, status, created_at) VALUES ('h-1', 'claude-sdk', 'active', 1000)`);
      sql.exec(
        `INSERT INTO turn_map (harness_id, turn_message_id, trigger_pubsub_id, external_session_id, created_at)
         VALUES ('h-1', 'msg-1', 30, 'session-at-30', 1000)`,
      );
      sql.exec(
        `INSERT INTO turn_map (harness_id, turn_message_id, trigger_pubsub_id, external_session_id, created_at)
         VALUES ('h-1', 'msg-2', 50, 'session-at-50', 2000)`,
      );

      await call("postClone", "original-agent", "forked-channel", "old-channel", 42);

      const sessionId = sql.exec(`SELECT value FROM state WHERE key = 'forkSessionId'`).toArray();
      expect(sessionId[0]!["value"]).toBe("session-at-30");

      vi.unstubAllGlobals();
    });

    it("calls onPostClone hook", async () => {
      const { instance, call, sql } = await createAgent("forked-agent");

      sql.exec(`INSERT INTO subscriptions (channel_id, context_id, subscribed_at) VALUES ('old-channel', 'ctx-1', 1000)`);

      await call("postClone", "original-agent", "forked-channel", "old-channel", 42);

      expect(instance.postCloneCalled).toBe(true);

      vi.unstubAllGlobals();
    });
  });

  describe("getResumeSessionIdForChannel()", () => {
    it("returns forkSessionId on every call until recordTurn consumes it", async () => {
      const { instance, sql } = await createAgent("forked-agent");

      sql.exec(`INSERT OR REPLACE INTO state (key, value) VALUES ('forkSessionId', 'session-fork')`);
      sql.exec(`INSERT INTO harnesses (id, type, status, created_at) VALUES ('h-1', 'claude-sdk', 'stopped', 1000)`);
      sql.exec(
        `INSERT INTO turn_map (harness_id, turn_message_id, trigger_pubsub_id, external_session_id, created_at)
         VALUES ('h-1', 'msg-1', 99, 'session-latest', 5000)`,
      );

      // Multiple calls return fork session (survives spawn retries)
      expect((instance as any).getResumeSessionIdForChannel("ch")).toBe("session-fork");
      expect((instance as any).getResumeSessionIdForChannel("ch")).toBe("session-fork");

      // recordTurn consumes forkSessionId
      (instance as any).recordTurn("h-1", "msg-new", 100, "session-new");
      expect(sql.exec(`SELECT value FROM state WHERE key = 'forkSessionId'`).toArray()).toHaveLength(0);

      // Now falls back to latest
      expect((instance as any).getResumeSessionIdForChannel("ch")).toBe("session-new");

      vi.unstubAllGlobals();
    });

    it("falls back to latest session when no forkSessionId", async () => {
      const { instance, sql } = await createAgent("agent-1");

      sql.exec(`INSERT INTO harnesses (id, type, status, created_at) VALUES ('h-1', 'claude-sdk', 'active', 1000)`);
      sql.exec(
        `INSERT INTO turn_map (harness_id, turn_message_id, trigger_pubsub_id, external_session_id, created_at)
         VALUES ('h-1', 'msg-1', 10, 'session-normal', 1000)`,
      );

      const result = (instance as any).getResumeSessionIdForChannel("ch-1");
      expect(result).toBe("session-normal");

      vi.unstubAllGlobals();
    });
  });
});
