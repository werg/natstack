import { useEffect, useRef, useCallback } from "react";
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
  // Track which panel IDs we've scheduled checks for
  const scheduledRef = useRef<Set<string>>(new Set());
  // Keep current participants in a ref so setTimeout can access fresh values
  const participantsRef = useRef(participants);
  participantsRef.current = participants;
  // Keep callback in a ref to avoid stale closures
  const onErrorRef = useRef(onWorkerBuildError);
  onErrorRef.current = onWorkerBuildError;

  // Function to check a single panel's status
  const checkPanel = useCallback((panelId: string) => {
    // Skip if already checked
    if (checkedRef.current.has(panelId)) {
      return;
    }

    // Check if the worker has joined by now
    const currentParticipants = participantsRef.current;
    const joinedWorkerPanelIds = new Set(
      Object.values(currentParticipants)
        .map((p) => (p.metadata as { workerPanelId?: string } | undefined)?.workerPanelId)
        .filter((id): id is string => !!id)
    );

    if (joinedWorkerPanelIds.has(panelId)) {
      console.log(`[ExpectedWorkerMonitor] Worker panel ${panelId} has joined, skipping check`);
      checkedRef.current.add(panelId);
      return;
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
          onErrorRef.current?.({
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
  }, []);

  // Schedule checks for new panel IDs when they arrive
  useEffect(() => {
    if (!enabled || expectedWorkerPanelIds.length === 0) {
      return;
    }

    // Find panel IDs we haven't scheduled yet
    const newPanelIds = expectedWorkerPanelIds.filter(
      (id) => !scheduledRef.current.has(id) && !checkedRef.current.has(id)
    );

    if (newPanelIds.length === 0) {
      return;
    }

    console.log(`[ExpectedWorkerMonitor] Scheduling checks for ${newPanelIds.length} worker panels:`, newPanelIds);

    // Schedule a check for each new panel ID
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const panelId of newPanelIds) {
      scheduledRef.current.add(panelId);
      const timer = setTimeout(() => {
        checkPanel(panelId);
      }, checkDelayMs);
      timers.push(timer);
    }

    return () => {
      // Clean up timers on unmount
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [enabled, expectedWorkerPanelIds, checkDelayMs, checkPanel]);
}
