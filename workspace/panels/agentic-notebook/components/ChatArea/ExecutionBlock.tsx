import { Card, Flex, Text, Box, Badge } from "@radix-ui/themes";
import type { ChannelMessage } from "../../types/messages";
import { CodeBlock } from "./CodeBlock";
import { CodeCellOutput } from "./CodeCellOutput";
import { ToolCallRecord } from "./ToolCallRecord";

interface ExecutionBlockProps {
  codeMessage: ChannelMessage;
  codeResult?: ChannelMessage | null;
  toolCall?: ChannelMessage | null;
  toolResult?: ChannelMessage | null;
}

/**
 * Unified view for an execution: tool metadata + code + kernel output.
 */
export function ExecutionBlock({
  codeMessage,
  codeResult,
  toolCall,
  toolResult,
}: ExecutionBlockProps) {
  const codeContent = codeMessage.content.type === "code" ? codeMessage.content : null;
  const codeResultContent = codeResult?.content.type === "code_result" ? codeResult.content : null;
  const toolCallContent = toolCall?.content.type === "tool_call" ? toolCall.content : null;
  const toolResultContent = toolResult?.content.type === "tool_result" ? toolResult.content : null;

  return (
    <Card
      variant="surface"
      style={{
        background: "var(--gray-2)",
        border: "1px solid var(--gray-6)",
        padding: "12px",
        gap: "8px",
      }}
    >
      <Flex align="center" justify="between" mb="2">
        <Flex align="center" gap="2">
          <Badge size="1" color={codeMessage.participantType === "user" ? "blue" : "gray"}>
            {codeContent?.language ?? "code"}
          </Badge>
          <Text size="1" color="gray">
            {codeContent?.source === "agent" ? "Agent" : "User"}
          </Text>
        </Flex>
        {toolCallContent && (
          <Text size="1" color="gray">
            via {toolCallContent.toolName}
          </Text>
        )}
      </Flex>

      {toolCallContent && (
        <Box mb="2">
          <ToolCallRecord
            call={toolCallContent}
            result={toolResultContent ?? null}
            defaultCollapsed
          />
        </Box>
      )}

      {codeContent && (
        <Box mb={codeResultContent ? "3" : "0"}>
          <CodeBlock code={codeContent.code} language={codeContent.language} />
        </Box>
      )}

      {codeResultContent && (
        <CodeCellOutput result={codeResultContent} defaultCollapsed={false} />
      )}
    </Card>
  );
}
