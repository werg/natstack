/**
 * NatstackPackageWatcher - File watcher for builtin @natstack/* packages.
 *
 * Watches the packages/ directory for file changes and proactively triggers
 * republishes to Verdaccio. This enables instant iteration on @natstack/*
 * packages during development without requiring git commits.
 *
 * When a package is republished, Verdaccio's existing transitive invalidation
 * logic (via DependencyGraph.getAffectedConsumers) invalidates all consumers.
 *
 * NOTE: Startup synchronization is handled by VerdaccioServer.publishChangedPackages(),
 * which compares expected vs actual versions. This watcher only handles runtime
 * file change detection.
 */

import * as path from "path";
import * as fs from "fs";
import chokidar, { type FSWatcher } from "chokidar";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("NatstackWatcher");

const DEBOUNCE_MS = 500; // Debounce file changes before republishing

/**
 * Callback to republish a package.
 * Returns "published" if actually published, "skipped" if unchanged.
 */
type RepublishCallback = (pkgPath: string, pkgName: string) => Promise<"published" | "skipped">;

export class NatstackPackageWatcher {
  private packagesDir: string;
  private watcher: FSWatcher | null = null;
  private republishCallback: RepublishCallback | null = null;
  private pendingRepublishes = new Map<string, NodeJS.Timeout>();
  private isInitialized = false;

  constructor(workspaceRoot: string) {
    this.packagesDir = path.join(workspaceRoot, "packages");
  }

  /**
   * Initialize the watcher with a republish callback.
   * This should be called after VerdaccioServer is ready and has synced packages.
   *
   * NOTE: Startup synchronization is handled by VerdaccioServer.publishChangedPackages()
   * before this is called. This watcher only handles runtime file changes.
   */
  async initialize(republishCallback: RepublishCallback): Promise<void> {
    if (this.isInitialized) return;

    this.republishCallback = republishCallback;
    this.isInitialized = true;

    // Start watching for live changes (startup sync is done by VerdaccioServer)
    this.startWatching();

    log.info(`Watching ${this.packagesDir} for changes`);
  }

  /**
   * Start watching for file changes.
   */
  private startWatching(): void {
    if (!fs.existsSync(this.packagesDir)) {
      log.warn(`Packages directory not found: ${this.packagesDir}`);
      return;
    }

    this.watcher = chokidar.watch(this.packagesDir, {
      ignored: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/coverage/**",
        "**/*.log",
        "**/.DS_Store",
      ],
      persistent: true,
      ignoreInitial: true, // Don't trigger on existing files
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher.on("change", (filePath: string) => this.onFileChange(filePath, "change"));
    this.watcher.on("add", (filePath: string) => this.onFileChange(filePath, "add"));
    this.watcher.on("unlink", (filePath: string) => this.onFileChange(filePath, "unlink"));

    this.watcher.on("error", (error: unknown) => {
      console.error("[NatstackWatcher] Watcher error:", error);
    });
  }

  /**
   * Handle a file change event.
   */
  private onFileChange(filePath: string, eventType: string): void {
    // Determine which package this file belongs to
    const pkgInfo = this.getPackageForFile(filePath);
    if (!pkgInfo) return;

    const { pkgPath, pkgName } = pkgInfo;

    log.verbose(` File ${eventType}: ${path.relative(this.packagesDir, filePath)} -> ${pkgName}`);

    // Debounce: cancel any pending republish for this package and reschedule
    const existingTimeout = this.pendingRepublishes.get(pkgName);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    const timeout = setTimeout(async () => {
      this.pendingRepublishes.delete(pkgName);
      await this.triggerRepublish(pkgPath, pkgName);
    }, DEBOUNCE_MS);

    this.pendingRepublishes.set(pkgName, timeout);
  }

  /**
   * Determine which package a file belongs to.
   */
  private getPackageForFile(filePath: string): { pkgPath: string; pkgName: string } | null {
    const relativePath = path.relative(this.packagesDir, filePath);
    const parts = relativePath.split(path.sep);

    if (parts.length < 2) return null;

    const firstPart = parts[0];
    const secondPart = parts[1];
    if (!firstPart || !secondPart) return null;

    let pkgDir: string;
    if (firstPart.startsWith("@")) {
      // Scoped package: @natstack/foo
      if (parts.length < 3) return null;
      pkgDir = path.join(this.packagesDir, firstPart, secondPart);
    } else {
      // Non-scoped package
      pkgDir = path.join(this.packagesDir, firstPart);
    }

    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) return null;

    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as { name: string; private?: boolean };
      if (pkgJson.private) return null;
      return { pkgPath: pkgDir, pkgName: pkgJson.name };
    } catch {
      return null;
    }
  }

  /**
   * Trigger a republish for a package.
   */
  private async triggerRepublish(pkgPath: string, pkgName: string): Promise<void> {
    if (!this.republishCallback) {
      log.warn(` Cannot republish ${pkgName}: no callback registered`);
      return;
    }

    try {
      log.verbose(` Triggering republish for ${pkgName}`);
      const result = await this.republishCallback(pkgPath, pkgName);
      if (result === "published") {
        log.info(`Republished ${pkgName} (file change detected)`);
      }
    } catch (err) {
      console.error(`[NatstackWatcher] Failed to republish ${pkgName}:`, err);
    }
  }

  /**
   * Stop watching and clean up.
   */
  async shutdown(): Promise<void> {
    // Cancel pending debounced republishes
    for (const timeout of this.pendingRepublishes.values()) {
      clearTimeout(timeout);
    }
    this.pendingRepublishes.clear();

    // Stop the watcher
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    log.info("Shutdown complete");
  }
}

// Singleton instance
let natstackWatcher: NatstackPackageWatcher | null = null;

/**
 * Get or create the NatstackPackageWatcher singleton.
 */
export function getNatstackPackageWatcher(workspaceRoot: string): NatstackPackageWatcher {
  if (!natstackWatcher) {
    natstackWatcher = new NatstackPackageWatcher(workspaceRoot);
  }
  return natstackWatcher;
}

/**
 * Shutdown the NatstackPackageWatcher (for app shutdown).
 */
export async function shutdownNatstackWatcher(): Promise<void> {
  if (natstackWatcher) {
    await natstackWatcher.shutdown();
    natstackWatcher = null;
  }
}
