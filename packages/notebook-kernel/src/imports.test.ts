import { describe, it } from "node:test";
import assert from "node:assert";
import {
  isBareSpecifier,
  resolveSpecifier,
  importModule,
  createImportModule,
  DEFAULT_CDN,
} from "./imports.js";

describe("isBareSpecifier", () => {
  describe("should return true for bare specifiers", () => {
    it("handles simple package names", () => {
      assert.strictEqual(isBareSpecifier("lodash"), true);
      assert.strictEqual(isBareSpecifier("react"), true);
      assert.strictEqual(isBareSpecifier("@scope/package"), true);
    });

    it("handles package names with paths", () => {
      assert.strictEqual(isBareSpecifier("lodash/debounce"), true);
      assert.strictEqual(isBareSpecifier("@scope/package/subpath"), true);
    });

    it("handles package names with versions", () => {
      assert.strictEqual(isBareSpecifier("lodash@4.17.21"), true);
    });
  });

  describe("should return false for non-bare specifiers", () => {
    it("handles absolute paths", () => {
      assert.strictEqual(isBareSpecifier("/absolute/path.js"), false);
    });

    it("handles relative paths starting with ./", () => {
      assert.strictEqual(isBareSpecifier("./relative.js"), false);
      assert.strictEqual(isBareSpecifier("./path/to/file.js"), false);
    });

    it("handles relative paths starting with ../", () => {
      assert.strictEqual(isBareSpecifier("../parent.js"), false);
      assert.strictEqual(isBareSpecifier("../../grandparent.js"), false);
    });

    it("handles URLs with protocols", () => {
      assert.strictEqual(isBareSpecifier("https://example.com/module.js"), false);
      assert.strictEqual(isBareSpecifier("http://example.com/module.js"), false);
      assert.strictEqual(isBareSpecifier("file:///path/to/module.js"), false);
      assert.strictEqual(isBareSpecifier("blob:https://example.com/abc"), false);
    });

    it("handles data URLs", () => {
      assert.strictEqual(isBareSpecifier("data:text/javascript,export default 1"), false);
    });
  });
});

describe("resolveSpecifier", () => {
  it("should resolve bare specifiers to CDN URLs", () => {
    const result = resolveSpecifier("lodash");
    assert.strictEqual(result, `${DEFAULT_CDN}/lodash`);
  });

  it("should resolve scoped packages to CDN URLs", () => {
    const result = resolveSpecifier("@scope/package");
    assert.strictEqual(result, `${DEFAULT_CDN}/@scope/package`);
  });

  it("should resolve package subpaths to CDN URLs", () => {
    const result = resolveSpecifier("lodash/debounce");
    assert.strictEqual(result, `${DEFAULT_CDN}/lodash/debounce`);
  });

  it("should use custom CDN when provided", () => {
    const customCdn = "https://cdn.jsdelivr.net/npm";
    const result = resolveSpecifier("react", customCdn);
    assert.strictEqual(result, `${customCdn}/react`);
  });

  it("should return non-bare specifiers unchanged", () => {
    assert.strictEqual(resolveSpecifier("./local.js"), "./local.js");
    assert.strictEqual(resolveSpecifier("../parent.js"), "../parent.js");
    assert.strictEqual(resolveSpecifier("/absolute.js"), "/absolute.js");
    assert.strictEqual(
      resolveSpecifier("https://example.com/module.js"),
      "https://example.com/module.js"
    );
  });
});

describe("importModule", () => {
  it("should call importFn with resolved CDN URL for bare specifiers", async () => {
    const calls: string[] = [];
    const mockModule = { default: "test" };

    const result = await importModule("lodash", {
      importFn: async (url) => {
        calls.push(url);
        return mockModule;
      },
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0], `${DEFAULT_CDN}/lodash`);
    assert.strictEqual(result, mockModule);
  });

  it("should call importFn with original URL for non-bare specifiers", async () => {
    const calls: string[] = [];

    await importModule("./local.js", {
      importFn: async (url) => {
        calls.push(url);
        return {};
      },
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0], "./local.js");
  });

  it("should use custom CDN option", async () => {
    const calls: string[] = [];
    // CDN URL with trailing slash should be normalized
    const customCdn = "https://custom.cdn/";

    await importModule("react", {
      cdn: customCdn,
      importFn: async (url) => {
        calls.push(url);
        return {};
      },
    });

    // Trailing slash is removed to avoid double slash
    assert.strictEqual(calls[0], "https://custom.cdn/react");
  });

  it("should handle import errors", async () => {
    await assert.rejects(
      async () => {
        await importModule("test-package", {
          importFn: async () => {
            throw new Error("Module not found");
          },
        });
      },
      { message: "Module not found" }
    );
  });
});

describe("createImportModule", () => {
  it("should create a bound import function", async () => {
    const calls: string[] = [];
    const boundImport = createImportModule({
      cdn: "https://my.cdn",
      importFn: async (url) => {
        calls.push(url);
        return { name: url };
      },
    });

    await boundImport("package-a");
    await boundImport("package-b");

    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0], "https://my.cdn/package-a");
    assert.strictEqual(calls[1], "https://my.cdn/package-b");
  });

  it("should use default CDN when none provided", async () => {
    const calls: string[] = [];
    const boundImport = createImportModule({
      importFn: async (url) => {
        calls.push(url);
        return {};
      },
    });

    await boundImport("test-pkg");

    assert.strictEqual(calls[0], `${DEFAULT_CDN}/test-pkg`);
  });
});

describe("DEFAULT_CDN", () => {
  it("should be esm.sh", () => {
    assert.strictEqual(DEFAULT_CDN, "https://esm.sh");
  });
});
