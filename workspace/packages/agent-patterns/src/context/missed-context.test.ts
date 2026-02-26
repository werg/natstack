vi.mock("@workspace/agentic-protocol", () => ({
  formatMissedContext: vi
    .fn()
    .mockReturnValue({ formatted: "context text", count: 2, lastPubsubId: 5 }),
}));

import { createMissedContextManager } from "./missed-context.js";
import { formatMissedContext } from "@workspace/agentic-protocol";

describe("createMissedContextManager", () => {
  const makeClient = (messages: any[] = []) => ({
    missedMessages: messages,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hasPending returns false initially (no rebuild called)", () => {
    const manager = createMissedContextManager({
      client: makeClient() as any,
    });
    expect(manager.hasPending()).toBe(false);
  });

  it("get returns null initially", () => {
    const manager = createMissedContextManager({
      client: makeClient() as any,
    });
    expect(manager.get()).toBeNull();
  });

  it("after rebuild with messages, hasPending returns true and get returns result", () => {
    const messages = [
      { pubsubId: 3, content: "hello" },
      { pubsubId: 5, content: "world" },
    ];
    const manager = createMissedContextManager({
      client: makeClient(messages) as any,
    });

    manager.rebuild();

    expect(manager.hasPending()).toBe(true);
    const result = manager.get();
    expect(result).toEqual({
      formatted: "context text",
      count: 2,
      lastPubsubId: 5,
    });
  });

  it("consume returns formatted text and clears pending", () => {
    const messages = [
      { pubsubId: 3, content: "hello" },
      { pubsubId: 5, content: "world" },
    ];
    const manager = createMissedContextManager({
      client: makeClient(messages) as any,
    });

    manager.rebuild();
    const text = manager.consume();
    expect(text).toBe("context text");

    // After consume, hasPending should be false and get returns null
    expect(manager.hasPending()).toBe(false);
    expect(manager.get()).toBeNull();
  });

  it("sinceId filtering: messages with pubsubId <= sinceId are excluded", () => {
    const messages = [
      { pubsubId: 1, content: "old" },
      { pubsubId: 2, content: "also old" },
      { pubsubId: 3, content: "new" },
    ];
    const manager = createMissedContextManager({
      client: makeClient(messages) as any,
      sinceId: 2,
    });

    manager.rebuild();

    // formatMissedContext should only receive messages with pubsubId > 2
    expect(formatMissedContext).toHaveBeenCalledWith(
      [{ pubsubId: 3, content: "new" }],
      { maxChars: 8000 },
    );
  });

  it("excludeSenderTypes filtering: matching sender types are excluded", () => {
    const messages = [
      { pubsubId: 1, content: "human msg", senderType: "panel" },
      { pubsubId: 2, content: "agent msg", senderType: "codex" },
      { pubsubId: 3, content: "another human", senderType: "panel" },
    ];
    const manager = createMissedContextManager({
      client: makeClient(messages) as any,
      excludeSenderTypes: ["codex"],
    });

    manager.rebuild();

    // formatMissedContext should exclude the codex message
    expect(formatMissedContext).toHaveBeenCalledWith(
      [
        { pubsubId: 1, content: "human msg", senderType: "panel" },
        { pubsubId: 3, content: "another human", senderType: "panel" },
      ],
      { maxChars: 8000 },
    );
  });

  it("consume updates lastProcessedPubsubId for subsequent rebuilds", () => {
    const messages = [
      { pubsubId: 3, content: "first batch" },
      { pubsubId: 5, content: "first batch 2" },
    ];
    const client = makeClient(messages);
    const manager = createMissedContextManager({
      client: client as any,
    });

    // First consume
    manager.rebuild();
    manager.consume();

    // Now add new messages and rebuild
    // After consume, lastProcessedPubsubId should be 5 (from lastPubsubId in mock return)
    vi.mocked(formatMissedContext).mockClear();

    client.missedMessages = [
      { pubsubId: 3, content: "first batch" },
      { pubsubId: 5, content: "first batch 2" },
      { pubsubId: 7, content: "new message" },
    ];
    manager.rebuild();

    // Should only include messages with pubsubId > 5
    expect(formatMissedContext).toHaveBeenCalledWith(
      [{ pubsubId: 7, content: "new message" }],
      { maxChars: 8000 },
    );
  });
});
