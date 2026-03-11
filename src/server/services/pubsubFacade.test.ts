import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  PubSubServer,
  ParticipantHandle,
  ChannelBroadcastEvent,
  ParticipantCallback,
} from "@natstack/pubsub-server";
import type { WorkerRouter } from "../workerRouter.js";
import type { ParticipantDescriptor, WorkerActions } from "@natstack/harness";
import { PubSubFacade, type ExecuteActionsFn } from "./pubsubFacade.js";

// ── Mock factories ──────────────────────────────────────────────────────────

function createMockHandle(): ParticipantHandle {
  return {
    sendMessage: vi.fn(),
    updateMessage: vi.fn(),
    completeMessage: vi.fn(),
    sendMethodCall: vi.fn(),
    sendMethodResult: vi.fn(),
    updateMetadata: vi.fn(),
    leave: vi.fn(),
  };
}

function createMockPubSub() {
  const capturedCallbacks = new Map<string, ParticipantCallback>();
  const mockHandle = createMockHandle();

  const pubsub = {
    registerParticipant: vi.fn(
      (
        _channel: string,
        participantId: string,
        _metadata: Record<string, unknown>,
        callback: ParticipantCallback,
      ) => {
        capturedCallbacks.set(participantId, callback);
        return mockHandle;
      },
    ),
    onChannelEvent: vi.fn().mockReturnValue(() => {}),
  } as unknown as PubSubServer;

  return { pubsub, mockHandle, capturedCallbacks };
}

function createMockRouter() {
  return {
    registerParticipant: vi.fn(),
    getDOForParticipant: vi.fn().mockReturnValue(undefined),
    dispatch: vi.fn<
      (className: string, objectKey: string, method: string, ...args: unknown[]) => Promise<WorkerActions>
    >().mockResolvedValue({ actions: [] }),
  } as unknown as WorkerRouter;
}

