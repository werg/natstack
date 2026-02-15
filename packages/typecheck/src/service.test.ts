import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TypeCheckService } from "./service.js";

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
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("TypeCheckService workspace resolution", () => {
  it("resolves @workspace/* from userWorkspacePath when natstack cache has no package", () => {
    const root = createTempDir("typecheck-service-workspace-");
    const panelPath = path.join(root, "panel");
    const workspaceRoot = path.join(root, "typecheck-root");
    const userWorkspacePath = path.join(root, "user-workspace");
    const panelFile = path.join(panelPath, "index.ts");

    fs.mkdirSync(panelPath, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const runtimePackageDir = path.join(userWorkspacePath, "packages", "runtime");
    writeFile(
      path.join(runtimePackageDir, "package.json"),
      JSON.stringify(
        {
          name: "@workspace/runtime",
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              default: "./dist/index.js",
            },
          },
        },
        null,
        2
      )
    );
    writeFile(
      path.join(runtimePackageDir, "dist", "index.d.ts"),
      "export interface RuntimeThing { ok: boolean }\n"
    );

    const service = new TypeCheckService({
      panelPath,
      workspaceRoot,
      userWorkspacePath,
      skipSuggestions: true,
    });

    service.updateFile(
      panelFile,
      [
        'import type { RuntimeThing } from "@workspace/runtime";',
        "const value: RuntimeThing = { ok: true };",
        "void value;",
      ].join("\n")
    );

    const result = service.check(panelFile);
    const unresolvedModules = result.diagnostics.filter((d) => d.code === 2307);
    expect(unresolvedModules).toHaveLength(0);
  });
});
