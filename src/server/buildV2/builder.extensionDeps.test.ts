import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { analyzeExtensionDependencies } from "./builder.js";

function writePackage(
  nodeModules: string,
  name: string,
  pkg: Record<string, unknown>,
  files: Record<string, string> = {}
): void {
  const packageDir = path.join(nodeModules, ...name.split("/"));
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", ...pkg })
  );
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(packageDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
}

describe("extension dependency diagnostics", () => {
  let root: string;
  let nodeModules: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-extension-deps-"));
    nodeModules = path.join(root, "node_modules");
    fs.mkdirSync(nodeModules, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("bundles plain JavaScript dependencies in auto mode", () => {
    writePackage(
      nodeModules,
      "plain-cjs",
      { main: "index.js" },
      { "index.js": "module.exports = {};" }
    );
    writePackage(
      nodeModules,
      "plain-esm",
      { type: "module" },
      { "index.js": "export default {};" }
    );

    const diagnostics = analyzeExtensionDependencies(
      { "plain-cjs": "1.0.0", "plain-esm": "1.0.0" },
      [nodeModules],
      "auto"
    );

    expect(diagnostics.runtimeExternalDeps).toEqual({});
    expect(diagnostics.bundledDeps).toEqual({ "plain-cjs": "1.0.0", "plain-esm": "1.0.0" });
    expect(diagnostics.classifiedDeps.map((dep) => [dep.name, dep.format, dep.external])).toEqual([
      ["plain-cjs", "cjs", false],
      ["plain-esm", "esm", false],
    ]);
  });

  it("externalizes native and WASM dependencies in auto mode", () => {
    writePackage(nodeModules, "native-dep", { main: "index.js" }, { "build/addon.node": "" });
    writePackage(nodeModules, "wasm-dep", { main: "index.js" }, { "pkg/module.wasm": "" });

    const diagnostics = analyzeExtensionDependencies(
      { "native-dep": "1.0.0", "wasm-dep": "1.0.0" },
      [nodeModules],
      "auto"
    );

    expect(diagnostics.runtimeExternalDeps).toEqual({
      "native-dep": "1.0.0",
      "wasm-dep": "1.0.0",
    });
    expect(diagnostics.classifiedDeps.find((dep) => dep.name === "native-dep")?.reasons).toContain(
      "native"
    );
    expect(diagnostics.classifiedDeps.find((dep) => dep.name === "wasm-dep")?.reasons).toContain(
      "wasm-asset"
    );
  });

  it("honors explicit bundle and external modes", () => {
    writePackage(nodeModules, "native-dep", { main: "index.js" }, { "build/addon.node": "" });

    expect(
      analyzeExtensionDependencies({ "native-dep": "1.0.0" }, [nodeModules], "bundle")
        .runtimeExternalDeps
    ).toEqual({});
    expect(
      analyzeExtensionDependencies({ "native-dep": "1.0.0" }, [nodeModules], "external")
        .runtimeExternalDeps
    ).toEqual({ "native-dep": "1.0.0" });
  });
});
