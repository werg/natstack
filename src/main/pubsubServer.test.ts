/**
 * Tests for the PubSub WebSocket server.
 *
 * Uses the real PubSubServer with injected test dependencies (InMemoryMessageStore,
 * TestTokenValidator) to test the actual implementation rather than a mock.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import WebSocket from "ws";
import {
  PubSubServer,
  InMemoryMessageStore,
  TestTokenValidator,
} from "./pubsubServer.js";

describe("PubSub Server", () => {
  let server: PubSubServer;
  let port: number;
  let messageStore: InMemoryMessageStore;
  let tokenValidator: TestTokenValidator;
  const openClients: WebSocket[] = [];

  beforeAll(async () => {
    messageStore = new InMemoryMessageStore();
    tokenValidator = new TestTokenValidator();

    // Set up test tokens
    tokenValidator.addToken("valid-token", "test-client-id");
    tokenValidator.addToken("client-a-token", "client-a");
    tokenValidator.addToken("client-b-token", "client-b");

    server = new PubSubServer({
      tokenValidator,
      messageStore,
      port: 0, // Let OS assign a port
    });

    port = await server.start();
  });

  afterAll(async () => {
    // Close all client connections
    for (const client of openClients) {
      client.close();
    }
    openClients.length = 0;
    await server.stop();
  });

  afterEach(async () => {
    // Close clients opened during test
    for (const client of openClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
    }
    openClients.length = 0;
    // Give time for cleanup
    await new Promise((r) => setTimeout(r, 50));
    // Clear message store between tests to prevent cross-test pollution
    messageStore.clear();
  });

  interface ClientConnection {
    ws: WebSocket;
    messages: object[];
  }

  const createClient = (
    token: string,
    channel: string,
    sinceId?: number
  ): Promise<ClientConnection> => {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({ token, channel });
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
    client: ClientConnection,
    timeoutMs = 2000
  ): Promise<object> => {
    return new Promise((resolve, reject) => {
      if (client.messages.length > 0) {
        resolve(client.messages.shift()!);
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
          resolve(client.messages.shift()!);
        }
      }, 10);
    });
  };

  it("sends ready message on valid connection", async () => {
    const client = await createClient("valid-token", "test-channel");
    const msg = await waitForMessage(client);
    expect(msg).toEqual({ kind: "ready" });
  });

  it("rejects connections with invalid token", async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/?token=invalid&channel=test`
      );
      openClients.push(ws);
      const timeout = setTimeout(() => reject(new Error("Close timeout")), 2000);
      ws.on("close", (code, reason) => {
        clearTimeout(timeout);
        expect(code).toBe(4001);
        expect(reason.toString()).toBe("unauthorized");
        resolve();
      });
      ws.on("error", () => {}); // Ignore connection errors
    });
  });

  it("rejects connections without channel", async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=valid-token`);
      openClients.push(ws);
      const timeout = setTimeout(() => reject(new Error("Close timeout")), 2000);
      ws.on("close", (code, reason) => {
        clearTimeout(timeout);
        expect(code).toBe(4002);
        expect(reason.toString()).toBe("channel required");
        resolve();
      });
      ws.on("error", () => {}); // Ignore connection errors
    });
  });

  it("returns persisted message with id when persist=true", async () => {
    const client = await createClient("valid-token", "test-channel");
    await waitForMessage(client); // ready
    await waitForMessage(client); // join presence

    client.ws.send(
      JSON.stringify({
        action: "publish",
        type: "test-msg",
        payload: { data: "hello" },
        persist: true,
        ref: 1,
      })
    );

    const response = (await waitForMessage(client)) as {
      kind: string;
      id?: number;
      ref?: number;
    };
    expect(response.kind).toBe("persisted");
    expect(response.id).toBeDefined();
    expect(response.id).toBeGreaterThan(0);
    expect(response.ref).toBe(1);
  });

  it("returns ephemeral message without id when persist=false", async () => {
    const client = await createClient("valid-token", "test-channel");
    await waitForMessage(client); // ready
    await waitForMessage(client); // join presence

    client.ws.send(
      JSON.stringify({
        action: "publish",
        type: "typing",
        payload: {},
        persist: false,
        ref: 2,
      })
    );

    const response = (await waitForMessage(client)) as {
      kind: string;
      id?: number;
      ref?: number;
    };
    expect(response.kind).toBe("ephemeral");
    expect(response.id).toBeUndefined();
    expect(response.ref).toBe(2);
  });

  it("broadcasts to all channel subscribers", async () => {
    const clientA = await createClient("client-a-token", "chat");
    const clientB = await createClient("client-b-token", "chat");

    await waitForMessage(clientA); // ready
    await waitForMessage(clientA); // join presence (A)
    await waitForMessage(clientB); // replay join (A)
    await waitForMessage(clientB); // ready
    await waitForMessage(clientB); // join presence (B)
    await waitForMessage(clientA); // join presence (B)

    clientA.ws.send(
      JSON.stringify({
        action: "publish",
        type: "message",
        payload: { text: "Hello from A" },
        ref: 1,
      })
    );

    const [msgA, msgB] = (await Promise.all([
      waitForMessage(clientA),
      waitForMessage(clientB),
    ])) as [{ senderId: string; ref?: number }, { senderId: string; ref?: number }];

    expect(msgA.senderId).toBe("client-a");
    expect(msgA.ref).toBe(1); // Sender gets ref

    expect(msgB.senderId).toBe("client-a");
    expect(msgB.ref).toBeUndefined(); // Others don't get ref
  });

  it("returns error for invalid JSON", async () => {
    const client = await createClient("valid-token", "test-channel");
    await waitForMessage(client); // ready
    await waitForMessage(client); // join presence

    client.ws.send("not json");

    const response = (await waitForMessage(client)) as {
      kind: string;
      error: string;
    };
    expect(response.kind).toBe("error");
    expect(response.error).toBe("invalid message format");
  });

  it("returns error for unknown action", async () => {
    const client = await createClient("valid-token", "test-channel");
    await waitForMessage(client); // ready
    await waitForMessage(client); // join presence

    client.ws.send(JSON.stringify({ action: "unknown" }));

    const response = (await waitForMessage(client)) as {
      kind: string;
      error: string;
    };
    expect(response.kind).toBe("error");
    expect(response.error).toBe("unknown action");
  });

  it("returns error with ref when publish fails", async () => {
    const client = await createClient("valid-token", "test-channel");
    await waitForMessage(client); // ready
    await waitForMessage(client); // join presence

    client.ws.send(JSON.stringify({ action: "unknown", ref: 42 }));

    const response = (await waitForMessage(client)) as {
      kind: string;
      error: string;
      ref?: number;
    };
    expect(response.kind).toBe("error");
    expect(response.error).toBe("unknown action");
    expect(response.ref).toBe(42);
  });

  it("replays persisted messages when sinceId is provided", async () => {
    const replayChannel = "replay-test-" + Date.now();

    // First client publishes some messages
    const client1 = await createClient("valid-token", replayChannel);
    await waitForMessage(client1); // ready
    await waitForMessage(client1); // join presence

    // Publish 3 messages
    client1.ws.send(
      JSON.stringify({
        action: "publish",
        type: "msg",
        payload: { text: "message 1" },
      })
    );
    const msg1 = (await waitForMessage(client1)) as { id: number };

    client1.ws.send(
      JSON.stringify({
        action: "publish",
        type: "msg",
        payload: { text: "message 2" },
      })
    );
    const msg2 = (await waitForMessage(client1)) as { id: number };

    client1.ws.send(
      JSON.stringify({
        action: "publish",
        type: "msg",
        payload: { text: "message 3" },
      })
    );
    const msg3 = (await waitForMessage(client1)) as { id: number };

    client1.ws.close();
    // Wait for leave presence to be persisted
    await new Promise((r) => setTimeout(r, 100));

    // Second client connects with sinceId = msg1.id (should get msg2 and msg3)
    const client2 = await createClient("valid-token", replayChannel, msg1.id);

    // Roster ops replay: join + leave presence for client1
    const replayJoin = (await waitForMessage(client2)) as {
      kind: string;
      type?: string;
      payload?: { action?: string };
    };
    const replayLeave = (await waitForMessage(client2)) as {
      kind: string;
      type?: string;
      payload?: { action?: string };
    };
    // Message replays (sinceId filters to msg2 and msg3)
    // Note: leave presence may be replayed again by replayMessages if its id > sinceId
    const replay1 = (await waitForMessage(client2)) as {
      kind: string;
      id: number;
      type?: string;
      payload: { text?: string };
    };
    const replay2 = (await waitForMessage(client2)) as {
      kind: string;
      id: number;
      type?: string;
      payload: { text?: string };
    };
    // Leave presence may be replayed again (id > sinceId)
    const replay3 = (await waitForMessage(client2)) as {
      kind: string;
      type?: string;
    };
    const ready = (await waitForMessage(client2)) as { kind: string };
    const joinPresence = (await waitForMessage(client2)) as { kind: string; type?: string };

    expect(replayJoin.kind).toBe("replay");
    expect(replayJoin.type).toBe("presence");
    expect(replayJoin.payload?.action).toBe("join");
    expect(replayLeave.kind).toBe("replay");
    expect(replayLeave.type).toBe("presence");
    expect(replayLeave.payload?.action).toBe("leave");
    expect(replay1.kind).toBe("replay");
    expect(replay1.id).toBe(msg2.id);
    expect(replay1.payload.text).toBe("message 2");

    expect(replay2.kind).toBe("replay");
    expect(replay2.id).toBe(msg3.id);
    expect(replay2.payload.text).toBe("message 3");

    // Leave presence replayed again (its id > sinceId)
    expect(replay3.kind).toBe("replay");
    expect(replay3.type).toBe("presence");

    expect(ready.kind).toBe("ready");
    expect(joinPresence.kind).toBe("persisted");
  });

  it("stores messages in the message store", async () => {
    const storeChannel = "store-test-" + Date.now();
    const client = await createClient("valid-token", storeChannel);
    await waitForMessage(client); // ready
    await waitForMessage(client); // join presence

    client.ws.send(
      JSON.stringify({
        action: "publish",
        type: "test",
        payload: { value: 123 },
      })
    );

    await waitForMessage(client); // persisted response

    // Check the message was stored (filter by type to skip presence messages)
    const stored = messageStore.getAll();
    const ourMessage = stored.find((m) => m.channel === storeChannel && m.type === "test");
    expect(ourMessage).toBeDefined();
    expect(ourMessage!.type).toBe("test");
    expect(JSON.parse(ourMessage!.payload)).toEqual({ value: 123 });
  });

  describe("presence", () => {
    it("sends join presence after ready when client connects", async () => {
      const presenceChannel = "presence-join-" + Date.now();
      const client = await createClient("valid-token", presenceChannel);

      const ready = await waitForMessage(client);
      expect(ready).toEqual({ kind: "ready" });

      const join = (await waitForMessage(client)) as {
        kind: string;
        type?: string;
        payload?: { action?: string; metadata?: Record<string, unknown> };
        senderId?: string;
      };

      expect(join.kind).toBe("persisted");
      expect(join.type).toBe("presence");
      expect(join.payload?.action).toBe("join");
      expect(join.senderId).toBe("test-client-id");
    });

    it("replays presence history to new joiners", async () => {
      const presenceChannel = "presence-history-" + Date.now();

      const clientA = await createClient("client-a-token", presenceChannel);
      await waitForMessage(clientA); // ready
      await waitForMessage(clientA); // join presence (A)

      const clientB = await createClient("client-b-token", presenceChannel);
      const replay = (await waitForMessage(clientB)) as {
        kind: string;
        type?: string;
        senderId?: string;
      };
      const ready = (await waitForMessage(clientB)) as { kind: string };
      const joinB = (await waitForMessage(clientB)) as { kind: string; senderId?: string };
      const joinForA = (await waitForMessage(clientA)) as { kind: string; senderId?: string };

      expect(replay.kind).toBe("replay");
      expect(replay.type).toBe("presence");
      expect(replay.senderId).toBe("client-a");
      expect(ready.kind).toBe("ready");
      expect(joinB.kind).toBe("persisted");
      expect(joinB.senderId).toBe("client-b");
      expect(joinForA.senderId).toBe("client-b");
    });

    it("broadcasts leave presence when last connection closes", async () => {
      const presenceChannel = "presence-leave-" + Date.now();

      const clientA = await createClient("client-a-token", presenceChannel);
      await waitForMessage(clientA); // ready
      await waitForMessage(clientA); // join presence (A)

      const clientB = await createClient("client-b-token", presenceChannel);
      await waitForMessage(clientB); // replay join (A)
      await waitForMessage(clientB); // ready
      await waitForMessage(clientB); // join presence (B)
      await waitForMessage(clientA); // join presence (B)

      clientB.ws.close();

      const leave = (await waitForMessage(clientA)) as {
        kind: string;
        type?: string;
        payload?: { action?: string };
        senderId?: string;
      };

      expect(leave.kind).toBe("persisted");
      expect(leave.type).toBe("presence");
      expect(leave.payload?.action).toBe("leave");
      expect(leave.senderId).toBe("client-b");
    });

    it("includes metadata in presence payloads", async () => {
      const presenceChannel = "presence-metadata-" + Date.now();

      const metadata = { name: "Alice", status: "online" };
      const params = new URLSearchParams({
        token: "client-a-token",
        channel: presenceChannel,
      });
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?${params.toString()}`);
      openClients.push(ws);
      const messages: object[] = [];
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
      });

      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });

      // Send metadata via update-metadata action (not URL params)
      ws.send(JSON.stringify({
        action: "update-metadata",
        payload: metadata,
        ref: 1,
      }));

      await new Promise((r) => setTimeout(r, 100));
      const presence = messages.find(
        (m) => (m as { type?: string }).type === "presence" &&
          (m as { payload?: { action?: string } }).payload?.action === "update"
      ) as {
        payload?: { metadata?: Record<string, unknown> };
      };

      expect(presence).toBeDefined();
      expect(presence.payload?.metadata).toEqual(metadata);
    });
  });

  describe("agent protocol", () => {
    it("returns empty agents list when agentHost not set", async () => {
      // Server doesn't have agentHost set in this test suite
      const client = await createClient("valid-token", "agent-test-1");
      await waitForMessage(client); // ready
      await waitForMessage(client); // join presence

      client.ws.send(JSON.stringify({ action: "list-agents", ref: 1 }));

      const response = (await waitForMessage(client)) as {
        kind: string;
        ref: number;
        agents: unknown[];
      };

      expect(response.kind).toBe("list-agents-response");
      expect(response.ref).toBe(1);
      expect(response.agents).toEqual([]);
    });

    it("returns error when list-agents called without ref", async () => {
      const client = await createClient("valid-token", "agent-test-2");
      await waitForMessage(client); // ready
      await waitForMessage(client); // join presence

      client.ws.send(JSON.stringify({ action: "list-agents" })); // no ref

      const response = (await waitForMessage(client)) as {
        kind: string;
        error?: string;
      };

      expect(response.kind).toBe("error");
      expect(response.error).toContain("ref required");
    });

    it("returns error when invite-agent called without agentHost", async () => {
      const client = await createClient("valid-token", "agent-test-3");
      await waitForMessage(client); // ready
      await waitForMessage(client); // join presence

      client.ws.send(JSON.stringify({
        action: "invite-agent",
        ref: 1,
        agentId: "test-agent",
      }));

      const response = (await waitForMessage(client)) as {
        kind: string;
        ref: number;
        success: boolean;
        error?: string;
      };

      expect(response.kind).toBe("invite-agent-response");
      expect(response.ref).toBe(1);
      expect(response.success).toBe(false);
      expect(response.error).toContain("not initialized");
    });

    it("returns empty channel agents when agentHost not set", async () => {
      const client = await createClient("valid-token", "agent-test-4");
      await waitForMessage(client); // ready
      await waitForMessage(client); // join presence

      client.ws.send(JSON.stringify({ action: "channel-agents", ref: 1 }));

      const response = (await waitForMessage(client)) as {
        kind: string;
        ref: number;
        agents: unknown[];
      };

      expect(response.kind).toBe("channel-agents-response");
      expect(response.ref).toBe(1);
      expect(response.agents).toEqual([]);
    });

    it("returns error when remove-agent called without agentHost", async () => {
      const client = await createClient("valid-token", "agent-test-5");
      await waitForMessage(client); // ready
      await waitForMessage(client); // join presence

      client.ws.send(JSON.stringify({
        action: "remove-agent",
        ref: 1,
        instanceId: "some-instance",
      }));

      const response = (await waitForMessage(client)) as {
        kind: string;
        ref: number;
        success: boolean;
        error?: string;
      };

      expect(response.kind).toBe("remove-agent-response");
      expect(response.ref).toBe(1);
      expect(response.success).toBe(false);
      expect(response.error).toContain("not initialized");
    });

    it("returns error when channel-agents called without ref", async () => {
      const client = await createClient("valid-token", "agent-test-6");
      await waitForMessage(client); // ready
      await waitForMessage(client); // join presence

      client.ws.send(JSON.stringify({ action: "channel-agents" })); // no ref

      const response = (await waitForMessage(client)) as {
        kind: string;
        error?: string;
      };

      expect(response.kind).toBe("error");
      expect(response.error).toContain("ref required");
    });
  });
});
