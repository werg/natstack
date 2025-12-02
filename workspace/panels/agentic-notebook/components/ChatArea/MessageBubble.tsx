import { useState, useCallback } from "react";
import { Box, Card, Flex, Text, IconButton, Tooltip } from "@radix-ui/themes";
import { CopyIcon, CheckIcon } from "@radix-ui/react-icons";
import type { ChannelMessage } from "../../types/messages";
import type { KernelManager } from "../../kernel/KernelManager";
import { ToolCallRecord } from "./ToolCallRecord";
import { MDXToolResult, isRenderMDXResult } from "./MDXToolResult";
import { CodeCellOutput } from "./CodeCellOutput";
import { CodeBlock } from "./CodeBlock";
import { MDXContent } from "./MDXContent";
import { mdxComponents } from "./mdxComponents";

/**
 * Copy button with success feedback.
 */
function CopyButton({ text, size = "1" }: { text: string; size?: "1" | "2" }) {
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
        size={size}
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

interface MessageBubbleProps {
  message: ChannelMessage;
  kernel: KernelManager | null;
  showCopy?: boolean;
}

/**
 * Render message content based on type.
 */
function MessageContent({
  message,
  kernel,
}: {
  message: ChannelMessage;
  kernel: KernelManager | null;
}) {
  const content = message.content;

  switch (content.type) {
    case "text":
      return (
        <Box>
          <MDXContent content={content.text} components={mdxComponents} />
          {content.reasoning && (
            <Box mt="2" style={{ opacity: 0.7, fontSize: "0.9em" }}>
              <Text size="1" color="gray">
                Reasoning:
              </Text>
              <Box style={{ fontSize: "0.9em" }}>
                <MDXContent content={content.reasoning} components={mdxComponents} />
              </Box>
            </Box>
          )}
        </Box>
      );

    case "code":
      return (
        <Box>
          <Flex justify="between" align="center" mb="1">
            <Text size="1" color="gray">
              {content.language}
            </Text>
            <Flex align="center" gap="2">
              <Text size="1" color="gray">
                {content.source === "user" ? "User" : "Agent"}
              </Text>
              <CopyButton text={content.code} />
            </Flex>
          </Flex>
          <CodeBlock code={content.code} language={content.language} />
        </Box>
      );

    case "code_result":
      return (
        <CodeCellOutput
          result={content}
          kernel={kernel}
          defaultCollapsed={false}
        />
      );

    case "tool_call":
      // Use MDXToolResult for render_mdx tool calls
      if (isRenderMDXResult(content, null)) {
        return <MDXToolResult call={content} result={null} />;
      }
      return (
        <ToolCallRecord
          call={content}
          result={null}
          defaultCollapsed={true}
        />
      );

    case "tool_result":
      // Use MDXToolResult for render_mdx tool results
      if (isRenderMDXResult(null, content)) {
        return <MDXToolResult call={null} result={content} />;
      }
      return (
        <ToolCallRecord
          call={null}
          result={content}
          defaultCollapsed={true}
        />
      );

    case "file_upload":
      return (
        <Box>
          <Text size="1" color="gray">
            Uploaded files:
          </Text>
          {content.files.map((file, i) => (
            <Text key={i} size="2">
              {file.name} ({(file.size / 1024).toFixed(1)} KB)
            </Text>
          ))}
        </Box>
      );

    case "system":
      return (
        <Text
          size="2"
          color={
            content.level === "error"
              ? "red"
              : content.level === "warning"
                ? "orange"
                : "gray"
          }
        >
          {content.message}
        </Text>
      );

    case "react_mount":
      // React mount is handled as part of code_result
      return null;

    default:
      return <Text size="2">Unknown message type</Text>;
  }
}

/**
 * Get participant label.
 */
function getParticipantLabel(type: string): string {
  switch (type) {
    case "user":
      return "You";
    case "agent":
      return "Assistant";
    case "kernel":
      return "Kernel";
    case "system":
      return "System";
    default:
      return type;
  }
}

/**
 * Get background color for message.
 */
function getMessageBackground(type: string): string {
  switch (type) {
    case "user":
      return "var(--blue-a2)";
    case "agent":
      return "var(--gray-a2)";
    case "kernel":
      return "var(--orange-a2)";
    case "system":
      return "var(--gray-a1)";
    default:
      return "var(--gray-a2)";
  }
}

/**
 * MessageBubble - Individual message display.
 */
export function MessageBubble({ message, kernel }: MessageBubbleProps) {
  const isUser = message.participantType === "user";
  const isSystem = message.participantType === "system";

  // System messages are displayed differently
  if (isSystem) {
    return (
      <Box my="2" style={{ textAlign: "center" }}>
        <Text size="1" color="gray">
          <MessageContent message={message} kernel={kernel} />
        </Text>
      </Box>
    );
  }

  // Tool calls and results are shown inline/subtle
  if (
    message.content.type === "tool_call" ||
    message.content.type === "tool_result"
  ) {
    return (
      <Box my="1" ml={isUser ? "0" : "8"}>
        <MessageContent message={message} kernel={kernel} />
      </Box>
    );
  }

  return (
    <Flex
      direction="column"
      align={isUser ? "end" : "start"}
      my="2"
    >
      <Flex align="center" gap="2" mb="1">
        <Text size="1" color="gray">
          {getParticipantLabel(message.participantType)}
          {message.isStreaming && " (streaming...)"}
        </Text>
        {(message.content.type === "text" || message.content.type === "code") && (
          <CopyButton
            text={
              message.content.type === "text"
                ? message.content.text
                : message.content.code
            }
            size="1"
          />
        )}
      </Flex>
      <Card
        style={{
          width: "100%",
          background: getMessageBackground(message.participantType),
        }}
      >
        <MessageContent message={message} kernel={kernel} />
      </Card>
    </Flex>
  );
}
