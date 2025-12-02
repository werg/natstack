import { useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  channelIdAtom,
  messagesAtom,
  participantsArrayAtom,
  participantsAtom,
  channelStatusAtom,
  isGeneratingAtom,
  abortSignalAtom,
  hasQueuedMessagesAtom,
  activeParticipantIdAtom,
  sendMessageAtom,
  queueMessageAtom,
  processQueueAtom,
  updateMessageAtom,
  appendToMessageAtom,
  finishStreamingAtom,
  updateToolStatusAtom,
  addParticipantAtom,
  removeParticipantAtom,
  startGenerationAtom,
  setStreamingAtom,
  abortGenerationAtom,
  endGenerationAtom,
  clearChannelAtom,
  resetChannelAtom,
  toStoredChatAtom,
  loadStoredChatAtom,
} from "../state";
import type { ChannelMessage, MessageContent } from "../types/messages";
import type { AnyParticipant, ChannelStatus } from "../types/channel";

// ============ Composable Hooks (Primary API) ============

/**
 * Hook for reading channel messages and queue state.
 */
export function useChannelMessages() {
  const messages = useAtomValue(messagesAtom);
  const hasQueuedMessages = useAtomValue(hasQueuedMessagesAtom);

  return {
    messages,
    hasQueuedMessages,
  };
}

/**
 * Hook for message actions (send, update, stream).
 */
export function useMessageActions() {
  const sendMessageRaw = useSetAtom(sendMessageAtom);
  const queueMessageRaw = useSetAtom(queueMessageAtom);
  const processQueue = useSetAtom(processQueueAtom);
  const updateMessageRaw = useSetAtom(updateMessageAtom);
  const appendToMessageRaw = useSetAtom(appendToMessageAtom);
  const finishStreaming = useSetAtom(finishStreamingAtom);
  const updateToolStatusRaw = useSetAtom(updateToolStatusAtom);

  const sendMessage = useCallback(
    (message: Omit<ChannelMessage, "id" | "timestamp" | "channelId">) => {
      return sendMessageRaw(message);
    },
    [sendMessageRaw]
  );

  const queueMessage = useCallback(
    (message: Omit<ChannelMessage, "id" | "timestamp" | "channelId">) => {
      queueMessageRaw(message);
    },
    [queueMessageRaw]
  );

  const updateMessage = useCallback(
    (messageId: string, update: Partial<MessageContent>) => {
      updateMessageRaw({ messageId, update });
    },
    [updateMessageRaw]
  );

  const appendToMessage = useCallback(
    (messageId: string, delta: string) => {
      appendToMessageRaw({ messageId, delta });
    },
    [appendToMessageRaw]
  );

  const updateToolStatus = useCallback(
    (messageId: string, status: ChannelMessage["toolStatus"]) => {
      updateToolStatusRaw({ messageId, status });
    },
    [updateToolStatusRaw]
  );

  return {
    sendMessage,
    queueMessage,
    processQueue,
    updateMessage,
    appendToMessage,
    finishStreaming,
    updateToolStatus,
  };
}

/**
 * Hook for reading generation status.
 */
export function useGenerationStatus() {
  const status = useAtomValue(channelStatusAtom);
  const isGenerating = useAtomValue(isGeneratingAtom);
  const activeParticipantId = useAtomValue(activeParticipantIdAtom);
  const abortSignal = useAtomValue(abortSignalAtom);

  return {
    status,
    isGenerating,
    activeParticipantId,
    abortSignal,
  };
}

/**
 * Hook for generation control (start, stop, abort).
 */
export function useGenerationControl() {
  const startGeneration = useSetAtom(startGenerationAtom);
  const setStreaming = useSetAtom(setStreamingAtom);
  const abortGeneration = useSetAtom(abortGenerationAtom);
  const endGeneration = useSetAtom(endGenerationAtom);

  return {
    startGeneration,
    setStreaming,
    abortGeneration,
    endGeneration,
  };
}

// ============ Utility Hooks ============

/**
 * Hook for managing the channel state (create, clear, reset).
 */
export function useChannel() {
  const channelId = useAtomValue(channelIdAtom);
  const resetChannel = useSetAtom(resetChannelAtom);
  const clearChannel = useSetAtom(clearChannelAtom);

  const createChannel = useCallback(
    (id?: string) => {
      return resetChannel(id);
    },
    [resetChannel]
  );

  return {
    channelId,
    createChannel,
    clearChannel,
  };
}

