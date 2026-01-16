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
   *
   * @param panelPath - Path to the panel requesting types
   * @param packageName - The package to get types for
   * @param version - Optional specific version
   * @returns Map of file paths to contents, empty map on error
   */
  async getPackageTypes(
    panelPath: string,
    packageName: string,
    version?: string
  ): Promise<Map<string, string>> {
    try {
      const result = await this.rpcCall<Record<string, string> | null>(
        "main",
        "typecheck.getPackageTypes",
        panelPath,
        packageName,
        version
      );
      if (!result || typeof result !== "object") {
        return new Map();
      }
      return new Map(Object.entries(result));
    } catch (error) {
      console.error(`[typecheck-client] Failed to get types for ${packageName}:`, error);
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
