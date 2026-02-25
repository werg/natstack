/**
 * Shared utilities for AI responder workers.
 *
 * Protocol-level types, content constants, tracker factories, and action descriptions
 * have moved to @workspace/agentic-protocol. This file retains responder-specific
 * utilities: logging, formatting, and message targeting.
 */

import type { IncomingNewMessage } from "./types.js";

// Re-export everything that moved to protocol for backward compatibility
export {
  // Content type constants
  CONTENT_TYPE_THINKING,
  CONTENT_TYPE_ACTION,
  CONTENT_TYPE_INLINE_UI,
  CONTENT_TYPE_TYPING,
  // Tracker types
  type ChatParticipantMetadata,
  type InlineUiData,
  type ActionData,
  type TrackerClient,
  type TypingData,
  type ThinkingTrackerState,
  type ThinkingTrackerOptions,
  type ThinkingTracker,
  type ActionTrackerState,
  type ActionTrackerOptions,
  type ActionTracker,
  type TypingTrackerState,
  type TypingTrackerOptions,
  type TypingTracker,
  // Tracker factories
  createThinkingTracker,
  createActionTracker,
  createTypingTracker,
  // Action descriptions
  getDetailedActionDescription,
} from "@workspace/agentic-protocol";

/**
 * Create a prefixed logger function for responder workers.
 * @param prefix - The prefix to include in log messages (e.g., "Claude Code", "Codex")
 * @param workerId - Optional worker ID to include in logs
 */
export function createLogger(prefix: string, workerId?: string): (message: string) => void {
  const idPart = workerId ? ` ${workerId}` : "";
  return (message: string) => console.log(`[${prefix}${idPart}] ${message}`);
}

/**
 * Format arguments for logging, handling circular references and truncating long output.
 * @param args - The arguments to format
 * @param maxLen - Maximum length of the output string (default: 2000)
 */
export function formatArgsForLog(args: unknown, maxLen = 2000): string {
  const seen = new WeakSet();
  const serialized = JSON.stringify(
    args,
    (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value as object)) return "[Circular]";
        seen.add(value as object);
      }
      return value;
    },
    2
  );
  if (!serialized) return "<empty>";
  return serialized.length > maxLen ? `${serialized.slice(0, maxLen)}...` : serialized;
}

/**
 * Check if a message is targeted at a specific participant.
 * Returns true if:
 * - `at` is undefined or empty (broadcast to all)
 * - `at` includes the given participantId
 */
export function isMessageTargetedAt(msg: IncomingNewMessage, participantId: string): boolean {
  if (!msg.at || msg.at.length === 0) return true;
  return msg.at.includes(participantId);
}
