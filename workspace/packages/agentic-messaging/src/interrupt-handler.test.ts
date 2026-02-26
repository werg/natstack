import { createInterruptHandler } from "./interrupt-handler.js";

describe("createInterruptHandler", () => {
  let mockEvents: any[];
  let eventResolve: any;
  let mockIterator: any;
  let client: any;

  beforeEach(() => {
    mockEvents = [];
    eventResolve = null;

    mockIterator = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if (mockEvents.length > 0) {
          return { done: false, value: mockEvents.shift() };
        }
        return new Promise((resolve) => {
          eventResolve = resolve;
        });
      },
      return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
    };

    client = {
      events: vi.fn().mockReturnValue(mockIterator),
      publish: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("isPaused returns false initially", () => {
    const handler = createInterruptHandler({
      client: client as any,
      messageId: "msg-1",
    });
    expect(handler.isPaused()).toBe(false);
  });

  it("cleanup sets monitoring inactive", () => {
    const handler = createInterruptHandler({
      client: client as any,
      messageId: "msg-1",
    });

    // Start monitoring, then immediately clean up
    const monitorPromise = handler.monitor();
    handler.cleanup();

    // The iterator's return should be called to close it
    expect(mockIterator.return).toHaveBeenCalled();
  });

  it('monitor listens for "pause" method-call events', async () => {
    const handler = createInterruptHandler({
      client: client as any,
      messageId: "msg-1",
    });

    // Queue a pause event before starting monitor
    mockEvents.push({
      type: "method-call",
      methodName: "pause",
      args: { reason: "User requested" },
    });

    await handler.monitor();

    expect(client.events).toHaveBeenCalled();
    expect(handler.isPaused()).toBe(true);
  });

  it("when pause event received, isPaused returns true", async () => {
    const handler = createInterruptHandler({
      client: client as any,
      messageId: "msg-1",
    });

    mockEvents.push({
      type: "method-call",
      methodName: "pause",
      args: { reason: "Stopping" },
    });

    await handler.monitor();
    expect(handler.isPaused()).toBe(true);
  });

  it("onPause callback is called with reason", async () => {
    const onPause = vi.fn();
    const handler = createInterruptHandler({
      client: client as any,
      messageId: "msg-1",
      onPause,
    });

    mockEvents.push({
      type: "method-call",
      methodName: "pause",
      args: { reason: "User cancelled" },
    });

    await handler.monitor();
    expect(onPause).toHaveBeenCalledWith("User cancelled");
  });

  it("after pause, publishes execution-pause event", async () => {
    const handler = createInterruptHandler({
      client: client as any,
      messageId: "msg-1",
    });

    mockEvents.push({
      type: "method-call",
      methodName: "pause",
      args: { reason: "Interrupted" },
    });

    await handler.monitor();

    expect(client.publish).toHaveBeenCalledWith(
      "execution-pause",
      {
        messageId: "msg-1",
        status: "paused",
        reason: "Interrupted",
      },
      { persist: true },
    );
  });
});
