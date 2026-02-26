/**
 * Tests for AI service handler.
 */

import { handleAiServiceCall } from "./aiHandlers.js";

describe("handleAiServiceCall", () => {
  const mockAiHandler = {
    getAvailableRoles: vi.fn().mockResolvedValue({ editor: true }),
    cancelStream: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined),
  };
  const mockStartStream = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when aiHandler is null", async () => {
    await expect(
      handleAiServiceCall(null, "listRoles", [], mockStartStream),
    ).rejects.toThrow("AI handler not initialized");
  });

  it("listRoles calls aiHandler.getAvailableRoles()", async () => {
    const result = await handleAiServiceCall(
      mockAiHandler as any,
      "listRoles",
      [],
      mockStartStream,
    );
    expect(mockAiHandler.getAvailableRoles).toHaveBeenCalled();
    expect(result).toEqual({ editor: true });
  });

  it("streamCancel calls aiHandler.cancelStream(streamId)", async () => {
    await handleAiServiceCall(
      mockAiHandler as any,
      "streamCancel",
      ["stream-42"],
      mockStartStream,
    );
    expect(mockAiHandler.cancelStream).toHaveBeenCalledWith("stream-42");
  });

  it("streamTextStart calls startStream with handler, options, and streamId", async () => {
    const options = { model: "claude-3", messages: [] };
    await handleAiServiceCall(
      mockAiHandler as any,
      "streamTextStart",
      [options, "stream-99"],
      mockStartStream,
    );
    expect(mockStartStream).toHaveBeenCalledWith(
      mockAiHandler,
      options,
      "stream-99",
    );
  });

  it("reinitialize throws for non-server callers and succeeds for server callers", async () => {
    await expect(
      handleAiServiceCall(
        mockAiHandler as any,
        "reinitialize",
        [],
        mockStartStream,
        "panel",
      ),
    ).rejects.toThrow("ai.reinitialize is restricted to server callers");

    await handleAiServiceCall(
      mockAiHandler as any,
      "reinitialize",
      [],
      mockStartStream,
      "server",
    );
    expect(mockAiHandler.initialize).toHaveBeenCalled();
  });

  it("throws on unknown method", async () => {
    await expect(
      handleAiServiceCall(
        mockAiHandler as any,
        "unknownMethod",
        [],
        mockStartStream,
      ),
    ).rejects.toThrow("Unknown AI method: unknownMethod");
  });
});
