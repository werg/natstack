import { defineConfig } from "vitest/config";
import path from "path";
import { readFileSync } from "fs";
import type { Alias } from "vite";

// Browser-mode test project. Opened Radix overlays (Dialog/DropdownMenu/Popover/
// HoverCard) can't render under jsdom: pnpm `node-linker=hoisted` leaves two
// path-distinct React copies (hoisted vs nested .pnpm), and the externalized
// overlay sidecars (react-remove-scroll, …) load the second one, so hooks crash
// with a null dispatcher the moment a portal mounts. No vitest alias/dedupe/
// inline combination fixes that (the CJS sidecars resist SSR transform). A real
// browser bundles ONE React, so the overlays open correctly. The jsdom suite
// (vitest.config.ts) excludes *.browser.test.tsx; this config runs only those.

const workspaceTsconfig = JSON.parse(
  readFileSync(path.resolve(__dirname, "tsconfig.workspace.json"), "utf-8"),
);
const tsconfigPaths: Record<string, string[]> = workspaceTsconfig.compilerOptions?.paths ?? {};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const sourceAliases: Alias[] = [];
for (const [importPath, [sourcePath]] of Object.entries(tsconfigPaths).sort((a, b) => b[0].length - a[0].length)) {
  if (!sourcePath) continue;
  if (importPath.includes("*") && sourcePath.includes("*")) {
    const find = new RegExp(`^${escapeRegex(importPath).replace("\\*", "(.+)")}$`);
    const replacement = path.resolve(__dirname, sourcePath).replace("*", "$1");
    sourceAliases.push({ find, replacement });
  } else {
    sourceAliases.push({ find: importPath, replacement: path.resolve(__dirname, sourcePath) });
  }
}

export default defineConfig({
  resolve: {
    alias: [
      ...sourceAliases,
      { find: "ignore", replacement: path.resolve(__dirname, "node_modules/.pnpm/ignore@5.3.2/node_modules/ignore") },
      { find: "picomatch", replacement: path.resolve(__dirname, "node_modules/.pnpm/picomatch@4.0.3/node_modules/picomatch") },
    ],
    dedupe: ["react", "react-dom"],
  },
  test: {
    globals: true,
    include: [
      "workspace/**/*.browser.test.tsx",
      "packages/**/*.browser.test.tsx",
      "src/**/*.browser.test.tsx",
    ],
    exclude: ["**/node_modules/**", "dist", "workspace/.contexts", "apps/mobile/**", "workspace/apps/mobile/**"],
    browser: {
      enabled: true,
      provider: "playwright",
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