function defaultDescriptor(
  overrides?: Partial<ParticipantDescriptor>,
): ParticipantDescriptor {
  return {
    handle: "bot",
    name: "TestBot",
    type: "ai",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PubSubFacade", () => {
  let pubsubMocks: ReturnType<typeof createMockPubSub>;
  let router: WorkerRouter;
  let executeActions: ExecuteActionsFn;
  let facade: PubSubFacade;

  beforeEach(() => {
    pubsubMocks = createMockPubSub();
    router = createMockRouter();
    executeActions = vi.fn<ExecuteActionsFn>().mockResolvedValue(undefined);
    facade = new PubSubFacade(pubsubMocks.pubsub, router, executeActions);
  });

  // ── subscribe() ─────────────────────────────────────────────────────────

  describe("subscribe()", () => {
    it("calls registerParticipant on PubSub with correct arguments", async () => {
      await facade.subscribe({
        channelId: "ch-1",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor: defaultDescriptor(),
      });

      expect(pubsubMocks.pubsub.registerParticipant).toHaveBeenCalledWith(
        "ch-1",
        "p-1",
        expect.objectContaining({ name: "TestBot", type: "ai", handle: "bot" }),
        expect.objectContaining({ onEvent: expect.any(Function) }),
      );
    });

    it("stores the handle so getHandle returns the entry", async () => {
      await facade.subscribe({
        channelId: "ch-1",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor: defaultDescriptor(),
      });

      const entry = facade.getHandle("p-1");
      expect(entry).toBeDefined();
      expect(entry!.channelId).toBe("ch-1");
      expect(entry!.className).toBe("ChatDO");
      expect(entry!.objectKey).toBe("room-1");
      expect(entry!.participantId).toBe("p-1");
    });

    it("registers participant in workerRouter", async () => {
      await facade.subscribe({
        channelId: "ch-1",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor: defaultDescriptor(),
      });

      expect(
        (router as unknown as Record<string, ReturnType<typeof vi.fn>>)["registerParticipant"],
      ).toHaveBeenCalledWith("p-1", "ChatDO", "room-1");
    });

    it("includes method advertisements in metadata when present", async () => {
      await facade.subscribe({
        channelId: "ch-1",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor: defaultDescriptor({
          methods: [{ name: "greet", description: "Say hello" }],
        }),
      });

      expect(pubsubMocks.pubsub.registerParticipant).toHaveBeenCalledWith(
        "ch-1",
        "p-1",
        expect.objectContaining({
          methods: [{ name: "greet", description: "Say hello" }],
        }),
        expect.anything(),
      );
    });

    it("unsubscribes existing participant before re-subscribing", async () => {
      await facade.subscribe({
        channelId: "ch-1",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor: defaultDescriptor(),
      });

      const firstHandle = pubsubMocks.mockHandle;
      // Create a fresh handle for the second subscription
      const secondHandle = createMockHandle();
      (pubsubMocks.pubsub.registerParticipant as ReturnType<typeof vi.fn>).mockReturnValue(
        secondHandle,
      );

      await facade.subscribe({
        channelId: "ch-2",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-2",
        descriptor: defaultDescriptor(),
      });

      expect(firstHandle.leave).toHaveBeenCalled();
      expect(facade.getHandle("p-1")!.channelId).toBe("ch-2");
    });
  });

  // ── unsubscribe() ───────────────────────────────────────────────────────

  describe("unsubscribe()", () => {
    it("calls handle.leave() and removes the entry", async () => {
      await facade.subscribe({
        channelId: "ch-1",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor: defaultDescriptor(),
      });

      facade.unsubscribe("p-1");

      expect(pubsubMocks.mockHandle.leave).toHaveBeenCalled();
      expect(facade.getHandle("p-1")).toBeUndefined();
    });

    it("is a no-op for unknown participantId", () => {
      // Should not throw
      facade.unsubscribe("nonexistent");
      expect(facade.getHandle("nonexistent")).toBeUndefined();
    });
  });

  // ── executeChannelAction() ──────────────────────────────────────────────

  describe("executeChannelAction()", () => {
    beforeEach(async () => {
      await facade.subscribe({
        channelId: "ch-1",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor: defaultDescriptor(),
      });
    });

    it("dispatches 'send' to handle.sendMessage with mapped options", () => {
      facade.executeChannelAction(
        {
          target: "channel",
          channelId: "ch-1",
          op: "send",
          messageId: "msg-1",
          content: "Hello",
          options: { type: "text", persist: true, senderMetadata: { role: "bot" } },
        },
        "p-1",
      );

      expect(pubsubMocks.mockHandle.sendMessage).toHaveBeenCalledWith(
        "msg-1",
        "Hello",
        { contentType: "text", persist: true, senderMetadata: { role: "bot" }, replyTo: undefined },
      );
    });

    it("dispatches 'send' without options", () => {
      facade.executeChannelAction(
        {
          target: "channel",
          channelId: "ch-1",
          op: "send",
          messageId: "msg-1",
          content: "Hi",
        },
        "p-1",
      );

      expect(pubsubMocks.mockHandle.sendMessage).toHaveBeenCalledWith(
        "msg-1",
        "Hi",
        undefined,
      );
    });

    it("dispatches 'update' to handle.updateMessage", () => {
      facade.executeChannelAction(
        {
          target: "channel",
          channelId: "ch-1",
          op: "update",
          messageId: "msg-1",
          content: "Updated",
        },
        "p-1",
      );

      expect(pubsubMocks.mockHandle.updateMessage).toHaveBeenCalledWith("msg-1", "Updated");
    });

    it("dispatches 'complete' to handle.completeMessage", () => {
      facade.executeChannelAction(
        {
          target: "channel",
          channelId: "ch-1",
          op: "complete",
          messageId: "msg-1",
        },
        "p-1",
      );

      expect(pubsubMocks.mockHandle.completeMessage).toHaveBeenCalledWith("msg-1");
    });

    it("dispatches 'method-result' to handle.sendMethodResult", () => {
      facade.executeChannelAction(
        {
          target: "channel",
          channelId: "ch-1",
          op: "method-result",
          callId: "call-42",
          content: { result: "ok" },
          isError: false,
        },
        "p-1",
      );

      expect(pubsubMocks.mockHandle.sendMethodResult).toHaveBeenCalledWith(
        "call-42",
        { result: "ok" },
        false,
      );
    });

    it("dispatches 'update-metadata' to handle.updateMetadata", () => {
      facade.executeChannelAction(
        {
          target: "channel",
          channelId: "ch-1",
          op: "update-metadata",
          metadata: { status: "typing" },
        },
        "p-1",
      );

      expect(pubsubMocks.mockHandle.updateMetadata).toHaveBeenCalledWith({
        status: "typing",
      });
    });

    it("dispatches 'send-ephemeral' to handle.sendMessage with persist:false", () => {
      facade.executeChannelAction(
        {
          target: "channel",
          channelId: "ch-1",
          op: "send-ephemeral",
          content: "typing indicator",
          contentType: "status",
        },
        "p-1",
      );

      expect(pubsubMocks.mockHandle.sendMessage).toHaveBeenCalledWith(
        expect.any(String), // randomUUID
        "typing indicator",
        { contentType: "status", persist: false },
      );
    });

    it("returns silently for unknown participantId", () => {
      // Should not throw
      facade.executeChannelAction(
        {
          target: "channel",
          channelId: "ch-1",
          op: "send",
          messageId: "msg-1",
          content: "Hello",
        },
        "unknown-participant",
      );

      expect(pubsubMocks.mockHandle.sendMessage).not.toHaveBeenCalled();
    });

    it("dispatches 'call-method' via callParticipantMethod async (fires sendMethodCall on caller handle)", async () => {
      facade.executeChannelAction(
        {
          target: "channel",
          channelId: "ch-1",
          op: "call-method",
          callId: "call-1",
          participantId: "other",
          method: "doSomething",
          args: {},
        },
        "p-1",
      );

      // call-method fires async — sendMethodCall on the caller's handle
      // Give the microtask a chance to settle
      await new Promise(r => setTimeout(r, 50));

      // The caller's handle should have sent a method-call
      expect(pubsubMocks.mockHandle.sendMethodCall).toHaveBeenCalledWith(
        "call-1",
        "other",
        "doSomething",
        {},
      );
    });
  });

  // ── Event dispatch (onEvent callback) ───────────────────────────────────

  describe("event dispatch", () => {
    it("dispatches channel events to the DO via workerRouter", async () => {
      await facade.subscribe({
        channelId: "ch-1",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor: defaultDescriptor(),
      });

      const callback = pubsubMocks.capturedCallbacks.get("p-1")!;
      expect(callback).toBeDefined();

      const event: ChannelBroadcastEvent = {
        id: 10,
        type: "message",
        payload: '{"text":"hi"}',
        senderId: "user-1",
        ts: Date.now(),
        persist: true,
      };

      callback.onEvent(event);

      // Flush the async queue
      const entry = facade.getHandle("p-1")!;
      await entry.queue.flush();

      expect(
        (router as unknown as Record<string, ReturnType<typeof vi.fn>>)["dispatch"],
      ).toHaveBeenCalledWith(
        "ChatDO",
        "room-1",
        "onChannelEvent",
        "ch-1",
        expect.objectContaining({
          id: 10,
          messageId: "10",
          type: "message",
          payload: { text: "hi" },
          senderId: "user-1",
        }),
      );
    });

    it("parses senderMetadata JSON and extracts type", async () => {
      await facade.subscribe({
        channelId: "ch-1",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor: defaultDescriptor(),
      });

      const callback = pubsubMocks.capturedCallbacks.get("p-1")!;

      callback.onEvent({
        id: 11,
        type: "message",
        payload: "hello",
        senderId: "user-1",
        senderMetadata: JSON.stringify({ type: "panel", name: "User" }),
        ts: Date.now(),
        persist: true,
      });

      const entry = facade.getHandle("p-1")!;
      await entry.queue.flush();

      expect(
        (router as unknown as Record<string, ReturnType<typeof vi.fn>>)["dispatch"],
      ).toHaveBeenCalledWith(
        "ChatDO",
        "room-1",
        "onChannelEvent",
        "ch-1",
        expect.objectContaining({
          senderType: "panel",
        }),
      );
    });

    it("skips events from the participant itself (feedback loop prevention)", async () => {
      await facade.subscribe({
        channelId: "ch-1",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor: defaultDescriptor(),
      });

      const callback = pubsubMocks.capturedCallbacks.get("p-1")!;

      callback.onEvent({
        id: 12,
        type: "message",
        payload: "echo",
        senderId: "p-1", // Same as participantId
        ts: Date.now(),
        persist: true,
      });

      const entry = facade.getHandle("p-1")!;
      await entry.queue.flush();

      expect(
        (router as unknown as Record<string, ReturnType<typeof vi.fn>>)["dispatch"],
      ).not.toHaveBeenCalled();
    });

    it("executes returned actions from the DO dispatch", async () => {
      const returnedActions: WorkerActions = {
        actions: [
          {
            target: "channel",
            channelId: "ch-1",
            op: "send",
            messageId: "reply-1",
            content: "response",
          },
        ],
      };
      (
        (router as unknown as Record<string, ReturnType<typeof vi.fn>>)["dispatch"]!
      ).mockResolvedValue(returnedActions);

      await facade.subscribe({
        channelId: "ch-1",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor: defaultDescriptor(),
      });

      const callback = pubsubMocks.capturedCallbacks.get("p-1")!;
      callback.onEvent({
        id: 13,
        type: "message",
        payload: "trigger",
        senderId: "user-1",
        ts: Date.now(),
        persist: true,
      });

      const entry = facade.getHandle("p-1")!;
      await entry.queue.flush();

      expect(executeActions).toHaveBeenCalledWith(returnedActions, {
        participantId: "p-1",
      });
    });

    it("does not call executeActions when dispatch returns empty actions", async () => {
      (
        (router as unknown as Record<string, ReturnType<typeof vi.fn>>)["dispatch"]!
      ).mockResolvedValue({ actions: [] });

      await facade.subscribe({
        channelId: "ch-1",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor: defaultDescriptor(),
      });

      const callback = pubsubMocks.capturedCallbacks.get("p-1")!;
      callback.onEvent({
        id: 14,
        type: "message",
        payload: "noop",
        senderId: "user-1",
        ts: Date.now(),
        persist: true,
      });

      const entry = facade.getHandle("p-1")!;
      await entry.queue.flush();

      expect(executeActions).not.toHaveBeenCalled();
    });

    it("handles dispatch errors gracefully (does not throw)", async () => {
      (
        (router as unknown as Record<string, ReturnType<typeof vi.fn>>)["dispatch"]!
      ).mockRejectedValue(new Error("DO unavailable"));

      await facade.subscribe({
        channelId: "ch-1",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor: defaultDescriptor(),
      });

      const callback = pubsubMocks.capturedCallbacks.get("p-1")!;
      callback.onEvent({
        id: 15,
        type: "message",
        payload: "boom",
        senderId: "user-1",
        ts: Date.now(),
        persist: true,
      });

      const entry = facade.getHandle("p-1")!;
      // Should not reject — error is caught internally
      await entry.queue.flush();
    });
  });

  // ── Utility methods ─────────────────────────────────────────────────────

  describe("getAllEntries()", () => {
    it("returns all registered participants", async () => {
      await facade.subscribe({
        channelId: "ch-1",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor: defaultDescriptor(),
      });

      // Provide a second handle so both entries are distinct
      const secondHandle = createMockHandle();
      (pubsubMocks.pubsub.registerParticipant as ReturnType<typeof vi.fn>).mockReturnValue(
        secondHandle,
      );

      await facade.subscribe({
        channelId: "ch-2",
        participantId: "p-2",
        className: "NoteDO",
        objectKey: "note-1",
        descriptor: defaultDescriptor(),
      });

      const entries = facade.getAllEntries();
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.participantId).sort()).toEqual(["p-1", "p-2"]);
    });
  });

  describe("flushAll()", () => {
    it("waits for all queues to settle", async () => {
      await facade.subscribe({
        channelId: "ch-1",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor: defaultDescriptor(),
      });

      const callback = pubsubMocks.capturedCallbacks.get("p-1")!;
      callback.onEvent({
        id: 20,
        type: "message",
        payload: "flush-test",
        senderId: "user-1",
        ts: Date.now(),
        persist: true,
      });

      await facade.flushAll();

      // After flush, the dispatch should have been called
      expect(
        (router as unknown as Record<string, ReturnType<typeof vi.fn>>)["dispatch"],
      ).toHaveBeenCalled();
    });
  });

  describe("unsubscribeAll()", () => {
    it("calls leave() on all handles and clears entries", async () => {
      await facade.subscribe({
        channelId: "ch-1",
        participantId: "p-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor: defaultDescriptor(),
      });

      const firstHandle = pubsubMocks.mockHandle;
      const secondHandle = createMockHandle();
      (pubsubMocks.pubsub.registerParticipant as ReturnType<typeof vi.fn>).mockReturnValue(
        secondHandle,
      );

      await facade.subscribe({
        channelId: "ch-2",
        participantId: "p-2",
        className: "NoteDO",
        objectKey: "note-1",
        descriptor: defaultDescriptor(),
      });

      facade.unsubscribeAll();

      expect(firstHandle.leave).toHaveBeenCalled();
      expect(secondHandle.leave).toHaveBeenCalled();
      expect(facade.getAllEntries()).toHaveLength(0);
    });
  });
});
