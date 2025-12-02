import { useState, useCallback, useMemo } from "react";
import { Box, Card, Flex, Text, Badge, IconButton, Tooltip } from "@radix-ui/themes";
import { CopyIcon, CheckIcon } from "@radix-ui/react-icons";
import type { ToolCallContent, ToolResultContent } from "../../types/messages";
import { MDXContent } from "./MDXContent";
import { mdxComponents } from "./mdxComponents";
import { CodeBlock } from "./CodeBlock";

interface MDXToolResultProps {
  call: ToolCallContent | null;
  result: ToolResultContent | null;
}

/**
 * Extract MDX content from tool call args.
 */
function extractMDXContent(call: ToolCallContent | null): string | null {
  if (!call?.args) return null;
  const args = call.args as Record<string, unknown>;
  if (typeof args.content === "string") {
    return args.content;
  }
  return null;
}

/**
 * Check if tool result indicates an error.
 */
function getResultError(result: ToolResultContent | null): string | null {
  if (!result) return null;
  if (result.isError) {
    return typeof result.result === "string"
      ? result.result
      : JSON.stringify(result.result);
  }
  return null;
}

/**
 * Copy button with success feedback.
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [text]);

  return (
    <Tooltip content={copied ? "Copied!" : "Copy source"}>
      <IconButton
        size="1"
        variant="ghost"
        color={copied ? "green" : "gray"}
        onClick={handleCopy}
        style={{ opacity: copied ? 1 : 0.6 }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </IconButton>
    </Tooltip>
  );
}

/**
 * Chevron icon component.
 */
function ChevronIcon({ direction }: { direction: "down" | "right" }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="currentColor"
      style={{
        transform: direction === "down" ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.2s",
      }}
    >
      <path d="M4.5 2L8.5 6L4.5 10" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * MDXToolResult - Renders render_mdx tool results as compiled MDX.
 *
 * Shows the rendered MDX content prominently, with an expandable section
 * to view the source MDX code.
 */
export function MDXToolResult({
  call,
  result,
}: MDXToolResultProps) {
  const [showSource, setShowSource] = useState(false);

  // MDX content comes from the tool call args, not the result
  const mdxContent = useMemo(() => extractMDXContent(call), [call]);
  const error = useMemo(() => getResultError(result), [result]);

  const isError = !!error;
  const status = result ? (isError ? "error" : "completed") : "pending";

  // If we have content and no error, show rendered MDX prominently
  if (mdxContent && !isError) {
    return (
      <Card
        variant="surface"
        size="1"
        style={{
          background: "var(--gray-1)",
          border: "1px solid var(--gray-4)",
        }}
      >
        {/* Header with source toggle */}
        <Flex
          align="center"
          gap="2"
          mb="2"
          style={{ cursor: "pointer" }}
          onClick={() => setShowSource(!showSource)}
        >
          <ChevronIcon direction={showSource ? "down" : "right"} />
          <Badge color="purple" size="1">
            render_mdx
          </Badge>
          <Text size="1" color="gray">
            {showSource ? "source" : "rendered"}
          </Text>
          <CopyButton text={mdxContent} />
        </Flex>

        {/* Source view (collapsible) */}
        {showSource && (
          <Box mb="3" onClick={(e) => e.stopPropagation()}>
            <CodeBlock code={mdxContent} language="mdx" />
          </Box>
        )}

        {/* Rendered MDX content */}
        <Box onClick={(e) => e.stopPropagation()}>
          <MDXContent content={mdxContent} components={mdxComponents} />
        </Box>
      </Card>
    );
  }

  // Error or pending state - show in collapsed format
  return (
    <Card
      variant="surface"
      size="1"
      style={{
        background: "var(--gray-2)",
        cursor: "pointer",
        border: `1px solid ${isError ? "var(--red-6)" : "var(--gray-5)"}`,
      }}
      onClick={() => setShowSource(!showSource)}
    >
      <Flex align="center" gap="2" mb={showSource ? "2" : "0"}>
        <ChevronIcon direction={showSource ? "down" : "right"} />
        <Badge color={isError ? "red" : status === "completed" ? "purple" : "blue"} size="1">
          render_mdx
        </Badge>
        <Text size="1" color={isError ? "red" : "gray"}>
          {status}
        </Text>
      </Flex>

      {showSource && (
        <Box mt="1" onClick={(e) => e.stopPropagation()}>
          {/* Show MDX source from args */}
          {mdxContent && (
            <Box mb="2">
              <Flex justify="between" align="center" mb="1">
                <Text size="1" color="gray">MDX Content</Text>
                <CopyButton text={mdxContent} />
              </Flex>
              <CodeBlock code={mdxContent} language="mdx" />
            </Box>
          )}

          {/* Show error if present */}
          {isError && (
            <Box>
              <Text size="1" color="red" mb="1">
                Error
              </Text>
              <CodeBlock code={error} language="text" />
            </Box>
          )}
        </Box>
      )}
    </Card>
  );
}

/**
 * Check if a tool result is from render_mdx tool.
 */
export function isRenderMDXResult(
  call: ToolCallContent | null,
  result: ToolResultContent | null
): boolean {
  const toolName = call?.toolName ?? result?.toolName;
  return toolName === "render_mdx";
}
