/**
 * Action Tracking Hooks - Composable tracking for tool execution.
 *
 * Wraps an ActionTracker into before/after hooks that can be composed
 * with tool executors via wrapWithTracking().
 */

import type { ActionTracker } from "@natstack/agentic-messaging";
import { getDetailedActionDescription } from "@natstack/agentic-messaging";
import type { PubsubTool } from "./pubsub-tool-registry.js";

/**
 * Lifecycle hooks for tool execution tracking.
 */
export interface ToolTrackingHooks {
  /** Called before tool execution starts */
  onStart?: (
    tool: PubsubTool,
    args: unknown,
    toolUseId: string
  ) => Promise<void>;
  /** Called after tool execution completes (or errors) */
  onEnd?: (
    tool: PubsubTool,
    toolUseId: string,
    error?: Error
  ) => Promise<void>;
}

/**
 * Create tracking hooks from an ActionTracker.
 *
 * Uses getDetailedActionDescription() to build rich action descriptions
 * from tool names and arguments.
 *
 * @example
 * ```typescript
 * const hooks = createActionTrackingHooks(trackers.action);
 * const executor = wrapWithTracking(baseExecutor, tool, hooks, toolUseId);
 * ```
 */
export function createActionTrackingHooks(
  actionTracker: ActionTracker
): ToolTrackingHooks {
  return {
    onStart: async (tool, args, toolUseId) => {
      const argsRecord =
        args && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      await actionTracker.startAction({
        type: tool.canonicalName,
        description: getDetailedActionDescription(
          tool.canonicalName,
          argsRecord
        ),
        toolUseId,
      });
    },
    onEnd: async () => {
      await actionTracker.completeAction();
    },
  };
}

/**
 * Wrap a tool executor with tracking hooks.
 *
 * Calls onStart before execution and onEnd after (even on error).
 *
 * @example
 * ```typescript
 * const tracked = wrapWithTracking(executor, tool, hooks, "tool-use-123");
 * const result = await tracked({ file_path: "/foo.ts" });
 * ```
 */
export function wrapWithTracking(
  executor: (args: unknown, signal?: AbortSignal) => Promise<unknown>,
  tool: PubsubTool,
  hooks: ToolTrackingHooks,
  toolUseId: string
): (args: unknown, signal?: AbortSignal) => Promise<unknown> {
  return async (args: unknown, signal?: AbortSignal): Promise<unknown> => {
    await hooks.onStart?.(tool, args, toolUseId);
    try {
      const result = await executor(args, signal);
      await hooks.onEnd?.(tool, toolUseId);
      return result;
    } catch (err) {
      await hooks.onEnd?.(tool, toolUseId, err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  };
}
