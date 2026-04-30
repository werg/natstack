import { describe, expect, it, vi } from "vitest";
import { GitAuthManager } from "./auth.js";

describe("GitAuthManager", () => {
  it("returns caller identity for authenticated pushes", () => {
    const auth = new GitAuthManager({
      getToken: vi.fn(),
      revokeToken: vi.fn(),
      validateToken: vi.fn(() => ({ callerId: "panel:1", callerKind: "panel" })),
    });

    expect(auth.validateAccess("token", "panels/example", "push")).toMatchObject({
      valid: true,
      callerId: "panel:1",
      callerKind: "panel",
    });
  });

  it("keeps protected tree push ownership checks before prompting", () => {
    const auth = new GitAuthManager({
      getToken: vi.fn(),
      revokeToken: vi.fn(),
      validateToken: vi.fn(() => ({ callerId: "tree/panels/chat/owner", callerKind: "panel" })),
    });

    expect(auth.validateAccess("token", "tree/panels/chat/other", "push")).toMatchObject({
      valid: false,
      reason: expect.stringContaining("cannot push"),
    });
  });
});
