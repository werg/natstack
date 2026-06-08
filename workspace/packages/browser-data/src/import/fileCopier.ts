import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BrowserDataError } from "../errors.js";

/**
 * Atomically copy a SQLite database (and its WAL/SHM files) to a temp directory.
 *
 * This avoids locking issues when the source browser is running. The copy is
 * not a snapshot — it's a best-effort copy of the files at a point in time.
 * SQLite's WAL recovery will handle any minor inconsistencies on open.
 *
 * @returns Path to the copied database file in the temp directory
 */
export async function copyDatabaseToTemp(dbPath: string): Promise<string> {
  if (!fs.existsSync(dbPath)) {
    throw new BrowserDataError(
      "PROFILE_NOT_FOUND",
      `Database not found: ${dbPath}`,
    );
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-browser-import-"));
  const dbName = path.basename(dbPath);
  const destPath = path.join(tmpDir, dbName);

  try {
    // Copy main DB file
    fs.copyFileSync(dbPath, destPath);

    // Copy WAL file if it exists
    const walPath = dbPath + "-wal";
    if (fs.existsSync(walPath)) {
      fs.copyFileSync(walPath, path.join(tmpDir, dbName + "-wal"));
    }

    // Copy SHM file if it exists
    const shmPath = dbPath + "-shm";
    if (fs.existsSync(shmPath)) {
      fs.copyFileSync(shmPath, path.join(tmpDir, dbName + "-shm"));
    }
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    // Clean up temp dir on failure
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    if (error.code === "EBUSY" || error.code === "EACCES" || error.code === "EPERM") {
      throw new BrowserDataError(
        "DB_LOCKED",
        `Database is locked (browser may be running): ${dbPath}`,
        error.code,
      );
    }
    throw new BrowserDataError(
      "PERMISSION_DENIED",
      `Failed to copy database: ${dbPath}`,
      error.message,
    );
  }

  return destPath;
}

/**
 * Copy a non-database file to a temp directory.
 */
export async function copyFileToTemp(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new BrowserDataError(
      "PROFILE_NOT_FOUND",
      `File not found: ${filePath}`,
    );
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-browser-import-"));
  const destPath = path.join(tmpDir, path.basename(filePath));

  try {
    fs.copyFileSync(filePath, destPath);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    if (error.code === "EPERM" || error.code === "EACCES") {
      throw new BrowserDataError(
        "TCC_ACCESS_DENIED",
        `Permission denied: ${filePath}`,
        error.code,
      );
    }
    throw error;
  }

  return destPath;
}

/**
 * Clean up a temp directory created by copyDatabaseToTemp or copyFileToTemp.
 */
export function cleanupTempCopy(tempFilePath: string): void {
  try {
    const dir = path.dirname(tempFilePath);
    if (dir.includes("natstack-browser-import-")) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup
  }
}
