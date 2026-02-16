/**
 * Approval Handlers
 *
 * Two approval paths:
 * 1. Gate pattern: createCanUseToolGate (check before/at tool execution)
 * 2. Wrapper pattern: wrapWithApproval (wraps individual executor)
 *
 * Both delegate to needsApprovalForTool() from agentic-messaging.
 * Both accept a getApprovalLevel() getter so that approval level changes
 * (e.g. "Always Allow") propagate immediately to all agents.
 */

import {
  needsApprovalForTool,
  type ApprovalLevel,
} from "@workspace/agentic-messaging";
import type { PubsubTool } from "./pubsub-tool-registry.js";

/**
 * Options for the approval gate.
 *
 * Note: AskUserQuestion, ExitPlanMode, EnterPlanMode are NOT pubsub tools
 * and should be handled separately in the agent's canUseTool callback.
 */
export interface CanUseToolGateOptions {
  /** Tool registry for looking up pubsub tools */
  byCanonical: ReadonlyMap<string, PubsubTool>;
  /** Get current approval level (called on every check for live propagation) */
  getApprovalLevel: () => ApprovalLevel | number;
  /** Whether we've shown at least one approval prompt */
  hasShownApprovalPrompt: boolean;
  /** Show permission prompt UI, returns "allow", "deny", or "always" */
  showPermissionPrompt: (
    tool: PubsubTool,
    input: unknown
  ) => Promise<{ allow: boolean; alwaysAllow?: boolean }>;
  /** Called when user grants "Always Allow" */
  onAlwaysAllow?: () => void;
  /** Called on first approval prompt */
  onFirstPrompt?: () => void;
}

/**
 * Create an approval gate that checks whether a tool should be allowed.
 *
 * Works with any SDK. The gate looks up the tool in the registry and checks
 * the current approval level via getApprovalLevel() on every call, so
 * changes propagate immediately.
 *
 * @example
 * ```typescript
 * const gate = createCanUseToolGate({
 *   byCanonical: registry.byCanonical,
 *   getApprovalLevel: () => settingsMgr.get().autonomyLevel ?? 0,
 *   hasShownApprovalPrompt: !!settings.hasShownApprovalPrompt,
 *   showPermissionPrompt: (tool, input) => showPermissionPrompt(client, panel.id, tool.canonicalName, input, options),
 *   onAlwaysAllow: () => settingsMgr.update({ autonomyLevel: 2 }),
 *   onFirstPrompt: () => settingsMgr.update({ hasShownApprovalPrompt: true }),
 * });
 *
 * // Use in any SDK's tool execution path:
 * const { allow } = await gate.canUseTool(toolName, input);
 * ```
 */
export function createCanUseToolGate(options: CanUseToolGateOptions): {
  canUseTool: (
    toolName: string,
    input: unknown
  ) => Promise<{ allow: boolean; updatedInput?: unknown }>;
} {
  let { hasShownApprovalPrompt } = options;
  const { byCanonical, getApprovalLevel, showPermissionPrompt, onAlwaysAllow, onFirstPrompt } = options;

  return {
    canUseTool: async (toolName: string, input: unknown) => {
      // Check if this needs approval (reads live approval level)
      if (!needsApprovalForTool(toolName, getApprovalLevel())) {
        return { allow: true, updatedInput: input };
      }

      // Look up in registry to get tool info for the prompt
      const tool = byCanonical.get(toolName);

      // Track first-time prompt
      const isFirstTimeGrant = !hasShownApprovalPrompt;
      if (isFirstTimeGrant) {
        hasShownApprovalPrompt = true;
        onFirstPrompt?.();
      }

      if (!tool) {
        // Tool not in registry - still check approval via showPermissionPrompt
        // Create a minimal tool-like object
        const minimalTool: PubsubTool = {
          providerId: "",
          providerName: "",
          methodName: toolName,
          canonicalName: toolName,
          wireName: toolName,
          parameters: {},
          menu: false,
          groups: [],
        };
        const { allow, alwaysAllow } = await showPermissionPrompt(minimalTool, input);

        if (allow && alwaysAllow) {
          onAlwaysAllow?.();
        }

        return { allow, updatedInput: input };
      }

      const { allow, alwaysAllow } = await showPermissionPrompt(tool, input);

      if (allow && alwaysAllow) {
        onAlwaysAllow?.();
      }

      return { allow, updatedInput: input };
    },
  };
}

/**
 * Options for wrapping a tool executor with approval.
 */
export interface WrapWithApprovalOptions {
  /** The tool being wrapped */
  tool: PubsubTool;
  /** Get current approval level (called on every check for live propagation) */
  getApprovalLevel: () => ApprovalLevel | number;
  /** Request approval from the user. Returns true if approved. */
  requestApproval: (tool: PubsubTool, args: unknown) => Promise<boolean>;
}

/**
 * Wrap a tool executor with approval checking (for Codex/AI SDK).
 *
 * Unlike the Claude gate which runs before execution, this wraps the
 * executor so approval is checked at execution time.
 *
 * @example
 * ```typescript
 * const executor = createToolExecutor(client, tool);
 * const approved = wrapWithApproval(executor, {
 *   tool,
 *   getApprovalLevel: () => settingsMgr.get().autonomyLevel ?? 0,
 *   requestApproval: async (tool, args) => {
 *     return await requestToolApproval(client, panelId, tool.canonicalName, args);
 *   },
 * });
 * ```
 */
export function wrapWithApproval(
  executor: (args: unknown, signal?: AbortSignal) => Promise<unknown>,
  options: WrapWithApprovalOptions
): (args: unknown, signal?: AbortSignal) => Promise<unknown> {
  const { tool, getApprovalLevel, requestApproval } = options;

  return async (args: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (needsApprovalForTool(tool.canonicalName, getApprovalLevel())) {
      const approved = await requestApproval(tool, args);
      if (!approved) {
        throw new Error(
          `Permission denied: User denied access to ${tool.canonicalName}`
        );
      }
    }
    return executor(args, signal);
  };
}
