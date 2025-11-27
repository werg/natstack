import type { BuildFileSystem } from "./types.js";

/**
 * OPFS-backed file system for browser builds
 * Uses the Origin Private File System API via ZenFS
 */
export class OpfsFileSystem implements BuildFileSystem {
  private fs: typeof import("@zenfs/core").fs;
  private promises: typeof import("@zenfs/core").promises;

  constructor(
    zenFs: typeof import("@zenfs/core").fs,
    zenPromises: typeof import("@zenfs/core").promises
  ) {
    this.fs = zenFs;
    this.promises = zenPromises;
  }

  async readFile(path: string): Promise<string> {
    return this.promises.readFile(path, "utf-8");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const buffer = await this.promises.readFile(path);
    return new Uint8Array(buffer);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.promises.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.promises.readdir(path);
    return entries as string[];
  }

  async isDirectory(path: string): Promise<boolean> {
    try {
      const stat = await this.promises.stat(path);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async glob(pattern: string, basePath: string): Promise<string[]> {
    // Simple glob implementation for OPFS
    // Supports basic patterns like "**/*.ts", "*.tsx"
    const results: string[] = [];
    await this.walkDir(basePath, pattern, results);
    return results;
  }

  private async walkDir(
    dir: string,
    pattern: string,
    results: string[]
  ): Promise<void> {
    const entries = await this.readdir(dir);

    for (const entry of entries) {
      const fullPath = this.joinPath(dir, entry);
      const isDir = await this.isDirectory(fullPath);

      if (isDir) {
        // Skip node_modules and hidden directories
        if (entry !== "node_modules" && !entry.startsWith(".")) {
          await this.walkDir(fullPath, pattern, results);
        }
      } else {
        if (this.matchesPattern(entry, fullPath, pattern)) {
          results.push(fullPath);
        }
      }
    }
  }

  private matchesPattern(
    filename: string,
    fullPath: string,
    pattern: string
  ): boolean {
    // Simple pattern matching
    if (pattern.startsWith("**/*.")) {
      const ext = pattern.slice(4); // Get extension after "**/*"
      return filename.endsWith(ext);
    }
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1);
      return filename.endsWith(ext);
    }
    // Exact match
    return filename === pattern || fullPath.endsWith(pattern);
  }

  private joinPath(...parts: string[]): string {
    return parts
      .join("/")
      .replace(/\/+/g, "/")
      .replace(/\/$/, "");
  }
}

/**
 * Create an OPFS file system instance
 * Must be called after ZenFS is initialized
 */
export async function createOpfsFileSystem(): Promise<OpfsFileSystem> {
  // Dynamic import to avoid issues in non-browser environments
  const { fs, promises } = await import("@zenfs/core");
  return new OpfsFileSystem(fs, promises);
}
