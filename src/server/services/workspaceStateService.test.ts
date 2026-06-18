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
  onSlotStateChanged?: () => void;
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
    ...(opts.onSlotStateChanged ? { onSlotStateChanged: opts.onSlotStateChanged } : {}),
  });
  return { svc, calls };
}

describe("workspaceStateService — title mirror hooks", () => {
  it("allows approved shell apps to read and write workspace slot state", () => {
    const { svc } = makeService({});

    expect(svc.policy.allowed).toContain("app");
    expect(svc.methods["slot.list"]?.policy?.allowed).toContain("app");
    expect(svc.methods["slot.create"]?.policy?.allowed).toContain("app");
  });

  it("exposes lifecycle lease methods to DO callers", async () => {
    const { svc, calls } = makeService({});
    const key = { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" };

    expect(svc.methods["lifecycleLeaseUpsert"]?.policy?.allowed).toContain("do");
    expect(svc.methods["lifecycleLeaseClear"]?.policy?.allowed).toContain("do");

    await svc.handler(makeCtx() as never, "lifecycleLeaseUpsert", [{ ...key, detail: "turn" }]);
    await svc.handler(makeCtx() as never, "lifecycleLeaseClear", [key]);

    expect(calls).toEqual([
      { method: "lifecycleLeaseUpsert", args: [{ ...key, detail: "turn" }] },
      { method: "lifecycleLeaseClear", args: [key] },
    ]);
  });

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

describe("workspaceStateService — slot-state change hook", () => {
  const mutating: Array<[method: string, args: unknown[]]> = [
    ["slot.create", [{ slotId: "s1" }]],
    ["slot.appendHistory", ["s1", { entryKey: "e1" }]],
    ["slot.setCurrent", ["s1", "e1"]],
    ["slot.updateCurrentStateArgs", ["s1", {}]],
    ["slot.replaceHistory", ["s1", [], 0]],
    ["slot.setParent", ["s1", null]],
    ["slot.setPosition", ["s1", "p1"]],
    ["slot.move", ["s1", null, "p1"]],
    ["slot.close", ["s1"]],
  ];

  for (const [method, args] of mutating) {
    it(`fires onSlotStateChanged after ${method}`, async () => {
      const onSlotStateChanged = vi.fn();
      const { svc } = makeService({ onSlotStateChanged });
      await svc.handler(makeCtx() as never, method, args);
      expect(onSlotStateChanged).toHaveBeenCalledTimes(1);
    });
  }

  const reads: Array<[method: string, args: unknown[]]> = [
    ["slot.list", []],
    ["slot.get", ["s1"]],
    ["slot.history", ["s1"]],
    ["entity.resolveActive", ["e1"]],
    ["panel.search", ["q", 10]],
    ["panel.incrementAccess", ["e1"]],
  ];

  for (const [method, args] of reads) {
    it(`does not fire onSlotStateChanged for read/non-tree method ${method}`, async () => {
      const onSlotStateChanged = vi.fn();
      const { svc } = makeService({ onSlotStateChanged });
      await svc.handler(makeCtx() as never, method, args);
      expect(onSlotStateChanged).not.toHaveBeenCalled();
    });
  }
});
