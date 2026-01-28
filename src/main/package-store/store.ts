/**
 * PackageStore - Content-addressable storage for npm packages.
 *
 * Files are stored by SHA256 hash and hard-linked into node_modules.
 * This eliminates redundant package installations across panels and workspaces.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getDatabaseManager } from "../db/databaseManager.js";
import { getCentralConfigDirectory } from "../paths.js";
import {
  SCHEMA_SQL,
  type PackageManifest,
  type StoredFile,
  type PackageRow,
  type FileRow,
  type PackageFileRow,
  type ResolutionCacheEntry,
  type ResolutionCacheRow,
} from "./schema.js";

const STORE_VERSION = "v1";
const STORE_OWNER_ID = "package-store";

/**
 * Get the default package store directory.
 * Location: ~/.config/natstack/package-store/v1/ (or platform equivalent)
 */
export function getDefaultStoreDir(): string {
  return path.join(getCentralConfigDirectory(), "package-store", STORE_VERSION);
}

/**
 * PackageStore manages content-addressable storage for npm packages.
 *
 * Key features:
 * - Files stored by SHA256 hash (deduplication across all packages)
 * - SQLite for metadata (package manifests, file index, access tracking)
 * - Hard-linking from store to node_modules for space efficiency
 * - Symlink recreation (hard-linking symlinks fails on most systems)
 */
export class PackageStore {
  private storeDir: string;
  private dbPath: string;
  private dbHandle: string | null = null;
  private initialized = false;

  constructor(storeDir?: string) {
    this.storeDir = storeDir ?? getDefaultStoreDir();
    this.dbPath = path.join(this.storeDir, "store.db");
  }

  /**
   * Initialize the store: create directories and database schema.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Create store directory
    fs.mkdirSync(this.storeDir, { recursive: true });
    fs.mkdirSync(path.join(this.storeDir, "files"), { recursive: true });

    // Open database
    const db = getDatabaseManager();
    this.dbHandle = db.openAtPath(STORE_OWNER_ID, this.dbPath);

    // Create schema
    db.exec(this.dbHandle, SCHEMA_SQL);

    this.initialized = true;
  }

  /**
   * Get the store directory path.
   */
  getStoreDir(): string {
    return this.storeDir;
  }

  /**
   * Check if a package version exists in the store.
   */
  hasPackage(name: string, version: string): boolean {
    this.ensureInitialized();
    const db = getDatabaseManager();
    const row = db.get<PackageRow>(
      this.dbHandle!,
      "SELECT id FROM packages WHERE name = ? AND version = ?",
      [name, version]
    );
    return row !== null;
  }

  /**
   * Get manifest for a package version.
   * Returns null if package not in store.
   * Does NOT update last_accessed (use touchPackage for that).
   */
  getManifest(name: string, version: string): PackageManifest | null {
    this.ensureInitialized();
    const db = getDatabaseManager();

    // Get package row
    const pkg = db.get<PackageRow>(
      this.dbHandle!,
      "SELECT * FROM packages WHERE name = ? AND version = ?",
      [name, version]
    );
    if (!pkg) return null;

    // Get all files for this package
    const fileRows = db.query<PackageFileRow & FileRow>(
      this.dbHandle!,
      `SELECT pf.relative_path, f.hash, f.size, f.mode, f.is_symlink, f.symlink_target
       FROM package_files pf
       JOIN files f ON pf.file_hash = f.hash
       WHERE pf.package_id = ?`,
      [pkg.id]
    );

    const files = new Map<string, StoredFile>();
    for (const row of fileRows) {
      files.set(row.relative_path, {
        hash: row.hash,
        size: row.size,
        mode: row.mode,
        isSymlink: row.is_symlink === 1,
        symlinkTarget: row.symlink_target ?? undefined,
      });
    }

    return {
      id: pkg.id,
      name: pkg.name,
      version: pkg.version,
      integrity: pkg.integrity,
      fetchedAt: pkg.fetched_at,
      lastAccessed: pkg.last_accessed,
      files,
    };
  }

