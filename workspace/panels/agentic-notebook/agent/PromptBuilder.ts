import type { Message } from "@natstack/ai";
import type { ChannelMessage } from "../types/messages";

/**
 * Content part types for prompt building.
 */
type TextPart = { type: "text"; text: string };
type ToolCallPart = { type: "tool-call"; toolCallId: string; toolName: string; args: unknown };
type ToolResultPart = { type: "tool-result"; toolCallId: string; toolName: string; result: unknown; isError?: boolean };

type ContentPart = TextPart | ToolCallPart | ToolResultPart;

/**
 * PromptBuilder - Converts channel messages to AI SDK prompt format.
 *
 * Responsible for:
 * - Converting ChannelMessage objects to Message[] for streamText
 * - Grouping consecutive messages by role
 * - Formatting different content types (text, tool calls/results)
 */
export class PromptBuilder {
  private systemPrompt: string;

  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
  }

  /**
   * Set the system prompt.
   */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /**
   * Get the system prompt.
   */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /**
   * Build the prompt from channel messages.
   */
  build(messages: ChannelMessage[]): Message[] {
    const prompt: Message[] = [];

    // Add system message
    prompt.push({
      role: "system",
      content: this.systemPrompt,
    });

    // Group messages by role for consolidation
    let currentRole: "user" | "assistant" | "tool" | null = null;
    let currentContent: ContentPart[] = [];

    const flushCurrent = () => {
      if (currentRole && currentContent.length > 0) {
        if (currentRole === "tool") {
          prompt.push({
            role: "tool",
            content: currentContent as ToolResultPart[],
          });
        } else if (currentRole === "assistant") {
          prompt.push({
            role: "assistant",
            content: currentContent as Array<TextPart | ToolCallPart>,
          });
        } else {
          prompt.push({
            role: "user",
            content: currentContent as TextPart[],
          });
        }
      }
      currentContent = [];
    };

    for (const msg of messages) {
      const part = this.convertMessageToPart(msg);
      if (!part) continue;

      // Determine if we need to start a new message
      if (part.role !== currentRole) {
        flushCurrent();
        currentRole = part.role;
      }

      currentContent.push(part.content);
    }

    // Don't forget the last message
    flushCurrent();

    return prompt;
  }

  /**
   * Convert a channel message to a prompt part (role + single content item).
   */
  private convertMessageToPart(msg: ChannelMessage): {
    role: "user" | "assistant" | "tool";
    content: ContentPart;
  } | null {
    switch (msg.participantType) {
      case "user":
        return this.convertUserMessage(msg);

      case "agent":
        return this.convertAgentMessage(msg);

      case "system":
        // System messages are not included in prompt
        return null;
    }
  }

  /**
   * Convert user messages to prompt parts.
   */
  private convertUserMessage(msg: ChannelMessage): {
    role: "user";
    content: TextPart;
  } | null {
    if (msg.content.type === "text") {
      return {
        role: "user",
        content: { type: "text", text: msg.content.text },
      };
    }

    return null;
  }

  /**
   * Convert agent messages to prompt parts.
   */
  private convertAgentMessage(msg: ChannelMessage): {
    role: "assistant" | "tool";
    content: ContentPart;
  } | null {
    if (msg.content.type === "text") {
      // Skip empty text messages (streaming placeholders)
      if (!msg.content.text) return null;
      return {
        role: "assistant",
        content: { type: "text", text: msg.content.text },
      };
    }

    if (msg.content.type === "tool_call") {
      return {
        role: "assistant",
        content: {
          type: "tool-call",
          toolCallId: msg.content.toolCallId,
          toolName: msg.content.toolName,
          args: msg.content.args,
        },
      };
    }

    if (msg.content.type === "tool_result") {
      return {
        role: "tool",
        content: {
          type: "tool-result",
          toolCallId: msg.content.toolCallId,
          toolName: msg.content.toolName,
          result: msg.content.result,
          isError: msg.content.isError,
        },
      };
    }

    return null;
  }
}
