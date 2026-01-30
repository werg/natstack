/**
 * Bundle analysis utilities for panel builds.
 *
 * Provides tools for analyzing esbuild metafiles to identify
 * large dependencies and bundle composition.
 *
 * Note: Bundle analysis output is controlled by NATSTACK_LOG_LEVEL.
 * Set to "verbose" to see detailed bundle analysis during builds.
 */

import type * as esbuild from "esbuild";
import { isVerbose } from "../devLog.js";

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function extractPackageName(inputPath: string): string {
  // Handle pnpm's flat structure: node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>/...
  const pnpmMatch = inputPath.match(/node_modules\/\.pnpm\/[^/]+\/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
  if (pnpmMatch?.[1]) {
    return pnpmMatch[1];
  }
  // Standard node_modules structure
  const nodeModulesMatch = inputPath.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
  if (nodeModulesMatch?.[1] && nodeModulesMatch[1] !== ".pnpm") {
    return nodeModulesMatch[1];
  }
  if (inputPath.startsWith("natstack-panel-fs-shim:") || inputPath.startsWith("natstack-panel-path-shim:")) {
    return "(shims)";
  }
  return "project";
}

/**
 * Analyze metafile to identify largest contributors to bundle size.
 * Groups by package name and returns top contributors.
 * With code splitting, also reports main bundle vs chunk sizes.
 *
 * Note: Only outputs detailed analysis when NATSTACK_LOG_LEVEL=verbose
 */
export function analyzeBundleSize(
  metafile: esbuild.Metafile,
  log?: (message: string) => void
): void {
  // Skip detailed bundle analysis unless verbose logging is enabled
  if (!isVerbose()) {
    return;
  }

  const outputs = Object.entries(metafile.outputs);

  // Separate entry bundle from chunks
  const jsOutputs = outputs.filter(([path]) => path.endsWith(".js"));
  const entryOutput = jsOutputs.find(([, meta]) => meta.entryPoint);
  const chunkOutputs = jsOutputs.filter(([, meta]) => !meta.entryPoint);

  // Report output file sizes if we have chunks (code splitting enabled)
  if (chunkOutputs.length > 0) {
    log?.("=== Bundle Split Analysis ===");

    if (entryOutput) {
      log?.(`  Main bundle: ${formatSize(entryOutput[1].bytes)}`);
    }

    const totalChunkSize = chunkOutputs.reduce((sum, [, meta]) => sum + meta.bytes, 0);
    log?.(`  Lazy chunks: ${formatSize(totalChunkSize)} (${chunkOutputs.length} files)`);

    // Show what's in each chunk (top packages per chunk)
    for (const [chunkPath, chunkMeta] of chunkOutputs) {
      const chunkName = chunkPath.split("/").pop() || chunkPath;
      const chunkPackages = new Map<string, number>();

      for (const inputPath of Object.keys(chunkMeta.inputs)) {
        const pkg = extractPackageName(inputPath);
        const inputBytes = metafile.inputs[inputPath]?.bytes || 0;
        chunkPackages.set(pkg, (chunkPackages.get(pkg) || 0) + inputBytes);
      }

      // Get top 3 packages in this chunk
      const topPkgs = [...chunkPackages.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([pkg, bytes]) => `${pkg} (${formatSize(bytes)})`)
        .join(", ");

      log?.(`    ${chunkName}: ${formatSize(chunkMeta.bytes)} - ${topPkgs}`);
    }

    const totalSize = (entryOutput?.[1].bytes || 0) + totalChunkSize;
    log?.(`  Total JS: ${formatSize(totalSize)}`);
    log?.("=== End Bundle Split Analysis ===");
  }

  // Group all input sizes by package (total across all outputs)
  const packageSizes = new Map<string, number>();

  for (const [inputPath, input] of Object.entries(metafile.inputs)) {
    const packageName = extractPackageName(inputPath);
    const currentSize = packageSizes.get(packageName) || 0;
    packageSizes.set(packageName, currentSize + input.bytes);
  }

  // Sort by size descending
  const sorted = [...packageSizes.entries()].sort((a, b) => b[1] - a[1]);

  // Log top 15 contributors
  log?.("=== Total Bundle Analysis (top 15 contributors) ===");
  for (const [pkg, bytes] of sorted.slice(0, 15)) {
    log?.(`  ${pkg}: ${formatSize(bytes)}`);
  }
  log?.("=== End Bundle Analysis ===");
}
