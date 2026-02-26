/**
 * Tests for collectTransitiveExternalDeps from externalDeps.ts.
 */

vi.mock("../../main/envPaths.js", () => ({
  getUserDataPath: vi.fn().mockReturnValue("/tmp/test-extdeps"),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { PackageGraph, type GraphNode } from "./packageGraph.js";
import { collectTransitiveExternalDeps } from "./externalDeps.js";

/** Helper: create a minimal GraphNode. */
function makeNode(
  name: string,
  dependencies: Record<string, string> = {},
  internalDeps: string[] = [],
): GraphNode {
  return {
    path: `/ws/packages/${name}`,
    relativePath: `packages/${name}`,
    name,
    kind: "package",
    dependencies,
    internalDeps,
    internalDepRefs: {},
    contentHash: "",
    manifest: {},
  };
}

describe("collectTransitiveExternalDeps", () => {
  it("collects direct external deps from a leaf node", () => {
    const graph = new PackageGraph();
    const leaf = makeNode("@workspace/leaf", {
      react: "^18.2.0",
      lodash: "^4.17.21",
    });
    graph.addNode(leaf);

    const deps = collectTransitiveExternalDeps(leaf, graph);
    expect(deps).toEqual({
      react: "^18.2.0",
      lodash: "^4.17.21",
    });
  });

  it("walks internal deps transitively and collects their externals", () => {
    const graph = new PackageGraph();
    const inner = makeNode("@workspace/inner", { zod: "^3.0.0" });
    const middle = makeNode(
      "@workspace/middle",
      { "@workspace/inner": "workspace:*", axios: "^1.0.0" },
      ["@workspace/inner"],
    );
    const outer = makeNode(
      "@workspace/outer",
      { "@workspace/middle": "workspace:*", react: "^18.0.0" },
      ["@workspace/middle"],
    );
    graph.addNode(inner);
    graph.addNode(middle);
    graph.addNode(outer);

    const deps = collectTransitiveExternalDeps(outer, graph);
    expect(deps).toHaveProperty("react", "^18.0.0");
    expect(deps).toHaveProperty("axios", "^1.0.0");
    expect(deps).toHaveProperty("zod", "^3.0.0");
    // Internal workspace deps should NOT appear
    expect(deps).not.toHaveProperty("@workspace/inner");
    expect(deps).not.toHaveProperty("@workspace/middle");
  });

  it("skips workspace:* deps (they are internal)", () => {
    const graph = new PackageGraph();
    const a = makeNode("@workspace/a", {
      react: "^18.0.0",
      "@workspace/b": "workspace:*",
    });
    // @workspace/b is in dependencies but not in the graph — should be skipped
    // because version starts with "workspace:"
    graph.addNode(a);

    const deps = collectTransitiveExternalDeps(a, graph);
    expect(deps).toEqual({ react: "^18.0.0" });
  });

  it("takes higher version on conflict", () => {
    const graph = new PackageGraph();
    const a = makeNode("@workspace/a", { lodash: "^4.17.0" });
    const b = makeNode("@workspace/b", { lodash: "^4.18.0" });
    const root = makeNode(
      "@workspace/root",
      {
        "@workspace/a": "workspace:*",
        "@workspace/b": "workspace:*",
        lodash: "^4.16.0",
      },
      ["@workspace/a", "@workspace/b"],
    );
    graph.addNode(a);
    graph.addNode(b);
    graph.addNode(root);

    const deps = collectTransitiveExternalDeps(root, graph);
    // ^4.18.0 is the highest
    expect(deps.lodash).toBe("^4.18.0");
  });

  it("treats wildcards * as lowest priority in version comparison", () => {
    const graph = new PackageGraph();
    const a = makeNode("@workspace/a", { lodash: "*" });
    const b = makeNode("@workspace/b", { lodash: "^4.17.21" });
    const root = makeNode(
      "@workspace/root",
      {
        "@workspace/a": "workspace:*",
        "@workspace/b": "workspace:*",
      },
      ["@workspace/a", "@workspace/b"],
    );
    graph.addNode(a);
    graph.addNode(b);
    graph.addNode(root);

    const deps = collectTransitiveExternalDeps(root, graph);
    expect(deps.lodash).toBe("^4.17.21");
  });

  it("does not visit the same internal node twice (cycle-safe)", () => {
    const graph = new PackageGraph();
    // Create a diamond: root -> a, root -> b, a -> shared, b -> shared
    const shared = makeNode("@workspace/shared", { zod: "^3.0.0" });
    const a = makeNode(
      "@workspace/a",
      { "@workspace/shared": "workspace:*", react: "^18.0.0" },
      ["@workspace/shared"],
    );
    const b = makeNode(
      "@workspace/b",
      { "@workspace/shared": "workspace:*", axios: "^1.0.0" },
      ["@workspace/shared"],
    );
    const root = makeNode(
      "@workspace/root",
      { "@workspace/a": "workspace:*", "@workspace/b": "workspace:*" },
      ["@workspace/a", "@workspace/b"],
    );
    graph.addNode(shared);
    graph.addNode(a);
    graph.addNode(b);
    graph.addNode(root);

    // Should work without infinite recursion and collect all externals
    const deps = collectTransitiveExternalDeps(root, graph);
    expect(deps).toHaveProperty("zod", "^3.0.0");
    expect(deps).toHaveProperty("react", "^18.0.0");
    expect(deps).toHaveProperty("axios", "^1.0.0");
  });
});
