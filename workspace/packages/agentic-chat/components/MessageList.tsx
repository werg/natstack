import React, { useState, useRef, useEffect, useCallback, useLayoutEffect, useMemo, type ComponentType } from "react";
import { Box, Button, Card, Flex, ScrollArea, Text } from "@radix-ui/themes";
import { prettifyToolName } from "@workspace/agentic-messaging/utils";
import type { Participant } from "@natstack/pubsub";
import type { MethodHistoryEntry } from "./MethodHistoryItem";
import { InlineGroup, type InlineItem } from "./InlineGroup";
import { parseActionData } from "./ActionMessage";
import { parseTypingData } from "./TypingMessage";
import { NewContentIndicator } from "./NewContentIndicator";
import { MessageCard } from "./MessageCard";
import type { ChatMessage, ChatParticipantMetadata } from "../types";

const BOTTOM_THRESHOLD_PX = 48;

// Grouped item types produced by the grouping logic
type GroupedItem =
  | { type: "inline-group"; items: Array<{ msg: ChatMessage; index: number }>; inlineItems: InlineItem[]; key: string }
  | { type: "message"; msg: ChatMessage; index: number };

// --- Grouping helper functions (module-level for reuse by fast paths) ---

type InlineItemType = "thinking" | "action" | "method" | "typing";

function getInlineItemType(msg: ChatMessage): InlineItemType | null {
  if (msg.kind === "method" && msg.method) return "method";
  if (msg.contentType === "thinking") return "thinking";
  if (msg.contentType === "action") return "action";
  if (msg.contentType === "typing" && !msg.complete) return "typing";
  return null;
}

/** Transform an inline group's messages into InlineItem[] with deduplication */
function buildInlineItems(
  items: Array<{ msg: ChatMessage; index: number }>,
  methodEntries?: Map<string, MethodHistoryEntry>,
): InlineItem[] {
  const inlineItems: InlineItem[] = items.map(({ msg }) => {
    if (msg.kind === "method" && msg.method) {
      const liveEntry = methodEntries?.get(msg.method.callId);
      return { type: "method" as const, entry: liveEntry ?? msg.method };
    }
    if (msg.contentType === "thinking") {
      return {
        type: "thinking" as const,
        id: msg.id,
        content: msg.content,
        complete: msg.complete ?? false,
      };
    }
    if (msg.contentType === "action") {
      const data = parseActionData(msg.content, msg.complete);
      return {
        type: "action" as const,
        id: msg.id,
        data,
        complete: msg.complete ?? false,
      };
    }
    if (msg.contentType === "typing") {
      const data = parseTypingData(msg.content);
      return {
        type: "typing" as const,
        id: msg.id,
        data,
        senderId: msg.senderId,
      };
    }
    return {
      type: "thinking" as const,
      id: msg.id,
      content: msg.content || "Unknown",
      complete: msg.complete ?? false,
    };
  });

  const lastActionIndexByToolUseId = new Map<string, number>();
  inlineItems.forEach((item, i) => {
    if (item.type === "action" && item.data.toolUseId) {
      lastActionIndexByToolUseId.set(item.data.toolUseId, i);
    }
  });

  const actionToolNames = new Set<string>();
  for (const item of inlineItems) {
    if (item.type === "action") {
      actionToolNames.add(prettifyToolName(item.data.type));
    }
  }

  return inlineItems.filter((item, i) => {
    if (item.type === "action" && item.data.toolUseId) {
      const lastIndex = lastActionIndexByToolUseId.get(item.data.toolUseId);
      if (lastIndex !== undefined && i !== lastIndex) return false;
    }
    if (item.type === "method") {
      const methodToolName = prettifyToolName(item.entry.methodName);
      if (actionToolNames.has(methodToolName)) return false;
    }
    return true;
  });
}

