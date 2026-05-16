import { createRpcBridge } from "./bridge.js";
import type {
  RpcTransport,
  RpcMessage,
  RpcStreamRequest,
  RpcStreamFrameMessage,
} from "./types.js";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function captureOnAnyMessageHandler(transport: RpcTransport) {
  const call = vi.mocked(transport.onAnyMessage).mock.calls[0]!;
  return call[0] as (sourceId: string, message: RpcMessage) => void;
}

/**
 * Bidirectional loopback transport: two endpoints, each `send` on one
 * is dispatched to the other's `_handleMessage` after a microtask.
 * Lets us exercise the real streaming protocol round-trip — caller
 * sends `stream-request`, server-side bridge dispatches to its
 * `exposeStreamingMethod` handler, frames flow back as `stream-frame`
 * messages, caller assembles them into a Response.
 */
function createLoopbackPair() {
  let bridgeA: ReturnType<typeof createRpcBridge> | null = null;
  let bridgeB: ReturnType<typeof createRpcBridge> | null = null;

  const transportA: RpcTransport = {
    send: vi.fn(async (_targetId: string, message: RpcMessage) => {
      await Promise.resolve();
      bridgeB?._handleMessage("a", message);
    }),
    onMessage: vi.fn().mockReturnValue(vi.fn()),
    onAnyMessage: vi.fn().mockReturnValue(vi.fn()),
  };
  const transportB: RpcTransport = {
    send: vi.fn(async (_targetId: string, message: RpcMessage) => {
      await Promise.resolve();
      bridgeA?._handleMessage("b", message);
    }),
    onMessage: vi.fn().mockReturnValue(vi.fn()),
    onAnyMessage: vi.fn().mockReturnValue(vi.fn()),
  };

  bridgeA = createRpcBridge({ selfId: "a", transport: transportA });
  bridgeB = createRpcBridge({ selfId: "b", transport: transportB });

  return { bridgeA, bridgeB, transportA, transportB };
}

