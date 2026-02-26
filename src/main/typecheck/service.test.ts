/**
 * Integration tests for main-process typecheck RPC methods.
 *
 * Exercises typeCheckRpcMethods.check / getTypeInfo / getCompletions
 * against real temp directories with TypeScript files.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { typeCheckRpcMethods, shutdownTypeDefinitionService } from "./service.js";

let panelDir: string;

beforeEach(async () => {
  panelDir = await mkdtemp(join(tmpdir(), "typecheck-rpc-test-"));
});

afterEach(async () => {
  shutdownTypeDefinitionService();
  await rm(panelDir, { recursive: true, force: true });
});

describe("typecheck.check", () => {
  it("returns error diagnostics for explicit fileContent with a type error", async () => {
    const filePath = "index.tsx";
    const fullPath = join(panelDir, filePath);
    // Write a valid file to disk so the service can init
    await writeFile(fullPath, "export {};\n");

    const result = await typeCheckRpcMethods["typecheck.check"](
      panelDir,
      filePath,
      // Provide explicit fileContent with a type error
      "const x: number = 'not a number';\n"
    );

    expect(result.diagnostics.length).toBeGreaterThan(0);
    const errorDiag = result.diagnostics.find(d => d.severity === "error");
    expect(errorDiag).toBeDefined();
    expect(result.checkedFiles).toContain(fullPath);
  });

  it("reads from disk when no fileContent is provided", async () => {
    const filePath = "index.tsx";
    const fullPath = join(panelDir, filePath);
    // Write a file with a type error to disk
    await writeFile(fullPath, "const x: number = 'bad';\n");

    const result = await typeCheckRpcMethods["typecheck.check"](panelDir, filePath);

    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.some(d => d.severity === "error")).toBe(true);
    expect(result.checkedFiles).toContain(fullPath);
  });

  it("refreshes stale cache after file modification", async () => {
    const filePath = "index.tsx";
    const fullPath = join(panelDir, filePath);

    // Start with valid code
    await writeFile(fullPath, "const x: number = 42;\n");
    const result1 = await typeCheckRpcMethods["typecheck.check"](panelDir, filePath);
    expect(result1.diagnostics.filter(d => d.severity === "error")).toHaveLength(0);

    // Modify file on disk to introduce an error
    await writeFile(fullPath, "const x: number = 'now broken';\n");
    const result2 = await typeCheckRpcMethods["typecheck.check"](panelDir, filePath);

    // Should see the new error despite cached service
    expect(result2.diagnostics.length).toBeGreaterThan(0);
    expect(result2.diagnostics.some(d => d.severity === "error")).toBe(true);
  });

  it("checks all files in whole-panel mode (no filePath)", async () => {
    await writeFile(join(panelDir, "a.tsx"), "const a: number = 'bad';\n");
    await writeFile(join(panelDir, "b.tsx"), "const b: string = 123;\n");

    const result = await typeCheckRpcMethods["typecheck.check"](panelDir);

    // Should have errors from both files
    expect(result.diagnostics.filter(d => d.severity === "error").length).toBeGreaterThanOrEqual(2);
    expect(result.checkedFiles.length).toBeGreaterThanOrEqual(2);
  });
});

describe("typecheck.getTypeInfo", () => {
  it("returns type information at a known position", async () => {
    const filePath = "index.tsx";
    await writeFile(join(panelDir, filePath), "const greeting: string = 'hello';\n");

    const info = await typeCheckRpcMethods["typecheck.getTypeInfo"](
      panelDir, filePath, 1, 7 // "greeting" starts at column 7
    );

    expect(info).not.toBeNull();
    expect(info!.displayParts).toContain("string");
  });

  it("refreshes stale cache after file modification", async () => {
    const filePath = "index.tsx";
    await writeFile(join(panelDir, filePath), "const val: number = 42;\n");

    // First call — type is number
    const info1 = await typeCheckRpcMethods["typecheck.getTypeInfo"](
      panelDir, filePath, 1, 7
    );
    expect(info1).not.toBeNull();
    expect(info1!.displayParts).toContain("number");

    // Modify file to change the type
    await writeFile(join(panelDir, filePath), "const val: string = 'hi';\n");

    // Second call — should see updated type despite cached service
    const info2 = await typeCheckRpcMethods["typecheck.getTypeInfo"](
      panelDir, filePath, 1, 7
    );
    expect(info2).not.toBeNull();
    expect(info2!.displayParts).toContain("string");
  });
});

describe("typecheck.getCompletions", () => {
  it("returns completion entries at a known position", async () => {
    const filePath = "index.tsx";
    // Write code where completions should be available after the dot
    await writeFile(
      join(panelDir, filePath),
      'const msg = "hello";\nmsg.\n'
    );

    const completions = await typeCheckRpcMethods["typecheck.getCompletions"](
      panelDir, filePath, 2, 5 // after "msg."
    );

    expect(completions).not.toBeNull();
    expect(completions!.entries.length).toBeGreaterThan(0);
    // String methods should be available
    const names = completions!.entries.map(e => e.name);
    expect(names).toContain("length");
  });

  it("refreshes stale cache after file modification", async () => {
    const filePath = "index.tsx";
    // Start with a string variable
    await writeFile(join(panelDir, filePath), 'const val = "hello";\nval.\n');

    const comp1 = await typeCheckRpcMethods["typecheck.getCompletions"](
      panelDir, filePath, 2, 5
    );
    expect(comp1).not.toBeNull();
    const names1 = comp1!.entries.map(e => e.name);
    expect(names1).toContain("length"); // string property

    // Change to an array
    await writeFile(join(panelDir, filePath), "const val = [1, 2, 3];\nval.\n");

    const comp2 = await typeCheckRpcMethods["typecheck.getCompletions"](
      panelDir, filePath, 2, 5
    );
    expect(comp2).not.toBeNull();
    const names2 = comp2!.entries.map(e => e.name);
    expect(names2).toContain("push"); // array method, not present on string
  });
});

describe("path key consistency (Bug 2 regression)", () => {
  it("produces no duplicate diagnostics for a single file", async () => {
    // Bug 2: init loaded files with relative keys, handlers used absolute keys.
    // This caused the same file to appear twice → duplicate diagnostics.
    const filePath = "index.tsx";
    await writeFile(join(panelDir, filePath), "const x: number = 'bad';\n");

    const result = await typeCheckRpcMethods["typecheck.check"](panelDir);

    // Should have exactly 1 error, not 2 (duplicate from mismatched keys)
    const errors = result.diagnostics.filter(d => d.severity === "error");
    expect(errors).toHaveLength(1);
  });

  it("reports diagnostics with absolute file paths", async () => {
    const filePath = "index.tsx";
    const fullPath = join(panelDir, filePath);
    await writeFile(fullPath, "const x: number = 'bad';\n");

    const result = await typeCheckRpcMethods["typecheck.check"](panelDir, filePath);

    for (const d of result.diagnostics) {
      expect(d.file).toBe(fullPath);
    }
  });

  it("whole-panel check reports each file exactly once in checkedFiles", async () => {
    await writeFile(join(panelDir, "a.tsx"), "const a: number = 'bad';\n");
    await writeFile(join(panelDir, "b.tsx"), "const b: string = 123;\n");

    const result = await typeCheckRpcMethods["typecheck.check"](panelDir);

    // No duplicates in checkedFiles
    const unique = new Set(result.checkedFiles);
    expect(unique.size).toBe(result.checkedFiles.length);
    // All paths should be absolute
    for (const f of result.checkedFiles) {
      expect(f).toMatch(/^\//);
    }
  });

  it("handles files in subdirectories correctly", async () => {
    const subDir = join(panelDir, "components");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "Button.tsx"), "const x: number = 'bad';\n");

    const result = await typeCheckRpcMethods["typecheck.check"](panelDir, "components/Button.tsx");

    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].file).toBe(join(subDir, "Button.tsx"));
  });
});

describe("cross-handler freshness (Bug 3 regression)", () => {
  it("getTypeInfo sees changes made after check loaded the file", async () => {
    // Real agent workflow: check → agent edits → getTypeInfo
    // Bug 3: getTypeInfo skipped disk read because hasFile() was true from check's load
    const filePath = "index.tsx";
    await writeFile(join(panelDir, filePath), "const val: number = 42;\n");

    // check loads the file into the service
    await typeCheckRpcMethods["typecheck.check"](panelDir, filePath);

    // Agent modifies the file on disk
    await writeFile(join(panelDir, filePath), "const val: string = 'changed';\n");

    // getTypeInfo should see the updated type, not the stale "number"
    const info = await typeCheckRpcMethods["typecheck.getTypeInfo"](
      panelDir, filePath, 1, 7
    );
    expect(info).not.toBeNull();
    expect(info!.displayParts).toContain("string");
    expect(info!.displayParts).not.toContain("number");
  });

  it("getCompletions sees changes made after check loaded the file", async () => {
    const filePath = "index.tsx";
    await writeFile(join(panelDir, filePath), 'const val = "hello";\nval.\n');

    // check loads the file
    await typeCheckRpcMethods["typecheck.check"](panelDir, filePath);

    // Agent changes the variable to an array
    await writeFile(join(panelDir, filePath), "const val = [1, 2];\nval.\n");

    const comp = await typeCheckRpcMethods["typecheck.getCompletions"](
      panelDir, filePath, 2, 5
    );
    expect(comp).not.toBeNull();
    const names = comp!.entries.map(e => e.name);
    expect(names).toContain("push"); // array, not string
  });

  it("check sees changes after getTypeInfo loaded the file", async () => {
    const filePath = "index.tsx";
    await writeFile(join(panelDir, filePath), "const val: number = 42;\n");

    // getTypeInfo loads the file
    await typeCheckRpcMethods["typecheck.getTypeInfo"](panelDir, filePath, 1, 7);

    // Agent introduces an error
    await writeFile(join(panelDir, filePath), "const val: number = 'oops';\n");

    const result = await typeCheckRpcMethods["typecheck.check"](panelDir, filePath);
    expect(result.diagnostics.some(d => d.severity === "error")).toBe(true);
  });
});

describe("new files after init", () => {
  it("check finds a file added after the service was created", async () => {
    // Init the service with one file
    await writeFile(join(panelDir, "index.tsx"), "export {};\n");
    await typeCheckRpcMethods["typecheck.check"](panelDir, "index.tsx");

    // Agent creates a new file with an error
    await writeFile(join(panelDir, "newfile.tsx"), "const x: number = 'bad';\n");

    const result = await typeCheckRpcMethods["typecheck.check"](panelDir, "newfile.tsx");
    expect(result.diagnostics.some(d => d.severity === "error")).toBe(true);
  });

  it("whole-panel check picks up files added after init", async () => {
    await writeFile(join(panelDir, "index.tsx"), "export {};\n");
    // Init the service
    await typeCheckRpcMethods["typecheck.check"](panelDir);

    // Agent creates a new file with an error
    await writeFile(join(panelDir, "added.tsx"), "const y: number = false;\n");

    const result = await typeCheckRpcMethods["typecheck.check"](panelDir);
    const addedErrors = result.diagnostics.filter(
      d => d.file === join(panelDir, "added.tsx") && d.severity === "error"
    );
    expect(addedErrors.length).toBeGreaterThan(0);
  });

  it("getTypeInfo works on a file not present at init", async () => {
    await writeFile(join(panelDir, "index.tsx"), "export {};\n");
    await typeCheckRpcMethods["typecheck.check"](panelDir, "index.tsx");

    // New file
    await writeFile(join(panelDir, "utils.tsx"), "export const count: number = 10;\n");

    const info = await typeCheckRpcMethods["typecheck.getTypeInfo"](
      panelDir, "utils.tsx", 1, 14
    );
    expect(info).not.toBeNull();
    expect(info!.displayParts).toContain("number");
  });
});

describe("whole-panel resync", () => {
  it("picks up modifications to existing files", async () => {
    await writeFile(join(panelDir, "index.tsx"), "const x: number = 42;\n");

    // Init — no errors
    const result1 = await typeCheckRpcMethods["typecheck.check"](panelDir);
    expect(result1.diagnostics.filter(d => d.severity === "error")).toHaveLength(0);

    // Modify the file to introduce an error
    await writeFile(join(panelDir, "index.tsx"), "const x: number = 'broken';\n");

    // Whole-panel resync should catch it
    const result2 = await typeCheckRpcMethods["typecheck.check"](panelDir);
    expect(result2.diagnostics.some(d => d.severity === "error")).toBe(true);
  });
});

describe("service caching", () => {
  it("reuses cached service across calls to the same panel", async () => {
    const filePath = "index.tsx";
    await writeFile(join(panelDir, filePath), "const x = 1;\n");

    // First call creates the service
    const result1 = await typeCheckRpcMethods["typecheck.check"](panelDir, filePath);
    // Second call should reuse the cached service (no re-init)
    const result2 = await typeCheckRpcMethods["typecheck.check"](panelDir, filePath);

    // Both should succeed without errors
    expect(result1.diagnostics.filter(d => d.severity === "error")).toHaveLength(0);
    expect(result2.diagnostics.filter(d => d.severity === "error")).toHaveLength(0);
  });
});
