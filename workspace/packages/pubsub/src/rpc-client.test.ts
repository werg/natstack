/**
 * Tests for the RPC-based PubSub client (connectViaRpc).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { connectViaRpc } from "./rpc-client.js";
import type { PubSubClient } from "./client.js";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  agenticEventSchema,
  invocationAbandonedPayload,
  invocationCancelledPayload,
  invocationCompletedPayload,
  invocationFailedPayload,
} from "@workspace/agentic-protocol";
import { z } from "zod";

const CHANNEL = "test-channel";
const DO_TARGET = `do:workers/pubsub-channel:PubSubChannel:${CHANNEL}`;
const SELF_ID = "panel:panel-1";

// Valid UUIDs for method callIds (schema requires uuid format)
const CALL_ID_1 = "00000000-0000-4000-8000-000000000001";
const CALL_ID_SLOW = "00000000-0000-4000-8000-000000000002";
const TRANSPORT_ID_1 = "00000000-0000-4000-8000-000000000011";

function invocation(
  kind: string,
  callId: string,
  payload: Record<string, unknown>,
  opts?: { transportCallId?: string; turnId?: string }
) {
  const terminalPayload =
    kind === "invocation.completed"
      ? invocationCompletedPayload()
      : kind === "invocation.failed"
        ? invocationFailedPayload("tool_error", String(payload["reason"] ?? "method failed"), {
            terminalReasonCode: "method_failed",
          })
        : kind === "invocation.cancelled"
          ? invocationCancelledPayload("cancelled", String(payload["reason"] ?? "cancelled"), {
              terminalReasonCode: "cancelled",
            })
          : kind === "invocation.abandoned"
            ? invocationAbandonedPayload(String(payload["reason"] ?? "abandoned"), {
                terminalReasonCode: "runner_restarted_before_invocation_completed",
              })
            : { protocol: "agentic.trajectory.v1" };
  return {
    kind,
    actor: { kind: "panel", id: "panel:panel-1" },
    ...(opts?.turnId ? { turnId: opts.turnId } : {}),
    causality: {
      invocationId: callId,
      ...(opts?.transportCallId ? { transportCallId: opts.transportCallId } : {}),
    },
    payload: { ...terminalPayload, ...payload },
    createdAt: new Date().toISOString(),
  };
}

function messageEvent(id: string, content: string, actorId = "agent-1") {
  return {
    kind: "message.completed",
    actor: { kind: "agent", id: actorId, displayName: actorId },
    causality: { messageId: id },
    payload: {
      protocol: "agentic.trajectory.v1",
      role: "assistant",
      content,
    },
    createdAt: new Date().toISOString(),
  };
}

interface MockRpc {
  call: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  selfId: string;
}

/**
 * Creates a mock RPC object. The `on` mock captures the listener
 * so tests can emit events by calling `emit(payload)`.
 */
