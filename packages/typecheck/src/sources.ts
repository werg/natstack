/**
 * File source abstraction for NatStack type checking.
 *
 * This module provides a unified interface for reading source files from
 * different backends:
 * - Disk: For external development (main process)
 * - Panel: For in-app development (panel/worker context)
 * - Virtual: For testing or synthetic sources
 */

/** Minimal filesystem interface for panel-based file sources. */
export interface ReadableFs {
  readFile(path: string, encoding?: BufferEncoding): Promise<string | Uint8Array>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size?: number; mtime?: number }>;
  exists(path: string): Promise<boolean>;
}

/**
 * File statistics for source files.
 */
export interface FileSourceStats {
  isFile(): boolean;
  isDirectory(): boolean;
  size?: number;
  mtime?: Date;
}

/**
 * Unified interface for reading source files.
 */
export interface FileSource {
  /**
   * Read a file's contents as a string.
   */
  readFile(path: string): Promise<string>;

  /**
   * Read a directory's contents.
   * Returns file/directory names (not full paths).
   */
  readdir(path: string): Promise<string[]>;

  /**
   * Get file/directory statistics.
   */
  stat(path: string): Promise<FileSourceStats>;

  /**
   * Check if a path exists.
   */
  exists(path: string): Promise<boolean>;

  /**
   * Optional: Watch for file changes.
   * Returns an unsubscribe function.
   */
  watch?(
    pattern: string,
    callback: (event: "create" | "change" | "delete", path: string) => void
  ): () => void;
}

/**
 * Create a file source from Node.js filesystem (for main process/external dev).
 */
