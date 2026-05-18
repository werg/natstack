import { describe, expect, it } from "vitest";
import { GitAuthManager } from "./auth.js";

describe("GitAuthManager", () => {
  it("allows shell callers to push", () => {
    const auth = new GitAuthManager();

    expect(auth.canAccess("shell:1", "shell", "panels/example", "push")).toEqual({ allowed: true });
  });

  it("keeps protected tree push ownership checks before prompting", () => {
    const auth = new GitAuthManager();

    expect(auth.canAccess("panel:tree/panels/chat/owner", "panel", "tree/panels/chat/other", "push")).toEqual({
      allowed: false,
      reason: expect.stringContaining("cannot push"),
    });
  });

  it("allows canonical panel callers to push owned protected tree paths", () => {
    const auth = new GitAuthManager();

    expect(auth.canAccess("panel:tree/panels/chat", "panel", "tree/panels/chat/child", "push")).toEqual({
      allowed: true,
    });
  });
});
