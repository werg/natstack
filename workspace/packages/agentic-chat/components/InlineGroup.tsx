import React, { useCallback, useState } from "react";
import { Box, Flex } from "@radix-ui/themes";
import type { CustomMessageCardPayload, InvocationCardPayload } from "@workspace/agentic-core";
import type { ChatSandboxValue } from "@workspace/agentic-core";
import { ThinkingPill, ExpandedThinking } from "./ThinkingMessage";
import { ActionPill, ExpandedAction } from "./ActionMessage";
import { TypingPill } from "./TypingMessage";
import { CustomPill, ExpandedCustom } from "./CustomMessage";
import type { MessageTypeComponentEntry, TypingIndicatorData } from "../types";

const PREVIEW_MAX_LENGTH = 50;

export type InlineItem =
  | { type: "thinking"; id: string; content: string; complete: boolean }
  | { type: "invocation"; id: string; invocation: InvocationCardPayload; complete: boolean; senderId: string }
  | { type: "custom"; id: string; payload: CustomMessageCardPayload }
  | { type: "typing"; id: string; data: TypingIndicatorData; senderId: string };

interface InlineGroupProps {
  items: InlineItem[];
  messageTypeComponents?: Map<string, MessageTypeComponentEntry>;
  chat?: Record<string, unknown> & Partial<Pick<ChatSandboxValue, "rpc">>;
  /** Callback to interrupt an agent (used for typing indicators). */
  onInterrupt?: (senderId: string) => void;
  /** Callback to cancel one pending tool/invocation dispatch. */
  onCancelInvocation?: (transportCallId: string) => void;
}

/** Typing items are ephemeral and never expand. */
function isExpandable(item: InlineItem): boolean {
  return item.type !== "typing";
}

/**
 * Ordered layout of an inline group: runs of collapsed pills are packed into
 * wrapping rows, and each expanded item is hoisted into its own full-width
 * block at the position it occupies. Expanding a pill therefore splits its row
 * of siblings — the pills before it stay above, the pills after it flow below
 * — instead of dumping every expanded detail beneath the whole group.
 */
type Segment =
  | { kind: "pills"; key: string; items: InlineItem[] }
  | { kind: "expanded"; key: string; item: InlineItem };

function buildSegments(items: InlineItem[], expandedIds: ReadonlySet<string>): Segment[] {
  const segments: Segment[] = [];
  let pillRun: InlineItem[] = [];
  const flush = () => {
    if (pillRun.length === 0) return;
    segments.push({ kind: "pills", key: `pills-${pillRun[0]!.id}`, items: pillRun });
    pillRun = [];
  };
  for (const item of items) {
    if (isExpandable(item) && expandedIds.has(item.id)) {
      flush();
      segments.push({ kind: "expanded", key: `expanded-${item.id}`, item });
    } else {
      pillRun.push(item);
    }
  }
  flush();
  return segments;
}

/**
 * InlineGroup renders a collection of thinking, action, and typing items as
 * compact pills in wrapping rows. Any number of items can be expanded at once,
 * and each expands in place rather than below its siblings. Typing indicators
 * are ephemeral and don't expand — they only show an interrupt button.
 */
export const InlineGroup = React.memo(function InlineGroup({
  items,
  messageTypeComponents,
  chat = {},
  onInterrupt,
  onCancelInvocation,
}: InlineGroupProps) {
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (items.length === 0) return null;

  const segments = buildSegments(items, expandedIds);

  const renderPill = (item: InlineItem) => {
    switch (item.type) {
      case "thinking": {
        const normalizedContent = item.content.replace(/\n/g, " ").trim();
        const isTruncated = normalizedContent.length > PREVIEW_MAX_LENGTH;
        const preview = normalizedContent.slice(0, PREVIEW_MAX_LENGTH);
        return (
          <ThinkingPill
            key={item.id}
            id={item.id}
            preview={preview}
            isTruncated={isTruncated}
            isStreaming={!item.complete}
            onExpand={toggle}
          />
        );
      }
      case "invocation":
        return (
          <ActionPill
            key={item.id}
            id={item.id}
            payload={item.invocation}
            onExpand={toggle}
            onCancel={item.invocation.transportCallId && onCancelInvocation
              ? () => onCancelInvocation(item.invocation.transportCallId!)
              : undefined}
          />
        );
      case "custom":
        return (
          <CustomPill
            key={item.id}
            id={item.id}
            payload={item.payload}
            entry={messageTypeComponents?.get(item.payload.typeId)}
            expanded={false}
            chat={chat}
            onExpand={toggle}
          />
        );
      case "typing":
        // Typing indicators don't expand - they just show the pill with interrupt
        return (
          <TypingPill
            key={item.id}
            data={item.data}
            onInterrupt={onInterrupt ? () => onInterrupt(item.senderId) : undefined}
          />
        );
    }
  };

  const renderExpanded = (item: InlineItem) => {
    const collapse = () => toggle(item.id);
    switch (item.type) {
      case "thinking":
        return (
          <ExpandedThinking
            content={item.content}
            isStreaming={!item.complete}
            onCollapse={collapse}
          />
        );
      case "invocation":
        return (
          <ExpandedAction
            payload={item.invocation}
            chat={chat}
            onCollapse={collapse}
            onCancel={item.invocation.transportCallId && onCancelInvocation
              ? () => onCancelInvocation(item.invocation.transportCallId!)
              : undefined}
          />
        );
      case "custom":
        return (
          <ExpandedCustom
            payload={item.payload}
            entry={messageTypeComponents?.get(item.payload.typeId)}
            expanded={true}
            chat={chat}
            onCollapse={collapse}
          />
        );
      case "typing":
        return null;
    }
  };

  return (
    <Box className="inline-group">
      <Flex className="inline-group-body" direction="column" gap="1">
        {segments.map((segment) => {
          if (segment.kind === "pills") {
            return (
              <Flex
                key={segment.key}
                className="inline-pill-row"
                gap="1"
                wrap="wrap"
                align="center"
              >
                {segment.items.map(renderPill)}
              </Flex>
            );
          }
          return (
            <Box key={segment.key} className="inline-expanded-item">
              {renderExpanded(segment.item)}
            </Box>
          );
        })}
      </Flex>
    </Box>
  );
});
