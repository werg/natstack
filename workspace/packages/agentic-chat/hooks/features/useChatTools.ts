/**
 * useChatTools — Tool provider and approval method builder.
 *
 * Provides raw tool method definitions (no approval middleware wrapping —
 * the DO handles approval based on channel config) and
 * `buildApprovalMethod()` which registers the `request_tool_approval`
 * PubSub method that DO-side agents call when they need tool approval
 * from the panel.
 */

import { useCallback, useMemo, useRef, useEffect } from "react";
import type { MethodDefinition } from "@natstack/pubsub";
import {
  useToolApproval,
} from "@workspace/tool-ui";
import type { ToolApprovalProps, useFeedbackManager } from "@workspace/tool-ui";
import type { SandboxOptions, SandboxResult } from "@workspace/eval";
import type { UseChannelConnectionResult } from "../useChannelConnection";
import type { ToolProvider, ChatSandboxValue } from "../../types";

interface UseChatToolsOptions {
  clientRef: UseChannelConnectionResult["clientRef"];
  tools?: ToolProvider;
  addFeedback: ReturnType<typeof useFeedbackManager>["addFeedback"];
  removeFeedback: ReturnType<typeof useFeedbackManager>["removeFeedback"];
  contextId: string;
  executeSandbox: (code: string, options?: SandboxOptions) => Promise<SandboxResult>;
  chat: ChatSandboxValue;
}

export interface ChatToolsState {
  /** Build tool method definitions (raw, no approval wrapping) */
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
  contextId,
  executeSandbox,
  chat,
}: UseChatToolsOptions): ChatToolsState {
  const approval = useToolApproval(clientRef.current as Parameters<typeof useToolApproval>[0], { addFeedback, removeFeedback });
  const approvalRef = useRef(approval);
  useEffect(() => { approvalRef.current = approval; }, [approval]);

  const buildToolMethods = useCallback((): Record<string, MethodDefinition> => {
    if (!tools) return {};
    return tools({ clientRef, contextId, executeSandbox, chat });
  }, [tools, clientRef, contextId, executeSandbox, chat]);

  /**
   * Build the request_tool_approval method — called by DO agents when
   * a harness tool needs approval. The DO already checked the channel's
   * approval level and determined this tool needs user input. Show the
   * approval UI and return the user's decision.
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

          // Fast path: if the panel's current approval level allows this
          // tool, return immediately. This catches the case where a prior
          // "Always Allow" click already set the floor to Full Auto.
          if (approvalRef.current.checkToolApproval(args.toolName)) {
            return { allow: true };
          }

          // Show approval UI and wait for user decision
          const allow = await approvalRef.current.requestApproval({
            callId: crypto.randomUUID(),
            agentId: args.agentId,
            agentName: args.agentName,
            methodName: args.toolName,
            args: args.toolArgs,
          });

          return { allow };
        },
      },
    };
  }, []);

  const toolApprovalValue: ToolApprovalProps = useMemo(() => ({
    settings: approval.settings,
    onSetFloor: approval.setGlobalFloor,
  }), [approval.settings, approval.setGlobalFloor]);

  return {
    buildToolMethods,
    buildApprovalMethod,
    toolApprovalValue,
  };
}
