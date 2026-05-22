import { describe, expect, it, vi } from "vitest";
import { createFlushController } from "./flush-controller";

describe("createFlushController", () => {
  it("flushes pending debounced paths on demand", () => {
    vi.useFakeTimers();
    try {
      const flushed: string[] = [];
      const controller = createFlushController({
        quiescenceMs: 1_500,
        onFlush: (path) => { flushed.push(path); },
      });

      controller.noteChange("A.mdx");
      controller.noteChange("B.mdx");

      controller.flushPending();

      expect(flushed).toEqual(["A.mdx", "B.mdx"]);
      vi.advanceTimersByTime(1_500);
      expect(flushed).toEqual(["A.mdx", "B.mdx"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces repeated changes for the same path", () => {
    vi.useFakeTimers();
    try {
      const flushed: string[] = [];
      const controller = createFlushController({
        quiescenceMs: 1_500,
        onFlush: (path) => { flushed.push(path); },
      });

      controller.noteChange("A.mdx");
      vi.advanceTimersByTime(1_000);
      controller.noteChange("A.mdx");
      vi.advanceTimersByTime(1_000);
      expect(flushed).toEqual([]);

      vi.advanceTimersByTime(500);
      expect(flushed).toEqual(["A.mdx"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
