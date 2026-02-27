/**
 * useChatDebug — Debug events + dirty repo warnings.
 *
 * Manages debug event state, debug console selection, and dirty repo warning dismissal.
 */

import { useState, useCallback } from "react";
import type { AgentDebugPayload } from "@workspace/agentic-messaging";
import type { DirtyRepoDetails } from "../useAgentEvents";

export interface ChatDebugState {
  debugEvents: Array<AgentDebugPayload & { ts: number }>;
  setDebugEvents: React.Dispatch<React.SetStateAction<Array<AgentDebugPayload & { ts: number }>>>;
  debugConsoleAgent: string | null;
  setDebugConsoleAgent: (agentHandle: string | null) => void;
  dirtyRepoWarnings: Map<string, DirtyRepoDetails>;
  setDirtyRepoWarnings: React.Dispatch<React.SetStateAction<Map<string, DirtyRepoDetails>>>;
  onDismissDirtyWarning: (agentName: string) => void;
  /** Reset debug state */
  resetDebug: () => void;
}

export function useChatDebug(): ChatDebugState {
  const [debugEvents, setDebugEvents] = useState<Array<AgentDebugPayload & { ts: number }>>([]);
  const [debugConsoleAgent, setDebugConsoleAgent] = useState<string | null>(null);
  const [dirtyRepoWarnings, setDirtyRepoWarnings] = useState<Map<string, DirtyRepoDetails>>(new Map());

  const onDismissDirtyWarning = useCallback((agentName: string) => {
    setDirtyRepoWarnings((prev) => {
      const next = new Map(prev);
      next.delete(agentName);
      return next;
    });
  }, []);

  const resetDebug = useCallback(() => {
    setDebugEvents([]);
    setDebugConsoleAgent(null);
    setDirtyRepoWarnings(new Map());
  }, []);

  return {
    debugEvents,
    setDebugEvents,
    debugConsoleAgent,
    setDebugConsoleAgent,
    dirtyRepoWarnings,
    setDirtyRepoWarnings,
    onDismissDirtyWarning,
    resetDebug,
  };
}
