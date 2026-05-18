import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { describe, expect, it, vi } from "vitest";
import { TokenManager } from "@natstack/shared/tokenManager";
import { createTokensService } from "./tokensService.js";

function createService(tokenManager = new TokenManager()) {
  const service = createTokensService({ tokenManager });
  return { service, tokenManager };
}

describe("tokensService", () => {
  it("does not expose panel token lifecycle methods", async () => {
    const { service } = createService();

    await expect(
      service.handler(
        { caller: createVerifiedCaller("shell:abc", "shell"), connectionId: "conn-1" },
        "ensurePanelToken",
        ["panel:panel-1", "ctx-1", null, "panels/chat"]
      )
    ).rejects.toThrow(/Unknown tokens method/);
  });

  it("rotates the admin token only after persistence succeeds", async () => {
    const tokenManager = new TokenManager();
    tokenManager.setAdminToken("old-token");
    const persistAdminToken = vi.fn();
    const service = createTokensService({ tokenManager, persistAdminToken });

    const next = (await service.handler(
      { caller: createVerifiedCaller("shell:abc", "shell") },
      "rotateAdmin",
      []
    )) as string;

    expect(persistAdminToken).toHaveBeenCalledWith(next);
    expect(tokenManager.validateAdminToken(next)).toBe(true);
    expect(tokenManager.validateAdminToken("old-token")).toBe(false);
  });
});
