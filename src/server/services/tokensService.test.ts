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
    gitServer: {
      getTokenForPanel: vi.fn(() => "git-token"),
      revokeTokenForPanel: vi.fn(),
    } as never,
  });
  return { service, tokenManager };
}

describe("tokensService", () => {
  it("records the authenticated shell websocket as the panel browser handoff owner", async () => {
    const { service, tokenManager } = createService();

    await service.handler({ callerId: "shell:abc", callerKind: "shell" }, "ensurePanelToken", [
      "panel-1",
      "ctx-1",
      null,
      "panels/chat",
    ]);

    expect(tokenManager.getPanelOwner("panel-1")).toBe("shell:abc");
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
});
