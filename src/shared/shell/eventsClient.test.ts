import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventsClient } from "./eventsClient.js";
import type { RpcBridge } from "@natstack/rpc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRpc(): RpcBridge & { call: ReturnType<typeof vi.fn> } {
  return {
    call: vi.fn(),
    emit: vi.fn(),
    onEvent: vi.fn(),
    exposeMethod: vi.fn(),
    expose: vi.fn(),
    selfId: "test",
  } as unknown as RpcBridge & { call: ReturnType<typeof vi.fn> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EventsClient", () => {
  let rpc: ReturnType<typeof makeRpc>;
  let client: EventsClient;

  beforeEach(() => {
    rpc = makeRpc();
    client = new EventsClient(rpc);
  });

  describe("subscribe()", () => {
    it("calls events.subscribe RPC with event name", async () => {
      rpc.call.mockResolvedValueOnce(undefined);

      await client.subscribe("panel-tree-updated");

      expect(rpc.call).toHaveBeenCalledWith(
        "main",
        "events.subscribe",
        "panel-tree-updated"
      );
    });

    it("calls events.subscribe with different event names", async () => {
      rpc.call.mockResolvedValueOnce(undefined);

      await client.subscribe("system-theme-changed");

      expect(rpc.call).toHaveBeenCalledWith(
        "main",
        "events.subscribe",
        "system-theme-changed"
      );
    });
  });

  describe("unsubscribe()", () => {
    it("calls events.unsubscribe RPC with event name", async () => {
      rpc.call.mockResolvedValueOnce(undefined);

      await client.unsubscribe("panel-tree-updated");

      expect(rpc.call).toHaveBeenCalledWith(
        "main",
        "events.unsubscribe",
        "panel-tree-updated"
      );
    });
  });

  describe("unsubscribeAll()", () => {
    it("calls events.unsubscribeAll RPC with no arguments", async () => {
      rpc.call.mockResolvedValueOnce(undefined);

      await client.unsubscribeAll();

      expect(rpc.call).toHaveBeenCalledWith("main", "events.unsubscribeAll");
    });
  });
});
