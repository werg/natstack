import { useEffect, useRef } from "react";
import { ensurePanelLoaded } from "@natstack/runtime";
import type { Participant } from "@natstack/agentic-messaging";
import type { ChatParticipantMetadata } from "../types";

export interface WorkerBuildError {
  panelId: string;
  buildState: string;
  error: string;
  handle?: string;
}

interface UseExpectedWorkerMonitorOptions {
  /**
   * Expected worker panel IDs from the chat-launcher.
   * These are the panels that were spawned and should eventually join the channel.
   */
  expectedWorkerPanelIds: string[];
  /**
   * Current roster of participants in the channel.
   * Used to detect which workers have joined.
   */
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  /**
   * Whether monitoring should be active (e.g., only when connected).
   */
  enabled: boolean;
  /**
   * Callback when a worker fails to load due to build issues.
   */
  onWorkerBuildError?: (error: WorkerBuildError) => void;
  /**
   * How long to wait before checking unjoined workers (default: 10 seconds).
   * Workers may take time to build and initialize.
   */
  checkDelayMs?: number;
}

/**
 * Hook to monitor expected worker panels and detect build failures.
 *
 * When workers are spawned by the chat-launcher, they may fail to start due to
 * build issues (dirty git state, compile errors, etc.). This hook monitors
 * expected workers and checks their status if they haven't joined within
 * a reasonable time.
 *
 * Unlike useAgentRecovery (which handles agents that joined then disconnected),
 * this hook handles agents that never joined in the first place.
 */
export function useExpectedWorkerMonitor(options: UseExpectedWorkerMonitorOptions) {
  const {
    expectedWorkerPanelIds,
    participants,
    enabled,
    onWorkerBuildError,
    checkDelayMs = 10000,
  } = options;

  // Track which workers we've already checked to avoid duplicate checks
  const checkedRef = useRef<Set<string>>(new Set());
  // Track timer so we can clean up
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || expectedWorkerPanelIds.length === 0) {
      return;
    }

    // Clear any existing timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Get list of worker panel IDs that have joined (from participant metadata)
    const joinedWorkerPanelIds = new Set(
      Object.values(participants)
        .map((p) => (p.metadata as { workerPanelId?: string } | undefined)?.workerPanelId)
        .filter((id): id is string => !!id)
    );

    // Find workers that haven't joined yet and haven't been checked
    const unjoinedWorkers = expectedWorkerPanelIds.filter(
      (panelId) => !joinedWorkerPanelIds.has(panelId) && !checkedRef.current.has(panelId)
    );

    if (unjoinedWorkers.length === 0) {
      return;
    }

    // Set a timer to check the unjoined workers after the delay
    // This gives them time to build and join
    timerRef.current = setTimeout(() => {
      // Re-check which workers have joined (state may have changed during delay)
      const currentJoinedIds = new Set(
        Object.values(participants)
          .map((p) => (p.metadata as { workerPanelId?: string } | undefined)?.workerPanelId)
          .filter((id): id is string => !!id)
      );

      for (const panelId of unjoinedWorkers) {
        // Skip if already joined or already checked
        if (currentJoinedIds.has(panelId) || checkedRef.current.has(panelId)) {
          continue;
        }

        // Mark as checked to avoid duplicate checks
        checkedRef.current.add(panelId);

        // Check the panel's status
        console.log(`[ExpectedWorkerMonitor] Checking status of expected worker panel: ${panelId}`);

        void ensurePanelLoaded(panelId)
          .then((result) => {
            if (!result.success) {
              // Panel failed to load - this is the issue we're looking for
              console.warn(
                `[ExpectedWorkerMonitor] Worker panel ${panelId} failed to load: ${result.buildState} - ${result.error}`
              );

              // Special case: panel was deleted - just log, don't show prominent error
              if (result.buildState === "not-found") {
                console.warn(
                  `[ExpectedWorkerMonitor] Worker panel ${panelId} no longer exists`
                );
                return;
              }

              // Report the error
              onWorkerBuildError?.({
                panelId,
                buildState: result.buildState,
                error: result.error ?? `Build failed: ${result.buildState}`,
              });
            } else {
              // Panel loaded successfully but hasn't joined yet - might just be slow
              // Give it more time; if it still doesn't join, useAgentRecovery will handle it
              console.log(
                `[ExpectedWorkerMonitor] Worker panel ${panelId} loaded successfully, waiting for join`
              );
            }
          })
          .catch((err) => {
            console.error(`[ExpectedWorkerMonitor] Error checking worker panel ${panelId}:`, err);
          });
      }
    }, checkDelayMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, expectedWorkerPanelIds, participants, onWorkerBuildError, checkDelayMs]);
}
