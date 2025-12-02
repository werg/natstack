import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { Box } from "@radix-ui/themes";
import { Virtuoso } from "react-virtuoso";
import { useMessages } from "../../hooks/useChannel";
import { kernelAtom } from "../../state/kernelAtoms";
import { MessageBubble } from "./MessageBubble";
import type { ChannelMessage } from "../../types/messages";
import { ToolCallRecord } from "./ToolCallRecord";
import { MDXToolResult, isRenderMDXResult } from "./MDXToolResult";
import { CodeCellOutput } from "./CodeCellOutput";

type GroupedItem = {
  root: ChannelMessage;
  children: ChannelMessage[];
};

/**
 * ChatArea - Scrollable message list.
 */
export function ChatArea() {
  const messages = useMessages();
  const kernel = useAtomValue(kernelAtom);

  const displayItems: GroupedItem[] = useMemo(() => {
    const idToMessage = new Map<string, ChannelMessage>();
    messages.forEach((m) => idToMessage.set(m.id, m));

    const findRoot = (msg: ChannelMessage): ChannelMessage => {
      let current: ChannelMessage = msg;
      const visited = new Set<string>();
      while (current.responseTo && idToMessage.has(current.responseTo) && !visited.has(current.responseTo)) {
        visited.add(current.responseTo);
        current = idToMessage.get(current.responseTo)!;
      }
      return current;
    };

    const groupMap = new Map<string, GroupedItem>();
    const order: string[] = [];

    for (const msg of messages) {
      const root = msg.responseTo ? findRoot(msg) : msg;
      const rootId = root.id;
      if (!groupMap.has(rootId)) {
        groupMap.set(rootId, { root, children: [] });
        order.push(rootId);
      }
      if (msg.id !== rootId) {
        groupMap.get(rootId)!.children.push(msg);
      }
    }

    return order.map((id) => groupMap.get(id)!).filter(Boolean);
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
        itemContent={(_index, item) => (
          <Box px="4" py="3">
            <Box
              style={{
                border: "1px solid var(--gray-a6)",
                borderRadius: "var(--radius-3)",
                background: "var(--gray-2)",
                padding: "12px",
              }}
            >
              <MessageBubble message={item.root} kernel={kernel} />
              {(() => {
                // Combine tool call + result pairs within this group
                const children = [...item.children];
                const toolCalls = children.filter((c) => c.content.type === "tool_call");
                const used = new Set<string>();
                const remaining = children.filter((c) => c.content.type !== "tool_call");

                const pairedToolComponents = toolCalls.map((call) => {
                  const result = remaining.find(
                    (c) =>
                      c.content.type === "tool_result" &&
                      c.content.toolCallId === call.content.toolCallId
                  );
                  if (result) used.add(result.id);
                  // Attach any code_result that responds to this tool_call (via responseTo chain)
                  const codeResults = remaining.filter(
                    (c) =>
                      c.content.type === "code_result" &&
                      c.responseTo === call.id
                  );
                  const toolResult = result?.content.type === "tool_result" ? result.content : null;

                  // Use MDXToolResult for render_mdx tool calls
                  const isMDX = isRenderMDXResult(call.content, toolResult);

                  return (
                    <Box key={call.id} mt="2">
                      {isMDX ? (
                        <MDXToolResult call={call.content} result={toolResult} />
                      ) : (
                        <ToolCallRecord
                          call={call.content}
                          result={toolResult}
                          defaultCollapsed
                        />
                      )}
                      {codeResults.map((cr) => (
                        <Box key={cr.id} mt="2">
                          <CodeCellOutput
                            result={cr.content}
                            kernel={kernel}
                            defaultCollapsed
                          />
                        </Box>
                      ))}
                    </Box>
                  );
                });

                const otherChildren = remaining.filter((c) => !used.has(c.id));

                return (
                  <>
                    {pairedToolComponents}
                    {otherChildren.map((child) => {
                      if (child.content.type === "tool_result") {
                        // Use MDXToolResult for render_mdx tool results
                        if (isRenderMDXResult(null, child.content)) {
                          return (
                            <Box key={child.id} mt="2">
                              <MDXToolResult call={null} result={child.content} />
                            </Box>
                          );
                        }
                        return (
                          <Box key={child.id} mt="2">
                            <ToolCallRecord
                              call={null}
                              result={child.content}
                              defaultCollapsed
                            />
                          </Box>
                        );
                      }
                      if (child.content.type === "code_result") {
                        return (
                          <Box key={child.id} mt="2">
                            <CodeCellOutput result={child.content} kernel={kernel} defaultCollapsed />
                          </Box>
                        );
                      }
                      if (child.content.type === "code" || child.content.type === "text") {
                        return (
                          <Box key={child.id} mt="2">
                            <MessageBubble message={child} kernel={kernel} />
                          </Box>
                        );
                      }
                      return null;
                    })}
                  </>
                );
              })()}
            </Box>
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
        computeItemKey={(_index, item) => item.root.id}
      />
    </Box>
  );
}

export { MessageBubble } from "./MessageBubble";
export { ToolCallRecord } from "./ToolCallRecord";
export { CodeCellOutput } from "./CodeCellOutput";
