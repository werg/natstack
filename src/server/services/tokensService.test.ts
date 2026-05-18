import { describe, expect, it, vi } from "vitest";
import { TokenManager } from "@natstack/shared/tokenManager";
import { createTokensService } from "./tokensService.js";

function createService(tokenManager = new TokenManager()) {
  const service = createTokensService({
    tokenManager,
    fsService: {
      registerCallerContext: vi.fn(),
      unregisterCallerContext: vi.fn(),
      updateCallerContext: vi.fn(),
    } as never,
  });
  return { service, tokenManager };
}

describe("tokensService", () => {
  it("records the authenticated shell caller as the panel browser handoff owner", async () => {
    const { service, tokenManager } = createService();

    await service.handler(
      { callerId: "shell:abc", callerKind: "shell", connectionId: "conn-1" },
      "ensurePanelToken",
      ["panel-1", "ctx-1", null, "panels/chat"]
    );

    expect(tokenManager.getPanelOwner("panel-1")).toBe("shell:abc");
    expect(tokenManager.getPanelOwnerConnection("panel-1")).toBeUndefined();
  });

  it("records the authenticated local admin websocket as the panel browser handoff owner", async () => {
    const { service, tokenManager } = createService();

    await service.handler({ callerId: "ws:local-main", callerKind: "server" }, "ensurePanelToken", [
      "panel-1",
      "ctx-1",
      null,
      "panels/chat",
    ]);

    expect(tokenManager.getPanelOwner("panel-1")).toBe("ws:local-main");
  });

  it("reclaims panel ownership for the authenticated shell caller", async () => {
    const { service, tokenManager } = createService();
    tokenManager.ensureToken("panel-1", "panel");
    tokenManager.setPanelOwner("panel-1", "shell:old");

    await service.handler(
      { callerId: "shell:new", callerKind: "shell", connectionId: "conn-2" },
      "reclaimPanels",
      [["panel-1"]]
    );

    expect(tokenManager.getPanelOwner("panel-1")).toBe("shell:new");
    expect(tokenManager.getPanelOwnerConnection("panel-1")).toBeUndefined();
  });
});
