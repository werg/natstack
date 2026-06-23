import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Box, Button, Flex, ScrollArea, Text } from "@radix-ui/themes";
import type { Participant } from "@workspace/pubsub";
import { useStickToBottom } from "../hooks/useStickToBottom.js";
import { useScrollAnchor, type ScrollAnchorItem } from "../hooks/useScrollAnchor.js";
import { InlineGroup, type InlineItem } from "./InlineGroup";
import { NewContentIndicator } from "./NewContentIndicator";
import { MessageCard } from "./MessageCard";
import type { InvocationCardPayload } from "@workspace/agentic-core";
import type {
  BrowserHandoffCaller,
  ChannelParticipantId,
  ChatMessage,
  ChatParticipantMetadata,
  InlineUiComponentEntry,
  MessageTypeComponentEntry,
} from "../types";
import type { MdxActionHandlers } from "./markdownComponents";

// Grouped item types produced by the grouping logic
type GroupedItem =
  | { type: "inline-group"; items: Array<{ msg: ChatMessage; index: number }>; inlineItems: InlineItem[]; key: string }
  | { type: "chat-message"; msg: ChatMessage; index: number };

// --- Grouping helper functions (module-level for reuse by fast paths) ---

type InlineItemType = "thinking" | "invocation" | "typing" | "custom";

function getInlineItemType(msg: ChatMessage): InlineItemType | null {
  if (msg.contentType === "thinking") return "thinking";
  if (msg.contentType === "invocation") return "invocation";
  if (msg.contentType === "typing") return "typing";
  if (msg.contentType === "custom" && msg.custom?.displayMode === "inline") return "custom";
  return null;
}

function isTypingMessage(msg: ChatMessage): boolean {
  return msg.contentType === "typing";
}

function messageSignature(msg: ChatMessage): string {
  const customUpdatedAt = msg.custom
    ? JSON.stringify([msg.custom.initialState ?? null, msg.custom.lastSeq, msg.custom.updates])
    : "";
  return [
    msg.contentType ?? "",
    msg.kind ?? "",
    msg.content,
    msg.complete ? "1" : "0",
    // Include every field that affects grouped rendering so receipt / edit /
    // retract changes re-memo the row (tier was previously omitted).
    msg.error ?? "",
    msg.tier ?? "",
    msg.receipts?.aggregate ?? "",
    msg.receipts ? JSON.stringify(msg.receipts.byParticipant) : "",
    msg.retracted ? "1" : "0",
    msg.revision ?? "",
    msg.editedAt ?? "",
    customUpdatedAt,
  ].join("\u001f");
}

function groupedItemAnchorId(item: GroupedItem): string {
  if (item.type === "inline-group") return item.key;
  return item.msg.id;
}

function groupedItemSignature(item: GroupedItem): string {
  if (item.type === "inline-group") {
    return item.items.map(({ msg }) => `${msg.id}:${messageSignature(msg)}`).join("\u001e");
  }
  return messageSignature(item.msg);
}

