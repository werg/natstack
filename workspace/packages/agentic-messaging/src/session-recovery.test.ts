import {
  computeTranscriptPath,
  readSdkTranscript,
  findCommonAncestor,
  computeSyncDeltas,
  extractMessageText,
  formatContextForSdk,
  prepareRecoveredMessages,
} from "./session-recovery.js";
import type {
  SdkTranscriptMessage,
  PubsubMessageWithMetadata,
} from "./session-recovery.js";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("os", () => ({
  homedir: vi.fn().mockReturnValue("/home/testuser"),
}));

import { readFile } from "fs/promises";

describe("computeTranscriptPath", () => {
  it("converts slashes to dashes in working directory", () => {
    const result = computeTranscriptPath("session-123", "/home/user/project");
    expect(result).toBe(
      "/home/testuser/.claude/projects/-home-user-project/session-123.jsonl"
    );
  });
});

describe("readSdkTranscript", () => {
  it("parses JSONL and filters to user/assistant/result types", async () => {
    const lines = [
      JSON.stringify({ type: "user", uuid: "u1", sessionId: "s1", timestamp: "t1" }),
      JSON.stringify({ type: "assistant", uuid: "u2", sessionId: "s1", timestamp: "t2" }),
      JSON.stringify({ type: "stream_event", uuid: "u3", sessionId: "s1", timestamp: "t3" }),
      JSON.stringify({ type: "result", uuid: "u4", sessionId: "s1", timestamp: "t4" }),
    ].join("\n");

    vi.mocked(readFile).mockResolvedValue(lines);

    const messages = await readSdkTranscript("/path/to/file.jsonl");
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.type)).toEqual(["user", "assistant", "result"]);
  });

  it("returns empty array for missing file (ENOENT)", async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    vi.mocked(readFile).mockRejectedValue(err);

    const messages = await readSdkTranscript("/nonexistent.jsonl");
    expect(messages).toEqual([]);
  });

  it("skips malformed JSON lines", async () => {
    const lines = [
      JSON.stringify({ type: "user", uuid: "u1", sessionId: "s1", timestamp: "t1" }),
      "not valid json",
      JSON.stringify({ type: "assistant", uuid: "u2", sessionId: "s1", timestamp: "t2" }),
    ].join("\n");

    vi.mocked(readFile).mockResolvedValue(lines);

    const messages = await readSdkTranscript("/path/to/file.jsonl");
    expect(messages).toHaveLength(2);
  });
});

describe("findCommonAncestor", () => {
  it("finds matching sdkUuid walking backward", () => {
    const sdkMessages: SdkTranscriptMessage[] = [
      { type: "user", uuid: "sdk-1", sessionId: "s1", timestamp: "t1" },
      { type: "assistant", uuid: "sdk-2", sessionId: "s1", timestamp: "t2" },
    ];

    const pubsubMessages: PubsubMessageWithMetadata[] = [
      { id: "p1", pubsubId: 1, content: "a", senderId: "s", metadata: { sdkUuid: "sdk-1" } },
      { id: "p2", pubsubId: 2, content: "b", senderId: "s", metadata: { sdkUuid: "sdk-2" } },
      { id: "p3", pubsubId: 3, content: "c", senderId: "s", metadata: {} },
    ];

    const index = findCommonAncestor(sdkMessages, pubsubMessages);
    // Should find sdk-2 at index 1 (walking backward)
    expect(index).toBe(1);
  });

  it("returns -1 when no common ancestor found", () => {
    const sdkMessages: SdkTranscriptMessage[] = [
      { type: "user", uuid: "sdk-1", sessionId: "s1", timestamp: "t1" },
    ];

    const pubsubMessages: PubsubMessageWithMetadata[] = [
      { id: "p1", pubsubId: 1, content: "a", senderId: "s", metadata: { sdkUuid: "other" } },
    ];

    const index = findCommonAncestor(sdkMessages, pubsubMessages);
    expect(index).toBe(-1);
  });
});

