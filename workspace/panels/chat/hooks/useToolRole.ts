/**
 * Tool Role Hook
 *
 * Manages tool role state, conflict detection, and negotiation for the panel.
 * Handles the coordination of which participant provides which tool groups.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import type {
  AgenticClient,
  ToolGroup,
  ToolRoleConflict,
  IncomingToolRoleRequestEvent,
  IncomingToolRoleResponseEvent,
  IncomingToolRoleHandoffEvent,
} from "@natstack/agentic-messaging";

/**
 * State for a single tool group.
 */
export interface ToolGroupState {
  /** Whether this panel is currently providing tools for this group */
  providing: boolean;
  /** If there's a conflict, who is the resolved provider */
  resolvedProvider?: string;
  /** Whether we're in negotiation for this group */
  negotiating: boolean;
}

/**
 * Pending conflict that needs user resolution.
 */
export interface PendingConflict {
  group: ToolGroup;
  conflict: ToolRoleConflict;
  /** Timestamp when conflict was detected */
  detectedAt: number;
}

export interface UseToolRoleResult {
  /** Current state for each tool group */
  groupStates: Record<ToolGroup, ToolGroupState>;
  /** Pending conflicts that need user action */
  pendingConflicts: PendingConflict[];
  /** Whether this panel should provide tools for a group (no conflict or we won) */
  shouldProvideGroup: (group: ToolGroup) => boolean;
  /** Request to take over a tool group from another provider */
  requestTakeOver: (group: ToolGroup) => Promise<void>;
  /** Accept using the existing provider (don't provide tools for this group) */
  acceptExisting: (group: ToolGroup) => void;
  /** Clear a pending conflict */
  dismissConflict: (group: ToolGroup) => void;
  /** Handle incoming tool role request event (auto-accept from panels) */
  handleToolRoleRequest: (event: IncomingToolRoleRequestEvent) => void;
  /** Handle incoming tool role response event (process acceptance/rejection) */
  handleToolRoleResponse: (event: IncomingToolRoleResponseEvent) => void;
  /** Handle incoming tool role handoff event (update group state when handoff completes) */
  handleToolRoleHandoff: (event: IncomingToolRoleHandoffEvent) => void;
}

const DEFAULT_GROUP_STATE: ToolGroupState = {
  providing: true, // Default: we want to provide tools
  resolvedProvider: undefined,
  negotiating: false,
};