function createMockRpc() {
  let eventListener: ((event: { payload: unknown }) => void) | null = null;
  const removeListener = vi.fn();

  const rpc: MockRpc = {
    call: vi.fn(async (target: string, method: string) => {
      if (target === "main" && method === "workers.resolveService") {
        return { kind: "durable-object", targetId: DO_TARGET };
      }
      return undefined;
    }),
    on: vi
      .fn()
      .mockImplementation((_event: string, listener: (event: { payload: unknown }) => void) => {
        eventListener = listener;
        return removeListener;
      }),
    selfId: SELF_ID,
  };

  function emit(msg: Record<string, unknown>) {
    if (!eventListener) throw new Error("No event listener registered");
    if (msg["kind"] === "ready") {
      eventListener({
        payload: {
          channelId: CHANNEL,
          message: {
            kind: "control",
            type: "ready",
            ready: {
              contextId: msg["contextId"],
              channelConfig: msg["channelConfig"],
              totalCount: msg["totalCount"],
              envelopeCount: msg["envelopeCount"],
              firstEnvelopeSeq: msg["firstEnvelopeSeq"],
              hasMoreBefore: msg["hasMoreBefore"],
            },
          },
        },
      });
      return;
    }
    if (msg["stream"] === "log") {
      eventListener({
        payload: {
          channelId: CHANNEL,
          message: {
            kind: "log",
            phase: msg["phase"] === "replay" ? "replay" : "live",
            event: {
              id: msg["id"],
              messageId: `test-${msg["id"]}`,
              type: msg["type"],
              payload: msg["payload"],
              senderId: msg["senderId"],
              ts: msg["ts"],
              senderMetadata: msg["senderMetadata"],
              attachments: msg["attachments"],
            },
          },
        },
      });
      return;
    }
    if (msg["stream"] === "signal") {
      eventListener({
        payload: {
          channelId: CHANNEL,
          message: {
            kind: "signal",
            type: msg["type"],
            payload: msg["payload"],
            senderId: msg["senderId"],
            ts: msg["ts"],
          },
        },
      });
      return;
    }
    eventListener({ payload: { channelId: CHANNEL, message: msg } });
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
  messages: Array<{ id: number; content: string; senderId: string }> = []
) {
  // Emit presence join replay events for each participant
  for (const p of participants) {
    emit({
      stream: "log",
      phase: "replay",
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
      stream: "log",
      phase: "replay",
      id: m.id,
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: messageEvent(`msg-${m.id}`, m.content, m.senderId),
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
    envelopeCount: messages.length,
    hasMoreBefore: false,
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
    it("registers event listener and calls subscribe on the channel service", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await Promise.resolve();
      await Promise.resolve();

      expect(mockRpc.on).toHaveBeenCalledWith("channel:message", expect.any(Function));
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "subscribe", [
        SELF_ID,
        expect.objectContaining({
          __participantSessionId: expect.any(String),
          replay: true,
          replayMessageLimit: 200,
        }),
      ]);

      client.close();
    });

    it("resolves ready() after replay + ready events", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });

      // Emit replay participants and ready
      await emitReplayAndReady(emit, [
        { id: "agent-1", name: "Claude", type: "agent" },
        { id: "panel:panel-1", name: "User", type: "panel" },
      ]);

      await client.ready();

      // Roster should have both participants
      const roster = client.roster;
      expect(roster["agent-1"]).toBeDefined();
      expect(roster["agent-1"]!.metadata).toEqual({ name: "Claude", type: "agent" });
      expect(roster["panel:panel-1"]).toBeDefined();
      expect(roster["panel:panel-1"]!.metadata).toEqual({ name: "User", type: "panel" });

      expect(client.connected).toBe(true);
      expect(client.contextId).toBe("ctx-123");
      expect(client.hasMoreBefore).toBe(false);

      client.close();
    });

    it("resolves ready() from the subscribe acknowledgment after applying fallback replay", async () => {
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (target === "main" && method === "workers.resolveService") {
          return { kind: "durable-object", targetId: DO_TARGET };
        }
        if (method === "subscribe") {
          return {
            ok: true,
            envelope: {
              mode: "initial",
              logEvents: [
                {
                  id: 101,
                  messageId: "presence-101",
                  type: "presence",
                  payload: { action: "join", metadata: { name: "Claude", type: "agent" } },
                  senderId: "agent-1",
                  ts: Date.now(),
                },
                {
                  id: 201,
                  messageId: "msg-201",
                  type: AGENTIC_EVENT_PAYLOAD_KIND,
                  payload: messageEvent("00000000-0000-4000-8000-000000000201", "from replay"),
                  senderId: "agent-1",
                  ts: Date.now(),
                },
              ],
              snapshots: [],
              ready: {
                contextId: "ctx-from-subscribe",
                channelConfig: { title: "Ack Channel" },
                totalCount: 1,
                envelopeCount: 1,
              },
            },
          };
        }
        return undefined;
      });

      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      const events = client.events({ includeReplay: true });
      const readyHandler = vi.fn();
      client.onReady(readyHandler);

      await client.ready();

      expect(client.connected).toBe(true);
      expect(client.contextId).toBe("ctx-from-subscribe");
      expect(client.channelConfig).toEqual({ title: "Ack Channel" });
      expect(client.roster["agent-1"]?.metadata).toEqual({ name: "Claude", type: "agent" });
      expect(readyHandler).toHaveBeenCalledTimes(1);

      let replayed = await events.next();
      while (!replayed.done && replayed.value.type !== AGENTIC_EVENT_PAYLOAD_KIND) {
        replayed = await events.next();
      }
      expect(replayed).toMatchObject({
        value: {
          delivery: "log",
          phase: "replay",
          pubsubId: 201,
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: {
            kind: "message.completed",
            causality: { messageId: "00000000-0000-4000-8000-000000000201" },
          },
        },
      });

      // If the queued event delivery catches up after the ack fallback, replay
      // and ready are deduped rather than surfacing a second boundary.
      emit({
        stream: "log",
        phase: "replay",
        id: 201,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: messageEvent("msg-201", "from replay"),
        senderId: "agent-1",
        ts: Date.now(),
      });
      emit({
        kind: "ready",
        contextId: "ctx-from-subscribe",
        channelConfig: { title: "Ack Channel" },
        totalCount: 1,
        envelopeCount: 1,
      });
      await Promise.resolve();
      expect(readyHandler).toHaveBeenCalledTimes(1);

      client.close();
    });

    it("does not surface replay events when replayMode is skip", async () => {
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (target === "main" && method === "workers.resolveService") {
          return { kind: "durable-object", targetId: DO_TARGET };
        }
        if (method === "subscribe") {
          return {
            ok: true,
            envelope: {
              mode: "initial",
              logEvents: [
                {
                  id: 201,
                  messageId: "msg-201",
                  type: AGENTIC_EVENT_PAYLOAD_KIND,
                  payload: messageEvent("00000000-0000-4000-8000-000000000201", "from replay"),
                  senderId: "agent-1",
                  ts: Date.now(),
                },
              ],
              snapshots: [
                {
                  kind: "roster-snapshot",
                  participants: [{ id: "agent-1", metadata: { name: "Agent", type: "agent" } }],
                  ts: Date.now(),
                },
              ],
              ready: {
                contextId: "ctx-skip",
                totalCount: 1,
                envelopeCount: 1,
              },
            },
          };
        }
        return undefined;
      });

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        replayMode: "skip",
      });

      await client.ready();

      expect(client.contextId).toBe("ctx-skip");
      expect(client.roster).toEqual({});

      client.close();
    });

    it("seeds late event subscribers with streamed replay after ready", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      emit({
        stream: "log",
        phase: "replay",
        id: 201,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: messageEvent("00000000-0000-4000-8000-000000000201", "from replay"),
        senderId: "agent-1",
        ts: Date.now(),
      });
      emit({
        kind: "ready",
        contextId: "ctx-from-subscribe",
        totalCount: 1,
        envelopeCount: 1,
      });
      await client.ready();

      const iter = client.events({ includeReplay: true });
      await expect(iter.next()).resolves.toMatchObject({
        value: {
          delivery: "log",
          phase: "replay",
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: {
            kind: "message.completed",
            causality: { messageId: "00000000-0000-4000-8000-000000000201" },
          },
        },
      });

      client.close();
    });

    it("delivers buffered streamed replay to subscribers that are already listening before ready", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      const iter = client.events({ includeReplay: true });
      const next = iter.next();

      emit({
        stream: "log",
        phase: "replay",
        id: 201,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: messageEvent("00000000-0000-4000-8000-000000000201", "from replay"),
        senderId: "agent-1",
        ts: Date.now(),
      });
      emit({
        kind: "ready",
        contextId: "ctx-from-subscribe",
        totalCount: 1,
        envelopeCount: 1,
      });

      await client.ready();
      await expect(next).resolves.toMatchObject({
        value: {
          delivery: "log",
          phase: "replay",
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: {
            kind: "message.completed",
            causality: { messageId: "00000000-0000-4000-8000-000000000201" },
          },
        },
      });

      client.close();
    });

    it("does not deliver buffered streamed replay to subscribers that opt out of replay", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      const iter = client.events();
      const next = iter.next();

      emit({
        stream: "log",
        phase: "replay",
        id: 201,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: messageEvent("00000000-0000-4000-8000-000000000201", "from replay"),
        senderId: "agent-1",
        ts: Date.now(),
      });
      emit({
        kind: "ready",
        contextId: "ctx-from-subscribe",
        totalCount: 1,
        envelopeCount: 1,
      });
      await client.ready();

      emit({
        stream: "log",
        phase: "live",
        id: 202,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: messageEvent("00000000-0000-4000-8000-000000000202", "from live"),
        senderId: "agent-1",
        ts: Date.now(),
      });

      await expect(next).resolves.toMatchObject({
        value: {
          delivery: "log",
          phase: "live",
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: {
            kind: "message.completed",
            causality: { messageId: "00000000-0000-4000-8000-000000000202" },
          },
        },
      });

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

      await emitReplayAndReady(emit, [{ id: "agent-1", name: "Claude", type: "agent" }]);

      await client.ready();

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
      await client.ready();
      // Clear call history from subscribe
      mockRpc.call.mockClear();
      mockRpc.call.mockResolvedValue({ id: 42 });
    });

    it("publish() calls rpc.call with correct arguments", async () => {
      const pubsubId = await client.publish("custom.event", { id: "m1", content: "hello" });

      expect(pubsubId).toBe(42);
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "publish", [
        SELF_ID,
        "custom.event",
        { id: "m1", content: "hello" },
        expect.objectContaining({}),
      ]);
    });

    it("send() publishes a typed agentic event envelope payload", async () => {
      const result = await client.send("hello", {
        replyTo: "msg-parent",
        mentions: ["agent:one"],
        metadata: { source: "test" },
        idempotencyKey: "send-1",
      });

      expect(result.pubsubId).toBe(42);
      expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "publish", [
        SELF_ID,
        AGENTIC_EVENT_PAYLOAD_KIND,
        expect.objectContaining({
          kind: "message.completed",
        }),
        expect.objectContaining({ idempotencyKey: "send-1" }),
      ]);

      const [, , args] = mockRpc.call.mock.calls[0]!;
      const payload = (args as unknown[])[2];
      const parsed = agenticEventSchema.parse(payload);
      expect(parsed.kind).toBe("message.completed");
      expect(parsed.causality?.messageId).toBe(result.messageId);
      expect(parsed.payload).toMatchObject({
        protocol: "agentic.trajectory.v1",
        role: "user",
        content: "hello",
        mentions: ["agent:one"],
        replyTo: "msg-parent",
      });
    });

    it("received envelopes appear in events() iterator", async () => {
      const iter = client.events();

      emit({
        stream: "log",
        phase: "live",
        id: 50,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: messageEvent("00000000-0000-4000-8000-000000000050", "world"),
        senderId: "agent-1",
        ts: Date.now(),
      });

      const first = await iter.next();
      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({
        delivery: "log",
        phase: "live",
        pubsubId: 50,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: {
          kind: "message.completed",
          causality: { messageId: "00000000-0000-4000-8000-000000000050" },
        },
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
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockResolvedValue(undefined);

      // Simulate an invocation start arriving from another participant.
      emit({
        stream: "log",
        phase: "live",
        id: 200,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.started",
          CALL_ID_1,
          {
            name: "compute",
            request: { x: 7 },
            transport: {
              kind: "channel",
              channelId: CHANNEL,
              target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
              transportCallId: TRANSPORT_ID_1,
            },
          },
          { transportCallId: TRANSPORT_ID_1, turnId: "turn-1" }
        ),
        senderId: "caller-1",
        ts: Date.now(),
      });

      // Let the async method execution complete
      await vi.waitFor(() => {
        expect(executeFn).toHaveBeenCalled();
      });

      // Wait for the result submit call
      await vi.waitFor(() => {
        const submitCalls = mockRpc.call.mock.calls.filter(
          (c: unknown[]) => c[1] === "submitMethodResult"
        );
        expect(submitCalls.length).toBeGreaterThanOrEqual(1);
      });

      // Find the terminal result submit call.
      const resultCall = mockRpc.call.mock.calls.find(
        (c: unknown[]) => c[1] === "submitMethodResult"
      );
      expect(resultCall).toBeDefined();
      // Args: doTarget, "submitMethodResult", pid, transportCallId, content, isError, opts
      const resultArgs = resultCall![2] as unknown[];
      expect(resultArgs[1]).toBe(TRANSPORT_ID_1);
      expect(resultArgs[2]).toEqual({ answer: 42 });
      expect(resultArgs[3]).toBe(false);
      expect(resultArgs[4]).toMatchObject({
        invocationId: CALL_ID_1,
        turnId: "turn-1",
      });

      client.close();
    });

    it("dedupes redelivered invocation starts for the same transport call", async () => {
      let resolveWork!: (value: { answer: number }) => void;
      const executeFn = vi.fn(
        () =>
          new Promise<{ answer: number }>((resolve) => {
            resolveWork = resolve;
          })
      );

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          compute: {
            description: "compute something",
            parameters: z.object({}),
            execute: executeFn,
          },
        },
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockResolvedValue(undefined);

      const emitInvocationStarted = (id: number) => {
        emit({
          stream: "log",
          phase: "live",
          id,
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: invocation(
            "invocation.started",
            CALL_ID_1,
            {
              name: "compute",
              request: {},
              transport: {
                kind: "channel",
                channelId: CHANNEL,
                target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
                transportCallId: TRANSPORT_ID_1,
              },
            },
            { transportCallId: TRANSPORT_ID_1, turnId: "turn-1" }
          ),
          senderId: "caller-1",
          ts: Date.now(),
        });
      };

      emitInvocationStarted(201);
      await vi.waitFor(() => {
        expect(executeFn).toHaveBeenCalledTimes(1);
      });

      emitInvocationStarted(202);
      await Promise.resolve();
      await Promise.resolve();
      expect(executeFn).toHaveBeenCalledTimes(1);

      resolveWork({ answer: 42 });
      await vi.waitFor(() => {
        const submitCalls = mockRpc.call.mock.calls.filter(
          (c: unknown[]) => c[1] === "submitMethodResult"
        );
        expect(submitCalls).toHaveLength(1);
      });

      emitInvocationStarted(203);
      await Promise.resolve();
      await Promise.resolve();
      expect(executeFn).toHaveBeenCalledTimes(1);
      expect(
        mockRpc.call.mock.calls.filter((c: unknown[]) => c[1] === "submitMethodResult")
      ).toHaveLength(1);

      client.close();
    });

    it("hydrates stored-value method arguments before validation", async () => {
      const executeFn = vi.fn().mockResolvedValue({ ok: true });
      const request = { x: 7 };
      const encodedRequest = JSON.stringify(request);

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        methods: {
          compute: {
            description: "compute something",
            parameters: z.object({ x: z.number() }).strict(),
            execute: executeFn,
          },
        },
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (target === "main" && method === "blobstore.getText") return encodedRequest;
        return undefined;
      });

      emit({
        stream: "log",
        phase: "live",
        id: 201,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.started",
          CALL_ID_1,
          {
            name: "compute",
            request: {
              protocol: "natstack.blob-ref.v1",
              digest: "abc123",
              size: encodedRequest.length,
              encoding: "json",
              originalBytes: encodedRequest.length,
            },
            transport: {
              kind: "channel",
              channelId: CHANNEL,
              target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
              transportCallId: TRANSPORT_ID_1,
            },
          },
          { transportCallId: TRANSPORT_ID_1 }
        ),
        senderId: "caller-1",
        ts: Date.now(),
      });

      await vi.waitFor(() => {
        expect(executeFn).toHaveBeenCalledWith(
          request,
          expect.objectContaining({ callId: TRANSPORT_ID_1 })
        );
      });

      client.close();
    });

    it("hydrates stored-value method results before resolving callers", async () => {
      const result = { answer: 42 };
      const encodedResult = JSON.stringify(result);

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (target === "main" && method === "blobstore.getText") return encodedResult;
        return undefined;
      });

      const handle = client.callMethod("provider-1", "compute", {});
      await Promise.resolve();

      emit({
        stream: "log",
        phase: "live",
        id: 401,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.completed",
          handle.invocationId,
          {
            result: {
              protocol: "natstack.blob-ref.v1",
              digest: "def456",
              size: encodedResult.length,
              encoding: "json",
              originalBytes: encodedResult.length,
            },
          },
          { transportCallId: handle.transportCallId }
        ),
        senderId: "provider-1",
        ts: Date.now(),
      });

      await expect(handle.result).resolves.toEqual({ content: result });

      client.close();
    });

    it("applies method progress and terminal chunks in receive order", async () => {
      const progress = { partial: "first" };
      const encodedProgress = JSON.stringify(progress);
      let releaseHydration: ((value: string) => void) | undefined;

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (target === "main" && method === "blobstore.getText") {
          return await new Promise<string>((resolve) => {
            releaseHydration = resolve;
          });
        }
        return undefined;
      });

      const handle = client.callMethod("provider-1", "compute", {});
      const chunks: unknown[] = [];
      const streamDone = (async () => {
        for await (const chunk of handle.stream) {
          chunks.push(chunk.content);
        }
      })();
      const resultSettled = vi.fn();
      void handle.result.then(resultSettled);
      await Promise.resolve();

      emit({
        stream: "log",
        phase: "live",
        id: 411,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.output",
          handle.invocationId,
          {
            output: {
              protocol: "natstack.blob-ref.v1",
              digest: "progress",
              size: encodedProgress.length,
              encoding: "json",
              originalBytes: encodedProgress.length,
            },
          },
          { transportCallId: handle.transportCallId }
        ),
        senderId: "provider-1",
        ts: Date.now(),
      });
      emit({
        stream: "log",
        phase: "live",
        id: 412,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.completed",
          handle.invocationId,
          { result: { done: true } },
          { transportCallId: handle.transportCallId }
        ),
        senderId: "provider-1",
        ts: Date.now(),
      });

      await Promise.resolve();
      await vi.waitFor(() => {
        expect(releaseHydration).toBeDefined();
      });
      expect(resultSettled).not.toHaveBeenCalled();

      releaseHydration!(encodedProgress);
      await expect(handle.result).resolves.toEqual({ content: { done: true } });
      await streamDone;
      expect(chunks).toEqual([progress, { done: true }]);

      client.close();
    });

    it("recovers a pending method result from a replayed invocation.completed on resubscribe", async () => {
      let recover!: () => Promise<void>;
      const registerColdRecoverHandler = vi.fn(
        (_id: string, handler: () => Promise<void>) => {
          recover = handler;
          return vi.fn();
        }
      );
      // The resubscribe replay carries the missed terminal as a durable
      // invocation.completed log event (no getSettledResult read-back).
      let pendingCallId: string | undefined;
      mockRpc.call.mockImplementation(async (target: string, method: string) => {
        if (target === "main" && method === "workers.resolveService") {
          return { kind: "durable-object", targetId: DO_TARGET };
        }
        if (method === "subscribe") {
          return {
            ok: true,
            envelope: {
              mode: "after",
              logEvents: pendingCallId
                ? [
                    {
                      id: 501,
                      type: AGENTIC_EVENT_PAYLOAD_KIND,
                      payload: invocation(
                        "invocation.completed",
                        pendingCallId,
                        { result: { answer: 42 } },
                        { transportCallId: pendingCallId }
                      ),
                      senderId: "provider-1",
                      ts: Date.now(),
                    },
                  ]
                : [],
              snapshots: [],
              ready: {
                contextId: "ctx-recovered",
                totalCount: 0,
                envelopeCount: 0,
              },
            },
          };
        }
        return undefined;
      });

      const client = connectViaRpc({
        rpc: mockRpc as any,
        channel: CHANNEL,
        recoveryCoordinator: { registerColdRecoverHandler },
      });
      await client.ready();
      mockRpc.call.mockClear();

      const handle = client.callMethod("provider-1", "compute", {});
      pendingCallId = handle.transportCallId;
      await recover();

      await expect(handle.result).resolves.toEqual({ content: { answer: 42 } });
      expect(
        mockRpc.call.mock.calls.some((call) => call[1] === "getSettledResult")
      ).toBe(false);

      client.close();
    });
  });

  // ── 4. Close ──────────────────────────────────────────────────────────

  describe("close", () => {
    it("calls unsubscribe and fires disconnect handlers", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockResolvedValue(undefined);

      const disconnectFn = vi.fn();
      client.onDisconnect(disconnectFn);

      client.close();
      await Promise.resolve();
      await Promise.resolve();

      // Verify unsubscribe was called
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "unsubscribe", [SELF_ID]);

      // Verify disconnect handler fired
      expect(disconnectFn).toHaveBeenCalledTimes(1);

      // Verify event listener was removed
      expect(removeListener).toHaveBeenCalled();

      // Verify connected is false
      expect(client.connected).toBe(false);
    });
  });

  // ── 5. Method cancel propagation ──────────────────────────────────────

  describe("method cancel propagation", () => {
    it("does not publish a method call when the caller signal is already aborted", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();

      const controller = new AbortController();
      controller.abort();

      const handle = client.callMethod("provider-1", "slowWork", {}, { signal: controller.signal });

      await expect(handle.result).rejects.toMatchObject({ code: "cancelled" });
      expect(mockRpc.call).not.toHaveBeenCalled();

      client.close();
    });

    it("cancels an in-flight method call when the caller signal aborts", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockResolvedValue(undefined);

      const controller = new AbortController();
      const handle = client.callMethod("provider-1", "slowWork", {}, { signal: controller.signal });
      await Promise.resolve();
      await Promise.resolve();

      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "callMethod", [
        SELF_ID,
        "provider-1",
        handle.callId,
        "slowWork",
        {},
        {
          invocationId: handle.invocationId,
          transportCallId: handle.transportCallId,
        },
      ]);

      controller.abort();

      await expect(handle.result).rejects.toMatchObject({ code: "cancelled" });
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "cancelMethodCall", [handle.callId]);

      client.close();
    });

    it("awaits cancelMethodCall for explicit cancellation", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();

      let resolveCancel!: () => void;
      mockRpc.call.mockImplementation((_target: string, method: string) => {
        if (method === "cancelMethodCall") {
          return new Promise<void>((resolve) => {
            resolveCancel = resolve;
          });
        }
        return Promise.resolve(undefined);
      });

      const handle = client.callMethod("provider-1", "slowWork", {});
      void handle.result.catch(() => {});

      const cancelPromise = handle.cancel();
      let settled = false;
      void cancelPromise.then(() => {
        settled = true;
      });

      await Promise.resolve();
      expect(settled).toBe(false);
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "cancelMethodCall", [handle.callId]);

      resolveCancel();
      await cancelPromise;
      expect(settled).toBe(true);

      client.close();
    });

    it("keeps pause calls on normal method transport until the provider result arrives", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockResolvedValue(undefined);

      const handle = client.callMethod("agent-1", "pause", {
        reason: "User interrupted execution",
      });

      await Promise.resolve();
      expect(handle.complete).toBe(false);
      expect(mockRpc.call).toHaveBeenCalledWith(DO_TARGET, "callMethod", [
        SELF_ID,
        "agent-1",
        handle.callId,
        "pause",
        { reason: "User interrupted execution" },
        {
          invocationId: handle.invocationId,
          transportCallId: handle.transportCallId,
        },
      ]);

      emit({
        stream: "log",
        phase: "live",
        id: 320,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.completed",
          handle.invocationId,
          { result: { paused: true } },
          { transportCallId: handle.transportCallId }
        ),
        senderId: "agent-1",
        ts: Date.now(),
      });

      await expect(handle.result).resolves.toEqual({ content: { paused: true } });
      expect(handle.complete).toBe(true);

      client.close();
    });

    it("aborts the executing method when invocation.cancelled arrives", async () => {
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
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockResolvedValue(undefined);

      // Trigger the method call
      emit({
        stream: "log",
        phase: "live",
        id: 300,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation("invocation.started", CALL_ID_SLOW, {
          name: "slowWork",
          request: {},
          transport: {
            kind: "channel",
            channelId: CHANNEL,
            target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
          },
        }),
        senderId: "caller-1",
        ts: Date.now(),
      });

      // Wait for the method to start executing
      await vi.waitFor(() => {
        expect(capturedSignal).not.toBeNull();
      });

      expect(capturedSignal!.aborted).toBe(false);

      // invocation.cancelled is now the provider-abort signal (no method-cancel).
      emit({
        stream: "log",
        phase: "live",
        id: 301,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation("invocation.cancelled", CALL_ID_SLOW, { reason: "cancelled" }),
        senderId: "caller-1",
        ts: Date.now(),
      });

      expect(capturedSignal!.aborted).toBe(true);

      client.close();
    });

    it("abortExecutingMethod fires the local signal synchronously without a channel round-trip", async () => {
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
              await new Promise<void>((resolve) => {
                if (ctx.signal.aborted) return resolve();
                ctx.signal.addEventListener("abort", () => resolve());
              });
              throw new Error("cancelled");
            },
          },
        },
      });

      await emitReplayAndReady(emit, []);
      await client.ready();
      mockRpc.call.mockClear();
      mockRpc.call.mockResolvedValue(undefined);

      emit({
        stream: "log",
        phase: "live",
        id: 400,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: invocation(
          "invocation.started",
          CALL_ID_SLOW,
          {
            name: "slowWork",
            request: {},
            transport: {
              kind: "channel",
              channelId: CHANNEL,
              target: { kind: "panel", id: SELF_ID, participantId: SELF_ID },
              transportCallId: TRANSPORT_ID_1,
            },
          },
          { transportCallId: TRANSPORT_ID_1 }
        ),
        senderId: "caller-1",
        ts: Date.now(),
      });

      await vi.waitFor(() => {
        expect(capturedSignal).not.toBeNull();
      });
      expect(capturedSignal!.aborted).toBe(false);

      // Abort locally by transport call id — no channel cancelMethodCall needed.
      const aborted = client.abortExecutingMethod(TRANSPORT_ID_1);

      expect(aborted).toBe(true);
      expect(capturedSignal!.aborted).toBe(true);
      // The local abort itself issues no cancelMethodCall RPC.
      const cancelCalls = mockRpc.call.mock.calls.filter(
        (c: unknown[]) => c[1] === "cancelMethodCall"
      );
      expect(cancelCalls.length).toBe(0);
      await vi.waitFor(() => {
        const submitCall = mockRpc.call.mock.calls.find(
          (c: unknown[]) => c[1] === "submitMethodResult"
        );
        const args = submitCall?.[2] as unknown[] | undefined;
        expect(args).toEqual(expect.arrayContaining([TRANSPORT_ID_1, expect.anything(), true]));
        expect(args?.[4]).toMatchObject({
          terminalOutcome: "cancelled",
          terminalReasonCode: "cancelled",
        });
      });

      client.close();
    });

    it("abortExecutingMethod returns false when no execution matches the call id", async () => {
      const client = connectViaRpc({ rpc: mockRpc as any, channel: CHANNEL });
      await emitReplayAndReady(emit, []);
      await client.ready();
      expect(client.abortExecutingMethod(TRANSPORT_ID_1)).toBe(false);
      client.close();
    });
  });
});
