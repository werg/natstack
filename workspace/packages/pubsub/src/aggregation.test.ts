/**
 * Tests for aggregateReplayEvents — specifically the append-vs-replace logic
 * for typed content and the `append: true` override flag.
 */

import { describe, it, expect } from "vitest";
import { aggregateReplayEvents } from "./aggregation.js";
import type {
  IncomingNewMessage,
  IncomingUpdateMessage,
} from "./protocol-types.js";

function newMsg(overrides: Partial<IncomingNewMessage> = {}): IncomingNewMessage {
  return {
    type: "message",
    kind: "replay",
    id: "msg-1",
    senderId: "user",
    ts: 1,
    content: "",
    pubsubId: 1,
    ...overrides,
  };
}

function upd(overrides: Partial<IncomingUpdateMessage> = {}): IncomingUpdateMessage {
  return {
    type: "update-message",
    kind: "replay",
    id: "msg-1",
    senderId: "user",
    ts: 2,
    pubsubId: 2,
    ...overrides,
  };
}

describe("aggregateReplayEvents", () => {
  it("appends content for untyped (plain text) messages", () => {
    const result = aggregateReplayEvents([
      newMsg({ content: "Hel" }),
      upd({ content: "lo " }),
      upd({ content: "world", complete: true }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "message",
      content: "Hello world",
      complete: true,
    });
  });

  it("replaces content for typed messages (snapshot semantics)", () => {
    const result = aggregateReplayEvents([
      newMsg({ content: "{\"v\":1}", contentType: "toolCall" }),
      upd({ content: "{\"v\":2}" }),
      upd({ content: "{\"v\":3}", complete: true }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "message",
      content: "{\"v\":3}",
      complete: true,
    });
  });

  it("honors append:true on typed messages (thinking streaming)", () => {
    const result = aggregateReplayEvents([
      newMsg({ content: "Let me ", contentType: "thinking" }),
      upd({ content: "think ", append: true }),
      upd({ content: "about it.", append: true, complete: true }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      content: "Let me think about it.",
      complete: true,
    });
  });
});
