import { useChatContext } from "../context/ChatContext";
import { AgentDebugConsole } from "./AgentDebugConsole";

/**
 * Agent debug console modal. Reads from ChatContext.
 */
export function ChatDebugConsole() {
  const { debugConsoleAgent, debugEvents, onDebugConsoleChange } = useChatContext();

  return (
    <AgentDebugConsole
      open={!!debugConsoleAgent}
      onOpenChange={(open) => !open && onDebugConsoleChange(null)}
      agentHandle={debugConsoleAgent ?? ""}
      debugEvents={debugEvents}
    />
  );
}
