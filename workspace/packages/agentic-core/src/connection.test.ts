import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "./connection.js";
import type { ChatParticipantMetadata, ConnectionConfig } from "./types.js";

const CHANNEL_TARGET = "do:workers/pubsub-channel:PubSubChannel:chat-1";

function createConfig(): ConnectionConfig {
  const call = vi.fn((target: string, method: string) => {
    if (target === "main" && method === "workers.resolveService") {
      return Promise.resolve({
        kind: "durable-object",
        targetId: CHANNEL_TARGET,
      });
    }
    if (method === "subscribe") return new Promise(() => {});
    return Promise.resolve(undefined);
  }) as NonNullable<ConnectionConfig["rpc"]>["call"];
  return {
    serverUrl: "ws://unused",
    token: "token",
    clientId: "panel:panel-1",
    rpc: {
      selfId: "panel:panel-1",
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
    await vi.waitFor(() => {
      expect(config.rpc!.call).toHaveBeenCalledWith(
        CHANNEL_TARGET,
        "subscribe",
        "panel:panel-1",
        expect.any(Object),
      );
    });
    manager.disconnect();

    await expect(connectPromise).rejects.toThrow("ready aborted");
    expect(config.rpc!.call).toHaveBeenCalledWith(
      CHANNEL_TARGET,
      "unsubscribe",
      "panel:panel-1",
    );
  });
});
