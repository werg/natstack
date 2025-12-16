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
    await waitForMessage(client); // roster

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
    await waitForMessage(client); // roster

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
    await waitForMessage(clientA); // initial roster
    await waitForMessage(clientB); // ready
    await waitForMessage(clientA); // updated roster (B joined)
    await waitForMessage(clientB); // roster

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
    await waitForMessage(client); // roster

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
    await waitForMessage(client); // roster

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
    await waitForMessage(client); // roster

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
    await waitForMessage(client1); // roster

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

    // Second client connects with sinceId = msg1.id (should get msg2 and msg3)
    const client2 = await createClient("valid-token", replayChannel, msg1.id);

    // Should receive replay messages before ready
    const replay1 = (await waitForMessage(client2)) as {
      kind: string;
      id: number;
      payload: { text: string };
    };
    const replay2 = (await waitForMessage(client2)) as {
      kind: string;
      id: number;
      payload: { text: string };
    };
    const ready = (await waitForMessage(client2)) as { kind: string };
    const roster = (await waitForMessage(client2)) as { kind: string };

    expect(replay1.kind).toBe("replay");
    expect(replay1.id).toBe(msg2.id);
    expect(replay1.payload.text).toBe("message 2");

    expect(replay2.kind).toBe("replay");
    expect(replay2.id).toBe(msg3.id);
    expect(replay2.payload.text).toBe("message 3");

    expect(ready.kind).toBe("ready");
    expect(roster.kind).toBe("roster");
  });

  it("stores messages in the message store", async () => {
    const storeChannel = "store-test-" + Date.now();
    const client = await createClient("valid-token", storeChannel);
    await waitForMessage(client); // ready
    await waitForMessage(client); // roster

    client.ws.send(
      JSON.stringify({
        action: "publish",
        type: "test",
        payload: { value: 123 },
      })
    );

    await waitForMessage(client); // persisted response

    // Check the message was stored
    const stored = messageStore.getAll();
    const ourMessage = stored.find((m) => m.channel === storeChannel);
    expect(ourMessage).toBeDefined();
    expect(ourMessage!.type).toBe("test");
    expect(JSON.parse(ourMessage!.payload)).toEqual({ value: 123 });
  });

  describe("roster / presence", () => {
    interface Participant {
      id: string;
      metadata: Record<string, unknown>;
    }

    it("sends roster message after ready when client connects", async () => {
      const rosterChannel = "roster-test-" + Date.now();
      const client = await createClient("valid-token", rosterChannel);

      const ready = await waitForMessage(client);
      expect(ready).toEqual({ kind: "ready" });

      const roster = (await waitForMessage(client)) as {
        kind: string;
        participants: Record<string, Participant>;
        ts: number;
      };
      expect(roster.kind).toBe("roster");
      expect(roster.participants["test-client-id"]).toBeDefined();
      expect(roster.participants["test-client-id"]!.id).toBe("test-client-id");
      expect(roster.ts).toBeDefined();
    });

    it("broadcasts updated roster when second client joins", async () => {
      const rosterChannel = "roster-join-" + Date.now();

      // First client connects
      const clientA = await createClient("client-a-token", rosterChannel);
      await waitForMessage(clientA); // ready
      const rosterA1 = (await waitForMessage(clientA)) as {
        kind: string;
        participants: Record<string, Participant>;
      };
      expect(rosterA1.kind).toBe("roster");
      expect(Object.keys(rosterA1.participants)).toEqual(["client-a"]);

      // Second client connects
      const clientB = await createClient("client-b-token", rosterChannel);
      await waitForMessage(clientB); // ready

      // Both clients should receive updated roster with both members
      const [rosterA2, rosterB1] = (await Promise.all([
        waitForMessage(clientA),
        waitForMessage(clientB),
      ])) as [
        { kind: string; participants: Record<string, Participant> },
        { kind: string; participants: Record<string, Participant> },
      ];

      expect(rosterA2.kind).toBe("roster");
      expect(Object.keys(rosterA2.participants).sort()).toEqual(["client-a", "client-b"]);

      expect(rosterB1.kind).toBe("roster");
      expect(Object.keys(rosterB1.participants).sort()).toEqual(["client-a", "client-b"]);
    });

    it("broadcasts updated roster when client disconnects", async () => {
      const rosterChannel = "roster-leave-" + Date.now();

      // Two clients connect
      const clientA = await createClient("client-a-token", rosterChannel);
      await waitForMessage(clientA); // ready
      await waitForMessage(clientA); // initial roster

      const clientB = await createClient("client-b-token", rosterChannel);
      await waitForMessage(clientB); // ready
      await waitForMessage(clientA); // roster update for A
      await waitForMessage(clientB); // roster for B

      // Client B disconnects
      clientB.ws.close();

      // Client A should receive roster with only themselves
      const rosterAfterLeave = (await waitForMessage(clientA)) as {
        kind: string;
        participants: Record<string, Participant>;
      };
      expect(rosterAfterLeave.kind).toBe("roster");
      expect(Object.keys(rosterAfterLeave.participants)).toEqual(["client-a"]);
    });

    it("roster contains unique client IDs even with multiple connections", async () => {
      const rosterChannel = "roster-unique-" + Date.now();

      // Same client connects twice (using same token/clientId)
      const conn1 = await createClient("client-a-token", rosterChannel);
      await waitForMessage(conn1); // ready
      const roster1 = (await waitForMessage(conn1)) as {
        kind: string;
        participants: Record<string, Participant>;
      };
      expect(Object.keys(roster1.participants)).toEqual(["client-a"]);

      const conn2 = await createClient("client-a-token", rosterChannel);
      await waitForMessage(conn2); // ready

      // Both connections receive roster update
      const [roster1Update, roster2] = (await Promise.all([
        waitForMessage(conn1),
        waitForMessage(conn2),
      ])) as [
        { kind: string; participants: Record<string, Participant> },
        { kind: string; participants: Record<string, Participant> },
      ];

      // Should still only show one client-a (deduplicated)
      expect(Object.keys(roster1Update.participants)).toEqual(["client-a"]);
      expect(Object.keys(roster2.participants)).toEqual(["client-a"]);
    });

    it("does not broadcast roster when last client in channel disconnects", async () => {
      const rosterChannel = "roster-empty-" + Date.now();

      const client = await createClient("valid-token", rosterChannel);
      await waitForMessage(client); // ready
      await waitForMessage(client); // roster

      // Close the connection - no one to receive the roster update
      client.ws.close();

      // No error should occur (channel is deleted when empty)
      // This test mainly ensures no crash happens
    });

    it("includes metadata in roster participants", async () => {
      const rosterChannel = "roster-metadata-" + Date.now();

      // Create client with metadata in URL
      const metadata = { name: "Alice", status: "online" };
      const params = new URLSearchParams({
        token: "client-a-token",
        channel: rosterChannel,
        metadata: JSON.stringify(metadata),
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

      // Wait for ready and roster
      await new Promise((r) => setTimeout(r, 100));
      const roster = messages.find(
        (m) => (m as { kind: string }).kind === "roster"
      ) as {
        kind: string;
        participants: Record<string, Participant>;
      };

      expect(roster).toBeDefined();
      expect(roster.participants["client-a"]).toBeDefined();
      expect(roster.participants["client-a"]!.metadata).toEqual(metadata);
    });
  });
});
