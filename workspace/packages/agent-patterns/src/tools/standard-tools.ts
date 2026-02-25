/**
 * Standard Tools Pattern
 *
 * Provides common tool definitions used across multiple agents.
 * These tools are nearly identical across pubsub-chat-responder,
 * claude-code-responder, and codex-responder.
 */

import type { AgenticClient, ChatParticipantMetadata } from "@workspace/agentic-protocol";
import {
  CONTENT_TYPE_INLINE_UI,
  getCachedTodoListCode,
  type TodoItem,
  type InlineUiData,
} from "@workspace/agentic-protocol";

/**
 * Standard tool definition structure compatible with AI SDK tools.
 */
export interface StandardToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  execute: (args: unknown) => Promise<unknown>;
}

/**
 * Options for creating standard tools.
 */
export interface StandardToolsOptions {
  /** Agentic client for sending messages */
  client: AgenticClient<ChatParticipantMetadata>;
  /** Logger function */
  log?: (msg: string) => void;
}

/**
 * Creates standard tool definitions used across agents.
 *
 * Includes:
 * - set_title: Set the channel/conversation title
 * - TodoWrite: Create and manage task lists with UI display
 *
 * @example
 * ```typescript
 * const standardTools = createStandardTools({
 *   client: this.client,
 *   log: (msg) => this.log.debug(msg),
 * });
 *
 * // Add to your tools object
 * const tools = {
 *   ...standardTools,
 *   ...otherTools,
 * };
 * ```
 */
export function createStandardTools(
  options: StandardToolsOptions
): Record<string, StandardToolDefinition> {
  const { client, log = () => {} } = options;

  return {
    set_title: {
      name: "set_title",
      description: `Set the channel/conversation title displayed to users.

Call this tool:
- Early in the conversation when the topic becomes clear
- When the topic shifts significantly to a new subject
- To provide a concise summary (1-5 words) of what this conversation is about

Examples: "Debug React Hooks", "Refactor Auth Module", "Setup CI Pipeline"`,
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            maxLength: 200,
            description: "Brief title for this conversation (1-5 words)",
          },
        },
        required: ["title"],
      },
      execute: async (args: unknown) => {
        const { title } = args as { title: string };
        await client.setChannelTitle(title);
        log(`Set channel title to: ${title}`);
        return { success: true, title };
      },
    },

    TodoWrite: {
      name: "TodoWrite",
      description: `Create and manage a structured task list for tracking progress.

Use this tool when working on complex, multi-step tasks to:
- Track progress on implementation tasks
- Show the user what you're working on
- Demonstrate thoroughness

Each todo item has:
- content: Imperative form (e.g., "Run tests")
- activeForm: Present continuous form shown during execution (e.g., "Running tests")
- status: "pending", "in_progress", or "completed"

Only have ONE task as in_progress at a time. Mark tasks complete immediately after finishing.`,
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "Task description in imperative form" },
                activeForm: { type: "string", description: "Task description in present continuous form" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["content", "activeForm", "status"],
            },
          },
        },
        required: ["todos"],
      },
      execute: async (args: unknown) => {
        const { todos } = args as { todos: TodoItem[] };
        if (todos && todos.length > 0) {
          try {
            const inlineData: InlineUiData = {
              id: "agent-todos",
              code: getCachedTodoListCode(),
              props: { todos },
            };

            await client.send(JSON.stringify(inlineData), {
              contentType: CONTENT_TYPE_INLINE_UI,
              persist: true,
            });

            const completedCount = todos.filter((t) => t.status === "completed").length;
            log(`Sent TODO list: ${todos.length} items, ${completedCount} completed`);
          } catch (err) {
            log(`Failed to send TODO list: ${err}`);
          }
        }
        return { success: true };
      },
    },
  };
}

/**
 * Creates set_title and TodoWrite tool definitions for MCP servers.
 * Returns tool definitions with special originalName markers for direct execution.
 *
 * Use with the Codex HTTP MCP bridge pattern where tools need special handling.
 *
 * @example
 * ```typescript
 * const mcpTools = createStandardMcpTools();
 * // Returns tools with originalName: "__set_title__" and "__todo_write__"
 * ```
 */
export function createStandardMcpTools(): Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  originalName: string;
}> {
  return [
    {
      name: "set_title",
      description: `Set the channel/conversation title displayed to users.

Call this tool:
- Early in the conversation when the topic becomes clear
- When the topic shifts significantly to a new subject
- To provide a concise summary (1-5 words) of what this conversation is about

Examples: "Debug React Hooks", "Refactor Auth Module", "Setup CI Pipeline"`,
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            maxLength: 200,
            description: "Brief title for this conversation (1-5 words)",
          },
        },
        required: ["title"],
      },
      originalName: "__set_title__",
    },
    {
      name: "TodoWrite",
      description: `Create and manage a structured task list for tracking progress.

Use this tool when working on complex, multi-step tasks to:
- Track progress on implementation tasks
- Show the user what you're working on
- Demonstrate thoroughness

Each todo item has:
- content: Imperative form (e.g., "Run tests")
- activeForm: Present continuous form shown during execution (e.g., "Running tests")
- status: "pending", "in_progress", or "completed"

Only have ONE task as in_progress at a time. Mark tasks complete immediately after finishing.`,
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "Task description in imperative form" },
                activeForm: { type: "string", description: "Task description in present continuous form" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["content", "activeForm", "status"],
            },
          },
        },
        required: ["todos"],
      },
      originalName: "__todo_write__",
    },
  ];
}

/**
 * Execute a standard MCP tool by its originalName marker.
 * Use this with createStandardMcpTools() for the Codex MCP bridge pattern.
 *
 * @example
 * ```typescript
 * const result = await executeStandardMcpTool(
 *   "__set_title__",
 *   { title: "My Title" },
 *   { client, log }
 * );
 * ```
 */
export async function executeStandardMcpTool(
  originalName: string,
  args: unknown,
  options: StandardToolsOptions
): Promise<{ handled: boolean; result?: unknown }> {
  const { client, log = () => {} } = options;

  if (originalName === "__set_title__") {
    const { title } = args as { title: string };
    await client.setChannelTitle(title);
    log(`Set channel title to: ${title}`);
    return { handled: true, result: { success: true, title } };
  }

  if (originalName === "__todo_write__") {
    const { todos } = (args as { todos?: TodoItem[] }) ?? {};
    if (todos && todos.length > 0) {
      try {
        const inlineData: InlineUiData = {
          id: "agent-todos",
          code: getCachedTodoListCode(),
          props: { todos },
        };

        await client.send(JSON.stringify(inlineData), {
          contentType: CONTENT_TYPE_INLINE_UI,
          persist: true,
        });

        const completedCount = todos.filter((t) => t.status === "completed").length;
        log(`Sent TODO list: ${todos.length} items, ${completedCount} completed`);
      } catch (err) {
        log(`Failed to send TODO list: ${err}`);
      }
    }
    return { handled: true, result: { success: true } };
  }

  return { handled: false };
}
