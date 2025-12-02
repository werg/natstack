import { atom } from "jotai";
import type { ChannelMessage, MessageContent, TextContent } from "../../types/messages";
import { createMessageId } from "../../types/messages";
import { channelIdAtom, channelUpdatedAtAtom } from "./coreAtoms";
import { validateMessage } from "../validation";

/**
 * Message-related atoms.
 * Handles the message list, message queue, and message mutations via action-based pattern.
 */

/** All messages in the channel */
export const messagesAtom = atom<ChannelMessage[]>([]);

/** Message queue for queued messages during generation */
export const messageQueueAtom = atom<Array<Omit<ChannelMessage, "id" | "timestamp" | "channelId">>>([]);

/** Check if there are queued messages */
export const hasQueuedMessagesAtom = atom((get) => {
  return get(messageQueueAtom).length > 0;
});

// =============================================================================
// Message Actions - Consolidated action-based mutation pattern
// =============================================================================

/** Message action types */
export type MessageAction =
  | { type: "send"; message: Omit<ChannelMessage, "id" | "timestamp" | "channelId"> }
  | { type: "queue"; message: Omit<ChannelMessage, "id" | "timestamp" | "channelId"> }
  | { type: "processQueue" }
  | { type: "update"; messageId: string; update: Partial<MessageContent> }
  | { type: "append"; messageId: string; delta: string }
  | { type: "finishStreaming"; messageId: string }
  | { type: "updateToolStatus"; messageId: string; status: ChannelMessage["toolStatus"] };

/**
 * Unified message dispatcher - single entry point for all message mutations.
 * Returns the affected message ID (for send/queue actions) or undefined.
 */
export const dispatchMessageAtom = atom(
  null,
  (get, set, action: MessageAction): string | undefined => {
    const channelId = get(channelIdAtom);

    switch (action.type) {
      case "send": {
        validateMessage(action.message);
        const fullMessage: ChannelMessage = {
          ...action.message,
          id: createMessageId(),
          channelId,
          timestamp: new Date(),
        };
        set(messagesAtom, [...get(messagesAtom), fullMessage]);
        set(channelUpdatedAtAtom, new Date());
        return fullMessage.id;
      }

      case "queue": {
        set(messageQueueAtom, [...get(messageQueueAtom), action.message]);
        return undefined;
      }

      case "processQueue": {
        const queue = get(messageQueueAtom);
        const newMessages = queue.map((message) => {
          validateMessage(message);
          return {
            ...message,
            id: createMessageId(),
            channelId,
            timestamp: new Date(),
          } as ChannelMessage;
        });

        if (newMessages.length > 0) {
          set(messagesAtom, [...get(messagesAtom), ...newMessages]);
          set(messageQueueAtom, []);
          set(channelUpdatedAtAtom, new Date());
        }
        return undefined;
      }

      case "update": {
        const messages = get(messagesAtom);
        const index = messages.findIndex((m) => m.id === action.messageId);
        if (index !== -1) {
          const message = messages[index];
          const updatedMessages = [
            ...messages.slice(0, index),
            {
              ...message,
              content: { ...message.content, ...action.update } as MessageContent,
            },
            ...messages.slice(index + 1),
          ];
          set(messagesAtom, updatedMessages);
          set(channelUpdatedAtAtom, new Date());
        }
        return action.messageId;
      }

      case "append": {
        const messages = get(messagesAtom);
        const index = messages.findIndex((m) => m.id === action.messageId);
        if (index !== -1) {
          const message = messages[index];
          if (message.content.type === "text") {
            const textContent = message.content as TextContent;
            const updatedMessages = [
              ...messages.slice(0, index),
              {
                ...message,
                content: { ...textContent, text: textContent.text + action.delta },
              },
              ...messages.slice(index + 1),
            ];
            set(messagesAtom, updatedMessages);
          }
        }
        return action.messageId;
      }

      case "finishStreaming": {
        const messages = get(messagesAtom);
        const index = messages.findIndex((m) => m.id === action.messageId);
        if (index !== -1) {
          const message = messages[index];
          const updatedMessages = [
            ...messages.slice(0, index),
            { ...message, isStreaming: false },
            ...messages.slice(index + 1),
          ];
          set(messagesAtom, updatedMessages);
        }
        return action.messageId;
      }

      case "updateToolStatus": {
        const messages = get(messagesAtom);
        const index = messages.findIndex((m) => m.id === action.messageId);
        if (index !== -1) {
          const message = messages[index];
          const updatedMessages = [
            ...messages.slice(0, index),
            { ...message, toolStatus: action.status },
            ...messages.slice(index + 1),
          ];
          set(messagesAtom, updatedMessages);
        }
        return action.messageId;
      }
    }
  }
);

// =============================================================================
// Legacy Atoms - Backward compatibility wrappers around dispatchMessageAtom
// =============================================================================

/** @deprecated Use dispatchMessageAtom with { type: "send", message } instead */
export const sendMessageAtom = atom(
  null,
  (_get, set, message: Omit<ChannelMessage, "id" | "timestamp" | "channelId">) => {
    return set(dispatchMessageAtom, { type: "send", message });
  }
);

/** @deprecated Use dispatchMessageAtom with { type: "queue", message } instead */
export const queueMessageAtom = atom(
  null,
  (_get, set, message: Omit<ChannelMessage, "id" | "timestamp" | "channelId">) => {
    set(dispatchMessageAtom, { type: "queue", message });
  }
);

/** @deprecated Use dispatchMessageAtom with { type: "processQueue" } instead */
export const processQueueAtom = atom(
  null,
  (_get, set) => {
    set(dispatchMessageAtom, { type: "processQueue" });
  }
);

/** @deprecated Use dispatchMessageAtom with { type: "update", messageId, update } instead */
export const updateMessageAtom = atom(
  null,
  (_get, set, { messageId, update }: { messageId: string; update: Partial<MessageContent> }) => {
    set(dispatchMessageAtom, { type: "update", messageId, update });
  }
);

/** @deprecated Use dispatchMessageAtom with { type: "append", messageId, delta } instead */
export const appendToMessageAtom = atom(
  null,
  (_get, set, { messageId, delta }: { messageId: string; delta: string }) => {
    set(dispatchMessageAtom, { type: "append", messageId, delta });
  }
);

/** @deprecated Use dispatchMessageAtom with { type: "finishStreaming", messageId } instead */
export const finishStreamingAtom = atom(
  null,
  (_get, set, messageId: string) => {
    set(dispatchMessageAtom, { type: "finishStreaming", messageId });
  }
);

/** @deprecated Use dispatchMessageAtom with { type: "updateToolStatus", messageId, status } instead */
export const updateToolStatusAtom = atom(
  null,
  (_get, set, { messageId, status }: { messageId: string; status: ChannelMessage["toolStatus"] }) => {
    set(dispatchMessageAtom, { type: "updateToolStatus", messageId, status });
  }
);
