import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { clearIgnoreCache, shouldIgnore, createIgnoreFilter } from "../gitignore-cache";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("gitignore-cache", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gitignore-test-"));
    clearIgnoreCache();
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true });
  });

  describe("shouldIgnore", () => {
    it("ignores node_modules by default", async () => {
      expect(await shouldIgnore("node_modules/foo.js", tempDir)).toBe(true);
    });

    it("ignores .git by default", async () => {
      expect(await shouldIgnore(".git/config", tempDir)).toBe(true);
    });

    it("does not ignore regular files by default", async () => {
      expect(await shouldIgnore("src/app.ts", tempDir)).toBe(false);
    });

    it("respects .gitignore patterns", async () => {
      await fs.promises.writeFile(
        path.join(tempDir, ".gitignore"),
        "*.log\nbuild/\n"
      );

      expect(await shouldIgnore("debug.log", tempDir)).toBe(true);
      expect(await shouldIgnore("build/output.js", tempDir)).toBe(true);
      expect(await shouldIgnore("src/app.ts", tempDir)).toBe(false);
    });

    it("handles negation patterns", async () => {
      await fs.promises.writeFile(
        path.join(tempDir, ".gitignore"),
        "*.log\n!important.log\n"
      );

      expect(await shouldIgnore("debug.log", tempDir)).toBe(true);
      expect(await shouldIgnore("important.log", tempDir)).toBe(false);
    });

    it("respects nested .gitignore files", async () => {
      await fs.promises.mkdir(path.join(tempDir, "src"));
      await fs.promises.writeFile(
        path.join(tempDir, ".gitignore"),
        "*.tmp\n"
      );
      await fs.promises.writeFile(
        path.join(tempDir, "src", ".gitignore"),
        "*.generated.ts\n"
      );

      expect(await shouldIgnore("src/foo.generated.ts", tempDir)).toBe(true);
      expect(await shouldIgnore("src/foo.tmp", tempDir)).toBe(true);
      expect(await shouldIgnore("src/foo.ts", tempDir)).toBe(false);
    });
  });

  describe("createIgnoreFilter", () => {
    it("returns a filter function", async () => {
      const filter = await createIgnoreFilter(tempDir);
      expect(typeof filter).toBe("function");
    });

    it("filter function ignores node_modules", async () => {
      const filter = await createIgnoreFilter(tempDir);
      expect(await filter("node_modules/package/index.js", tempDir)).toBe(true);
    });

    it("filter function respects .gitignore", async () => {
      await fs.promises.writeFile(
        path.join(tempDir, ".gitignore"),
        "dist/\n"
      );

      const filter = await createIgnoreFilter(tempDir);
      expect(await filter("dist/bundle.js", tempDir)).toBe(true);
      expect(await filter("src/index.js", tempDir)).toBe(false);
    });
  });

  describe("clearIgnoreCache", () => {
    it("clears cached ignore rules", async () => {
      // First call loads and caches
      await shouldIgnore("test.txt", tempDir);

      // Add a new .gitignore
      await fs.promises.writeFile(
        path.join(tempDir, ".gitignore"),
        "test.txt\n"
      );

      // Without clearing cache, old rules apply
      expect(await shouldIgnore("test.txt", tempDir)).toBe(false);

      // Clear cache and re-check
      clearIgnoreCache();
      expect(await shouldIgnore("test.txt", tempDir)).toBe(true);
    });
  });
});
