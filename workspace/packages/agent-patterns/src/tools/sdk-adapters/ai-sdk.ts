/**
 * Vercel AI SDK Adapter
 *
 * Converts PubsubToolRegistry to AI SDK tool format.
 * Supports deferred execution for tools requiring approval.
 */

import type { AgenticClient } from "@workspace/agentic-messaging";
import { needsApprovalForTool, type ApprovalLevel } from "@workspace/agentic-messaging";
import type { PubsubToolRegistry, PubsubTool } from "../pubsub-tool-registry.js";
import { createToolExecutor } from "../pubsub-tool-registry.js";
import type { StandardToolDefinition } from "../standard-tools.js";

/**
 * AI SDK tool definition shape (compatible with Vercel AI SDK).
 */
export interface AiSdkToolDefinition {
  description?: string;
  parameters: Record<string, unknown>;
  execute?: (args: unknown) => Promise<unknown>;
}

export interface ToAiSdkToolsOptions {
  /** Approval level for determining which tools get execute functions */
  approvalLevel?: ApprovalLevel | number;
}

/**
 * Convert a PubsubToolRegistry to AI SDK tool format.
 *
 * Tools that need approval get `execute: undefined`, causing the AI SDK
 * to emit them as tool-call events without executing. The agent can then
 * handle approval in a deferred loop.
 *
 * @returns Record of canonical name -> AI SDK tool definition, plus a
 * lookup from canonical name back to wire name (for executing after approval).
 *
 * @example
 * ```typescript
 * const registry = buildPubsubToolRegistry(client);
 * const standardTools = createStandardTools({ client, log });
 * const { tools, canonicalToWire } = toAiSdkTools(registry, client, standardTools, {
 *   approvalLevel: settings.autonomyLevel,
 * });
 *
 * // Use in streamText()
 * const stream = ai.streamText({ tools, ... });
 *
 * // For deferred approval, use canonicalToWire to look up wire name
 * const wireName = canonicalToWire.get(toolName);
 * ```
 */
export function toAiSdkTools(
  registry: PubsubToolRegistry,
  client: AgenticClient,
  standardTools: Record<string, StandardToolDefinition>,
  options?: ToAiSdkToolsOptions
): {
  tools: Record<string, AiSdkToolDefinition>;
  /** Maps canonical name -> wire name for deferred execution */
  canonicalToWire: ReadonlyMap<string, string>;
  /** Execute a tool by its canonical name (for deferred approval) */
  execute: (canonicalName: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
} {
  const approvalLevel = options?.approvalLevel ?? 0;
  const tools: Record<string, AiSdkToolDefinition> = {};
  const canonicalToWire = new Map<string, string>();

  // Add pubsub tools
  for (const tool of registry.tools) {
    const requiresApproval = needsApprovalForTool(tool.canonicalName, approvalLevel);
    const executor = createToolExecutor(client, tool);

    canonicalToWire.set(tool.canonicalName, tool.wireName);

    tools[tool.canonicalName] = {
      description: tool.description,
      parameters: tool.parameters,
      execute: requiresApproval ? undefined : (args) => executor(args),
    };
  }

  // Add standard tools (always auto-execute, never need approval)
  for (const [name, stdTool] of Object.entries(standardTools)) {
    tools[name] = {
      description: stdTool.description,
      parameters: stdTool.parameters,
      execute: stdTool.execute,
    };
  }

  // Create an execute function for deferred approval
  const executorCache = new Map<string, (args: unknown, signal?: AbortSignal) => Promise<unknown>>();

  const execute = async (canonicalName: string, args: unknown, signal?: AbortSignal): Promise<unknown> => {
    // Check standard tools first
    const stdTool = standardTools[canonicalName];
    if (stdTool) {
      return stdTool.execute(args);
    }

    // Look up pubsub tool
    const tool = registry.byCanonical.get(canonicalName);
    if (!tool) {
      throw new Error(`Tool not found: ${canonicalName}`);
    }

    let executor = executorCache.get(canonicalName);
    if (!executor) {
      executor = createToolExecutor(client, tool);
      executorCache.set(canonicalName, executor);
    }

    return executor(args, signal);
  };

  return { tools, canonicalToWire, execute };
}
