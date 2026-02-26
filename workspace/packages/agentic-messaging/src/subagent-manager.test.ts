const { mockSubagent } = vi.hoisted(() => ({
  mockSubagent: {
    complete: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("./subagent-connection.js", () => ({
  createSubagentConnection: vi.fn().mockResolvedValue(mockSubagent),
  forwardStreamEventToSubagent: vi.fn().mockResolvedValue(undefined),
}));

import { SubagentManager } from "./subagent-manager.js";
import { createSubagentConnection, forwardStreamEventToSubagent } from "./subagent-connection.js";

describe("SubagentManager", () => {
  const config = {
    serverUrl: "ws://test",
    token: "token",
    channel: "ch",
    parentClient: { contextId: "ctx" } as any,
    log: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("constructor sets up correctly", () => {
    const manager = new SubagentManager(config);
    expect(manager.size).toBe(0);
  });

  it("has() returns false for unknown toolUseId", () => {
    const manager = new SubagentManager(config);
    expect(manager.has("unknown-id")).toBe(false);
  });

  it("bufferEvent stores events for later", () => {
    const manager = new SubagentManager(config);
    const event = { type: "text-delta", text: "hello" } as any;
    manager.bufferEvent("tool-1", event);
    // Buffered events are internal; verify they flush on create
    expect(manager.has("tool-1")).toBe(false);
  });

  it("create creates subagent, flushes buffered events", async () => {
    const manager = new SubagentManager(config);
    const event1 = { type: "text-delta", text: "buffered1" } as any;
    const event2 = { type: "text-delta", text: "buffered2" } as any;
    manager.bufferEvent("tool-1", event1);
    manager.bufferEvent("tool-1", event2);

    await manager.create("tool-1", {
      taskDescription: "Test task",
      subagentType: "Explore",
      parentToolUseId: "tool-1",
    });

    expect(createSubagentConnection).toHaveBeenCalled();
    expect(manager.has("tool-1")).toBe(true);
    expect(manager.size).toBe(1);

    // Buffered events should be flushed
    expect(forwardStreamEventToSubagent).toHaveBeenCalledTimes(2);
    expect(forwardStreamEventToSubagent).toHaveBeenCalledWith(mockSubagent, event1);
    expect(forwardStreamEventToSubagent).toHaveBeenCalledWith(mockSubagent, event2);
  });

  it("create sets timeout", async () => {
    const manager = new SubagentManager({ ...config, timeoutMs: 5000 });
    await manager.create("tool-1", {
      taskDescription: "Test task",
      parentToolUseId: "tool-1",
    });

    expect(manager.has("tool-1")).toBe(true);

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(5000);

    // Subagent should be cleaned up after timeout
    expect(mockSubagent.error).toHaveBeenCalledWith("Subagent timed out");
    expect(mockSubagent.close).toHaveBeenCalled();
    expect(manager.has("tool-1")).toBe(false);
  });

  it("forward returns true for active subagent, false for unknown", async () => {
    const manager = new SubagentManager(config);
    const event = { type: "text-delta", text: "hello" } as any;

    // Unknown subagent
    const result1 = await manager.forward("unknown", event);
    expect(result1).toBe(false);

    // Create subagent then forward
    await manager.create("tool-1", {
      taskDescription: "Test",
      parentToolUseId: "tool-1",
    });
    vi.mocked(forwardStreamEventToSubagent).mockClear();

    const result2 = await manager.forward("tool-1", event);
    expect(result2).toBe(true);
    expect(forwardStreamEventToSubagent).toHaveBeenCalledWith(mockSubagent, event);
  });

  it("routeEvent forwards to active subagent", async () => {
    const manager = new SubagentManager(config);
    await manager.create("tool-1", {
      taskDescription: "Test",
      parentToolUseId: "tool-1",
    });
    vi.mocked(forwardStreamEventToSubagent).mockClear();

    const event = { type: "text-delta", text: "routed" } as any;
    await manager.routeEvent("tool-1", event);

    expect(forwardStreamEventToSubagent).toHaveBeenCalledWith(mockSubagent, event);
  });

  it("routeEvent buffers if subagent doesn't exist", async () => {
    const manager = new SubagentManager(config);
    const event = { type: "text-delta", text: "buffered" } as any;
    await manager.routeEvent("tool-1", event);

    // Event should not be forwarded yet (no subagent)
    expect(forwardStreamEventToSubagent).not.toHaveBeenCalled();

    // Now create the subagent - buffered event should flush
    await manager.create("tool-1", {
      taskDescription: "Test",
      parentToolUseId: "tool-1",
    });
    expect(forwardStreamEventToSubagent).toHaveBeenCalledWith(mockSubagent, event);
  });

  it('cleanup("complete") calls subagent.complete() and close()', async () => {
    const manager = new SubagentManager(config);
    await manager.create("tool-1", {
      taskDescription: "Test",
      parentToolUseId: "tool-1",
    });

    await manager.cleanup("tool-1", "complete");

    expect(mockSubagent.complete).toHaveBeenCalled();
    expect(mockSubagent.close).toHaveBeenCalled();
    expect(manager.has("tool-1")).toBe(false);
  });

  it("cleanupAll cleans all active subagents", async () => {
    const manager = new SubagentManager(config);
    await manager.create("tool-1", {
      taskDescription: "Test 1",
      parentToolUseId: "tool-1",
    });
    await manager.create("tool-2", {
      taskDescription: "Test 2",
      parentToolUseId: "tool-2",
    });

    expect(manager.size).toBe(2);
    await manager.cleanupAll();
    expect(manager.size).toBe(0);
    // error is called with "Parent cancelled" for cleanupAll
    expect(mockSubagent.error).toHaveBeenCalledWith("Parent cancelled");
  });

  it("size property tracks active count", async () => {
    const manager = new SubagentManager(config);
    expect(manager.size).toBe(0);

    await manager.create("tool-1", {
      taskDescription: "Test 1",
      parentToolUseId: "tool-1",
    });
    expect(manager.size).toBe(1);

    await manager.create("tool-2", {
      taskDescription: "Test 2",
      parentToolUseId: "tool-2",
    });
    expect(manager.size).toBe(2);

    await manager.cleanup("tool-1", "complete");
    expect(manager.size).toBe(1);
  });
});
