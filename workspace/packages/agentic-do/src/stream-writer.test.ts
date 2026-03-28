import { describe, it, expect, vi, beforeEach } from "vitest";
import { StreamWriter } from "./stream-writer.js";

describe("StreamWriter typing lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("persists typing messages so busy state survives reconnects", async () => {
    const channel = {
      send: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined),
    };
    const writer = new StreamWriter(
      channel as never,
      "agent-1",
      "ch-1",
      "msg-1",
      '{"senderName":"AI Chat"}',
      {
        responseMessageId: null,
        thinkingMessageId: null,
        actionMessageId: null,
        typingMessageId: null,
      },
    );

    await writer.startTyping();

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0]![3]).toMatchObject({
      contentType: "typing",
      persist: true,
      replyTo: "msg-1",
    });
  });

  it("keeps typing active while the turn moves through thinking, action, and text", async () => {
    const channel = {
      send: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined),
    };
    const writer = new StreamWriter(
      channel as never,
      "agent-1",
      "ch-1",
      "msg-1",
      '{"senderName":"AI Chat"}',
      {
        responseMessageId: null,
        thinkingMessageId: null,
        actionMessageId: null,
        typingMessageId: null,
      },
    );

    await writer.startTyping();
    const typingMessageId = writer.getState().typingMessageId;

    await writer.startThinking();
    await writer.startAction("eval", "Running eval", "tool-1");
    await writer.startText();

    expect(writer.getState().typingMessageId).toBe(typingMessageId);
    expect(channel.complete).not.toHaveBeenCalledWith("agent-1", typingMessageId, expect.anything());
  });
});
