/**
 * Custom Task Tool for Restricted Mode
 *
 * Provides a Task tool that runs subagent SDK sessions with MCP tools.
 * Only used in restricted mode where the SDK's built-in Task tool is disabled.
 */

import { z } from "zod";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  createSubagentConnection,
  forwardStreamEventToSubagent,
  jsonSchemaToZodRawShape,
  type AgenticClient,
  type SubagentConnectionOptions,
  type SDKStreamEvent,
} from "@natstack/agentic-messaging";
import { extractMethodName, getCanonicalToolName } from "@natstack/agentic-messaging/utils";

/**
 * Schema for the restricted mode Task tool.
 * Uses "Eval" instead of "Bash" since we only have sandboxed execution.
 */
export const RestrictedTaskToolSchema = z.object({
  description: z.string().describe("Short (3-5 word) description of the task"),
  prompt: z.string().describe("Detailed instructions for the subagent"),
  subagent_type: z
    .enum(["Explore", "Plan", "Eval", "general-purpose"])
    .describe(
      "Explore=search code, Plan=design architecture, Eval=run commands, general-purpose=full capabilities"
    ),
  model: z.enum(["sonnet", "opus", "haiku"]).optional(),
  max_turns: z.number().optional(),
});

export type RestrictedTaskToolArgs = z.infer<typeof RestrictedTaskToolSchema>;

/**
 * Tool definition with execute function.
 * Matches the structure returned by createToolsForAgentSDK.
 */
export interface ToolDefinitionWithExecute {
  name: string;
  description?: string;
  inputSchema: unknown;
  execute: (args: unknown, signal?: AbortSignal) => Promise<unknown>;
}

/**
 * Context required to create the restricted Task tool.
 */
export interface TaskToolContext {
  /** Parent pubsub client */
  parentClient: AgenticClient;
  /** All available tools from pubsub participants */
  availableTools: ToolDefinitionWithExecute[];
  /** Path to claude CLI executable */
  claudeExecutable: string;
  /** Connection options for creating subagent pubsub connections */
  connectionOptions: SubagentConnectionOptions;
  /** Parent settings to inherit (optional, subagent uses defaults if not provided) */
  parentSettings?: {
    maxThinkingTokens?: number;
  };
}

/**
 * Get canonical tool name (strip MCP/pubsub prefixes and map to PascalCase).
 * Uses extractMethodName to properly parse prefixed names, then getCanonicalToolName
 * to map snake_case to PascalCase (e.g., "pubsub_abc_file_read" → "Read").
 */
function getCanonicalName(toolName: string): string {
  const methodName = extractMethodName(toolName);
  return getCanonicalToolName(methodName);
}

/**
 * Get the tools available for a specific subagent type.
 */
function getToolsForSubagentType(
  subagentType: string,
  allTools: ToolDefinitionWithExecute[]
): ToolDefinitionWithExecute[] {
  // Build a set of canonical names for checking availability
  const canonicalNames = new Set(allTools.map((t) => getCanonicalName(t.name)));

  // Define which canonical tool names each subagent type can use
  const allowedCanonical: Record<string, string[]> = {
    Explore: ["Read", "Glob", "Grep"],
    Plan: ["Read", "Glob", "Grep"],
    Eval: ["Eval", "Read"],
    "general-purpose": [], // empty = allow all
  };

  const allowed = allowedCanonical[subagentType];
  if (!allowed || allowed.length === 0) {
    return allTools; // general-purpose or unknown: all tools
  }

  // For Eval, verify the tool is available
  if (subagentType === "Eval" && !canonicalNames.has("Eval")) {
    throw new Error("Eval subagent requires Eval tool, but it's not available via MCP");
  }

  // Filter by canonical name match
  return allTools.filter((t) => allowed.includes(getCanonicalName(t.name)));
}

/**
 * Get the system prompt for a specific subagent type.
 */
function getSystemPromptForSubagentType(subagentType: string): string {
  switch (subagentType) {
    case "Explore":
      return `You are a fast codebase explorer. Your job is to quickly search for patterns, find files, and answer questions about the codebase. You have read-only access - do not attempt to modify files. Be concise and focused.`;

    case "Plan":
      return `You are a software architect. Analyze code structure and design implementation plans. Focus on architectural decisions, trade-offs, and step-by-step approaches. Do not write code - only plan and explain.`;

    case "Eval":
      return `You are a command execution specialist. Run shell commands for git operations, builds, tests, and other CLI tasks. Be careful with destructive commands. Explain what each command does.`;

    case "general-purpose":
    default:
      return `You are a capable assistant helping with a subtask. Complete the task thoroughly and report your findings.`;
  }
}

/**
 * Build an MCP server with filtered tools for the subagent type.
 *
 * Tools are exposed to the subagent using canonical names (e.g., "Read")
 * but execution uses the original tool's execute function which handles
 * the prefixed name mapping internally.
 *
 * Returns both the MCP server and the list of allowed tool names for SDK restriction.
 */
