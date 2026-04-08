/**
 * usePiTextDeltas — Accumulate text-delta ephemerals for the typing indicator.
 *
 * Pi (`@mariozechner/pi-coding-agent`) emits text deltas as the LLM streams
 * tokens. The agent worker forwards each delta as a `natstack-text-delta`
 * ephemeral. This hook accumulates deltas with a timestamp later than
 * `sinceTs` (typically `usePiSessionSnapshot().latestTs`).
 *
 * As soon as a new snapshot arrives (sinceTs increases), the accumulator
 * resets — the typing-indicator overlay is replaced by the canonical
 * snapshot text.
 */

import { useMemo } from "react";
import {
  parseEphemeralEvent,
  type EphemeralMessageLike,
} from "@workspace/agentic-core";

export interface TextDeltaPayload {
  messageId: string;
  delta: string;
}

export interface PiTextDeltaResult {
  messageId: string;
  text: string;
}

/**
 * Returns the accumulated text-delta string for the in-progress message
 * since `sinceTs`. Returns null if no delta has arrived since then.
 */
export function usePiTextDeltas(
  ephemeralMessages: ReadonlyArray<EphemeralMessageLike & { ts: number }>,
  sinceTs: number,
): PiTextDeltaResult | null {
  return useMemo(() => {
    let acc = "";
    let messageId = "";
    for (const msg of ephemeralMessages) {
      if (msg.ts <= sinceTs) continue;
      const parsed = parseEphemeralEvent<TextDeltaPayload>(
        msg,
        "natstack-text-delta",
      );
      if (!parsed) continue;
      if (messageId && parsed.messageId !== messageId) {
        // A new in-progress message started; reset the accumulator.
        acc = parsed.delta;
        messageId = parsed.messageId;
      } else {
        messageId = parsed.messageId;
        acc += parsed.delta;
      }
    }
    return acc ? { messageId, text: acc } : null;
  }, [ephemeralMessages, sinceTs]);
}
