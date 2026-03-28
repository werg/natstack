import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PanelShell } from "./panelShell.js";
import type { RpcBridge } from "@natstack/rpc";
import type { Panel } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePanel(id: string, overrides?: Partial<Panel>): Panel {
  return {
    id,
    title: id,
    children: [],
    selectedChildId: null,
    snapshot: {
      source: `panels/${id}`,
      contextId: `ctx-${id}`,
      options: {},
    },
    artifacts: {},
    ...overrides,
  };
}

function makeRpc(): RpcBridge & { call: ReturnType<typeof vi.fn> } {
  return {
    call: vi.fn(),
    emit: vi.fn(),
    onEvent: vi.fn(),
    exposeMethod: vi.fn(),
    expose: vi.fn(),
    selfId: "test",
  } as unknown as RpcBridge & { call: ReturnType<typeof vi.fn> };
}

function serverTreeResponse(panels: Panel[], collapsedIds: string[] = []) {
  return { rootPanels: panels, collapsedIds };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PanelShell", () => {
  let rpc: ReturnType<typeof makeRpc>;
  let shell: PanelShell;
  let onTreeUpdated: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    rpc = makeRpc();
    onTreeUpdated = vi.fn();
    shell = new PanelShell(rpc, onTreeUpdated);
  });

  afterEach(() => {
    shell.dispose();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  describe("init()", () => {
    it("calls panel.loadTree RPC and populates registry", async () => {
      const panels = [makePanel("root-1"), makePanel("root-2")];
      rpc.call.mockResolvedValueOnce(serverTreeResponse(panels, ["root-2"]));

      await shell.init();

      expect(rpc.call).toHaveBeenCalledWith("main", "panel.loadTree");
      expect(shell.getTree()).toHaveLength(2);
      expect(shell.getTree()[0]!.id).toBe("root-1");
      expect(shell.getCollapsedIds()).toEqual(["root-2"]);
    });

    it("handles empty tree from server", async () => {
      rpc.call.mockResolvedValueOnce(serverTreeResponse([]));

      await shell.init();

      expect(shell.getTree()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Data queries (local registry)
  // -------------------------------------------------------------------------

  describe("data queries", () => {
    beforeEach(async () => {
      const parent = makePanel("parent", {
        children: [makePanel("c0"), makePanel("c1"), makePanel("c2")],
      });
      rpc.call.mockResolvedValueOnce(serverTreeResponse([parent], ["parent"]));
      await shell.init();
    });

    it("getTree() returns serializable panel tree", () => {
      const tree = shell.getTree();
      expect(tree).toHaveLength(1);
      expect(tree[0]!.id).toBe("parent");
      expect(tree[0]!.children).toHaveLength(3);
    });

    it("getChildrenPaginated() returns paginated children", () => {
      const page = shell.getChildrenPaginated("parent", 0, 2);
      expect(page.total).toBe(3);
      expect(page.children).toHaveLength(2);
      expect(page.hasMore).toBe(true);
    });

    it("getChildrenPaginated() returns last page correctly", () => {
      const page = shell.getChildrenPaginated("parent", 2, 2);
      expect(page.total).toBe(3);
      expect(page.children).toHaveLength(1);
      expect(page.hasMore).toBe(false);
    });

    it("getRootPanelsPaginated() returns paginated root panels", () => {
      const page = shell.getRootPanelsPaginated(0, 10);
      expect(page.total).toBe(1);
      expect(page.panels).toHaveLength(1);
      expect(page.hasMore).toBe(false);
    });

    it("getCollapsedIds() returns collapsed state", () => {
      expect(shell.getCollapsedIds()).toEqual(["parent"]);
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle ops (server RPC + cache refresh)
  // -------------------------------------------------------------------------

  describe("lifecycle ops", () => {
    beforeEach(async () => {
      rpc.call.mockResolvedValueOnce(
        serverTreeResponse([makePanel("panel-1")])
      );
      await shell.init();
      rpc.call.mockClear();
    });

    it("archive() calls RPC and triggers resync", async () => {
      // The lifecycle op call
      rpc.call.mockResolvedValueOnce(undefined);
      // The resync loadTree call
      rpc.call.mockResolvedValueOnce(serverTreeResponse([]));

      await shell.archive("panel-1");

      expect(rpc.call).toHaveBeenCalledWith("main", "panel.archive", "panel-1");
      // resync fires asynchronously
      await vi.advanceTimersByTimeAsync(0);
      expect(rpc.call).toHaveBeenCalledWith("main", "panel.loadTree");
    });

    it("movePanel() calls RPC with request object and triggers resync", async () => {
      rpc.call.mockResolvedValueOnce(undefined);
      rpc.call.mockResolvedValueOnce(
        serverTreeResponse([makePanel("panel-1")])
      );

      await shell.movePanel("panel-1", null, 0);

      expect(rpc.call).toHaveBeenCalledWith("main", "panel.movePanel", {
        panelId: "panel-1",
        newParentId: null,
        targetPosition: 0,
      });
    });

    it("createAboutPanel() calls RPC and returns result", async () => {
      const result = { id: "about-1", title: "About" };
      rpc.call.mockResolvedValueOnce(result);
      rpc.call.mockResolvedValueOnce(serverTreeResponse([]));

      const returned = await shell.createAboutPanel("settings");

      expect(rpc.call).toHaveBeenCalledWith(
        "main",
        "panel.createAboutPanel",
        "settings"
      );
      expect(returned).toEqual(result);
    });

    it("setCollapsed() calls RPC with panelId and collapsed flag", async () => {
      rpc.call.mockResolvedValueOnce(undefined);
      rpc.call.mockResolvedValueOnce(serverTreeResponse([]));

      await shell.setCollapsed("panel-1", true);

      expect(rpc.call).toHaveBeenCalledWith(
        "main",
        "panel.setCollapsed",
        "panel-1",
        true
      );
    });

    it("expandIds() calls RPC with array of panel IDs", async () => {
      rpc.call.mockResolvedValueOnce(undefined);
      rpc.call.mockResolvedValueOnce(serverTreeResponse([]));

      await shell.expandIds(["a", "b", "c"]);

      expect(rpc.call).toHaveBeenCalledWith("main", "panel.expandIds", [
        "a",
        "b",
        "c",
      ]);
    });

    it("notifyFocused() calls RPC with panel ID", async () => {
      rpc.call.mockResolvedValueOnce(undefined);
      rpc.call.mockResolvedValueOnce(serverTreeResponse([]));

      await shell.notifyFocused("panel-1");

      expect(rpc.call).toHaveBeenCalledWith(
        "main",
        "panel.notifyFocused",
        "panel-1"
      );
    });
  });

  // -------------------------------------------------------------------------
  // resync
  // -------------------------------------------------------------------------

  describe("resync()", () => {
    it("calls panel.loadTree and updates registry via repopulate()", async () => {
      // Initial init
      rpc.call.mockResolvedValueOnce(
        serverTreeResponse([makePanel("old")])
      );
      await shell.init();
      rpc.call.mockClear();

      // Trigger resync via a lifecycle op
      rpc.call.mockResolvedValueOnce(undefined); // archive call
      rpc.call.mockResolvedValueOnce(
        serverTreeResponse([makePanel("new-panel")])
      ); // resync loadTree

      await shell.archive("old");
      await vi.advanceTimersByTimeAsync(0);

      // After resync, the tree should reflect the new data
      // Need to wait for debounced tree update
      await vi.advanceTimersByTimeAsync(20);

      const tree = shell.getTree();
      expect(tree).toHaveLength(1);
      expect(tree[0]!.id).toBe("new-panel");
    });

    it("catches errors silently during resync", async () => {
      rpc.call.mockResolvedValueOnce(
        serverTreeResponse([makePanel("panel-1")])
      );
      await shell.init();
      rpc.call.mockClear();

      // archive succeeds, but resync loadTree fails
      rpc.call.mockResolvedValueOnce(undefined); // archive call
      rpc.call.mockRejectedValueOnce(new Error("network error")); // resync fails

      // Should not throw
      await shell.archive("panel-1");
      await vi.advanceTimersByTimeAsync(0);

      // Tree should remain unchanged (stale cache)
      expect(shell.getTree()).toHaveLength(1);
      expect(shell.getTree()[0]!.id).toBe("panel-1");
    });
  });

  // -------------------------------------------------------------------------
  // onTreeUpdated callback
  // -------------------------------------------------------------------------

  describe("onTreeUpdated callback", () => {
    it("is called when tree changes via repopulate", async () => {
      rpc.call.mockResolvedValueOnce(
        serverTreeResponse([makePanel("panel-1")])
      );
      await shell.init();
      rpc.call.mockClear();

      // Trigger resync
      rpc.call.mockResolvedValueOnce(undefined); // archive
      rpc.call.mockResolvedValueOnce(
        serverTreeResponse([makePanel("updated")])
      ); // resync

      await shell.archive("panel-1");
      await vi.advanceTimersByTimeAsync(0); // let resync resolve
      await vi.advanceTimersByTimeAsync(20); // debounce fires

      expect(onTreeUpdated).toHaveBeenCalled();
      const tree = onTreeUpdated.mock.calls[onTreeUpdated.mock.calls.length - 1]![0] as Panel[];
      expect(tree[0]!.id).toBe("updated");
    });
  });

  // -------------------------------------------------------------------------
  // Periodic sync
  // -------------------------------------------------------------------------

  describe("startPeriodicSync() / stopPeriodicSync()", () => {
    it("calls resync at specified interval", async () => {
      rpc.call.mockResolvedValueOnce(
        serverTreeResponse([makePanel("panel-1")])
      );
      await shell.init();
      rpc.call.mockClear();

      // Each periodic resync call
      rpc.call.mockResolvedValue(
        serverTreeResponse([makePanel("panel-1")])
      );

      shell.startPeriodicSync(1000);

      // Advance one interval
      await vi.advanceTimersByTimeAsync(1000);
      expect(rpc.call).toHaveBeenCalledWith("main", "panel.loadTree");

      rpc.call.mockClear();

      // Advance another interval
      await vi.advanceTimersByTimeAsync(1000);
      expect(rpc.call).toHaveBeenCalledWith("main", "panel.loadTree");
    });

    it("stopPeriodicSync() stops the timer", async () => {
      rpc.call.mockResolvedValueOnce(
        serverTreeResponse([makePanel("panel-1")])
      );
      await shell.init();
      rpc.call.mockClear();

      shell.startPeriodicSync(1000);
      shell.stopPeriodicSync();

      await vi.advanceTimersByTimeAsync(2000);
      // No resync calls should have been made
      expect(rpc.call).not.toHaveBeenCalled();
    });

    it("startPeriodicSync() stops previous timer before starting new one", async () => {
      rpc.call.mockResolvedValueOnce(
        serverTreeResponse([makePanel("panel-1")])
      );
      await shell.init();
      rpc.call.mockClear();

      rpc.call.mockResolvedValue(
        serverTreeResponse([makePanel("panel-1")])
      );

      shell.startPeriodicSync(1000);
      shell.startPeriodicSync(5000);

      // At 1000ms, old timer would have fired but was cleared
      await vi.advanceTimersByTimeAsync(1000);
      expect(rpc.call).not.toHaveBeenCalled();

      // At 5000ms, new timer fires
      await vi.advanceTimersByTimeAsync(4000);
      expect(rpc.call).toHaveBeenCalledWith("main", "panel.loadTree");
    });

    it("uses default interval of 30000ms", async () => {
      rpc.call.mockResolvedValueOnce(
        serverTreeResponse([makePanel("panel-1")])
      );
      await shell.init();
      rpc.call.mockClear();

      rpc.call.mockResolvedValue(
        serverTreeResponse([makePanel("panel-1")])
      );

      shell.startPeriodicSync();

      await vi.advanceTimersByTimeAsync(29_999);
      expect(rpc.call).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(rpc.call).toHaveBeenCalledWith("main", "panel.loadTree");
    });
  });

  // -------------------------------------------------------------------------
  // dispose
  // -------------------------------------------------------------------------

  describe("dispose()", () => {
    it("stops periodic sync", async () => {
      rpc.call.mockResolvedValueOnce(
        serverTreeResponse([makePanel("panel-1")])
      );
      await shell.init();
      rpc.call.mockClear();

      shell.startPeriodicSync(1000);
      shell.dispose();

      rpc.call.mockResolvedValue(
        serverTreeResponse([makePanel("panel-1")])
      );

      await vi.advanceTimersByTimeAsync(2000);
      expect(rpc.call).not.toHaveBeenCalled();
    });

    it("is safe to call multiple times", () => {
      expect(() => {
        shell.dispose();
        shell.dispose();
      }).not.toThrow();
    });
  });
});
