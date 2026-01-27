/**
 * TODO List UI utilities for inline_ui rendering.
 *
 * Provides MDX code generation for displaying task progress
 * that can be used by any agentic worker.
 */

import { CONTENT_TYPE_INLINE_UI, type InlineUiData } from "./responder-utils.js";
import type { TrackerClient } from "./responder-utils.js";

/**
 * Structure of a TODO item matching the SDK's TodoWrite format.
 */
export interface TodoItem {
  /** Imperative form of the task (e.g., "Run tests") */
  content: string;
  /** Present continuous form shown during execution (e.g., "Running tests") */
  activeForm: string;
  /** Current status of the task */
  status: "pending" | "in_progress" | "completed";
}

/**
 * Get the MDX code for rendering a TODO list.
 * This code will be compiled and rendered by the chat panel.
 */
export function getTodoListCode(): string {
  return `
import { Card, Flex, Text, Badge, Progress } from "@radix-ui/themes";

export default function TodoList({ props = {} }) {
  const { todos = [] } = props || {};
  const completed = todos.filter(t => t.status === "completed").length;
  const inProgress = todos.find(t => t.status === "in_progress");
  const progress = todos.length > 0 ? (completed / todos.length) * 100 : 0;

  const StatusIcon = ({ status }) => {
    if (status === "completed") return <Text color="green">✓</Text>;
    if (status === "in_progress") return <Text color="blue">▶</Text>;
    return <Text color="gray">○</Text>;
  };

  return (
    <Card size="1" style={{ maxWidth: 400 }}>
      <Flex direction="column" gap="2">
        <Flex justify="between" align="center">
          <Text size="2" weight="medium">Tasks</Text>
          <Badge color={completed === todos.length ? "green" : "blue"} size="1">
            {completed}/{todos.length}
          </Badge>
        </Flex>

        <Progress value={progress} size="1" />

        {inProgress && (
          <Flex align="center" gap="1">
            <Text size="1" color="blue">{inProgress.activeForm}...</Text>
          </Flex>
        )}

        <Flex direction="column" gap="1">
          {todos.map((todo, idx) => (
            <Flex key={idx} align="center" gap="2">
              <StatusIcon status={todo.status} />
              <Text
                size="1"
                color={todo.status === "completed" ? "gray" : undefined}
                style={{
                  textDecoration: todo.status === "completed" ? "line-through" : undefined,
                  flex: 1
                }}
              >
                {todo.content}
              </Text>
            </Flex>
          ))}
        </Flex>
      </Flex>
    </Card>
  );
}
`.trim();
}

// Cache the code since it doesn't change
let cachedTodoCode: string | null = null;

/**
 * Get the cached TODO list MDX code.
 * Caches the result since the code doesn't change - only props do.
 */
export function getCachedTodoListCode(): string {
  if (!cachedTodoCode) {
    cachedTodoCode = getTodoListCode();
  }
  return cachedTodoCode;
}

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
