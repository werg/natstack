import { describe, expect, it } from "vitest";
import { isTranscriptContentType, isTranscriptWireMessage } from "./transcriptRouting";

describe("transcript routing", () => {
  it("accepts the message content types rendered by the transcript", () => {
    expect(isTranscriptContentType(undefined)).toBe(true);
    expect(isTranscriptContentType("text")).toBe(true);
    expect(isTranscriptContentType("thinking")).toBe(true);
    expect(isTranscriptContentType("toolCall")).toBe(true);
    expect(isTranscriptContentType("inline_ui")).toBe(true);
    expect(isTranscriptContentType("feedback_form")).toBe(true);
    expect(isTranscriptContentType("feedback_custom")).toBe(true);
    expect(isTranscriptContentType("error")).toBe(true);
  });

  it("rejects side-channel and unknown content types", () => {
    expect(isTranscriptContentType("notify:info")).toBe(false);
    expect(isTranscriptContentType("natstack-dispatch-cancel")).toBe(false);
    expect(isTranscriptContentType("natstack-ext-status")).toBe(false);
    expect(isTranscriptContentType("natstack-ext-widget")).toBe(false);
    expect(isTranscriptContentType("natstack-ext-working")).toBe(false);
    expect(isTranscriptContentType("future-side-channel")).toBe(false);
  });

  it("routes by event type and content type, not persistence kind", () => {
    expect(isTranscriptWireMessage({
      type: "message",
      contentType: "inline_ui",
    })).toBe(true);
    expect(isTranscriptWireMessage({
      type: "message",
      contentType: "notify:info",
    })).toBe(false);
    expect(isTranscriptWireMessage({
      type: "presence",
      contentType: "inline_ui",
    })).toBe(false);
  });
});
