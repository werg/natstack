import { describe, expect, it } from "vitest";
import { PrincipalRegistry } from "./principalRegistry.js";

describe("PrincipalRegistry", () => {
  it("stores source, context, and parent independently", () => {
    const registry = new PrincipalRegistry();
    registry.register({
      id: "panel:one",
      kind: "panel",
      source: { repoPath: "panels/one", effectiveVersion: "ev1" },
      context: { contextId: "ctx-1" },
      parent: { parentId: null },
    });

    registry.bindContext("panel:one", "ctx-2");
    registry.setParent("panel:one", "panel:root");

    expect(registry.resolveSource("panel:one")).toEqual({
      repoPath: "panels/one",
      effectiveVersion: "ev1",
    });
    expect(registry.resolveContext("panel:one")).toBe("ctx-2");
    expect(registry.resolveParent("panel:one")).toBe("panel:root");
  });

  it("projects concrete DO caller ids onto do-service principals", () => {
    const registry = new PrincipalRegistry();
    registry.register({
      id: "do-service:workers/store:Store",
      kind: "do-service",
      source: { repoPath: "workers/store", effectiveVersion: "ev1" },
    });

    expect(registry.resolveAlias("do:workers/store:Store:key:with:colon")).toBe(
      "do-service:workers/store:Store",
    );
    expect(registry.resolveSource("do:workers/store:Store:key")).toEqual({
      repoPath: "workers/store",
      effectiveVersion: "ev1",
    });
  });

  it("checks descendants through parent records", () => {
    const registry = new PrincipalRegistry();
    registry.register({ id: "panel:root", kind: "panel" });
    registry.register({ id: "panel:child", kind: "panel", parent: { parentId: "panel:root" } });
    registry.register({
      id: "panel:grandchild",
      kind: "panel",
      parent: { parentId: "panel:child" },
    });

    expect(registry.isDescendantOf("panel:grandchild", "panel:root")).toBe(true);
    expect(registry.isDescendantOf("panel:root", "panel:grandchild")).toBe(false);
  });
});
