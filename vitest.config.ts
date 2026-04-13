import { defineConfig } from "vitest/config";
import path from "path";
import { readFileSync } from "fs";
import type { Alias } from "vite";

// Read workspace tsconfig paths and convert to vitest aliases.
// This is the single source of truth for resolving workspace/natstack
// package imports to source .ts files — no dist needed.
const workspaceTsconfig = JSON.parse(
  readFileSync(path.resolve(__dirname, "tsconfig.workspace.json"), "utf-8"),
);
const tsconfigPaths: Record<string, string[]> = workspaceTsconfig.compilerOptions?.paths ?? {};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const sourceAliases: Alias[] = [];
// Sort by specificity (longer paths first) so subpath exports match before bare imports
for (const [importPath, [sourcePath]] of Object.entries(tsconfigPaths).sort((a, b) => b[0].length - a[0].length)) {
  if (!sourcePath) continue;

  if (importPath.includes("*") && sourcePath.includes("*")) {
    const find = new RegExp(`^${escapeRegex(importPath).replace("\\*", "(.+)")}$`);
    const replacement = path.resolve(__dirname, sourcePath).replace("*", "$1");
    sourceAliases.push({ find, replacement });
  } else {
    sourceAliases.push({
      find: importPath,
      replacement: path.resolve(__dirname, sourcePath),
    });
  }
}

export default defineConfig({
  resolve: {
    alias: [
      ...sourceAliases,
      // Resolve workspace panel dependencies from pnpm's node_modules
      // These are needed for tests in workspace/panels/ which aren't pnpm workspace packages
      {
        find: "ignore",
        replacement: path.resolve(__dirname, "node_modules/.pnpm/ignore@5.3.2/node_modules/ignore"),
      },
      {
        find: "picomatch",
        replacement: path.resolve(__dirname, "node_modules/.pnpm/picomatch@4.0.3/node_modules/picomatch"),
      },
    ],
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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "workspace/**/*.test.ts", "workspace/**/*.test.tsx", "packages/**/*.test.ts", "packages/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "dist", "workspace/.contexts"],
    setupFiles: ["tests/setup/vitest.setup.ts"],
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
