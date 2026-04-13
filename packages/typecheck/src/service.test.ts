import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TypeCheckService } from "./service.js";
import { clearWorkspaceContextCache } from "./lib/workspace-packages.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Symlinks on macOS resolve to /private/var/... — use realpath so the
  // service's internal path comparisons match.
  const real = fs.realpathSync(dir);
  tempDirs.push(real);
  return real;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  clearWorkspaceContextCache();
});

describe("TypeCheckService workspace resolution", () => {
  it("resolves a workspace package from its source via the workspace context map", () => {
    // Build a minimal pnpm-workspace-style monorepo:
    //   <root>/pnpm-workspace.yaml           (packages: ["packages/*"])
    //   <root>/packages/runtime/package.json (name: "@workspace/runtime", exports: ./src/index.ts)
    //   <root>/packages/runtime/src/index.ts (exports RuntimeThing)
    //   <root>/packages/consumer/package.json
    //   <root>/packages/consumer/index.ts    (imports @workspace/runtime)
    const root = createTempDir("typecheck-service-workspace-");

    writeFile(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );

    // The producer package
    writeFile(
      path.join(root, "packages", "runtime", "package.json"),
      JSON.stringify(
        {
          name: "@workspace/runtime",
          type: "module",
          exports: { ".": "./src/index.ts" },
        },
        null,
        2,
      ),
    );
    writeFile(
      path.join(root, "packages", "runtime", "src", "index.ts"),
      "export interface RuntimeThing { ok: boolean }\n",
    );

    // The consumer package (this is what we type-check)
    writeFile(
      path.join(root, "packages", "consumer", "package.json"),
      JSON.stringify({ name: "@workspace/consumer", type: "module" }, null, 2),
    );
    const consumerFile = path.join(root, "packages", "consumer", "index.ts");
    writeFile(
      consumerFile,
      [
        'import type { RuntimeThing } from "@workspace/runtime";',
        "const value: RuntimeThing = { ok: true };",
        "void value;",
      ].join("\n"),
    );

    const service = new TypeCheckService({
      panelPath: path.join(root, "packages", "consumer"),
      skipSuggestions: true,
      disableTsconfigDiscovery: true,
    });

    service.updateFile(consumerFile, fs.readFileSync(consumerFile, "utf-8"));

    const result = service.check(consumerFile);
    const unresolvedModules = result.diagnostics.filter((d) => d.code === 2307);
    expect(unresolvedModules).toHaveLength(0);
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("returns a Cannot-find-module error for an import that doesn't resolve", () => {
    const root = createTempDir("typecheck-service-workspace-");
    writeFile(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );
    const consumerDir = path.join(root, "packages", "consumer");
    writeFile(
      path.join(consumerDir, "package.json"),
      JSON.stringify({ name: "@workspace/consumer", type: "module" }, null, 2),
    );
    const consumerFile = path.join(consumerDir, "index.ts");
    writeFile(
      consumerFile,
      'import { nope } from "@workspace/nonexistent";\nvoid nope;\n',
    );

    const service = new TypeCheckService({
      panelPath: consumerDir,
      skipSuggestions: true,
      disableTsconfigDiscovery: true,
    });
    service.updateFile(consumerFile, fs.readFileSync(consumerFile, "utf-8"));

    const result = service.check(consumerFile);
    const unresolvedModules = result.diagnostics.filter((d) => d.code === 2307);
    expect(unresolvedModules).toHaveLength(1);
  });

  it("resolves external packages from explicit nodeModulesPaths", () => {
    const root = createTempDir("typecheck-service-node-modules-");
    const consumerDir = path.join(root, "workspace", "packages", "consumer");
    const externalNodeModules = path.join(root, "external-deps", "node_modules");

    writeFile(
      path.join(consumerDir, "package.json"),
      JSON.stringify({
        name: "@workspace/consumer",
        type: "module",
        dependencies: {
          "use-stick-to-bottom": "^1.1.3",
        },
      }, null, 2),
    );
    writeFile(
      path.join(externalNodeModules, "use-stick-to-bottom", "package.json"),
      JSON.stringify({
        name: "use-stick-to-bottom",
        type: "module",
        types: "./dist/index.d.ts",
      }, null, 2),
    );
    writeFile(
      path.join(externalNodeModules, "use-stick-to-bottom", "dist", "index.d.ts"),
      'export declare function useStickToBottom(): { isAtBottom: boolean };\n',
    );

    const consumerFile = path.join(consumerDir, "index.ts");
    writeFile(
      consumerFile,
      [
        'import { useStickToBottom } from "use-stick-to-bottom";',
        "const state = useStickToBottom();",
        "const atBottom: boolean = state.isAtBottom;",
        "void atBottom;",
      ].join("\n"),
    );

    const service = new TypeCheckService({
      panelPath: consumerDir,
      nodeModulesPaths: [externalNodeModules],
      skipSuggestions: true,
      disableTsconfigDiscovery: true,
      workspaceContext: null,
    });

    service.updateFile(consumerFile, fs.readFileSync(consumerFile, "utf-8"));

    const result = service.check(consumerFile);
    const unresolvedModules = result.diagnostics.filter((d) => d.code === 2307);
    expect(unresolvedModules).toHaveLength(0);
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });
});
