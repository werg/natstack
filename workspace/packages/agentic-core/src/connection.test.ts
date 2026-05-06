import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "./connection.js";
import type { ChatParticipantMetadata, ConnectionConfig } from "./types.js";

function createConfig(): ConnectionConfig {
  const call = vi.fn((_target: string, method: string) => {
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
  it("closes a pubsub client when a pending connect is aborted", async () => {
    const config = createConfig();
    const manager = new ConnectionManager({ config, metadata, callbacks: {} });

    const connectPromise = manager.connect({ channelId: "chat-1", methods: {} });
    manager.disconnect();

    await expect(connectPromise).rejects.toThrow("ready aborted");
    expect(config.rpc!.call).toHaveBeenCalledWith(
      "do:workers/pubsub-channel:PubSubChannel:chat-1",
      "unsubscribe",
      "panel-1",
    );
  });
});
