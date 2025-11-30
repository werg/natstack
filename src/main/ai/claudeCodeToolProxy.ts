/**
 * Claude Code Tool Proxy
 *
 * Creates SDK MCP servers that proxy tool calls back to panels via IPC.
 * This allows panel code to define and execute tools while using Claude Code
 * as the AI provider.
 */

import { createSdkMcpServer, tool } from "ai-sdk-provider-claude-code";
import { z } from "zod";
import type { AIToolDefinition } from "@natstack/ai";

/**
 * MCP server configuration with instance (from claude-agent-sdk)
 */
type McpSdkServerConfigWithInstance = ReturnType<typeof createSdkMcpServer>;

/**
 * Result format for tool execution (MCP compatible)
 */
export interface ToolExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Callback type for executing a tool in the panel
 */
export type ToolExecuteCallback = (
  toolName: string,
  args: Record<string, unknown>
) => Promise<ToolExecutionResult>;

/**
 * Configuration for creating a tool proxy MCP server
 */
export interface ToolProxyConfig {
  /** Unique identifier for this conversation */
  conversationId: string;
  /** Panel that owns this conversation */
  panelId: string;
  /** Tool definitions from the panel */
  tools: AIToolDefinition[];
  /** Callback to execute tools in the panel */
  executeCallback: ToolExecuteCallback;
}

/**
 * Convert JSON Schema to Zod schema.
 * Simplified conversion that handles common JSON Schema patterns.
 * Note: json-schema-to-zod returns code strings which can't be used at runtime,
 * so we still need manual conversion for the most common patterns.
 */
function convertJsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  const type = schema["type"] as string | undefined;

  switch (type) {
    case "string": {
      const enumValues = schema["enum"] as string[] | undefined;
      if (enumValues && enumValues.length > 0) {
        return z.enum(enumValues as [string, ...string[]]);
      }
      return z.string();
    }
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array": {
      const items = schema["items"] as Record<string, unknown> | undefined;
      if (items) {
        return z.array(convertJsonSchemaToZod(items));
      }
      return z.array(z.unknown());
    }
    case "object": {
      const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
      const required = (schema["required"] as string[]) || [];

      if (!properties) {
        return z.record(z.string(), z.unknown());
      }
      const shape: Record<string, z.ZodType> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        const zodType = convertJsonSchemaToZod(propSchema);
        shape[key] = required.includes(key) ? zodType : zodType.optional();
      }
      return z.object(shape);
    }
    case "null":
      return z.null();
    default:
      // Handle union types
      if (schema["anyOf"] || schema["oneOf"]) {
        const variants = (schema["anyOf"] || schema["oneOf"]) as Record<string, unknown>[];
        if (variants.length === 0) {
          return z.unknown();
        } else if (variants.length === 1) {
          return convertJsonSchemaToZod(variants[0]!);
        } else {
          const zodVariants = variants.map(convertJsonSchemaToZod) as [z.ZodType, z.ZodType, ...z.ZodType[]];
          return z.union(zodVariants);
        }
      }
      return z.unknown();
  }
}

/**
 * Convert JSON Schema to a shape object for the tool() function.
 * If the schema is an object type, returns the properties as a shape.
 * Otherwise wraps the schema in { input: ... }.
 */
function jsonSchemaToShape(schema: Record<string, unknown>): Record<string, z.ZodType> {
  const type = schema["type"] as string | undefined;

  if (type === "object") {
    const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
    const required = (schema["required"] as string[]) || [];

    if (!properties) {
      // Empty object schema - return empty shape
      return {};
    }

    const shape: Record<string, z.ZodType> = {};
    for (const [key, propSchema] of Object.entries(properties)) {
      const zodType = convertJsonSchemaToZod(propSchema);
      shape[key] = required.includes(key) ? zodType : zodType.optional();
    }
    return shape;
  }

  // Non-object schemas get wrapped
  return { input: convertJsonSchemaToZod(schema) };
}

/**
 * Create an SDK MCP server that proxies tool calls to the panel.
 *
 * @param config - Configuration for the tool proxy
 * @returns MCP server configuration that can be passed to Claude Code provider
 */
export function createToolProxyMcpServer(config: ToolProxyConfig): McpSdkServerConfigWithInstance {
  const { conversationId, tools, executeCallback } = config;

  // Create SDK tools from our AIToolDefinition array
  const sdkTools = tools.map((toolDef) => {
    // Convert JSON Schema parameters to a shape object
    const inputSchema = jsonSchemaToShape(toolDef.parameters);

    return tool(
      toolDef.name,
      toolDef.description || `Tool: ${toolDef.name}`,
      inputSchema,
      async (args: Record<string, unknown>): Promise<ToolExecutionResult> => {
        try {
          return await executeCallback(toolDef.name, args);
        } catch (error) {
          // Convert thrown errors to isError results so Claude sees them gracefully
          return {
            content: [
              { type: "text", text: error instanceof Error ? error.message : String(error) },
            ],
            isError: true,
          };
        }
      }
    );
  });

  // Create the MCP server with all the tools
  return createSdkMcpServer({
    name: `proxy-${conversationId}`,
    tools: sdkTools,
  });
}

/**
 * Get the MCP tool names for a set of tool definitions.
 * Tool names follow the pattern: mcp__<serverName>__<toolName>
 *
 * @param conversationId - The conversation ID (used in server name)
 * @param tools - Tool definitions
 * @returns Array of MCP tool names
 */
export function getMcpToolNames(conversationId: string, tools: AIToolDefinition[]): string[] {
  const serverName = `proxy-${conversationId}`;
  return tools.map((t) => `mcp__${serverName}__${t.name}`);
}
