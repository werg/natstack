/**
 * Claude Code Conversation Manager
 *
 * Manages per-conversation Claude Code provider instances. Each conversation
 * with tools gets its own provider configured with an SDK MCP server that
 * proxies tool calls back to the panel.
 */

import { createClaudeCode, type ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import type { AIToolDefinition } from "@natstack/types";
import {
  createToolProxyMcpServer,
  getMcpToolNames,
  type ToolExecuteCallback,
} from "./claudeCodeToolProxy.js";
import { Logger } from "../../shared/logging.js";
import { findExecutable } from "./providerFactory.js";
import { getActiveWorkspace } from "../paths.js";

/**
 * Language model interface (minimal for our needs)
 */
interface LanguageModel {
  specificationVersion: "v2" | "v3";
  provider: string;
  modelId: string;
  doGenerate(options: unknown): PromiseLike<unknown>;
  doStream(options: unknown): PromiseLike<{ stream: ReadableStream<unknown> }>;
}

/**
 * State for an active conversation
 */
interface ConversationState {
  conversationId: string;
  panelId: string;
  modelId: string;
  tools: AIToolDefinition[];
  createModel: (modelId: string) => LanguageModel;
  createdAt: number;
}

/**
 * Handle returned to callers for managing a conversation
 */
export interface ConversationHandle {
  conversationId: string;
  getModel: () => LanguageModel;
}

/**
 * Options for creating a new conversation
 */
export interface CreateConversationOptions {
  panelId: string;
  modelId: string; // e.g., "sonnet", "opus", "haiku"
  tools: AIToolDefinition[];
  executeCallback: ToolExecuteCallback;
  /** Additional Claude Code settings */
  settings?: Partial<ClaudeCodeSettings>;
}

/**
 * Manages Claude Code conversations with per-conversation tool proxying.
 *
 * Key features:
 * - Creates isolated provider instances for each conversation
 * - Disables all builtin Claude Code tools
 * - Enables only the MCP proxy tools defined by the panel
 * - Handles cleanup when conversations end
 */
export class ClaudeCodeConversationManager {
  private conversations = new Map<string, ConversationState>();
  private panelConversations = new Map<string, Set<string>>(); // panelId -> conversationIds
  private claudeExecutable: string | undefined;
  private logger = new Logger("ClaudeCodeConversationManager");
  private endListeners = new Set<(conversationId: string, panelId: string) => void>();

  constructor() {
    this.claudeExecutable = findExecutable("claude");
    if (!this.claudeExecutable) {
      this.logger.warn("init", "Claude Code CLI not found in PATH");
    }
  }

  /**
   * Check if Claude Code CLI is available
   */
  isAvailable(): boolean {
    return !!this.claudeExecutable;
  }

  /**
   * Create a new conversation with tools.
   *
   * @param options - Conversation configuration
   * @returns Handle to the conversation
   * @throws Error if Claude Code CLI is not available
   */
  createConversation(options: CreateConversationOptions): ConversationHandle {
    if (!this.claudeExecutable) {
      throw new Error("Claude Code CLI not available");
    }

    const { panelId, modelId, tools, executeCallback, settings } = options;
    const conversationId = crypto.randomUUID();

    this.logger.info(conversationId, "Creating conversation", {
      panelId,
      modelId,
      toolCount: tools.length,
    });

    // Create the MCP server that proxies tool calls
    const mcpServer = createToolProxyMcpServer({
      conversationId,
      panelId,
      tools,
      executeCallback,
    });

    // Get the MCP tool names for the allowlist
    const mcpToolNames = getMcpToolNames(conversationId, tools);

    // Create a Claude Code provider for this conversation with:
    // - All builtin tools disabled (only MCP proxy tools allowed)
    // - Streaming input enabled (required for MCP tools to work correctly)
    const provider = createClaudeCode({
      defaultSettings: {
        pathToClaudeCodeExecutable: this.claudeExecutable,
        cwd: getActiveWorkspace()?.path ?? process.cwd(),
        allowedTools: mcpToolNames,
        mcpServers: {
          [`proxy-${conversationId}`]: mcpServer,
        },
        permissionMode: "default",
        streamingInput: "always",
        ...settings,
      },
    });

    // Create a model factory for this conversation
    const createModel = (mid: string): LanguageModel => {
      return provider(mid as "sonnet" | "opus" | "haiku");
    };

    // Store the conversation state
    const state: ConversationState = {
      conversationId,
      panelId,
      modelId,
      tools,
      createModel,
      createdAt: Date.now(),
    };
    this.conversations.set(conversationId, state);

    // Track which conversations belong to which panel
    let panelConvs = this.panelConversations.get(panelId);
    if (!panelConvs) {
      panelConvs = new Set();
      this.panelConversations.set(panelId, panelConvs);
    }
    panelConvs.add(conversationId);

    this.logger.info(conversationId, "Conversation created", {
      mcpToolNames,
    });

    return {
      conversationId,
      getModel: () => createModel(modelId),
    };
  }

  /**
   * Get an existing conversation by ID
   */
  getConversation(conversationId: string): ConversationState | undefined {
    return this.conversations.get(conversationId);
  }

  /**
   * Get the model for a conversation
   */
  getModel(conversationId: string): LanguageModel | undefined {
    const state = this.conversations.get(conversationId);
    if (!state) return undefined;
    return state.createModel(state.modelId);
  }

  /**
   * End a conversation and clean up resources
   */
  endConversation(conversationId: string): void {
    const state = this.conversations.get(conversationId);
    if (!state) {
      this.logger.warn(conversationId, "Attempted to end non-existent conversation");
      return;
    }

    this.logger.info(conversationId, "Ending conversation", {
      panelId: state.panelId,
      durationMs: Date.now() - state.createdAt,
    });

    // Remove from panel tracking
    const panelConvs = this.panelConversations.get(state.panelId);
    if (panelConvs) {
      panelConvs.delete(conversationId);
      if (panelConvs.size === 0) {
        this.panelConversations.delete(state.panelId);
      }
    }

    // Remove conversation state
    this.conversations.delete(conversationId);

    // Notify listeners
    for (const listener of this.endListeners) {
      try {
        listener(conversationId, state.panelId);
      } catch (error) {
        this.logger.warn(conversationId, "Conversation end listener threw", { error });
      }
    }
  }

  /**
   * End all conversations for a panel (called when panel is destroyed)
   */
  endPanelConversations(panelId: string): void {
    const conversationIds = this.panelConversations.get(panelId);
    if (!conversationIds) return;

    const ids = Array.from(conversationIds);

    this.logger.info("cleanup", "Ending all conversations for panel", {
      panelId,
      count: ids.length,
    });

    for (const conversationId of ids) {
      this.endConversation(conversationId);
    }
  }

  /**
   * Get all active conversations for a panel
   */
  getPanelConversations(panelId: string): string[] {
    const conversationIds = this.panelConversations.get(panelId);
    return conversationIds ? Array.from(conversationIds) : [];
  }

  /**
   * Check if a conversation exists
   */
  hasConversation(conversationId: string): boolean {
    return this.conversations.has(conversationId);
  }

  /**
   * Subscribe to conversation end events.
   */
  addConversationEndListener(
    listener: (conversationId: string, panelId: string) => void
  ): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }
}

// Singleton instance
let instance: ClaudeCodeConversationManager | null = null;

/**
 * Get the singleton conversation manager instance
 */
export function getClaudeCodeConversationManager(): ClaudeCodeConversationManager {
  if (!instance) {
    instance = new ClaudeCodeConversationManager();
  }
  return instance;
}
