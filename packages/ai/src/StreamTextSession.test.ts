import { describe, it, expect, vi } from "vitest";
import type { StreamTextOptions } from "@natstack/types";
import { StreamTextSession } from "./StreamTextSession.js";

/** Minimal options stub — tests only exercise event processing, not model/messages */
function opts(overrides: Partial<StreamTextOptions> = {}): StreamTextOptions {
  return { model: "test", messages: [], ...overrides };
}

describe("StreamTextSession", () => {
  it("processEvent with text-delta accumulates fullText", async () => {
    const session = new StreamTextSession("s1", opts(), vi.fn());

    await session.processEvent({ type: "text-delta", text: "hello " });
    await session.processEvent({ type: "text-delta", text: "world" });

    // Verify via toResult().text promise
    session.cleanup();
    const result = session.toResult();
    await expect(result.text).resolves.toBe("hello world");
  });

  it("processEvent with tool-call accumulates toolCalls", async () => {
    const session = new StreamTextSession("s1", opts(), vi.fn());

    await session.processEvent({
      type: "tool-call",
      toolCallId: "tc1",
      toolName: "search",
      args: { query: "test" },
    });

    session.cleanup();
    const result = session.toResult();
    await expect(result.toolCalls).resolves.toEqual([
      { toolCallId: "tc1", toolName: "search", args: { query: "test" } },
    ]);
  });

  it("processEvent with step-finish resets per-step state and calls onStepFinish", async () => {
    const onStepFinish = vi.fn();
    const session = new StreamTextSession("s1", opts({ onStepFinish }), vi.fn());

    await session.processEvent({ type: "text-delta", text: "step1 text" });
    await session.processEvent({
      type: "step-finish",
      stepNumber: 0,
      finishReason: "tool-calls",
    });

    expect(onStepFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        stepNumber: 0,
        finishReason: "tool-calls",
        text: "step1 text",
      })
    );

    // After step-finish, new text-delta starts fresh per-step
    await session.processEvent({ type: "text-delta", text: "step2" });
    await session.processEvent({
      type: "step-finish",
      stepNumber: 1,
      finishReason: "stop",
    });

    expect(onStepFinish).toHaveBeenCalledTimes(2);
    expect(onStepFinish.mock.calls[1]![0].text).toBe("step2");
  });

  it("processEvent with finish calls onFinish callback with accumulated state", async () => {
    const onFinish = vi.fn();
    const session = new StreamTextSession("s1", opts({ onFinish }), vi.fn());

    await session.processEvent({ type: "text-delta", text: "result text" });
    await session.processEvent({
      type: "finish",
      totalSteps: 1,
      usage: { promptTokens: 10, completionTokens: 20 },
    });

    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "result text",
        totalSteps: 1,
        usage: { promptTokens: 10, completionTokens: 20 },
      })
    );
  });

  it("processEvent with error calls onError callback and sets streamError", async () => {
    const onError = vi.fn();
    const session = new StreamTextSession("s1", opts({ onError }), vi.fn());

    const err = new Error("stream failed");
    await session.processEvent({ type: "error", error: err });

    expect(onError).toHaveBeenCalledWith(err);
  });

  it("onChunk callback is called for every event type", async () => {
    const onChunk = vi.fn();
    const session = new StreamTextSession("s1", opts({ onChunk }), vi.fn());

    const events = [
      { type: "text-delta" as const, text: "hi" },
      { type: "tool-call" as const, toolCallId: "tc1", toolName: "t", args: {} },
      { type: "finish" as const, totalSteps: 1 },
    ];

    for (const event of events) {
      await session.processEvent(event);
    }

    expect(onChunk).toHaveBeenCalledTimes(3);
    expect(onChunk.mock.calls[0]![0]).toEqual(events[0]);
    expect(onChunk.mock.calls[1]![0]).toEqual(events[1]);
    expect(onChunk.mock.calls[2]![0]).toEqual(events[2]);
  });

  it("callback errors are caught and logged", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onChunk = vi.fn().mockRejectedValue(new Error("callback broke"));
    const session = new StreamTextSession("s1", opts({ onChunk }), vi.fn());

    // Should not throw despite callback error
    await session.processEvent({ type: "text-delta", text: "hi" });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("cleanup resolves all pending promises", async () => {
    const session = new StreamTextSession("s1", opts(), vi.fn());
    const result = session.toResult();

    await session.processEvent({ type: "text-delta", text: "final" });

    // Get promises before cleanup
    const textPromise = result.text;
    const toolCallsPromise = result.toolCalls;
    const finishReasonPromise = result.finishReason;

    session.cleanup();

    await expect(textPromise).resolves.toBe("final");
    await expect(toolCallsPromise).resolves.toEqual([]);
    await expect(finishReasonPromise).resolves.toBe("stop");
  });

  it("createIterator delivers queued events", async () => {
    const session = new StreamTextSession("s1", opts(), vi.fn());

    // Queue events before creating iterator
    await session.processEvent({ type: "text-delta", text: "a" });
    await session.processEvent({ type: "text-delta", text: "b" });

    const iterator = session.createIterator();

    const r1 = await iterator.next();
    expect(r1.done).toBe(false);
    expect(r1.value).toEqual({ type: "text-delta", text: "a" });

    const r2 = await iterator.next();
    expect(r2.done).toBe(false);
    expect(r2.value).toEqual({ type: "text-delta", text: "b" });

    // Now end the stream
    session.cleanup();

    const r3 = await iterator.next();
    expect(r3.done).toBe(true);
  });

  it("createIterator throws on second call", () => {
    const session = new StreamTextSession("s1", opts(), vi.fn());

    session.createIterator();

    expect(() => session.createIterator()).toThrow("Multiple iterators");
  });

  it("cancel calls onCancel and cleans up", async () => {
    const onCancel = vi.fn();
    const session = new StreamTextSession("s1", opts(), onCancel);
    const unsub = vi.fn();
    session.addUnsubscriber(unsub);

    session.cancel();

    expect(onCancel).toHaveBeenCalled();
    expect(unsub).toHaveBeenCalled();
  });
});
