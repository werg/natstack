import { useMemo } from "react";
import { Box } from "@radix-ui/themes";
import { Virtuoso } from "react-virtuoso";
import { useChannelMessages } from "../../hooks/useChannel";
import { MessageBubble } from "./MessageBubble";
import type { ChannelMessage, ToolCallContent, ToolResultContent } from "../../types/messages";
import { ToolResultDisplay } from "./ToolResultDisplay";

/**
 * Represents a displayable item - either a standalone message or a tool call with its result.
 */
type DisplayItem =
  | { type: "message"; message: ChannelMessage }
  | { type: "tool_pair"; toolCall: ChannelMessage; toolResult?: ChannelMessage };

/**
 * ChatArea - Scrollable message list.
 */
export function ChatArea() {
  const { messages } = useChannelMessages();

  const displayItems: DisplayItem[] = useMemo(() => {
    const items: DisplayItem[] = [];

    // Build a map of toolCallId -> tool_result message
    const toolResultByCallId = new Map<string, ChannelMessage>();
    for (const msg of messages) {
      if (msg.content.type === "tool_result") {
        toolResultByCallId.set(msg.content.toolCallId, msg);
      }
    }

    // Track which tool_results have been paired
    const pairedResultIds = new Set<string>();

    for (const msg of messages) {
      if (msg.content.type === "tool_call") {
        // Find matching tool_result
        const toolResult = toolResultByCallId.get(msg.content.toolCallId);
        if (toolResult) {
          pairedResultIds.add(toolResult.id);
        }
        items.push({ type: "tool_pair", toolCall: msg, toolResult });
      } else if (msg.content.type === "tool_result") {
        // Only add unpaired tool_results
        if (!pairedResultIds.has(msg.id)) {
          items.push({ type: "message", message: msg });
        }
      } else {
        // Regular messages (text, file_upload, system)
        items.push({ type: "message", message: msg });
      }
    }

    return items;
  }, [messages]);

  return (
    <Box
      style={{
        flex: 1,
        position: "relative",
        height: "100%",
        display: "flex",
        minHeight: 0,
      }}
    >
      <Virtuoso
        data={displayItems}
        followOutput="smooth"
        style={{ height: "100%", width: "100%" }}
        itemContent={(_index: number, item: DisplayItem) => (
          <Box px="4" py="2">
            {item.type === "message" ? (
              <MessageBubble message={item.message} />
            ) : (
              <ToolPairDisplay toolCall={item.toolCall} toolResult={item.toolResult} />
            )}
          </Box>
        )}
        components={{
          EmptyPlaceholder: () => (
            <Box
              style={{
                textAlign: "center",
                color: "var(--gray-9)",
                paddingTop: "40px",
              }}
            >
              Start a conversation or execute code
            </Box>
          ),
        }}
        computeItemKey={(_index: number, item: DisplayItem) =>
          item.type === "message" ? item.message.id : item.toolCall.id
        }
      />
    </Box>
  );
}

/**
 * Display a tool call with its result.
 */
function ToolPairDisplay({
  toolCall,
  toolResult,
}: {
  toolCall: ChannelMessage;
  toolResult?: ChannelMessage;
}) {
  const callContent = toolCall.content as ToolCallContent;
  const resultContent = toolResult?.content.type === "tool_result"
    ? (toolResult.content as ToolResultContent)
    : null;

  // For tools with prominent output (render_mdx, execute_code), collapse details by default
  // This keeps focus on the output while allowing users to expand for source/details
  const hasProminentOutput = !!(resultContent && !resultContent.isError && (
    callContent.toolName === "render_mdx" ||
    callContent.toolName === "execute_code"
  ));

  return (
    <ToolResultDisplay
      call={callContent}
      result={resultContent}
      defaultCollapsed={hasProminentOutput}
    />
  );
}

export { MessageBubble } from "./MessageBubble";
export { ToolResultDisplay } from "./ToolResultDisplay";
export { CodeExecutionOutput } from "./CodeExecutionOutput";
export { MDXRenderedOutput } from "./MDXRenderedOutput";
