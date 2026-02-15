import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  clearNatstackTypesCache,
  findPackagesDir,
  loadNatstackPackageTypes,
} from "./load-natstack-types.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

afterEach(() => {
  clearNatstackTypesCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("findPackagesDir", () => {
  it("prefers workspace/packages over packages at workspace root", () => {
    const root = createTempDir("natstack-find-packages-");
    const workspacePackages = path.join(root, "workspace", "packages");
    const topLevelPackages = path.join(root, "packages");
    fs.mkdirSync(workspacePackages, { recursive: true });
    fs.mkdirSync(topLevelPackages, { recursive: true });

    expect(findPackagesDir(root)).toBe(workspacePackages);
  });

  it("falls back to parent workspace/packages", () => {
    const root = createTempDir("natstack-find-parent-");
    const workspaceRoot = path.join(root, "panel");
    const parentWorkspacePackages = path.join(root, "workspace", "packages");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(parentWorkspacePackages, { recursive: true });

    expect(findPackagesDir(workspaceRoot)).toBe(parentWorkspacePackages);
  });
});

describe("loadNatstackPackageTypes", () => {
  it("loads and caches package types on cache miss without async preload", () => {
    const root = createTempDir("natstack-load-types-");
    const packagesDir = path.join(root, "workspace", "packages");
    const pkgDir = path.join(packagesDir, "runtime");

    writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify(
        {
          name: "@workspace/runtime",
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              default: "./dist/index.js",
            },
            "./panel": {
              types: "./dist/panel.d.ts",
              default: "./dist/panel.js",
            },
          },
        },
        null,
        2
      )
    );
    writeFile(
      path.join(pkgDir, "dist", "index.d.ts"),
      "export interface RuntimeThing { ok: boolean }\n"
    );
    writeFile(
      path.join(pkgDir, "dist", "panel.d.ts"),
      "export type PanelMode = \"view\" | \"edit\";\n"
    );

    const firstLoad = loadNatstackPackageTypes(packagesDir);
    const runtime = firstLoad["@workspace/runtime"];
    expect(runtime).toBeDefined();
    expect(runtime?.files["index.d.ts"]).toContain("RuntimeThing");
    expect(runtime?.subpaths["./panel"]).toBe("panel.d.ts");

    const secondLoad = loadNatstackPackageTypes(packagesDir);
    expect(secondLoad).toBe(firstLoad);
  });
});
