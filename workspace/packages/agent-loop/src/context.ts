/**
 * buildModelContext (WS1 §1.4.1 / §2.4.1, pure): convert the folded session
 * entries into a model message array. Replaces buildSessionContext +
 * TrajectoryBackedSessionStorage — the log IS the session.
 */

import type { AgentState, SessionEntry } from "./state.js";

export interface ModelMessage {
  role: "user" | "assistant" | "toolResult";
  content?: unknown;
  blocks?: unknown[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export function buildModelContext(
  state: AgentState,
  contextThroughSeq: number = Number.POSITIVE_INFINITY
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const entry of state.entries) {
    if (entry.seq > contextThroughSeq) break;
    messages.push(modelMessageFromEntry(entry));
  }
  return messages;
}

function modelMessageFromEntry(entry: SessionEntry): ModelMessage {
  switch (entry.kind) {
    case "user":
      return { role: "user", content: entry.content };
    case "assistant":
      return { role: "assistant", blocks: entry.blocks };
    case "tool-result":
      return {
        role: "toolResult",
        toolCallId: entry.invocationId,
        toolName: entry.name,
        content: entry.result,
        isError: entry.isError,
      };
    case "note":
      return { role: "user", content: { note: entry.text } };
  }
}
