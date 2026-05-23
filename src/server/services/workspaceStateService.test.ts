// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { createWorkspaceStateService } from "./workspaceStateService.js";

interface MockHandlerCtx {
  caller: { runtime: { kind: string; id: string } };
}

function makeCtx(): MockHandlerCtx {
  return { caller: { runtime: { kind: "shell", id: "shell" } } };
}

function makeService(opts: {
  onPanelTitleChanged?: (entityId: string, title: string) => void;
  /**
   * Map of DO method → return value. The dispatcher uses this to drive
   * outcomes (e.g. simulating the entity-id WorkspaceDO returns from
   * `panelIndex` / `panelUpdateTitle`).
   */
  dispatchReturns?: Record<string, unknown>;
}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const doDispatch = {
    dispatch: async (_ref: unknown, method: string, ...args: unknown[]) => {
      calls.push({ method, args });
      return opts.dispatchReturns?.[method];
    },
  };
  const svc = createWorkspaceStateService({
    doDispatch: doDispatch as never,
    workspaceId: "test-workspace",
    ...(opts.onPanelTitleChanged ? { onPanelTitleChanged: opts.onPanelTitleChanged } : {}),
  });
  return { svc, calls };
}

describe("workspaceStateService — title mirror hooks", () => {
  it("fires onPanelTitleChanged with the DO-resolved entity id on panel.index", async () => {
    const onPanelTitleChanged = vi.fn();
    const { svc } = makeService({
      onPanelTitleChanged,
      // WorkspaceDO returns the slot's current entity id when it stamped a
      // title — the service should pass THAT (not the slot id) to the hook.
      dispatchReturns: { panelIndex: "entity:abc-current" },
    });
    await svc.handler(makeCtx() as never, "panel.index", [
      { id: "panel:abc", title: "Spectrolite — README" },
    ]);
    expect(onPanelTitleChanged).toHaveBeenCalledWith("entity:abc-current", "Spectrolite — README");
  });

  it("skips onPanelTitleChanged on panel.index when the input has no title", async () => {
    const onPanelTitleChanged = vi.fn();
    const { svc } = makeService({
      onPanelTitleChanged,
      dispatchReturns: { panelIndex: null },
    });
    await svc.handler(makeCtx() as never, "panel.index", [{ id: "panel:abc", title: "" }]);
    expect(onPanelTitleChanged).not.toHaveBeenCalled();
  });

  it("fires onPanelTitleChanged with the resolved entity id on panel.updateTitle", async () => {
    const onPanelTitleChanged = vi.fn();
    const { svc } = makeService({
      onPanelTitleChanged,
      dispatchReturns: { panelUpdateTitle: "entity:abc-current" },
    });
    await svc.handler(makeCtx() as never, "panel.updateTitle", ["panel:abc", "New title"]);
    expect(onPanelTitleChanged).toHaveBeenCalledWith("entity:abc-current", "New title");
  });

  it("does not fire onPanelTitleChanged when the slot has no current entity", async () => {
    const onPanelTitleChanged = vi.fn();
    const { svc } = makeService({
      onPanelTitleChanged,
      dispatchReturns: { panelUpdateTitle: null },
    });
    await svc.handler(makeCtx() as never, "panel.updateTitle", ["panel:abc", "Stale"]);
    expect(onPanelTitleChanged).not.toHaveBeenCalled();
  });

  it("never fires onPanelTitleChanged for unrelated methods", async () => {
    const onPanelTitleChanged = vi.fn();
    const { svc } = makeService({ onPanelTitleChanged });
    await svc.handler(makeCtx() as never, "panel.incrementAccess", ["panel:abc"]);
    expect(onPanelTitleChanged).not.toHaveBeenCalled();
  });
});
