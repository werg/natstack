import { describe, it, expect, vi, beforeEach } from "vitest";
import { SettingsClient } from "./settingsClient.js";
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

describe("SettingsClient", () => {
  let rpc: ReturnType<typeof makeRpc>;
  let client: SettingsClient;

  beforeEach(() => {
    rpc = makeRpc();
    client = new SettingsClient(rpc);
  });

  describe("getData()", () => {
    it("calls settings.getData RPC and returns settings data", async () => {
      const data = { providers: [], models: {} };
      rpc.call.mockResolvedValueOnce(data);

      const result = await client.getData();

      expect(rpc.call).toHaveBeenCalledWith("main", "settings.getData");
      expect(result).toEqual(data);
    });
  });

  describe("setApiKey()", () => {
    it("calls settings.setApiKey RPC with provider and key", async () => {
      rpc.call.mockResolvedValueOnce(undefined);

      await client.setApiKey("anthropic", "sk-test-key");

      expect(rpc.call).toHaveBeenCalledWith(
        "main",
        "settings.setApiKey",
        "anthropic",
        "sk-test-key"
      );
    });
  });

  describe("removeApiKey()", () => {
    it("calls settings.removeApiKey RPC with provider ID", async () => {
      rpc.call.mockResolvedValueOnce(undefined);

      await client.removeApiKey("anthropic");

      expect(rpc.call).toHaveBeenCalledWith(
        "main",
        "settings.removeApiKey",
        "anthropic"
      );
    });
  });

  describe("setModelRole()", () => {
    it("calls settings.setModelRole RPC with role and model spec", async () => {
      rpc.call.mockResolvedValueOnce(undefined);

      await client.setModelRole("chat", "claude-3-opus");

      expect(rpc.call).toHaveBeenCalledWith(
        "main",
        "settings.setModelRole",
        "chat",
        "claude-3-opus"
      );
    });
  });
});
