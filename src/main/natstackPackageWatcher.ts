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
 * Persistence:
 * - Stores the last known git commit for packages/
 * - On startup, compares with current commit to detect changes made while app was closed
 * - Also stores per-package "dirty" state for uncommitted changes
 */

import * as path from "path";
import * as fs from "fs";
import { promisify } from "util";
import { exec } from "child_process";
import { app } from "electron";
import chokidar, { type FSWatcher } from "chokidar";
import { createDevLogger } from "./devLog.js";

const execAsync = promisify(exec);
const log = createDevLogger("NatstackWatcher");

const PERSISTENCE_FILENAME = "natstack-package-state.json";
const DEBOUNCE_MS = 300; // Debounce file changes before republishing

interface PersistedState {
  version: string;
  /** Last known git commit hash for packages/ */
  lastCommitHash: string | null;
  /** Packages that had uncommitted changes when app last closed */
  dirtyPackages: string[];
}

const STATE_VERSION = "1";

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
   * This should be called after VerdaccioServer is ready.
   */
  async initialize(republishCallback: RepublishCallback): Promise<void> {
    if (this.isInitialized) return;

    this.republishCallback = republishCallback;
    this.isInitialized = true;

    // Check for changes since last app run
    await this.checkStartupChanges();

    // Start watching for live changes
    this.startWatching();

    log.info(`Watching ${this.packagesDir} for changes`);
  }

  /**
   * Check for changes that occurred while the app was closed.
   * Compares current git state with persisted state and republishes changed packages.
   */
  private async checkStartupChanges(): Promise<void> {
    const state = this.loadState();
    const currentCommit = await this.getCurrentCommit();
    const packagesToRepublish = new Set<string>();

    // 1. If git commit changed (and we have previous state), republish packages with commits
    if (state?.lastCommitHash && state.lastCommitHash !== currentCommit) {
      const changedPackages = await this.getChangedPackagesSinceCommit(state.lastCommitHash);
      for (const pkgName of changedPackages) {
        packagesToRepublish.add(pkgName);
      }
    }

    // 2. ALWAYS check for currently dirty packages (even on first run / missing state)
    // This handles: fresh install with dirty files, state file deleted, edited while closed
    const currentlyDirty = await this.getDirtyPackages();
    for (const pkgName of currentlyDirty) {
      packagesToRepublish.add(pkgName);
    }

    // 3. Republish all packages that need it
    if (packagesToRepublish.size > 0) {
      log.info(`Republishing ${packagesToRepublish.size} packages changed while app was closed`);
      for (const pkgName of packagesToRepublish) {
        const pkgPath = await this.findPackagePath(pkgName);
        if (pkgPath) {
          await this.triggerRepublish(pkgPath, pkgName);
        }
      }
    } else if (!state) {
      log.verbose(" No previous state, starting fresh");
    }

    // 4. Save current state
    await this.saveState(currentCommit, currentlyDirty);
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
   * Get the current git commit hash for packages/.
   */
  private async getCurrentCommit(): Promise<string | null> {
    try {
      const { stdout } = await execAsync("git rev-parse HEAD", { cwd: this.packagesDir });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  /**
   * Get packages that changed between a commit and HEAD.
   */
  private async getChangedPackagesSinceCommit(fromCommit: string): Promise<string[]> {
    try {
      const { stdout } = await execAsync(
        `git diff --name-only ${fromCommit} HEAD -- .`,
        { cwd: this.packagesDir }
      );

      const changedFiles = stdout.trim().split("\n").filter(Boolean);
      const changedPackages = new Set<string>();

      for (const file of changedFiles) {
        const fullPath = path.join(this.packagesDir, file);
        const pkgInfo = this.getPackageForFile(fullPath);
        if (pkgInfo) {
          changedPackages.add(pkgInfo.pkgName);
        }
      }

      return Array.from(changedPackages);
    } catch {
      return [];
    }
  }

  /**
   * Find the path for a package by name.
   */
  private async findPackagePath(pkgName: string): Promise<string | null> {
    // Parse scoped package name
    const match = pkgName.match(/^(@[^/]+)\/(.+)$/);
    if (match) {
      const scope = match[1];
      const name = match[2];
      if (scope && name) {
        const pkgPath = path.join(this.packagesDir, scope, name);
        if (fs.existsSync(path.join(pkgPath, "package.json"))) {
          return pkgPath;
        }
      }
    } else {
      const pkgPath = path.join(this.packagesDir, pkgName);
      if (fs.existsSync(path.join(pkgPath, "package.json"))) {
        return pkgPath;
      }
    }
    return null;
  }

  /**
   * Load persisted state from disk.
   */
  private loadState(): PersistedState | null {
    const statePath = this.getStatePath();
    try {
      if (!fs.existsSync(statePath)) return null;
      const content = fs.readFileSync(statePath, "utf-8");
      const state = JSON.parse(content) as PersistedState;
      if (state.version !== STATE_VERSION) return null;
      return state;
    } catch {
      return null;
    }
  }

  /**
   * Save state to disk.
   */
  private async saveState(commitHash: string | null, dirtyPackages: string[]): Promise<void> {
    const statePath = this.getStatePath();
    const state: PersistedState = {
      version: STATE_VERSION,
      lastCommitHash: commitHash,
      dirtyPackages,
    };

    try {
      const dir = path.dirname(statePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error("[NatstackWatcher] Failed to save state:", err);
    }
  }

  private getStatePath(): string {
    return path.join(app.getPath("userData"), PERSISTENCE_FILENAME);
  }

  /**
   * Get currently dirty packages (for persistence on shutdown).
   */
  async getDirtyPackages(): Promise<string[]> {
    const dirty: string[] = [];

    if (!fs.existsSync(this.packagesDir)) return dirty;

    // Check git status for each package
    try {
      const { stdout } = await execAsync("git status --porcelain -- .", { cwd: this.packagesDir });
      const changedFiles = stdout.trim().split("\n").filter(Boolean);

      const dirtyPackages = new Set<string>();
      for (const line of changedFiles) {
        // Git status format: "XY filename" where XY is the status
        const file = line.substring(3);
        const fullPath = path.join(this.packagesDir, file);
        const pkgInfo = this.getPackageForFile(fullPath);
        if (pkgInfo) {
          dirtyPackages.add(pkgInfo.pkgName);
        }
      }

      return Array.from(dirtyPackages);
    } catch {
      return [];
    }
  }

  /**
   * Flush pending republishes and save state before shutdown.
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

    // Save current state
    const currentCommit = await this.getCurrentCommit();
    const dirtyPackages = await this.getDirtyPackages();
    await this.saveState(currentCommit, dirtyPackages);

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
