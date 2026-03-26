/**
 * Tests for the RPC-based PubSub client (connectViaRpc).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { connectViaRpc } from "./rpc-client.js";
import type { PubSubClient } from "./client.js";
import { z } from "zod";

const CHANNEL = "test-channel";
const DO_TARGET = `do:workers/pubsub-channel:PubSubChannel:${CHANNEL}`;
const SELF_ID = "panel-1";

// Valid UUIDs for method callIds (schema requires uuid format)
const CALL_ID_1 = "00000000-0000-4000-8000-000000000001";
const CALL_ID_SLOW = "00000000-0000-4000-8000-000000000002";

interface MockRpc {
  call: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  selfId: string;
}

/**
 * Creates a mock RPC object. The `onEvent` mock captures the listener
 * so tests can emit events by calling `emit(fromId, payload)`.
 */
function createMockRpc() {
  let eventListener: ((fromId: string, payload: unknown) => void) | null = null;
  const removeListener = vi.fn();

  const rpc: MockRpc = {
    call: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn().mockImplementation(
      (_event: string, listener: (fromId: string, payload: unknown) => void) => {
        eventListener = listener;
        return removeListener;
      },
    ),
    selfId: SELF_ID,
  };

  function emit(msg: Record<string, unknown>) {
    if (!eventListener) throw new Error("No event listener registered");
    eventListener("server", { channelId: CHANNEL, message: msg });
  }

  return { rpc, emit, removeListener };
}

/**
 * Helper: emit a sequence of replay presence joins, then a ready event,
 * with a microtask yield between to let the client process each.
 */
async function emitReplayAndReady(
  emit: (msg: Record<string, unknown>) => void,
  participants: Array<{ id: string; name: string; type: string }>,
  messages: Array<{ id: number; content: string; senderId: string }> = [],
) {
  // Emit presence join replay events for each participant
  for (const p of participants) {
    emit({
      kind: "replay",
      id: 100 + participants.indexOf(p),
      type: "presence",
      payload: { action: "join", metadata: { name: p.name, type: p.type } },
      senderId: p.id,
      ts: Date.now(),
    });
  }

  // Emit message replay events
  for (const m of messages) {
    emit({
      kind: "replay",
      id: m.id,
      type: "message",
      payload: { id: `msg-${m.id}`, content: m.content },
      senderId: m.senderId,
      ts: Date.now(),
    });
  }

  // Emit ready
  emit({
    kind: "ready",
    contextId: "ctx-123",
    channelConfig: { title: "Test Channel" },
    totalCount: messages.length,
    chatMessageCount: messages.length,
  });
}

