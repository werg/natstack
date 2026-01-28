/**
 * Package Store SQLite Schema
 *
 * Content-addressable storage for npm packages.
 * Files are stored by SHA256 hash and hard-linked into node_modules.
 */

// =============================================================================
// TypeScript Interfaces
// =============================================================================

/**
 * A file stored in the content-addressed store.
 */
export interface StoredFile {
  /** SHA256 hash of file content */
  hash: string;
  /** File size in bytes */
  size: number;
  /** Unix file mode (permissions) */
  mode: number;
  /** Whether this is a symlink */
  isSymlink: boolean;
  /** Symlink target path (only if isSymlink) */
  symlinkTarget?: string;
}

/**
 * Manifest for a package version in the store.
 */
export interface PackageManifest {
  /** Database row ID */
  id: number;
  /** Package name (e.g., "react" or "@types/node") */
  name: string;
  /** Package version (e.g., "18.2.0") */
  version: string;
  /** npm integrity hash (SHA512) */
  integrity: string;
  /** Unix timestamp when package was fetched */
  fetchedAt: number;
  /** Unix timestamp when package was last accessed (for GC) */
  lastAccessed: number;
  /** Map of relative path -> file info */
  files: Map<string, StoredFile>;
}

/**
 * Options for garbage collection.
 */
export interface GCOptions {
  /** Remove packages not accessed in N milliseconds (default: 30 days) */
  olderThan?: number;
  /** Keep N most recent versions per package */
  keepVersions?: number;
  /** If true, only report what would be removed without deleting */
  dryRun?: boolean;
}

/**
 * Result of garbage collection.
 */
export interface GCResult {
  /** Number of package versions removed */
  packagesRemoved: number;
  /** Number of content files removed */
  filesRemoved: number;
  /** Bytes freed on disk */
  bytesFreed: number;
}

/**
 * Options for resolution caching.
 */
export interface ResolutionCacheEntry {
  /** SHA256 hash of sorted dependencies object */
  depsHash: string;
  /** Serialized tree structure */
  treeJson: string;
  /** Unix timestamp when cached */
  createdAt: number;
}

// =============================================================================
// SQLite Schema
// =============================================================================

/**
 * SQL statements to initialize the package store database.
 */
export const SCHEMA_SQL = `
-- Package versions
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  integrity TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL,
  UNIQUE(name, version)
);

-- Content-addressed files
CREATE TABLE IF NOT EXISTS files (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mode INTEGER NOT NULL,
  is_symlink INTEGER NOT NULL DEFAULT 0,
  symlink_target TEXT
);

-- Package -> files mapping (junction table)
CREATE TABLE IF NOT EXISTS package_files (
  package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  file_hash TEXT NOT NULL REFERENCES files(hash),
  relative_path TEXT NOT NULL,
  PRIMARY KEY (package_id, relative_path)
);

-- Cached resolution results per deps directory
CREATE TABLE IF NOT EXISTS resolution_cache (
  deps_hash TEXT PRIMARY KEY,
  tree_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_packages_name ON packages(name);
CREATE INDEX IF NOT EXISTS idx_packages_last_accessed ON packages(last_accessed);
CREATE INDEX IF NOT EXISTS idx_package_files_hash ON package_files(file_hash);
`;

// =============================================================================
// Database Row Types (for SQLite queries)
// =============================================================================

export interface PackageRow {
  id: number;
  name: string;
  version: string;
  integrity: string;
  fetched_at: number;
  last_accessed: number;
}

export interface FileRow {
  hash: string;
  size: number;
  mode: number;
  is_symlink: number;
  symlink_target: string | null;
}

export interface PackageFileRow {
  package_id: number;
  file_hash: string;
  relative_path: string;
}

export interface ResolutionCacheRow {
  deps_hash: string;
  tree_json: string;
  created_at: number;
}
