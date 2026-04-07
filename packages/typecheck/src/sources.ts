/**
 * File source abstraction for the type checker.
 *
 * Two consumers today:
 *   - `createDiskFileSource` reads source files from the Node filesystem.
 *   - `loadSourceFiles` walks a source recursively and returns a relative
 *     path → content map for feeding into `TypeCheckService.updateFile`.
 *
 * The panel-side OPFS / virtual sources that used to live here were
 * deleted once the server-side type checker became the only real consumer.
 * If a browser-hosted typecheck comes back, reintroduce them then.
 */

/** Stat result for a source file. */
export interface FileSourceStats {
  isFile(): boolean;
  isDirectory(): boolean;
  size?: number;
  mtime?: Date;
}

/**
 * Unified interface for reading source files from disk (or in theory any
 * other backend — today only the disk implementation remains).
 */
export interface FileSource {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<FileSourceStats>;
  exists(path: string): Promise<boolean>;
}

/**
 * Create a file source from the Node filesystem. All paths are resolved
 * relative to `basePath`.
 */
export function createDiskFileSource(basePath: string): FileSource {
  // Dynamic import so this module can be loaded in contexts that bundle
  // for the browser, as long as nobody calls it there.
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
      return fs.readFile(path.resolve(basePath, filePath), "utf-8");
    },

    async readdir(dirPath: string): Promise<string[]> {
      const { fs, path } = await ensureModules();
      return fs.readdir(path.resolve(basePath, dirPath));
    },

    async stat(filePath: string): Promise<FileSourceStats> {
      const { fs, path } = await ensureModules();
      const stats = await fs.stat(path.resolve(basePath, filePath));
      return {
        isFile: () => stats.isFile(),
        isDirectory: () => stats.isDirectory(),
        size: stats.size,
        mtime: stats.mtime,
      };
    },

    async exists(filePath: string): Promise<boolean> {
      const { fs, path } = await ensureModules();
      try {
        await fs.access(path.resolve(basePath, filePath));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Recursively find all non-test TypeScript files in a file source.
 *
 * Skips `node_modules`, dotfiles, and test files (`.test.ts` / `.spec.ts`).
 * Returned paths are normalized to clean relative form (no leading `./`)
 * so they can be passed to `TypeCheckService.updateFile`.
 */
async function findTypeScriptFiles(source: FileSource, dir: string = "."): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await source.readdir(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry === "node_modules" || entry.startsWith(".") || entry === "__tests__") continue;

      const entryPath = currentDir.endsWith("/") ? currentDir + entry : currentDir + "/" + entry;

      let stats: FileSourceStats;
      try {
        stats = await source.stat(entryPath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!stats.isFile()) continue;

      const isTestFile = /\.(test|spec)\.(ts|tsx)$/.test(entry);
      if (isTestFile) continue;
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;

      let normalizedPath = entryPath;
      while (normalizedPath.startsWith("./")) normalizedPath = normalizedPath.slice(2);
      files.push(normalizedPath);
    }
  }

  await walk(dir);
  return files;
}

/**
 * Load all TypeScript source files from a file source into a path → content
 * map. The caller is expected to pass each entry through
 * `TypeCheckService.updateFile` (typically resolving the relative path to
 * an absolute one first).
 */
export async function loadSourceFiles(
  source: FileSource,
  dir: string = ".",
): Promise<Map<string, string>> {
  const files = await findTypeScriptFiles(source, dir);
  const contents = new Map<string, string>();

  for (const file of files) {
    try {
      contents.set(file, await source.readFile(file));
    } catch {
      // Skip files we can't read
    }
  }

  return contents;
}