describe("computeSyncDeltas", () => {
  it("returns correct deltas with common ancestor", () => {
    const sdkMessages: SdkTranscriptMessage[] = [
      { type: "user", uuid: "sdk-1", sessionId: "s1", timestamp: "t1" },
      { type: "assistant", uuid: "sdk-2", sessionId: "s1", timestamp: "t2" },
      { type: "user", uuid: "sdk-3", sessionId: "s1", timestamp: "t3" },
    ];

    const pubsubMessages: PubsubMessageWithMetadata[] = [
      { id: "p1", pubsubId: 1, content: "a", senderId: "s", metadata: { sdkUuid: "sdk-1" } },
      { id: "p2", pubsubId: 2, content: "b", senderId: "s", metadata: { sdkUuid: "sdk-2" } },
      { id: "p3", pubsubId: 3, content: "from-panel", senderId: "panel", senderType: "panel", metadata: {} },
    ];

    const deltas = computeSyncDeltas(sdkMessages, pubsubMessages);
    expect(deltas.commonAncestorIndex).toBe(1);
    expect(deltas.commonAncestorUuid).toBe("sdk-2");
    // p3 is in pubsub but not in SDK
    expect(deltas.pubsubDelta).toHaveLength(1);
    expect(deltas.pubsubDelta[0].id).toBe("p3");
    // sdk-3 is in SDK but not in pubsub
    expect(deltas.sdkDelta).toHaveLength(1);
    expect(deltas.sdkDelta[0].uuid).toBe("sdk-3");
  });

  it("returns correct deltas without common ancestor", () => {
    const sdkMessages: SdkTranscriptMessage[] = [
      { type: "user", uuid: "sdk-1", sessionId: "s1", timestamp: "t1" },
    ];

    const pubsubMessages: PubsubMessageWithMetadata[] = [
      { id: "p1", pubsubId: 1, content: "a", senderId: "s", metadata: { sdkUuid: "no-match" } },
    ];

    const deltas = computeSyncDeltas(sdkMessages, pubsubMessages);
    expect(deltas.commonAncestorIndex).toBe(-1);
    expect(deltas.pubsubDelta).toHaveLength(1);
    expect(deltas.sdkDelta).toHaveLength(1);
  });

  it("excludes subagent messages from deltas", () => {
    const sdkMessages: SdkTranscriptMessage[] = [
      { type: "user", uuid: "sdk-1", sessionId: "s1", timestamp: "t1" },
      { type: "assistant", uuid: "sdk-2", sessionId: "s1", timestamp: "t2", parent_tool_use_id: "tool-1" },
    ];

    const pubsubMessages: PubsubMessageWithMetadata[] = [
      { id: "p1", pubsubId: 1, content: "a", senderId: "s", metadata: { sdkUuid: "sdk-1" } },
      { id: "p2", pubsubId: 2, content: "sub", senderId: "s", metadata: { isSubagent: true } },
    ];

    const deltas = computeSyncDeltas(sdkMessages, pubsubMessages);
    // Subagent pubsub message should be excluded
    expect(deltas.pubsubDelta).toHaveLength(0);
    // Subagent SDK message should be excluded
    expect(deltas.sdkDelta).toHaveLength(0);
  });
});

describe("extractMessageText", () => {
  it("extracts text from content blocks", () => {
    const msg: SdkTranscriptMessage = {
      type: "assistant",
      uuid: "u1",
      sessionId: "s1",
      timestamp: "t1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello " },
          { type: "tool_use", tool_use_id: "t1" },
          { type: "text", text: "World" },
        ],
      },
    };

    expect(extractMessageText(msg)).toBe("Hello World");
  });

  it("returns empty string for missing content", () => {
    const msg: SdkTranscriptMessage = {
      type: "user",
      uuid: "u1",
      sessionId: "s1",
      timestamp: "t1",
    };

    expect(extractMessageText(msg)).toBe("");
  });
});

describe("formatContextForSdk", () => {
  it("formats messages with session-recovery-context tags", () => {
    const messages: PubsubMessageWithMetadata[] = [
      {
        id: "p1",
        pubsubId: 1,
        content: "What about X?",
        senderId: "user1",
        senderType: "panel",
        timestamp: 1700000000000,
      },
      {
        id: "p2",
        pubsubId: 2,
        content: "Here is the answer.",
        senderId: "ai1",
        senderType: "ai-responder",
        timestamp: 1700000001000,
      },
    ];

    const result = formatContextForSdk(messages);
    expect(result).toContain("<session-recovery-context>");
    expect(result).toContain("</session-recovery-context>");
    expect(result).toContain("[User at");
    expect(result).toContain("What about X?");
    expect(result).toContain("[Assistant at");
    expect(result).toContain("Here is the answer.");
  });

  it("returns empty string for empty array", () => {
    expect(formatContextForSdk([])).toBe("");
  });
});

describe("prepareRecoveredMessages", () => {
  it("filters synthetic messages and non-user/assistant types", () => {
    const messages: SdkTranscriptMessage[] = [
      {
        type: "user",
        uuid: "u1",
        sessionId: "s1",
        timestamp: "t1",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "assistant",
        uuid: "u2",
        sessionId: "s1",
        timestamp: "t2",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      },
      {
        type: "result",
        uuid: "u3",
        sessionId: "s1",
        timestamp: "t3",
      },
      {
        type: "user",
        uuid: "u4",
        sessionId: "s1",
        timestamp: "t4",
        isSynthetic: true,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] },
      },
    ];

    const recovered = prepareRecoveredMessages(messages);
    expect(recovered).toHaveLength(2);
    expect(recovered[0].sdkUuid).toBe("u1");
    expect(recovered[0].type).toBe("user");
    expect(recovered[1].sdkUuid).toBe("u2");
    expect(recovered[1].type).toBe("assistant");
  });

  it("skips messages with empty text content", () => {
    const messages: SdkTranscriptMessage[] = [
      {
        type: "user",
        uuid: "u1",
        sessionId: "s1",
        timestamp: "t1",
        message: { role: "user", content: [{ type: "image", data: "..." }] },
      },
    ];

    const recovered = prepareRecoveredMessages(messages);
    expect(recovered).toHaveLength(0);
  });
});