describe("connectViaRpc", () => {
  let mockRpc: MockRpc;
  let emit: (msg: Record<string, unknown>) => void;
  let removeListener: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mock = createMockRpc();
    mockRpc = mock.rpc;
    emit = mock.emit;
    removeListener = mock.removeListener;
  });

  // ── 1. Subscribe + ready flow ──────────────────────────────────────────

  describe("subscribe + ready flow", () => {
    it("registers event listener and calls subscribe on the DO", () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });

      expect(mockRpc.onEvent).toHaveBeenCalledWith("channel:message", expect.any(Function));
      expect(mockRpc.call).toHaveBeenCalledWith(
        DO_TARGET,
        "subscribe",
        SELF_ID,
        expect.objectContaining({ transport: "rpc" }),
      );

      client.close();
    });

    it("resolves ready() after replay + ready events", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });

      // Emit replay participants and ready
      await emitReplayAndReady(emit, [
        { id: "agent-1", name: "Claude", type: "agent" },
        { id: "panel-1", name: "User", type: "panel" },
      ]);

      await client.ready(1000);

      // Roster should have both participants
      const roster = client.roster;
      expect(roster["agent-1"]).toBeDefined();
      expect(roster["agent-1"]!.metadata).toEqual({ name: "Claude", type: "agent" });
      expect(roster["panel-1"]).toBeDefined();
      expect(roster["panel-1"]!.metadata).toEqual({ name: "User", type: "panel" });

      expect(client.connected).toBe(true);
      expect(client.contextId).toBe("ctx-123");

      client.close();
    });

    it("fires onRoster handlers during replay", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      const rosterUpdates: Array<{ participantId: string; action: string }> = [];
      client.onRoster((update) => {
        if (update.change) {
          rosterUpdates.push({
            participantId: update.change.participantId,
            action: update.change.type,
          });
        }
      });

      await emitReplayAndReady(emit, [
        { id: "agent-1", name: "Claude", type: "agent" },
      ]);

      await client.ready(1000);

      expect(rosterUpdates).toContainEqual({ participantId: "agent-1", action: "join" });

      client.close();
    });
  });

  // ── 2. Publish + receive ───────────────────────────────────────────────

  describe("publish + receive", () => {
    let client: PubSubClient;

    beforeEach(async () => {
      client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready(1000);
      // Clear call history from subscribe
      mockRpc.call.mockClear();
      mockRpc.call.mockResolvedValue({ id: 42 });
    });

    it("publish() calls rpc.call with correct arguments", async () => {
      const pubsubId = await client.publish("message", { id: "m1", content: "hello" });

      expect(pubsubId).toBe(42);
      expect(mockRpc.call).toHaveBeenCalledWith(
        DO_TARGET,
        "publish",
        SELF_ID,
        "message",
        { id: "m1", content: "hello" },
        expect.objectContaining({ persist: true }),
      );
    });

    it("received messages appear in messages() iterator", async () => {
      const iter = client.messages();

      // The ready event enqueues a ready message; drain it first
      const readyMsg = await iter.next();
      expect(readyMsg.value).toMatchObject({ kind: "ready" });

      // Simulate a persisted message arriving from the DO
      emit({
        kind: "persisted",
        id: 50,
        type: "message",
        payload: { id: "m2", content: "world" },
        senderId: "agent-1",
        ts: Date.now(),
      });

      const first = await iter.next();
      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({
        kind: "persisted",
        id: 50,
        type: "message",
        payload: { id: "m2", content: "world" },
        senderId: "agent-1",
      });

      client.close();
    });
  });

  // ── 3. Method calls ───────────────────────────────────────────────────

  describe("method execution", () => {
    it("executes registered method and publishes result back", async () => {
      const executeFn = vi.fn().mockResolvedValue({ answer: 42 });

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          compute: {
            description: "compute something",
            parameters: z.object({ x: z.number() }),
            execute: executeFn,
          },
        },
      });

      await emitReplayAndReady(emit, []);
      await client.ready(1000);
      mockRpc.call.mockClear();
      mockRpc.call.mockResolvedValue(undefined);

      // Simulate a method-call arriving from another participant
      emit({
        kind: "persisted",
        id: 200,
        type: "method-call",
        payload: {
          callId: CALL_ID_1,
          methodName: "compute",
          providerId: SELF_ID,
          args: { x: 7 },
        },
        senderId: "caller-1",
        ts: Date.now(),
      });

      // Let the async method execution complete
      await vi.waitFor(() => {
        expect(executeFn).toHaveBeenCalled();
      });

      // Wait for the result publish call
      await vi.waitFor(() => {
        const publishCalls = mockRpc.call.mock.calls.filter(
          (c: unknown[]) => c[1] === "publish" && (c[3] as string) === "method-result",
        );
        expect(publishCalls.length).toBeGreaterThanOrEqual(1);
      });

      // Find the method-result publish call
      const resultCall = mockRpc.call.mock.calls.find(
        (c: unknown[]) => c[1] === "publish" && (c[3] as string) === "method-result",
      );
      expect(resultCall).toBeDefined();
      // Args: doTarget, "publish", pid, type, payload, opts
      const resultPayload = resultCall![4] as Record<string, unknown>;
      expect(resultPayload["callId"]).toBe(CALL_ID_1);
      expect(resultPayload["content"]).toEqual({ answer: 42 });
      expect(resultPayload["complete"]).toBe(true);
      expect(resultPayload["isError"]).toBe(false);

      client.close();
    });
  });

  // ── 4. Close ──────────────────────────────────────────────────────────

  describe("close", () => {
    it("calls unsubscribe and fires disconnect handlers", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready(1000);
      mockRpc.call.mockClear();
      mockRpc.call.mockResolvedValue(undefined);

      const disconnectFn = vi.fn();
      client.onDisconnect(disconnectFn);

      client.close();

      // Verify unsubscribe was called
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "unsubscribe", SELF_ID);

      // Verify disconnect handler fired
      expect(disconnectFn).toHaveBeenCalledTimes(1);

      // Verify event listener was removed
      expect(removeListener).toHaveBeenCalled();

      // Verify connected is false
      expect(client.connected).toBe(false);
    });

    it("terminates messages() iterator on close", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready(1000);

      const iter = client.messages();

      // Close should cause the iterator to end
      client.close();

      const result = await iter.next();
      expect(result.done).toBe(true);
    });
  });

  // ── 5. Method cancel propagation ──────────────────────────────────────

  describe("method cancel propagation", () => {
    it("aborts the signal when method-cancel arrives", async () => {
      let capturedSignal: AbortSignal | null = null;

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          slowWork: {
            description: "slow operation",
            parameters: z.object({}),
            execute: async (_args, ctx) => {
              capturedSignal = ctx.signal;
              // Wait until aborted
              await new Promise<void>((resolve) => {
                if (ctx.signal.aborted) {
                  resolve();
                  return;
                }
                ctx.signal.addEventListener("abort", () => resolve());
              });
              return { cancelled: true };
            },
          },
        },
      });

      await emitReplayAndReady(emit, []);
      await client.ready(1000);
      mockRpc.call.mockClear();
      mockRpc.call.mockResolvedValue(undefined);

      // Trigger the method call
      emit({
        kind: "persisted",
        id: 300,
        type: "method-call",
        payload: {
          callId: CALL_ID_SLOW,
          methodName: "slowWork",
          providerId: SELF_ID,
          args: {},
        },
        senderId: "caller-1",
        ts: Date.now(),
      });

      // Wait for the method to start executing
      await vi.waitFor(() => {
        expect(capturedSignal).not.toBeNull();
      });

      expect(capturedSignal!.aborted).toBe(false);

      // Send method-cancel
      emit({
        kind: "persisted",
        id: 301,
        type: "method-cancel",
        payload: { callId: CALL_ID_SLOW },
        senderId: "caller-1",
        ts: Date.now(),
      });

      // The signal should now be aborted
      expect(capturedSignal!.aborted).toBe(true);

      client.close();
    });
  });
});
