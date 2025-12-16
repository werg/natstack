import {
  ai,
  type StreamEvent,
  type ToolDefinition,
} from "@natstack/ai";
import type { ChannelMessage } from "../types/messages";
import { isCodeExecutionResult } from "../types/messages";
import { createFileTools } from "./tools/fileTools";
import { createEvalTools } from "./tools/evalTools";
import { createMDXTools } from "./tools/mdxTools";
import { getSystemPrompt } from "./prompts/systemPrompt";
import { PromptBuilder } from "./PromptBuilder";

/**
 * Convert a tool result payload to a small, serializable value for channel storage / prompting.
 * Prefers textual content; falls back to JSON stringification for objects.
 */
function formatResultForMessage(result: unknown): string | number | boolean | null {
  if (result === undefined) return "";
  if (result === null || typeof result === "string" || typeof result === "number" || typeof result === "boolean") {
    return result;
  }

  // streamText tool results often have a content[] array
  if (
    result &&
    typeof result === "object" &&
    "content" in (result as Record<string, unknown>) &&
    Array.isArray((result as { content?: Array<{ text?: string }> }).content)
  ) {
    const joined = ((result as { content?: Array<{ text?: string }> }).content ?? [])
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
    if (joined) return joined;
  }

  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Context passed to tool execution.
 */
export interface ToolExecutionContext {
  /** Signal for aborting the operation */
  signal?: AbortSignal;
}

/**
 * Tool definition with execute callback (internal format).
 */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

/**
 * Channel adapter interface for AgentSession.
 * This decouples AgentSession from specific state management (Jotai atoms, etc.)
 */
export interface ChannelAdapter {
  /** Get all messages in the channel */
  getMessages(): ChannelMessage[];
  /** Send a message to the channel, returns the message ID */
  sendMessage(message: Omit<ChannelMessage, "id" | "timestamp" | "channelId">): string;
  /** Append text to a streaming message */
  appendToMessage(messageId: string, delta: string): void;
  /** Mark a message as done streaming */
  finishStreaming(messageId: string): void;
  /** Update tool status on a message */
  updateToolStatus(messageId: string, status: ChannelMessage["toolStatus"]): void;
  /** Start generation and return an AbortController */
  startGeneration(participantId: string): AbortController;
  /** Set channel status to streaming */
  setStreaming(): void;
  /** End generation */
  endGeneration(): void;
  /** Abort generation */
  abortGeneration(): void;
}

/**
 * Agent session options.
 */
export interface AgentSessionOptions {
  adapter: ChannelAdapter;
  modelRole?: string;
  participantId?: string;
}

/**
 * AgentSession - Manages AI model session with tools.
 *
 * Uses the unified streamText API that handles the agent loop server-side.
 * Tools execute panel-side via IPC callbacks.
 */
export class AgentSession {
  private adapter: ChannelAdapter;
  private participantId: string;
  private modelRole: string;
  private tools: Map<string, AgentTool> = new Map();
  private promptBuilder: PromptBuilder;
  private isStreaming = false;
  private abortController: AbortController | null = null;

  constructor(options: AgentSessionOptions) {
    this.adapter = options.adapter;
    this.participantId = options.participantId ?? "agent";
    this.modelRole = options.modelRole ?? "coding";
    this.promptBuilder = new PromptBuilder(getSystemPrompt());
  }

  /**
   * Initialize the agent session.
   */
  async initialize(): Promise<void> {
    // Load roles to validate the model role
    const roles = await ai.listRoles();
    if (!roles[this.modelRole]) {
      throw new Error(`Model role '${this.modelRole}' not available`);
    }
  }

  /**
   * Register a custom tool.
   */
  registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Register file operation tools.
   */
  registerFileTools(): void {
    const fileTools = createFileTools();
    for (const tool of fileTools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Register code execution tools.
   */
  registerEvalTools(): void {
    const evalTools = createEvalTools();
    for (const tool of evalTools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Register MDX rendering tools.
   */
  registerMDXTools(): void {
    const mdxTools = createMDXTools();
    for (const tool of mdxTools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Build streamText-compatible tools from registered tools.
   */
  private buildStreamTextTools(): Record<string, ToolDefinition> {
    const tools: Record<string, ToolDefinition> = {};

    for (const [name, tool] of this.tools) {
      tools[name] = {
        description: tool.description,
        parameters: tool.parameters,
        execute: async (args: Record<string, unknown>): Promise<unknown> => {
          // Execute the tool with abort signal from current generation
          const result = await tool.execute(args, {
            signal: this.abortController?.signal,
          });
          const text = result.content.map(c => c.text).join("\n");

          // If error, throw so streamText handles it as an error
          if (result.isError) {
            throw new Error(text);
          }

          // Return the full result object - streamText will serialize it for the LLM,
          // but we can access the original object in the tool-result event
          return result;
        },
      };
    }

    return tools;
  }

  /**
   * Generate a streaming response using the unified streamText API.
   * The agent loop runs server-side; tool callbacks execute here.
   */
  async streamGenerate(): Promise<void> {
    if (this.isStreaming) {
      throw new Error("Already streaming");
    }

    this.isStreaming = true;
    this.abortController = this.adapter.startGeneration(this.participantId);

    try {
      this.adapter.setStreaming();

      // Build prompt and tools
      const channelMessages = this.adapter.getMessages();
      const messages = this.promptBuilder.build(channelMessages);
      const tools = this.buildStreamTextTools();

      console.log(`[AgentSession] Starting streamText with ${Object.keys(tools).length} tools, ${messages.length} messages`);

      // Create streaming message placeholder
      const messageId = this.adapter.sendMessage({
        participantId: this.participantId,
        participantType: "agent",
        content: {
          type: "text",
          text: "",
        },
        isStreaming: true,
      });

      // Track tool calls for updating status
      const toolCallMessageIds = new Map<string, string>();

      console.log("[AgentSession] Invoking streamText API...", tools, messages);

      // Use the unified streamText API
      const stream = ai.streamText({
        model: this.modelRole,
        messages,
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        maxSteps: 10,
        abortSignal: this.abortController.signal,
      });

      // Process stream events
      for await (const event of stream) {
        this.processStreamEvent(event, messageId, toolCallMessageIds);
      }

      // Mark message as done streaming
      this.adapter.finishStreaming(messageId);

    } catch (error) {
      // Check for abort errors
      const isAbortError =
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.message === "Aborted" ||
          error.message.includes("aborted"));

      if (!isAbortError) {
        // Send error message
        this.adapter.sendMessage({
          participantId: "system",
          participantType: "system",
          content: {
            type: "system",
            level: "error",
            message: `Stream error: ${error instanceof Error ? error.message : String(error)}`,
          },
        });
      }
    } finally {
      this.isStreaming = false;
      this.abortController = null;
      this.adapter.endGeneration();
    }
  }

  /**
   * Process a stream event from streamText.
   */
  private processStreamEvent(
    event: StreamEvent,
    messageId: string,
    toolCallMessageIds: Map<string, string>
  ): void {
    switch (event.type) {
      case "text-delta":
        this.adapter.appendToMessage(messageId, event.text);
        break;

      case "tool-call": {
        // Send tool call message to channel
        const toolCallMsgId = this.adapter.sendMessage({
          participantId: this.participantId,
          participantType: "agent",
          content: {
            type: "tool_call",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          },
          toolStatus: "executing",
        });
        toolCallMessageIds.set(event.toolCallId, toolCallMsgId);
        break;
      }

      case "tool-result": {
        // Update tool call status
        const toolCallMsgId = toolCallMessageIds.get(event.toolCallId);
        if (toolCallMsgId) {
          this.adapter.updateToolStatus(
            toolCallMsgId,
            event.isError ? "error" : "completed"
          );
        }

        // Send tool result message
        // Extract CodeExecutionData if present (only execute_code returns structured data)
        const resultData = isCodeExecutionResult(event.result)
          ? event.result.data
          : undefined;

        // Only put a serialized/textual result into the message for prompt usage
        const serializedResult = formatResultForMessage(event.result);

        this.adapter.sendMessage({
          participantId: this.participantId,
          participantType: "agent",
          content: {
            type: "tool_result",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: serializedResult,
            isError: event.isError ?? false,
            data: resultData,
          },
        });
        break;
      }

      case "step-finish":
        console.log(`[AgentSession] Step ${event.stepNumber} finished: ${event.finishReason}`);
        break;

      case "finish":
        console.log(`[AgentSession] Generation finished: ${event.totalSteps} steps`);
        if (event.usage) {
          console.log(`[AgentSession] Usage: ${event.usage.promptTokens} prompt, ${event.usage.completionTokens} completion`);
        }
        break;

      case "error":
        this.adapter.sendMessage({
          participantId: "system",
          participantType: "system",
          content: {
            type: "system",
            level: "error",
            message: `Stream error: ${event.error.message}`,
          },
        });
        break;
    }
  }

  /**
   * Get the current model role.
   */
  getModelRole(): string {
    return this.modelRole;
  }

  /**
   * Set the model role.
   */
  async setModelRole(role: string): Promise<void> {
    const roles = await ai.listRoles();
    if (!roles[role]) {
      throw new Error(`Model role '${role}' not available`);
    }
    this.modelRole = role;
  }

  /**
   * Get the system prompt.
   */
  getSystemPrompt(): string {
    return this.promptBuilder.getSystemPrompt();
  }

  /**
   * Set the system prompt.
   */
  setSystemPrompt(prompt: string): void {
    this.promptBuilder.setSystemPrompt(prompt);
  }

  /**
   * Check if currently streaming.
   */
  getIsStreaming(): boolean {
    return this.isStreaming;
  }

  /**
   * Abort current generation.
   */
  abort(): void {
    this.adapter.abortGeneration();
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.tools.clear();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
