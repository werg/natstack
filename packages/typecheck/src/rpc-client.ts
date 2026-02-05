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
   * Get type definitions for a single package.
   * Delegates to getPackageTypesBatch for consistency.
   */
  async getPackageTypes(
    panelPath: string,
    packageName: string
  ): Promise<PackageTypesResult> {
    const results = await this.getPackageTypesBatch(panelPath, [packageName]);
    return results.get(packageName) ?? { files: new Map() };
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

}

/**
 * Create a TypeDefinitionClient instance.
 */
export function createTypeDefinitionClient(
  config: TypeDefinitionClientConfig
): TypeDefinitionClient {
  return new TypeDefinitionClient(config);
}