  /**
   * Store a package from an extracted tarball directory.
   *
   * @param name - Package name
   * @param version - Package version
   * @param extractedDir - Directory containing extracted package contents
   * @param integrity - npm integrity hash (SHA512)
   */
  async storePackage(
    name: string,
    version: string,
    extractedDir: string,
    integrity: string
  ): Promise<PackageManifest> {
    this.ensureInitialized();
    const db = getDatabaseManager();
    const now = Date.now();

    // Check if already stored (fast path)
    const existing = this.getManifest(name, version);
    if (existing) return existing;

    // Walk directory and collect files
    const files = new Map<string, StoredFile>();
    await this.walkAndStoreFiles(extractedDir, "", files);

    // Insert package record with conflict handling for concurrent fetchers.
    // Use INSERT OR IGNORE to handle race where another process inserted between
    // our getManifest() check and this INSERT.
    const pkgResult = db.run(
      this.dbHandle!,
      `INSERT OR IGNORE INTO packages (name, version, integrity, fetched_at, last_accessed)
       VALUES (?, ?, ?, ?, ?)`,
      [name, version, integrity, now, now]
    );

    // If insert was ignored (changes=0), another process won the race - return their result
    if (pkgResult.changes === 0) {
      const raceWinner = this.getManifest(name, version);
      if (raceWinner) return raceWinner;
      // Should not happen, but fall through to error if it does
      throw new Error(`Failed to store or retrieve package ${name}@${version}`);
    }

    const packageId = Number(pkgResult.lastInsertRowid);

    // Insert file mappings
    for (const [relativePath, file] of files) {
      db.run(
        this.dbHandle!,
        `INSERT OR IGNORE INTO files (hash, size, mode, is_symlink, symlink_target)
         VALUES (?, ?, ?, ?, ?)`,
        [file.hash, file.size, file.mode, file.isSymlink ? 1 : 0, file.symlinkTarget ?? null]
      );

      db.run(
        this.dbHandle!,
        `INSERT INTO package_files (package_id, file_hash, relative_path)
         VALUES (?, ?, ?)`,
        [packageId, file.hash, relativePath]
      );
    }

    return {
      id: packageId,
      name,
      version,
      integrity,
      fetchedAt: now,
      lastAccessed: now,
      files,
    };
  }

