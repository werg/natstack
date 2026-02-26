import { createResponseManager } from "./response-manager.js";

describe("createResponseManager", () => {
  const mockClient = {
    send: vi.fn().mockResolvedValue({ messageId: "msg-1" }),
    complete: vi.fn().mockResolvedValue(undefined),
  };

  const mockTrackers = {
    typing: {
      isTyping: vi.fn().mockReturnValue(true),
      stopTyping: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockResolvedValue(undefined),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getMessageId returns null initially", () => {
    const response = createResponseManager({
      client: mockClient as any,
      replyTo: "reply-1",
    });
    expect(response.getMessageId()).toBeNull();
  });

  it("hasMessage returns false initially", () => {
    const response = createResponseManager({
      client: mockClient as any,
      replyTo: "reply-1",
    });
    expect(response.hasMessage()).toBe(false);
  });

  it("ensureMessage creates a message via client.send and returns messageId", async () => {
    const response = createResponseManager({
      client: mockClient as any,
      replyTo: "reply-1",
    });
    const id = await response.ensureMessage();
    expect(id).toBe("msg-1");
    expect(mockClient.send).toHaveBeenCalledWith("", { replyTo: "reply-1" });
    expect(response.hasMessage()).toBe(true);
    expect(response.getMessageId()).toBe("msg-1");
  });

  it("ensureMessage returns same messageId on subsequent calls (lazy creation)", async () => {
    const response = createResponseManager({
      client: mockClient as any,
      replyTo: "reply-1",
    });
    const id1 = await response.ensureMessage();
    const id2 = await response.ensureMessage();
    expect(id1).toBe(id2);
    expect(mockClient.send).toHaveBeenCalledTimes(1);
  });

  it("ensureMessage stops typing tracker before creating message", async () => {
    const response = createResponseManager({
      client: mockClient as any,
      replyTo: "reply-1",
      trackers: mockTrackers as any,
    });
    await response.ensureMessage();
    expect(mockTrackers.typing.isTyping).toHaveBeenCalled();
    expect(mockTrackers.typing.stopTyping).toHaveBeenCalled();
    // stopTyping should be called before send
    const stopOrder = mockTrackers.typing.stopTyping.mock.invocationCallOrder[0];
    const sendOrder = mockClient.send.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(sendOrder);
  });

  it("commitCheckpointIfNeeded calls commitCheckpoint once, second call is no-op", () => {
    const commitCheckpoint = vi.fn();
    const response = createResponseManager({
      client: mockClient as any,
      replyTo: "reply-1",
      pubsubId: 42,
      commitCheckpoint,
    });

    expect(response.isCheckpointCommitted()).toBe(false);
    response.commitCheckpointIfNeeded();
    expect(commitCheckpoint).toHaveBeenCalledWith(42);
    expect(response.isCheckpointCommitted()).toBe(true);

    // Second call should be a no-op
    response.commitCheckpointIfNeeded();
    expect(commitCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("complete calls client.complete when message exists", async () => {
    const response = createResponseManager({
      client: mockClient as any,
      replyTo: "reply-1",
    });
    await response.ensureMessage();
    await response.complete();
    expect(mockClient.complete).toHaveBeenCalledWith("msg-1");
  });

  it("cleanup stops typing tracker when no message created", async () => {
    const response = createResponseManager({
      client: mockClient as any,
      replyTo: "reply-1",
      trackers: mockTrackers as any,
    });
    await response.cleanup();
    expect(mockTrackers.typing.cleanup).toHaveBeenCalled();
  });
});
