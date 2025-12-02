import { useState, useCallback, useMemo } from "react";
import { Box, Card, Flex, Text, Badge, IconButton, Tooltip } from "@radix-ui/themes";
import { CopyIcon, CheckIcon } from "@radix-ui/react-icons";
import type { ToolCallContent, ToolResultContent } from "../../types/messages";
import { CodeBlock } from "./CodeBlock";

interface ToolCallRecordProps {
  call: ToolCallContent | null;
  result: ToolResultContent | null;
  defaultCollapsed?: boolean;
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
    <Tooltip content={copied ? "Copied!" : "Copy"}>
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
 * ToolCallRecord - Expandable tool action display.
 */
export function ToolCallRecord({
  call,
  result,
  defaultCollapsed = true,
}: ToolCallRecordProps) {
  const [isExpanded, setIsExpanded] = useState(!defaultCollapsed);

  const toolName = call?.toolName ?? result?.toolName ?? "Unknown";
  const isError = result?.isError ?? false;
  const status = result ? (isError ? "error" : "completed") : "pending";
   const argsJson = useMemo(
    () => (call ? JSON.stringify(call.args, null, 2) : ""),
    [call]
  );
  const resultJson = useMemo(() => {
    if (!result) return "";
    if (typeof result.result === "string") return result.result;
    return JSON.stringify(result.result, null, 2);
  }, [result]);

  const hasCodeArg =
    call &&
    typeof call.args === "object" &&
    call.args !== null &&
    "code" in (call.args as Record<string, unknown>);
  const codeLanguage =
    (call?.args as { language?: string } | undefined)?.language || "typescript";
  const codeValue =
    (call?.args as { code?: string } | undefined)?.code ?? "";

  return (
    <Card
      variant="surface"
      size="1"
      style={{
        background: "var(--gray-2)",
        cursor: "pointer",
        border: "1px solid var(--gray-5)",
      }}
      onClick={() => setIsExpanded(!isExpanded)}
    >
      <Flex align="center" gap="2" mb={isExpanded ? "2" : "0"}>
        <ChevronIcon direction={isExpanded ? "down" : "right"} />
        <Badge color={isError ? "red" : status === "completed" ? "green" : "blue"} size="1">
          {toolName}
        </Badge>
        <Text size="1" color="gray">{status}</Text>
        {hasCodeArg && (
          <Text size="1" color="gray" style={{ marginLeft: "auto" }}>
            {codeLanguage}
          </Text>
        )}
      </Flex>

      {isExpanded && (
        <Box mt="1" onClick={(e) => e.stopPropagation()}>
          {call && (
            <Box mb="3">
              <Flex justify="between" align="center" mb="1">
                <Text size="1" color="gray">Arguments</Text>
                <CopyButton text={hasCodeArg ? codeValue : argsJson} />
              </Flex>
              {hasCodeArg ? (
                <CodeBlock code={codeValue} language={codeLanguage} />
              ) : (
                <CodeBlock code={argsJson} language="json" />
              )}
            </Box>
          )}

          {result && (
            <Box>
              <Flex justify="between" align="center" mb="1">
                <Text size="1" color={isError ? "red" : "gray"}>
                  {isError ? "Error" : "Result"}
                </Text>
                <CopyButton text={resultJson} />
              </Flex>
              <CodeBlock
                code={resultJson}
                language={isError ? "bash" : hasCodeArg ? "json" : "text"}
              />
            </Box>
          )}
        </Box>
      )}
    </Card>
  );
}
