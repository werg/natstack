import { createRpcBridge } from "./bridge.js";
import type { RpcTransport, RpcMessage, RpcResponse, RpcRequest, RpcEvent } from "./types.js";

function createMockTransport() {
  const transport: RpcTransport = {
    send: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn().mockReturnValue(vi.fn()),
    onAnyMessage: vi.fn().mockReturnValue(vi.fn()),
  };
  return transport;
}

function captureOnAnyMessageHandler(transport: RpcTransport) {
  const call = vi.mocked(transport.onAnyMessage).mock.calls[0];
  return call[0] as (sourceId: string, message: RpcMessage) => void;
}

describe("createRpcBridge", () => {
  it("call/response round-trip resolves with result", async () => {
    const transport = createMockTransport();
    const bridge = createRpcBridge({ selfId: "test", transport });
    const handler = captureOnAnyMessageHandler(transport);

    const callPromise = bridge.call("target", "greet", "world");

    // Extract the requestId from the sent message
    const sendCall = vi.mocked(transport.send).mock.calls[0];
    expect(sendCall[0]).toBe("target");
    const request = sendCall[1] as RpcRequest;
    expect(request.type).toBe("request");
    expect(request.method).toBe("greet");
    expect(request.args).toEqual(["world"]);

    // Simulate response via _handleMessage
    const response: RpcResponse = {
      type: "response",
      requestId: request.requestId,
      result: "hello world",
    };
    handler("target", response);

    await expect(callPromise).resolves.toBe("hello world");
  });

  it("call times out after default 30s", async () => {
    vi.useFakeTimers();
    try {
      const transport = createMockTransport();
      const bridge = createRpcBridge({ selfId: "test", transport });

      const callPromise = bridge.call("target", "slow.method");

      vi.advanceTimersByTime(30000);

      await expect(callPromise).rejects.toThrow("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ai.* calls use longer 300s timeout", async () => {
    vi.useFakeTimers();
    try {
      const transport = createMockTransport();
      const bridge = createRpcBridge({ selfId: "test", transport });

      const callPromise = bridge.call("target", "ai.streamText");

      // Should NOT have timed out at 30s
      vi.advanceTimersByTime(30000);
      // Verify promise is still pending by racing with a resolved value
      const result = await Promise.race([
        callPromise.then(() => "resolved").catch(() => "rejected"),
        Promise.resolve("still-pending"),
      ]);
      expect(result).toBe("still-pending");

      // Should time out at 300s
      vi.advanceTimersByTime(270000);

      await expect(callPromise).rejects.toThrow("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposeMethod handles incoming request and sends response", async () => {
    const transport = createMockTransport();
    const bridge = createRpcBridge({ selfId: "test", transport });
    const handler = captureOnAnyMessageHandler(transport);

    bridge.exposeMethod("add", (a: number, b: number) => a + b);

    const request: RpcRequest = {
      type: "request",
      requestId: "req-1",
      fromId: "caller",
      method: "add",
      args: [3, 4],
    };

    handler("caller", request);

    // Wait for the async handler to settle
    await vi.waitFor(() => {
      expect(vi.mocked(transport.send)).toHaveBeenCalledWith(
        "caller",
        expect.objectContaining({
          type: "response",
          requestId: "req-1",
          result: 7,
        })
      );
    });
  });

  it("error response causes call to reject with Error", async () => {
    const transport = createMockTransport();
    const bridge = createRpcBridge({ selfId: "test", transport });
    const handler = captureOnAnyMessageHandler(transport);

    const callPromise = bridge.call("target", "fail");

    const sendCall = vi.mocked(transport.send).mock.calls[0];
    const request = sendCall[1] as RpcRequest;

    const response: RpcResponse = {
      type: "response",
      requestId: request.requestId,
      error: "something went wrong",
    };
    handler("target", response);

    await expect(callPromise).rejects.toThrow("something went wrong");
  });

  it("onEvent listener fires when event is received", () => {
    const transport = createMockTransport();
    const bridge = createRpcBridge({ selfId: "test", transport });
    const handler = captureOnAnyMessageHandler(transport);

    const listener = vi.fn();
    bridge.onEvent("update", listener);

    const event: RpcEvent = {
      type: "event",
      fromId: "source",
      event: "update",
      payload: { value: 42 },
    };
    handler("source", event);

    expect(listener).toHaveBeenCalledWith("source", { value: 42 });
  });

  it("onEvent unsubscribe removes listener", () => {
    const transport = createMockTransport();
    const bridge = createRpcBridge({ selfId: "test", transport });
    const handler = captureOnAnyMessageHandler(transport);

    const listener = vi.fn();
    const unsubscribe = bridge.onEvent("update", listener);

    unsubscribe();

    const event: RpcEvent = {
      type: "event",
      fromId: "source",
      event: "update",
      payload: "data",
    };
    handler("source", event);

    expect(listener).not.toHaveBeenCalled();
  });

  it("exposed method that throws sends error response", async () => {
    const transport = createMockTransport();
    const bridge = createRpcBridge({ selfId: "test", transport });
    const handler = captureOnAnyMessageHandler(transport);

    bridge.exposeMethod("boom", () => {
      throw new Error("kaboom");
    });

    const request: RpcRequest = {
      type: "request",
      requestId: "req-err",
      fromId: "caller",
      method: "boom",
      args: [],
    };

    handler("caller", request);

    await vi.waitFor(() => {
      expect(vi.mocked(transport.send)).toHaveBeenCalledWith(
        "caller",
        expect.objectContaining({
          type: "response",
          requestId: "req-err",
          error: "kaboom",
        })
      );
    });
  });
});
