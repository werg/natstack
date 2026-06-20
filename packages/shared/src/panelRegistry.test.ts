import { describe, it, expect, vi, beforeEach } from "vitest";
import { PanelRegistry } from "./panelRegistry.js";
import { asPanelEntityId, asPanelSlotId } from "./panel/ids.js";
import type { Panel, PanelTreeSnapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePanel(id: string, overrides?: Partial<Panel>): Panel {
  const snapshot = {
    source: `panels/${id}`,
    contextId: `ctx-${id}`,
    options: {},
  };
  return {
    id,
    title: id,
    children: [],
    snapshot,
    artifacts: {},
    ...overrides,
  };
}

function makeRegistry(onTreeUpdated?: (snapshot: PanelTreeSnapshot) => void) {
  return new PanelRegistry({
    onTreeUpdated: onTreeUpdated ?? vi.fn(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PanelRegistry", () => {
  let registry: PanelRegistry;
  let onTreeUpdated: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onTreeUpdated = vi.fn();
    registry = makeRegistry(onTreeUpdated);
  });

  // -------------------------------------------------------------------------
  // addPanel
  // -------------------------------------------------------------------------

  describe("addPanel", () => {
    it("adds a root panel (replaces tree by default)", () => {
      const p = makePanel("panel:tree/root-1");
      registry.addPanel(p, null);

      expect(registry.getPanel("panel:tree/root-1")).toBe(p);
      expect(registry.getRootPanels()).toEqual([p]);
    });

    it("adds a root panel with addAsRoot without clearing existing roots", () => {
      const p1 = makePanel("panel:tree/root-1");
      const p2 = makePanel("panel:tree/root-2");

      registry.addPanel(p1, null, { addAsRoot: true });
      registry.addPanel(p2, null, { addAsRoot: true });

      expect(registry.getRootPanels().length).toBe(2);
      expect(registry.getRootPanels()[0]!.id).toBe("panel:tree/root-1");
      expect(registry.getRootPanels()[1]!.id).toBe("panel:tree/root-2");
    });

    it("adds a child panel under a parent", () => {
      const parent = makePanel("panel:tree/parent");
      registry.addPanel(parent, null, { addAsRoot: true });

      const child = makePanel("panel:tree/child");
      registry.addPanel(child, "panel:tree/parent");

      expect(registry.getPanel("panel:tree/child")).toBe(child);
      expect(parent.children[0]).toBe(child);
    });

    it("throws when adding a child to a nonexistent parent", () => {
      const child = makePanel("panel:tree/child");
      expect(() => registry.addPanel(child, "panel:tree/no-such-parent")).toThrow("Parent panel not found");
    });
  });

  describe("listPanels/getChildren", () => {
    it("includes kind and hydrates direct children", () => {
      const root = makePanel("panel:tree/root");
      const child = makePanel("panel:tree/child", {
        snapshot: {
          source: "browser:https://example.com",
          contextId: "ctx-child",
          options: {},
        },
      });
      registry.addPanel(root, null, { addAsRoot: true });
      registry.addPanel(child, "panel:tree/root");

      expect(registry.listPanels()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ panelId: "panel:tree/root", kind: "workspace", parentId: null }),
          expect.objectContaining({ panelId: "panel:tree/child", kind: "browser", parentId: "panel:tree/root" }),
        ])
      );
      expect(registry.getChildren("panel:tree/root")).toEqual([
        expect.objectContaining({
          panelId: "panel:tree/child",
          source: "browser:https://example.com",
          kind: "browser",
          parentId: "panel:tree/root",
        }),
      ]);
    });
  });

  describe("repopulate", () => {
    it("preserves runtime artifacts and navigation for unchanged panels", () => {
      registry.addPanel(
        makePanel("panel:tree/root", {
          artifacts: {
            htmlPath: "http://localhost:1234/panels/chat/",
            buildState: "ready",
          },
          navigation: {
            url: "http://localhost:1234/panels/chat/",
            isLoading: false,
            canGoBack: true,
          },
        }),
        null,
        { addAsRoot: true }
      );

      registry.repopulate([
        makePanel("panel:tree/root", {
          title: "root from server",
          artifacts: {},
        }),
      ]);

      expect(registry.getPanel("panel:tree/root")?.artifacts).toEqual({
        htmlPath: "http://localhost:1234/panels/chat/",
        buildState: "ready",
      });
      expect(registry.getPanel("panel:tree/root")?.navigation).toEqual({
        url: "http://localhost:1234/panels/chat/",
        isLoading: false,
        canGoBack: true,
      });
      expect(registry.getPanel("panel:tree/root")?.title).toBe("root from server");
    });

    it("preserves runtime artifacts across an in-place navigate (same contextId, new source)", () => {
      // Navigating a panel in place keeps the view session (contextId) but
      // changes the source; the Electron-main artifacts are authoritative for the
      // live view and must survive the next server repopulate.
      registry.addPanel(
        makePanel("panel:tree/root", {
          artifacts: {
            htmlPath: "http://localhost:1234/panels/chat/",
            buildState: "ready",
          },
        }),
        null,
        { addAsRoot: true }
      );

      registry.repopulate([
        makePanel("panel:tree/root", {
          snapshot: {
            source: "panels/other",
            contextId: "ctx-panel:tree/root",
            options: {},
          },
          artifacts: {},
        }),
      ]);

      expect(registry.getPanel("panel:tree/root")?.artifacts).toEqual({
        htmlPath: "http://localhost:1234/panels/chat/",
        buildState: "ready",
      });
    });

    it("does not preserve runtime artifacts when the view session (contextId) changes", () => {
      registry.addPanel(
        makePanel("panel:tree/root", {
          artifacts: {
            htmlPath: "http://localhost:1234/panels/chat/",
            buildState: "ready",
          },
        }),
        null,
        { addAsRoot: true }
      );

      registry.repopulate([
        makePanel("panel:tree/root", {
          snapshot: {
            source: "panels/other",
            contextId: "ctx-different",
            options: {},
          },
          artifacts: {},
        }),
      ]);

      expect(registry.getPanel("panel:tree/root")?.artifacts).toEqual({});
    });
  });

  describe("explicit state", () => {
    it("derives build and view state from artifacts", () => {
      registry.addPanel(makePanel("panel:tree/root"), null, { addAsRoot: true });

      registry.updateArtifacts("panel:tree/root", {
        buildState: "ready",
        htmlPath: "http://localhost:1234/panels/root/",
      });

      expect(registry.getPanel("panel:tree/root")?.state).toMatchObject({
        build: {
          state: "ready",
          artifactUrl: "http://localhost:1234/panels/root/",
        },
        view: {
          exists: true,
          url: "http://localhost:1234/panels/root/",
        },
        runtime: {
          leased: false,
        },
      });
    });

    it("applies runtime leases by slot id while preserving runtime entity id", () => {
      registry.addPanel(makePanel("panel:tree/slot-a"), null, { addAsRoot: true });

      registry.applyRuntimeLeaseSnapshot({
        version: { epoch: "test", counter: 1 },
        leases: [
          {
            slotId: asPanelSlotId("panel:tree/slot-a"),
            runtimeEntityId: asPanelEntityId("panel:nav-entity-a"),
            clientSessionId: "desktop-a",
            hostConnectionId: "desktop-a",
            connectionId: "conn-a",
            holderLabel: "Desktop A",
            platform: "desktop",
            supportsCdp: true,
            loadOnLeaseAssignment: false,
            acquiredAt: 1,
          },
        ],
      });

      expect(registry.getRuntimeLease("panel:tree/slot-a")).toMatchObject({
        slotId: "panel:tree/slot-a",
        runtimeEntityId: "panel:nav-entity-a",
      });
      expect(registry.getPanel("panel:tree/slot-a")?.state?.runtime).toMatchObject({
        leased: true,
        holderLabel: "Desktop A",
        clientSessionId: "desktop-a",
        connectionId: "conn-a",
      });
    });
  });

  // -------------------------------------------------------------------------
  // findParentId
  // -------------------------------------------------------------------------

  describe("findParentId", () => {
    it("returns null for root panels", () => {
      const root = makePanel("panel:tree/root");
      registry.addPanel(root, null, { addAsRoot: true });
      expect(registry.findParentId("panel:tree/root")).toBeNull();
    });

    it("returns the parent ID for a child panel", () => {
      const parent = makePanel("panel:tree/parent");
      registry.addPanel(parent, null, { addAsRoot: true });

      const child = makePanel("panel:tree/child");
      registry.addPanel(child, "panel:tree/parent");

      expect(registry.findParentId("panel:tree/child")).toBe("panel:tree/parent");
    });

    it("returns null for unknown panel IDs", () => {
      expect(registry.findParentId("nonexistent")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // isDescendantOf
  // -------------------------------------------------------------------------

  describe("isDescendantOf", () => {
    it("returns true for a direct child", () => {
      const parent = makePanel("panel:tree/parent");
      registry.addPanel(parent, null, { addAsRoot: true });

      const child = makePanel("panel:tree/child");
      registry.addPanel(child, "panel:tree/parent");

      expect(registry.isDescendantOf("panel:tree/child", "panel:tree/parent")).toBe(true);
    });

    it("returns true for a grandchild", () => {
      const root = makePanel("panel:tree/root");
      registry.addPanel(root, null, { addAsRoot: true });

      const mid = makePanel("panel:tree/mid");
      registry.addPanel(mid, "panel:tree/root");

      const leaf = makePanel("panel:tree/leaf");
      registry.addPanel(leaf, "panel:tree/mid");

      expect(registry.isDescendantOf("panel:tree/leaf", "panel:tree/root")).toBe(true);
    });

    it("returns false when there is no ancestor relationship", () => {
      const a = makePanel("panel:tree/a");
      const b = makePanel("panel:tree/b");
      registry.addPanel(a, null, { addAsRoot: true });
      registry.addPanel(b, null, { addAsRoot: true });

      expect(registry.isDescendantOf("panel:tree/a", "panel:tree/b")).toBe(false);
    });

    it("returns false for the same panel", () => {
      const p = makePanel("panel:tree/p");
      registry.addPanel(p, null, { addAsRoot: true });
      expect(registry.isDescendantOf("panel:tree/p", "panel:tree/p")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // removePanel
  // -------------------------------------------------------------------------

  describe("removePanel", () => {
    it("removes a root panel", () => {
      const p = makePanel("panel:tree/root");
      registry.addPanel(p, null, { addAsRoot: true });

      registry.removePanel("panel:tree/root");

      expect(registry.getPanel("panel:tree/root")).toBeUndefined();
      expect(registry.getRootPanels().length).toBe(0);
    });

    it("removes a child panel from its parent", () => {
      const parent = makePanel("panel:tree/parent");
      registry.addPanel(parent, null, { addAsRoot: true });

      const child = makePanel("panel:tree/child");
      registry.addPanel(child, "panel:tree/parent");

      registry.removePanel("panel:tree/child");

      expect(registry.getPanel("panel:tree/child")).toBeUndefined();
      expect(parent.children.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // movePanel
  // -------------------------------------------------------------------------

  describe("movePanel", () => {
    it("moves a root panel under another root", () => {
      const a = makePanel("panel:tree/a");
      const b = makePanel("panel:tree/b");
      registry.addPanel(a, null, { addAsRoot: true });
      registry.addPanel(b, null, { addAsRoot: true });

      registry.movePanel("panel:tree/a", "panel:tree/b", 0);

      expect(registry.findParentId("panel:tree/a")).toBe("panel:tree/b");
      expect(registry.getRootPanels().map((p) => p.id)).toEqual(["panel:tree/b"]);
    });

    it("moves a child to root level", () => {
      const parent = makePanel("panel:tree/parent");
      registry.addPanel(parent, null, { addAsRoot: true });

      const child = makePanel("panel:tree/child");
      registry.addPanel(child, "panel:tree/parent");

      registry.movePanel("panel:tree/child", null, 0);

      expect(registry.findParentId("panel:tree/child")).toBeNull();
      expect(registry.getRootPanels().map((p) => p.id)).toContain("panel:tree/child");
      expect(parent.children.length).toBe(0);
    });

    it("throws when moving into own subtree", () => {
      const parent = makePanel("panel:tree/parent");
      registry.addPanel(parent, null, { addAsRoot: true });

      const child = makePanel("panel:tree/child");
      registry.addPanel(child, "panel:tree/parent");

      expect(() => registry.movePanel("panel:tree/parent", "panel:tree/child", 0)).toThrow(
        "Cannot move panel into its own subtree"
      );
    });

    it("throws when panel not found", () => {
      expect(() => registry.movePanel("nope", null, 0)).toThrow("Panel not found");
    });

    it("throws when new parent not found", () => {
      const p = makePanel("panel:tree/p");
      registry.addPanel(p, null, { addAsRoot: true });
      expect(() => registry.movePanel("panel:tree/p", "no-parent", 0)).toThrow("New parent panel not found");
    });

    it("clamps target position to valid range", () => {
      const a = makePanel("panel:tree/a");
      const b = makePanel("panel:tree/b");
      registry.addPanel(a, null, { addAsRoot: true });
      registry.addPanel(b, null, { addAsRoot: true });

      // Position 999 should be clamped
      registry.movePanel("panel:tree/a", "panel:tree/b", 999);
      expect(registry.findParentId("panel:tree/a")).toBe("panel:tree/b");
      expect(b.children[0]!.id).toBe("panel:tree/a");
    });
  });

  // -------------------------------------------------------------------------
  // reservePanelId / releasePanelId
  // -------------------------------------------------------------------------

  describe("reservePanelId / releasePanelId", () => {
    it("reserves an ID successfully", () => {
      expect(registry.reservePanelId("new-panel")).toBe(true);
    });

    it("returns false when reserving an already reserved ID", () => {
      registry.reservePanelId("x");
      expect(registry.reservePanelId("x")).toBe(false);
    });

    it("returns false when reserving an ID that already has a panel", () => {
      const p = makePanel("panel:tree/existing");
      registry.addPanel(p, null, { addAsRoot: true });
      expect(registry.reservePanelId("panel:tree/existing")).toBe(false);
    });

    it("allows re-reservation after release", () => {
      registry.reservePanelId("x");
      registry.releasePanelId("x");
      expect(registry.reservePanelId("x")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // updateSelectedPath
  // -------------------------------------------------------------------------

  describe("updateSelectedPath", () => {
    it("walks up the tree setting selectedChildId", () => {
      const root = makePanel("panel:tree/root");
      registry.addPanel(root, null, { addAsRoot: true });

      const mid = makePanel("panel:tree/mid");
      registry.addPanel(mid, "panel:tree/root");

      const leaf = makePanel("panel:tree/leaf");
      registry.addPanel(leaf, "panel:tree/mid");

      registry.updateSelectedPath("panel:tree/leaf");

      expect(registry.getFocusedPanelId()).toBe("panel:tree/leaf");
      expect(registry.getPanel("panel:tree/root")?.selectedChildId).toBe("panel:tree/mid");
      expect(registry.getPanel("panel:tree/mid")?.selectedChildId).toBe("panel:tree/leaf");
    });
  });

  // -------------------------------------------------------------------------
  // getSerializablePanelTree
  // -------------------------------------------------------------------------

  describe("getSerializablePanelTree", () => {
    it("returns a deep copy of the tree", () => {
      const root = makePanel("panel:tree/root");
      registry.addPanel(root, null, { addAsRoot: true });

      const child = makePanel("panel:tree/child");
      registry.addPanel(child, "panel:tree/root");

      const tree = registry.getSerializablePanelTree();
      expect(tree.length).toBe(1);
      expect(tree[0]!.id).toBe("panel:tree/root");
      expect(tree[0]!.children.length).toBe(1);
      expect(tree[0]!.children[0]!.id).toBe("panel:tree/child");

      // Should be a copy, not the same reference
      expect(tree[0]).not.toBe(root);
    });

    it("exposes monotonically increasing tree revisions", async () => {
      const updates: PanelTreeSnapshot[] = [];
      registry = makeRegistry((snapshot) => updates.push(snapshot));

      expect(registry.getTreeRevision()).toBe(0);
      registry.addPanel(makePanel("panel:tree/root"), null, { addAsRoot: true });
      const afterAdd = registry.getTreeRevision();
      registry.updateTitle("panel:tree/root", "Root");
      const afterTitle = registry.getTreeRevision();

      expect(afterAdd).toBeGreaterThan(0);
      expect(afterTitle).toBeGreaterThan(afterAdd);

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(updates[updates.length - 1]).toMatchObject({
        revision: afterTitle,
        rootPanels: [expect.objectContaining({ id: "panel:tree/root", title: "Root" })],
      });
    });
  });

  // -------------------------------------------------------------------------
  // Headless paginated queries (in-memory)
  // -------------------------------------------------------------------------

  // cleanupChildlessAutoArchivePanels tests removed — cleanup logic now in server panel service

  // -------------------------------------------------------------------------
  // Headless paginated queries (in-memory)
  // -------------------------------------------------------------------------

  describe("paginated queries (in-memory)", () => {
    it("getChildrenPaginated returns children slice", () => {
      const parent = makePanel("panel:tree/parent");
      registry.addPanel(parent, null, { addAsRoot: true });

      for (let i = 0; i < 5; i++) {
        registry.addPanel(makePanel(`c${i}`), "panel:tree/parent");
      }

      const page = registry.getChildrenPaginated("panel:tree/parent", 1, 2);
      expect(page.total).toBe(5);
      expect(page.children.length).toBe(2);
      expect(page.hasMore).toBe(true);
    });

    it("getRootPanelsPaginated returns root panels slice", () => {
      for (let i = 0; i < 4; i++) {
        registry.addPanel(makePanel(`r${i}`), null, { addAsRoot: true });
      }

      const page = registry.getRootPanelsPaginated(0, 2);
      expect(page.total).toBe(4);
      expect(page.panels.length).toBe(2);
      expect(page.hasMore).toBe(true);
    });
  });
});
