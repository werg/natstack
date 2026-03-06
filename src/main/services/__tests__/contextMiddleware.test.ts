/**
 * Tests for context-scoping middleware.
 */

import { resolveContextScope, type ContextScope } from "../contextMiddleware.js";
import * as path from "path";

// Mock ContextFolderManager
function createMockContextFolderManager(contextRoot: string) {
  return {
    ensureContextFolder: async (_contextId: string) => contextRoot,
  } as any;
}

describe("resolveContextScope", () => {
  it("returns a ContextScope with correct contextRoot", async () => {
    const root = "/tmp/test-context";
    const manager = createMockContextFolderManager(root);

    const scope = await resolveContextScope(manager, "test-ctx");
    expect(scope.contextRoot).toBe(root);
  });

  it("resolvePath resolves relative paths within context root", async () => {
    const root = "/tmp/test-context";
    const manager = createMockContextFolderManager(root);

    const scope = await resolveContextScope(manager, "test-ctx");
    const resolved = scope.resolvePath("src/index.ts");
    expect(resolved).toBe(path.join(root, "src/index.ts"));
  });

  it("resolvePath throws on directory traversal", async () => {
    const root = "/tmp/test-context";
    const manager = createMockContextFolderManager(root);

    const scope = await resolveContextScope(manager, "test-ctx");
    expect(() => scope.resolvePath("../../../etc/passwd")).toThrow(
      "Path escapes context root"
    );
  });

  it("validatePath succeeds for paths within root", async () => {
    const root = "/tmp/test-context";
    const manager = createMockContextFolderManager(root);

    const scope = await resolveContextScope(manager, "test-ctx");
    expect(() => scope.validatePath(path.join(root, "file.txt"))).not.toThrow();
  });

  it("validatePath throws on paths outside root", async () => {
    const root = "/tmp/test-context";
    const manager = createMockContextFolderManager(root);

    const scope = await resolveContextScope(manager, "test-ctx");
    expect(() => scope.validatePath("/etc/passwd")).toThrow(
      "file_path escapes panel root"
    );
  });
});
