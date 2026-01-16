/**
 * Watch mode for NatStack type checking.
 *
 * This module provides real-time type checking with debounced updates
 * and PubSub integration for broadcasting diagnostics.
 */

import {
  TypeCheckService,
  type TypeCheckResult,
  type TypeCheckServiceConfig,
} from "./service.js";
import { type FileSource, loadSourceFiles } from "./sources.js";
import { type TypeDefinitionClient } from "./rpc-client.js";

/**
 * Options for the TypeCheckWatcher.
 */
export interface TypeCheckWatcherOptions extends Omit<TypeCheckServiceConfig, "requestExternalTypes"> {
  /** File source for loading panel files */
  fileSource: FileSource;
  /** Debounce delay in milliseconds (default: 300) */
  debounceMs?: number;
  /** Callback when diagnostics are available */
  onDiagnostics?: (result: TypeCheckResult) => void;
  /** Callback for errors during checking */
  onError?: (error: Error) => void;
  /** Client for fetching external package types from main process */
  typeDefinitionClient?: TypeDefinitionClient;
}

/**
 * Watch mode type checker with debouncing.
 */
export class TypeCheckWatcher {
  private service: TypeCheckService;
  private fileSource: FileSource;
  private debounceMs: number;
  private onDiagnostics?: (result: TypeCheckResult) => void;
  private onError?: (error: Error) => void;
  private panelPath: string;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isChecking = false;
  private disposed = false;
  private unwatch?: () => void;
  /** True while start() is loading initial files */
  private isStarting = false;
  /** Updates queued during startup to apply after initial load */
  private pendingUpdates = new Map<string, string>();

  constructor(options: TypeCheckWatcherOptions) {
    this.panelPath = options.panelPath;
    this.fileSource = options.fileSource;
    this.debounceMs = options.debounceMs ?? 300;
    this.onDiagnostics = options.onDiagnostics;
    this.onError = options.onError;

    // Create requestExternalTypes callback if typeDefinitionClient is provided
    const requestExternalTypes = options.typeDefinitionClient
      ? async (packageName: string) => {
          return options.typeDefinitionClient!.getPackageTypes(this.panelPath, packageName);
        }
      : undefined;

    this.service = new TypeCheckService({
      ...options,
      requestExternalTypes,
    });
  }

  /**
   * Start the watcher by loading initial files.
   */
  async start(): Promise<void> {
    if (this.disposed) {
      throw new Error("Watcher has been disposed");
    }

    this.isStarting = true;
    try {
      // Load all TypeScript files from the source
      // Use "." (current directory) so FileSource uses its basePath, not root "/"
      const files = await loadSourceFiles(this.fileSource, ".");

      // Add files to the service, but don't overwrite pending updates from user
      for (const [path, content] of files) {
        if (!this.pendingUpdates.has(path)) {
          this.service.updateFile(path, content);
        }
      }

      // Apply any pending updates that arrived during startup
      for (const [path, content] of this.pendingUpdates) {
        this.service.updateFile(path, content);
      }
      this.pendingUpdates.clear();

      // Run initial check
      await this.runCheck();

      // Set up file watching if supported
      if (this.fileSource.watch) {
        this.unwatch = this.fileSource.watch("**/*.{ts,tsx}", (event, path) => {
          this.handleFileEvent(event, path);
        });
      }
    } finally {
      this.isStarting = false;
    }
  }

  /**
   * Handle a file event from the watcher.
   */
  private async handleFileEvent(
    event: "create" | "change" | "delete",
    filePath: string
  ): Promise<void> {
    if (this.disposed) return;

    if (event === "delete") {
      this.service.removeFile(filePath);
    } else {
      try {
        const content = await this.fileSource.readFile(filePath);
        this.service.updateFile(filePath, content);
      } catch (error) {
        this.onError?.(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }

    this.scheduleCheck(filePath);
  }

  /**
   * Manually update a file and schedule a check.
   */
  updateFile(path: string, content: string): void {
    if (this.disposed) return;

    if (this.isStarting) {
      // Queue update to be applied after initial load completes
      this.pendingUpdates.set(path, content);
      return;
    }

    this.service.updateFile(path, content);
    this.scheduleCheck(path);
  }

  /**
   * Manually remove a file and schedule a check.
   */
  removeFile(path: string): void {
    if (this.disposed) return;

    this.service.removeFile(path);
    this.scheduleCheck(path);
  }

  /**
   * Schedule a debounced type check.
   */
  private scheduleCheck(_filePath?: string): void {
    // Clear existing timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Schedule new check
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runCheck();
    }, this.debounceMs);
  }

  /**
   * Run type checking.
   */
  private async runCheck(): Promise<void> {
    if (this.disposed || this.isChecking) return;

    this.isChecking = true;

    try {
      // Always run full check - TypeScript diagnostics are interdependent
      // (changing a type in one file affects all files that import it)
      const result = this.service.check();

      // Load any pending external types that were discovered during resolution
      const loadedNewTypes = await this.service.loadPendingTypes();

      if (loadedNewTypes) {
        // Re-check with newly loaded types to get accurate diagnostics
        const refinedResult = this.service.check();
        this.onDiagnostics?.(refinedResult);
      } else {
        this.onDiagnostics?.(result);
      }
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Force an immediate check (bypasses debounce).
   */
  async checkNow(): Promise<TypeCheckResult> {
    if (this.disposed) {
      throw new Error("Watcher has been disposed");
    }

    // Cancel pending debounced check
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    return this.service.check();
  }

  /**
   * Get the underlying TypeCheckService.
   */
  getService(): TypeCheckService {
    return this.service;
  }

  /**
   * Dispose the watcher and clean up resources.
   */
  dispose(): void {
    if (this.disposed) return;

    this.disposed = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.unwatch) {
      this.unwatch();
      this.unwatch = undefined;
    }
  }
}

/**
 * Create a TypeCheckWatcher instance.
 */
export function createTypeCheckWatcher(
  options: TypeCheckWatcherOptions
): TypeCheckWatcher {
  return new TypeCheckWatcher(options);
}

/**
 * PubSub event names for type checking.
 */
export const TYPECHECK_EVENTS = {
  /** Broadcast when diagnostics are available */
  DIAGNOSTICS: "typecheck:diagnostics",
  /** Request a type check */
  CHECK_REQUEST: "typecheck:check",
  /** File was updated */
  FILE_UPDATED: "typecheck:file-updated",
} as const;

/**
 * Payload for typecheck:diagnostics event.
 */
export interface TypeCheckDiagnosticsEvent {
  panelPath: string;
  diagnostics: TypeCheckResult["diagnostics"];
  timestamp: number;
  checkedFiles: string[];
}

/**
 * Payload for typecheck:file-updated event.
 */
export interface TypeCheckFileUpdatedEvent {
  panelPath: string;
  filePath: string;
  action: "create" | "change" | "delete";
}
