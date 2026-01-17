/**
 * Tool Approval Middleware
 *
 * Wraps method definitions with approval checks before execution.
 * Handles both first-time agent grants and per-call approvals.
 */

import type { MethodDefinition, MethodExecutionContext, ToolGroup } from "@natstack/agentic-messaging";
import { getGroupsForTool } from "@natstack/agentic-messaging";
import type { z } from "zod";

/**
 * Approval functions needed by the middleware.
 */
export interface ApprovalFunctions {
  /** Check if an agent has been granted access */
  isAgentGranted: (agentId: string) => boolean;
  /** Check if a tool call from an agent needs approval */
  checkToolApproval: (agentId: string, methodName: string) => boolean;
  /** Request approval from the user */
  requestApproval: (params: {
    callId: string;
    agentId: string;
    agentName: string;
    methodName: string;
    args: unknown;
  }) => Promise<boolean>;
}

/**
 * Tool role functions for checking if we should provide tools.
 */
export interface ToolRoleFunctions {
  /** Check if we should provide tools for a group (no conflict or we won) */
  shouldProvideGroup: (group: ToolGroup) => boolean;
}

/**
 * Getter function to retrieve tool role functions at execution time.
 * This avoids stale closure issues when tool role state changes.
 */
export type GetToolRoleFunctions = () => ToolRoleFunctions | undefined;

/**
 * Methods that should NOT be wrapped with approval.
 * These are meta-tools that handle feedback/communication.
 */
const META_TOOLS = new Set(["eval", "feedback_form", "feedback_custom", "pause"]);

/**
 * Wrap method definitions with approval middleware.
 *
 * For each method:
 * 0. Check if we should provide this tool (tool role conflicts)
 * 1. Check if agent is granted (isAgentGranted)
 * 2. If not -> request first-time grant approval
 * 3. If granted -> check if this tool needs per-call approval (checkToolApproval)
 * 4. If approval needed -> request it
 * 5. If denied at any step -> throw error
 * 6. Execute original method
 *
 * @param methods - Record of method name to method definition
 * @param approval - Approval functions from useToolApproval hook
 * @param getAgentName - Function to get display name for an agent ID
 * @param getToolRole - Optional getter for tool role functions (called at execution time to avoid stale closures)
 * @returns Wrapped method definitions
 */
export function wrapMethodsWithApproval(
  methods: Record<string, MethodDefinition>,
  approval: ApprovalFunctions,
  getAgentName: (agentId: string) => string,
  getToolRole?: GetToolRoleFunctions
): Record<string, MethodDefinition> {
  const wrapped: Record<string, MethodDefinition> = {};

  for (const [name, method] of Object.entries(methods)) {
    // Skip meta-tools
    if (META_TOOLS.has(name)) {
      wrapped[name] = method;
      continue;
    }

    wrapped[name] = {
      ...method,
      execute: async (args: z.infer<typeof method.parameters>, ctx: MethodExecutionContext) => {
        // Step 0: Check if we should provide this tool (tool role conflicts)
        // Call getToolRole() at execution time to get fresh state
        const toolRole = getToolRole?.();
        if (toolRole) {
          const groups = getGroupsForTool(name);
          for (const group of groups) {
            if (!toolRole.shouldProvideGroup(group)) {
              throw new Error(`Tool ${name} is provided by another panel (${group} conflict resolved)`);
            }
          }
        }

        const agentId = ctx.callerId;
        const agentName = getAgentName(agentId);

        // Step 1: Check if agent is granted
        const isGranted = approval.isAgentGranted(agentId);

        if (!isGranted) {
          // Step 2: Request first-time grant
          const approved = await approval.requestApproval({
            callId: ctx.callId,
            agentId,
            agentName,
            methodName: name,
            args,
          });

          if (!approved) {
            throw new Error(`Tool access denied for ${agentName}`);
          }

          // After grant, still need to check if this specific tool needs approval
          // But first-time grant also approves this call
        } else {
          // Step 3: Check if tool needs per-call approval
          const canProceed = approval.checkToolApproval(agentId, name);

          if (!canProceed) {
            // Step 4: Request per-call approval
            const approved = await approval.requestApproval({
              callId: ctx.callId,
              agentId,
              agentName,
              methodName: name,
              args,
            });

            if (!approved) {
              throw new Error(`Tool ${name} denied by user`);
            }
          }
        }

        // Step 6: Execute original method
        return method.execute(args, ctx);
      },
    };
  }

  return wrapped;
}
