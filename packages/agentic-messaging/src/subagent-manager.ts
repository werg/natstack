/**
 * SubagentManager - Unified Subagent Lifecycle Management
 *
 * Consolidates all subagent management logic:
 * - Event buffering for tools that haven't created their subagent yet
 * - Subagent creation with proper connection options
 * - Event forwarding to active subagents
 * - Timeout handling to prevent resource leaks
 * - Cleanup on tool completion or error
 *
 * Used by unrestricted mode in claude-code-responder to manage
 * Task tool subagents that stream their output to the chat.
 */

import {
  createSubagentConnection,
  forwardStreamEventToSubagent,
  type SubagentConnection,
  type SubagentConnectionConfig,
  type SDKStreamEvent,
} from "./subagent-connection.js";
import type { AgenticClient } from "./types.js";

/** Default timeout for subagents (10 minutes) */
const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Configuration for SubagentManager.
 */
export interface SubagentManagerConfig {
  /** PubSub server URL (from runtime pubsubConfig) */
  serverUrl: string;
  /** Auth token (from runtime pubsubConfig) */
  token: string;
  /** Channel name */
  channel: string;
  /**
   * Parent client - used to lazily derive contextId.
   * This avoids the issue of capturing contextId too early (before server sends it).
   */
  parentClient: AgenticClient;
  /** Logging function */
  log: (msg: string) => void;
  /** Timeout in milliseconds before cleaning up idle subagents (default: 10 minutes) */
  timeoutMs?: number;
}

/**
 * Configuration for creating a subagent.
 */
export interface SubagentConfig {
  /** Short description of the task (shown in participant name) */
  taskDescription: string;
  /** Type of subagent (e.g., "Explore", "Plan", "Bash") */
  subagentType?: string;
  /** Tool use ID that triggered this subagent */
  parentToolUseId: string;
}

/**
 * Unified manager for subagent lifecycle.
 *
 * Handles:
 * - Event buffering until subagent is created
 * - Subagent creation with proper connection options
 * - Event forwarding to active subagents
 * - Timeout-based cleanup to prevent leaks
 * - Cleanup on tool completion
 *
 * @example
 * ```typescript
 * const manager = new SubagentManager({
 *   serverUrl: pubsubConfig.serverUrl,
 *   token: pubsubConfig.token,
 *   channel: channelName,
 *   parentClient: client,
 *   log,
 * });
 *
 * // In event loop:
 * if (event.parent_tool_use_id) {
 *   await manager.routeEvent(event.parent_tool_use_id, event);
 * }
 *
 * // When Task tool input is parsed:
 * await manager.create(toolUseId, {
 *   taskDescription: "Explore the codebase",
 *   subagentType: "Explore",
 *   parentToolUseId: toolUseId,
 * });
 *
 * // On tool result:
 * await manager.cleanup(toolUseId, "complete");
 *
 * // On error or pause:
 * await manager.cleanupAll();
 * ```
 */
export class SubagentManager {
  private readonly active = new Map<string, SubagentConnection>();
  private readonly pendingEvents = new Map<string, SDKStreamEvent[]>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly serverUrl: string;
  private readonly token: string;
  private readonly channel: string;
  private readonly parentClient: AgenticClient;
  private readonly log: (msg: string) => void;
  private readonly timeoutMs: number;

  constructor(config: SubagentManagerConfig) {
    this.serverUrl = config.serverUrl;
    this.token = config.token;
    this.channel = config.channel;
    this.parentClient = config.parentClient;
    this.log = config.log;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  }

  /**
   * Derive connection options lazily from the parent client.
   * contextId comes from the parent client, which gets it from the server.
   */
  private getConnectionOptions() {
    return {
      serverUrl: this.serverUrl,
      token: this.token,
      channel: this.channel,
      contextId: this.parentClient.contextId,
    };
  }

  /**
   * Get connection options for external use (e.g., restricted mode Task tool).
   *
   * This is useful when you need to create subagent connections outside of
   * SubagentManager's normal lifecycle management (e.g., in task-tool.ts).
   */
  getConnectionOptionsForExternalUse() {
    return this.getConnectionOptions();
  }

  /**
   * Buffer an event for a tool that hasn't created its subagent yet.
   *
   * Events are buffered until create() is called, at which point they're
   * flushed to the newly created subagent.
   *
   * @param toolUseId - Tool use ID to buffer for
   * @param event - SDK stream event to buffer
   */
  bufferEvent(toolUseId: string, event: SDKStreamEvent): void {
    const buffered = this.pendingEvents.get(toolUseId) ?? [];
    buffered.push(event);
    this.pendingEvents.set(toolUseId, buffered);
  }

