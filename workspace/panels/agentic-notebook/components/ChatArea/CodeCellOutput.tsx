import { useState, useCallback } from "react";
import { Box, Card, Flex, Text, Badge, IconButton, Tooltip } from "@radix-ui/themes";
import { CopyIcon, CheckIcon } from "@radix-ui/react-icons";
import type { CodeResultContent } from "../../types/messages";
import { CodeBlock } from "./CodeBlock";

interface CodeCellOutputProps {
  result: CodeResultContent;
  defaultCollapsed?: boolean;
}

/**
 * Copy button with success feedback.
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
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
 * Format console output.
 */
function formatConsoleOutput(
  output: CodeResultContent["consoleOutput"]
): string {
  return output
    .map((entry) => {
      const args = entry.args
        .map((arg: unknown) =>
          typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
        )
        .join(" ");
      return `[${entry.level}] ${args}`;
    })
    .join("\n");
}

/**
 * CodeCellOutput - Code execution result display.
 */
export function CodeCellOutput({
  result,
  defaultCollapsed = true,
}: CodeCellOutputProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  const hasOutput = result.consoleOutput.length > 0;
  const hasResult = result.result !== undefined;
  const hasError = !result.success;

  return (
    <Card
      variant="surface"
      size="1"
      style={{
        background: hasError ? "var(--red-a2)" : "var(--gray-a2)",
        width: "100%",
      }}
    >
      {/* Header */}
      <Flex
        align="center"
        justify="between"
        mb={isCollapsed ? "0" : "2"}
        style={{ cursor: "pointer" }}
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <Flex align="center" gap="2">
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            style={{
              transform: isCollapsed ? "rotate(0deg)" : "rotate(90deg)",
              transition: "transform 0.15s ease",
            }}
          >
            <path d="M4.5 2L8.5 6L4.5 10" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <Badge color={hasError ? "red" : "green"} size="1">
            {hasError ? "Error" : "Output"}
          </Badge>
          <Text size="1" color="gray">
            {result.executionTime}ms
          </Text>
        </Flex>
        {(hasOutput || hasResult) && (
          <Text size="1" color="gray">
            {isCollapsed ? "Show details" : "Hide details"}
          </Text>
        )}
      </Flex>

      {/* Console Output & Result (collapsible) */}
      {!isCollapsed && (
        <>
          {/* Error */}
          {hasError && result.error && (
            <Box
              style={{
                background: "var(--red-a2)",
                borderRadius: "var(--radius-2)",
                padding: "12px",
                marginBottom: "8px",
              }}
            >
              <Flex justify="between" align="center" mb="1">
                <Text size="1" color="red">
                  Error:
                </Text>
                <CopyButton text={result.error} />
              </Flex>
              <CodeBlock code={result.error} language="bash" />
            </Box>
          )}

          {/* Console Output */}
          {hasOutput && (
            <Box
              style={{
                background: "var(--gray-a2)",
                borderRadius: "var(--radius-2)",
                padding: "12px",
                marginBottom: hasResult ? "8px" : "0",
              }}
            >
              <Flex justify="between" align="center" mb="1">
                <Text size="1" color="gray">
                  Console:
                </Text>
                <CopyButton text={formatConsoleOutput(result.consoleOutput)} />
              </Flex>
              <CodeBlock code={formatConsoleOutput(result.consoleOutput)} language="bash" />
            </Box>
          )}

          {/* Return Value */}
          {hasResult && !hasError && (
            <Box
              style={{
                background: "var(--green-a2)",
                borderRadius: "var(--radius-2)",
                padding: "12px",
              }}
            >
              <Flex justify="between" align="center" mb="1">
                <Text size="1" color="gray">
                  Result:
                </Text>
                <CopyButton
                  text={
                    typeof result.result === "object"
                      ? JSON.stringify(result.result, null, 2)
                      : String(result.result)
                  }
                />
              </Flex>
              <CodeBlock
                code={
                  typeof result.result === "object"
                    ? JSON.stringify(result.result, null, 2)
                    : String(result.result)
                }
                language="json"
              />
            </Box>
          )}
        </>
      )}
    </Card>
  );
}
