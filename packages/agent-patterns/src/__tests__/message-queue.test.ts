import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMessageQueue } from "../queue/message-queue.js";
import type { EventStreamItem } from "@natstack/agentic-messaging";

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
});
