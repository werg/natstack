/**
 * Hook for managing tool approval workflow.
 *
 * Approval level is channel-global: it lives in channel config and applies
 * to all agents on the channel. The panel reads/writes it via
 * `updateChannelConfig({ approvalLevel })`.
 *
 * The DO receives config updates and caches the level. When approval-needed
 * fires and the level says auto-approve, the DO approves immediately —
 * zero panel roundtrip.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import {
  needsApprovalForTool,
  createApprovalSchema,
} from "@natstack/pubsub";
import type { ChannelConfig } from "@natstack/pubsub";
import type { FieldValue } from "@natstack/types";
import type {
  ApprovalLevel,
  ToolApprovalSettings,
  UseToolApprovalResult,
  ActiveFeedbackSchema,
  FeedbackResult,
} from "../types";

/**
 * Approval level definitions with labels and descriptions.
 * Shared between ToolApprovalPrompt and ToolPermissionsDropdown.
 */
export const APPROVAL_LEVELS: Record<ApprovalLevel, {
  label: string;
  shortDesc: string;
  details: string[];
}> = {
  0: {
    label: "Ask All",
    shortDesc: "Ask before every tool call",
    details: ["Request approval for all tool calls"],
  },
  1: {
    label: "Auto-Safe",
    shortDesc: "Auto-approve read-only tools",
    details: ["Read files automatically", "Request approval for write operations"],
  },
  2: {
    label: "Full Auto",
    shortDesc: "Auto-approve all tools",
    details: ["Execute all tools automatically"],
  },
};

const DEFAULT_SETTINGS: ToolApprovalSettings = {
  globalFloor: 2, // Default: Full Auto
};

/**
 * Feedback functions needed by the hook to show approval UI.
 */
export interface FeedbackFunctions {
  /** Add a feedback schema to be displayed */
  addFeedback: (feedback: ActiveFeedbackSchema) => void;
  /** Remove a feedback by its callId */
  removeFeedback: (callId: string) => void;
}

/**
 * Minimal client interface for channel config access.
 * Accepts PubSubClient.
 */
interface ConfigClient {
  channelConfig?: ChannelConfig;
  updateChannelConfig?(config: Partial<ChannelConfig>): Promise<ChannelConfig>;
  onConfigChange?(handler: (config: ChannelConfig) => void): () => void;
}

export function useToolApproval(
  client: ConfigClient | null,
  feedback?: FeedbackFunctions
): UseToolApprovalResult {
  const [settings, setSettings] = useState<ToolApprovalSettings>(DEFAULT_SETTINGS);

  // Use ref for settings so callbacks can always read current state
  const settingsRef = useRef<ToolApprovalSettings>(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Ref for setGlobalFloor to avoid circular dependency in requestApproval
  const setGlobalFloorRef = useRef<(level: ApprovalLevel) => void>(() => {});

  // Track pending approval completers so we can auto-resolve them when
  // the floor changes to Full Auto (e.g. concurrent tool calls where
  // user clicks "Always Allow" on one while the other is still pending).
  const pendingApprovals = useRef<Map<string, (result: FeedbackResult) => void>>(new Map());

  // Sync approval level from channel config
  useEffect(() => {
    if (!client?.onConfigChange) return;

    // onConfigChange fires immediately with current config if available,
    // so no separate initial read is needed.
    const unsub = client.onConfigChange((config: ChannelConfig) => {
      const level = config.approvalLevel ?? 2;
      setSettings({ globalFloor: level as ApprovalLevel });
    });

    return unsub;
  }, [client]);

  const setGlobalFloor = useCallback(
    (level: ApprovalLevel) => {
      const newSettings = { globalFloor: level };
      // Update ref immediately so sync readers (checkToolApproval) see the
      // new value before React re-renders. Without this, a callMethod that
      // arrives between setSettings and the next useEffect would read stale state.
      settingsRef.current = newSettings;
      setSettings(newSettings);
      // Write to channel config — this propagates to all participants
      if (client?.updateChannelConfig) {
        void client.updateChannelConfig({ approvalLevel: level });
      }
      // When switching to Full Auto, auto-resolve all pending approval prompts
      if (level >= 2) {
        for (const [, complete] of pendingApprovals.current) {
          complete({ type: "submit", value: { decision: "allow" } });
        }
        // Map is cleared by each complete handler via removePending
      }
    },
    [client]
  );

  // Update ref after function is defined
  useEffect(() => {
    setGlobalFloorRef.current = setGlobalFloor;
  }, [setGlobalFloor]);

  /**
   * Check if a tool call can proceed without approval prompt.
   * STABLE function that reads from ref.
   */
  const checkToolApproval = useCallback(
    (toolName: string): boolean => {
      return !needsApprovalForTool(toolName, settingsRef.current.globalFloor);
    },
    [] // No dependencies - reads from ref
  );

  // Store feedback ref for use in callbacks
  const feedbackRef = useRef(feedback);
  useEffect(() => {
    feedbackRef.current = feedback;
  }, [feedback]);

  /**
   * Request approval from the user for a tool call.
   * Uses the unified feedback_form system to display approval UI.
   * Returns a promise that resolves to true if approved, false if denied.
   * STABLE function that reads from ref.
   */
  const requestApproval = useCallback(
    (params: {
      callId: string;
      agentId: string;
      agentName: string;
      methodName: string;
      args: unknown;
    }): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        const currentFeedback = feedbackRef.current;
        if (!currentFeedback) {
          // No feedback system available - deny by default
          console.warn("[useToolApproval] No feedback system available, denying approval");
          resolve(false);
          return;
        }

        const currentSettings = settingsRef.current;

        const removePending = () => {
          pendingApprovals.current.delete(params.callId);
        };

        // Build the approval schema
        const fields = createApprovalSchema({
          agentName: params.agentName,
          toolName: params.methodName,
          args: params.args,
          isFirstTimeGrant: false,
          floorLevel: currentSettings.globalFloor,
        });

        // Create the complete handler that processes the decision
        const complete = (result: FeedbackResult) => {
          removePending();
          // Remove from feedback state
          currentFeedback.removeFeedback(params.callId);

          if (result.type === "submit") {
            const value = result.value as Record<string, FieldValue> | undefined;
            const decision = value?.["decision"];

            if (decision === "allow") {
              resolve(true);
            } else if (decision === "always") {
              // "Always Allow" - set channel to Full Auto via config
              setGlobalFloorRef.current(2);
              resolve(true);
            } else {
              // Deny
              resolve(false);
            }
          } else {
            // Cancel or error = deny
            resolve(false);
          }
        };

        // Track this pending approval so setGlobalFloor can auto-resolve it
        pendingApprovals.current.set(params.callId, complete);

        // Create the ActiveFeedbackSchema entry
        const feedbackSchema: ActiveFeedbackSchema = {
          type: "schema",
          callId: params.callId,
          complete,
          createdAt: Date.now(),
          title: "", // Title is in the approvalHeader field
          fields,
          values: {},
          severity: "warning",
          hideSubmit: true, // buttonGroup handles submission
          hideCancel: true,
        };

        // Add to feedback state
        currentFeedback.addFeedback(feedbackSchema);
      });
    },
    [] // No dependencies - reads from refs
  );

  return {
    settings,
    setGlobalFloor,
    checkToolApproval,
    requestApproval,
  };
}
