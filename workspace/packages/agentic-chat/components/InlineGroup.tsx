import React, { useCallback, useState } from "react";
import { Box, Flex } from "@radix-ui/themes";
import type { InvocationCardPayload } from "@workspace/agentic-core";
import { ThinkingPill, ExpandedThinking } from "./ThinkingMessage";
import { ActionPill, ExpandedAction } from "./ActionMessage";
import { TypingPill } from "./TypingMessage";
import type { TypingIndicatorData } from "../types";

const PREVIEW_MAX_LENGTH = 50;

export type InlineItem =
  | { type: "thinking"; id: string; content: string; complete: boolean }
  | { type: "invocation"; id: string; invocation: InvocationCardPayload; complete: boolean }
  | { type: "typing"; id: string; data: TypingIndicatorData; senderId: string };

interface InlineGroupProps {
  items: InlineItem[];
  /** Callback to interrupt an agent (used for typing indicators) */
  onInterrupt?: (senderId: string) => void;
}

/**
 * InlineGroup renders a collection of thinking, action, and typing items
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
        if (item.type === "typing") return false;
        return item.id === expandedId;
      })
    : null;

  return (
    <Box className="inline-group">
      <Flex className="inline-group-body" direction="column" gap="1">
        {/* Compact pills row */}
        <Flex className="inline-pill-row" gap="1" wrap="wrap" align="center">
          {items.map((item) => {
            const itemId = item.id;
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
              case "invocation":
                return (
                  <ActionPill
                    key={itemId}
                    id={itemId}
                    payload={item.invocation}
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
            {expandedItem.type === "invocation" && (
              <ExpandedAction
                payload={expandedItem.invocation}
                onCollapse={handleCollapse}
              />
            )}
          </>
        )}
      </Flex>
    </Box>
  );
});
