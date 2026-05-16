import { describe, expect, it } from "vitest";

import {
  FRAME_DATA,
  FRAME_END,
  FRAME_ERROR,
  FRAME_HEAD,
  FrameDecoder,
  encodeDataFrame,
  encodeEndFrame,
  encodeErrorFrame,
  encodeHeadFrame,
  parseEndFrame,
  parseErrorFrame,
  parseHeadFrame,
} from "./streamFraming.js";

describe("streamFraming", () => {
  it("round-trips a HEAD frame", async () => {
    const head = {
      status: 200,
      statusText: "OK",
      headerPairs: [
        ["content-type", "application/json"],
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ] as Array<[string, string]>,
      finalUrl: "https://example.com/after-redirect",
    };
    const frame = encodeHeadFrame(head);
    const seen: Array<{ type: number; payload: Uint8Array }> = [];
    const decoder = new FrameDecoder((type, payload) => {
      seen.push({ type, payload });
    });
    await decoder.push(frame);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe(FRAME_HEAD);
    expect(parseHeadFrame(seen[0]!.payload)).toEqual(head);
  });

  it("round-trips a DATA frame with raw binary bytes (no base64)", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const frame = encodeDataFrame(bytes);
    let seen: Uint8Array | null = null;
    const decoder = new FrameDecoder((type, payload) => {
      if (type === FRAME_DATA) seen = payload;
    });
    await decoder.push(frame);
    expect(seen).not.toBeNull();
    expect(Array.from(seen!)).toEqual(Array.from(bytes));
  });

  it("buffers across split chunks regardless of where the boundary falls", async () => {
    const head = encodeHeadFrame({
      status: 200,
      statusText: "OK",
      headerPairs: [],
      finalUrl: "https://example.com/",
    });
    const data1 = encodeDataFrame(new Uint8Array([1, 2, 3, 4, 5]));
    const data2 = encodeDataFrame(new Uint8Array([6, 7, 8]));
    const end = encodeEndFrame({ bytesIn: 8 });
    const combined = new Uint8Array(head.byteLength + data1.byteLength + data2.byteLength + end.byteLength);
    combined.set(head, 0);
    combined.set(data1, head.byteLength);
    combined.set(data2, head.byteLength + data1.byteLength);
    combined.set(end, head.byteLength + data1.byteLength + data2.byteLength);

    // Feed the same byte stream split at every possible boundary; the
    // decoder must produce the same sequence of frames every time.
    for (let split = 1; split < combined.byteLength; split++) {
      const seen: number[] = [];
      const decoder = new FrameDecoder((type) => {
        seen.push(type);
      });
      await decoder.push(combined.slice(0, split));
      await decoder.push(combined.slice(split));
      expect(seen).toEqual([FRAME_HEAD, FRAME_DATA, FRAME_DATA, FRAME_END]);
      expect(decoder.finished()).toBe(true);
    }
  });

  it("handles a stream of many small data frames", async () => {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 100; i++) {
      chunks.push(new Uint8Array([i & 0xff, (i + 1) & 0xff, (i + 2) & 0xff]));
    }
    const frames = chunks.map(encodeDataFrame);
    const concat = new Uint8Array(frames.reduce((s, f) => s + f.byteLength, 0));
    let off = 0;
    for (const f of frames) {
      concat.set(f, off);
      off += f.byteLength;
    }
    const seen: Uint8Array[] = [];
    const decoder = new FrameDecoder((type, payload) => {
      if (type === FRAME_DATA) seen.push(payload);
    });
    // Push one byte at a time — torture test for partial-buffer handling.
    for (let i = 0; i < concat.byteLength; i++) {
      await decoder.push(concat.slice(i, i + 1));
    }
    expect(seen).toHaveLength(100);
    for (let i = 0; i < 100; i++) {
      expect(Array.from(seen[i]!)).toEqual(Array.from(chunks[i]!));
    }
  });

  it("encodes and parses an ERROR frame", async () => {
    const err = { status: 502, message: "upstream connection reset", code: "ECONNRESET" };
    const frame = encodeErrorFrame(err);
    let seen: Uint8Array | null = null;
    const decoder = new FrameDecoder((type, payload) => {
      if (type === FRAME_ERROR) seen = payload;
    });
    await decoder.push(frame);
    expect(parseErrorFrame(seen!)).toEqual(err);
  });

  it("routes a pre-HEAD ERROR frame to the head promise, not the body stream", async () => {
    // Regression: the decoder previously set a generic "first frame
    // seen" flag and treated ERROR-as-first-frame as a body error.
    // The caller then saw "no HEAD frame received" instead of the
    // real upstream message. Now ERROR before HEAD rejects the head
    // promise with the upstream's message.
    const { decodeFramedResponseToStreaming } = await import("./streamFraming.js");
    const frame = encodeErrorFrame({ status: 502, message: "upstream connection refused" });
    const wireBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame);
        controller.close();
      },
    });
    await expect(
      decodeFramedResponseToStreaming(wireBody, "https://example.com/"),
    ).rejects.toThrow(/upstream connection refused/);
  });

  it("parses an empty END frame as bytesIn=0", () => {
    const frame = encodeEndFrame({ bytesIn: 0 });
    // The wire payload is `{"bytesIn":0}` — non-empty JSON. We also want
    // graceful handling of an empty payload, in case a future server
    // version omits the body.
    expect(parseEndFrame(new Uint8Array(0))).toEqual({ bytesIn: 0 });
    expect(parseEndFrame(frame.slice(5))).toEqual({ bytesIn: 0 });
  });
});
