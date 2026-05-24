import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  discoverExtensionPackageNames,
  renderExtensionRegistry,
  writeExtensionRegistry,
  EXTENSION_REGISTRY_RELATIVE_PATH,
} from "./extensionRegistry.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ext-registry-")));
  tempDirs.push(dir);
  return dir;
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeExtension(root: string, relDir: string, name: string, isExtension = true): void {
  write(
    path.join(root, "extensions", relDir, "package.json"),
    JSON.stringify({ name, ...(isExtension ? { natstack: { extension: {} } } : {}) }),
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("renderExtensionRegistry", () => {
  it("renders sorted type-only re-exports with sanitized aliases", () => {
    const out = renderExtensionRegistry([
      "@workspace-extensions/shell",
      "@workspace-extensions/browser-data",
    ]);
    expect(out).toContain('export type { Api as Ext_workspace_extensions_browser_data } from "@workspace-extensions/browser-data";');
    expect(out).toContain('export type { Api as Ext_workspace_extensions_shell } from "@workspace-extensions/shell";');
    // browser-data sorts before shell
    expect(out.indexOf("browser_data")).toBeLessThan(out.indexOf("Ext_workspace_extensions_shell"));
  });

  it("emits an empty module marker when there are no extensions", () => {
    expect(renderExtensionRegistry([])).toContain("export {};");
  });

  it("is deterministic and de-duplicates", () => {
    const a = renderExtensionRegistry(["@a/one", "@a/two", "@a/one"]);
    const b = renderExtensionRegistry(["@a/two", "@a/one"]);
    expect(a).toBe(b);
  });
});

describe("discoverExtensionPackageNames", () => {
  it("finds scoped and unscoped extension packages, skipping non-extensions", () => {
    const root = tempDir();
    writeExtension(root, "@workspace-extensions/shell", "@workspace-extensions/shell");
    writeExtension(root, "@workspace-extensions/file-tools", "@workspace-extensions/file-tools");
    writeExtension(root, "standalone-ext", "standalone-ext");
    writeExtension(root, "@workspace-extensions/not-an-ext", "@workspace-extensions/not-an-ext", false);

    expect(discoverExtensionPackageNames(root).sort()).toEqual([
      "@workspace-extensions/file-tools",
      "@workspace-extensions/shell",
      "standalone-ext",
    ]);
  });

  it("returns [] when there is no extensions directory", () => {
    expect(discoverExtensionPackageNames(tempDir())).toEqual([]);
  });
});

describe("writeExtensionRegistry", () => {
  it("writes the barrel and is idempotent", () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, "packages", "runtime", "src", "shared"), { recursive: true });
    writeExtension(root, "@workspace-extensions/shell", "@workspace-extensions/shell");

    expect(writeExtensionRegistry(root)).toBe(true);
    const barrel = path.join(root, EXTENSION_REGISTRY_RELATIVE_PATH);
    expect(fs.readFileSync(barrel, "utf-8")).toContain("@workspace-extensions/shell");
    // Second run with unchanged inputs makes no write.
    expect(writeExtensionRegistry(root)).toBe(false);
  });

  it("is a no-op when the workspace has no runtime package", () => {
    const root = tempDir();
    writeExtension(root, "@workspace-extensions/shell", "@workspace-extensions/shell");
    expect(writeExtensionRegistry(root)).toBe(false);
  });
});
