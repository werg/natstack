import { describe, it, expect, vi } from "vitest";
import { createAiClient } from "./client.js";
import type { RpcBridge } from "@natstack/rpc";

function createMockRpc() {
  const eventHandlers = new Map<string, Function>();
  const rpc = {
    selfId: "test",
    call: vi.fn(),
    emit: vi.fn(),
    onEvent: vi.fn((event: string, handler: Function) => {
      eventHandlers.set(event, handler);
      return vi.fn();
    }),
    exposeMethod: vi.fn(),
  } as unknown as RpcBridge;
  return { rpc, eventHandlers };
}

describe("createAiClient", () => {
  it("listRoles caches after first call", async () => {
    const { rpc } = createMockRpc();
    const mockRoles = { default: { model: "claude-3" } };
    vi.mocked(rpc.call).mockResolvedValue(mockRoles);

    const client = createAiClient(rpc);

    const result1 = await client.listRoles();
    const result2 = await client.listRoles();

    expect(result1).toEqual(mockRoles);
    expect(result2).toEqual(mockRoles);
    // Should only call RPC once due to caching
    expect(rpc.call).toHaveBeenCalledTimes(1);
    expect(rpc.call).toHaveBeenCalledWith("main", "ai.listRoles");
  });

  it("clearRoleCache makes next listRoles call the RPC again", async () => {
    const { rpc } = createMockRpc();
    const mockRoles = { default: { model: "claude-3" } };
    vi.mocked(rpc.call).mockResolvedValue(mockRoles);

    const client = createAiClient(rpc);

    await client.listRoles();
    expect(rpc.call).toHaveBeenCalledTimes(1);

    client.clearRoleCache();

    await client.listRoles();
    expect(rpc.call).toHaveBeenCalledTimes(2);
  });

  it("registers ai:stream-text-chunk and ai:stream-text-end event handlers", () => {
    const { rpc } = createMockRpc();
    createAiClient(rpc);

    const onEventCalls = vi.mocked(rpc.onEvent).mock.calls;
    const registeredEvents = onEventCalls.map((c) => c[0]);

    expect(registeredEvents).toContain("ai:stream-text-chunk");
    expect(registeredEvents).toContain("ai:stream-text-end");
  });

  it("exposes ai.executeTool method", () => {
    const { rpc } = createMockRpc();
    createAiClient(rpc);

    expect(rpc.exposeMethod).toHaveBeenCalledWith(
      "ai.executeTool",
      expect.any(Function)
    );
  });

  it("streamText returns an AsyncIterable", () => {
    const { rpc } = createMockRpc();
    vi.mocked(rpc.call).mockResolvedValue(undefined);

    const client = createAiClient(rpc);

    const result = client.streamText({
      model: "claude-3",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result).toBeDefined();
    expect(Symbol.asyncIterator in result).toBe(true);
  });

  it("streamText initiates rpc call for ai.streamTextStart", async () => {
    const { rpc, eventHandlers } = createMockRpc();
    vi.mocked(rpc.call).mockResolvedValue(undefined);

    const client = createAiClient(rpc);

    const iterable = client.streamText({
      model: "claude-3",
      messages: [{ role: "user", content: "hello" }],
    });

    // Start iterating to trigger the RPC call
    const iterator = iterable[Symbol.asyncIterator]();

    // Let the microtask queue flush so the call fires
    await new Promise((r) => setTimeout(r, 0));

    expect(rpc.call).toHaveBeenCalledWith(
      "main",
      "ai.streamTextStart",
      expect.objectContaining({ model: "claude-3" }),
      expect.any(String)
    );

    // End the stream to clean up
    const endHandler = eventHandlers.get("ai:stream-text-end");
    // Extract the streamId from the call args
    const streamTextCall = vi.mocked(rpc.call).mock.calls.find(
      (c) => c[1] === "ai.streamTextStart"
    );
    if (endHandler && streamTextCall) {
      endHandler("main", { streamId: streamTextCall[3] });
    }

    await iterator.return!();
  });
});
