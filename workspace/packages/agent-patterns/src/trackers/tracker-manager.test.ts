const { mockTyping, mockThinking, mockAction } = vi.hoisted(() => ({
  mockTyping: { setReplyTo: vi.fn(), cleanup: vi.fn().mockResolvedValue(true) },
  mockThinking: { setReplyTo: vi.fn(), cleanup: vi.fn().mockResolvedValue(true) },
  mockAction: { setReplyTo: vi.fn(), cleanup: vi.fn().mockResolvedValue(true) },
}));

vi.mock("@workspace/agentic-protocol", () => ({
  createTypingTracker: vi.fn().mockReturnValue(mockTyping),
  createThinkingTracker: vi.fn().mockReturnValue(mockThinking),
  createActionTracker: vi.fn().mockReturnValue(mockAction),
}));

import { createTrackerManager } from "./tracker-manager.js";

describe("createTrackerManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates all three trackers (typing, thinking, action)", () => {
    const manager = createTrackerManager({
      client: {} as any,
    });
    expect(manager.typing).toBe(mockTyping);
    expect(manager.thinking).toBe(mockThinking);
    expect(manager.action).toBe(mockAction);
  });

  it("setReplyTo propagates to all trackers", () => {
    const manager = createTrackerManager({
      client: {} as any,
    });
    manager.setReplyTo("msg-123");
    expect(mockTyping.setReplyTo).toHaveBeenCalledWith("msg-123");
    expect(mockThinking.setReplyTo).toHaveBeenCalledWith("msg-123");
    expect(mockAction.setReplyTo).toHaveBeenCalledWith("msg-123");
  });

  it("cleanupAll calls cleanup on all three trackers", async () => {
    const manager = createTrackerManager({
      client: {} as any,
    });
    await manager.cleanupAll();
    expect(mockTyping.cleanup).toHaveBeenCalled();
    expect(mockThinking.cleanup).toHaveBeenCalled();
    expect(mockAction.cleanup).toHaveBeenCalled();
  });

  it("cleanupAll returns true when all succeed", async () => {
    const manager = createTrackerManager({
      client: {} as any,
    });
    const result = await manager.cleanupAll();
    expect(result).toBe(true);
  });

  it("cleanupAll returns false when one fails", async () => {
    mockThinking.cleanup.mockResolvedValueOnce(false);
    const manager = createTrackerManager({
      client: {} as any,
    });
    const result = await manager.cleanupAll();
    expect(result).toBe(false);
  });
});
