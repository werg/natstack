/**
 * Tests for PackageGraph class.
 */

import { PackageGraph, type GraphNode } from "./packageGraph.js";

/** Helper: create a minimal GraphNode for testing. */
function makeNode(
  name: string,
  internalDeps: string[] = [],
  overrides: Partial<GraphNode> = {},
): GraphNode {
  return {
    path: `/ws/packages/${name}`,
    relativePath: `packages/${name}`,
    name,
    kind: "package",
    dependencies: {},
    internalDeps,
    internalDepRefs: {},
    contentHash: "",
    manifest: {},
    ...overrides,
  };
}

describe("PackageGraph", () => {
  // -------------------------------------------------------------------------
  // Basic CRUD operations
  // -------------------------------------------------------------------------
  describe("addNode / get / tryGet / has / allNodes", () => {
    it("stores and retrieves a node by name", () => {
      const graph = new PackageGraph();
      const node = makeNode("@workspace/core");
      graph.addNode(node);

      expect(graph.has("@workspace/core")).toBe(true);
      expect(graph.get("@workspace/core")).toBe(node);
      expect(graph.tryGet("@workspace/core")).toBe(node);
    });

    it("get throws for unknown package", () => {
      const graph = new PackageGraph();
      expect(() => graph.get("@workspace/missing")).toThrowError("Unknown package: @workspace/missing");
    });

    it("tryGet returns undefined for unknown package", () => {
      const graph = new PackageGraph();
      expect(graph.tryGet("@workspace/missing")).toBeUndefined();
    });

    it("has returns false for unknown package", () => {
      const graph = new PackageGraph();
      expect(graph.has("@workspace/missing")).toBe(false);
    });

    it("allNodes returns all added nodes", () => {
      const graph = new PackageGraph();
      const a = makeNode("@workspace/a");
      const b = makeNode("@workspace/b");
      graph.addNode(a);
      graph.addNode(b);

      const all = graph.allNodes();
      expect(all).toHaveLength(2);
      expect(all).toContain(a);
      expect(all).toContain(b);
    });
  });

  // -------------------------------------------------------------------------
  // isInternal
  // -------------------------------------------------------------------------
  describe("isInternal", () => {
    it("delegates to has — returns true for added nodes, false otherwise", () => {
      const graph = new PackageGraph();
      graph.addNode(makeNode("@workspace/core"));

      expect(graph.isInternal("@workspace/core")).toBe(true);
      expect(graph.isInternal("lodash")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Topological sort
  // -------------------------------------------------------------------------
  describe("computeTopologicalOrder", () => {
    it("sorts a simple chain: A -> B -> C gives [C, B, A]", () => {
      const graph = new PackageGraph();
      const c = makeNode("C");
      const b = makeNode("B", ["C"]);
      const a = makeNode("A", ["B"]);
      graph.addNode(a);
      graph.addNode(b);
      graph.addNode(c);

      graph.computeTopologicalOrder();
      const order = graph.topologicalOrder().map((n) => n.name);

      // Leaves first: C, then B, then A
      expect(order.indexOf("C")).toBeLessThan(order.indexOf("B"));
      expect(order.indexOf("B")).toBeLessThan(order.indexOf("A"));
    });

    it("sorts a diamond: A -> B, A -> C, B -> D, C -> D", () => {
      const graph = new PackageGraph();
      const d = makeNode("D");
      const b = makeNode("B", ["D"]);
      const c = makeNode("C", ["D"]);
      const a = makeNode("A", ["B", "C"]);
      graph.addNode(a);
      graph.addNode(b);
      graph.addNode(c);
      graph.addNode(d);

      graph.computeTopologicalOrder();
      const order = graph.topologicalOrder().map((n) => n.name);

      // D must come before B and C; B and C before A
      expect(order.indexOf("D")).toBeLessThan(order.indexOf("B"));
      expect(order.indexOf("D")).toBeLessThan(order.indexOf("C"));
      expect(order.indexOf("B")).toBeLessThan(order.indexOf("A"));
      expect(order.indexOf("C")).toBeLessThan(order.indexOf("A"));
    });

    it("handles independent nodes (no edges)", () => {
      const graph = new PackageGraph();
      graph.addNode(makeNode("X"));
      graph.addNode(makeNode("Y"));
      graph.addNode(makeNode("Z"));

      graph.computeTopologicalOrder();
      const order = graph.topologicalOrder();
      expect(order).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Cycle detection
  // -------------------------------------------------------------------------
  describe("cycle detection", () => {
    it("throws an error with 'Dependency cycle' for a direct cycle", () => {
      const graph = new PackageGraph();
      graph.addNode(makeNode("A", ["B"]));
      graph.addNode(makeNode("B", ["A"]));

      expect(() => graph.computeTopologicalOrder()).toThrowError(/Dependency cycle/);
    });

    it("throws for an indirect cycle A -> B -> C -> A", () => {
      const graph = new PackageGraph();
      graph.addNode(makeNode("A", ["B"]));
      graph.addNode(makeNode("B", ["C"]));
      graph.addNode(makeNode("C", ["A"]));

      expect(() => graph.computeTopologicalOrder()).toThrowError(/Dependency cycle/);
    });
  });

  // -------------------------------------------------------------------------
  // getReverseDeps
  // -------------------------------------------------------------------------
  describe("getReverseDeps", () => {
    it("returns all packages that transitively depend on a given node", () => {
      const graph = new PackageGraph();
      graph.addNode(makeNode("D"));
      graph.addNode(makeNode("C", ["D"]));
      graph.addNode(makeNode("B", ["D"]));
      graph.addNode(makeNode("A", ["B"]));

      // D is depended upon by B and C directly, and A transitively (A -> B -> D)
      const reverseDeps = graph.getReverseDeps("D");
      expect(reverseDeps).toContain("B");
      expect(reverseDeps).toContain("C");
      expect(reverseDeps).toContain("A");
    });

    it("returns empty set for a root node with no dependents", () => {
      const graph = new PackageGraph();
      graph.addNode(makeNode("A", ["B"]));
      graph.addNode(makeNode("B"));

      const reverseDeps = graph.getReverseDeps("A");
      expect(reverseDeps.size).toBe(0);
    });
  });
});
