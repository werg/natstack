// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { createEntityTitleService, type EntityTitleService } from "./entityTitleService.js";
import type { DODispatch, DORef } from "../doDispatch.js";

interface FakeDispatch extends DODispatch {
  calls: Array<{ method: string; args: unknown[] }>;
  storedTitles: Map<string, string | null>;
  hydrateResponse: Array<{ id: string; title: string }>;
}

function makeDispatch(): FakeDispatch {
  const storedTitles = new Map<string, string | null>();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const hydrateResponse: Array<{ id: string; title: string }> = [];
  const dispatch: FakeDispatch = {
    calls,
    storedTitles,
    hydrateResponse,
    // The real DODispatch has more on it; the service only uses .dispatch.
    dispatch: vi.fn(async (_ref: DORef, method: string, ...args: unknown[]) => {
      calls.push({ method, args });
      if (method === "entitySetDisplayTitle") {
        const [entityId, title] = args as [string, string | null];
        storedTitles.set(entityId, title);
        return undefined;
      }
      if (method === "entityListDisplayTitles") {
        return hydrateResponse;
      }
      return undefined;
    }),
  } as unknown as FakeDispatch;
  return dispatch;
}

const workspaceRef: DORef = {
  source: "internal",
  className: "WorkspaceDO",
  objectKey: "test-workspace",
};

function svcWithDispatch(): {
  svc: EntityTitleService;
  dispatch: FakeDispatch;
  setDispatch: (next: DODispatch | null) => void;
} {
  let active: DODispatch | null = makeDispatch();
  const setDispatch = (next: DODispatch | null) => {
    active = next;
  };
  const svc = createEntityTitleService({
    getDoDispatch: () => active,
    workspaceRef,
  });
  return { svc, dispatch: active as FakeDispatch, setDispatch };
}

describe("createEntityTitleService", () => {
  it("setTitle updates cache and writes through to the DO", async () => {
    const { svc, dispatch } = svcWithDispatch();
    await svc.setTitle("panel:abc", "Hello world");
    expect(svc.getTitle("panel:abc")).toBe("Hello world");
    expect(dispatch.calls).toContainEqual({
      method: "entitySetDisplayTitle",
      args: ["panel:abc", "Hello world"],
    });
  });

  it("collapses whitespace and strips control chars on write", async () => {
    const { svc, dispatch } = svcWithDispatch();
    await svc.setTitle("worker:1", "   Hello   world   ");
    expect(svc.getTitle("worker:1")).toBe("Hello world");
    // The DO sees the sanitized value, not the raw input.
    expect(dispatch.calls[dispatch.calls.length - 1]).toEqual({
      method: "entitySetDisplayTitle",
      args: ["worker:1", "Hello world"],
    });
  });

  it("treats empty/whitespace-only/null as a clear", async () => {
    const { svc, dispatch } = svcWithDispatch();
    await svc.setTitle("worker:1", "Initial");
    await svc.setTitle("worker:1", "   ");
    expect(svc.getTitle("worker:1")).toBeUndefined();
    // The DO receives null (not the empty string) so it can drop the row.
    expect(dispatch.calls[dispatch.calls.length - 1]).toEqual({
      method: "entitySetDisplayTitle",
      args: ["worker:1", null],
    });
  });

  it("mirrorCachedTitle updates the cache but does NOT call the DO", async () => {
    const { svc, dispatch } = svcWithDispatch();
    const listener = vi.fn();
    svc.onChanged(listener);
    svc.mirrorCachedTitle("panel:zzz", "Mirrored");
    expect(svc.getTitle("panel:zzz")).toBe("Mirrored");
    expect(dispatch.calls).toEqual([]);
    expect(listener).toHaveBeenCalledWith("panel:zzz", "Mirrored", "mirror");
  });

  it("clear() drops the cache row and writes null to the DO", async () => {
    const { svc, dispatch } = svcWithDispatch();
    await svc.setTitle("do:1", "Title");
    await svc.clear("do:1");
    expect(svc.getTitle("do:1")).toBeUndefined();
    expect(dispatch.calls[dispatch.calls.length - 1]).toEqual({
      method: "entitySetDisplayTitle",
      args: ["do:1", null],
    });
  });

  it("skips notifications when the value is unchanged", async () => {
    const { svc } = svcWithDispatch();
    const listener = vi.fn();
    svc.onChanged(listener);
    await svc.setTitle("panel:dup", "Same");
    await svc.setTitle("panel:dup", "Same");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("panel:dup", "Same", "set");
  });

  it("marks explicit clears distinctly", async () => {
    const { svc } = svcWithDispatch();
    await svc.setTitle("panel:clear", "Temporary");
    const listener = vi.fn();
    svc.onChanged(listener);
    await svc.clear("panel:clear");
    expect(listener).toHaveBeenCalledWith("panel:clear", undefined, "clear");
  });

  it("caps very long titles", async () => {
    const { svc } = svcWithDispatch();
    await svc.setTitle("worker:long", "x".repeat(500));
    const stored = svc.getTitle("worker:long");
    expect(stored).toBeDefined();
    expect(stored!.length).toBeLessThanOrEqual(120);
  });

  it("hydrate seeds the cache from the DO", async () => {
    const dispatch = makeDispatch();
    dispatch.hydrateResponse.push(
      { id: "panel:1", title: "Restored panel" },
      { id: "worker:1", title: "Restored worker" }
    );
    const svc = createEntityTitleService({
      getDoDispatch: () => dispatch,
      workspaceRef,
    });
    await svc.hydrate();
    expect(svc.getTitle("panel:1")).toBe("Restored panel");
    expect(svc.getTitle("worker:1")).toBe("Restored worker");
  });

  it("getTitle still works before doDispatch is online (cache-only path)", async () => {
    let active: DODispatch | null = null;
    const svc = createEntityTitleService({
      getDoDispatch: () => active,
      workspaceRef,
    });
    // setTitle without a dispatcher updates the cache and returns. The DO
    // write is silently dropped; the next setter will land in the DO once
    // dispatch comes online.
    await svc.setTitle("panel:early", "Pre-boot title");
    expect(svc.getTitle("panel:early")).toBe("Pre-boot title");
    active = makeDispatch();
    await svc.setTitle("panel:early", "Pre-boot title 2");
    expect((active as FakeDispatch).calls).toContainEqual({
      method: "entitySetDisplayTitle",
      args: ["panel:early", "Pre-boot title 2"],
    });
  });
});
