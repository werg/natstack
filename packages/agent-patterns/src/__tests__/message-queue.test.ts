import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMessageQueue } from "../queue/message-queue.js";
import type { EventStreamItem } from "@workspace/agentic-messaging";

// Mock event factory
function createMockEvent(id: number): EventStreamItem {
  return {
    type: "message",
    kind: "persisted",
    id: `msg-${id}`,
    pubsubId: id,
    content: `Message ${id}`,
    senderId: "sender",
    ts: Date.now(),
  } as EventStreamItem;
}

describe("createMessageQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("should process events sequentially by default", async () => {
    const processed: number[] = [];
    const queue = createMessageQueue({
      onProcess: async (event) => {
        processed.push((event as { pubsubId: number }).pubsubId);
        await new Promise((r) => setTimeout(r, 10));
      },
    });

    queue.enqueue(createMockEvent(1));
    queue.enqueue(createMockEvent(2));
    queue.enqueue(createMockEvent(3));

    // Process all timers
    await vi.runAllTimersAsync();
    await queue.drain();

    expect(processed).toEqual([1, 2, 3]);
  });

  it("should return false when enqueueing after stop", () => {
    const queue = createMessageQueue({
      onProcess: vi.fn(),
    });

    queue.stop();
    const result = queue.enqueue(createMockEvent(1));

    expect(result).toBe(false);
    expect(queue.getStats().stopped).toBe(true);
  });

  it("should drain immediately when empty", async () => {
    const queue = createMessageQueue({
      onProcess: vi.fn(),
    });

    const drainPromise = queue.drain();
    await expect(drainPromise).resolves.toBeUndefined();
  });

  it("should wait for processing to complete on drain", async () => {
    let processedCount = 0;
    const queue = createMessageQueue({
      onProcess: async () => {
        await new Promise((r) => setTimeout(r, 50));
        processedCount++;
      },
    });

    queue.enqueue(createMockEvent(1));
    queue.enqueue(createMockEvent(2));

    // Start drain (won't complete until processing done)
    const drainPromise = queue.drain();

    // Should not be done yet
    expect(processedCount).toBe(0);

    // Process timers
    await vi.runAllTimersAsync();
    await drainPromise;

    expect(processedCount).toBe(2);
  });

  it("should call onError when processing fails", async () => {
    const onError = vi.fn();
    const error = new Error("Processing failed");

    const queue = createMessageQueue({
      onProcess: async () => {
        throw error;
      },
      onError,
    });

    queue.enqueue(createMockEvent(1));
    await vi.runAllTimersAsync();
    await queue.drain();

    expect(onError).toHaveBeenCalledWith(error, expect.anything());
  });

  it("should pause and resume processing", async () => {
    const processed: number[] = [];
    const queue = createMessageQueue({
      onProcess: async (event) => {
        processed.push((event as { pubsubId: number }).pubsubId);
      },
    });

    // Enqueue first event and let it process
    queue.enqueue(createMockEvent(1));
    await vi.runAllTimersAsync();

    // Pause and enqueue more
    queue.pause();
    expect(queue.isPaused()).toBe(true);

    queue.enqueue(createMockEvent(2));
    queue.enqueue(createMockEvent(3));

    // Should only have processed first event
    await vi.runAllTimersAsync();
    expect(processed).toEqual([1]);

    // Resume
    queue.resume();
    expect(queue.isPaused()).toBe(false);

    await vi.runAllTimersAsync();
    await queue.drain();

    expect(processed).toEqual([1, 2, 3]);
  });

  it("should report correct stats", async () => {
    const queue = createMessageQueue({
      onProcess: async () => {
        await new Promise((r) => setTimeout(r, 100));
      },
    });

    // Initially empty
    expect(queue.getStats()).toEqual({
      pending: 0,
      processing: false,
      stopped: false,
      paused: false,
    });

    // Enqueue events
    queue.enqueue(createMockEvent(1));
    queue.enqueue(createMockEvent(2));

    // After enqueueing (first is processing)
    expect(queue.getStats().pending).toBe(1);
    expect(queue.getStats().processing).toBe(true);

    // After stop
    queue.stop();
    expect(queue.getStats().stopped).toBe(true);

    await vi.runAllTimersAsync();
    await queue.drain();
  });

  it("should support concurrency > 1", async () => {
    const processing: number[] = [];
    const completed: number[] = [];

    const queue = createMessageQueue({
      onProcess: async (event) => {
        const id = (event as { pubsubId: number }).pubsubId;
        processing.push(id);
        await new Promise((r) => setTimeout(r, 50));
        completed.push(id);
      },
      concurrency: 2,
    });

    queue.enqueue(createMockEvent(1));
    queue.enqueue(createMockEvent(2));
    queue.enqueue(createMockEvent(3));

    // Let first batch start
    await vi.advanceTimersByTimeAsync(10);

    // Both 1 and 2 should be processing
    expect(processing).toContain(1);
    expect(processing).toContain(2);
    expect(processing).not.toContain(3);

    // Complete all
    await vi.runAllTimersAsync();
    await queue.drain();

    expect(completed).toEqual([1, 2, 3]);
  });

  describe("takePending", () => {
    it("should return and remove all pending items", async () => {
      vi.useRealTimers();
      let processResolve: (() => void) | null = null;
      const processed: number[] = [];

      const queue = createMessageQueue({
        onProcess: async (event) => {
          processed.push((event as { pubsubId: number }).pubsubId);
          // Block on the first event so items accumulate in pending
          await new Promise<void>((r) => { processResolve = r; });
        },
      });

      // Enqueue first event — it starts processing immediately
      queue.enqueue(createMockEvent(1));
      // Enqueue more — these go to pending since event 1 is processing
      queue.enqueue(createMockEvent(2));
      queue.enqueue(createMockEvent(3));

      expect(queue.getPendingCount()).toBe(2);

      // Take all pending items
      const taken = queue.takePending();
      expect(taken).toHaveLength(2);
      expect((taken[0] as { pubsubId: number }).pubsubId).toBe(2);
      expect((taken[1] as { pubsubId: number }).pubsubId).toBe(3);

      // Pending should now be empty
      expect(queue.getPendingCount()).toBe(0);

      // Unblock processing
      processResolve!();
      await queue.drain();

      // Only the first event was processed via onProcess (taken items bypassed it)
      expect(processed).toEqual([1]);
    });

    it("should return empty array when nothing is pending", () => {
      const queue = createMessageQueue({
        onProcess: vi.fn(),
      });

      const taken = queue.takePending();
      expect(taken).toEqual([]);
    });

    it("should not re-process taken items via processNext", async () => {
      vi.useRealTimers();
      let processResolve: (() => void) | null = null;
      const processed: number[] = [];

      const queue = createMessageQueue({
        onProcess: async (event) => {
          const id = (event as { pubsubId: number }).pubsubId;
          processed.push(id);
          if (id === 1) {
            // Block on event 1 so pending accumulates
            await new Promise<void>((r) => { processResolve = r; });
          }
        },
      });

      queue.enqueue(createMockEvent(1));
      queue.enqueue(createMockEvent(2));
      queue.enqueue(createMockEvent(3));

      // Take pending (events 2, 3)
      queue.takePending();

      // Add a new event after take
      queue.enqueue(createMockEvent(4));

      // Unblock event 1
      processResolve!();
      await queue.drain();

      // Event 1 was processed, events 2/3 were taken, event 4 is the only remaining
      expect(processed).toEqual([1, 4]);
    });

    it("should work with concurrent enqueue", async () => {
      vi.useRealTimers();
      const resolvers: Array<() => void> = [];

      const queue = createMessageQueue({
        onProcess: async () => {
          await new Promise<void>((r) => { resolvers.push(r); });
        },
      });

      // Event 1 starts processing
      queue.enqueue(createMockEvent(1));
      // Events 2, 3 go to pending
      queue.enqueue(createMockEvent(2));
      queue.enqueue(createMockEvent(3));

      // Take all pending
      const taken = queue.takePending();
      expect(taken).toHaveLength(2);

      // Enqueue more after take
      queue.enqueue(createMockEvent(4));
      expect(queue.getPendingCount()).toBe(1);

      // Take remaining to avoid blocking on drain
      const taken2 = queue.takePending();
      expect(taken2).toHaveLength(1);
      expect((taken2[0] as { pubsubId: number }).pubsubId).toBe(4);

      // Cleanup — resolve all processors
      for (const r of resolvers) r();
      await queue.drain();
    });

    it("should work correctly with concurrency > 1", async () => {
      vi.useRealTimers();
      const resolvers: Array<() => void> = [];
      const processed: number[] = [];

      const queue = createMessageQueue({
        onProcess: async (event) => {
          processed.push((event as { pubsubId: number }).pubsubId);
          await new Promise<void>((r) => { resolvers.push(r); });
        },
        concurrency: 2,
      });

      // With concurrency 2, first two start processing immediately
      queue.enqueue(createMockEvent(1));
      queue.enqueue(createMockEvent(2));
      // These go to pending
      queue.enqueue(createMockEvent(3));
      queue.enqueue(createMockEvent(4));

      // Allow microtasks to settle (both processors start)
      await new Promise((r) => setTimeout(r, 10));

      expect(queue.getPendingCount()).toBe(2);

      // Take pending — only drains items not yet claimed by processors
      const taken = queue.takePending();
      expect(taken).toHaveLength(2);
      expect((taken[0] as { pubsubId: number }).pubsubId).toBe(3);
      expect((taken[1] as { pubsubId: number }).pubsubId).toBe(4);

      // Events 1 and 2 are still processing
      expect(processed).toContain(1);
      expect(processed).toContain(2);

      // Resolve all processors
      for (const r of resolvers) r();
      await queue.drain();

      // Only events 1, 2 were processed (3, 4 were taken)
      expect(processed).toEqual([1, 2]);
    });
  });

  describe("onNewItem", () => {
    it("should fire when an item is enqueued while processing is active", async () => {
      vi.useRealTimers();
      const onNewItem = vi.fn();
      let processResolve: (() => void) | null = null;

      const queue = createMessageQueue({
        onProcess: async () => {
          await new Promise<void>((r) => { processResolve = r; });
        },
        onNewItem,
      });

      // First event starts processing (activeCount > 0)
      queue.enqueue(createMockEvent(1));
      expect(onNewItem).not.toHaveBeenCalled();

      // Second event should trigger onNewItem since processing is active
      queue.enqueue(createMockEvent(2));
      expect(onNewItem).toHaveBeenCalledTimes(1);
      expect((onNewItem.mock.calls[0]![0] as { pubsubId: number }).pubsubId).toBe(2);

      // Third event also triggers
      queue.enqueue(createMockEvent(3));
      expect(onNewItem).toHaveBeenCalledTimes(2);

      // Cleanup — take pending to avoid them blocking on processResolve
      queue.takePending();
      processResolve!();
      await queue.drain();
    });

    it("should NOT fire when nothing is processing", () => {
      const onNewItem = vi.fn();

      const queue = createMessageQueue({
        onProcess: vi.fn().mockResolvedValue(undefined),
        onNewItem,
      });

      // Queue is paused so nothing processes
      queue.pause();
      queue.enqueue(createMockEvent(1));
      queue.enqueue(createMockEvent(2));

      // onNewItem should NOT fire (activeCount === 0 because paused)
      expect(onNewItem).not.toHaveBeenCalled();
    });

    it("should not break enqueue if onNewItem throws", async () => {
      vi.useRealTimers();
      const onNewItem = vi.fn().mockImplementation(() => {
        throw new Error("callback error");
      });
      let processResolve: (() => void) | null = null;

      const queue = createMessageQueue({
        onProcess: async () => {
          await new Promise<void>((r) => { processResolve = r; });
        },
        onNewItem,
      });

      // Start processing
      queue.enqueue(createMockEvent(1));

      // This should NOT throw even though onNewItem throws
      const result = queue.enqueue(createMockEvent(2));
      expect(result).toBe(true);
      expect(queue.getPendingCount()).toBe(1);

      // Cleanup
      queue.takePending();
      processResolve!();
      await queue.drain();
    });
  });
});