/** Transform an inline group's messages into InlineItem[] */
function buildInlineItems(
  items: Array<{ msg: ChatMessage; index: number }>,
): InlineItem[] {
  return items.flatMap(({ msg }) => {
    if (msg.contentType === "invocation") {
      if (!msg.invocation) return [];
      return {
        type: "invocation" as const,
        id: msg.id,
        invocation: msg.invocation,
        complete: msg.complete ?? false,
        senderId: msg.senderId,
      };
    }
    if (msg.contentType === "typing") {
      return {
        type: "typing" as const,
        id: msg.id,
        data: {
          senderId: msg.senderId,
          senderName: msg.senderMetadata?.name,
          senderType: msg.senderMetadata?.type,
        },
        senderId: msg.senderId,
      };
    }
    if (msg.contentType === "custom") {
      if (!msg.custom || msg.custom.displayMode !== "inline") return [];
      return {
        type: "custom" as const,
        id: msg.id,
        payload: msg.custom,
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

function pushInlineGroup(
  result: GroupedItem[],
  items: Array<{ msg: ChatMessage; index: number }>,
): void {
  if (items.length === 0) return;
  const inlineItems = buildInlineItems(items);
  if (inlineItems.length === 0) return;
  result.push({
    type: "inline-group",
    items,
    inlineItems,
    key: `inline-group-${items[0]!.msg.id || items[0]!.index}`,
  });
}

/** Full grouping computation — scans all messages from scratch */
function fullGroupComputation(
  messages: ChatMessage[],
): GroupedItem[] {
  const result: GroupedItem[] = [];
  let currentInlineGroup: Array<{ msg: ChatMessage; index: number }> = [];

  messages.forEach((msg, index) => {
    if (isTypingMessage(msg)) {
      if (currentInlineGroup.length > 0) {
        pushInlineGroup(result, currentInlineGroup);
        currentInlineGroup = [];
      }
      pushInlineGroup(result, [{ msg, index }]);
      return;
    }

    const inlineType = getInlineItemType(msg);

    if (inlineType !== null) {
      currentInlineGroup.push({ msg, index });
    } else {
      if (currentInlineGroup.length > 0) {
        pushInlineGroup(result, currentInlineGroup);
        currentInlineGroup = [];
      }
      result.push({ type: "chat-message", msg, index });
    }
  });

  if (currentInlineGroup.length > 0) {
    pushInlineGroup(result, currentInlineGroup);
  }

  return result;
}

/**
 * Roster fallback for participants that expose ephemeral typing metadata.
 * Durable `turn.opened` / `turn.closed` events are projected into
 * `contentType: "typing"` messages and take precedence for agent turns.
 */
function buildActiveTypingItems(
  participants: Record<string, Participant<ChatParticipantMetadata>>,
  selfId: string | null,
): InlineItem[] {
  const items: InlineItem[] = [];
  for (const [pid, p] of Object.entries(participants)) {
    if (!p.metadata.typing) continue;
    if (pid === selfId) continue;
    items.push({
      type: "typing" as const,
      id: `typing-${pid}`,
      data: {
        senderId: pid,
        senderName: p.metadata.name,
        senderType: p.metadata.type,
      },
      senderId: pid,
    });
  }
  return items;
}

/** Sender info returned by getSenderInfo */
export interface SenderInfo {
  name: string;
  type: "panel" | "headless" | "agent" | "unknown";
  handle: string;
}

export interface MessageListProps {
  messages: ChatMessage[];
  /** Current active roster — typing indicators are derived from participant metadata */
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  /** This client's participant ID — excluded from typing display */
  selfId: ChannelParticipantId | null;
  allParticipants: Record<string, Participant<ChatParticipantMetadata>>;
  inlineUiComponents?: Map<string, InlineUiComponentEntry>;
  messageTypeComponents?: Map<string, MessageTypeComponentEntry>;
  chat?: Record<string, unknown>;
  browserHandoffCaller?: BrowserHandoffCaller;
  hasMoreHistory?: boolean;
  loadingMore?: boolean;
  onLoadEarlierMessages?: () => void;
  onInterrupt?: (agentId: string, messageId?: string, agentHandle?: string) => void;
  onCancelInvocation?: (invocation: InvocationCardPayload, senderId: string) => void;
  onFocusPanel?: (panelId: string) => void;
  onReloadPanel?: (panelId: string) => void;
  onReply?: (messageId: string) => void;
  mdxActions?: MdxActionHandlers;
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
  participants,
  selfId,
  allParticipants,
  inlineUiComponents,
  messageTypeComponents,
  chat,
  browserHandoffCaller,
  hasMoreHistory,
  loadingMore,
  onLoadEarlierMessages,
  onInterrupt,
  onCancelInvocation,
  onFocusPanel,
  onReloadPanel,
  onReply,
  mdxActions,
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
    isAtBottomRef,
  } = useStickToBottom({
    initial: "instant",
    resize: "instant",
  });

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
    } catch (err) {
      console.error("Failed to copy message:", err);
    }
  }, []);
  const handleClearCopiedMessage = useCallback((messageId: string) => {
    setCopiedMessageId((current) => current === messageId ? null : current);
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
        if (lastItem?.type === "chat-message" && lastItem.msg.id === lastMsg.id && lastMsgInlineType === null) {
          const result = cache.result.slice(); // shallow copy
          result[result.length - 1] = { type: "chat-message", msg: lastMsg, index: messages.length - 1 };
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
            const inlineItems = buildInlineItems(updatedItems);
            if (inlineItems.length > 0) {
              result[result.length - 1] = {
                type: "inline-group",
                items: updatedItems,
                inlineItems,
                key: lastItem.key,
              };
            } else {
              result.pop();
            }
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
        if (lastCached?.type === "inline-group" && !lastCached.items.some(({ msg }) => isTypingMessage(msg))) {
          // Pop the last inline group — new messages might extend it
          tailInlineGroup = lastCached.items.slice();
          result.pop();
        }

        for (let i = cache.messages.length; i < messages.length; i++) {
          const msg = messages[i]!;
          if (isTypingMessage(msg)) {
            if (tailInlineGroup && tailInlineGroup.length > 0) {
              pushInlineGroup(result, tailInlineGroup);
              tailInlineGroup = null;
            }
            pushInlineGroup(result, [{ msg, index: i }]);
            continue;
          }

          const inlineType = getInlineItemType(msg);
          if (inlineType !== null) {
            if (!tailInlineGroup) tailInlineGroup = [];
            tailInlineGroup.push({ msg, index: i });
          } else {
            if (tailInlineGroup && tailInlineGroup.length > 0) {
              pushInlineGroup(result, tailInlineGroup);
              tailInlineGroup = null;
            }
            result.push({ type: "chat-message", msg, index: i });
          }
        }

        if (tailInlineGroup && tailInlineGroup.length > 0) {
          pushInlineGroup(result, tailInlineGroup);
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
  const scrollAnchorItems = useMemo<ScrollAnchorItem[]>(
    () => groupedItems.map((item) => ({
      id: groupedItemAnchorId(item),
      signature: groupedItemSignature(item),
    })),
    [groupedItems],
  );

  useScrollAnchor({
    scrollRef,
    contentRef,
    items: scrollAnchorItems,
    isAtBottomRef,
    onNewContent: () => setShowNewContent(true),
  });

  const messagesById = useMemo(() => {
    const byId = new Map<string, ChatMessage>();
    for (const message of messages) byId.set(message.id, message);
    return byId;
  }, [messages]);

  const hasDurableTypingMessages = messages.some((msg) => msg.contentType === "typing");
  const activeTypingItems = useMemo(
    () => hasDurableTypingMessages ? [] : buildActiveTypingItems(participants, selfId),
    [participants, selfId, hasDurableTypingMessages],
  );

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
        return <Flex className="message-item" direction="column">{customRenderInlineGroup(item.inlineItems)}</Flex>;
      }
      return <Flex className="message-item" direction="column"><InlineGroup key={item.key} items={item.inlineItems} messageTypeComponents={messageTypeComponents} chat={chat} onInterrupt={handleTypingInterrupt} onCancelInvocation={onCancelInvocation} /></Flex>;
    }

    const { msg, index: msgIndex } = item;
    const sender = getSenderInfo(msg.senderId, msg);
    const mentionLabels = (msg.mentions ?? []).map((participantId) => {
      const participant = allParticipants[participantId];
      return participant?.metadata.handle ?? participant?.metadata.name ?? participantId;
    });
    const repliedTo = msg.replyTo ? messagesById.get(msg.replyTo) : undefined;
    const replySender = repliedTo ? getSenderInfo(repliedTo.senderId, repliedTo) : null;
    const replyContext = repliedTo && replySender
      ? {
          id: repliedTo.id,
          senderName: replySender.name,
          snippet: repliedTo.content.slice(0, 120),
        }
      : undefined;

    if (customRenderMessage) {
      return <Flex className="message-item" direction="column">{customRenderMessage(msg, sender as SenderInfo)}</Flex>;
    }

    // User messages are published as `message.completed` (so `complete` is
    // already true); the legacy `!pending` term is moot, so drop it.
    const isStreaming = msg.kind === "message" && !msg.complete;

    return (
      <Flex className="message-item" direction="column">
        <MessageCard
          key={msg.id || `fallback-msg-${msgIndex}`}
          msg={msg}
          index={msgIndex}
          selfId={selfId}
          senderType={sender.type}
          senderInfo={sender as SenderInfo}
          participants={allParticipants}
          mentionLabels={mentionLabels}
          replyContext={replyContext}
          isStreaming={isStreaming}
          isCopied={copiedMessageIdRef.current === msg.id}
          inlineUiComponents={inlineUiComponents}
          messageTypeComponents={messageTypeComponents}
          chat={chat}
          browserHandoffCaller={browserHandoffCaller}
          onInterrupt={handleInterruptMessage}
          onCopy={handleCopyMessage}
          onClearCopied={handleClearCopiedMessage}
          onReply={onReply}
          onFocusPanel={onFocusPanel}
          onReloadPanel={onReloadPanel}
          mdxActions={mdxActions}
        />
      </Flex>
    );
  }, [getSenderInfo, inlineUiComponents, messageTypeComponents, chat, browserHandoffCaller, mdxActions, allParticipants, messagesById, onReply,
      handleInterruptMessage, handleCopyMessage, handleClearCopiedMessage, handleTypingInterrupt, onCancelInvocation, onFocusPanel, onReloadPanel,
      customRenderMessage, customRenderInlineGroup]);

  // --- Render ---
  return (
    <Box className="message-list-card" flexGrow="1" overflow="hidden" style={{ minHeight: 0, position: "relative" }}>
      <ScrollArea
        className="message-scroll-area"
        ref={(node) => { scrollRef(node); }}
        style={{
          height: "100%",
          width: "100%",
        }}
        scrollbars="vertical"
        size="1"
      >
        <div
          ref={contentRef}
          className="message-list-content"
          style={{ padding: "var(--message-list-padding)" }}
        >
          {/* Load earlier messages button */}
          {hasMoreHistory && onLoadEarlierMessages && (
            <Flex justify="center" py="1">
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
            <Flex className="message-list-stack" direction="column" gap="1">
              {groupedItems.map((item, index) => (
                <div
                  className="message-item"
                  data-scroll-anchor-id={groupedItemAnchorId(item)}
                  key={item.type === "inline-group" ? item.key : (item.msg.id || `msg-${index}`)}
                >
                  {renderItem(index)}
                </div>
              ))}
              {activeTypingItems.length > 0 && (
                <div className="message-item" key="active-typing">
                  <Flex className="message-item" direction="column">
                    {customRenderInlineGroup
                      ? customRenderInlineGroup(activeTypingItems)
                      : <InlineGroup items={activeTypingItems} messageTypeComponents={messageTypeComponents} chat={chat} onInterrupt={handleTypingInterrupt} onCancelInvocation={onCancelInvocation} />}
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
    </Box>
  );
});
