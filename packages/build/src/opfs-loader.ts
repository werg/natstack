/**
 * Filesystem Module Loader
 *
 * Loads and bundles modules from the filesystem (via ZenFS/OPFS)
 * using esbuild-wasm for transitive resolution and TypeScript/JSX support.
 *
 * Uses fs/promises which is redirected to ZenFS by the panel build system.
 * ZenFS provides a Node.js-compatible fs API backed by OPFS.
 */

import * as fs from "fs/promises";
import { getEsbuild } from "./esbuild-init.js";

type EsbuildWasm = typeof import("esbuild-wasm");

/** Common file extensions to try when resolving extensionless imports */
const EXTENSION_ORDER = [".ts", ".tsx", ".js", ".jsx", ".json"];

/**
 * Loader for modules stored in the filesystem with support for transitive resolution.
 */
export class FsLoader {
  private esbuild: EsbuildWasm | null = null;
  private cache = new Map<string, unknown>();

  /**
   * Import a module from the filesystem.
   * Automatically initializes esbuild-wasm on first call.
   *
   * @param path - Path to the module (e.g., "/scripts/helper.ts")
   * @returns The imported module
   */
  async importModule(path: string): Promise<unknown> {
    // Auto-initialize on first use (uses shared esbuild instance)
    if (!this.esbuild) {
      this.esbuild = await getEsbuild();
    }

    const cacheKey = path;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Resolve the actual path (handles extension-less imports)
    const resolvedPath = await resolveWithExtensions(path);

    // Read source from filesystem
    const source = await fs.readFile(resolvedPath, "utf-8");

    // Bundle with esbuild
    const result = await this.esbuild.build({
      stdin: {
        contents: source,
        loader: getLoader(resolvedPath),
        resolveDir: getDirectory(resolvedPath),
        sourcefile: resolvedPath,
      },
      bundle: true,
      format: "esm",
      write: false,
      platform: "browser",
      target: "es2022",
      plugins: [createFsResolverPlugin()],
    });

    if (result.errors.length > 0) {
      const errorMsg = result.errors
        .map((e) => `${e.location?.file || path}:${e.location?.line || 0}: ${e.text}`)
        .join("\n");
      throw new Error(`Build failed:\n${errorMsg}`);
    }

    // Create blob URL and import
    const outputText = result.outputFiles?.[0]?.text;
    if (!outputText) {
      throw new Error("No output from esbuild");
    }

    const blob = new Blob([outputText], {
      type: "application/javascript",
    });
    const url = URL.createObjectURL(blob);

    try {
      const module = await import(/* webpackIgnore: true */ url);
      // Blob URL can be revoked immediately after import since the module is already loaded
      URL.revokeObjectURL(url);
      this.cache.set(cacheKey, module);
      return module;
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  /**
   * Clear the module cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Invalidate a specific cached module.
   *
   * @param path - The module path
   */
  invalidate(path: string): void {
    this.cache.delete(path);
  }
}

/**
 * Read a file from the filesystem.
 */
export async function readFile(path: string): Promise<string> {
  return fs.readFile(path, "utf-8");
}

/**
 * Write a file to the filesystem.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  // Ensure parent directory exists
  const dir = getDirectory(path);
  if (dir && dir !== "/") {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      // Directory might already exist, ignore error
    }
  }

  await fs.writeFile(path, content);
}

/**
 * Check if a file exists.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Check if path has a known file extension.
 */
function hasKnownExtension(path: string): boolean {
  return (
    path.endsWith(".ts") ||
    path.endsWith(".tsx") ||
    path.endsWith(".js") ||
    path.endsWith(".jsx") ||
    path.endsWith(".json") ||
    path.endsWith(".css")
  );
}

/**
 * Get the appropriate esbuild loader for a file extension.
 */
function getLoader(path: string): "js" | "jsx" | "ts" | "tsx" | "json" | "css" {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".ts")) return "ts";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  return "js";
}

/**
 * Get the directory portion of a path.
 */
function getDirectory(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash > 0 ? path.slice(0, lastSlash) : "/";
}

/**
 * Resolve a relative path against a base directory.
 */
function resolvePath(base: string, relative: string): string {
  // Handle absolute paths
  if (relative.startsWith("/")) {
    return relative;
  }

  // Split into parts
  const baseParts = base.split("/").filter(Boolean);
  const relativeParts = relative.split("/");

  const result = [...baseParts];

  for (const part of relativeParts) {
    if (part === "..") {
      result.pop();
    } else if (part !== "." && part !== "") {
      result.push(part);
    }
  }

  return "/" + result.join("/");
}

/**
 * Try to resolve a path with different extensions if it doesn't have one.
 */
async function resolveWithExtensions(path: string): Promise<string> {
  // If path already has an extension, use it directly
  if (hasKnownExtension(path)) {
    return path;
  }

  // Try each extension in order
  for (const ext of EXTENSION_ORDER) {
    const pathWithExt = path + ext;
    if (await fileExists(pathWithExt)) {
      return pathWithExt;
    }
  }

  // Try as directory with index file
  for (const ext of EXTENSION_ORDER) {
    const indexPath = path + "/index" + ext;
    if (await fileExists(indexPath)) {
      return indexPath;
    }
  }

  // Return original path, let it fail with a proper error message
  return path;
}

/**
 * Create an esbuild plugin for resolving imports from the filesystem.
 */
function createFsResolverPlugin(): import("esbuild-wasm").Plugin {
  return {
    name: "fs-resolver",
    setup: (build) => {
      // Resolve relative imports
      build.onResolve({ filter: /^\./ }, async (args) => {
        const resolveDir = args.resolveDir || "/";
        const resolved = resolvePath(resolveDir, args.path);
        const withExt = await resolveWithExtensions(resolved);
        return { path: withExt, namespace: "fs" };
      });

      // Resolve absolute imports starting with /
      build.onResolve({ filter: /^\// }, async (args) => {
        const withExt = await resolveWithExtensions(args.path);
        return { path: withExt, namespace: "fs" };
      });

      // Load files from fs namespace
      build.onLoad({ filter: /.*/, namespace: "fs" }, async (args) => {
        try {
          const contents = await fs.readFile(args.path, "utf-8");
          return {
            contents,
            loader: getLoader(args.path),
            resolveDir: getDirectory(args.path),
          };
        } catch (error) {
          return {
            errors: [
              {
                text: `Failed to load ${args.path}: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      });
    },
  };
}

/**
 * Convenience function to import from filesystem using a shared loader instance.
 */
const sharedLoader = new FsLoader();

export function importModule(path: string): Promise<unknown> {
  return sharedLoader.importModule(path);
}

export function clearModuleCache(): void {
  sharedLoader.clearCache();
}

export function invalidateModule(path: string): void {
  sharedLoader.invalidate(path);
}

/**
 * Create an esbuild plugin for resolving imports from the filesystem.
 * This is a standalone factory for use with esbuild.build().
 */
export function createFsPlugin(): import("esbuild-wasm").Plugin {
  return createFsResolverPlugin();
}

// Legacy exports for backward compatibility
// These are aliases to the new names
export { FsLoader as OPFSLoader };
export { importModule as importFromOPFS };
export { clearModuleCache as clearOPFSCache };
export { invalidateModule as invalidateOPFSModule };
export { readFile as readOPFSFile };
export { writeFile as writeOPFSFile };
export { createFsPlugin as createOPFSPlugin };
