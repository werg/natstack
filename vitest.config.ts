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
    // Force a single React instance across the test graph. The repo has
    // BOTH `node_modules/react` (hoisted) and
    // `node_modules/.pnpm/react@19.2.3/node_modules/react` (canonical pnpm),
    // and the files inside are hardlinks — same inode, different path
    // strings. Node's module system keys by path, so different importers
    // can each end up with their own React module record. The dispatcher
    // (ReactSharedInternals.H) gets set on one copy but read from the
    // other, and hooks crash with "Cannot read properties of null
    // (reading 'useState' / 'useSyncExternalStore')". `dedupe` makes Vite
    // always resolve react to the same path; `server.deps.inline` below
    // makes the same true for code in node_modules.
    dedupe: ["react", "react-dom"],
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "workspace/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist", "workspace/.contexts"],
    server: {
      deps: {
        // Inline Radix so its imports go through Vite's transform pipeline,
        // where `resolve.dedupe` above can rewrite their `react` imports
        // to the same canonical path used elsewhere. Without inlining,
        // Node's CJS resolver finds React via the deeply-nested pnpm
        // symlink chain (which is hardlinked to but path-distinct from the
        // hoisted `node_modules/react`), so we end up with two React module
        // records and hooks crash with "Cannot read properties of null
        // (reading 'useState')". Patterns match against the resolved file
        // path, not the import specifier, so we anchor on the .pnpm folder.
        inline: [
          /node_modules\/\.pnpm\/@radix-ui\+/,
          /node_modules\/\.pnpm\/radix-ui@/,
        ],
      },
    },
  },
});