  /**
   * Walk a directory recursively and store files in the content-addressed store.
   */
  private async walkAndStoreFiles(
    baseDir: string,
    relativePath: string,
    files: Map<string, StoredFile>
  ): Promise<void> {
    const fullPath = path.join(baseDir, relativePath);
    const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryRelPath = relativePath ? path.join(relativePath, entry.name) : entry.name;
      const entryFullPath = path.join(baseDir, entryRelPath);

      if (entry.isSymbolicLink()) {
        // Store symlink target (we'll recreate the symlink when linking)
        const target = await fs.promises.readlink(entryFullPath);
        const stats = await fs.promises.lstat(entryFullPath);

        // For symlinks, use a hash of the target path
        const hash = crypto.createHash("sha256").update(target).digest("hex");

        files.set(entryRelPath, {
          hash,
          size: 0,
          mode: stats.mode,
          isSymlink: true,
          symlinkTarget: target,
        });
      } else if (entry.isDirectory()) {
        await this.walkAndStoreFiles(baseDir, entryRelPath, files);
      } else if (entry.isFile()) {
        // Read file and compute hash
        const content = await fs.promises.readFile(entryFullPath);
        const hash = crypto.createHash("sha256").update(content).digest("hex");
        const stats = await fs.promises.stat(entryFullPath);

        // Store file content if not already in store
        const storePath = this.getFilePath(hash);
        if (!fs.existsSync(storePath)) {
          await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
          await fs.promises.writeFile(storePath, content, { mode: stats.mode });
        }

        files.set(entryRelPath, {
          hash,
          size: content.length,
          mode: stats.mode,
          isSymlink: false,
        });
      }
      // Skip other file types (sockets, etc.)
    }
  }

  /**
   * Get the file path in the store for a given hash.
   * Files are stored in a two-level directory structure: files/ab/ab12cd...
   */
  getFilePath(hash: string): string {
    return path.join(this.storeDir, "files", hash.slice(0, 2), hash);
  }

  /**
   * Link a package from the store to a target directory.
   * Creates hard links for regular files and recreates symlinks.
   *
   * @param name - Package name
   * @param version - Package version
   * @param targetDir - Directory to link into (the package root, e.g., node_modules/react)
   */
  async linkPackage(name: string, version: string, targetDir: string): Promise<void> {
    const manifest = this.getManifest(name, version);
    if (!manifest) {
      throw new Error(`Package not in store: ${name}@${version}`);
    }

    // Update last_accessed for GC tracking
    this.touchPackage(name, version);

    // Create target directory
    await fs.promises.mkdir(targetDir, { recursive: true });

    for (const [relativePath, file] of manifest.files) {
      const targetPath = path.join(targetDir, relativePath);
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

      // Remove existing file/symlink if present
      try {
        await fs.promises.unlink(targetPath);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }

      if (file.isSymlink) {
        // Recreate symlink (can't hard-link a symlink)
        await fs.promises.symlink(file.symlinkTarget!, targetPath);
      } else {
        // Hard link regular file from store
        const storePath = this.getFilePath(file.hash);
        try {
          await fs.promises.link(storePath, targetPath);
        } catch (e: unknown) {
          // If hard link fails (e.g., cross-device), fall back to copy
          if ((e as NodeJS.ErrnoException).code === "EXDEV") {
            await fs.promises.copyFile(storePath, targetPath);
            await fs.promises.chmod(targetPath, file.mode);
          } else {
            throw e;
          }
        }
      }
    }
  }

  /**
   * Update the last_accessed timestamp for a package.
   * Called when a package is linked to node_modules.
   */
  touchPackage(name: string, version: string): void {
    this.ensureInitialized();
    const db = getDatabaseManager();
    db.run(
      this.dbHandle!,
      "UPDATE packages SET last_accessed = ? WHERE name = ? AND version = ?",
      [Date.now(), name, version]
    );
  }

  /**
   * Get cached resolution result for a dependencies hash.
   */
  getResolutionCache(depsHash: string): ResolutionCacheEntry | null {
    this.ensureInitialized();
    const db = getDatabaseManager();
    const row = db.get<ResolutionCacheRow>(
      this.dbHandle!,
      "SELECT * FROM resolution_cache WHERE deps_hash = ?",
      [depsHash]
    );
    if (!row) return null;
    return {
      depsHash: row.deps_hash,
      treeJson: row.tree_json,
      createdAt: row.created_at,
    };
  }

  /**
   * Set cached resolution result for a dependencies hash.
   */
  setResolutionCache(depsHash: string, treeJson: string): void {
    this.ensureInitialized();
    const db = getDatabaseManager();
    db.run(
      this.dbHandle!,
      `INSERT OR REPLACE INTO resolution_cache (deps_hash, tree_json, created_at)
       VALUES (?, ?, ?)`,
      [depsHash, treeJson, Date.now()]
    );
  }

  /**
   * Clear resolution cache entries older than a given age.
   */
  clearOldResolutionCache(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): number {
    this.ensureInitialized();
    const db = getDatabaseManager();
    const cutoff = Date.now() - olderThanMs;
    const result = db.run(
      this.dbHandle!,
      "DELETE FROM resolution_cache WHERE created_at < ?",
      [cutoff]
    );
    return result.changes;
  }

  /**
   * Get store statistics.
   */
  getStats(): {
    packageCount: number;
    fileCount: number;
    totalSize: number;
  } {
    this.ensureInitialized();
    const db = getDatabaseManager();

    const pkgCount = db.get<{ count: number }>(
      this.dbHandle!,
      "SELECT COUNT(*) as count FROM packages"
    );
    const fileCount = db.get<{ count: number }>(
      this.dbHandle!,
      "SELECT COUNT(*) as count FROM files"
    );
    const totalSize = db.get<{ total: number }>(
      this.dbHandle!,
      "SELECT COALESCE(SUM(size), 0) as total FROM files"
    );

    return {
      packageCount: pkgCount?.count ?? 0,
      fileCount: fileCount?.count ?? 0,
      totalSize: totalSize?.total ?? 0,
    };
  }

  /**
   * Shutdown the store: close database connection.
   */
  shutdown(): void {
    if (this.dbHandle) {
      const db = getDatabaseManager();
      db.close(this.dbHandle);
      this.dbHandle = null;
      this.initialized = false;
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.dbHandle) {
      throw new Error("PackageStore not initialized. Call init() first.");
    }
  }
}

// =============================================================================
// Singleton instance
// =============================================================================

let storeInstance: PackageStore | null = null;

/**
 * Get the singleton PackageStore instance.
 * Initializes the store on first call.
 */
export async function getPackageStore(): Promise<PackageStore> {
  if (!storeInstance) {
    storeInstance = new PackageStore();
    await storeInstance.init();
  }
  return storeInstance;
}

/**
 * Shutdown the package store.
 */
export function shutdownPackageStore(): void {
  if (storeInstance) {
    storeInstance.shutdown();
    storeInstance = null;
  }
}
