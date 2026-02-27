/**
 * useRosterTracking — Disconnect detection + participant lifecycle.
 *
 * Tracks historical participants, detects agent disconnections,
 * suppresses false disconnect messages for expected stops (idle/hibernation),
 * and cleans up stale typing indicators on reconnection.
 */

import { useCallback, useRef, useState } from "react";
import type { Participant, RosterUpdate } from "@natstack/pubsub";
import type { ChatMessage, ChatParticipantMetadata, DisconnectedAgentInfo } from "../../types";
import type { RosterExtension } from "../core/useChatCore";

interface UseRosterTrackingOptions {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  configClientId: string;
}

export interface RosterTrackingState {
  historicalParticipants: Record<string, Participant<ChatParticipantMetadata>>;
  /** Mutable set of agent handles expected to stop (idle timeout / hibernation) */
  expectedStopsRef: React.MutableRefObject<Set<string>>;
  /** Roster extension callback — register with useChatCore */
  rosterExtension: RosterExtension;
  /** Reconnect handler — clears disconnect messages and resets suppression */
  onReconnect: () => void;
  /** Reset roster tracking state */
  resetRoster: () => void;
}

export function useRosterTracking({
  setMessages,
  configClientId,
}: UseRosterTrackingOptions): RosterTrackingState {
  const [historicalParticipants, setHistoricalParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});
  const suppressDisconnectRef = useRef(true);
  const expectedStopsRef = useRef(new Set<string>());

  const rosterExtension: RosterExtension = useCallback((
    roster: RosterUpdate<ChatParticipantMetadata>,
    prevParticipants: Record<string, Participant<ChatParticipantMetadata>>,
  ) => {
    const newParticipants = roster.participants;

    // Unsuppress disconnect detection once we see ourselves in the roster
    if (suppressDisconnectRef.current && configClientId in newParticipants) {
      suppressDisconnectRef.current = false;
    }

    // Track historical participants (ever-seen)
    setHistoricalParticipants((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [id, participant] of Object.entries(newParticipants)) {
        if (!(id in next)) { next[id] = participant; changed = true; }
      }
      return changed ? next : prev;
    });

    const prevIds = new Set(Object.keys(prevParticipants));
    const newIds = new Set(Object.keys(newParticipants));
    const disconnectedIds: string[] = [];

    if (!suppressDisconnectRef.current) {
      const changeIsGraceful = roster.change?.type === "leave" && roster.change.leaveReason === "graceful";

      for (const prevId of prevIds) {
        if (!newIds.has(prevId)) {
          disconnectedIds.push(prevId);
          if (changeIsGraceful && roster.change?.participantId === prevId) {
            continue;
          }
          const disconnected = prevParticipants[prevId];
          const meta = disconnected?.metadata;
          if (meta && meta.type !== "panel") {
            const isExpectedStop = expectedStopsRef.current.has(meta.handle) || changeIsGraceful;
            expectedStopsRef.current.delete(meta.handle);

            if (!isExpectedStop) {
              const agentInfo: DisconnectedAgentInfo = {
                name: meta.name, handle: meta.handle, panelId: meta.panelId, agentTypeId: meta.agentTypeId, type: meta.type,
              };
              setMessages((prev) => [...prev, {
                id: `system-disconnect-${prevId}-${Date.now()}`, senderId: "system", content: "", kind: "system", complete: true, disconnectedAgent: agentInfo,
              }]);
            }
          }
        }
      }
    }

    // Clear typing indicators for disconnected agents
    if (disconnectedIds.length > 0) {
      const disconnectedSet = new Set(disconnectedIds);
      setMessages((prev) => {
        let changed = false;
        const next = prev.map((msg) => {
          if (msg.contentType === "typing" && !msg.complete && disconnectedSet.has(msg.senderId)) { changed = true; return { ...msg, complete: true }; }
          return msg;
        });
        return changed ? next : prev;
      });
    }

    // Handle reconnecting agents — clear stale typing from old client IDs
    const reconnectingHandles = new Set<string>();
    for (const newId of newIds) {
      if (!prevIds.has(newId) && newParticipants[newId]?.metadata?.type !== "panel") {
        reconnectingHandles.add(newParticipants[newId]!.metadata.handle);
      }
    }

    if (reconnectingHandles.size > 0) {
      const staleSenderIds = new Set<string>();
      for (const [id, p] of Object.entries(prevParticipants)) {
        if (reconnectingHandles.has(p.metadata.handle) && !newIds.has(id)) { staleSenderIds.add(id); }
      }
      if (staleSenderIds.size > 0) {
        setMessages((prev) => {
          let changed = false;
          const next = prev.map((msg) => {
            if (msg.contentType === "typing" && !msg.complete && staleSenderIds.has(msg.senderId)) { changed = true; return { ...msg, complete: true }; }
            return msg;
          });
          return changed ? next : prev;
        });
      }
    }

    // Remove stale disconnect messages when an agent with the same handle reconnects
    const agentHandles = new Set(Object.values(newParticipants).filter(p => p.metadata.type !== "panel").map(p => p.metadata.handle));
    setMessages((prev) => {
      const filtered = prev.filter(msg => {
        if (msg.kind !== "system" || !msg.disconnectedAgent) return true;
        return !agentHandles.has(msg.disconnectedAgent.handle);
      });
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [setMessages, configClientId]);

  const onReconnect = useCallback(() => {
    suppressDisconnectRef.current = true;
    setMessages((prev) => {
      const filtered = prev.filter(msg => msg.kind !== "system" || !msg.disconnectedAgent);
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [setMessages]);

  const resetRoster = useCallback(() => {
    setHistoricalParticipants({});
    suppressDisconnectRef.current = true;
    expectedStopsRef.current.clear();
  }, []);

  return {
    historicalParticipants,
    expectedStopsRef,
    rosterExtension,
    onReconnect,
    resetRoster,
  };
}
