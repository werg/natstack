/**
 * Factory functions for creating message trackers.
 *
 * These factories create ThinkingTracker, ActionTracker, and TypingTracker
 * instances that operate against the TrackerClient interface.
 */

import {
  CONTENT_TYPE_THINKING,
  CONTENT_TYPE_ACTION,
  CONTENT_TYPE_TYPING,
} from "./content-types.js";
import type {
  TrackerClient,
  ActionData,
  TypingData,
  ThinkingTrackerState,
  ThinkingTrackerOptions,
  ThinkingTracker,
  ActionTrackerState,
  ActionTrackerOptions,
  ActionTracker,
  TypingTrackerState,
  TypingTrackerOptions,
  TypingTracker,
} from "./tracker-types.js";

/**
 * Create a ThinkingTracker for managing thinking/reasoning message state.
 */
export function createThinkingTracker(options: ThinkingTrackerOptions): ThinkingTracker {
  const { client, log = () => {} } = options;
  let currentReplyTo = options.replyTo;

  const state: ThinkingTrackerState = {
    currentContentType: null,
    thinkingMessageId: null,
    thinkingItemId: null,
  };

  return {
    get state() {
      return state;
    },

    setReplyTo(id: string | undefined): void {
      currentReplyTo = id;
    },

    async startThinking(itemId?: string): Promise<string> {
      // End any existing thinking message first
      if (state.thinkingMessageId) {
        await this.endThinking();
      }

      const { messageId } = await client.send("", {
        replyTo: currentReplyTo,
        contentType: CONTENT_TYPE_THINKING,
      });

      state.thinkingMessageId = messageId;
      state.currentContentType = "thinking";
      state.thinkingItemId = itemId ?? null;

      log(`Started thinking message: ${messageId}`);
      return messageId;
    },

    async updateThinking(content: string): Promise<void> {
      if (state.thinkingMessageId && content) {
        await client.update(state.thinkingMessageId, content);
      }
    },

    async endThinking(): Promise<void> {
      if (state.thinkingMessageId) {
        await client.complete(state.thinkingMessageId);
        log(`Completed thinking message: ${state.thinkingMessageId}`);
        state.thinkingMessageId = null;
        state.thinkingItemId = null;
      }
      state.currentContentType = null;
    },

    isThinking(): boolean {
      return state.currentContentType === "thinking";
    },

    isThinkingItem(itemId: string): boolean {
      return state.thinkingItemId === itemId;
    },

    setTextMode(): void {
      state.currentContentType = "text";
    },

    async cleanup(): Promise<boolean> {
      // Complete any pending thinking message to avoid orphaned messages
      if (state.thinkingMessageId) {
        const messageId = state.thinkingMessageId;
        state.thinkingMessageId = null;
        state.thinkingItemId = null;
        state.currentContentType = null;
        try {
          await client.complete(messageId);
          log(`Cleanup: completed orphaned thinking message: ${messageId}`);
          return true;
        } catch (err) {
          log(`Cleanup: failed to complete thinking message ${messageId}: ${err}`);
          return false;
        }
      }
      state.currentContentType = null;
      return true;
    },
  };
}

/**
 * Create an ActionTracker for managing action message state.
 */
export function createActionTracker(options: ActionTrackerOptions): ActionTracker {
  const { client, log = () => {} } = options;
  let currentReplyTo = options.replyTo;

  const state: ActionTrackerState = {
    actionMessageId: null,
    currentAction: null,
  };

  return {
    get state() {
      return state;
    },

    setReplyTo(id: string | undefined): void {
      currentReplyTo = id;
    },

    async startAction(action: Omit<ActionData, "status">): Promise<string> {
      // Complete any existing action first
      if (state.actionMessageId) {
        await this.completeAction();
      }

      const actionData: ActionData = { ...action, status: "pending" };
      const { messageId } = await client.send(JSON.stringify(actionData), {
        replyTo: currentReplyTo,
        contentType: CONTENT_TYPE_ACTION,
      });

      state.actionMessageId = messageId;
      state.currentAction = actionData;

      log(`Started action: ${action.type} - ${action.description}`);
      return messageId;
    },

    async completeAction(): Promise<void> {
      if (state.actionMessageId && state.currentAction) {
        // Don't update content - just mark as complete.
        // The message's complete flag indicates the action is done.
        // (client.update appends content, which would duplicate the JSON)
        await client.complete(state.actionMessageId);
        log(`Completed action: ${state.currentAction.type}`);
        state.actionMessageId = null;
        state.currentAction = null;
      }
    },

    isActive(): boolean {
      return state.actionMessageId !== null;
    },

    async cleanup(): Promise<boolean> {
      if (state.actionMessageId) {
        const messageId = state.actionMessageId;
        state.actionMessageId = null;
        state.currentAction = null;
        try {
          await client.complete(messageId);
          log(`Cleanup: completed orphaned action: ${messageId}`);
          return true;
        } catch (err) {
          log(`Cleanup: failed to complete action ${messageId}: ${err}`);
          return false;
        }
      }
      return true;
    },
  };
}

/**
 * Create a TypingTracker for managing ephemeral typing indicator messages.
 */
export function createTypingTracker(options: TypingTrackerOptions): TypingTracker {
  const { client, log = () => {}, senderInfo } = options;
  let currentReplyTo = options.replyTo;

  const state: TypingTrackerState = {
    typingMessageId: null,
    isTyping: false,
  };

  return {
    get state() {
      return state;
    },

    setReplyTo(id: string | undefined): void {
      currentReplyTo = id;
    },

    async startTyping(context?: string): Promise<string> {
      // Stop any existing typing indicator first
      if (state.typingMessageId) {
        await this.stopTyping();
      }

      const typingData: TypingData = {
        senderId: senderInfo?.senderId ?? "",
        senderName: senderInfo?.senderName,
        senderType: senderInfo?.senderType,
        context,
      };

      const { messageId } = await client.send(JSON.stringify(typingData), {
        replyTo: currentReplyTo,
        contentType: CONTENT_TYPE_TYPING,
        persist: false, // EPHEMERAL - key difference from other trackers
      });

      state.typingMessageId = messageId;
      state.isTyping = true;

      log(`Started typing indicator: ${messageId}${context ? ` (${context})` : ""}`);
      return messageId;
    },

    async stopTyping(): Promise<void> {
      if (state.typingMessageId) {
        await client.update(state.typingMessageId, "", { complete: true, persist: false });
        log(`Stopped typing indicator: ${state.typingMessageId}`);
        state.typingMessageId = null;
        state.isTyping = false;
      }
    },

    isTyping(): boolean {
      return state.isTyping;
    },

    async cleanup(): Promise<boolean> {
      if (state.typingMessageId) {
        const messageId = state.typingMessageId;
        state.typingMessageId = null;
        state.isTyping = false;
        try {
          await client.update(messageId, "", { complete: true, persist: false });
          log(`Cleanup: stopped typing indicator: ${messageId}`);
          return true;
        } catch (err) {
          log(`Cleanup: failed to stop typing indicator ${messageId}: ${err}`);
          return false;
        }
      }
      return true;
    },
  };
}
