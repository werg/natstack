import { useState } from "react";
import type { AgentDebugPayload } from "@natstack/pubsub";
import type { DirtyRepoDetails } from "@workspace/agentic-core";

export interface ChatDebugState {
  debugConsoleAgent: string | null;
  setDebugConsoleAgent: (agentHandle: string | null) => void;
}

/**
 * @deprecated Debug event and dirty repo warning state has moved to SessionManager
 * (exposed via useChatCore). This hook only manages the UI-specific debugConsoleAgent.
 */
export function useChatDebug(): ChatDebugState {
  const [debugConsoleAgent, setDebugConsoleAgent] = useState<string | null>(null);
  return { debugConsoleAgent, setDebugConsoleAgent };
}