export function useToolRole(
  client: AgenticClient | null,
  selfId: string | null
): UseToolRoleResult {
  // State for each tool group
  const [groupStates, setGroupStates] = useState<Record<ToolGroup, ToolGroupState>>({
    "file-ops": { ...DEFAULT_GROUP_STATE },
    "git-ops": { ...DEFAULT_GROUP_STATE },
    "workspace-ops": { ...DEFAULT_GROUP_STATE },
  });

  // Pending conflicts awaiting user decision
  const [pendingConflicts, setPendingConflicts] = useState<PendingConflict[]>([]);

  // Track if we've registered conflict handler
  const unsubRef = useRef<(() => void) | null>(null);

  // Handle incoming tool role conflicts
  const handleConflicts = useCallback(
    (conflicts: ToolRoleConflict[]) => {
      if (!selfId) return;

      for (const conflict of conflicts) {
        const weAreResolved = conflict.resolvedProvider === selfId;
        const weAreClaiming = conflict.providers.some((p) => p.id === selfId);

        // Update group state
        setGroupStates((prev) => ({
          ...prev,
          [conflict.group]: {
            ...prev[conflict.group],
            resolvedProvider: conflict.resolvedProvider,
            // If we're the resolved provider, we keep providing
            // If we're not, we need user input
            providing: weAreResolved,
          },
        }));

        // If we're claiming but not resolved, show conflict to user
        if (weAreClaiming && !weAreResolved) {
          setPendingConflicts((prev) => {
            // Don't add duplicate conflicts
            if (prev.some((p) => p.group === conflict.group)) {
              return prev.map((p) =>
                p.group === conflict.group
                  ? { ...p, conflict, detectedAt: Date.now() }
                  : p
              );
            }
            return [...prev, { group: conflict.group, conflict, detectedAt: Date.now() }];
          });
        }

        // FIX: If we ARE the resolved provider, notify losers that we won
        if (weAreResolved && weAreClaiming && conflict.providers.length > 1 && client) {
          for (const loser of conflict.providers) {
            if (loser.id !== selfId) {
              void client.announceToolRoleHandoff(conflict.group, loser.id, selfId);
            }
          }
        }
      }
    },
    [selfId, client]
  );

  // Register conflict handler when client connects
  useEffect(() => {
    if (!client) {
      // Reset state when disconnected
      setGroupStates({
        "file-ops": { ...DEFAULT_GROUP_STATE },
        "git-ops": { ...DEFAULT_GROUP_STATE },
        "workspace-ops": { ...DEFAULT_GROUP_STATE },
      });
      setPendingConflicts([]);
      return;
    }

    // Unsubscribe from previous handler
    if (unsubRef.current) {
      unsubRef.current();
    }

    // Subscribe to conflict events
    unsubRef.current = client.onToolRoleConflict(handleConflicts);

    return () => {
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
    };
  }, [client, handleConflicts]);

  /**
   * Check if this panel should provide tools for a group.
   * Returns true if no conflict or if we're the resolved provider.
   */
  const shouldProvideGroup = useCallback(
    (group: ToolGroup): boolean => {
      const state = groupStates[group];
      if (!state.resolvedProvider) {
        // No conflict detected, we can provide
        return state.providing;
      }
      // There's a conflict, only provide if we're the winner
      return state.resolvedProvider === selfId;
    },
    [groupStates, selfId]
  );

  /**
   * Request to take over a tool group from another provider.
   */
  const requestTakeOver = useCallback(
    async (group: ToolGroup) => {
      if (!client) return;

      // Mark as negotiating
      setGroupStates((prev) => ({
        ...prev,
        [group]: { ...prev[group], negotiating: true },
      }));

      try {
        await client.requestToolRole(group);
        // For panel-to-panel, handoff is auto-accepted
        // The roster will update and we'll get a new conflict check
        // which will resolve in our favor
        setGroupStates((prev) => ({
          ...prev,
          [group]: {
            ...prev[group],
            providing: true,
            negotiating: false,
          },
        }));
        // Remove pending conflict
        setPendingConflicts((prev) => prev.filter((p) => p.group !== group));
      } catch (err) {
        console.error(`[useToolRole] Failed to request takeover for ${group}:`, err);
        setGroupStates((prev) => ({
          ...prev,
          [group]: { ...prev[group], negotiating: false },
        }));
      }
    },
    [client]
  );

  /**
   * Accept using the existing provider (don't provide tools for this group).
   */
  const acceptExisting = useCallback((group: ToolGroup) => {
    setGroupStates((prev) => ({
      ...prev,
      [group]: {
        ...prev[group],
        providing: false,
        negotiating: false,
      },
    }));
    // Remove pending conflict
    setPendingConflicts((prev) => prev.filter((p) => p.group !== group));
  }, []);

  /**
   * Dismiss a pending conflict without taking action.
   */
  const dismissConflict = useCallback((group: ToolGroup) => {
    setPendingConflicts((prev) => prev.filter((p) => p.group !== group));
  }, []);

  /**
   * Handle incoming tool role request event.
   * Auto-accepts requests from other panels.
   */
  const handleToolRoleRequest = useCallback(
    (event: IncomingToolRoleRequestEvent) => {
      if (!client || !selfId) return;

      const { group, requesterId, requesterType } = event;
      const state = groupStates[group];

      // Only respond if we're currently providing this group
      if (!state.providing) {
        // Send explicit rejection so requester knows
        void client.respondToolRole(group, false);
        return;
      }

      // Auto-accept from other panels
      if (requesterType === "panel") {

        // Stop providing this group
        setGroupStates((prev) => ({
          ...prev,
          [group]: {
            ...prev[group],
            providing: false,
          },
        }));

        // Send response accepting the handoff
        void client.respondToolRole(group, true, requesterId);

        // Announce the handoff
        void client.announceToolRoleHandoff(group, selfId, requesterId);
      }
      // For non-panel requests, could show a modal asking the user
      // For now, we don't auto-accept from workers/agents
    },
    [client, selfId, groupStates]
  );

  /**
   * Handle incoming tool role response event.
   * Processes acceptance/rejection of our takeover request.
   */
  const handleToolRoleResponse = useCallback(
    (event: IncomingToolRoleResponseEvent) => {
      if (!selfId) return;

      const { group, accepted, handoffTo } = event;

      // Only process responses to our requests
      if (handoffTo !== selfId) return;

      if (accepted) {
        setGroupStates((prev) => ({
          ...prev,
          [group]: {
            ...prev[group],
            providing: true,
            negotiating: false,
            resolvedProvider: selfId,
          },
        }));
        // Remove pending conflict since we now own this group
        setPendingConflicts((prev) => prev.filter((p) => p.group !== group));
      } else {
        setGroupStates((prev) => ({
          ...prev,
          [group]: { ...prev[group], negotiating: false },
        }));
        // FIX: Clear pending conflict - we got a definitive answer
        setPendingConflicts((prev) => prev.filter((p) => p.group !== group));
      }
    },
    [selfId]
  );

  /**
   * Handle incoming tool role handoff event.
   * Updates group state when handoff completes.
   */
  const handleToolRoleHandoff = useCallback(
    (event: IncomingToolRoleHandoffEvent) => {
      if (!selfId) return;

      const { group, from, to } = event;

      // Update provider tracking
      setGroupStates((prev) => ({
        ...prev,
        [group]: {
          ...prev[group],
          resolvedProvider: to,
          // We're providing if we're the new provider
          providing: to === selfId,
        },
      }));

      // If we were the one handing off (from === selfId), we already stopped providing
      // If we're the new provider (to === selfId), we already started providing via response handler
      // FIX: Always clear pending conflict - handoff settles the conflict
      setPendingConflicts((prev) => prev.filter((p) => p.group !== group));
    },
    [selfId]
  );

  return {
    groupStates,
    pendingConflicts,
    shouldProvideGroup,
    requestTakeOver,
    acceptExisting,
    dismissConflict,
    handleToolRoleRequest,
    handleToolRoleResponse,
    handleToolRoleHandoff,
  };
}
