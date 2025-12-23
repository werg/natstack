/**
 * Shared utilities for AI responder workers.
 *
 * These utilities provide common functionality used across different
 * responder implementations (Claude Code, Codex, etc.).
 */

import type { AgenticParticipantMetadata } from "./types.js";

/**
 * Standard participant metadata for chat-style channels.
 * Used by responder workers and panels to identify participant types.
 */
export interface ChatParticipantMetadata extends AgenticParticipantMetadata {
  name: string;
  type: "panel" | "ai-responder" | "claude-code" | "codex";
}

/**
 * Safely parse AGENT_CONFIG from environment.
 * Returns empty object if parsing fails or config is invalid.
 */
export function parseAgentConfig(): Record<string, unknown> {
  const raw = process.env["AGENT_CONFIG"];
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

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
