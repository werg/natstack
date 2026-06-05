import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setUserDataPath } from "@natstack/env-paths";
import { PackageGraph, type GraphNode } from "./packageGraph.js";
import {
  buildUnit,
  createPlaywrightAwareLibraryBuildOptions,
  createPlaywrightCoreBrowserBuildOptions,
  initBuilder,
} from "./builder.js";
import { discoverPackageGraph } from "./packageGraph.js";

const REPO_ROOT = process.cwd();

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

function commit(dir: string, msg: string): void {
  git(dir, ["init", "-b", "main"]);
  git(dir, ["add", "."]);
  git(dir, [
    "-c",
    "user.name=NatStack Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    msg,
  ]);
}

function copyPackage(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name.endsWith(".tsbuildinfo")
    ) {
      continue;
    }
    const source = path.join(src, entry.name);
    const target = path.join(dst, entry.name);
    if (entry.isDirectory()) copyPackage(source, target);
    else fs.copyFileSync(source, target);
  }
}

describe("Playwright core library build", () => {
  it("keeps the lightweight CDP client independent from Playwright core", async () => {
    const workspaceRoot = path.resolve("workspace");
    const graph = discoverPackageGraph(workspaceRoot);
    const client = graph.get("@workspace/cdp-client");

    expect(client.dependencies).not.toHaveProperty("@workspace/playwright-core");
    expect(client.internalDeps).not.toContain("@workspace/playwright-core");
  });

  it("builds the lightweight CDP client without bundling Playwright core", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-cdp-client-"));
    try {
      const outfile = path.join(tempDir, "bundle.js");
      await esbuild.build({
        entryPoints: [path.resolve("workspace/packages/cdp-client/src/index.ts")],
        outfile,
        bundle: true,
        format: "esm",
        platform: "browser",
        conditions: ["natstack-panel", "browser", "import", "default"],
        logLevel: "silent",
      });

      const bundle = fs.readFileSync(outfile, "utf-8");
      expect(bundle).not.toContain("@workspace/playwright-core");
      expect(bundle).not.toContain("playwright-core");
      expect(bundle).toContain("CdpConnection");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("builds a loadable CJS browser bundle from source", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-playwright-core-"));
    try {
      const outfile = path.join(tempDir, "bundle.js");
      await esbuild.build(
        createPlaywrightCoreBrowserBuildOptions(
          path.resolve("workspace/packages/playwright-core"),
          outfile,
          { logLevel: "silent" }
        )
      );

      const bundle = fs.readFileSync(outfile, "utf-8");
      const exports: Record<string, unknown> = {};
      const module = { exports };
      const requireFn = (id: string) => {
        throw new Error(`Unexpected external require: ${id}`);
      };

      new Function("require", "exports", "module", bundle)(requireFn, exports, module);

      expect(
        typeof (module.exports as { BrowserImpl?: { connect?: unknown } }).BrowserImpl?.connect
      ).toBe("function");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("builds a loadable automation package bundle with a static Playwright import", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-playwright-automation-"));
    try {
      const workspaceRoot = path.resolve(".");
      const graph = new PackageGraph();
      graph.addNode({
        path: path.join(workspaceRoot, "workspace/packages/playwright-core"),
        relativePath: "workspace/packages/playwright-core",
        name: "@workspace/playwright-core",
        kind: "package",
        dependencies: {},
        dependencyOverrides: {},
        internalDeps: [],
        internalDepRefs: {},
        manifest: {},
      } satisfies GraphNode);
      graph.addNode({
        path: path.join(workspaceRoot, "workspace/packages/playwright-automation"),
        relativePath: "workspace/packages/playwright-automation",
        name: "@workspace/playwright-automation",
        kind: "package",
        dependencies: { "@workspace/playwright-core": "workspace:*" },
        dependencyOverrides: {},
        internalDeps: ["@workspace/playwright-core"],
        internalDepRefs: {},
        manifest: {},
      } satisfies GraphNode);

      const outfile = path.join(tempDir, "bundle.js");
      await esbuild.build(
        createPlaywrightAwareLibraryBuildOptions(
          path.join(workspaceRoot, "workspace/packages/playwright-automation/src/index.ts"),
          outfile,
          path.join(workspaceRoot, "workspace/packages/playwright-core"),
          graph,
          workspaceRoot,
          workspaceRoot,
          { logLevel: "silent" }
        )
      );

      const bundle = fs.readFileSync(outfile, "utf-8");
      const exports: Record<string, unknown> = {};
      const module = { exports };
      const requireFn = (id: string) => {
        throw new Error(`Unexpected external require: ${id}`);
      };

      new Function("require", "exports", "module", bundle)(requireFn, exports, module);

      expect(typeof (module.exports as { playwrightPage?: unknown }).playwrightPage).toBe(
        "function"
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("builds a loadable userland bundle that imports the automation package", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-playwright-userland-"));
    try {
      const workspaceRoot = path.resolve(".");
      const graph = new PackageGraph();
      graph.addNode({
        path: path.join(workspaceRoot, "workspace/packages/playwright-protocol"),
        relativePath: "workspace/packages/playwright-protocol",
        name: "@workspace/playwright-protocol",
        kind: "package",
        dependencies: {},
        dependencyOverrides: {},
        internalDeps: [],
        internalDepRefs: {},
        manifest: {},
      } satisfies GraphNode);
      graph.addNode({
        path: path.join(workspaceRoot, "workspace/packages/playwright-core"),
        relativePath: "workspace/packages/playwright-core",
        name: "@workspace/playwright-core",
        kind: "package",
        dependencies: {},
        dependencyOverrides: {},
        internalDeps: ["@workspace/playwright-protocol"],
        internalDepRefs: {},
        manifest: {},
      } satisfies GraphNode);
      graph.addNode({
        path: path.join(workspaceRoot, "workspace/packages/playwright-automation"),
        relativePath: "workspace/packages/playwright-automation",
        name: "@workspace/playwright-automation",
        kind: "package",
        dependencies: { "@workspace/playwright-core": "workspace:*" },
        dependencyOverrides: {},
        internalDeps: ["@workspace/playwright-core"],
        internalDepRefs: {},
        manifest: {},
      } satisfies GraphNode);

      const entryFile = path.join(tempDir, "entry.ts");
      fs.writeFileSync(
        entryFile,
        `export { playwrightPage } from "@workspace/playwright-automation";\n`
      );
      const outfile = path.join(tempDir, "bundle.js");
      await esbuild.build(
        createPlaywrightAwareLibraryBuildOptions(
          entryFile,
          outfile,
          path.join(workspaceRoot, "workspace/packages/playwright-core"),
          graph,
          workspaceRoot,
          workspaceRoot,
          { logLevel: "silent" }
        )
      );

      const bundle = fs.readFileSync(outfile, "utf-8");
      const exports: Record<string, unknown> = {};
      const module = { exports };
      const requireFn = (id: string) => {
        throw new Error(`Unexpected external require: ${id}`);
      };

      new Function("require", "exports", "module", bundle)(requireFn, exports, module);

      expect(typeof (module.exports as { playwrightPage?: unknown }).playwrightPage).toBe(
        "function"
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("builds and evaluates a worker bundle that imports the automation package", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-playwright-worker-"));
    try {
      const workspaceRoot = path.join(root, "workspace");
      setUserDataPath(path.join(root, "state"));
      initBuilder([path.join(REPO_ROOT, "node_modules")]);

      for (const name of ["playwright-protocol", "playwright-core", "playwright-automation"]) {
        const packageDir = path.join(workspaceRoot, "packages", name);
        copyPackage(path.join(REPO_ROOT, "workspace/packages", name), packageDir);
        commit(packageDir, name);
      }

      const workerDir = path.join(workspaceRoot, "workers", "playwright-import");
      fs.mkdirSync(workerDir, { recursive: true });
      fs.writeFileSync(
        path.join(workerDir, "package.json"),
        JSON.stringify({
          name: "@workspace-workers/playwright-import",
          version: "0.1.0",
          private: true,
          type: "module",
          natstack: { entry: "worker.ts" },
          dependencies: { "@workspace/playwright-automation": "workspace:*" },
        })
      );
      fs.writeFileSync(
        path.join(workerDir, "worker.ts"),
        [
          `import { playwrightPage } from "@workspace/playwright-automation";`,
          `export default {`,
          `  async fetch() {`,
          `    return new Response(typeof playwrightPage);`,
          `  }`,
          `};`,
        ].join("\n")
      );
      commit(workerDir, "worker imports playwright automation");

      const graph = discoverPackageGraph(workspaceRoot);
      const result = await buildUnit(
        graph.get("@workspace-workers/playwright-import"),
        "ev-playwright-worker",
        graph,
        workspaceRoot
      );

      const bundle = result.artifacts.find((artifact) => artifact.role === "primary")?.content;
      expect(bundle).toBeTruthy();
      expect(bundle).not.toContain("require(");

      const bundlePath = path.join(root, "worker-bundle.mjs");
      fs.writeFileSync(bundlePath, bundle!);
      const mod = (await import(pathToFileURL(bundlePath).href)) as {
        default: { fetch(): Promise<Response> };
      };
      await expect(mod.default.fetch().then((response) => response.text())).resolves.toBe(
        "function"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