export function createDiskFileSource(basePath: string): FileSource {
  // Dynamic import for Node.js fs
  let fsModule: typeof import("fs/promises") | null = null;
  let pathModule: typeof import("path") | null = null;

  const ensureModules = async () => {
    if (!fsModule) {
      fsModule = await import("fs/promises");
      pathModule = await import("path");
    }
    return { fs: fsModule, path: pathModule! };
  };

  return {
    async readFile(filePath: string): Promise<string> {
      const { fs, path } = await ensureModules();
      const fullPath = path.resolve(basePath, filePath);
      return fs.readFile(fullPath, "utf-8");
    },

    async readdir(dirPath: string): Promise<string[]> {
      const { fs, path } = await ensureModules();
      const fullPath = path.resolve(basePath, dirPath);
      return fs.readdir(fullPath);
    },

    async stat(filePath: string): Promise<FileSourceStats> {
      const { fs, path } = await ensureModules();
      const fullPath = path.resolve(basePath, filePath);
      const stats = await fs.stat(fullPath);
      return {
        isFile: () => stats.isFile(),
        isDirectory: () => stats.isDirectory(),
        size: stats.size,
        mtime: stats.mtime,
      };
    },

    async exists(filePath: string): Promise<boolean> {
      const { fs, path } = await ensureModules();
      const fullPath = path.resolve(basePath, filePath);
      try {
        await fs.access(fullPath);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Create a file source from the panel filesystem (for in-app dev in panels).
 */
export function createOpfsFileSource(fs: ReadableFs, basePath: string): FileSource {
  const resolvePath = (filePath: string): string => {
    // Simple path resolution for panel filesystem
    if (filePath.startsWith("/")) {
      return filePath;
    }
    const base = basePath.endsWith("/") ? basePath : basePath + "/";
    return base + filePath;
  };

  return {
    async readFile(filePath: string): Promise<string> {
      const fullPath = resolvePath(filePath);
      const content = await fs.readFile(fullPath, "utf-8");
      return typeof content === "string" ? content : new TextDecoder().decode(content);
    },

    async readdir(dirPath: string): Promise<string[]> {
      const fullPath = resolvePath(dirPath);
      return fs.readdir(fullPath);
    },

    async stat(filePath: string): Promise<FileSourceStats> {
      const fullPath = resolvePath(filePath);
      const stats = await fs.stat(fullPath);
      return {
        isFile: () => stats.isFile(),
        isDirectory: () => stats.isDirectory(),
        size: stats.size,
        mtime: stats.mtime ? new Date(stats.mtime) : undefined,
      };
    },

    async exists(filePath: string): Promise<boolean> {
      const fullPath = resolvePath(filePath);
      return fs.exists(fullPath);
    },
  };
}

/**
 * Create a virtual file source from a map of paths to contents.
 * Useful for testing or synthetic sources.
 */
export function createVirtualFileSource(
  files: Map<string, string> | Record<string, string>
): FileSource {
  const fileMap = files instanceof Map ? files : new Map(Object.entries(files));

  // Build directory structure
  const directories = new Set<string>();
  for (const path of fileMap.keys()) {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += "/" + parts[i];
      directories.add(current);
    }
  }

  return {
    async readFile(filePath: string): Promise<string> {
      const normalized = filePath.startsWith("/") ? filePath : "/" + filePath;
      const content = fileMap.get(normalized);
      if (content === undefined) {
        throw new Error(`File not found: ${filePath}`);
      }
      return content;
    },

    async readdir(dirPath: string): Promise<string[]> {
      const normalized = dirPath.startsWith("/") ? dirPath : "/" + dirPath;
      const normalizedDir = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;

      const entries = new Set<string>();

      // Find files in this directory
      for (const path of fileMap.keys()) {
        if (path.startsWith(normalizedDir + "/")) {
          const rest = path.slice(normalizedDir.length + 1);
          const firstPart = rest.split("/")[0];
          if (firstPart) {
            entries.add(firstPart);
          }
        }
      }

      // Find subdirectories
      for (const dir of directories) {
        if (dir.startsWith(normalizedDir + "/")) {
          const rest = dir.slice(normalizedDir.length + 1);
          const firstPart = rest.split("/")[0];
          if (firstPart) {
            entries.add(firstPart);
          }
        }
      }

      return [...entries];
    },

    async stat(filePath: string): Promise<FileSourceStats> {
      const normalized = filePath.startsWith("/") ? filePath : "/" + filePath;

      if (fileMap.has(normalized)) {
        const content = fileMap.get(normalized)!;
        return {
          isFile: () => true,
          isDirectory: () => false,
          size: content.length,
        };
      }

      const normalizedDir = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
      if (directories.has(normalizedDir) || normalizedDir === "") {
        return {
          isFile: () => false,
          isDirectory: () => true,
        };
      }

      throw new Error(`Path not found: ${filePath}`);
    },

    async exists(filePath: string): Promise<boolean> {
      const normalized = filePath.startsWith("/") ? filePath : "/" + filePath;
      if (fileMap.has(normalized)) {
        return true;
      }
      const normalizedDir = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
      return directories.has(normalizedDir);
    },
  };
}

/**
 * Recursively find all TypeScript files in a file source.
 * @param dir - Starting directory. Use "." for FileSource's basePath (default).
 *              Using "/" would scan from absolute root, bypassing basePath.
 * @returns Array of relative file paths (e.g., "index.tsx", "components/File.tsx").
 *          Paths are normalized to remove "./" prefixes for consistency with
 *          TypeScript's language service expectations.
 */
export async function findTypeScriptFiles(
  source: FileSource,
  dir: string = "."
): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    try {
      const entries = await source.readdir(currentDir);

      for (const entry of entries) {
        // Skip node_modules, hidden directories, and test directories
        if (entry === "node_modules" || entry.startsWith(".") || entry === "__tests__") {
          continue;
        }

        const entryPath = currentDir.endsWith("/")
          ? currentDir + entry
          : currentDir + "/" + entry;

        try {
          const stats = await source.stat(entryPath);

          if (stats.isDirectory()) {
            await walk(entryPath);
          } else if (stats.isFile()) {
            // Skip test files (.test.ts, .test.tsx, .spec.ts, .spec.tsx)
            const isTestFile = /\.(test|spec)\.(ts|tsx)$/.test(entry);
            if (!isTestFile && (entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
              // Normalize path: remove leading "./" to get clean relative path
              // Keep paths relative (not starting with /) so FileSource can resolve them
              let normalizedPath = entryPath;
              while (normalizedPath.startsWith("./")) {
                normalizedPath = normalizedPath.slice(2); // "./foo" -> "foo"
              }
              files.push(normalizedPath);
            }
          }
        } catch {
          // Skip entries we can't stat
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
  }

  await walk(dir);
  return files;
}

/**
 * Load all TypeScript files from a file source into a map.
 * @param dir - Starting directory. Use "." for FileSource's basePath (default).
 */
export async function loadSourceFiles(
  source: FileSource,
  dir: string = "."
): Promise<Map<string, string>> {
  const files = await findTypeScriptFiles(source, dir);
  const contents = new Map<string, string>();

  for (const file of files) {
    try {
      const content = await source.readFile(file);
      contents.set(file, content);
    } catch {
      // Skip files we can't read
    }
  }

  return contents;
}
