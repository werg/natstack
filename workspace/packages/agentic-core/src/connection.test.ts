import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "./connection.js";
import type { ChatParticipantMetadata, ConnectionConfig } from "./types.js";

const RESOLVED_DO_TARGET = "do:workers/pubsub-channel:PubSubChannel:chat-1";

function createConfig(): ConnectionConfig {
  const call = vi.fn((_target: string, method: string) => {
    if (method === "workers.resolveService")
      return Promise.resolve({ kind: "durable-object", targetId: RESOLVED_DO_TARGET });
    if (method === "subscribe") return new Promise(() => {});
    return Promise.resolve(undefined);
  }) as NonNullable<ConnectionConfig["rpc"]>["call"];
  return {
    serverUrl: "ws://unused",
    token: "token",
    clientId: "panel-1",
    rpc: {
      selfId: "panel-1",
      call,
      onEvent: vi.fn(() => vi.fn()),
    },
  };
}

const metadata: ChatParticipantMetadata = {
  name: "Panel",
  type: "panel",
  handle: "user",
};

describe("ConnectionManager", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("closes a pubsub client when a pending connect is aborted", async () => {
    const config = createConfig();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/subscribe")) {
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const manager = new ConnectionManager({ config, metadata, callbacks: {} });

    const connectPromise = manager.connect({ channelId: "chat-1", methods: {} });
    manager.disconnect();

    await expect(connectPromise).rejects.toThrow("ready aborted");
    for (let index = 0; index < 20; index += 1) {
      if (fetchMock.mock.calls.some(([url]) => String(url).endsWith("/unsubscribe"))) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(fetchMock).toHaveBeenCalledWith(
      "ws://unused/_w/workers/pubsub-channel/PubSubChannel/chat-1/unsubscribe",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(["panel-1"]),
      })
    );
  });
});
