/**
 * usePiSessionSnapshot — Render the latest Pi state snapshot from a channel's
 * ephemeral message stream.
 *
 * Pi (`@mariozechner/pi-coding-agent`) is the source of truth for chat state.
 * The agent worker forwards `session.state.messages` as a JSON-encoded
 * `natstack-state-snapshot` ephemeral message after every meaningful state
 * change. This hook returns the most recent snapshot — no event replay,
 * no state machine.
 */

import { useMemo } from "react";
import {
  parseEphemeralEvent,
  type EphemeralMessageLike,
} from "@workspace/agentic-core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

export interface PiSnapshotPayload {
  messages: AgentMessage[];
  isStreaming: boolean;
}

export interface PiSessionSnapshotResult {
  /** The latest snapshot's messages array, or [] if no snapshot has arrived. */
  snapshot: PiSnapshotPayload;
  /** Timestamp (ms) of the latest snapshot ephemeral, or 0 if none. */
  latestTs: number;
}

/**
 * Scan a list of ephemeral messages for the most recent
 * `natstack-state-snapshot` payload. The input is the channel's full
 * ephemeral stream (or any prefix); the hook walks backward and returns
 * the first valid snapshot it finds.
 */
export function usePiSessionSnapshot(
  ephemeralMessages: ReadonlyArray<EphemeralMessageLike & { ts: number }>,
): PiSessionSnapshotResult {
  return useMemo(() => {
    for (let i = ephemeralMessages.length - 1; i >= 0; i--) {
      const msg = ephemeralMessages[i]!;
      const parsed = parseEphemeralEvent<PiSnapshotPayload>(
        msg,
        "natstack-state-snapshot",
      );
      if (parsed) return { snapshot: parsed, latestTs: msg.ts };
    }
    return { snapshot: { messages: [], isStreaming: false }, latestTs: 0 };
  }, [ephemeralMessages]);
}
