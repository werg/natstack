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
  AggregatedMessage,
} from "@workspace/agentic-messaging";
import type { Participant, Attachment } from "@workspace/pubsub";
import type { MethodHistoryEntry } from "../components/MethodHistoryItem";
import type { ChatParticipantMetadata, ChatMessage, PendingAgent } from "../types";

// ===========================================================================
// Aggregated → ChatMessage Converter
// ===========================================================================

/** Convert an AggregatedMessage (from collect replay or aggregated pagination) to ChatMessage */
export function aggregatedToChatMessage(event: AggregatedMessage): ChatMessage {
  return {
    id: event.id,
    pubsubId: event.pubsubId,
    senderId: event.senderId,
    content: event.content,
    contentType: event.contentType,
    kind: "message",
    complete: event.complete || !!event.error,
    error: event.error,
    replyTo: event.replyTo,
    senderMetadata: {
      name: event.senderName,
      type: event.senderType,
      handle: event.senderHandle,
    },
  };
}

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
  addMethodHistoryEntry: (entry: MethodHistoryEntry) => void;
  handleMethodResult: (result: IncomingMethodResult) => void;
  setDebugEvents?: (
    updater: (prev: Array<AgentDebugPayload & { ts: number }>) => Array<AgentDebugPayload & { ts: number }>
  ) => void;
  setDirtyRepoWarnings?: (
    updater: (prev: Map<string, DirtyRepoDetails>) => Map<string, DirtyRepoDetails>
  ) => void;
  setPendingAgents?: (updater: (prev: Map<string, PendingAgent>) => Map<string, PendingAgent>) => void;
  /**
   * Mutable set of agent handles that recently stopped due to idle timeout.
   * Populated by lifecycle events, consumed by roster handler to suppress
   * spurious "disconnected unexpectedly" messages for hibernating agents.
   */
  expectedStops?: Set<string>;
}

// ===========================================================================
// Helper Functions
// ===========================================================================

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
// Event Middleware
// ===========================================================================

/** Middleware function for event processing pipeline */
export type EventMiddleware = (event: IncomingEvent, next: () => void) => void;

// ===========================================================================
// Main Dispatcher
// ===========================================================================

/**
 * Handles incoming agentic events and updates appropriate state.
 * Pure function to keep event logic separate from component.
 *
 * @param middleware - Optional array of middleware functions that run before default handling.
 *   Each middleware receives the event and a `next` callback. Call `next()` to continue
 *   to the next middleware or default handling. Skip `next()` to swallow the event.
 */
export function dispatchAgenticEvent(
  event: IncomingEvent,
  handlers: AgentEventHandlers,
  selfId: string | null,
  participants: Record<string, Participant<ChatParticipantMetadata>>,
  middleware?: EventMiddleware[],
): void {
  // Run middleware chain if provided
  if (middleware && middleware.length > 0) {
    let index = 0;
    let continued = false;
    const runNext = () => {
      continued = true;
      index++;
      if (index < middleware.length) {
        continued = false;
        middleware[index]!(event, runNext);
      }
    };
    middleware[0]!(event, runNext);
    // If any middleware did not call next(), stop processing
    if (!continued && index < middleware.length) return;
  }

  const isSelf = !!selfId && event.senderId === selfId;
  const isPanelSender = event.senderMetadata?.type === "panel" || isSelf;

  switch (event.type) {
    case "message": {
      handlers.setMessages((prev) => {
        const existingIndex = prev.findIndex((m) => m.id === event.id);
        if (existingIndex !== -1) {
          if (prev[existingIndex]!.pending) {
            const updated = {
              ...prev[existingIndex]!,
              pending: false,
              // Merge attachments from server (in case local didn't have them)
              attachments: getEventAttachments(event) ?? prev[existingIndex]!.attachments,
            };
            if (isPanelSender) {
              updated.complete = true;
            }
            return prev.map((m, i) => (i === existingIndex ? updated : m));
          }
          return prev;
        }
        // Dedup by pubsubId (catches replay/pagination overlap)
        if (event.pubsubId !== undefined && prev.some(m => m.pubsubId === event.pubsubId)) {
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
            // Snapshot sender metadata so historical messages render correctly
            // even when the original participant is no longer in the roster.
            senderMetadata: event.senderMetadata as ChatMessage["senderMetadata"],
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
      // Keep last 300 events (~300KB) to keep the debug console useful
      const updated = [...prev.slice(-299), { ...debugPayload, ts: event.ts }];
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

    // Agent stopped due to idle timeout — record so roster handler can suppress
    // the "disconnected unexpectedly" message. The lifecycle event arrives before
    // the roster leave because agentHost emits it before killing the process.
    if (debugPayload.event === "stopped" && (debugPayload.reason === "timeout" || debugPayload.reason === "idle")) {
      handlers.expectedStops?.add(debugPayload.handle);
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
