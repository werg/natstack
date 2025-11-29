/**
 * OPFS Module Loader
 *
 * Loads and bundles modules from the Origin Private File System (OPFS)
 * using esbuild-wasm for transitive resolution and TypeScript/JSX support.
 */

import { getEsbuild, isEsbuildAvailable } from "./esbuild-init.js";

type EsbuildWasm = typeof import("esbuild-wasm");

/** Common file extensions to try when resolving extensionless imports */
const EXTENSION_ORDER = [".ts", ".tsx", ".js", ".jsx", ".json"];

export interface OPFSModuleLoaderOptions {
  /** URL to the esbuild.wasm file (if not provided, derives from installed package version) */
  wasmURL?: string;
}

/**
 * Loader for modules stored in OPFS with support for transitive resolution.
 */
export class OPFSModuleLoader {
  private esbuild: EsbuildWasm | null = null;
  private initOptions: OPFSModuleLoaderOptions = {};
  private cache = new Map<string, unknown>();

  /**
   * Configure initialization options (will be used on first import).
   * Call this before importing if you need custom options like wasmURL.
   */
  configure(options: OPFSModuleLoaderOptions): void {
    if (isEsbuildAvailable()) {
      console.warn("esbuild already initialized, configure() has no effect");
      return;
    }
    this.initOptions = options;
  }

  /**
   * Initialize the esbuild-wasm runtime.
   * Called automatically on first import, but can be called manually for eager initialization.
   *
   * @param options - Loader options (overrides configured options)
   */
  async initialize(options?: OPFSModuleLoaderOptions): Promise<void> {
    this.esbuild = await getEsbuild(options ?? this.initOptions);
  }

  /**
   * Import a module from OPFS.
   * Automatically initializes esbuild-wasm on first call.
   *
   * @param path - Path within OPFS (e.g., "/scripts/helper.ts")
   * @param opfsRoot - The OPFS root directory handle
   * @returns The imported module
   */
  async importFromOPFS(
    path: string,
    opfsRoot: FileSystemDirectoryHandle
  ): Promise<unknown> {
    // Auto-initialize on first use (uses shared esbuild instance)
    if (!this.esbuild) {
      this.esbuild = await getEsbuild(this.initOptions);
    }

    // Create cache key that includes the OPFS root name to avoid collisions
    // when the same loader is used with different roots
    const rootName = opfsRoot.name || "opfs";
    const cacheKey = `${rootName}:${path}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Resolve the actual path (handles extension-less imports)
    const resolvedPath = await this.resolveWithExtensions(path, opfsRoot);

    // Read source from OPFS
    const source = await this.readOPFSFile(resolvedPath, opfsRoot);

    // Bundle with esbuild
    const result = await this.esbuild.build({
      stdin: {
        contents: source,
        loader: this.getLoader(resolvedPath),
        resolveDir: this.getDirectory(resolvedPath),
        sourcefile: resolvedPath,
      },
      bundle: true,
      format: "esm",
      write: false,
      platform: "browser",
      target: "es2022",
      plugins: [this.createOPFSResolverPlugin(opfsRoot)],
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
   * @param opfsRoot - Optional OPFS root to scope the invalidation
   */
  invalidate(path: string, opfsRoot?: FileSystemDirectoryHandle): void {
    if (opfsRoot) {
      // Invalidate specific root's cache entry
      const rootName = opfsRoot.name || "opfs";
      const cacheKey = `${rootName}:${path}`;
      this.cache.delete(cacheKey);
    } else {
      // Invalidate all entries matching this path (any root)
      for (const key of this.cache.keys()) {
        if (key.endsWith(`:${path}`)) {
          this.cache.delete(key);
        }
      }
    }
  }

  /**
   * Try to resolve a path with different extensions if it doesn't have one.
   */
  private async resolveWithExtensions(
    path: string,
    root: FileSystemDirectoryHandle
  ): Promise<string> {
    // If path already has an extension, use it directly
    if (this.hasKnownExtension(path)) {
      return path;
    }

    // Try each extension in order
    for (const ext of EXTENSION_ORDER) {
      try {
        const pathWithExt = path + ext;
        await this.readOPFSFile(pathWithExt, root);
        return pathWithExt;
      } catch {
        // Try next extension
      }
    }

    // Try as directory with index file
    for (const ext of EXTENSION_ORDER) {
      try {
        const indexPath = path + "/index" + ext;
        await this.readOPFSFile(indexPath, root);
        return indexPath;
      } catch {
        // Try next extension
      }
    }

    // Return original path, let it fail with a proper error message
    return path;
  }

  /**
   * Check if path has a known file extension.
   */
  private hasKnownExtension(path: string): boolean {
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
   * Read a file from OPFS.
   */
  private async readOPFSFile(
    path: string,
    root: FileSystemDirectoryHandle
  ): Promise<string> {
    // Normalize path
    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    const parts = normalizedPath.split("/").filter(Boolean);

    if (parts.length === 0) {
      throw new Error(`Invalid path: ${path}`);
    }

    // Navigate to the file
    let current: FileSystemDirectoryHandle = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (part) {
        current = await current.getDirectoryHandle(part);
      }
    }

    const fileName = parts[parts.length - 1];
    if (!fileName) {
      throw new Error(`Invalid path: ${path}`);
    }
    const fileHandle = await current.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    return file.text();
  }

  /**
   * Create an esbuild plugin for resolving OPFS imports.
   */
  private createOPFSResolverPlugin(
    root: FileSystemDirectoryHandle
  ): import("esbuild-wasm").Plugin {
    return {
      name: "opfs-resolver",
      setup: (build) => {
        // Resolve relative imports within OPFS
        build.onResolve({ filter: /^\./ }, async (args) => {
          const resolveDir = args.resolveDir || "/";
          const resolved = this.resolvePath(resolveDir, args.path);
          // Handle extension-less imports
          const withExt = await this.resolveWithExtensions(resolved, root);
          return { path: withExt, namespace: "opfs" };
        });

        // Load files from OPFS namespace
        build.onLoad({ filter: /.*/, namespace: "opfs" }, async (args) => {
          try {
            const contents = await this.readOPFSFile(args.path, root);
            return {
              contents,
              loader: this.getLoader(args.path),
              resolveDir: this.getDirectory(args.path),
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
   * Get the appropriate esbuild loader for a file extension.
   */
  private getLoader(
    path: string
  ): "js" | "jsx" | "ts" | "tsx" | "json" | "css" {
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
  private getDirectory(path: string): string {
    const lastSlash = path.lastIndexOf("/");
    return lastSlash > 0 ? path.slice(0, lastSlash) : "/";
  }

  /**
   * Resolve a relative path against a base directory.
   */
  private resolvePath(base: string, relative: string): string {
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
}

/**
 * Create a function that imports from a specific OPFS root.
 */
export function createOPFSImporter(
  loader: OPFSModuleLoader,
  opfsRoot: FileSystemDirectoryHandle
): (path: string) => Promise<unknown> {
  return (path: string) => loader.importFromOPFS(path, opfsRoot);
}
