import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkspaceClient } from "./workspaceClient.js";
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

describe("WorkspaceClient", () => {
  let rpc: ReturnType<typeof makeRpc>;
  let client: WorkspaceClient;

  beforeEach(() => {
    rpc = makeRpc();
    client = new WorkspaceClient(rpc);
  });

  describe("list()", () => {
    it("calls workspace.list RPC and returns result", async () => {
      const entries = [
        { name: "default", isActive: true },
        { name: "dev", isActive: false },
      ];
      rpc.call.mockResolvedValueOnce(entries);

      const result = await client.list();

      expect(rpc.call).toHaveBeenCalledWith("main", "workspace.list");
      expect(result).toEqual(entries);
    });
  });

  describe("create()", () => {
    it("calls workspace.create RPC with name", async () => {
      const entry = { name: "new-ws", isActive: false };
      rpc.call.mockResolvedValueOnce(entry);

      const result = await client.create("new-ws");

      expect(rpc.call).toHaveBeenCalledWith(
        "main",
        "workspace.create",
        "new-ws",
        undefined
      );
      expect(result).toEqual(entry);
    });

    it("calls workspace.create RPC with forkFrom option", async () => {
      const entry = { name: "forked", isActive: false };
      rpc.call.mockResolvedValueOnce(entry);

      const result = await client.create("forked", { forkFrom: "default" });

      expect(rpc.call).toHaveBeenCalledWith(
        "main",
        "workspace.create",
        "forked",
        { forkFrom: "default" }
      );
      expect(result).toEqual(entry);
    });
  });

  describe("delete()", () => {
    it("calls workspace.delete RPC with name", async () => {
      rpc.call.mockResolvedValueOnce(undefined);

      await client.delete("old-ws");

      expect(rpc.call).toHaveBeenCalledWith("main", "workspace.delete", "old-ws");
    });
  });

  describe("getActive()", () => {
    it("calls workspace.getActive RPC and returns workspace name", async () => {
      rpc.call.mockResolvedValueOnce("default");

      const result = await client.getActive();

      expect(rpc.call).toHaveBeenCalledWith("main", "workspace.getActive");
      expect(result).toBe("default");
    });
  });
});
