/**
 * Bundle analysis utilities for panel builds.
 *
 * Provides tools for analyzing esbuild metafiles to identify
 * large dependencies and bundle composition.
 */

import type * as esbuild from "esbuild";

/**
 * Analyze metafile to identify largest contributors to bundle size.
 * Groups by package name and returns top contributors.
 */
export function analyzeBundleSize(
  metafile: esbuild.Metafile,
  log?: (message: string) => void
): void {
  // Group input sizes by package
  const packageSizes = new Map<string, number>();

  for (const [inputPath, input] of Object.entries(metafile.inputs)) {
    // Extract package name from path
    let packageName = "project";

    // Handle pnpm's flat structure: node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>/...
    const pnpmMatch = inputPath.match(/node_modules\/\.pnpm\/[^/]+\/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
    if (pnpmMatch?.[1]) {
      packageName = pnpmMatch[1];
    } else {
      // Standard node_modules structure
      const nodeModulesMatch = inputPath.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
      if (nodeModulesMatch?.[1] && nodeModulesMatch[1] !== ".pnpm") {
        packageName = nodeModulesMatch[1];
      } else if (inputPath.startsWith("natstack-panel-fs-shim:") || inputPath.startsWith("natstack-panel-path-shim:")) {
        packageName = "(shims)";
      }
    }

    const currentSize = packageSizes.get(packageName) || 0;
    packageSizes.set(packageName, currentSize + input.bytes);
  }

  // Sort by size descending
  const sorted = [...packageSizes.entries()].sort((a, b) => b[1] - a[1]);

  // Log top 15 contributors
  log?.("=== Bundle Size Analysis (top 15 contributors) ===");
  for (const [pkg, bytes] of sorted.slice(0, 15)) {
    const mb = (bytes / 1024 / 1024).toFixed(2);
    const kb = (bytes / 1024).toFixed(0);
    log?.(`  ${pkg}: ${bytes > 1024 * 1024 ? `${mb} MB` : `${kb} KB`}`);
  }
  log?.("=== End Bundle Analysis ===");
}
