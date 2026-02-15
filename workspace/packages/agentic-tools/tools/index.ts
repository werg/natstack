/**
 * Pubsub RPC tools index.
 *
 * Exports all tool implementations and method definition creators.
 */

// Utilities
export { resolvePath } from "./utils";

// File tools
export {
  fileRead,
  fileWrite,
  fileEdit,
  rm,
  createFileToolMethodDefinitions,
} from "./file-tools";

// Search tools
export {
  glob,
  grep,
  createSearchToolMethodDefinitions,
} from "./search-tools";

// Directory tools
export {
  tree,
  listDirectory,
  createDirectoryToolMethodDefinitions,
} from "./directory-tools";

// Git tools
export {
  gitStatus,
  gitDiff,
  gitLog,
  gitAdd,
  gitCommit,
  gitCheckout,
  createGitToolMethodDefinitions,
} from "./git-tools";

// Type checking tools
export {
  checkTypes,
  getTypeInfo,
  getCompletions,
  createTypeCheckToolMethodDefinitions,
  type DiagnosticsPublisher,
} from "./typecheck-tools";

// Workspace tools
export {
  workspaceList,
  workspaceClone,
  contextInfo,
  contextTemplateList,
  contextTemplateRead,
  createWorkspaceToolMethodDefinitions,
} from "./workspace-tools";

import type { MethodDefinition } from "@workspace/agentic-messaging";
import { createFileToolMethodDefinitions } from "./file-tools";
import { createSearchToolMethodDefinitions } from "./search-tools";
import { createDirectoryToolMethodDefinitions } from "./directory-tools";
import { createGitToolMethodDefinitions } from "./git-tools";
import { createTypeCheckToolMethodDefinitions, type DiagnosticsPublisher } from "./typecheck-tools";
import { createWorkspaceToolMethodDefinitions } from "./workspace-tools";

export interface CreateAllToolsOptions {
  /** The workspace root path for resolving relative paths */
  workspaceRoot?: string;
  /**
   * Optional function to broadcast type check diagnostics via PubSub.
   * When provided, diagnostics are published to the current channel using
   * TYPECHECK_EVENTS.DIAGNOSTICS event type.
   */
  diagnosticsPublisher?: DiagnosticsPublisher;
}

/**
 * Create all pubsub tool method definitions.
 *
 * @param options - Options including workspaceRoot and diagnosticsPublisher
 * @returns Record of method name to method definition
 */
export function createAllToolMethodDefinitions(
  options?: CreateAllToolsOptions
): Record<string, MethodDefinition> {
  const { workspaceRoot, diagnosticsPublisher } = options ?? {};

  return {
    ...createFileToolMethodDefinitions(workspaceRoot),
    ...createSearchToolMethodDefinitions(workspaceRoot),
    ...createDirectoryToolMethodDefinitions(workspaceRoot),
    ...createGitToolMethodDefinitions(workspaceRoot),
    ...createTypeCheckToolMethodDefinitions(diagnosticsPublisher),
    ...createWorkspaceToolMethodDefinitions(workspaceRoot),
  };
}
