import type { ToolCallContent, ToolResultContent } from "../types/messages";

/**
 * Configuration for extracting and displaying tool arguments.
 */
export interface ToolArgConfig {
  /** The argument key containing the primary content */
  primaryArg: string;
  /** Syntax highlighting language for the primary content */
  language: string;
  /** Label to show for the input section */
  label: string;
}

/**
 * Registry of known tool argument patterns.
 */
export const TOOL_ARG_CONFIG: Record<string, ToolArgConfig> = {
  execute_code: {
    primaryArg: "code",
    language: "tsx",
    label: "Source",
  },
  render_mdx: {
    primaryArg: "content",
    language: "mdx",
    label: "MDX Source",
  },
};

/**
 * Extracted tool argument content with metadata.
 */
export interface ExtractedToolArg {
  /** The primary content string */
  content: string | null;
  /** Syntax highlighting language */
  language: string;
  /** Display label */
  label: string;
}

/**
 * Extract the primary argument from a tool call.
 */
export function getToolPrimaryArg(call: ToolCallContent | null): ExtractedToolArg {
  if (!call?.args) {
    return { content: null, language: "json", label: "Input" };
  }

  const config = TOOL_ARG_CONFIG[call.toolName];
  const args = call.args as Record<string, unknown>;

  if (config && typeof args[config.primaryArg] === "string") {
    return {
      content: args[config.primaryArg] as string,
      language: config.language,
      label: config.label,
    };
  }

  // Fall back to JSON representation
  return {
    content: JSON.stringify(args, null, 2),
    language: "json",
    label: "Input",
  };
}

/**
 * Get error message from a tool result.
 */
export function getToolResultError(result: ToolResultContent | null): string | null {
  if (!result) return null;
  if (result.isError) {
    return typeof result.result === "string"
      ? result.result
      : JSON.stringify(result.result);
  }
  return null;
}

/**
 * Get the tool name from call or result.
 */
export function getToolName(
  call: ToolCallContent | null | undefined,
  result: ToolResultContent | null | undefined
): string {
  return call?.toolName ?? result?.toolName ?? "unknown";
}

/**
 * Determine tool status from result.
 */
export type ToolStatus = "pending" | "completed" | "error";

export function getToolStatus(result: ToolResultContent | null | undefined): ToolStatus {
  if (!result) return "pending";
  return result.isError ? "error" : "completed";
}
