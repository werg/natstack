/**
 * Tests for channel forking semantics in the MessageStore.
 *
 * Validates fork chain resolution, cross-segment query aggregation,
 * and fork-aware replay through the PubSubServer.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from "vitest";
import WebSocket from "ws";
import {
  InMemoryMessageStore,
  PubSubServer,
  TestTokenValidator,
} from "./index.js";

describe("MessageStore fork semantics", () => {
  let store: InMemoryMessageStore;

  beforeEach(() => {
    store = new InMemoryMessageStore();
    store.init();
  });

  describe("resolveForkedSegments", () => {
    it("returns single segment for root channel", () => {
      store.createChannel("root", "ctx", "user");
      const segments = store.resolveForkedSegments("root");
      expect(segments).toEqual([{ channel: "root", upToId: Infinity }]);
    });

    it("returns correct chain for 2-level fork", () => {
      store.createChannel("root", "ctx", "user");
      store.createChannel("fork-1", "ctx", "user");
      store.setChannelFork("fork-1", "root", 50);

      const segments = store.resolveForkedSegments("fork-1");
      expect(segments).toEqual([
        { channel: "root", upToId: 50 },
        { channel: "fork-1", upToId: Infinity },
      ]);
    });

    it("returns correct chain for 3-level fork", () => {
      store.createChannel("root", "ctx", "user");
      store.createChannel("fork-1", "ctx", "user");
      store.createChannel("fork-2", "ctx", "user");
      store.setChannelFork("fork-1", "root", 50);
      store.setChannelFork("fork-2", "fork-1", 80);

      const segments = store.resolveForkedSegments("fork-2");
      expect(segments).toEqual([
        { channel: "root", upToId: 50 },
        { channel: "fork-1", upToId: 80 },
        { channel: "fork-2", upToId: Infinity },
      ]);
    });

    it("enforces max depth of 10", () => {
      // Create a chain of 12 channels
      store.createChannel("ch-0", "ctx", "user");
      for (let i = 1; i <= 12; i++) {
        store.createChannel(`ch-${i}`, "ctx", "user");
        store.setChannelFork(`ch-${i}`, `ch-${i - 1}`, i * 10);
      }

      const segments = store.resolveForkedSegments("ch-12");
      // Should stop at depth 10 — so the root of the chain is ch-2, not ch-0
      expect(segments.length).toBeLessThanOrEqual(11); // 10 parents + leaf
    });
  });

  describe("setChannelFork / getChannelFork", () => {
    it("stores and retrieves fork metadata", () => {
      store.createChannel("root", "ctx", "user");
      store.createChannel("fork-1", "ctx", "user");
      store.setChannelFork("fork-1", "root", 42);

      const fork = store.getChannelFork("fork-1");
      expect(fork).toEqual({ parentChannel: "root", forkPointId: 42 });
    });

    it("returns null for root channel", () => {
      store.createChannel("root", "ctx", "user");
      expect(store.getChannelFork("root")).toBeNull();
    });

    it("returns null for nonexistent channel", () => {
      expect(store.getChannelFork("nonexistent")).toBeNull();
    });
  });

  describe("queryRange", () => {
    it("returns messages within range", () => {
      store.createChannel("ch", "ctx", "user");
      store.insert("ch", "message", '{"text":"1"}', "u", 1);
      store.insert("ch", "message", '{"text":"2"}', "u", 2);
      store.insert("ch", "message", '{"text":"3"}', "u", 3);
      store.insert("ch", "message", '{"text":"4"}', "u", 4);

      // sinceId=1 means id > 1; upToId=3 means id <= 3
      const rows = store.queryRange("ch", 1, 3);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.id).toBe(2);
      expect(rows[1]!.id).toBe(3);
    });

    it("handles Infinity upToId", () => {
      store.createChannel("ch", "ctx", "user");
      store.insert("ch", "message", '{"text":"1"}', "u", 1);
      store.insert("ch", "message", '{"text":"2"}', "u", 2);

      const rows = store.queryRange("ch", 0, Infinity);
      expect(rows).toHaveLength(2);
    });
  });

  describe("getMessageCount (fork-aware)", () => {
    it("sums counts across fork chain", () => {
      store.createChannel("root", "ctx", "user");
      // Insert 3 messages in root (ids 1, 2, 3)
      store.insert("root", "message", '{"text":"r1"}', "u", 1);
      store.insert("root", "message", '{"text":"r2"}', "u", 2);
      store.insert("root", "message", '{"text":"r3"}', "u", 3);

      // Fork at message 2 — only root messages 1, 2 are inherited
      store.createChannel("fork-1", "ctx", "user");
      store.setChannelFork("fork-1", "root", 2);

      // Insert 2 messages in fork (ids 4, 5)
      store.insert("fork-1", "message", '{"text":"f1"}', "u", 4);
      store.insert("fork-1", "message", '{"text":"f2"}', "u", 5);

      // Fork-aware count for fork-1: 2 (from root) + 2 (from fork-1) = 4
      expect(store.getMessageCount("fork-1")).toBe(4);

      // Root count unchanged: 3
      expect(store.getMessageCount("root")).toBe(3);
    });

    it("sums counts across 3-level chain with type filter", () => {
      store.createChannel("root", "ctx", "user");
      store.insert("root", "message", '{"text":"r1"}', "u", 1);
      store.insert("root", "presence", '{"action":"join"}', "u", 2);
      store.insert("root", "message", '{"text":"r2"}', "u", 3);

      store.createChannel("fork-1", "ctx", "user");
      store.setChannelFork("fork-1", "root", 3);
      store.insert("fork-1", "message", '{"text":"f1"}', "u", 4);

      store.createChannel("fork-2", "ctx", "user");
      store.setChannelFork("fork-2", "fork-1", 4);
      store.insert("fork-2", "message", '{"text":"f2-1"}', "u", 5);

      // Fork-aware message count for fork-2:
      // root (up to id 3): 2 messages (ids 1, 3) — presence excluded by type filter
      // fork-1 (up to id 4): 1 message (id 4)
      // fork-2 (all): 1 message (id 5)
      // Total: 4
      expect(store.getMessageCount("fork-2", "message")).toBe(4);
    });
  });

  describe("getMinMessageId (fork-aware)", () => {
    it("finds min across fork chain", () => {
      store.createChannel("root", "ctx", "user");
      store.insert("root", "message", '{"text":"r1"}', "u", 1);  // id 1
      store.insert("root", "message", '{"text":"r2"}', "u", 2);  // id 2

      store.createChannel("fork-1", "ctx", "user");
      store.setChannelFork("fork-1", "root", 2);
      store.insert("fork-1", "message", '{"text":"f1"}', "u", 3);  // id 3

      // Min across fork-1 chain should be 1 (from root)
      expect(store.getMinMessageId("fork-1", "message")).toBe(1);
    });
  });

  describe("queryBefore (fork-aware)", () => {
    it("paginates across fork boundary", () => {
      store.createChannel("root", "ctx", "user");
      // Insert messages in root: ids 1, 2, 3
      store.insert("root", "message", '{"text":"r1"}', "u", 1);
      store.insert("root", "message", '{"text":"r2"}', "u", 2);
      store.insert("root", "message", '{"text":"r3"}', "u", 3);

      // Fork at message 2
      store.createChannel("fork-1", "ctx", "user");
      store.setChannelFork("fork-1", "root", 2);

      // Insert messages in fork: ids 4, 5
      store.insert("fork-1", "message", '{"text":"f1"}', "u", 4);
      store.insert("fork-1", "message", '{"text":"f2"}', "u", 5);

      // queryBefore on fork-1 with beforeId=5, limit=3
      // Should get: root id 2, fork-1 id 4 (and NOT root id 3 since fork point is 2)
      const rows = store.queryBefore("fork-1", 5, 3);
      expect(rows).toHaveLength(3);
      expect(rows[0]!.id).toBe(1); // root
      expect(rows[1]!.id).toBe(2); // root (fork boundary)
      expect(rows[2]!.id).toBe(4); // fork-1
    });

    it("limits results correctly across segments", () => {
      store.createChannel("root", "ctx", "user");
      for (let i = 0; i < 5; i++) {
        store.insert("root", "message", `{"text":"r${i}"}`, "u", i);
      }

      store.createChannel("fork-1", "ctx", "user");
      store.setChannelFork("fork-1", "root", 3);

      for (let i = 0; i < 5; i++) {
        store.insert("fork-1", "message", `{"text":"f${i}"}`, "u", 10 + i);
      }

      // Query before id 100, limit 4 — should get last 4 messages across chain
      const rows = store.queryBefore("fork-1", 100, 4);
      expect(rows).toHaveLength(4);
      // Should be the last 4 messages: fork-1 ids 7, 8, 9, 10 (the fork messages)
    });
  });

  describe("getAnchorId (fork-aware)", () => {
    it("walks segments for Nth-from-last", () => {
      store.createChannel("root", "ctx", "user");
      store.insert("root", "message", '{"text":"r1"}', "u", 1);  // id 1
      store.insert("root", "message", '{"text":"r2"}', "u", 2);  // id 2

      store.createChannel("fork-1", "ctx", "user");
      store.setChannelFork("fork-1", "root", 2);
      store.insert("fork-1", "message", '{"text":"f1"}', "u", 3);  // id 3

      // Offset 0 = last message of type "message" = id 3 (fork-1)
      expect(store.getAnchorId("fork-1", "message", 0)).toBe(3);

      // Offset 1 = second-from-last = id 2 (root)
      expect(store.getAnchorId("fork-1", "message", 1)).toBe(2);

      // Offset 2 = third-from-last = id 1 (root)
      expect(store.getAnchorId("fork-1", "message", 2)).toBe(1);

      // Offset 3 = out of range
      expect(store.getAnchorId("fork-1", "message", 3)).toBeNull();
    });

    it("respects fork boundary — does not include parent messages beyond fork point", () => {
      store.createChannel("root", "ctx", "user");
      store.insert("root", "message", '{"text":"r1"}', "u", 1);  // id 1
      store.insert("root", "message", '{"text":"r2"}', "u", 2);  // id 2
      store.insert("root", "message", '{"text":"r3"}', "u", 3);  // id 3

      store.createChannel("fork-1", "ctx", "user");
      store.setChannelFork("fork-1", "root", 2);  // Fork after id 2

      // fork-1 sees root messages 1 and 2 only (not 3)
      // getAnchorId offset 0 = last = id 2 (from root, since fork-1 has no own messages)
      expect(store.getAnchorId("fork-1", "message", 0)).toBe(2);
      expect(store.getAnchorId("fork-1", "message", 1)).toBe(1);
      expect(store.getAnchorId("fork-1", "message", 2)).toBeNull();
    });
  });

  describe("queryTrailingUpdates (fork-aware)", () => {
    it("finds updates across fork segments", () => {
      store.createChannel("root", "ctx", "user");
      const id1 = store.insert("root", "message", '{"id":"msg-1","text":"hello"}', "u", 1);
      const id2 = store.insert("root", "update-message", '{"id":"msg-1","text":"updated"}', "u", 2);

      store.createChannel("fork-1", "ctx", "user");
      store.setChannelFork("fork-1", "root", 2);
      const id3 = store.insert("fork-1", "update-message", '{"id":"msg-1","text":"updated again"}', "u", 3);

      // Query trailing updates for msg-1 from fork-1 perspective
      const updates = store.queryTrailingUpdates("fork-1", ["msg-1"], id1 + 1);
      expect(updates).toHaveLength(2);
      expect(updates[0]!.id).toBe(id2);
      expect(updates[1]!.id).toBe(id3);
    });
  });
});

describe("Fork-aware replay via PubSubServer", () => {
  let server: PubSubServer;
  let port: number;
  let messageStore: InMemoryMessageStore;
  let tokenValidator: TestTokenValidator;
  const openClients: WebSocket[] = [];

  beforeAll(async () => {
    messageStore = new InMemoryMessageStore();
    tokenValidator = new TestTokenValidator();
    tokenValidator.addToken("valid-token", "test-client");
    tokenValidator.addToken("client-a-token", "client-a");
    tokenValidator.addToken("client-b-token", "client-b");

    server = new PubSubServer({
      tokenValidator,
      messageStore,
      port: 0,
    });

    port = await server.start();
  });

  afterAll(async () => {
    for (const client of openClients) {
      client.close();
    }
    openClients.length = 0;
    await server.stop();
  });

  afterEach(async () => {
    for (const client of openClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
    }
    openClients.length = 0;
    await new Promise((r) => setTimeout(r, 50));
    messageStore.clear();
  });

  interface ClientConn {
    ws: WebSocket;
    messages: object[];
  }

  const createClient = (
    token: string,
    channel: string,
    sinceId?: number,
    contextId = "ctx-test"
  ): Promise<ClientConn> => {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({ token, channel, contextId });
      if (sinceId !== undefined) {
        params.set("sinceId", String(sinceId));
      }
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?${params.toString()}`);
      openClients.push(ws);
      const messages: object[] = [];
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
      });
      ws.on("open", () => resolve({ ws, messages }));
      ws.on("error", reject);
    });
  };

  const waitForMessage = (
    client: ClientConn,
    timeoutMs = 2000
  ): Promise<Record<string, unknown>> => {
    return new Promise((resolve, reject) => {
      if (client.messages.length > 0) {
        resolve(client.messages.shift()! as Record<string, unknown>);
        return;
      }
      const timeout = setTimeout(
        () => reject(new Error("Message timeout")),
        timeoutMs
      );
      const checkInterval = setInterval(() => {
        if (client.messages.length > 0) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve(client.messages.shift()! as Record<string, unknown>);
        }
      }, 10);
    });
  };

  const drainUntilReady = async (client: ClientConn): Promise<Record<string, unknown>[]> => {
    const collected: Record<string, unknown>[] = [];
    while (true) {
      const msg = await waitForMessage(client);
      collected.push(msg);
      if (msg["kind"] === "ready") break;
    }
    return collected;
  };

  it("replays parent history + child messages on forked channel", async () => {
    // Setup: publish 3 messages to root channel
    const rootClient = await createClient("client-a-token", "root-replay");
    await drainUntilReady(rootClient);
    await waitForMessage(rootClient); // join presence

    for (let i = 1; i <= 3; i++) {
      rootClient.ws.send(JSON.stringify({
        action: "publish",
        type: "message",
        payload: { text: `msg-${i}` },
      }));
      await waitForMessage(rootClient); // persisted
    }

    rootClient.ws.close();
    await new Promise((r) => setTimeout(r, 100));

    // Get the IDs — all messages in the store
    const allMsgs = messageStore.getAll().filter(m => m.type === "message" && m.channel === "root-replay");
    expect(allMsgs).toHaveLength(3);
    const forkPointId = allMsgs[1]!.id; // Fork after 2nd message

    // Create forked channel and set fork metadata
    messageStore.createChannel("fork-replay", "ctx-test", "client-b");
    messageStore.setChannelFork("fork-replay", "root-replay", forkPointId);

    // Insert messages in the fork directly
    messageStore.insert("fork-replay", "message", '{"text":"fork-msg-1"}', "client-b", Date.now());

    // Connect to the forked channel with sinceId=0 (full replay)
    const forkClient = await createClient("client-b-token", "fork-replay", 0);
    const messages = await drainUntilReady(forkClient);

    // Filter to replay messages (not presence, not ready)
    const replays = messages.filter(m => m["kind"] === "replay" && m["type"] !== "presence");

    // Should see: root msg-1, root msg-2 (up to fork point), fork-msg-1
    expect(replays).toHaveLength(3);
    expect((replays[0]!["payload"] as { text: string }).text).toBe("msg-1");
    expect((replays[1]!["payload"] as { text: string }).text).toBe("msg-2");
    expect((replays[2]!["payload"] as { text: string }).text).toBe("fork-msg-1");

    // Should NOT include root msg-3 (beyond fork point)
    const msg3Replay = replays.find(m => (m["payload"] as { text: string }).text === "msg-3");
    expect(msg3Replay).toBeUndefined();
  });

  it("ready metadata is fork-aware", async () => {
    // Setup root with messages
    messageStore.createChannel("root-meta", "ctx-test", "user");
    messageStore.insert("root-meta", "message", '{"text":"r1"}', "u", 1);
    messageStore.insert("root-meta", "message", '{"text":"r2"}', "u", 2);
    const id3 = messageStore.insert("root-meta", "message", '{"text":"r3"}', "u", 3);

    // Fork at id 2 — root messages 1, 2 inherited
    messageStore.createChannel("fork-meta", "ctx-test", "user");
    messageStore.setChannelFork("fork-meta", "root-meta", allMsgId(2));
    messageStore.insert("fork-meta", "message", '{"text":"f1"}', "u", 4);

    function allMsgId(n: number): number {
      const all = messageStore.getAll().filter(m => m.channel === "root-meta" && m.type === "message");
      return all[n - 1]!.id;
    }

    const client = await createClient("valid-token", "fork-meta", 0);
    const messages = await drainUntilReady(client);

    const ready = messages.find(m => m["kind"] === "ready") as Record<string, unknown>;
    // totalCount should include fork chain: 2 (root, up to fork point) + 1 (fork) = 3
    // chatMessageCount should be 3 as well (all are "message" type)
    expect(ready["chatMessageCount"]).toBe(3);
    // firstChatMessageId should be the min across the chain
    const firstId = messageStore.getAll().filter(m => m.type === "message")[0]!.id;
    expect(ready["firstChatMessageId"]).toBe(firstId);
  });

  it("presence events are NOT inherited from parent channel", async () => {
    // Setup root with presence events
    messageStore.createChannel("root-presence", "ctx-test", "user");
    messageStore.insert("root-presence", "presence", '{"action":"join","metadata":{}}', "other-user", 1);
    messageStore.insert("root-presence", "message", '{"text":"hello"}', "other-user", 2);

    // Fork
    messageStore.createChannel("fork-presence", "ctx-test", "user");
    messageStore.setChannelFork("fork-presence", "root-presence", 2);

    // Connect to fork with full replay
    const client = await createClient("valid-token", "fork-presence", 0);
    const messages = await drainUntilReady(client);

    // Presence from root should NOT appear in replay (replayed only from fork-presence itself)
    const presenceReplays = messages.filter(m => m["kind"] === "replay" && m["type"] === "presence");
    // There should be no presence replays from the parent
    for (const p of presenceReplays) {
      expect(p["senderId"]).not.toBe("other-user");
    }

    // The "message" type message from root SHOULD be replayed
    const msgReplays = messages.filter(m => m["kind"] === "replay" && m["type"] === "message");
    expect(msgReplays).toHaveLength(1);
    expect((msgReplays[0]!["payload"] as { text: string }).text).toBe("hello");
  });

  it("sinceId works across fork boundaries", async () => {
    // Setup root with messages
    messageStore.createChannel("root-since", "ctx-test", "user");
    const r1 = messageStore.insert("root-since", "message", '{"text":"r1"}', "u", 1);
    const r2 = messageStore.insert("root-since", "message", '{"text":"r2"}', "u", 2);

    // Fork at r2
    messageStore.createChannel("fork-since", "ctx-test", "user");
    messageStore.setChannelFork("fork-since", "root-since", r2);
    const f1 = messageStore.insert("fork-since", "message", '{"text":"f1"}', "u", 3);

    // Connect with sinceId = r1 (should skip r1, get r2 and f1)
    const client = await createClient("valid-token", "fork-since", r1);
    const messages = await drainUntilReady(client);
    const replays = messages.filter(m => m["kind"] === "replay" && m["type"] === "message");

    expect(replays).toHaveLength(2);
    expect((replays[0]!["payload"] as { text: string }).text).toBe("r2");
    expect((replays[1]!["payload"] as { text: string }).text).toBe("f1");
  });
});