  /**
   * Create a subagent and flush any buffered events.
   *
   * @param toolUseId - Tool use ID that triggered this subagent
   * @param config - Subagent configuration
   * @returns The created SubagentConnection
   * @throws If subagent creation fails
   */
  async create(toolUseId: string, config: SubagentConfig): Promise<SubagentConnection> {
    const connectionConfig: SubagentConnectionConfig = {
      parentClient: this.parentClient,
      taskDescription: config.taskDescription,
      subagentType: config.subagentType,
      parentToolUseId: config.parentToolUseId,
    };

    const subagent = await createSubagentConnection(
      connectionConfig,
      this.getConnectionOptions()
    );

    this.active.set(toolUseId, subagent);
    this.log(`Created subagent for Task ${toolUseId}: ${config.taskDescription}`);

    // Set timeout to prevent leaks if tool_result never arrives
    const timeoutId = setTimeout(async () => {
      await this.cleanup(toolUseId, "timeout");
    }, this.timeoutMs);
    this.timeouts.set(toolUseId, timeoutId);

    // Flush any buffered events
    const buffered = this.pendingEvents.get(toolUseId) ?? [];
    for (const event of buffered) {
      await forwardStreamEventToSubagent(subagent, event);
    }
    this.pendingEvents.delete(toolUseId);

    return subagent;
  }

  /**
   * Forward an event to an existing subagent.
   *
   * @param toolUseId - Tool use ID of the subagent
   * @param event - SDK stream event to forward
   * @returns true if event was forwarded, false if subagent doesn't exist
   */
  async forward(toolUseId: string, event: SDKStreamEvent): Promise<boolean> {
    const subagent = this.active.get(toolUseId);
    if (!subagent) {
      return false;
    }
    await forwardStreamEventToSubagent(subagent, event);
    return true;
  }

  /**
   * Route an event to the appropriate subagent.
   *
   * If the subagent exists, forwards the event.
   * If not, buffers the event until the subagent is created.
   *
   * @param toolUseId - Tool use ID to route to
   * @param event - SDK stream event
   */
  async routeEvent(toolUseId: string, event: SDKStreamEvent): Promise<void> {
    const forwarded = await this.forward(toolUseId, event);
    if (!forwarded) {
      this.bufferEvent(toolUseId, event);
    }
  }

  /**
   * Clean up a single subagent.
   *
   * @param toolUseId - Tool use ID of the subagent
   * @param reason - Reason for cleanup (affects error message if applicable)
   */
  async cleanup(toolUseId: string, reason: "complete" | "error" | "timeout"): Promise<void> {
    // Always clean pending events (may exist even if subagent creation failed)
    this.pendingEvents.delete(toolUseId);

    // Clear timeout if set
    const timeout = this.timeouts.get(toolUseId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(toolUseId);
    }

    const subagent = this.active.get(toolUseId);
    if (!subagent) return;

    // Finalize subagent
    if (reason === "complete") {
      await subagent.complete();
    } else if (reason === "error") {
      await subagent.error("Subagent error");
    } else if (reason === "timeout") {
      await subagent.error("Subagent timed out");
      this.log(`Subagent ${toolUseId} timed out after ${this.timeoutMs / 1000}s`);
    }

    await subagent.close();
    this.active.delete(toolUseId);
    this.log(`Cleaned up subagent ${toolUseId} (reason: ${reason})`);
  }

  /**
   * Clean up all subagents.
   *
   * Used when the parent agent is paused or encounters an error.
   */
  async cleanupAll(): Promise<void> {
    for (const [toolUseId, subagent] of this.active) {
      const timeout = this.timeouts.get(toolUseId);
      if (timeout) {
        clearTimeout(timeout);
        this.timeouts.delete(toolUseId);
      }
      await subagent.error("Parent cancelled");
      await subagent.close();
    }
    this.active.clear();
    this.pendingEvents.clear();
    this.log("Cleaned up all subagents");
  }

  /**
   * Check if a subagent exists for the given tool use ID.
   *
   * @param toolUseId - Tool use ID to check
   */
  has(toolUseId: string): boolean {
    return this.active.has(toolUseId);
  }

  /**
   * Get a subagent by tool use ID.
   *
   * @param toolUseId - Tool use ID to get
   */
  get(toolUseId: string): SubagentConnection | undefined {
    return this.active.get(toolUseId);
  }

  /**
   * Get the number of active subagents.
   */
  get size(): number {
    return this.active.size;
  }
}
