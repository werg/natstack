import React, { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from "react";
import { Box, Button, Card, Flex, ScrollArea, Text } from "@radix-ui/themes";
import type { Participant } from "@natstack/pubsub";
import { useStickToBottom } from "use-stick-to-bottom";
import { InlineGroup, type InlineItem } from "./InlineGroup";
import { parseActionData } from "./ActionMessage";
import { parseTypingData } from "./TypingMessage";
import { NewContentIndicator } from "./NewContentIndicator";
import { MessageCard } from "./MessageCard";
import type { ChatMessage, ChatParticipantMetadata, InlineUiComponentEntry } from "../types";

// Grouped item types produced by the grouping logic
type GroupedItem =
  | { type: "inline-group"; items: Array<{ msg: ChatMessage; index: number }>; inlineItems: InlineItem[]; key: string }
  | { type: "message"; msg: ChatMessage; index: number };

// --- Grouping helper functions (module-level for reuse by fast paths) ---

type InlineItemType = "thinking" | "action";

function getInlineItemType(msg: ChatMessage): InlineItemType | null {
  if (msg.contentType === "thinking") return "thinking";
  if (msg.contentType === "action") return "action";
  return null;
}

/** Transform an inline group's messages into InlineItem[] */
function buildInlineItems(
  items: Array<{ msg: ChatMessage; index: number }>,
): InlineItem[] {
  return items.map(({ msg }) => {
    if (msg.contentType === "action") {
      const data = parseActionData(msg.content, msg.complete);
      return {
        type: "action" as const,
        id: msg.id,
        data,
        complete: msg.complete ?? false,
      };
    }
    return {
      type: "thinking" as const,
      id: msg.id,
      content: msg.content,
      complete: msg.complete ?? false,
    };
  });
}

/** Full grouping computation — scans all messages from scratch */
function fullGroupComputation(
  messages: ChatMessage[],
): GroupedItem[] {
  const result: GroupedItem[] = [];
  let currentInlineGroup: Array<{ msg: ChatMessage; index: number }> = [];

  messages.forEach((msg, index) => {
    // Typing is rendered as bottom-of-chat busy state, not transcript history.
    if (msg.contentType === "typing") return;

    const inlineType = getInlineItemType(msg);

    if (inlineType !== null) {
      currentInlineGroup.push({ msg, index });
    } else {
      if (currentInlineGroup.length > 0) {
        result.push({
          type: "inline-group",
          items: currentInlineGroup,
          inlineItems: buildInlineItems(currentInlineGroup),
          key: `inline-group-${currentInlineGroup[0]!.msg.id || currentInlineGroup[0]!.index}`,
        });
        currentInlineGroup = [];
      }
      result.push({ type: "message", msg, index });
    }
  });

  if (currentInlineGroup.length > 0) {
    result.push({
      type: "inline-group",
      items: currentInlineGroup,
      inlineItems: buildInlineItems(currentInlineGroup),
      key: `inline-group-${currentInlineGroup[0]!.msg.id || currentInlineGroup[0]!.index}`,
    });
  }

  return result;
}

function buildActiveTypingItems(messages: ChatMessage[]): InlineItem[] {
  const latestTypingBySender = new Map<string, { msg: ChatMessage; index: number }>();

  messages.forEach((msg, index) => {
    if (msg.contentType !== "typing" || msg.complete) return;
    latestTypingBySender.set(msg.senderId, { msg, index });
  });

  // Filter out stale typing indicators: if there is a later *text* message
  // from the SAME sender, the agent has already produced output and the
  // typing indicator is orphaned (e.g., from a crash or hibernation where
  // the complete event was lost).  Only plain text (no contentType) counts
  // as output — action, thinking, inline_ui, and image messages coexist
  // with active typing during tool execution.
  for (const [senderId, { index: typingIndex }] of latestTypingBySender) {
    const hasLaterTextOutput = messages.some(
      (m, i) => i > typingIndex && m.senderId === senderId && !m.contentType,
    );
    if (hasLaterTextOutput) {
      latestTypingBySender.delete(senderId);
    }
  }

  return Array.from(latestTypingBySender.values())
    .sort((a, b) => a.index - b.index)
    .map(({ msg }) => ({
      type: "typing" as const,
      id: msg.id,
      data: parseTypingData(msg.content),
      senderId: msg.senderId,
    }));
}

/** Sender info returned by getSenderInfo */
export interface SenderInfo {
  name: string;
  type: "panel" | "headless" | "agent" | "unknown";
  handle: string;
}

export interface MessageListProps {
  messages: ChatMessage[];
  allParticipants: Record<string, Participant<ChatParticipantMetadata>>;
  inlineUiComponents?: Map<string, InlineUiComponentEntry>;
  hasMoreHistory?: boolean;
  loadingMore?: boolean;
  onLoadEarlierMessages?: () => void;
  onInterrupt?: (agentId: string, messageId?: string, agentHandle?: string) => void;
  onFocusPanel?: (panelId: string) => void;
  onReloadPanel?: (panelId: string) => void;
  /** Override default message card rendering */
  renderMessage?: (msg: ChatMessage, senderInfo: SenderInfo) => React.ReactNode;
  /** Override default inline group rendering */
  renderInlineGroup?: (items: InlineItem[]) => React.ReactNode;
}

/**
 * MessageList — the core message rendering area, wrapped in React.memo.
 *
 * This component owns:
 * - Scroll tracking and auto-scroll logic
 * - Message grouping (groupedItems useMemo)
 * - The rendering loop over grouped items
 * - Copy-to-clipboard state (copiedMessageId)
 * - "New content" indicator
 *
 * Critically, it does NOT receive `input` as a prop, so keystroke-driven
 * re-renders in the parent stop at this memo boundary.
 */
export const MessageList = React.memo(function MessageList({
  messages,
  allParticipants,
  inlineUiComponents,
  hasMoreHistory,
  loadingMore,
  onLoadEarlierMessages,
  onInterrupt,
  onFocusPanel,
  onReloadPanel,
  renderMessage: customRenderMessage,
  renderInlineGroup: customRenderInlineGroup,
}: MessageListProps) {
  // --- Scroll state ---
  const [showNewContent, setShowNewContent] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const {
    scrollRef,
    contentRef,
    scrollToBottom,
    isAtBottom,
  } = useStickToBottom({
    initial: "instant",
    resize: "instant",
  });

  // Refs for message window tracking
  const lastMessageCountRef = useRef(0);
  const lastFirstMessageIdRef = useRef<string | null>(null);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);

  // Refs for auto-load on scroll to top (keeps handleScroll stable)
  const hasMoreHistoryRef = useRef(hasMoreHistory);
  const loadingMoreRef = useRef(loadingMore);
  const onLoadEarlierMessagesRef = useRef(onLoadEarlierMessages);
  hasMoreHistoryRef.current = hasMoreHistory;
  loadingMoreRef.current = loadingMore;
  onLoadEarlierMessagesRef.current = onLoadEarlierMessages;

  const handleViewportScroll = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    lastScrollTopRef.current = viewport.scrollTop;
    lastScrollHeightRef.current = viewport.scrollHeight;
    if (viewport.scrollTop < 200 && hasMoreHistoryRef.current && !loadingMoreRef.current) {
      onLoadEarlierMessagesRef.current?.();
    }
  }, [scrollRef]);

  // Attach scroll listener
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) {
      return;
    }

    viewport.addEventListener("scroll", handleViewportScroll, { passive: true });
    handleViewportScroll();
    return () => viewport.removeEventListener("scroll", handleViewportScroll);
  }, [handleViewportScroll, scrollRef]);

  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const prevCount = lastMessageCountRef.current;
    const nextCount = messages.length;
    const prevFirstId = lastFirstMessageIdRef.current;
    const nextFirstId = messages[0]?.id ?? null;
    const countDelta = nextCount - prevCount;
    const isPrepend =
      countDelta > 0 && prevFirstId !== null && nextFirstId !== prevFirstId;

    if (viewport && prevCount > 0 && !isAtBottom && isPrepend) {
      const scrollHeightDelta = viewport.scrollHeight - lastScrollHeightRef.current;
      if (scrollHeightDelta !== 0) {
        viewport.scrollTop = lastScrollTopRef.current + scrollHeightDelta;
      }
    }

    if (prevCount > 0) {
      if (isAtBottom) {
        setShowNewContent(false);
      } else if (countDelta > 0 && !isPrepend) {
        setShowNewContent(true);
      }
    }

    if (viewport) {
      lastScrollTopRef.current = viewport.scrollTop;
      lastScrollHeightRef.current = viewport.scrollHeight;
    }
    lastMessageCountRef.current = nextCount;
    lastFirstMessageIdRef.current = nextFirstId;
  }, [isAtBottom, messages]);

  useEffect(() => {
    if (isAtBottom) {
      setShowNewContent(false);
    }
  }, [isAtBottom]);

  // Scroll to the latest content when the indicator is clicked.
  const handleScrollToNewContent = useCallback(() => {
    void scrollToBottom({ animation: "instant" });
    setShowNewContent(false);
  }, [scrollToBottom]);

  // --- Copy handler (local to MessageList) ---
  const handleCopyMessage = useCallback(async (messageId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 1500);
    } catch (err) {
      console.error("Failed to copy message:", err);
    }
  }, []);

  // --- Sender info lookup ---
  // Falls back to the message's senderMetadata snapshot (populated from events
  // and history) before defaulting, so historical messages from agents align
  // correctly on reload even when the original participant left the roster.
  const getSenderInfo = useCallback((senderId: string, msg?: ChatMessage) => {
    const live = allParticipants[senderId]?.metadata;
    const stored = msg?.senderMetadata;
    // Merge stored snapshot (immutable, from DB — always has correct type)
    // with live roster (may be fresher, but empty {} during join→metadata gap).
    // Stored is absent for locally-created messages not yet persisted;
    // live is {} during the connection setup window.
    return {
      name: "Unknown",
      type: "unknown" as const,
      handle: "unknown",
      ...(stored?.type ? stored : {}),
      ...(live?.type ? live : {}),
    };
  }, [allParticipants]);

  // --- Interrupt handler ---
  const handleInterruptMessage = useCallback(
    (msgId: string, senderId: string) => {
      const handle = allParticipants[senderId]?.metadata?.handle;
      onInterrupt?.(senderId, msgId, handle);
    },
    [onInterrupt, allParticipants]
  );

  // Stable callback for interrupting typing indicators
  const handleTypingInterrupt = useCallback((senderId: string) => {
    const handle = allParticipants[senderId]?.metadata?.handle;
    onInterrupt?.(senderId, undefined, handle);
  }, [allParticipants, onInterrupt]);

  // --- Message grouping (with incremental fast paths) ---
  const prevGroupCacheRef = useRef<{
    messages: ChatMessage[];
    result: GroupedItem[];
  } | null>(null);

  const groupedItems = useMemo(() => {
    const cache = prevGroupCacheRef.current;

    // Fast path A: streaming update — same array length, only last message changed.
    // During streaming, the messages array is replaced with a new reference where only
    // the last element has updated content. All prior elements are reference-equal.
    if (cache && cache.messages.length === messages.length && messages.length > 0
) {
      let onlyLastChanged = true;
      for (let i = 0; i < messages.length - 1; i++) {
        if (messages[i] !== cache.messages[i]) { onlyLastChanged = false; break; }
      }
      if (onlyLastChanged) {
        const lastMsg = messages[messages.length - 1]!;
        const lastItem = cache.result[cache.result.length - 1];
        const lastMsgInlineType = getInlineItemType(lastMsg);
        // If the last grouped item is a regular message with the same id, swap it in-place.
        // Also verify the message hasn't transitioned to an inline type.
        if (lastItem?.type === "message" && lastItem.msg.id === lastMsg.id && lastMsgInlineType === null) {
          const result = cache.result.slice(); // shallow copy
          result[result.length - 1] = { type: "message", msg: lastMsg, index: messages.length - 1 };
          prevGroupCacheRef.current = { messages, result };
          return result;
        }
        // If it's an inline group whose last source message changed (e.g., thinking/action streaming),
        // rebuild only that inline group. Verify the message is still an inline type.
        if (lastItem?.type === "inline-group" && lastMsgInlineType !== null) {
          const lastSrcMsg = lastItem.items[lastItem.items.length - 1]?.msg;
          if (lastSrcMsg?.id === lastMsg.id) {
            const result = cache.result.slice();
            const updatedItems = lastItem.items.slice();
            updatedItems[updatedItems.length - 1] = { msg: lastMsg, index: messages.length - 1 };
            result[result.length - 1] = {
              type: "inline-group",
              items: updatedItems,
              inlineItems: buildInlineItems(updatedItems),
              key: lastItem.key,
            };
            prevGroupCacheRef.current = { messages, result };
            return result;
          }
        }
      }
    }

    // Fast path B: append-only — prefix unchanged, new messages added at end.
    // Common when a new message arrives or a new inline item is appended.
    if (cache && messages.length > cache.messages.length) {
      let prefixMatch = true;
      for (let i = 0; i < cache.messages.length; i++) {
        if (messages[i] !== cache.messages[i]) { prefixMatch = false; break; }
      }
      if (prefixMatch) {
        const result = cache.result.slice();
        // Process only the new messages, potentially merging with the tail group
        let tailInlineGroup: Array<{ msg: ChatMessage; index: number }> | null = null;
        const lastCached = result[result.length - 1];
        if (lastCached?.type === "inline-group") {
          // Pop the last inline group — new messages might extend it
          tailInlineGroup = lastCached.items.slice();
          result.pop();
        }

        for (let i = cache.messages.length; i < messages.length; i++) {
          const msg = messages[i]!;
          if (msg.contentType === "typing") continue;

          const inlineType = getInlineItemType(msg);
          if (inlineType !== null) {
            if (!tailInlineGroup) tailInlineGroup = [];
            tailInlineGroup.push({ msg, index: i });
          } else {
            if (tailInlineGroup && tailInlineGroup.length > 0) {
              result.push({
                type: "inline-group",
                items: tailInlineGroup,
                inlineItems: buildInlineItems(tailInlineGroup),
                key: `inline-group-${tailInlineGroup[0]!.msg.id || tailInlineGroup[0]!.index}`,
              });
              tailInlineGroup = null;
            }
            result.push({ type: "message", msg, index: i });
          }
        }

        if (tailInlineGroup && tailInlineGroup.length > 0) {
          result.push({
            type: "inline-group",
            items: tailInlineGroup,
            inlineItems: buildInlineItems(tailInlineGroup),
            key: `inline-group-${tailInlineGroup[0]!.msg.id || tailInlineGroup[0]!.index}`,
          });
        }

        prevGroupCacheRef.current = { messages, result };
        return result;
      }
    }

    // Full recompute fallback (prepends, trims, mid-array changes)
    const result = fullGroupComputation(messages);
    prevGroupCacheRef.current = { messages, result };
    return result;
  }, [messages]);

  const activeTypingItems = useMemo(() => buildActiveTypingItems(messages), [messages]);

  // Refs for stable renderItem callback — avoids recreating the closure on every
  // groupedItems / copiedMessageId change, which would force every visible
  // virtual item to re-render.
  const groupedItemsRef = useRef(groupedItems);
  groupedItemsRef.current = groupedItems;
  const copiedMessageIdRef = useRef(copiedMessageId);
  copiedMessageIdRef.current = copiedMessageId;

  // Render a single grouped item by index.
  // Each item is wrapped in its own flex column container so that
  // MessageCard's alignSelf works regardless of the parent's display mode.
  const renderItem = useCallback((index: number) => {
    const item = groupedItemsRef.current[index];
    if (!item) return null;

    if (item.type === "inline-group") {
      if (customRenderInlineGroup) {
        return <Flex direction="column">{customRenderInlineGroup(item.inlineItems)}</Flex>;
      }
      return <Flex direction="column"><InlineGroup key={item.key} items={item.inlineItems} onInterrupt={handleTypingInterrupt} /></Flex>;
    }

    const { msg, index: msgIndex } = item;
    const sender = getSenderInfo(msg.senderId, msg);

    if (customRenderMessage) {
      return <Flex direction="column">{customRenderMessage(msg, sender as SenderInfo)}</Flex>;
    }

    const isStreaming = msg.kind === "message" && !msg.complete && !msg.pending;

    return (
      <Flex direction="column">
        <MessageCard
          key={msg.id || `fallback-msg-${msgIndex}`}
          msg={msg}
          index={msgIndex}
          senderType={sender.type}
          isStreaming={isStreaming}
          isCopied={copiedMessageIdRef.current === msg.id}
          inlineUiComponents={inlineUiComponents}
          onInterrupt={handleInterruptMessage}
          onCopy={handleCopyMessage}
          onFocusPanel={onFocusPanel}
          onReloadPanel={onReloadPanel}
        />
      </Flex>
    );
  }, [getSenderInfo, inlineUiComponents,
      handleInterruptMessage, handleCopyMessage, handleTypingInterrupt, onFocusPanel, onReloadPanel,
      customRenderMessage, customRenderInlineGroup]);

  // --- Render ---
  return (
    <Box flexGrow="1" overflow="hidden" style={{ minHeight: 0, position: "relative" }} asChild>
      <Card>
        <ScrollArea
          ref={scrollRef}
          style={{
            height: "100%",
          }}
          scrollbars="vertical"
          size="1"
        >
          <div ref={contentRef} style={{ padding: "var(--space-1)" }}>
            {/* Load earlier messages button */}
            {hasMoreHistory && onLoadEarlierMessages && (
              <Flex justify="center" py="2">
                <Button
                  size="1"
                  variant="soft"
                  onClick={onLoadEarlierMessages}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading..." : "Load earlier messages"}
                </Button>
              </Flex>
            )}
            {groupedItems.length === 0 && activeTypingItems.length === 0 ? (
              <Text color="gray" size="2">
                Send a message to start chatting
              </Text>
            ) : (
              <Flex direction="column" gap="1">
                {groupedItems.map((item, index) => (
                  <div key={item.type === "inline-group" ? item.key : (item.msg.id || `msg-${index}`)}>
                    {renderItem(index)}
                  </div>
                ))}
                {activeTypingItems.length > 0 && (
                  <div key="active-typing">
                    <Flex direction="column">
                      {customRenderInlineGroup
                        ? customRenderInlineGroup(activeTypingItems)
                        : <InlineGroup items={activeTypingItems} onInterrupt={handleTypingInterrupt} />}
                    </Flex>
                  </div>
                )}
              </Flex>
            )}
          </div>
        </ScrollArea>
        {showNewContent && (
          <NewContentIndicator onClick={handleScrollToNewContent} />
        )}
      </Card>
    </Box>
  );
});
