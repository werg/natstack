/**
 * Tests for collectTransitiveExternalDeps from externalDeps.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { testExtDepsRoot } = vi.hoisted(() => ({
  testExtDepsRoot: `/tmp/test-extdeps-${process.pid}`,
}));

vi.mock("@natstack/env-paths", () => ({
  getUserDataPath: vi.fn().mockReturnValue("/tmp/test-extdeps"),
  getCentralDataPath: vi.fn().mockReturnValue(testExtDepsRoot),
}));

vi.mock("@natstack/shared/npmInstaller", () => ({
  runNpmInstall: vi.fn((cwd: string) => {
    fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
  }),
}));

import { PackageGraph, type GraphNode } from "./packageGraph.js";
import {
  collectTransitiveDependencyOverrides,
  collectTransitiveExternalDeps,
  ensureExternalDeps,
} from "./externalDeps.js";
import { runNpmInstall } from "@natstack/shared/npmInstaller";

/** Helper: create a minimal GraphNode. */
function makeNode(
  name: string,
  dependencies: Record<string, string> = {},
  internalDeps: string[] = []
): GraphNode {
  return {
    path: `/ws/packages/${name}`,
    relativePath: `packages/${name}`,
    name,
    kind: "package",
    dependencies,
    dependencyOverrides: {},
    internalDeps,
    internalDepRefs: {},
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
      ["@workspace/inner"]
    );
    const outer = makeNode(
      "@workspace/outer",
      { "@workspace/middle": "workspace:*", react: "^18.0.0" },
      ["@workspace/middle"]
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

  it("collects external runtime deps from @natstack internal packages", () => {
    const graph = new PackageGraph();
    const shared = makeNode("@natstack/shared", {
      "@silvia-odwyer/photon-node": "^0.3.4",
    });
    const extension = makeNode(
      "@workspace-extensions/image-service",
      { "@natstack/shared": "workspace:*" },
      ["@natstack/shared"]
    );
    graph.addNode(shared);
    graph.addNode(extension);

    const deps = collectTransitiveExternalDeps(extension, graph);
    expect(deps).toEqual({
      "@silvia-odwyer/photon-node": "^0.3.4",
    });
  });

  it("walks repo-root workspace package manifests that are outside the workspace graph", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-extdeps-"));
    try {
      const workspaceRoot = path.join(root, "workspace");
      const sharedDir = path.join(root, "packages", "shared");
      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.mkdirSync(sharedDir, { recursive: true });
      fs.writeFileSync(
        path.join(sharedDir, "package.json"),
        JSON.stringify({
          name: "@natstack/shared",
          dependencies: {
            "@silvia-odwyer/photon-node": "^0.3.4",
          },
        })
      );

      const graph = new PackageGraph();
      const extension = makeNode("@workspace-extensions/image-service", {
        "@natstack/shared": "workspace:*",
      });
      graph.addNode(extension);

      const deps = collectTransitiveExternalDeps(extension, graph, workspaceRoot);
      expect(deps).toEqual({
        "@silvia-odwyer/photon-node": "^0.3.4",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("walks scoped workspace package manifests resolved from app node_modules", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-extdeps-"));
    try {
      const workspaceRoot = path.join(root, "fresh-dev-workspace", "source");
      const appNodeModules = path.join(root, "app", "node_modules");
      const sharedDir = path.join(appNodeModules, "@natstack", "shared");
      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.mkdirSync(sharedDir, { recursive: true });
      fs.writeFileSync(
        path.join(sharedDir, "package.json"),
        JSON.stringify({
          name: "@natstack/shared",
          dependencies: {
            "@silvia-odwyer/photon-node": "^0.3.4",
          },
        })
      );

      const graph = new PackageGraph();
      const extension = makeNode("@workspace-extensions/image-service", {
        "@natstack/shared": "workspace:*",
      });
      graph.addNode(extension);

      const deps = collectTransitiveExternalDeps(extension, graph, workspaceRoot, [appNodeModules]);
      expect(deps).toEqual({
        "@silvia-odwyer/photon-node": "^0.3.4",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not install pnpm-patched app dependencies into npm external cache", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-extdeps-"));
    const previousAppRoot = process.env["NATSTACK_APP_ROOT"];
    try {
      process.env["NATSTACK_APP_ROOT"] = root;
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          pnpm: {
            patchedDependencies: {
              "@earendil-works/pi-agent-core@0.78.0": "patches/pi-agent-core.patch",
            },
          },
        })
      );

      const graph = new PackageGraph();
      const adapter = makeNode("@workspace/pi-adapter", {
        "@earendil-works/pi-agent-core": "^0.78.0",
        zod: "^3.25.0",
      });
      graph.addNode(adapter);

      const deps = collectTransitiveExternalDeps(adapter, graph);
      expect(deps).toEqual({ zod: "^3.25.0" });
    } finally {
      if (previousAppRoot === undefined) {
        delete process.env["NATSTACK_APP_ROOT"];
      } else {
        process.env["NATSTACK_APP_ROOT"] = previousAppRoot;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
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
      ["@workspace/a", "@workspace/b"]
    );
    graph.addNode(a);
    graph.addNode(b);
    graph.addNode(root);

    const deps = collectTransitiveExternalDeps(root, graph);
    // ^4.18.0 is the highest
    expect(deps["lodash"]).toBe("^4.18.0");
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
      ["@workspace/a", "@workspace/b"]
    );
    graph.addNode(a);
    graph.addNode(b);
    graph.addNode(root);

    const deps = collectTransitiveExternalDeps(root, graph);
    expect(deps["lodash"]).toBe("^4.17.21");
  });

  it("does not visit the same internal node twice (cycle-safe)", () => {
    const graph = new PackageGraph();
    // Create a diamond: root -> a, root -> b, a -> shared, b -> shared
    const shared = makeNode("@workspace/shared", { zod: "^3.0.0" });
    const a = makeNode("@workspace/a", { "@workspace/shared": "workspace:*", react: "^18.0.0" }, [
      "@workspace/shared",
    ]);
    const b = makeNode("@workspace/b", { "@workspace/shared": "workspace:*", axios: "^1.0.0" }, [
      "@workspace/shared",
    ]);
    const root = makeNode(
      "@workspace/root",
      { "@workspace/a": "workspace:*", "@workspace/b": "workspace:*" },
      ["@workspace/a", "@workspace/b"]
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

  it("collects dependency overrides from transitive userland packages", () => {
    const graph = new PackageGraph();
    const shared = makeNode("@workspace/shared", { "left-pad": "^1.3.0" });
    shared.dependencyOverrides = { "left-pad": "1.3.0" };
    const panel = makeNode("@workspace/panel", { "@workspace/shared": "workspace:*" }, [
      "@workspace/shared",
    ]);
    panel.dependencyOverrides = { react: "19.0.0" };

    graph.addNode(shared);
    graph.addNode(panel);

    const overrides = collectTransitiveDependencyOverrides(panel, graph);

    expect(overrides).toEqual({
      react: "19.0.0",
      "left-pad": "1.3.0",
    });
  });
});

describe("ensureExternalDeps", () => {
  it("writes npm overrides into generated external-deps package.json", async () => {
    vi.mocked(runNpmInstall).mockClear();
    fs.rmSync(testExtDepsRoot, { recursive: true, force: true });

    const nodeModulesDir = await ensureExternalDeps(
      { "@earendil-works/pi-ai": "0.74.1", react: "^19.0.0" },
      { "@anthropic-ai/sdk": "0.97.1", react: "19.0.0" }
    );

    expect(runNpmInstall).toHaveBeenCalledTimes(1);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(path.dirname(nodeModulesDir), "package.json"), "utf-8")
    ) as {
      dependencies: Record<string, string>;
      overrides?: Record<string, string>;
    };
    expect(pkg.dependencies["react"]).toBe("19.0.0");
    expect(pkg.overrides).toMatchObject({
      "@anthropic-ai/sdk": "0.97.1",
    });
    expect(pkg.overrides).not.toHaveProperty("react");
  });

  it("reinstalls a cache entry when the ready sentinel exists but node_modules is missing", async () => {
    fs.rmSync(testExtDepsRoot, { recursive: true, force: true });
    const first = await ensureExternalDeps({ leftpad: "1.0.0" });
    expect(fs.existsSync(first)).toBe(true);

    const cacheDir = path.dirname(first);
    fs.rmSync(first, { recursive: true, force: true });
    expect(fs.existsSync(path.join(cacheDir, ".ready"))).toBe(true);

    const repaired = await ensureExternalDeps({ leftpad: "1.0.0" });
    expect(repaired).toBe(first);
    expect(fs.existsSync(repaired)).toBe(true);
  });
});
