/**
 * Hook for managing tool approval workflow.
 *
 * Provides state management for:
 * - Global approval level (Ask All, Auto-Safe, Full Auto)
 * - Per-agent access grants
 * - Integration with feedback system for approval prompts
 *
 * This hook now uses the unified feedback_form system for approval UI,
 * eliminating the need for separate PendingApproval state.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import {
  needsApprovalForTool,
  extractMethodName,
  type AgenticClient,
} from "@natstack/agentic-messaging";
import type { FieldValue } from "@natstack/runtime";
import type {
  ApprovalLevel,
  ToolApprovalSettings,
  UseToolApprovalResult,
  ActiveFeedbackSchema,
  FeedbackResult,
} from "../types";
import { createApprovalSchema } from "../utils/createApprovalSchema";

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
  globalFloor: 1, // Default: Auto-Safe
  agentGrants: {},
};

const SETTINGS_KEY = "toolApproval";

/**
 * Feedback functions needed by the hook to show approval UI.
 */
export interface FeedbackFunctions {
  /** Add a feedback schema to be displayed */
  addFeedback: (feedback: ActiveFeedbackSchema) => void;
  /** Remove a feedback by its callId */
  removeFeedback: (callId: string) => void;
}

export function useToolApproval(
  client: AgenticClient | null,
  feedback?: FeedbackFunctions
): UseToolApprovalResult {
  const [settings, setSettings] = useState<ToolApprovalSettings>(DEFAULT_SETTINGS);

  // Use ref for settings so callbacks can always read current state
  // This fixes the stale closure issue when functions are captured at wrap time
  const settingsRef = useRef<ToolApprovalSettings>(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Track client changes to reload settings
  const clientRef = useRef<AgenticClient | null>(null);
  const loadedRef = useRef(false);

  // Load settings from client when client changes
  useEffect(() => {
    // Skip if same client
    if (client === clientRef.current) return;
    clientRef.current = client;
    loadedRef.current = false;

    if (!client) {
      // Reset to defaults when client disconnects
      setSettings(DEFAULT_SETTINGS);
      return;
    }

    const loadSettings = async () => {
      try {
        const stored = await client.getSettings<{ [SETTINGS_KEY]: ToolApprovalSettings }>();
        if (stored?.[SETTINGS_KEY]) {
          setSettings(stored[SETTINGS_KEY]);
        }
        loadedRef.current = true;
      } catch (err) {
        console.warn("[useToolApproval] Failed to load settings:", err);
        loadedRef.current = true;
      }
    };

    void loadSettings();
  }, [client]);

  // Persist settings helper - uses ref to get current client
  const persistSettings = useCallback(
    async (newSettings: ToolApprovalSettings) => {
      const currentClient = clientRef.current;
      if (!currentClient || !loadedRef.current) return;
      try {
        await currentClient.updateSettings({ [SETTINGS_KEY]: newSettings });
      } catch (err) {
        console.warn("[useToolApproval] Failed to persist settings:", err);
      }
    },
    []
  );

  const setGlobalFloor = useCallback(
    (level: ApprovalLevel) => {
      setSettings((prev) => {
        const next = { ...prev, globalFloor: level };
        void persistSettings(next);
        return next;
      });
    },
    [persistSettings]
  );

  // grantAgent needs to be defined before it's used in resolveApproval
  // Using ref pattern to avoid circular dependency
  const grantAgentRef = useRef<(agentId: string) => void>(() => {});

  const grantAgent = useCallback(
    (agentId: string) => {
      setSettings((prev) => {
        const next = {
          ...prev,
          agentGrants: { ...prev.agentGrants, [agentId]: Date.now() },
        };
        void persistSettings(next);
        return next;
      });
    },
    [persistSettings]
  );

  // Update ref after grantAgent is defined
  useEffect(() => {
    grantAgentRef.current = grantAgent;
  }, [grantAgent]);

  const revokeAgent = useCallback(
    (agentId: string) => {
      setSettings((prev) => {
        const { [agentId]: _, ...rest } = prev.agentGrants;
        const next = { ...prev, agentGrants: rest };
        void persistSettings(next);
        return next;
      });
    },
    [persistSettings]
  );

  const revokeAll = useCallback(() => {
    setSettings((prev) => {
      const next = { ...prev, agentGrants: {} };
      void persistSettings(next);
      return next;
    });
  }, [persistSettings]);

  /**
   * Check if agent is granted - STABLE function that reads from ref.
   * Safe to capture in closures that outlive render cycles.
   */
  const isAgentGranted = useCallback(
    (agentId: string): boolean => {
      return agentId in settingsRef.current.agentGrants;
    },
    [] // No dependencies - reads from ref
  );

  /**
   * Check if a tool call from an agent needs approval.
   * Returns true if the call can proceed without prompt.
   * STABLE function that reads from ref.
   */
  const checkToolApproval = useCallback(
    (agentId: string, methodName: string): boolean => {
      const currentSettings = settingsRef.current;
      // Agent must be granted first
      if (!(agentId in currentSettings.agentGrants)) return false;

      // Use the approval level logic
      const actualMethod = extractMethodName(methodName);
      return !needsApprovalForTool(actualMethod, currentSettings.globalFloor);
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
        const isFirstTimeGrant = !(params.agentId in currentSettings.agentGrants);

        // Build the approval schema
        const fields = createApprovalSchema({
          agentName: params.agentName,
          toolName: params.methodName,
          args: params.args,
          isFirstTimeGrant,
          floorLevel: currentSettings.globalFloor,
        });

        // Create the complete handler that processes the decision
        const complete = (result: FeedbackResult) => {
          // Remove from feedback state
          currentFeedback.removeFeedback(params.callId);

          if (result.type === "submit") {
            const value = result.value as Record<string, FieldValue> | undefined;
            const approved = value?.["decision"] === "allow";

            // If approving a first-time grant, add agent to grants
            if (approved && isFirstTimeGrant) {
              grantAgentRef.current(params.agentId);
            }

            resolve(approved);
          } else {
            // Cancel or error = deny
            resolve(false);
          }
        };

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
    grantAgent,
    revokeAgent,
    revokeAll,
    isAgentGranted,
    checkToolApproval,
    requestApproval,
  };
}
