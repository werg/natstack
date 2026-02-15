/**
 * Factory functions for creating TypeCheckService instances.
 *
 * This module provides high-level factory functions that simplify
 * creating properly configured TypeCheckService instances with
 * external type loading support.
 */

import { TypeCheckService, type TypeCheckServiceConfig } from "./service.js";
import { createTypeDefinitionClient } from "./rpc-client.js";
import { loadSourceFiles, type FileSource } from "./sources.js";

/**
 * Configuration for createPanelTypeCheckService.
 */
export interface PanelTypeCheckServiceConfig {
  /** Root path of the panel being checked */
  panelPath: string;
  /** File source for loading files (use createDiskFileSource or createOpfsFileSource) */
  fileSource: FileSource;
  /** RPC call function from runtime (rpc.call) */
  rpcCall: <T>(targetId: string, method: string, ...args: unknown[]) => Promise<T>;
  /** Additional TypeCheckServiceConfig options */
  serviceOptions?: Partial<Omit<TypeCheckServiceConfig, "panelPath" | "requestExternalTypes">>;
}

/**
 * Create a fully configured TypeCheckService with:
 * - External type loading via RPC
 * - Files loaded from the provided source
 *
 * This is the recommended way to create a TypeCheckService in panels
 * and chat tools that need external package type resolution.
 *
 * @example
 * ```typescript
 * import {
 *   createPanelTypeCheckService,
 *   createDiskFileSource,
 * } from "@workspace/typecheck";
 * import { rpc } from "@workspace/runtime";
 *
 * const service = await createPanelTypeCheckService({
 *   panelPath: "/workspace/panels/my-panel",
 *   fileSource: createDiskFileSource("/workspace/panels/my-panel"),
 *   rpcCall: rpc.call,
 * });
 *
 * // Check with automatic external type loading
 * const result = await service.checkWithExternalTypes();
 * ```
 */
export async function createPanelTypeCheckService(
  config: PanelTypeCheckServiceConfig
): Promise<TypeCheckService> {
  const { panelPath, fileSource, rpcCall, serviceOptions } = config;

  // Create type definition client for external package types
  const typeDefClient = createTypeDefinitionClient({ rpcCall });

  // Create service with external type callback
  const service = new TypeCheckService({
    panelPath,
    ...serviceOptions,
    requestExternalTypes: async (packageName) => {
      return typeDefClient.getPackageTypes(panelPath, packageName);
    },
  });

  // Load files from source
  const files = await loadSourceFiles(fileSource, ".");
  for (const [path, content] of files) {
    service.updateFile(path, content);
  }

  return service;
}
