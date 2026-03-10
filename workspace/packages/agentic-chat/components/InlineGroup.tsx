import React, { useCallback, useState } from "react";
import { Box, Flex } from "@radix-ui/themes";
import type { ActionData, TypingData } from "@natstack/agentic-messaging";
import type { MethodHistoryEntry } from "./MethodHistoryItem";
import { CompactMethodPill, ExpandedMethodDetail } from "./MethodHistoryItem";
import { ThinkingPill, ExpandedThinking } from "./ThinkingMessage";
import { ActionPill, ExpandedAction } from "./ActionMessage";
import { TypingPill } from "./TypingMessage";

const PREVIEW_MAX_LENGTH = 50;

export type InlineItem =
  | { type: "thinking"; id: string; content: string; complete: boolean }
  | { type: "action"; id: string; data: ActionData; complete: boolean }
  | { type: "method"; entry: MethodHistoryEntry }
  | { type: "typing"; id: string; data: TypingData; senderId: string };

interface InlineGroupProps {
  items: InlineItem[];
  /** Callback to interrupt an agent (used for typing indicators) */
  onInterrupt?: (senderId: string) => void;
}

/**
 * InlineGroup renders a collection of thinking, action, method, and typing items
 * as compact pills in a wrapping flex row. Only one item can be expanded at a time.
 * Typing indicators are ephemeral and don't expand - they just show interrupt button.
 */
export const InlineGroup = React.memo(function InlineGroup({ items, onInterrupt }: InlineGroupProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const handleExpand = useCallback((id: string) => setExpandedId(id), []);
  const handleCollapse = useCallback(() => setExpandedId(null), []);

  if (items.length === 0) return null;

  // Find expanded item (typing items don't expand)
  const expandedItem = expandedId
    ? items.find((item) => {
        if (item.type === "method") return item.entry.callId === expandedId;
        if (item.type === "typing") return false; // Typing items don't expand
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
                    id={itemId}
                    preview={preview}
                    isTruncated={isTruncated}
                    isStreaming={!item.complete}
                    onExpand={handleExpand}
                  />
                );
              }
              case "action":
                return (
                  <ActionPill
                    key={itemId}
                    id={itemId}
                    data={item.data}
                    onExpand={handleExpand}
                  />
                );
              case "method":
                return (
                  <CompactMethodPill
                    key={itemId}
                    id={itemId}
                    entry={item.entry}
                    onExpand={handleExpand}
                  />
                );
              case "typing":
                // Typing indicators don't expand - they just show the pill with interrupt
                return (
                  <TypingPill
                    key={itemId}
                    data={item.data}
                    onInterrupt={onInterrupt ? () => onInterrupt(item.senderId) : undefined}
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
                onCollapse={handleCollapse}
              />
            )}
            {expandedItem.type === "action" && (
              <ExpandedAction
                data={expandedItem.data}
                onCollapse={handleCollapse}
              />
            )}
            {expandedItem.type === "method" && (
              <ExpandedMethodDetail
                entry={expandedItem.entry}
                onCollapse={handleCollapse}
              />
            )}
          </>
        )}
      </Flex>
    </Box>
  );
});
