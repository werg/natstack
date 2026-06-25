import { describe, expect, it, vi } from "vitest";
import { createBuildServiceClient, createEvalImportLoader } from "./evalImportLoader.js";

describe("createEvalImportLoader", () => {
  it("loads npm refs through getBuildNpm", async () => {
    const call = vi.fn(async () => ({ bundle: "npm-bundle" }));
    const loadImport = createEvalImportLoader(createBuildServiceClient(call), "worker");

    await expect(loadImport("left-pad", "npm:1.3.0", ["react"])).resolves.toBe("npm-bundle");

    expect(call).toHaveBeenCalledWith("build", "getBuildNpm", ["left-pad", "1.3.0", ["react"]]);
  });

  it("accepts package-qualified npm refs when the package matches the import key", async () => {
    const call = vi.fn(async () => ({ bundle: "npm-bundle" }));
    const loadImport = createEvalImportLoader(createBuildServiceClient(call), "worker");

    await expect(loadImport("left-pad", "npm:left-pad@1.3.0", [])).resolves.toBe("npm-bundle");
    await expect(loadImport("@scope/pkg", "npm:@scope/pkg@2.0.0", [])).resolves.toBe("npm-bundle");

    expect(call).toHaveBeenNthCalledWith(1, "build", "getBuildNpm", ["left-pad", "1.3.0", []]);
    expect(call).toHaveBeenNthCalledWith(2, "build", "getBuildNpm", ["@scope/pkg", "2.0.0", []]);
  });

  it("rejects package-qualified npm refs when the package does not match the import key", async () => {
    const call = vi.fn(async () => ({ bundle: "npm-bundle" }));
    const loadImport = createEvalImportLoader(createBuildServiceClient(call), "worker");

    await expect(loadImport("left-pad", "npm:lodash@4.17.21", [])).rejects.toThrow(
      'npm import "left-pad" points at "lodash"'
    );
    expect(call).not.toHaveBeenCalled();
  });

  it("loads workspace refs as library builds tagged with the host target", async () => {
    const call = vi.fn(async () => ({ bundle: "workspace-bundle" }));
    const loadImport = createEvalImportLoader(createBuildServiceClient(call), "worker");

    await expect(loadImport("@workspace/pkg", "abc123", ["react"])).resolves.toBe("workspace-bundle");

    expect(call).toHaveBeenCalledWith("build", "getBuild", [
      "@workspace/pkg",
      "abc123",
      { library: true, externals: ["react"], libraryTarget: "worker" },
    ]);
  });

  it("rejects full builds for library imports", async () => {
    const call = vi.fn(async () => ({ artifacts: [] }));
    const loadImport = createEvalImportLoader(createBuildServiceClient(call), "worker");

    await expect(loadImport("@workspace/pkg", undefined, [])).rejects.toThrow(
      "Build service returned a full build for library import: @workspace/pkg"
    );
  });
});
