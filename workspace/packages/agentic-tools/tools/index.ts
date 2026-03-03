/**
 * Tools index.
 *
 * Exports all tool implementations and method definition creators.
 */

// Type checking tools
export {
  checkTypes,
  getTypeInfo,
  getCompletions,
  createTypeCheckToolMethodDefinitions,
  type DiagnosticsPublisher,
} from "./typecheck-tools";

// Git tools
export { gitOp, createGitToolMethodDefinitions } from "./git-tools";

// Project tools
export { createProject, createProjectToolMethodDefinitions } from "./project-tools";

// Test tools
export { runTests, createTestToolMethodDefinitions } from "./test-tools";

import type { MethodDefinition } from "@workspace/agentic-messaging";
import { createTypeCheckToolMethodDefinitions, type DiagnosticsPublisher } from "./typecheck-tools";
import { createGitToolMethodDefinitions } from "./git-tools";
import { createProjectToolMethodDefinitions } from "./project-tools";
import { createTestToolMethodDefinitions } from "./test-tools";

export interface CreateAllToolsOptions {
  /**
   * Optional function to broadcast type check diagnostics via PubSub.
   * When provided, diagnostics are published to the current channel using
   * TYPECHECK_EVENTS.DIAGNOSTICS event type.
   */
  diagnosticsPublisher?: DiagnosticsPublisher;
}

/**
 * Create all tool method definitions.
 *
 * @param options - Options including diagnosticsPublisher
 * @returns Record of method name to method definition
 */
export function createAllToolMethodDefinitions(
  options?: CreateAllToolsOptions
): Record<string, MethodDefinition> {
  const { diagnosticsPublisher } = options ?? {};

  return {
    ...createTypeCheckToolMethodDefinitions(diagnosticsPublisher),
    ...createGitToolMethodDefinitions(),
    ...createProjectToolMethodDefinitions(),
    ...createTestToolMethodDefinitions(),
  };
}
