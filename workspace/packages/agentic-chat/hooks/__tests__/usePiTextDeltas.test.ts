// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePiTextDeltas } from "../usePiTextDeltas.js";

function deltaMessage(messageId: string, delta: string, ts: number) {
  return {
    ts,
    content: JSON.stringify({ messageId, delta }),
    contentType: "natstack-text-delta",
  };
}

describe("usePiTextDeltas", () => {
  it("returns null when no deltas have arrived", () => {
    const { result } = renderHook(() => usePiTextDeltas([], 0));
    expect(result.current).toBeNull();
  });

  it("concatenates sequential deltas with the same messageId", () => {
    const msgs = [
      deltaMessage("m1", "Hello", 100),
      deltaMessage("m1", " ", 110),
      deltaMessage("m1", "world", 120),
    ];
    const { result } = renderHook(() => usePiTextDeltas(msgs, 0));
    expect(result.current).toEqual({ messageId: "m1", text: "Hello world" });
  });

  it("ignores deltas with timestamp <= sinceTs", () => {
    const msgs = [
      deltaMessage("m1", "ignored", 100),
      deltaMessage("m1", "kept", 200),
    ];
    const { result } = renderHook(() => usePiTextDeltas(msgs, 150));
    expect(result.current).toEqual({ messageId: "m1", text: "kept" });
  });

  it("resets accumulator on a new messageId", () => {
    const msgs = [
      deltaMessage("m1", "old", 100),
      deltaMessage("m2", "new", 200),
    ];
    const { result } = renderHook(() => usePiTextDeltas(msgs, 0));
    expect(result.current).toEqual({ messageId: "m2", text: "new" });
  });

  it("ignores messages with non-matching contentType", () => {
    const msgs = [
      { ts: 100, content: "garbage", contentType: "other" },
      deltaMessage("m1", "kept", 200),
    ];
    const { result } = renderHook(() => usePiTextDeltas(msgs, 0));
    expect(result.current).toEqual({ messageId: "m1", text: "kept" });
  });
});
