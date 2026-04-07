import { useState } from "react";
import type { AgentDebugPayload } from "@natstack/pubsub";
import type { DirtyRepoDetails } from "@workspace/agentic-core";

export interface ChatDebugState {
  debugConsoleAgent: string | null;
  setDebugConsoleAgent: (agentHandle: string | null) => void;
}

/**
 * UI-only state for the chat debug console.
 *
 * Debug event streams and dirty-repo warnings live on `SessionManager` (exposed
 * via `useChatCore`). This hook just owns which agent the debug console is
 * currently focused on — a pure React/UI concern.
 */
export function useChatDebug(): ChatDebugState {
  const [debugConsoleAgent, setDebugConsoleAgent] = useState<string | null>(null);
  return { debugConsoleAgent, setDebugConsoleAgent };
}
