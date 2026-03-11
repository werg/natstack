/**
 * useChatTools — Tool provider wrapping with approval middleware.
 *
 * Wraps raw tool method definitions with the approval system.
 * Also provides `buildApprovalMethod()` which registers the
 * `request_tool_approval` PubSub method that DO-side agents call
 * when they need tool approval from the panel.
 */

import { useCallback, useMemo, useRef, useEffect } from "react";
import type { MethodDefinition } from "@natstack/pubsub";
import {
  useToolApproval,
  wrapMethodsWithApproval,
} from "@workspace/tool-ui";
import type { ToolApprovalProps, useFeedbackManager } from "@workspace/tool-ui";
import type { UseChannelConnectionResult } from "../useChannelConnection";
import type { ToolProvider } from "../../types";

interface UseChatToolsOptions {
  clientRef: UseChannelConnectionResult["clientRef"];
  tools?: ToolProvider;
  addFeedback: ReturnType<typeof useFeedbackManager>["addFeedback"];
  removeFeedback: ReturnType<typeof useFeedbackManager>["removeFeedback"];
}

export interface ChatToolsState {
  /** Build tool method definitions wrapped with approval */
  buildToolMethods: () => Record<string, MethodDefinition>;
  /** Build the request_tool_approval method for DO-originated approval requests */
  buildApprovalMethod: () => Record<string, MethodDefinition>;
  /** Memoized tool approval props for UI */
  toolApprovalValue: ToolApprovalProps;
}

export function useChatTools({
  clientRef,
  tools,
  addFeedback,
  removeFeedback,
}: UseChatToolsOptions): ChatToolsState {
  // PubSubClient doesn't have getSettings/updateSettings — approval settings won't persist
  // across sessions, but the approval system works fine without persistence.
  const approval = useToolApproval(clientRef.current as Parameters<typeof useToolApproval>[0], { addFeedback, removeFeedback });
  const approvalRef = useRef(approval);
  useEffect(() => { approvalRef.current = approval; }, [approval]);

  const buildToolMethods = useCallback((): Record<string, MethodDefinition> => {
    if (!tools) return {};
    const rawTools = tools({ clientRef });
    return wrapMethodsWithApproval(
      rawTools,
      {
        isAgentGranted: (...args) => approvalRef.current.isAgentGranted(...args),
        checkToolApproval: (...args) => approvalRef.current.checkToolApproval(...args),
        requestApproval: (...args) => approvalRef.current.requestApproval(...args),
      },
      (agentId) => clientRef.current?.roster[agentId]?.metadata.name ?? agentId,
    );
  }, [tools, clientRef]);

  /**
   * Build the request_tool_approval method — called by DO agents when
   * a harness tool needs approval. Routes through the panel's approval
   * policy layer (auto-approve via checkToolApproval, UI prompt via
   * requestApproval with per-agent grants and floor levels).
   */
  const buildApprovalMethod = useCallback((): Record<string, MethodDefinition> => {
    return {
      request_tool_approval: {
        description: "Request approval for a tool call from an AI agent",
        parameters: {} as never,
        internal: true, // Only callable by DOs via callMethod, not discoverable as an AI tool
        execute: async (rawArgs) => {
          const args = rawArgs as {
            agentId: string;
            agentName: string;
            toolName: string;
            toolArgs: unknown;
          };

          // Check auto-approve — if the panel's approval level allows this tool,
          // return immediately without showing UI.
          if (approvalRef.current.checkToolApproval(args.agentId, args.toolName)) {
            return { allow: true, alwaysAllow: true };
          }

          // Show approval UI and wait for user decision
          const allow = await approvalRef.current.requestApproval({
            callId: crypto.randomUUID(),
            agentId: args.agentId,
            agentName: args.agentName,
            methodName: args.toolName,
            args: args.toolArgs,
          });

          return { allow, alwaysAllow: false };
        },
      },
    };
  }, []);

  const toolApprovalValue: ToolApprovalProps = useMemo(() => ({
    settings: approval.settings,
    onSetFloor: approval.setGlobalFloor,
    onGrantAgent: approval.grantAgent,
    onRevokeAgent: approval.revokeAgent,
    onRevokeAll: approval.revokeAll,
  }), [approval.settings, approval.setGlobalFloor, approval.grantAgent, approval.revokeAgent, approval.revokeAll]);

  return {
    buildToolMethods,
    buildApprovalMethod,
    toolApprovalValue,
  };
}
