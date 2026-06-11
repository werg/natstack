import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setUserDataPath } from "@natstack/env-paths";

import { buildUnit, initBuilder } from "./builder.js";
import { discoverPackageGraph } from "./packageGraph.js";

const REPO_ROOT = process.cwd();
const REAL_SHIM = path.join(REPO_ROOT, "workspace", "packages", "terminal-shim");

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
function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

describe("buildUnit terminal worker builds", () => {
  let root: string;
  let workspaceRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-terminal-build-"));
    workspaceRoot = path.join(root, "workspace");
    setUserDataPath(path.join(root, "state"));
    // Resolve external npm deps (yoga-layout) from the repo's real node_modules.
    initBuilder([path.join(REPO_ROOT, "node_modules")]);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("aliases yoga-layout to the shim and emits a yoga.wasm artifact", async () => {
    // Copy the real @workspace/terminal-shim source into the temp workspace.
    const shimDir = path.join(workspaceRoot, "packages", "terminal-shim");
    copyDir(REAL_SHIM, shimDir);
    commit(shimDir, "terminal-shim");

    // A minimal terminal worker that imports yoga-layout (Ink's hard dep). This
    // exercises the terminal build path without bundling all of Ink/React.
    const workerDir = path.join(workspaceRoot, "workers", "terminal-min");
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(
      path.join(workerDir, "package.json"),
      JSON.stringify({
        name: "@workspace-workers/terminal-min",
        version: "0.1.0",
        private: true,
        type: "module",
        natstack: {
          entry: "worker.ts",
          durable: { classes: [{ className: "TerminalMin" }] },
          terminal: { renderer: "ink" },
        },
        dependencies: { "@workspace/terminal-shim": "workspace:*", "yoga-layout": "^3.2.1" },
      })
    );
    fs.writeFileSync(
      path.join(workerDir, "worker.ts"),
      [
        `import Yoga from "yoga-layout";`,
        `export class TerminalMin {`,
        `  async fetch() {`,
        `    const n = Yoga.Node.create();`,
        `    n.setWidth(10); n.calculateLayout(10, 10, Yoga.DIRECTION_LTR);`,
        `    const w = n.getComputedLayout().width; n.free();`,
        `    return new Response(JSON.stringify({ width: w }));`,
        `  }`,
        `}`,
      ].join("\n")
    );
    commit(workerDir, "terminal-min worker");

    const graph = discoverPackageGraph(workspaceRoot);
    const result = await buildUnit(
      graph.get("@workspace-workers/terminal-min"),
      "ev-terminal-min",
      graph,
      workspaceRoot
    );

    // Multi-artifact: primary bundle.js + the extracted yoga.wasm module.
    const wasm = result.artifacts.find((a) => a.role === "wasm");
    expect(wasm, "yoga.wasm artifact should be emitted").toBeDefined();
    expect(wasm?.path).toBe("yoga.wasm");
    expect(wasm?.encoding).toBe("base64");
    // Real yoga wasm is ~70KB; sanity-check it's a substantial binary.
    expect(Buffer.from(wasm!.content, "base64").byteLength).toBeGreaterThan(10_000);
    // The wasm starts with the WASM magic header (\0asm).
    expect(Buffer.from(wasm!.content, "base64").subarray(0, 4)).toEqual(
      Buffer.from([0x00, 0x61, 0x73, 0x6d])
    );

    // The bundle imports the external "yoga.wasm" (workerd provides the module).
    const bundle = result.artifacts.find((a) => a.role === "primary")?.content ?? "";
    expect(bundle).toContain("yoga.wasm");
  }, 60_000);

  it("prefers workspace package source over stale build-output exports", async () => {
    const pkgDir = path.join(workspaceRoot, "packages", "stale-dist-lib");
    fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@workspace/stale-dist-lib",
        version: "0.1.0",
        type: "module",
        exports: {
          ".": "./dist/index.js",
        },
      })
    );
    fs.writeFileSync(
      path.join(pkgDir, "src", "index.ts"),
      'export const freshWorkerSymbol = "fresh-source-export";\n'
    );
    fs.writeFileSync(
      path.join(pkgDir, "dist", "index.js"),
      'export const staleWorkerSymbol = "stale-dist-export";\n'
    );
    commit(pkgDir, "stale dist lib");

    const workerDir = path.join(workspaceRoot, "workers", "stale-dist-worker");
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(
      path.join(workerDir, "package.json"),
      JSON.stringify({
        name: "@workspace-workers/stale-dist-worker",
        version: "0.1.0",
        private: true,
        type: "module",
        natstack: {
          entry: "worker.ts",
          durable: { classes: [{ className: "StaleDistWorker" }] },
        },
        dependencies: { "@workspace/stale-dist-lib": "workspace:*" },
      })
    );
    fs.writeFileSync(
      path.join(workerDir, "worker.ts"),
      [
        'import { freshWorkerSymbol } from "@workspace/stale-dist-lib";',
        "export class StaleDistWorker {",
        "  async fetch() {",
        "    return new Response(freshWorkerSymbol);",
        "  }",
        "}",
      ].join("\n")
    );
    commit(workerDir, "stale dist worker");

    const graph = discoverPackageGraph(workspaceRoot);
    const result = await buildUnit(
      graph.get("@workspace-workers/stale-dist-worker"),
      "ev-stale-dist-worker",
      graph,
      workspaceRoot
    );

    const bundle = result.artifacts.find((a) => a.role === "primary")?.content ?? "";
    expect(bundle).toContain("fresh-source-export");
    expect(bundle).not.toContain("stale-dist-export");
  });
});
