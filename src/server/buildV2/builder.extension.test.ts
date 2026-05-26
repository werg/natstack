import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setUserDataPath } from "@natstack/env-paths";

import { buildUnit } from "./builder.js";
import { primaryTextArtifactContent } from "./buildStore.js";
import { discoverPackageGraph } from "./packageGraph.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

describe("buildUnit extension builds", () => {
  let root: string;
  let workspaceRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-extension-build-"));
    workspaceRoot = path.join(root, "workspace");
    setUserDataPath(path.join(root, "state"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("builds a workspace extension package as a node ESM bundle with inline sourcemaps", async () => {
    const extensionDir = path.join(workspaceRoot, "extensions", "hello");
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(
      path.join(extensionDir, "package.json"),
      JSON.stringify({
        name: "@workspace-extensions/hello",
        version: "0.1.0",
        type: "module",
        private: true,
        natstack: {
          displayName: "Hello Extension",
          entry: "index.ts",
          sourcemap: true,
          extension: { activationEvents: ["*"] },
        },
      })
    );
    fs.writeFileSync(
      path.join(extensionDir, "index.ts"),
      [
        "export async function activate() {",
        "  return {",
        "    ping() { return 'pong'; },",
        "  };",
        "}",
        "",
      ].join("\n")
    );
    git(extensionDir, ["init", "-b", "main"]);
    git(extensionDir, ["add", "."]);
    git(extensionDir, [
      "-c",
      "user.name=NatStack Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial extension",
    ]);

    const graph = discoverPackageGraph(workspaceRoot);
    const node = graph.get("@workspace-extensions/hello");
    const result = await buildUnit(node, "ev-extension-test", graph, workspaceRoot);

    expect(result.metadata).toMatchObject({
      kind: "extension",
      name: "@workspace-extensions/hello",
      sourcemap: true,
      details: {
        kind: "extension",
        runtimeDepsKey: null,
        runtimeAbi: "2",
      },
    });
    expect(fs.readFileSync(path.join(result.dir, "package.json"), "utf8")).toBe(
      '{"type":"module"}'
    );
    const bundle = primaryTextArtifactContent(result);
    expect(bundle).toContain("ping() {");
    expect(bundle).toContain("sourceMappingURL=data:application/json");
  });

  it("runs bundled CommonJS dependencies from an ESM extension bundle", async () => {
    const extensionDir = path.join(workspaceRoot, "extensions", "cjs-extension");
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(
      path.join(extensionDir, "package.json"),
      JSON.stringify({
        name: "@workspace-extensions/cjs-extension",
        version: "0.1.0",
        type: "module",
        private: true,
        natstack: {
          displayName: "CJS Extension",
          entry: "index.ts",
          sourcemap: true,
          extension: { activationEvents: ["*"] },
        },
      })
    );
    fs.writeFileSync(
      path.join(extensionDir, "cjs-dep.cjs"),
      [
        "const path = require('path');",
        "module.exports = { base: (value) => path.basename(value) };",
        "",
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(extensionDir, "index.ts"),
      [
        "import dep from './cjs-dep.cjs';",
        "export async function activate() {",
        "  return {",
        "    basename(value: string) { return dep.base(value); },",
        "  };",
        "}",
        "",
      ].join("\n")
    );
    git(extensionDir, ["init", "-b", "main"]);
    git(extensionDir, ["add", "."]);
    git(extensionDir, [
      "-c",
      "user.name=NatStack Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial extension",
    ]);

    const graph = discoverPackageGraph(workspaceRoot);
    const node = graph.get("@workspace-extensions/cjs-extension");
    const result = await buildUnit(node, "ev-extension-cjs-test", graph, workspaceRoot);
    const mod = await import(`file://${path.join(result.dir, "bundle.js")}`);
    const api = await mod.activate();

    expect(api.basename("/tmp/example.txt")).toBe("example.txt");
  });
});
