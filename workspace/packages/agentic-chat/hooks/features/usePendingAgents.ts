/**
 * usePendingAgents — Tracks agents that have been invited but haven't joined yet.
 *
 * Handles: pending agent state, 45-second timeout, roster-based resolution.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { Participant, RosterUpdate } from "@natstack/pubsub";
import type { PendingAgent, ChatParticipantMetadata } from "../../types";
import type { RosterExtension } from "../core/useChatCore";

interface PendingAgentInfo {
  agentId: string;
  handle: string;
}

interface UsePendingAgentsOptions {
  /** Initial pending agents from launcher */
  initialPendingAgents?: PendingAgentInfo[];
}

export interface PendingAgentsState {
  pendingAgents: Map<string, PendingAgent>;
  setPendingAgents: React.Dispatch<React.SetStateAction<Map<string, PendingAgent>>>;
  /** Roster extension — resolves pending agents when they appear */
  rosterExtension: RosterExtension;
  /** Reset pending agents state */
  resetPending: () => void;
}

const PENDING_TIMEOUT_MS = 45_000;

export function usePendingAgents({ initialPendingAgents }: UsePendingAgentsOptions = {}): PendingAgentsState {
  const [pendingAgents, setPendingAgents] = useState<Map<string, PendingAgent>>(() => {
    const initial = new Map<string, PendingAgent>();
    if (initialPendingAgents) {
      for (const agent of initialPendingAgents) {
        initial.set(agent.handle, { agentId: agent.agentId, status: "starting" });
      }
    }
    return initial;
  });

  // Timeout handling
  const pendingTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timeouts = pendingTimeoutsRef.current;
    for (const [handle, agent] of pendingAgents) {
      if (agent.status === "starting" && !timeouts.has(handle)) {
        const timeout = setTimeout(() => {
          setPendingAgents(prev => {
            const next = new Map(prev);
            const existing = next.get(handle);
            if (existing?.status === "starting") {
              next.set(handle, {
                ...existing,
                status: "error",
                error: { message: "Agent failed to start (timeout)" },
              });
            }
            return next;
          });
          timeouts.delete(handle);
        }, PENDING_TIMEOUT_MS);
        timeouts.set(handle, timeout);
      }
    }
    for (const [handle, timeout] of timeouts) {
      if (!pendingAgents.has(handle)) {
        clearTimeout(timeout);
        timeouts.delete(handle);
      }
    }
  }, [pendingAgents]);

  useEffect(() => {
    return () => {
      for (const timeout of pendingTimeoutsRef.current.values()) {
        clearTimeout(timeout);
      }
    };
  }, []);

  // Roster extension: resolve pending agents when they appear
  const rosterExtension: RosterExtension = useCallback((
    roster: RosterUpdate<ChatParticipantMetadata>,
    _prevParticipants: Record<string, Participant<ChatParticipantMetadata>>,
  ) => {
    const newHandles = new Set(Object.values(roster.participants).map((p) => p.metadata.handle));
    setPendingAgents((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const handle of prev.keys()) {
        if (newHandles.has(handle)) { next.delete(handle); changed = true; }
      }
      return changed ? next : prev;
    });
  }, []);

  const resetPending = useCallback(() => {
    setPendingAgents(new Map());
  }, []);

  return {
    pendingAgents,
    setPendingAgents,
    rosterExtension,
    resetPending,
  };
}
