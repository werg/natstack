/**
 * Tool Approval Middleware
 *
 * Wraps method definitions with approval checks before execution.
 * Handles both first-time agent grants and per-call approvals.
 */

import type { MethodDefinition, MethodExecutionContext } from "@workspace/agentic-messaging";
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
 * Methods that should NOT be wrapped with approval.
 * These are meta-tools that handle feedback/communication.
 */
const META_TOOLS = new Set(["eval", "feedback_form", "feedback_custom", "pause"]);

/**
 * Wrap method definitions with approval middleware.
 *
 * For each method:
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
 * @returns Wrapped method definitions
 */
export function wrapMethodsWithApproval(
  methods: Record<string, MethodDefinition>,
  approval: ApprovalFunctions,
  getAgentName: (agentId: string) => string,
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
