import { useState } from "react";
import { Box, Flex } from "@radix-ui/themes";
import type { ActionData } from "@natstack/agentic-messaging";
import type { MethodHistoryEntry } from "./MethodHistoryItem";
import { CompactMethodPill, ExpandedMethodDetail } from "./MethodHistoryItem";
import { ThinkingPill, ExpandedThinking } from "./ThinkingMessage";
import { ActionPill, ExpandedAction } from "./ActionMessage";

const PREVIEW_MAX_LENGTH = 50;

export type InlineItem =
  | { type: "thinking"; id: string; content: string; complete: boolean }
  | { type: "action"; id: string; data: ActionData; complete: boolean }
  | { type: "method"; entry: MethodHistoryEntry };

interface InlineGroupProps {
  items: InlineItem[];
}

/**
 * InlineGroup renders a collection of thinking, action, and method items
 * as compact pills in a wrapping flex row. Only one item can be expanded at a time.
 */
export function InlineGroup({ items }: InlineGroupProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (items.length === 0) return null;

  // Find expanded item
  const expandedItem = expandedId
    ? items.find((item) => {
        if (item.type === "method") return item.entry.callId === expandedId;
        return item.id === expandedId;
      })
    : null;

  return (
    <Box style={{ maxWidth: "96%", alignSelf: "flex-start" }}>
      <Flex direction="column" gap="1">
        {/* Compact pills row */}
        <Flex gap="1" wrap="wrap" align="center">
          {items.map((item) => {
            const itemId = item.type === "method" ? item.entry.callId : item.id;
            if (expandedId === itemId) return null;

            switch (item.type) {
              case "thinking": {
                const normalizedContent = item.content.replace(/\n/g, " ").trim();
                const isTruncated = normalizedContent.length > PREVIEW_MAX_LENGTH;
                const preview = normalizedContent.slice(0, PREVIEW_MAX_LENGTH);
                return (
                  <ThinkingPill
                    key={itemId}
                    preview={preview}
                    isTruncated={isTruncated}
                    isStreaming={!item.complete}
                    onClick={() => setExpandedId(itemId)}
                  />
                );
              }
              case "action":
                return (
                  <ActionPill
                    key={itemId}
                    data={item.data}
                    onClick={() => setExpandedId(itemId)}
                  />
                );
              case "method":
                return (
                  <CompactMethodPill
                    key={itemId}
                    entry={item.entry}
                    onClick={() => setExpandedId(itemId)}
                  />
                );
            }
          })}
        </Flex>

        {/* Expanded detail (if any) */}
        {expandedItem && (
          <>
            {expandedItem.type === "thinking" && (
              <ExpandedThinking
                content={expandedItem.content}
                onCollapse={() => setExpandedId(null)}
              />
            )}
            {expandedItem.type === "action" && (
              <ExpandedAction
                data={expandedItem.data}
                onCollapse={() => setExpandedId(null)}
              />
            )}
            {expandedItem.type === "method" && (
              <ExpandedMethodDetail
                entry={expandedItem.entry}
                onCollapse={() => setExpandedId(null)}
              />
            )}
          </>
        )}
      </Flex>
    </Box>
  );
}
