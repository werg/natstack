/**
 * Agent Event Dispatcher
 *
 * Handles incoming agentic events and routes them to appropriate state handlers.
 * Extracted from chat/index.tsx for better organization and testability.
 */

import type {
  IncomingEvent,
  IncomingMethodResult,
  IncomingAgentDebugEvent,
  AgentDebugPayload,
  AgentBuildError,
} from "@natstack/agentic-messaging";
import type { Participant, Attachment } from "@natstack/pubsub";
import type { MethodHistoryEntry } from "../components/MethodHistoryItem";
import type { ChatParticipantMetadata, ChatMessage, PendingAgent } from "../types";

// ===========================================================================
// Types
// ===========================================================================

/** Dirty repo warning details */
export interface DirtyRepoDetails {
  modified: string[];
  untracked: string[];
  staged: string[];
}

/** Handler functions passed to dispatchAgenticEvent */
export interface AgentEventHandlers {
  setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  setHistoricalParticipants: (
    updater: (
      prev: Record<string, Participant<ChatParticipantMetadata>>
    ) => Record<string, Participant<ChatParticipantMetadata>>
  ) => void;
  addMethodHistoryEntry: (entry: MethodHistoryEntry) => void;
  handleMethodResult: (result: IncomingMethodResult) => void;
  setDebugEvents?: (
    updater: (prev: Array<AgentDebugPayload & { ts: number }>) => Array<AgentDebugPayload & { ts: number }>
  ) => void;
  setDirtyRepoWarnings?: (
    updater: (prev: Map<string, DirtyRepoDetails>) => Map<string, DirtyRepoDetails>
  ) => void;
  setPendingAgents?: (updater: (prev: Map<string, PendingAgent>) => Map<string, PendingAgent>) => void;
}

// ===========================================================================
// Helper Functions
// ===========================================================================

/** Utility to check if a value looks like ChatParticipantMetadata */
export function isChatParticipantMetadata(value: unknown): value is ChatParticipantMetadata {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.name === "string" && typeof obj.type === "string" && typeof obj.handle === "string";
}

/** Extract contentType from event (typed loosely in the SDK) */
function getEventContentType(event: IncomingEvent): string | undefined {
  return (event as { contentType?: string }).contentType;
}

/** Extract attachments from event */
function getEventAttachments(event: IncomingEvent): Attachment[] | undefined {
  return (event as { attachments?: Attachment[] }).attachments;
}

/**
 * Look up a method description from a provider's method advertisements.
 */
function getMethodDescription(
  providerId: string | undefined,
  methodName: string,
  participants: Record<string, Participant<ChatParticipantMetadata>>
): string | undefined {
  if (!providerId) return undefined;
  const provider = participants[providerId];
  if (!provider?.metadata?.methods) return undefined;
  const method = provider.metadata.methods.find((m) => m.name === methodName);
  return method?.description;
}

// ===========================================================================
// Debug Event Type Guards
// ===========================================================================

interface LifecyclePayload {
  debugType: "lifecycle";
  event: "spawning" | "started" | "stopped" | "woken" | "warning";
  agentId: string;
  handle: string;
  reason?: "timeout" | "explicit" | "crash" | "idle" | "dirty-repo";
  details?: DirtyRepoDetails;
}

interface SpawnErrorPayload {
  debugType: "spawn-error";
  agentId: string;
  handle: string;
  error?: string;
  buildError?: AgentBuildError;
}

function isLifecycleEvent(payload: AgentDebugPayload): payload is LifecyclePayload {
  return payload.debugType === "lifecycle" && "event" in payload;
}

function isSpawnErrorEvent(payload: AgentDebugPayload): payload is SpawnErrorPayload {
  return payload.debugType === "spawn-error";
}

// ===========================================================================
// Main Dispatcher
// ===========================================================================

/**
 * Handles incoming agentic events and updates appropriate state.
 * Pure function to keep event logic separate from component.
 */