describe("createRpcBridge streaming", () => {
  it("round-trips HEAD + DATA + END frames as a Response with ReadableStream body", async () => {
    const { bridgeA, bridgeB } = createLoopbackPair();

    bridgeB.exposeStreamingMethod("credentials.proxyFetch", async (_args, sink) => {
      await sink({
        kind: "head",
        status: 200,
        statusText: "OK",
        headerPairs: [["content-type", "text/plain"]],
        finalUrl: "https://example.com/after-redirect",
      });
      await sink({ kind: "chunk", bytes: new Uint8Array([0x68, 0x65]) });
      await sink({ kind: "chunk", bytes: new Uint8Array([0x6c, 0x6c, 0x6f]) });
      await sink({ kind: "end", bytesIn: 5 });
    });

    const response = await bridgeA.streamCall("b", "credentials.proxyFetch", [
      { url: "https://example.com/", method: "GET" },
    ]);

    expect(response.status).toBe(200);
    expect(response.statusText).toBe("OK");
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.url).toBe("https://example.com/after-redirect");
    const text = await response.text();
    expect(text).toBe("hello");
  });

  it("preserves binary bytes through base64 framing", async () => {
    const { bridgeA, bridgeB } = createLoopbackPair();
    const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

    bridgeB.exposeStreamingMethod("credentials.proxyFetch", async (_args, sink) => {
      await sink({
        kind: "head",
        status: 200,
        statusText: "OK",
        headerPairs: [["content-type", "application/pdf"]],
        finalUrl: "https://example.com/doc.pdf",
      });
      await sink({ kind: "chunk", bytes: pdfMagic });
      await sink({ kind: "end", bytesIn: pdfMagic.byteLength });
    });

    const response = await bridgeA.streamCall("b", "credentials.proxyFetch", [
      { url: "https://example.com/doc.pdf", method: "GET" },
    ]);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(pdfMagic));
  });

  it("surfaces a pre-HEAD ERROR frame as a rejected streamCall promise", async () => {
    const { bridgeA, bridgeB } = createLoopbackPair();

    bridgeB.exposeStreamingMethod("credentials.proxyFetch", async (_args, sink) => {
      await sink({
        kind: "error",
        status: 502,
        message: "upstream unreachable",
        code: "ECONNREFUSED",
      });
    });

    await expect(
      bridgeA.streamCall("b", "credentials.proxyFetch", [{ url: "x", method: "GET" }]),
    ).rejects.toThrow(/upstream unreachable/);
  });

  it("surfaces a post-HEAD ERROR frame as a stream body error", async () => {
    const { bridgeA, bridgeB } = createLoopbackPair();

    bridgeB.exposeStreamingMethod("credentials.proxyFetch", async (_args, sink) => {
      await sink({
        kind: "head",
        status: 200,
        statusText: "OK",
        headerPairs: [],
        finalUrl: "",
      });
      await sink({ kind: "chunk", bytes: new Uint8Array([0x68]) });
      await sink({ kind: "error", status: 502, message: "connection reset mid-stream" });
    });

    const response = await bridgeA.streamCall("b", "credentials.proxyFetch", [
      { url: "x", method: "GET" },
    ]);
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow(/connection reset mid-stream/);
  });

  it("rejects when no streaming handler is registered for the method", async () => {
    const { bridgeA } = createLoopbackPair();
    // bridgeB doesn't expose any streaming methods.

    await expect(
      bridgeA.streamCall("b", "nonexistent.method", []),
    ).rejects.toThrow(/No streaming handler/);
  });

  it("propagates AbortSignal as a stream-cancel that triggers the handler's abortSignal", async () => {
    const { bridgeA, bridgeB } = createLoopbackPair();
    let observedAbortReason: unknown;
    let resolveHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      resolveHandlerStarted = resolve;
    });

    bridgeB.exposeStreamingMethod("credentials.proxyFetch", async (_args, sink, abortSignal) => {
      await sink({
        kind: "head",
        status: 200,
        statusText: "OK",
        headerPairs: [],
        finalUrl: "",
      });
      resolveHandlerStarted();
      // Stall on the signal — production code would loop reading
      // upstream and check `abortSignal.aborted` between chunks.
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => {
          observedAbortReason = abortSignal.reason ?? "aborted";
          resolve();
        });
      });
    });

    const controller = new AbortController();
    const response = await bridgeA.streamCall(
      "b",
      "credentials.proxyFetch",
      [{ url: "x", method: "GET" }],
      { signal: controller.signal },
    );
    expect(response.status).toBe(200);
    await handlerStarted;

    controller.abort();
    // Give the cancel message a microtask to round-trip.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(observedAbortReason).toBeDefined();
  });

  it("times out a stalled stream that never sends HEAD", async () => {
    const transport: RpcTransport = {
      send: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn().mockReturnValue(vi.fn()),
      onAnyMessage: vi.fn().mockReturnValue(vi.fn()),
    };
    const bridge = createRpcBridge({
      selfId: "client",
      transport,
      // Very short idle timeout so the test runs quickly. Real
      // deployments use the 90s default.
      streamIdleTimeoutMs: 30,
    });

    // Peer never responds with a frame. The streamCall promise
    // should reject after the idle window.
    await expect(
      bridge.streamCall("server", "credentials.proxyFetch", [
        { url: "https://example.com/", method: "GET" },
      ]),
    ).rejects.toThrow(/timed out — no frames received/);
  });

  it("re-arms the idle timer on each incoming frame", async () => {
    const transport: RpcTransport = {
      send: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn().mockReturnValue(vi.fn()),
      onAnyMessage: vi.fn().mockReturnValue(vi.fn()),
    };
    const bridge = createRpcBridge({
      selfId: "client",
      transport,
      streamIdleTimeoutMs: 30,
    });
    const handler = captureOnAnyMessageHandler(transport);

    const callPromise = bridge.streamCall("server", "credentials.proxyFetch", [
      { url: "https://example.com/", method: "GET" },
    ]);

    // Extract the requestId of the outbound stream-request so we can
    // tag returning frames with the same id.
    const sentRequest = vi.mocked(transport.send).mock.calls[0]![1] as RpcStreamRequest;
    expect(sentRequest.type).toBe("stream-request");

    // Send a HEAD frame within the idle window — that should both
    // resolve the streamCall promise AND re-arm the timer.
    await new Promise((r) => setTimeout(r, 15));
    handler("server", {
      type: "stream-frame",
      requestId: sentRequest.requestId,
      fromId: "server",
      frameType: 0x01,
      payload: JSON.stringify({
        status: 200,
        statusText: "OK",
        headerPairs: [],
        finalUrl: "",
      }),
    });

    const response = await callPromise;
    expect(response.status).toBe(200);

    // Now wait past the original idle window — the timer should
    // have been re-armed when HEAD arrived, so the stream is still
    // alive at this point. Send another frame to confirm.
    await new Promise((r) => setTimeout(r, 20));
    handler("server", {
      type: "stream-frame",
      requestId: sentRequest.requestId,
      fromId: "server",
      frameType: 0x02,
      payload: bytesToBase64(new Uint8Array([0x68, 0x69])),
    });
    // Close the stream cleanly so we don't leave it pending.
    handler("server", {
      type: "stream-frame",
      requestId: sentRequest.requestId,
      fromId: "server",
      frameType: 0x03,
      payload: JSON.stringify({ bytesIn: 2 }),
    });

    const text = await response.text();
    expect(text).toBe("hi");
  });

  it("encodes DATA chunks as base64 in the wire frames", async () => {
    const transport: RpcTransport = {
      send: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn().mockReturnValue(vi.fn()),
      onAnyMessage: vi.fn().mockReturnValue(vi.fn()),
    };
    const bridge = createRpcBridge({ selfId: "server", transport });
    const handler = captureOnAnyMessageHandler(transport);

    bridge.exposeStreamingMethod("test.stream", async (_args, sink) => {
      await sink({
        kind: "head",
        status: 200,
        statusText: "OK",
        headerPairs: [],
        finalUrl: "",
      });
      await sink({ kind: "chunk", bytes: new Uint8Array([0xff, 0x00, 0x42]) });
      await sink({ kind: "end", bytesIn: 3 });
    });

    const incoming: RpcStreamRequest = {
      type: "stream-request",
      requestId: "req-1",
      fromId: "client",
      method: "test.stream",
      args: [],
    };
    handler("client", incoming);

    // Wait for frames to flush.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const calls = vi.mocked(transport.send).mock.calls;
    const frames = calls
      .map(([, msg]) => msg as RpcStreamFrameMessage)
      .filter((m) => m.type === "stream-frame");
    expect(frames.length).toBeGreaterThanOrEqual(3);
    const dataFrame = frames.find((f) => f.frameType === 0x02)!;
    expect(dataFrame.payload).toBe(bytesToBase64(new Uint8Array([0xff, 0x00, 0x42])));
  });
});