/** Full grouping computation — scans all messages from scratch */
function fullGroupComputation(
  messages: ChatMessage[],
  methodEntries?: Map<string, MethodHistoryEntry>,
): GroupedItem[] {
  const lastTypingIndexBySender = new Map<string, number>();
  messages.forEach((msg, index) => {
    if (msg.contentType === "typing" && !msg.complete) {
      lastTypingIndexBySender.set(msg.senderId, index);
    }
  });
  const isSupersededTyping = (msg: ChatMessage, index: number): boolean => {
    if (msg.contentType !== "typing" || msg.complete) return false;
    const lastIndex = lastTypingIndexBySender.get(msg.senderId);
    return lastIndex !== undefined && index !== lastIndex;
  };

  const result: GroupedItem[] = [];
  let currentInlineGroup: Array<{ msg: ChatMessage; index: number }> = [];

  messages.forEach((msg, index) => {
    if (isSupersededTyping(msg, index)) return;
    // Skip completed typing indicators — they're ephemeral and render as
    // null in MessageCard.  Excluding them avoids phantom height for
    // invisible items.
    if (msg.contentType === "typing" && msg.complete) return;

    const inlineType = getInlineItemType(msg);

    if (inlineType !== null) {
      currentInlineGroup.push({ msg, index });
    } else {
      if (currentInlineGroup.length > 0) {
        result.push({
          type: "inline-group",
          items: currentInlineGroup,
          inlineItems: buildInlineItems(currentInlineGroup, methodEntries),
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
      inlineItems: buildInlineItems(currentInlineGroup, methodEntries),
      key: `inline-group-${currentInlineGroup[0]!.msg.id || currentInlineGroup[0]!.index}`,
    });
  }

  return result;
}

/** Sender info returned by getSenderInfo */
export interface SenderInfo {
  name: string;
  type: "panel" | "ai-responder" | "claude-code" | "codex" | "subagent" | "unknown";
  handle: string;
}

export interface MessageListProps {
  messages: ChatMessage[];
  methodEntries?: Map<string, MethodHistoryEntry>;
  allParticipants: Record<string, Participant<ChatParticipantMetadata>>;
  inlineUiComponents?: Map<string, {
    Component?: ComponentType<{ props: Record<string, unknown> }>;
    cacheKey: string;
    error?: string;
  }>;
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
  methodEntries,
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
  // --- Scroll refs and state ---
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const [showNewContent, setShowNewContent] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null);

  // Refs for scroll position tracking
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
  // Explicit "at bottom" flag — scrollToIndex is async (estimated offset may
  // undershoot), so reading viewport.scrollTop right after may not reflect the
  // true position. Setting this flag after auto-scrolling ensures consecutive
  // streaming updates keep scrolling without waiting for the scroll event.
  const isAtBottomRef = useRef(true);

  const getViewport = useCallback((): HTMLElement | null => {
    const content = scrollContentRef.current;
    const root = scrollAreaRef.current;
    if (!content || !root) return null;
    // Walk up from the content div to the ScrollArea root to find the
    // scrollable viewport.  Radix may insert intermediate wrappers (e.g. a
    // `display:table` div) between the viewport and our content, so a simple
    // `parentElement` isn't reliable.
    let el: HTMLElement | null = content.parentElement;
    while (el && el !== root) {
      // Fast path: Radix marks the viewport with a data attribute
      if (el.hasAttribute("data-radix-scroll-area-viewport")) return el;
      // Fallback: look for scrollable overflow
      const { overflowY } = getComputedStyle(el);
      if (overflowY === "scroll" || overflowY === "auto" || overflowY === "hidden") return el;
      el = el.parentElement;
    }
    return null;
  }, []);

  // Track the actual viewport element so scroll listeners attach reliably.
  useLayoutEffect(() => {
    const nextViewport = getViewport();
    if (nextViewport !== viewportEl) {
      setViewportEl(nextViewport);
    }
  }, [getViewport, viewportEl]);

  // Handle scroll events.
  // Only clear isAtBottomRef when the user explicitly scrolls UP (scrollTop
  // decreased). Layout-induced scroll events (e.g. flex container resizing
  // from sibling re-renders, viewport height changes) can shift scrollTop
  // without user intent — clearing isAtBottom in those cases breaks autoscroll
  // because the next streaming update sees the flag as false and skips
  // scrollToEnd().
  const handleScroll = useCallback(() => {
    const viewport = viewportEl ?? getViewport();
    if (!viewport) return;
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    const prevScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;
    lastScrollHeightRef.current = scrollHeight;

    const nearBottom =
      scrollHeight - scrollTop - clientHeight <= BOTTOM_THRESHOLD_PX;

    if (nearBottom) {
      isAtBottomRef.current = true;
      setShowNewContent(false);
    } else if (scrollTop < prevScrollTop) {
      // User scrolled up — clear the flag.
      isAtBottomRef.current = false;
    }
    // Otherwise (scrollTop >= prevScrollTop but not nearBottom) leave the flag
    // unchanged. This handles content growth and layout-induced shifts that
    // move the bottom further away without user action.

    // Auto-load earlier messages when scrolling near the top
    if (viewport.scrollTop < 200 && hasMoreHistoryRef.current && !loadingMoreRef.current) {
      onLoadEarlierMessagesRef.current?.();
    }
  }, [getViewport, viewportEl]);

  // Attach scroll listener
  useEffect(() => {
    if (!viewportEl) return;
    viewportEl.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => viewportEl.removeEventListener("scroll", handleScroll);
  }, [handleScroll, viewportEl]);

  // Handle new content: keep position unless the user was near the bottom.
  const scrollRafRef = useRef(0);
  useEffect(() => {
    return () => cancelAnimationFrame(scrollRafRef.current);
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportEl ?? getViewport();
    const prevCount = lastMessageCountRef.current;
    const nextCount = messages.length;
    const prevFirstId = lastFirstMessageIdRef.current;
    const nextFirstId = messages[0]?.id ?? null;

    if (!viewport) {
      lastMessageCountRef.current = nextCount;
      lastFirstMessageIdRef.current = nextFirstId;
      return;
    }

    const scrollToEnd = () => {
      // Direct DOM scroll — always lands at the true bottom.
      // scrollToIndex uses estimated offsets and often undershoots,
      // causing handleScroll to incorrectly clear isAtBottomRef.
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" });
      // Retry next frame: layout may shift between now and the next paint.
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = requestAnimationFrame(() => {
        const vp = viewportEl ?? getViewport();
        if (vp) vp.scrollTo({ top: vp.scrollHeight, behavior: "auto" });
      });
    };

    if (prevCount === 0) {
      if (nextCount > 0) {
        scrollToEnd();
        isAtBottomRef.current = true;
      }
    } else {
      const countDelta = nextCount - prevCount;
      const { scrollHeight } = viewport;
      const prevScrollHeight = lastScrollHeightRef.current;
      const scrollHeightDelta = scrollHeight - prevScrollHeight;
      const isPrepend =
        countDelta > 0 && prevFirstId !== null && nextFirstId !== prevFirstId;

      if (isAtBottomRef.current) {
        scrollToEnd();
        setShowNewContent(false);
        // Keep the flag true — the rAF retry fires asynchronously, and
        // scroll events from the first scrollTo may arrive before the retry.
        isAtBottomRef.current = true;
      } else {
        if (isPrepend && scrollHeightDelta !== 0) {
          viewport.scrollTop = lastScrollTopRef.current + scrollHeightDelta;
        } else if (countDelta > 0 && !isPrepend) {
          setShowNewContent(true);
        }
      }
    }

    // Re-evaluate isAtBottomRef from the DOM — catches cases where the
    // flag was cleared by an intermediate scroll event but we're actually
    // at the bottom.
    if (!isAtBottomRef.current) {
      isAtBottomRef.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD_PX;
    }

    lastScrollTopRef.current = viewport.scrollTop;
    lastScrollHeightRef.current = viewport.scrollHeight;
    lastMessageCountRef.current = nextCount;
    lastFirstMessageIdRef.current = nextFirstId;
  }, [messages, getViewport, viewportEl]);

  // Scroll to the latest content when the indicator is clicked.
  const handleScrollToNewContent = useCallback(() => {
    const viewport = viewportEl ?? getViewport();
    if (viewport) {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" });
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = requestAnimationFrame(() => {
        const vp = viewportEl ?? getViewport();
        if (vp) vp.scrollTo({ top: vp.scrollHeight, behavior: "auto" });
      });
    }
    isAtBottomRef.current = true;
    setShowNewContent(false);
  }, [getViewport, viewportEl]);

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
    methodEntries: Map<string, MethodHistoryEntry> | undefined;
    result: GroupedItem[];
  } | null>(null);

  const groupedItems = useMemo(() => {
    const cache = prevGroupCacheRef.current;

    // Fast path A: streaming update — same array length, only last message changed.
    // During streaming, the messages array is replaced with a new reference where only
    // the last element has updated content. All prior elements are reference-equal.
    if (cache && cache.messages.length === messages.length && messages.length > 0
        && cache.methodEntries === methodEntries) {
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
          prevGroupCacheRef.current = { messages, methodEntries, result };
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
              inlineItems: buildInlineItems(updatedItems, methodEntries),
              key: lastItem.key,
            };
            prevGroupCacheRef.current = { messages, methodEntries, result };
            return result;
          }
        }
      }
    }

    // Fast path B: append-only — prefix unchanged, new messages added at end.
    // Common when a new message arrives or a new inline item is appended.
    if (cache && messages.length > cache.messages.length && cache.methodEntries === methodEntries) {
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

        // Recompute typing dedup for new messages only (approximate — full dedup
        // is only needed for the typing subset which is typically small)
        const lastTypingBySender = new Map<string, number>();
        messages.forEach((msg, index) => {
          if (msg.contentType === "typing" && !msg.complete) {
            lastTypingBySender.set(msg.senderId, index);
          }
        });

        for (let i = cache.messages.length; i < messages.length; i++) {
          const msg = messages[i]!;
          // Skip completed typing indicators (same filter as fullGroupComputation)
          if (msg.contentType === "typing" && msg.complete) continue;
          // Skip superseded typing
          if (msg.contentType === "typing" && !msg.complete) {
            const last = lastTypingBySender.get(msg.senderId);
            if (last !== undefined && i !== last) continue;
          }

          const inlineType = getInlineItemType(msg);
          if (inlineType !== null) {
            if (!tailInlineGroup) tailInlineGroup = [];
            tailInlineGroup.push({ msg, index: i });
          } else {
            if (tailInlineGroup && tailInlineGroup.length > 0) {
              result.push({
                type: "inline-group",
                items: tailInlineGroup,
                inlineItems: buildInlineItems(tailInlineGroup, methodEntries),
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
            inlineItems: buildInlineItems(tailInlineGroup, methodEntries),
            key: `inline-group-${tailInlineGroup[0]!.msg.id || tailInlineGroup[0]!.index}`,
          });
        }

        prevGroupCacheRef.current = { messages, methodEntries, result };
        return result;
      }
    }

    // Full recompute fallback (prepends, trims, mid-array changes)
    const result = fullGroupComputation(messages, methodEntries);
    prevGroupCacheRef.current = { messages, methodEntries, result };
    return result;
  }, [messages, methodEntries]);

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
      <ScrollArea ref={scrollAreaRef} style={{ height: "100%" }}>
        <div ref={scrollContentRef} style={{ overflowAnchor: "none", padding: "var(--space-1)" }}>
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
          {messages.length === 0 ? (
            <Text color="gray" size="2">
              Send a message to start chatting
            </Text>
          ) : (
            <Flex direction="column" gap="1">
              {groupedItems.map((item, index) => (
                <div
                  key={item.type === "inline-group" ? item.key : (item.msg.id || `msg-${index}`)}
                  style={{
                    contentVisibility: "auto",
                    containIntrinsicSize: item.type === "inline-group" ? "auto 36px" : "auto 100px",
                  } as React.CSSProperties}
                >
                  {renderItem(index)}
                </div>
              ))}
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
