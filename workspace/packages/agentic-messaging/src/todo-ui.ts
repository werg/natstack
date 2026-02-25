/**
 * TODO List UI utilities for inline_ui rendering.
 *
 * TodoItem, getTodoListCode, and getCachedTodoListCode have moved to
 * @workspace/agentic-protocol. This file retains the implementation
 * utilities that depend on TrackerClient.
 */

import { CONTENT_TYPE_INLINE_UI } from "@workspace/agentic-protocol/content-types";
import { type InlineUiData, type TrackerClient } from "@workspace/agentic-protocol/tracker-types";
import { type TodoItem, getCachedTodoListCode } from "@workspace/agentic-protocol/todo-types";

// Re-export protocol types for backward compatibility
export { type TodoItem, getTodoListCode, getCachedTodoListCode } from "@workspace/agentic-protocol/todo-types";

/**
 * Helper to create inline_ui data for a TODO list.
 */
export function createTodoInlineUiData(todos: TodoItem[]): InlineUiData {
  return {
    id: "agent-todos",
    code: getCachedTodoListCode(),
    props: { todos },
  };
}

/**
 * Send or update a TODO list as an inline_ui message.
 * Tracks the message ID internally to support updates.
 *
 * @param client - The agentic client with send/update methods
 * @param todos - The list of TODO items
 * @param existingMessageId - Optional existing message ID for updates
 * @returns The message ID (for subsequent updates)
 */
export async function sendTodoListMessage(
  client: TrackerClient,
  todos: TodoItem[],
  existingMessageId?: string | null
): Promise<string> {
  const inlineData = createTodoInlineUiData(todos);
  const content = JSON.stringify(inlineData);

  if (existingMessageId) {
    await client.update(existingMessageId, content, {
      complete: true,
      contentType: CONTENT_TYPE_INLINE_UI,
    });
    return existingMessageId;
  } else {
    const { messageId } = await client.send(content, {
      contentType: CONTENT_TYPE_INLINE_UI,
      persist: true,
    });
    return messageId;
  }
}

/**
 * Create a TODO tracker that manages sending and updating TODO list messages.
 */
export interface TodoTracker {
  /** Send or update the TODO list */
  update(todos: TodoItem[]): Promise<void>;
  /** Get the current message ID (if any) */
  getMessageId(): string | null;
}

export interface TodoTrackerOptions {
  client: TrackerClient;
  /** Optional logger function */
  log?: (message: string) => void;
}

/**
 * Create a tracker for managing TODO list inline_ui messages.
 */
export function createTodoTracker(options: TodoTrackerOptions): TodoTracker {
  const { client, log } = options;
  let messageId: string | null = null;

  return {
    async update(todos: TodoItem[]): Promise<void> {
      try {
        messageId = await sendTodoListMessage(client, todos, messageId);
        const completedCount = todos.filter(t => t.status === "completed").length;
        log?.(`Updated TODO list: ${todos.length} items, ${completedCount} completed`);
      } catch (err) {
        log?.(`Failed to send TODO list: ${err}`);
      }
    },

    getMessageId(): string | null {
      return messageId;
    },
  };
}
