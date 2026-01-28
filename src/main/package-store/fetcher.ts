/**
 * PackageFetcher - Fetches npm packages with concurrency control.
 *
 * Uses pacote for package fetching with:
 * - Per-package locking to prevent duplicate fetches
 * - Concurrency limiting via p-limit
 * - Integrity verification
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import pacote from "pacote";
import pLimit from "p-limit";
import { PackageStore, getPackageStore } from "./store.js";
import type { PackageManifest } from "./schema.js";

/**
 * Package specification for fetching.
 */
export interface PackageSpec {
  name: string;
  version: string;
  integrity?: string;
}

/**
 * Options for package fetching.
 */
export interface FetchOptions {
  /** npm registry URL */
  registry?: string;
  /** Maximum concurrent fetches (default: 10) */
  concurrency?: number;
}

/**
 * PackageFetcher fetches npm packages and stores them in the content-addressed store.
 */
export class PackageFetcher {
  private store: PackageStore;
  private registry: string;

  /** Per-package fetch locks to deduplicate concurrent requests */
  private fetchLocks = new Map<string, Promise<PackageManifest>>();

  constructor(store: PackageStore, registry: string) {
    this.store = store;
    this.registry = registry;
  }

  /**
   * Fetch a package, store in content-addressed store, return manifest.
   * Uses per-package locking to prevent duplicate fetches.
   */
  async fetch(name: string, version: string, integrity?: string): Promise<PackageManifest> {
    const key = `${name}@${version}`;

    // Fast path: check store first
    const existing = this.store.getManifest(name, version);
    if (existing) return existing;

    // Check if fetch already in progress (deduplicate concurrent requests)
    const inFlight = this.fetchLocks.get(key);
    if (inFlight) return inFlight;

    // Start fetch with lock
    const fetchPromise = this.doFetch(name, version, integrity);
    this.fetchLocks.set(key, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.fetchLocks.delete(key);
    }
  }

  /**
   * Internal fetch implementation.
   */
  private async doFetch(
    name: string,
    version: string,
    integrity?: string
  ): Promise<PackageManifest> {
    const spec = `${name}@${version}`;
    const tempDir = path.join(
      os.tmpdir(),
      `natstack-fetch-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
    );

    try {
      // Get package manifest from registry
      const pkgManifest = await pacote.manifest(spec, {
        registry: this.registry,
        fullMetadata: true,
      });

      // Determine integrity to verify
      const integrityToVerify = integrity || (pkgManifest as { _integrity?: string })._integrity;

      // Extract package to temp directory
      await fs.promises.mkdir(tempDir, { recursive: true });
      await pacote.extract(spec, tempDir, {
        registry: this.registry,
        // Only pass integrity option if we have a value (undefined/empty can cause issues)
        ...(integrityToVerify ? { integrity: integrityToVerify } : {}),
      });

      // Store in content-addressed store
      return await this.store.storePackage(
        name,
        version,
        tempDir,
        integrityToVerify || ""
      );
    } finally {
      // Clean up temp directory
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Batch fetch multiple packages with concurrency control.
   * Deduplicates and limits parallel fetches.
   */
  async fetchAll(
    packages: PackageSpec[],
    options?: { concurrency?: number }
  ): Promise<Map<string, PackageManifest>> {
    const limit = pLimit(options?.concurrency ?? 10);
    const results = new Map<string, PackageManifest>();

    // Deduplicate package specs
    const uniquePackages = new Map<string, PackageSpec>();
    for (const pkg of packages) {
      const key = `${pkg.name}@${pkg.version}`;
      if (!uniquePackages.has(key)) {
        uniquePackages.set(key, pkg);
      }
    }

    await Promise.all(
      Array.from(uniquePackages.values()).map(({ name, version, integrity }) =>
        limit(async () => {
          const manifest = await this.fetch(name, version, integrity);
          results.set(`${name}@${version}`, manifest);
        })
      )
    );

    return results;
  }
}

// =============================================================================
// Factory function
// =============================================================================

/**
 * Create a PackageFetcher instance.
 */
export async function createPackageFetcher(registry: string): Promise<PackageFetcher> {
  const store = await getPackageStore();
  return new PackageFetcher(store, registry);
}