function buildSubagentMcpServer(
  subagentType: string,
  parentTools: ToolDefinitionWithExecute[]
): { server: ReturnType<typeof createSdkMcpServer>; allowedTools: string[] } {
  const filteredTools = getToolsForSubagentType(subagentType, parentTools);

  const mcpTools = filteredTools.map((originalTool) => {
    // Expose canonical name to subagent (e.g., "Read" not "mcp__workspace__Read")
    const canonicalName = getCanonicalName(originalTool.name);

    return tool(
      canonicalName,
      originalTool.description ?? `Execute ${canonicalName}`,
      // Convert JSON Schema to ZodRawShape (inputSchema from pubsub is JSON Schema format)
      jsonSchemaToZodRawShape(originalTool.inputSchema as Record<string, unknown>),
      async (args) => {
        // Execute using the original tool's execute function directly
        const result = await originalTool.execute(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }
    );
  });

  // Generate allowed tool names for SDK restriction (e.g., "mcp__subagent__Read")
  const allowedTools = mcpTools.map((t) => `mcp__subagent__${t.name}`);

  return {
    server: createSdkMcpServer({
      name: "subagent",
      version: "1.0.0",
      tools: mcpTools,
    }),
    allowedTools,
  };
}

/**
 * Configuration for running a subagent SDK session.
 */
interface SubagentSessionConfig {
  prompt: string;
  systemPrompt: string;
  mcpServer: ReturnType<typeof createSdkMcpServer>;
  /** List of allowed tools for SDK restriction (e.g., ["mcp__subagent__Read"]) */
  allowedTools: string[];
  model?: string;
  maxTurns?: number;
  maxThinkingTokens?: number;
  claudeExecutable: string;
  onStreamEvent: (event: SDKStreamEvent) => Promise<void>;
}

/**
 * Run an SDK session for a subagent, streaming events to a callback.
 */
async function runSubagentSession(config: SubagentSessionConfig): Promise<string> {
  const subagentQuery = query({
    prompt: config.prompt,
    options: {
      mcpServers: { subagent: config.mcpServer },
      systemPrompt: config.systemPrompt,
      pathToClaudeCodeExecutable: config.claudeExecutable,
      includePartialMessages: true, // Enable streaming
      // CRITICAL: Restrict subagent to only MCP tools - prevents bypassing restricted mode
      allowedTools: config.allowedTools,
      ...(config.model && { model: config.model }),
      ...(config.maxTurns && { maxTurns: config.maxTurns }),
      ...(config.maxThinkingTokens && { maxThinkingTokens: config.maxThinkingTokens }),
    },
  });

  let result = "";

  for await (const message of subagentQuery) {
    // Forward stream events to subagent connection
    if (message.type === "stream_event") {
      await config.onStreamEvent(message.event as SDKStreamEvent);
    }

    // Capture final result
    if (message.type === "result" && message.subtype === "success") {
      result = (message as { result?: string }).result ?? "";
    }
  }

  return result;
}

/**
 * Create custom Task tool for restricted mode.
 *
 * Returns a tool definition that can be added to the MCP server's tool list.
 * This tool spawns subagent SDK sessions that appear as separate chat participants.
 */
export function createRestrictedTaskTool(context: TaskToolContext) {
  return {
    name: "Task",
    description: `Launch a subagent for complex, multi-step tasks. The subagent appears as a separate chat participant with full streaming.

Available subagent types:
- Explore: Fast codebase exploration, searching, read-only
- Plan: Architectural planning and design, read-only
- Eval: Command execution (sandboxed)
- general-purpose: Full capabilities`,
    inputSchema: RestrictedTaskToolSchema,
    execute: async (args: RestrictedTaskToolArgs) => {
      // 1. Create subagent pubsub connection
      const subagent = await createSubagentConnection(
        {
          parentClient: context.parentClient,
          taskDescription: args.description,
          subagentType: args.subagent_type,
        },
        context.connectionOptions
      );

      try {
        // 2. Build MCP server with filtered tools for this subagent type
        const { server: mcpServer, allowedTools } = buildSubagentMcpServer(
          args.subagent_type,
          context.availableTools
        );

        // 3. Get system prompt for subagent type
        const systemPrompt = getSystemPromptForSubagentType(args.subagent_type);

        // 4. Run SDK session for subagent, streaming to pubsub
        const result = await runSubagentSession({
          prompt: args.prompt,
          systemPrompt,
          mcpServer,
          allowedTools,
          model: args.model,
          maxTurns: args.max_turns,
          maxThinkingTokens: context.parentSettings?.maxThinkingTokens,
          claudeExecutable: context.claudeExecutable,
          onStreamEvent: (event) => forwardStreamEventToSubagent(subagent, event),
        });

        await subagent.complete();
        return { success: true, result };
      } catch (err) {
        await subagent.error(err instanceof Error ? err.message : String(err));
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        await subagent.close();
      }
    },
  };
}
