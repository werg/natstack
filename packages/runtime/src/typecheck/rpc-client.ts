/**
 * RPC client for fetching type definitions from the main process.
 *
 * This module provides a clean API for panels to request type definitions
 * using the standard NatStack RPC system.
 */

/**
 * Type definition client configuration.
 */
export interface TypeDefinitionClientConfig {
  /**
   * RPC call function from the runtime.
   * Signature: (targetId: string, method: string, ...args: unknown[]) => Promise<T>
   */
  rpcCall: <T = unknown>(targetId: string, method: string, ...args: unknown[]) => Promise<T>;
}

/**
 * Result from getPackageTypes with full metadata.
 */
export interface PackageTypesResult {
  /** Map of file paths to their contents */
  files: Map<string, string>;
  /** Package names referenced via /// <reference types="..." /> */
  referencedPackages?: string[];
  /** The main entry point file path */
  entryPoint?: string;
}

/**
 * Result from batch API (record format for RPC serialization).
 */
export interface PackageTypesResultRecord {
  /** Map of file paths to their contents (as Record for JSON serialization) */
  files: Record<string, string>;
  /** Package names referenced via /// <reference types="..." /> */
  referencedPackages?: string[];
  /** The main entry point file path */
  entryPoint?: string;
  /** Error message if package failed to load */
  error?: string;
  /** True if package was skipped (e.g., Node built-in) */
  skipped?: boolean;
}

/**
 * Client for fetching type definitions from the main process.
 */
export class TypeDefinitionClient {
  private rpcCall: TypeDefinitionClientConfig["rpcCall"];

  constructor(config: TypeDefinitionClientConfig) {
    this.rpcCall = config.rpcCall;
  }

  /**
   * Get type definitions for a package.
   * Main process will auto-install if missing.
   * Always installs latest version (version parameter removed for batching simplicity).
   *
   * @param panelPath - Path to the panel requesting types
   * @param packageName - The package to get types for
   * @returns PackageTypesResult with files map and metadata, empty files on error
   */
  async getPackageTypes(
    panelPath: string,
    packageName: string
  ): Promise<PackageTypesResult> {
    try {
      const result = await this.rpcCall<{
        files: Record<string, string>;
        referencedPackages?: string[];
        entryPoint?: string;
      } | null>(
        "main",
        "typecheck.getPackageTypes",
        panelPath,
        packageName
      );

      return {
        files: new Map(Object.entries(result?.files ?? {})),
        referencedPackages: result?.referencedPackages,
        entryPoint: result?.entryPoint,
      };
    } catch (error) {
      console.error(`[typecheck-client] Failed to get types for ${packageName}:`, error);
      return { files: new Map() };
    }
  }

  /**
   * Get type definitions for multiple packages in a batch.
   * This is the primary API - use this instead of single-package calls when possible.
   *
   * @param panelPath - Path to the panel requesting types
   * @param packageNames - Array of package names to get types for
   * @returns Map of package name to result with types or error
   */
  async getPackageTypesBatch(
    panelPath: string,
    packageNames: string[]
  ): Promise<Map<string, PackageTypesResult>> {
    try {
      const result = await this.rpcCall<Record<string, PackageTypesResultRecord> | null>(
        "main",
        "typecheck.getPackageTypesBatch",
        panelPath,
        packageNames
      );

      const resultMap = new Map<string, PackageTypesResult>();
      if (result) {
        for (const [name, data] of Object.entries(result)) {
          resultMap.set(name, {
            files: new Map(Object.entries(data.files)),
            referencedPackages: data.referencedPackages,
            entryPoint: data.entryPoint,
          });
        }
      }
      return resultMap;
    } catch (error) {
      console.error(`[typecheck-client] Failed to get types batch:`, error);
      return new Map();
    }
  }

  /**
   * Get the deps directory for a panel.
   * Useful for direct file access if needed.
   */
  async getDepsDir(panelPath: string): Promise<string> {
    return this.rpcCall<string>("main", "typecheck.getDepsDir", panelPath);
  }

  /**
   * Clear the global type cache in main process.
   */
  async clearCache(): Promise<void> {
    await this.rpcCall<void>("main", "typecheck.clearCache");
  }

  /**
   * Clear cache for a specific package.
   */
  async clearPackageCache(packageName: string, version?: string): Promise<void> {
    await this.rpcCall<void>("main", "typecheck.clearPackageCache", packageName, version);
  }
}

/**
 * Create a TypeDefinitionClient instance.
 */
export function createTypeDefinitionClient(
  config: TypeDefinitionClientConfig
): TypeDefinitionClient {
  return new TypeDefinitionClient(config);
}