export function dispatchAgenticEvent(
  event: IncomingEvent,
  handlers: AgentEventHandlers,
  selfId: string | null,
  participants: Record<string, Participant<ChatParticipantMetadata>>
): void {
  const isSelf = !!selfId && event.senderId === selfId;
  const isPanelSender = event.senderMetadata?.type === "panel" || isSelf;

  switch (event.type) {
    case "message": {
      handlers.setMessages((prev) => {
        const existingIndex = prev.findIndex((m) => m.id === event.id);
        if (existingIndex !== -1) {
          if (prev[existingIndex].pending) {
            const updated = {
              ...prev[existingIndex],
              pending: false,
              // Merge attachments from server (in case local didn't have them)
              attachments: getEventAttachments(event) ?? prev[existingIndex].attachments,
            };
            if (isPanelSender) {
              updated.complete = true;
            }
            return prev.map((m, i) => (i === existingIndex ? updated : m));
          }
          return prev;
        }
        return [
          ...prev,
          {
            id: event.id,
            pubsubId: event.pubsubId,
            senderId: event.senderId,
            content: event.content,
            contentType: getEventContentType(event),
            replyTo: event.replyTo,
            kind: "message",
            complete: event.kind === "replay" || isPanelSender,
            attachments: getEventAttachments(event),
          },
        ];
      });
      break;
    }

    case "update-message": {
      handlers.setMessages((prev) =>
        prev.map((m) =>
          m.id === event.id
            ? {
                ...m,
                content: event.content !== undefined ? m.content + event.content : m.content,
                contentType: getEventContentType(event) ?? m.contentType,
                complete: event.complete ?? m.complete,
              }
            : m
        )
      );
      break;
    }

    case "error": {
      handlers.setMessages((prev) =>
        prev.map((m) => (m.id === event.id ? { ...m, complete: true, error: event.error } : m))
      );
      break;
    }

    case "method-call": {
      if (event.kind !== "replay" && event.providerId === selfId) {
        return;
      }
      handlers.addMethodHistoryEntry({
        callId: event.callId,
        methodName: event.methodName,
        description: getMethodDescription(event.providerId, event.methodName, participants),
        args: event.args,
        status: "pending",
        startedAt: event.ts ?? Date.now(),
        providerId: event.providerId,
        callerId: event.senderId,
        handledLocally: false,
      });
      break;
    }

    case "method-result": {
      handlers.handleMethodResult(event as IncomingMethodResult);
      break;
    }

    case "presence": {
      if (event.action === "join" && isChatParticipantMetadata(event.metadata)) {
        handlers.setHistoricalParticipants((prev) => ({
          ...prev,
          [event.senderId]: {
            id: event.senderId,
            metadata: event.metadata as ChatParticipantMetadata,
          },
        }));
      }
      break;
    }

    case "execution-pause": {
      handlers.setMessages((prev) =>
        prev.map((m) => (m.id === event.messageId ? { ...m, complete: true } : m))
      );
      break;
    }

    case "agent-debug": {
      handleAgentDebugEvent(event as IncomingAgentDebugEvent, handlers);
      break;
    }
  }
}

/**
 * Handle agent-debug events separately for clarity.
 */
function handleAgentDebugEvent(
  event: IncomingAgentDebugEvent,
  handlers: AgentEventHandlers
): void {
  const debugPayload = event.payload;

  // Store all debug events for the debug console
  if (handlers.setDebugEvents) {
    handlers.setDebugEvents((prev) => {
      // Keep last 500 events to prevent memory bloat
      const updated = [...prev.slice(-499), { ...debugPayload, ts: event.ts }];
      return updated;
    });
  }

  // Handle lifecycle events
  if (isLifecycleEvent(debugPayload)) {
    // Dirty repo warnings
    if (debugPayload.event === "warning" && debugPayload.reason === "dirty-repo") {
      if (handlers.setDirtyRepoWarnings && debugPayload.details) {
        handlers.setDirtyRepoWarnings((prev) => {
          const next = new Map(prev);
          next.set(debugPayload.handle, debugPayload.details!);
          return next;
        });
      }
    }

    // Agent spawning - add to pending agents
    if (debugPayload.event === "spawning" && handlers.setPendingAgents) {
      handlers.setPendingAgents((prev) => {
        // Don't overwrite existing entry (could be error state)
        if (prev.has(debugPayload.handle)) return prev;
        const next = new Map(prev);
        next.set(debugPayload.handle, {
          agentId: debugPayload.agentId,
          status: "starting",
        });
        return next;
      });
    }
  }

  // Handle spawn errors
  if (isSpawnErrorEvent(debugPayload) && handlers.setPendingAgents) {
    const buildError: AgentBuildError = debugPayload.buildError ?? {
      message: debugPayload.error ?? "Unknown spawn error",
    };

    handlers.setPendingAgents((prev) => {
      const next = new Map(prev);
      // Find by handle first, then by agentId if handle is missing
      let targetHandle = debugPayload.handle;
      if (!targetHandle) {
        for (const [h, info] of prev) {
          if (info.agentId === debugPayload.agentId) {
            targetHandle = h;
            break;
          }
        }
      }
      if (!targetHandle) return prev; // Can't find matching entry
      next.set(targetHandle, {
        agentId: debugPayload.agentId,
        status: "error",
        error: buildError,
      });
      return next;
    });
  }
}
