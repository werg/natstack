/**
 * useChatTools — Tool provider wrapping with approval middleware.
 *
 * Wraps raw tool method definitions with the approval system.
 */

import { useCallback, useMemo, useRef, useEffect } from "react";
import type { MethodDefinition } from "@workspace/agentic-messaging";
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
  /** Memoized tool approval props for UI */
  toolApprovalValue: ToolApprovalProps;
}

export function useChatTools({
  clientRef,
  tools,
  addFeedback,
  removeFeedback,
}: UseChatToolsOptions): ChatToolsState {
  const approval = useToolApproval(clientRef.current, { addFeedback, removeFeedback });
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

  const toolApprovalValue: ToolApprovalProps = useMemo(() => ({
    settings: approval.settings,
    onSetFloor: approval.setGlobalFloor,
    onGrantAgent: approval.grantAgent,
    onRevokeAgent: approval.revokeAgent,
    onRevokeAll: approval.revokeAll,
  }), [approval.settings, approval.setGlobalFloor, approval.grantAgent, approval.revokeAgent, approval.revokeAll]);

  return {
    buildToolMethods,
    toolApprovalValue,
  };
}