/**
 * Hook for serialization (save/load chat state).
 */
export function useChannelSerialization() {
  const storedChat = useAtomValue(toStoredChatAtom);
  const loadStoredChat = useSetAtom(loadStoredChatAtom);

  return {
    toStoredChat: () => storedChat,
    loadStoredChat,
  };
}

/**
 * Hook for managing participants.
 */
export function useParticipantActions() {
  const addParticipant = useSetAtom(addParticipantAtom);
  const removeParticipant = useSetAtom(removeParticipantAtom);

  return {
    addParticipant,
    removeParticipant,
  };
}

// ============ Legacy Hooks (For Backward Compatibility) ============
// These will be deprecated in favor of the composable hooks above.

/**
 * @deprecated Use useChannelMessages().messages instead
 */
export function useMessages(): ChannelMessage[] {
  return useAtomValue(messagesAtom);
}

/**
 * @deprecated Use useGenerationStatus().status instead
 */
export function useChannelStatus(): ChannelStatus {
  return useAtomValue(channelStatusAtom);
}

/**
 * @deprecated Use useGenerationStatus().isGenerating instead
 */
export function useIsGenerating(): boolean {
  return useAtomValue(isGeneratingAtom);
}

/**
 * @deprecated Use useGenerationStatus().abortSignal instead
 */
export function useAbortSignal(): AbortSignal | undefined {
  return useAtomValue(abortSignalAtom);
}

/**
 * @deprecated Use useChannelMessages().hasQueuedMessages instead
 */
export function useHasQueuedMessages(): boolean {
  return useAtomValue(hasQueuedMessagesAtom);
}

/**
 * @deprecated Use useMessageActions().sendMessage instead
 */
export function useSendMessage() {
  const sendMessage = useSetAtom(sendMessageAtom);
  return useCallback(
    (message: Omit<ChannelMessage, "id" | "timestamp" | "channelId">) => {
      return sendMessage(message);
    },
    [sendMessage]
  );
}

/**
 * @deprecated Use useMessageActions().queueMessage instead
 */
export function useQueueMessage() {
  const queueMessage = useSetAtom(queueMessageAtom);
  return useCallback(
    (message: Omit<ChannelMessage, "id" | "timestamp" | "channelId">) => {
      queueMessage(message);
    },
    [queueMessage]
  );
}

/**
 * @deprecated Use useMessageActions().processQueue instead
 */
export function useProcessQueue() {
  return useSetAtom(processQueueAtom);
}

/**
 * @deprecated Use useMessageActions().updateMessage instead
 */
export function useUpdateMessage() {
  const updateMessage = useSetAtom(updateMessageAtom);
  return useCallback(
    (messageId: string, update: Partial<MessageContent>) => {
      updateMessage({ messageId, update });
    },
    [updateMessage]
  );
}

/**
 * @deprecated Use useMessageActions().appendToMessage instead
 */
export function useAppendToMessage() {
  const appendToMessage = useSetAtom(appendToMessageAtom);
  return useCallback(
    (messageId: string, delta: string) => {
      appendToMessage({ messageId, delta });
    },
    [appendToMessage]
  );
}

/**
 * @deprecated Use useMessageActions().finishStreaming instead
 */
export function useFinishStreaming() {
  return useSetAtom(finishStreamingAtom);
}

/**
 * @deprecated Use useMessageActions().updateToolStatus instead
 */
export function useUpdateToolStatus() {
  const updateToolStatus = useSetAtom(updateToolStatusAtom);
  return useCallback(
    (messageId: string, status: ChannelMessage["toolStatus"]) => {
      updateToolStatus({ messageId, status });
    },
    [updateToolStatus]
  );
}

/**
 * @deprecated Use useGenerationControl().abortGeneration instead
 */
export function useAbortGeneration() {
  return useSetAtom(abortGenerationAtom);
}

// ============ Direct Access Hooks ============
// These provide direct access to individual entities by ID.

/**
 * Hook for reading channel participants.
 */
export function useParticipants(): AnyParticipant[] {
  return useAtomValue(participantsArrayAtom);
}

/**
 * Hook for getting a message by ID.
 */
export function useMessage(messageId: string): ChannelMessage | undefined {
  const messages = useAtomValue(messagesAtom);
  return messages.find((m) => m.id === messageId);
}

/**
 * Hook for getting participant by ID.
 */
export function useParticipant(participantId: string): AnyParticipant | undefined {
  const participants = useAtomValue(participantsAtom);
  return participants.get(participantId);
}
