import { describe, expect, it, vi } from "vitest";
import { ELECTRON_LOCAL_SERVICE_NAMES } from "@natstack/rpc";
import { createPanelPersistenceService } from "./panelPersistenceService.js";

describe("panelPersistenceService", () => {
  it("is restricted to shell/server callers and is not panel-routable", () => {
    const service = createPanelPersistenceService({
      workspaceId: "workspace-1",
      doDispatch: { dispatch: vi.fn() } as never,
    });

    expect(service.policy.allowed).toEqual(["shell", "server"]);
    expect((ELECTRON_LOCAL_SERVICE_NAMES as readonly string[]).includes("panel-persistence")).toBe(
      false
    );
  });
});
