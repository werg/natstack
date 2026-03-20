import { defineConfig } from "vitest/config";
import path from "path";
import { readFileSync } from "fs";

// Read workspace tsconfig paths and convert to vitest aliases.
// This is the single source of truth for resolving workspace/natstack
// package imports to source .ts files — no dist needed.
const workspaceTsconfig = JSON.parse(
  readFileSync(path.resolve(__dirname, "tsconfig.workspace.json"), "utf-8"),
);
const tsconfigPaths: Record<string, string[]> = workspaceTsconfig.compilerOptions?.paths ?? {};

const sourceAliases: Record<string, string> = {};
// Sort by specificity (longer paths first) so subpath exports match before bare imports
for (const [importPath, [sourcePath]] of Object.entries(tsconfigPaths).sort((a, b) => b[0].length - a[0].length)) {
  if (sourcePath) {
    sourceAliases[importPath] = path.resolve(__dirname, sourcePath);
  }
}

export default defineConfig({
  resolve: {
    alias: {
      ...sourceAliases,
      // Resolve workspace panel dependencies from pnpm's node_modules
      // These are needed for tests in workspace/panels/ which aren't pnpm workspace packages
      ignore: path.resolve(__dirname, "node_modules/.pnpm/ignore@5.3.2/node_modules/ignore"),
      picomatch: path.resolve(__dirname, "node_modules/.pnpm/picomatch@4.0.3/node_modules/picomatch"),
    },
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "workspace/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist", "workspace/.contexts"],
  },
});
