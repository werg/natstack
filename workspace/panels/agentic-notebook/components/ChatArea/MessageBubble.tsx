import { Box, Card, Flex, Text } from "@radix-ui/themes";
import type { ChannelMessage } from "../../types/messages";
import { ToolResultDisplay } from "./ToolResultDisplay";
import { MDXContent } from "./MDXContent";
import { mdxComponents } from "./mdxComponents";
import { CopyButton } from "../shared/CopyButton";

interface MessageBubbleProps {
  message: ChannelMessage;
  showCopy?: boolean;
}

/**
 * Render message content based on type.
 */
function MessageContent({ message }: { message: ChannelMessage }) {
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

    case "tool_call":
      return <ToolResultDisplay call={content} />;

    case "tool_result":
      return <ToolResultDisplay result={content} />;

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
    case "system":
      return "var(--gray-a1)";
    default:
      return "var(--gray-a2)";
  }
}

/**
 * MessageBubble - Individual message display.
 */
export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.participantType === "user";
  const isSystem = message.participantType === "system";

  // System messages are displayed differently
  if (isSystem) {
    return (
      <Box my="2" style={{ textAlign: "center" }}>
        <Text size="1" color="gray">
          <MessageContent message={message} />
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
        <MessageContent message={message} />
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
        {message.content.type === "text" && (
          <CopyButton
            text={message.content.text}
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
        <MessageContent message={message} />
      </Card>
    </Flex>
  );
}
