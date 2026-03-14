/**
 * Tests for the PubSub server HTTP API endpoints.
 *
 * Uses a real PubSubServer with InMemoryMessageStore and TestTokenValidator.
 * Starts on a random port and makes real HTTP requests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  PubSubServer,
  InMemoryMessageStore,
  TestTokenValidator,
} from "./index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let server: PubSubServer;
let store: InMemoryMessageStore;
let port: number;
let baseUrl: string;
const token = "test-token-123";

/** Tiny HTTP servers used as POST-back callback targets. */
const callbackServers: HttpServer[] = [];

beforeEach(async () => {
  store = new InMemoryMessageStore();
  const tokenValidator = new TestTokenValidator();
  tokenValidator.addToken(token, "test-client", "server");

  server = new PubSubServer({
    tokenValidator,
    messageStore: store,
    port: 0,
  });
  port = await server.start();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await server.stop();
  // Close all callback target servers
  await Promise.all(
    callbackServers.map(
      (s) => new Promise<void>((resolve) => s.close(() => resolve()))
    )
  );
  callbackServers.length = 0;
});

async function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function get(path: string) {
  return fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Start a tiny HTTP server that records POSTs.
 * Returns { url, received, server }.
 * Also handles /onMethodCall and /onCallResult sub-paths.
 */
function startCallbackServer(): Promise<{
  url: string;
  port: number;
  received: Array<{ path: string; body: unknown }>;
  server: HttpServer;
  /** Wait until at least `n` requests have been received. */
  waitForRequests: (n: number, timeoutMs?: number) => Promise<void>;
  /** Set a handler that returns a custom response body for /onMethodCall */
  setMethodCallHandler: (handler: (body: unknown) => unknown) => void;
}> {
  const received: Array<{ path: string; body: unknown }> = [];
  let methodCallHandler: ((body: unknown) => unknown) | null = null;

  return new Promise((resolve) => {
    const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const bodyStr = Buffer.concat(chunks).toString("utf-8");
        let body: unknown;
        try {
          body = JSON.parse(bodyStr);
        } catch {
          body = bodyStr;
        }
        received.push({ path: req.url || "/", body });

        if (req.url === "/onMethodCall" && methodCallHandler) {
          const result = methodCallHandler(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });

    callbackServers.push(httpServer);

    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
        received,
        server: httpServer,
        waitForRequests: (n: number, timeoutMs = 3000) => {
          return new Promise<void>((resolve, reject) => {
            if (received.length >= n) {
              resolve();
              return;
            }
            const timeout = setTimeout(
              () => reject(new Error(`Timed out waiting for ${n} requests (got ${received.length})`)),
              timeoutMs
            );
            const interval = setInterval(() => {
              if (received.length >= n) {
                clearTimeout(timeout);
                clearInterval(interval);
                resolve();
              }
            }, 10);
          });
        },
        setMethodCallHandler: (handler: (body: unknown) => unknown) => {
          methodCallHandler = handler;
        },
      });
    });
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe("HTTP API auth", () => {
  it("rejects requests without Authorization header (401)", async () => {
    const res = await fetch(`${baseUrl}/channel/test-ch/participants`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/missing/i);
  });

  it("rejects requests with invalid token (401)", async () => {
    const res = await fetch(`${baseUrl}/channel/test-ch/participants`, {
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });
});

// ─── Channel operations ───────────────────────────────────────────────────────

describe("HTTP API channel operations", () => {
  const channelId = "test-ch";
  const participantId = "cb-participant-1";

  /** Register a callback participant for use in channel-operation tests. */
  let events: Array<{ type: string; payload: string; senderId: string }>;

  beforeEach(() => {
    events = [];
    server.registerParticipant(channelId, participantId, { name: "callback" }, {
      onEvent: (event) => {
        events.push({ type: event.type, payload: event.payload, senderId: event.senderId });
      },
    });
  });

  it("POST /channel/{id}/send — sends a message, visible in store", async () => {
    const res = await post(`/channel/${channelId}/send`, {
      participantId,
      messageId: "msg-001",
      content: "Hello from HTTP",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify message was persisted
    const stored = store.getAll();
    const msg = stored.find((m) => m.type === "message" && m.channel === channelId);
    expect(msg).toBeDefined();
    const payload = JSON.parse(msg!.payload);
    expect(payload.content).toBe("Hello from HTTP");
    expect(payload.id).toBe("msg-001");
  });

  it("POST /channel/{id}/update — updates a message", async () => {
    // Send first, then update
    await post(`/channel/${channelId}/send`, {
      participantId,
      messageId: "msg-002",
      content: "original",
    });

    const res = await post(`/channel/${channelId}/update`, {
      participantId,
      messageId: "msg-002",
      content: "updated content",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify update message was persisted
    const stored = store.getAll();
    const updates = stored.filter((m) => m.type === "update-message" && m.channel === channelId);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(updates[updates.length - 1]!.payload);
    expect(payload.content).toBe("updated content");
    expect(payload.id).toBe("msg-002");
  });

  it("POST /channel/{id}/complete — completes a message", async () => {
    await post(`/channel/${channelId}/send`, {
      participantId,
      messageId: "msg-003",
      content: "a message",
    });

    const res = await post(`/channel/${channelId}/complete`, {
      participantId,
      messageId: "msg-003",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify completion event was persisted
    const stored = store.getAll();
    const completions = stored.filter(
      (m) => m.type === "update-message" && m.channel === channelId
    );
    const last = completions[completions.length - 1]!;
    const payload = JSON.parse(last.payload);
    expect(payload.id).toBe("msg-003");
    expect(payload.complete).toBe(true);
  });

  it("POST /channel/{id}/send-ephemeral — sends with persist: false", async () => {
    const messageCountBefore = store
      .getAll()
      .filter((m) => m.type === "message" && m.channel === channelId).length;

    const res = await post(`/channel/${channelId}/send-ephemeral`, {
      participantId,
      content: "ephemeral content",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Ephemeral messages should NOT be persisted in the store
    const messageCountAfter = store
      .getAll()
      .filter((m) => m.type === "message" && m.channel === channelId).length;
    expect(messageCountAfter).toBe(messageCountBefore);
  });

  it("POST /channel/{id}/update-metadata — updates participant metadata", async () => {
    const res = await post(`/channel/${channelId}/update-metadata`, {
      participantId,
      metadata: { name: "new name", status: "busy" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify the presence update was persisted (MessageRow uses sender_id, not senderId)
    const stored = store.getAll();
    const presenceUpdates = stored.filter(
      (m) =>
        m.type === "presence" &&
        m.channel === channelId &&
        m.sender_id === participantId
    );
    // Should have at least the join + the update
    expect(presenceUpdates.length).toBeGreaterThanOrEqual(2);
    const last = presenceUpdates[presenceUpdates.length - 1]!;
    const payload = JSON.parse(last.payload);
    expect(payload.action).toBe("update");
    expect(payload.metadata).toEqual({ name: "new name", status: "busy" });
  });
});

// ─── Roster ───────────────────────────────────────────────────────────────────

describe("HTTP API roster", () => {
  it("GET /channel/{id}/participants — returns participant list", async () => {
    const channelId = "roster-ch";
    server.registerParticipant(channelId, "p1", { role: "agent" }, {
      onEvent: () => {},
    });
    server.registerParticipant(channelId, "p2", { role: "user" }, {
      onEvent: () => {},
    });

    const res = await get(`/channel/${channelId}/participants`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      participantId: string;
      metadata: Record<string, unknown>;
    }>;
    expect(body).toHaveLength(2);

    const ids = body.map((p) => p.participantId).sort();
    expect(ids).toEqual(["p1", "p2"]);

    const p1 = body.find((p) => p.participantId === "p1")!;
    expect(p1.metadata).toEqual({ role: "agent" });
  });

  it("GET /channel/{id}/participants — returns empty array for unknown channel", async () => {
    const res = await get(`/channel/nonexistent/participants`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

// ─── Subscribe + event delivery ───────────────────────────────────────────────

describe("HTTP API subscribe and event delivery", () => {
  it("POST /channel/{id}/subscribe registers a POST-back participant", async () => {
    const cb = await startCallbackServer();
    const channelId = "sub-ch";

    const res = await post(`/channel/${channelId}/subscribe`, {
      participantId: "postback-1",
      metadata: { kind: "test" },
      callbackUrl: cb.url,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // The participant should now appear in the roster
    const rosterRes = await get(`/channel/${channelId}/participants`);
    const roster = (await rosterRes.json()) as Array<{ participantId: string }>;
    expect(roster.some((p) => p.participantId === "postback-1")).toBe(true);
  });

  it("events are delivered via HTTP POST to callbackUrl", async () => {
    const cb = await startCallbackServer();
    const channelId = "delivery-ch";

    // Subscribe the callback target
    await post(`/channel/${channelId}/subscribe`, {
      participantId: "listener",
      metadata: { kind: "listener" },
      callbackUrl: cb.url,
    });

    // Register a second participant that will send a message
    const senderHandle = server.registerParticipant(
      channelId,
      "sender",
      { kind: "sender" },
      { onEvent: () => {} }
    );

    // Send a message from the sender
    senderHandle.sendMessage("msg-1", "hello callback", { persist: true });

    // Wait for callback to receive events (join presence + message)
    await cb.waitForRequests(2);

    // Find the message event delivery (skip presence events)
    const messageDelivery = cb.received.find((r) => {
      const arr = r.body as unknown[];
      if (!Array.isArray(arr) || arr.length < 2) return false;
      const evt = arr[1] as { type?: string };
      return evt.type === "message";
    });
    expect(messageDelivery).toBeDefined();

    // Verify the POST body is a JSON array [channelId, event]
    const [receivedChannel, event] = messageDelivery!.body as [string, { type: string; senderId: string }];
    expect(receivedChannel).toBe(channelId);
    expect(event.type).toBe("message");
    expect(event.senderId).toBe("sender");
  });

  it("events from self are NOT delivered to own callbackUrl", async () => {
    const cb = await startCallbackServer();
    const channelId = "self-skip-ch";

    // Subscribe
    await post(`/channel/${channelId}/subscribe`, {
      participantId: "self-poster",
      metadata: { kind: "test" },
      callbackUrl: cb.url,
    });

    // Send via HTTP using the subscribed participant's own ID
    await post(`/channel/${channelId}/send`, {
      participantId: "self-poster",
      messageId: "self-msg",
      content: "from self",
    });

    // Give a brief window for any unexpected delivery
    await new Promise((r) => setTimeout(r, 200));

    // Should NOT have received any message events (only join presence of self is skipped too)
    const messageDeliveries = cb.received.filter((r) => {
      const arr = r.body as unknown[];
      if (!Array.isArray(arr) || arr.length < 2) return false;
      const event = arr[1] as { type?: string };
      return event.type === "message";
    });
    expect(messageDeliveries).toHaveLength(0);
  });
});

// ─── Unsubscribe ──────────────────────────────────────────────────────────────

describe("HTTP API unsubscribe", () => {
  it("POST /channel/{id}/unsubscribe removes POST-back participant", async () => {
    const cb = await startCallbackServer();
    const channelId = "unsub-ch";

    // Subscribe first
    await post(`/channel/${channelId}/subscribe`, {
      participantId: "temp-sub",
      metadata: { kind: "temp" },
      callbackUrl: cb.url,
    });

    // Unsubscribe
    const res = await post(`/channel/${channelId}/unsubscribe`, {
      participantId: "temp-sub",
    });
    expect(res.status).toBe(200);

    // Register another participant and send a message
    const senderHandle = server.registerParticipant(
      channelId,
      "sender-2",
      { kind: "sender" },
      { onEvent: () => {} }
    );
    senderHandle.sendMessage("msg-after-unsub", "should not arrive", { persist: true });

    // Wait briefly for any unexpected delivery
    await new Promise((r) => setTimeout(r, 200));

    // No message events should have been delivered after unsubscribe
    const messageDeliveries = cb.received.filter((r) => {
      const arr = r.body as unknown[];
      if (!Array.isArray(arr) || arr.length < 2) return false;
      const event = arr[1] as { type?: string; senderId?: string };
      return event.type === "message" && event.senderId === "sender-2";
    });
    expect(messageDeliveries).toHaveLength(0);
  });

  it("unsubscribe for non-existent participant returns 404", async () => {
    const res = await post(`/channel/some-ch/unsubscribe`, {
      participantId: "not-registered",
    });
    expect(res.status).toBe(404);
  });
});

// ─── Cancel-call ──────────────────────────────────────────────────────────────

describe("HTTP API cancel-call", () => {
  it("POST /channel/{id}/cancel-call — returns cancelled field", async () => {
    // Without a pending call, cancelled should be false
    const res = await post(`/channel/any-ch/cancel-call`, {
      callId: "nonexistent-call",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; callId: string; cancelled: boolean };
    expect(body.ok).toBe(true);
    expect(body.callId).toBe("nonexistent-call");
    expect(body.cancelled).toBe(false);
  });

  it("cancel-call missing callId returns 400", async () => {
    const res = await post(`/channel/any-ch/cancel-call`, {});
    expect(res.status).toBe(400);
  });
});

// ─── Method calls ─────────────────────────────────────────────────────────────

describe("HTTP API call-method (POST-back to POST-back)", () => {
  it("call-method with POST-back target: posts to target, delivers result to caller", async () => {
    const channelId = "method-ch";
    const callerCb = await startCallbackServer();
    const targetCb = await startCallbackServer();

    // Target returns a result from /onMethodCall
    targetCb.setMethodCallHandler((body) => {
      // body is [channelId, callId, method, args]
      const [, , method, args] = body as [string, string, string, unknown];
      return { computed: `${method}(${JSON.stringify(args)})` };
    });

    // Subscribe both as POST-back participants
    await post(`/channel/${channelId}/subscribe`, {
      participantId: "caller-p",
      metadata: { role: "caller" },
      callbackUrl: callerCb.url,
    });
    await post(`/channel/${channelId}/subscribe`, {
      participantId: "target-p",
      metadata: { role: "target" },
      callbackUrl: targetCb.url,
    });

    // Initiate the method call
    const res = await post(`/channel/${channelId}/call-method`, {
      callerParticipantId: "caller-p",
      callerCallbackUrl: callerCb.url,
      targetParticipantId: "target-p",
      callId: "call-001",
      method: "doSomething",
      args: { x: 42 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; callId: string };
    expect(body.ok).toBe(true);
    expect(body.callId).toBe("call-001");

    // Wait for the target to receive /onMethodCall
    await targetCb.waitForRequests(1);
    const methodCallReq = targetCb.received.find((r) => r.path === "/onMethodCall");
    expect(methodCallReq).toBeDefined();
    const [mcChannel, mcCallId, mcMethod, mcArgs] = methodCallReq!.body as [string, string, string, unknown];
    expect(mcChannel).toBe(channelId);
    expect(mcCallId).toBe("call-001");
    expect(mcMethod).toBe("doSomething");
    expect(mcArgs).toEqual({ x: 42 });

    // Wait for the caller to receive /onCallResult
    // The caller may also receive presence events on /, so filter for /onCallResult
    await callerCb.waitForRequests(1);
    // Give a bit more time for the result POST to arrive
    await new Promise((r) => setTimeout(r, 200));

    const callResultReq = callerCb.received.find((r) => r.path === "/onCallResult");
    expect(callResultReq).toBeDefined();
    const [crCallId, crResult, crIsError] = callResultReq!.body as [string, unknown, boolean];
    expect(crCallId).toBe("call-001");
    expect(crResult).toEqual({ computed: 'doSomething({"x":42})' });
    expect(crIsError).toBe(false);
  });

  it("call-method missing required fields returns 400", async () => {
    const res = await post(`/channel/ch/call-method`, {
      callerParticipantId: "caller",
      // missing callerCallbackUrl, targetParticipantId, callId, method
    });
    expect(res.status).toBe(400);
  });
});

// ─── Error cases ──────────────────────────────────────────────────────────────

describe("HTTP API error cases", () => {
  it("send to non-existent participant returns 404", async () => {
    const res = await post(`/channel/some-ch/send`, {
      participantId: "ghost",
      messageId: "msg-x",
      content: "will fail",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/ghost/);
  });

  it("send with missing required fields returns 400", async () => {
    const res = await post(`/channel/some-ch/send`, {
      participantId: "p1",
      // missing messageId and content
    });
    expect(res.status).toBe(400);
  });

  it("update with missing required fields returns 400", async () => {
    const res = await post(`/channel/some-ch/update`, {
      participantId: "p1",
      messageId: "m1",
      // missing content
    });
    expect(res.status).toBe(400);
  });

  it("complete with missing required fields returns 400", async () => {
    const res = await post(`/channel/some-ch/complete`, {
      // missing participantId and messageId
    });
    expect(res.status).toBe(400);
  });

  it("send-ephemeral with missing required fields returns 400", async () => {
    const res = await post(`/channel/some-ch/send-ephemeral`, {
      participantId: "p1",
      // missing content
    });
    expect(res.status).toBe(400);
  });

  it("update-metadata with missing fields returns 400", async () => {
    const res = await post(`/channel/some-ch/update-metadata`, {
      participantId: "p1",
      // missing metadata
    });
    expect(res.status).toBe(400);
  });

  it("subscribe with missing fields returns 400", async () => {
    const res = await post(`/channel/some-ch/subscribe`, {
      participantId: "p1",
      // missing metadata and callbackUrl
    });
    expect(res.status).toBe(400);
  });

  it("unsubscribe with missing participantId returns 400", async () => {
    const res = await post(`/channel/some-ch/unsubscribe`, {});
    expect(res.status).toBe(400);
  });

  it("unknown action returns 404", async () => {
    const res = await post(`/channel/some-ch/nonexistent-action`, { foo: "bar" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown action/);
  });

  it("GET on a POST-only endpoint returns 405", async () => {
    const res = await get(`/channel/some-ch/send`);
    expect(res.status).toBe(405);
  });

  it("unknown top-level path returns 404", async () => {
    const res = await get(`/not-a-channel-route`);
    expect(res.status).toBe(404);
  });
});
