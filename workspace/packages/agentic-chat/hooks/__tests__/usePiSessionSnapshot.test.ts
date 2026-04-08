// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePiSessionSnapshot } from "../usePiSessionSnapshot.js";

function snapshotMessage(payload: unknown, ts: number) {
  return {
    ts,
    content: JSON.stringify(payload),
    contentType: "natstack-state-snapshot",
  };
}

describe("usePiSessionSnapshot", () => {
  it("returns empty snapshot when no messages", () => {
    const { result } = renderHook(() => usePiSessionSnapshot([]));
    expect(result.current.snapshot.messages).toEqual([]);
    expect(result.current.snapshot.isStreaming).toBe(false);
    expect(result.current.latestTs).toBe(0);
  });

  it("returns the latest snapshot when multiple are present", () => {
    const msgs = [
      snapshotMessage({ messages: [{ role: "user", content: "first" }], isStreaming: false }, 100),
      snapshotMessage({ messages: [{ role: "user", content: "second" }], isStreaming: true }, 200),
    ];
    const { result } = renderHook(() => usePiSessionSnapshot(msgs));
    expect(result.current.snapshot.isStreaming).toBe(true);
    expect(result.current.latestTs).toBe(200);
    expect(result.current.snapshot.messages).toHaveLength(1);
  });

  it("ignores messages with non-matching contentType", () => {
    const msgs = [
      { ts: 100, content: "garbage", contentType: "other-type" },
      snapshotMessage({ messages: [], isStreaming: false }, 200),
    ];
    const { result } = renderHook(() => usePiSessionSnapshot(msgs));
    expect(result.current.latestTs).toBe(200);
  });

  it("returns the previous valid snapshot when the latest is malformed", () => {
    const msgs = [
      snapshotMessage({ messages: [{ role: "user", content: "good" }], isStreaming: false }, 100),
      { ts: 200, content: "{not-json", contentType: "natstack-state-snapshot" },
    ];
    const { result } = renderHook(() => usePiSessionSnapshot(msgs));
    expect(result.current.latestTs).toBe(100);
    expect(result.current.snapshot.messages).toHaveLength(1);
  });
});
