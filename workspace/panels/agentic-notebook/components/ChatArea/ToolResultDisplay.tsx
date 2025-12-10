import { useState } from "react";
import { Box, Card, Flex, Text, Badge } from "@radix-ui/themes";
import type { ToolCallContent, ToolResultContent } from "../../types/messages";
import { isCodeExecutionData } from "../../types/messages";
import { CodeBlock } from "./CodeBlock";
import { CopyButton } from "../shared/CopyButton";
import { ChevronIcon } from "../shared/ChevronIcon";
import { CodeExecutionOutput } from "./CodeExecutionOutput";
import { MDXRenderedOutput } from "./MDXRenderedOutput";
import {
  getToolPrimaryArg,
  getToolResultError,
  getToolName,
  getToolStatus,
  type ToolStatus,
} from "../../utils/toolArgs";

interface ToolResultDisplayProps {
  /** Tool call content (may be null for orphan results) */
  call?: ToolCallContent | null;
  /** Tool result content (may be null for pending calls) */
  result?: ToolResultContent | null;
  /** Whether to default to collapsed state */
  defaultCollapsed?: boolean;
}

/**
 * Get badge color based on status.
 */
function getStatusColor(status: ToolStatus, toolName: string): "red" | "green" | "blue" | "purple" {
  if (status === "error") return "red";
  if (status === "pending") return "blue";
  // Completed - use tool-specific colors
  if (toolName === "render_mdx") return "purple";
  return "green";
}

/**
 * Collapsible input section with syntax highlighting.
 */
function ToolInputSection({
  call,
  defaultCollapsed = true,
}: {
  call: ToolCallContent;
  defaultCollapsed?: boolean;
}) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const { content, language, label } = getToolPrimaryArg(call);

  if (!content) return null;

  return (
    <Box
      style={{
        background: "var(--blue-a2)",
        borderRadius: "var(--radius-2)",
        padding: "12px",
      }}
    >
      <Flex
        justify="between"
        align="center"
        style={{ cursor: "pointer" }}
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <Flex align="center" gap="2">
          <ChevronIcon direction={isCollapsed ? "right" : "down"} />
          <Text size="1" color="gray">
            {label}
          </Text>
        </Flex>
        <CopyButton text={content} />
      </Flex>
      {!isCollapsed && (
        <Box mt="2" onClick={(e) => e.stopPropagation()}>
          <CodeBlock code={content} language={language} />
        </Box>
      )}
    </Box>
  );
}

/**
 * Error display section.
 */
function ErrorSection({ error }: { error: string }) {
  return (
    <Box
      style={{
        background: "var(--red-a2)",
        borderRadius: "var(--radius-2)",
        padding: "12px",
      }}
    >
      <Flex justify="between" align="center" mb="1">
        <Text size="1" color="red">
          Error:
        </Text>
        <CopyButton text={error} />
      </Flex>
      <CodeBlock code={error} language="text" />
    </Box>
  );
}

/**
 * Generic result display for tools without specialized output.
 */
function GenericResultSection({ result }: { result: ToolResultContent }) {
  const resultText = typeof result.result === "string"
    ? result.result
    : JSON.stringify(result.result, null, 2);

  if (!resultText || resultText === "null" || resultText === "undefined") {
    return null;
  }

  return (
    <Box
      style={{
        background: "var(--gray-a2)",
        borderRadius: "var(--radius-2)",
        padding: "12px",
      }}
    >
      <Flex justify="between" align="center" mb="1">
        <Text size="1" color="gray">
          Result:
        </Text>
        <CopyButton text={resultText} />
      </Flex>
      <CodeBlock code={resultText} language="json" />
    </Box>
  );
}

/**
 * ToolResultDisplay - Unified component for rendering tool calls and results.
 *
 * Architecture:
 * - Header: Always shows tool name, status badge, and collapse toggle
 * - Output section: Specialized renderers based on tool type (prominent when completed)
 * - Input section: Collapsible syntax-highlighted input (always available)
 * - Error section: Shows error message if present
 *
 * Specialized output renderers:
 * - render_mdx → MDXRenderedOutput (rendered MDX content)
 * - execute_code → CodeExecutionOutput (component/console/result)
 * - other tools → GenericResultSection (JSON result)
 */
export function ToolResultDisplay({
  call,
  result,
  defaultCollapsed = true,
}: ToolResultDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(!defaultCollapsed);

  const toolName = getToolName(call, result);
  const status = getToolStatus(result);
  const error = getToolResultError(result ?? null);
  const hasError = !!error;

  // Extract primary content for MDX
  const primaryArg = call ? getToolPrimaryArg(call) : null;
  const mdxContent = toolName === "render_mdx" ? primaryArg?.content : null;

  // Check for code execution data
  const codeExecutionData = result && isCodeExecutionData(result.data) ? result.data : null;

  // Determine if we have prominent output to show
  const hasProminentOutput = !hasError && (
    (toolName === "render_mdx" && mdxContent) ||
    (toolName === "execute_code" && codeExecutionData)
  );

  // For completed tools with prominent output, show output prominently
  // For error/pending or generic tools, use collapsed format
  const showProminentOutput = status === "completed" && hasProminentOutput;

  return (
    <Card
      variant="surface"
      size="1"
      style={{
        background: hasError ? "var(--red-a2)" : "var(--gray-2)",
        border: `1px solid ${hasError ? "var(--red-6)" : "var(--gray-5)"}`,
        width: "100%",
      }}
    >
      {/* Header */}
      <Flex
        align="center"
        gap="2"
        mb={isExpanded || showProminentOutput ? "2" : "0"}
        style={{ cursor: "pointer" }}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <ChevronIcon direction={isExpanded ? "down" : "right"} />
        <Badge color={getStatusColor(status, toolName)} size="1">
          {toolName}
        </Badge>
        <Text size="1" color={hasError ? "red" : "gray"}>
          {status}
        </Text>
        {codeExecutionData && (
          <Text size="1" color="gray">
            {codeExecutionData.executionTime}ms
          </Text>
        )}
      </Flex>

      {/* Prominent Output (always visible when available) */}
      {showProminentOutput && (
        <Box mb={isExpanded ? "2" : "0"}>
          {toolName === "render_mdx" && mdxContent && (
            <MDXRenderedOutput content={mdxContent} />
          )}
          {toolName === "execute_code" && codeExecutionData && (
            <CodeExecutionOutput result={codeExecutionData} />
          )}
        </Box>
      )}

      {/* Expanded section (input, error, generic result) */}
      {isExpanded && (
        <Box onClick={(e) => e.stopPropagation()}>
          {/* Error (if not showing prominent output) */}
          {hasError && !showProminentOutput && (
            <Box mb="2">
              <ErrorSection error={error} />
            </Box>
          )}

          {/* Code execution output (if error state, show in expanded) */}
          {toolName === "execute_code" && codeExecutionData && hasError && (
            <Box mb="2">
              <CodeExecutionOutput result={codeExecutionData} />
            </Box>
          )}

          {/* Generic result for other tools */}
          {!hasError && !hasProminentOutput && result && (
            <Box mb={call ? "2" : "0"}>
              <GenericResultSection result={result} />
            </Box>
          )}

          {/* Input section (always available when we have a call) */}
          {call && (
            <ToolInputSection
              call={call}
              defaultCollapsed={!!showProminentOutput}
            />
          )}
        </Box>
      )}
    </Card>
  );
}
