import { describe, expect, it } from "vitest";
import {
  FRAME_DATA,
  FRAME_END,
  FRAME_HEAD,
  type FrameType,
  createInboundStreamMux,
  decodeFramedResponseToStreaming,
  encodeStreamDataFrameV2,
  encodeStreamEndFrameV2,
  encodeStreamErrorFrameV2,
  encodeStreamFrameV2,
  encodeStreamHeadFrameV2,
  StreamFrameDecoderV2,
} from "./streamCodec.js";

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

describe("stream codec v2 (streamId multiplexing)", () => {
  it("round-trips a single frame with its stream id", async () => {
    const seen: Array<{ streamId: number; type: FrameType; payload: Uint8Array }> = [];
    const decoder = new StreamFrameDecoderV2((streamId, type, payload) => {
      seen.push({ streamId, type, payload });
    });
    const bytes = encodeStreamDataFrameV2(7, new Uint8Array([1, 2, 3, 4]));
    await decoder.push(bytes);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.streamId).toBe(7);
    expect(seen[0]!.type).toBe(FRAME_DATA);
    expect([...seen[0]!.payload]).toEqual([1, 2, 3, 4]);
    expect(decoder.finished()).toBe(true);
  });

  it("preserves large (>16-bit) stream ids without sign issues", async () => {
    const seen: number[] = [];
    const decoder = new StreamFrameDecoderV2((streamId) => {
      seen.push(streamId);
    });
    await decoder.push(encodeStreamFrameV2(0xfffffffe, FRAME_DATA, new Uint8Array([9])));
    expect(seen[0]).toBe(0xfffffffe);
  });

  it("interleaves and demultiplexes frames from two streams in one byte run", async () => {
    const seen: Array<[number, FrameType]> = [];
    const decoder = new StreamFrameDecoderV2((streamId, type) => {
      seen.push([streamId, type]);
    });
    const run = concat(
      encodeStreamHeadFrameV2(1, { status: 200, statusText: "OK", headerPairs: [], finalUrl: "x" }),
      encodeStreamHeadFrameV2(2, { status: 404, statusText: "NF", headerPairs: [], finalUrl: "y" }),
      encodeStreamDataFrameV2(1, new Uint8Array([1])),
      encodeStreamDataFrameV2(2, new Uint8Array([2])),
      encodeStreamEndFrameV2(1, { bytesIn: 1 }),
      encodeStreamEndFrameV2(2, { bytesIn: 1 }),
    );
    await decoder.push(run);
    expect(seen).toEqual([
      [1, FRAME_HEAD],
      [2, FRAME_HEAD],
      [1, FRAME_DATA],
      [2, FRAME_DATA],
      [1, FRAME_END],
      [2, FRAME_END],
    ]);
  });

  it("reassembles a frame delivered across split chunks", async () => {
    const seen: Uint8Array[] = [];
    const decoder = new StreamFrameDecoderV2((_s, _t, payload) => {
      seen.push(payload);
    });
    const full = encodeStreamDataFrameV2(3, new Uint8Array([10, 20, 30, 40, 50]));
    await decoder.push(full.slice(0, 6));
    expect(seen).toHaveLength(0);
    await decoder.push(full.slice(6));
    expect(seen).toHaveLength(1);
    expect([...seen[0]!]).toEqual([10, 20, 30, 40, 50]);
  });

  it("mux feeds decodeFramedResponseToStreaming to rebuild a Response per stream", async () => {
    const mux = createInboundStreamMux();
    const bodyA = mux.acquire(11);
    const bodyB = mux.acquire(22);
    const respA = decodeFramedResponseToStreaming(bodyA, "https://a/");
    const respB = decodeFramedResponseToStreaming(bodyB, "https://b/");

    const enc = new TextEncoder();
    // Drive both streams via the demux, as the bulk channel would.
    const dec = new StreamFrameDecoderV2((streamId, type, payload) => {
      mux.push(streamId, type, payload);
    });
    await dec.push(
      concat(
        encodeStreamHeadFrameV2(11, { status: 201, statusText: "Created", headerPairs: [["x-a", "1"]], finalUrl: "https://a/final" }),
        encodeStreamHeadFrameV2(22, { status: 200, statusText: "OK", headerPairs: [], finalUrl: "https://b/" }),
        encodeStreamDataFrameV2(11, enc.encode("hello-")),
        encodeStreamDataFrameV2(22, enc.encode("world")),
        encodeStreamDataFrameV2(11, enc.encode("A")),
        encodeStreamEndFrameV2(11, { bytesIn: 7 }),
        encodeStreamEndFrameV2(22, { bytesIn: 5 }),
      ),
    );

    const a = await respA;
    const b = await respB;
    expect(a.status).toBe(201);
    expect(a.headers.get("x-a")).toBe("1");
    expect(a.url).toBe("https://a/final");
    expect(await a.text()).toBe("hello-A");
    expect(b.status).toBe(200);
    expect(await b.text()).toBe("world");
    expect(mux.size).toBe(0);
  });

  it("propagates an ERROR frame into the stream's Response", async () => {
    const mux = createInboundStreamMux();
    const body = mux.acquire(5);
    const resp = decodeFramedResponseToStreaming(body, "https://e/");
    mux.push(5, FRAME_HEAD, new TextEncoder().encode(JSON.stringify({ status: 200, statusText: "OK", headerPairs: [], finalUrl: "https://e/" })));
    // Read side starts; now error it.
    const errBytes = encodeStreamErrorFrameV2(5, { status: 502, message: "upstream boom", code: "EBOOM" });
    const dec = new StreamFrameDecoderV2((streamId, type, payload) => mux.push(streamId, type, payload));
    await dec.push(errBytes);
    const r = await resp;
    await expect(r.text()).rejects.toThrow(/upstream boom/);
  });

  it("closeAll errors every open stream (pipe loss is loud, not a hang)", async () => {
    const mux = createInboundStreamMux();
    const body = mux.acquire(1);
    const resp = decodeFramedResponseToStreaming(body, "https://x/");
    mux.push(1, FRAME_HEAD, new TextEncoder().encode(JSON.stringify({ status: 200, statusText: "OK", headerPairs: [], finalUrl: "https://x/" })));
    mux.closeAll(new Error("pipe lost"));
    const r = await resp;
    await expect(r.text()).rejects.toThrow(/pipe lost/);
    expect(mux.size).toBe(0);
  });
});
