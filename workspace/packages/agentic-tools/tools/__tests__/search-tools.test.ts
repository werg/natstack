import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { grep, glob } from "../search-tools";
import { clearIgnoreCache } from "../gitignore-cache";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("grep", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "grep-test-"));
    clearIgnoreCache();
    // Create test files
    await fs.promises.writeFile(
      path.join(tempDir, "test.txt"),
      "hello world\nHello World\nHelloWorld\nhello-world\n"
    );
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true });
  });

  describe("-w (word boundary)", () => {
    it("matches whole words only", async () => {
      const result = await grep(
        {
          pattern: "hello",
          path: tempDir,
          "-w": true,
          output_mode: "content",
        },
        tempDir
      );

      expect(result).toContain("hello world");
      expect(result).toContain("hello-world"); // word boundary at hyphen
      expect(result).not.toContain("HelloWorld"); // no word boundary (case + no boundary)
    });

    it("combines with -i for case-insensitive word matching", async () => {
      const result = await grep(
        {
          pattern: "hello",
          path: tempDir,
          "-w": true,
          "-i": true,
          output_mode: "content",
        },
        tempDir
      );

      expect(result).toContain("hello world");
      expect(result).toContain("Hello World");
    });
  });

  describe("-F (fixed string)", () => {
    it("treats pattern as literal string", async () => {
      await fs.promises.writeFile(
        path.join(tempDir, "regex.txt"),
        "foo.*bar\nfoo.bar\nfoobar\n"
      );

      const result = await grep(
        {
          pattern: "foo.*bar",
          path: path.join(tempDir, "regex.txt"),
          "-F": true,
          output_mode: "content",
        },
        tempDir
      );

      expect(result).toContain("foo.*bar");
      // Without -F, "foo.*bar" as regex would match "foobar" too
      // With -F, it only matches the literal "foo.*bar"
      const lines = result.split("\n").filter(Boolean);
      expect(lines.length).toBe(1);
    });

    it("escapes all regex special characters", async () => {
      await fs.promises.writeFile(
        path.join(tempDir, "special.txt"),
        "price: $100.00\nregex: [a-z]+\npath: /foo/bar\n"
      );

      const result = await grep(
        {
          pattern: "$100.00",
          path: path.join(tempDir, "special.txt"),
          "-F": true,
          output_mode: "content",
        },
        tempDir
      );

      expect(result).toContain("$100.00");
    });

    it("escapes brackets and other special chars", async () => {
      await fs.promises.writeFile(
        path.join(tempDir, "brackets.txt"),
        "array[0]\narray[1]\narray0\n"
      );

      const result = await grep(
        {
          pattern: "array[0]",
          path: path.join(tempDir, "brackets.txt"),
          "-F": true,
          output_mode: "content",
        },
        tempDir
      );

      expect(result).toContain("array[0]");
      // Without -F, [0] is a character class matching "0"
      // With -F, it matches literal "array[0]"
      const lines = result.split("\n").filter(Boolean);
      expect(lines.length).toBe(1);
    });
  });

  describe("-w and -F combined", () => {
    it("matches literal string at word boundaries", async () => {
      // Note: \b matches at transitions between word chars [a-zA-Z0-9_] and non-word chars
      // So "foo.bar" in "foo.bar.baz" DOES match because . is a non-word char (word boundary exists)
      // To test word boundary properly, we need cases where the pattern is embedded in word chars
      await fs.promises.writeFile(
        path.join(tempDir, "combined.txt"),
        "use foo.bar here\nxfoo.bar\nfoo.barx\nfoo.bar\n"
      );

      const result = await grep(
        {
          pattern: "foo.bar",
          path: path.join(tempDir, "combined.txt"),
          "-F": true,
          "-w": true,
          output_mode: "content",
        },
        tempDir
      );

      expect(result).toContain("use foo.bar here");
      expect(result).toContain("combined.txt:4:foo.bar"); // standalone match on line 4
      // These should NOT match - no word boundary before/after due to adjacent word chars
      expect(result).not.toContain("xfoo.bar"); // 'x' before 'f' prevents word boundary
      expect(result).not.toContain("foo.barx"); // 'x' after 'r' prevents word boundary
    });
  });
});

describe("glob with gitignore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "glob-test-"));
    clearIgnoreCache();
    // Create test structure
    await fs.promises.mkdir(path.join(tempDir, "src"));
    await fs.promises.mkdir(path.join(tempDir, "build"));
    await fs.promises.writeFile(path.join(tempDir, "src", "app.ts"), "export {}");
    await fs.promises.writeFile(path.join(tempDir, "build", "app.js"), "module.exports = {}");
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true });
  });

  it("respects .gitignore when globbing", async () => {
    await fs.promises.writeFile(path.join(tempDir, ".gitignore"), "build/\n");

    const result = await glob({ pattern: "**/*.{ts,js}" }, tempDir);

    expect(result).toContain("src/app.ts");
    expect(result).not.toContain("build/app.js");
  });

  it("ignores node_modules by default", async () => {
    await fs.promises.mkdir(path.join(tempDir, "node_modules", "pkg"), { recursive: true });
    await fs.promises.writeFile(
      path.join(tempDir, "node_modules", "pkg", "index.js"),
      "module.exports = {}"
    );

    const result = await glob({ pattern: "**/*.js" }, tempDir);

    expect(result).not.toContain("node_modules");
  });

  it("combines .gitignore with default ignores", async () => {
    await fs.promises.writeFile(path.join(tempDir, ".gitignore"), "*.log\n");
    await fs.promises.writeFile(path.join(tempDir, "debug.log"), "log content");
    await fs.promises.writeFile(path.join(tempDir, "src", "index.ts"), "export {}");

    const result = await glob({ pattern: "**/*" }, tempDir);

    expect(result).not.toContain("debug.log");
    expect(result).toContain("src/index.ts");
  });
});
