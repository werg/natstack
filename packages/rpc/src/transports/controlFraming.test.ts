import { describe, expect, it } from "vitest";
import { frameControlMessage, createControlDefragmenter } from "./controlFraming.js";

describe("control framing", () => {
  it("round-trips a small frame as a single whole message", () => {
    const frame = new TextEncoder().encode("hello");
    const parts = frameControlMessage(frame, 16 * 1024, 1);
    expect(parts.length).toBe(1);
    const out = createControlDefragmenter().accept(parts[0]!);
    expect(out).not.toBeNull();
    expect(new TextDecoder().decode(out!)).toBe("hello");
  });

  it("fragments and reassembles a frame larger than the cap", () => {
    const frame = new Uint8Array(50_000).map((_, i) => i % 256);
    const max = 16 * 1024;
    const parts = frameControlMessage(frame, max, 7);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.byteLength).toBeLessThanOrEqual(max);
    const defrag = createControlDefragmenter();
    let out: Uint8Array | null = null;
    for (const part of parts) out = defrag.accept(part) ?? out;
    expect([...out!]).toEqual([...frame]);
  });

  it("reassembles two interleaved fragment sets independently", () => {
    const max = 32; // tiny cap forces fragmentation
    const a = new Uint8Array(100).fill(0xaa);
    const b = new Uint8Array(100).fill(0xbb);
    const pa = frameControlMessage(a, max, 1);
    const pb = frameControlMessage(b, max, 2);
    const defrag = createControlDefragmenter();
    const results: Uint8Array[] = [];
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if (pa[i]) {
        const r = defrag.accept(pa[i]!);
        if (r) results.push(r);
      }
      if (pb[i]) {
        const r = defrag.accept(pb[i]!);
        if (r) results.push(r);
      }
    }
    expect(results.length).toBe(2);
    expect(results.some((r) => r.length === 100 && r.every((x) => x === 0xaa))).toBe(true);
    expect(results.some((r) => r.length === 100 && r.every((x) => x === 0xbb))).toBe(true);
  });

  it("reset() drops in-flight fragments so a new pipe never reassembles stale data", () => {
    const parts = frameControlMessage(new Uint8Array(100).fill(0xcc), 32, 1);
    const defrag = createControlDefragmenter();
    expect(defrag.accept(parts[0]!)).toBeNull(); // partial set
    defrag.reset();
    let out: Uint8Array | null = null;
    for (let i = 1; i < parts.length; i++) out = defrag.accept(parts[i]!) ?? out;
    expect(out).toBeNull(); // index 0 was dropped → set can never complete
  });
});
