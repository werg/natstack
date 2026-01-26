import { useEffect, useRef } from "react";
import { ensurePanelLoaded } from "@natstack/runtime";
import type { Participant, IncomingPresenceEvent } from "@natstack/agentic-messaging";
import type { ChatParticipantMetadata } from "../types";

interface AgentRecoveryState {
  handle: string;
  workerPanelId: string;
  agentTypeId: string;
  lastSeen: "join" | "leave-graceful" | "leave-disconnect";
  joinedAt?: number; // Timestamp for last-write-wins ordering
}

export interface AgentLoadError {
  handle: string;
  workerPanelId: string;
  buildState: string; // "error" | "dirty" | "not-git-repo" | "timeout" | "not-found"
  error: string;
}

interface UseAgentRecoveryOptions {
  enabled: boolean;
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  onAgentLoadError?: (error: AgentLoadError) => void;
}

/**
 * Hook to recover missing agents on chat panel load.
 *
 * Tracks agent worker records from presence events and kicks
 * workers that should be present but aren't (disconnected unexpectedly).
 *
 * - "graceful" leave: Worker chose to leave, don't reload
 * - "disconnect" leave: Worker crashed/reloaded, attempt to reload
 * - Missing worker: Worker's last state was "join", attempt to reload
 */
export function useAgentRecovery(
  presenceEvents: IncomingPresenceEvent[],
  options: UseAgentRecoveryOptions
) {
  const { enabled, participants, onAgentLoadError } = options;
  const kickedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;

    // Build agent state from presence history
    const agentStates = new Map<string, AgentRecoveryState>();

    for (const event of presenceEvents) {
      const metadata = event.metadata as ChatParticipantMetadata & {
        workerPanelId?: string;
        agentTypeId?: string;
      };

      // Only track agent workers (participants with workerPanelId and not panels)
      if (!metadata.workerPanelId || metadata.type === "panel") continue;

      const handle = metadata.handle;
      if (!handle) continue;

      if (event.action === "join") {
        const existing = agentStates.get(handle);
        const eventTs = event.ts ?? 0;
        // Last-write-wins: only update if newer or first seen
        if (!existing || !existing.joinedAt || eventTs > existing.joinedAt) {
          agentStates.set(handle, {
            handle,
            workerPanelId: metadata.workerPanelId,
            agentTypeId: metadata.agentTypeId ?? "unknown",
            lastSeen: "join",
            joinedAt: eventTs,
          });
        }
      } else if (event.action === "leave") {
        const existing = agentStates.get(handle);
        if (existing) {
          existing.lastSeen =
            event.leaveReason === "graceful" ? "leave-graceful" : "leave-disconnect";
        }
      }
    }

    // Determine which agents need to be kicked (reloaded)
    const missingAgents = Array.from(agentStates.values()).filter((state) => {
      // Agent gracefully left - don't reload
      if (state.lastSeen === "leave-graceful") return false;

      // Already attempted to reload this session
      if (kickedRef.current.has(state.workerPanelId)) return false;

      // Check if handle exists in current roster
      const currentWithHandle = Object.values(participants).find(
        (p) => p.metadata?.handle === state.handle
      );
      if (currentWithHandle) {
        // Handle exists - check if it's the same worker or a replacement
        const currentPanelId = (
          currentWithHandle.metadata as { workerPanelId?: string } | undefined
        )?.workerPanelId;
        if (currentPanelId && currentPanelId !== state.workerPanelId) {
          // Different worker has this handle now - don't reload old one
          return false;
        }
        // Same worker, already present - no reload needed
        return false;
      }

      // Agent disconnected or last seen joining - should reload
      return state.lastSeen === "join" || state.lastSeen === "leave-disconnect";
    });

    // Kick (reload) missing agents
    for (const agent of missingAgents) {
      kickedRef.current.add(agent.workerPanelId);

      console.log(
        `[AgentRecovery] Attempting to reload disconnected agent @${agent.handle} (panel: ${agent.workerPanelId})`
      );

      void ensurePanelLoaded(agent.workerPanelId)
        .then((result) => {
          if (!result.success) {
            // Special case: panel was deleted - just log, don't show prominent error
            if (result.buildState === "not-found") {
              console.warn(
                `[AgentRecovery] Agent @${agent.handle} worker panel ${agent.workerPanelId} no longer exists`
              );
              return;
            }

            // Report error for other failure cases
            console.warn(
              `[AgentRecovery] Failed to reload agent @${agent.handle}: ${result.error}`
            );
            try {
              onAgentLoadError?.({
                handle: agent.handle,
                workerPanelId: agent.workerPanelId,
                buildState: result.buildState,
                error: result.error ?? `Build failed: ${result.buildState}`,
              });
            } catch (callbackError) {
              console.error("[AgentRecovery] onAgentLoadError callback error:", callbackError);
            }
          } else {
            console.log(
              `[AgentRecovery] Successfully reloaded agent @${agent.handle}`
            );
          }
        })
        .catch((err) => {
          console.error(`[AgentRecovery] Error loading agent @${agent.handle}:`, err);
        });
    }
  }, [enabled, presenceEvents, participants, onAgentLoadError]);
}
