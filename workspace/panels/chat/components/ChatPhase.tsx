import { useState, useRef, useEffect, useCallback, useLayoutEffect, useMemo, type ComponentType } from "react";
import { Badge, Box, Button, Callout, Card, Flex, IconButton, ScrollArea, Text, TextArea, Theme } from "@radix-ui/themes";
import { PaperPlaneIcon, ImageIcon, CopyIcon, CheckIcon } from "@radix-ui/react-icons";
import type { Participant, AttachmentInput } from "@natstack/pubsub";
import { CONTENT_TYPE_INLINE_UI, prettifyToolName, type AgentDebugPayload } from "@natstack/agentic-messaging";
import {
  FeedbackContainer,
  FeedbackFormRenderer,
  type ActiveFeedback,
  type ToolApprovalProps,
} from "@natstack/tool-ui";
import type { MethodHistoryEntry } from "./MethodHistoryItem";
import { TypingIndicator } from "./TypingIndicator";
import { MessageContent } from "./MessageContent";
import { ParticipantBadgeMenu } from "./ParticipantBadgeMenu";
import { ToolPermissionsDropdown } from "./ToolPermissionsDropdown";
import { InlineGroup, type InlineItem } from "./InlineGroup";
import { parseActionData } from "./ActionMessage";
import { parseTypingData } from "./TypingMessage";
import { ImageInput, getAttachmentInputsFromPendingImages } from "./ImageInput";
import { ImageGallery } from "./ImageGallery";
import { NewContentIndicator } from "./NewContentIndicator";
import { InlineUiMessage, parseInlineUiData } from "./InlineUiMessage";
import { type PendingImage, getImagesFromClipboard, createPendingImage, validateImageFiles } from "../utils/imageUtils";
import type { ChatMessage, ChatParticipantMetadata, PendingAgent } from "../types";
import { AgentDisconnectedMessage } from "./AgentDisconnectedMessage";
import { AgentDebugConsole } from "./AgentDebugConsole";
import { DirtyRepoWarning } from "./DirtyRepoWarning";
import { PendingAgentBadge } from "./PendingAgentBadge";
import "../styles.css";

// Re-export for backwards compatibility
export type { ChatMessage };

const MAX_IMAGE_COUNT = 10;
const BOTTOM_THRESHOLD_PX = 2;

interface ChatPhaseProps {
  channelId: string | null;
  connected: boolean;
  status: string;
  messages: ChatMessage[];
  input: string;
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  activeFeedbacks: Map<string, ActiveFeedback>;
  theme: "light" | "dark";
  /** Whether session persistence is enabled (true = restricted/persistent session) */
  sessionEnabled?: boolean;
  /** Pending images for the message */
  pendingImages: PendingImage[];
  /** Whether there are more messages to load from history */
  hasMoreHistory?: boolean;
  /** Whether currently loading more messages */
  loadingMore?: boolean;
  /** Live method entry data — keyed by callId, updated independently of messages */
  methodEntries?: Map<string, MethodHistoryEntry>;
  /** Compiled inline UI components by ID */
  inlineUiComponents?: Map<string, {
    Component?: ComponentType<{ props: Record<string, unknown> }>;
    cacheKey: string;
    error?: string;
  }>;
  /** Debug events for agents (ephemeral, in-memory) */
  debugEvents?: Array<AgentDebugPayload & { ts: number }>;
  /** Currently open debug console agent handle */
  debugConsoleAgent?: string | null;
  /** Dirty repo warnings for agents spawned with uncommitted changes */
  dirtyRepoWarnings?: Map<string, { modified: string[]; untracked: string[]; staged: string[] }>;
  /** Pending agents (starting or failed) - managed by parent, not computed from events */
  pendingAgents?: Map<string, PendingAgent>;
  /** Callback to open/close debug console */
  onDebugConsoleChange?: (agentHandle: string | null) => void;
  /** Callback to load earlier messages */
  onLoadEarlierMessages?: () => void;
  onInputChange: (value: string) => void;
  /** Send message with optional attachments (server assigns IDs) */
  onSendMessage: (attachments?: AttachmentInput[]) => Promise<void>;
  onImagesChange: (images: PendingImage[]) => void;
  /** Add agent to the chat - optional, hides button if not provided */
  onAddAgent?: () => void;
  onReset: () => void;
  onFeedbackDismiss: (callId: string) => void;
  onFeedbackError: (callId: string, error: Error) => void;
  onInterrupt?: (agentId: string, messageId?: string, agentHandle?: string) => void;
  onCallMethod?: (providerId: string, methodName: string, args: unknown) => void;
  /** Focus a disconnected agent's panel */
  onFocusPanel?: (panelId: string) => void;
  /** Reload a disconnected agent's panel */
  onReloadPanel?: (panelId: string) => void;
  /** Dismiss a dirty repo warning */
  onDismissDirtyWarning?: (agentName: string) => void;
  /** Tool approval configuration - optional, when provided enables approval UI */
  toolApproval?: ToolApprovalProps;
}

export function ChatPhase({
  channelId,
  connected,
  status,
  messages,
  input,
  participants,
  activeFeedbacks,
  theme,
  sessionEnabled,
  pendingImages,
  hasMoreHistory,
  loadingMore,
  inlineUiComponents,
  methodEntries,
  debugEvents,
  debugConsoleAgent,
  dirtyRepoWarnings,
  pendingAgents,
  onDebugConsoleChange,
  onLoadEarlierMessages,
  onInputChange,
  onSendMessage,
  onImagesChange,
  onAddAgent,
  onReset,
  onFeedbackDismiss,
  onFeedbackError,
  onInterrupt,
  onCallMethod,
  onFocusPanel,
  onReloadPanel,
  onDismissDirtyWarning,
  toolApproval,
}: ChatPhaseProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showImageInput, setShowImageInput] = useState(false);
  const [showNewContent, setShowNewContent] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null);

  // Refs for scroll position tracking
  const lastMessageCountRef = useRef(0);
  const lastFirstMessageIdRef = useRef<string | null>(null);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const isAtBottomRef = useRef(true);

  const getViewport = useCallback(() => {
    return scrollAreaRef.current?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]') ?? null;
  }, []);

  // Track the actual viewport element so scroll listeners attach reliably.
  useLayoutEffect(() => {
    const nextViewport = getViewport();
    if (nextViewport !== viewportEl) {
      setViewportEl(nextViewport);
    }
  }, [getViewport, viewportEl]);

  // Handle scroll events - keep track of whether the user left the bottom
  const handleScroll = useCallback(() => {
    const viewport = viewportEl ?? getViewport();
    if (!viewport) return;
    lastScrollTopRef.current = viewport.scrollTop;
    lastScrollHeightRef.current = viewport.scrollHeight;
    const isNearBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD_PX;
    isAtBottomRef.current = isNearBottom;
    if (isNearBottom) {
      setShowNewContent(false);
    }
  }, [getViewport, viewportEl]);

  // Attach scroll listener directly to viewport (Radix ScrollArea doesn't bubble scroll events)
  useEffect(() => {
    if (!viewportEl) return;
    viewportEl.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => viewportEl.removeEventListener("scroll", handleScroll);
  }, [handleScroll, viewportEl]);

  // Auto-scroll helper
  const autoScrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const viewport = viewportEl ?? getViewport();
    if (viewport) {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    } else {
      scrollRef.current?.scrollIntoView({ behavior });
    }
  }, [getViewport, viewportEl]);

  // Handle new content: keep position unless the user was at the bottom
  useLayoutEffect(() => {
    const viewport = getViewport();
    const prevCount = lastMessageCountRef.current;
    const nextCount = messages.length;
    const prevFirstId = lastFirstMessageIdRef.current;
    const nextFirstId = messages[0]?.id ?? null;

    if (!viewport) {
      lastMessageCountRef.current = nextCount;
      lastFirstMessageIdRef.current = nextFirstId;
      return;
    }

    const countDelta = nextCount - prevCount;
    const prevScrollHeight = lastScrollHeightRef.current || viewport.scrollHeight;
    const prevScrollTop = lastScrollTopRef.current || viewport.scrollTop;
    const scrollHeightDelta = viewport.scrollHeight - prevScrollHeight;
    const isPrepend =
      countDelta > 0 && prevCount > 0 && prevFirstId !== null && nextFirstId !== prevFirstId;

    if (prevCount > 0) {
      if (isAtBottomRef.current) {
        autoScrollToBottom();
        setShowNewContent(false);
      } else {
        if (isPrepend && scrollHeightDelta !== 0) {
          viewport.scrollTop = prevScrollTop + scrollHeightDelta;
        } else if (countDelta > 0 && !isPrepend) {
          setShowNewContent(true);
        }
      }
    }

    lastScrollTopRef.current = viewport.scrollTop;
    lastScrollHeightRef.current = viewport.scrollHeight;
    isAtBottomRef.current =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD_PX;
    lastMessageCountRef.current = nextCount;
    lastFirstMessageIdRef.current = nextFirstId;
  }, [messages, autoScrollToBottom, getViewport, viewportEl]);

  // Handler to scroll to new content when notification is clicked
  const handleScrollToNewContent = useCallback(() => {
    autoScrollToBottom("smooth");
    setShowNewContent(false);
  }, [autoScrollToBottom]);

  // Handler to copy message content to clipboard
  const handleCopyMessage = useCallback(async (messageId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 1500);
    } catch (err) {
      console.error("Failed to copy message:", err);
    }
  }, []);

  // Auto-dismiss error after 5 seconds
  useEffect(() => {
    if (sendError) {
      const timer = setTimeout(() => setSendError(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [sendError]);

  // Auto-resize textarea based on content
  useEffect(() => {
    const textArea = textAreaRef.current;
    if (textArea) {
      textArea.style.height = "auto";
      textArea.style.height = `${textArea.scrollHeight}px`;
    }
  }, [input]);

  // Handle paste for images (works even when ImageInput is not visible)
  useEffect(() => {
    if (!connected) return;

    const handlePaste = async (event: ClipboardEvent) => {
      try {
        const files = getImagesFromClipboard(event);
        if (files.length === 0) return;

        event.preventDefault();

        if (pendingImages.length + files.length > MAX_IMAGE_COUNT) {
          setSendError(`Maximum ${MAX_IMAGE_COUNT} images allowed`);
          return;
        }

        const validation = validateImageFiles(files);
        if (!validation.valid) {
          setSendError(validation.error ?? "Invalid image");
          return;
        }

        // Create pending images from pasted files
        const newImages: PendingImage[] = [];
        for (const file of files) {
          try {
            const pending = await createPendingImage(file);
            newImages.push(pending);
          } catch (err) {
            console.error("[ChatPhase] Failed to process pasted image:", err);
          }
        }

        if (newImages.length > 0) {
          try {
            onImagesChange([...pendingImages, ...newImages]);
          } catch (err) {
            console.error("[ChatPhase] onImagesChange callback error:", err);
          }
        }
      } catch (err) {
        console.error("[ChatPhase] Image paste handler error:", err);
      }
    };

    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [connected, pendingImages, onImagesChange]);

  const handleSendMessage = useCallback(async () => {
    try {
      setSendError(null);
      // Get attachment inputs from pending images (server assigns IDs)
      const attachments = pendingImages.length > 0
        ? getAttachmentInputsFromPendingImages(pendingImages)
        : undefined;
      await onSendMessage(attachments);
      // Clear images after sending
      onImagesChange([]);
      setShowImageInput(false);
      // Reset textarea height after sending
      if (textAreaRef.current) {
        textAreaRef.current.style.height = "auto";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSendError(message);
      console.error("Failed to send message:", error);
    }
  }, [onSendMessage, pendingImages, onImagesChange]);

  const handleInterruptMessage = useCallback(
    (msgId: string, senderId: string) => {
      // Pass handle from participants roster for fallback lookup if agentId is stale
      const handle = participants[senderId]?.metadata?.handle;
      onInterrupt?.(senderId, msgId, handle);
    },
    [onInterrupt, participants]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSendMessage();
    }
  };

  const getSenderInfo = useCallback((senderId: string) => {
    const participant = participants[senderId];
    return participant?.metadata ?? { name: "Unknown", type: "panel" as const, handle: "unknown" };
  }, [participants]);

  // Memoize message grouping AND inline item transformation to prevent expensive recalculation on every render
  const groupedItems = useMemo(() => {
    // Helper to determine if a message is an inline item (thinking, action, method, or typing)
    type InlineItemType = "thinking" | "action" | "method" | "typing";
    function getInlineItemType(msg: ChatMessage): InlineItemType | null {
      if (msg.kind === "method" && msg.method) return "method";
      if (msg.contentType === "thinking") return "thinking";
      if (msg.contentType === "action") return "action";
      // Typing indicators are ephemeral - hide completed ones
      if (msg.contentType === "typing" && !msg.complete) return "typing";
      return null;
    }

    /** Transform an inline group's messages into InlineItem[] with deduplication */
    function buildInlineItems(items: Array<{ msg: ChatMessage; index: number }>): InlineItem[] {
      const inlineItems: InlineItem[] = items.map(({ msg }) => {
        if (msg.kind === "method" && msg.method) {
          // Use live data from methodEntries Map if available, fall back to snapshot
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
        // Fallback — shouldn't happen
        return {
          type: "thinking" as const,
          id: msg.id,
          content: msg.content || "Unknown",
          complete: msg.complete ?? false,
        };
      });

      // Deduplicate: prefer action over method when both exist for the same tool
      const actionToolNames = new Set<string>();
      for (const item of inlineItems) {
        if (item.type === "action") {
          actionToolNames.add(prettifyToolName(item.data.type));
        }
      }
      return inlineItems.filter((item) => {
        if (item.type === "method") {
          const methodToolName = prettifyToolName(item.entry.methodName);
          if (actionToolNames.has(methodToolName)) return false;
        }
        return true;
      });
    }

    // Group consecutive inline items (thinking, action, method)
    const result: Array<
      | { type: "inline-group"; items: Array<{ msg: ChatMessage; index: number }>; inlineItems: InlineItem[]; key: string }
      | { type: "message"; msg: ChatMessage; index: number }
    > = [];

    let currentInlineGroup: Array<{ msg: ChatMessage; index: number }> = [];

    messages.forEach((msg, index) => {
      const inlineType = getInlineItemType(msg);

      if (inlineType !== null) {
        // This is an inline item (thinking, action, or method)
        currentInlineGroup.push({ msg, index });
      } else {
        // Regular message - flush any pending inline group
        if (currentInlineGroup.length > 0) {
          result.push({
            type: "inline-group",
            items: currentInlineGroup,
            inlineItems: buildInlineItems(currentInlineGroup),
            key: `inline-group-${currentInlineGroup[0].msg.id || currentInlineGroup[0].index}`,
          });
          currentInlineGroup = [];
        }
        result.push({ type: "message", msg, index });
      }
    });

    // Flush final inline group
    if (currentInlineGroup.length > 0) {
      result.push({
        type: "inline-group",
        items: currentInlineGroup,
        inlineItems: buildInlineItems(currentInlineGroup),
        key: `inline-group-${currentInlineGroup[0].msg.id || currentInlineGroup[0].index}`,
      });
    }

    return result;
  }, [messages, methodEntries]);

  // Stable callback for interrupting typing indicators (avoids new closure per render)
  const handleTypingInterrupt = useCallback((senderId: string) => {
    const handle = participants[senderId]?.metadata?.handle;
    onInterrupt?.(senderId, undefined, handle);
  }, [participants, onInterrupt]);

  // pendingAgents is now passed as a prop (managed by parent component)
  // This is cleaner than computing from ephemeral debug events

  return (
    <Theme appearance={theme}>
      <Flex direction="column" height="100vh" p="2" gap="2">
      {/* Header */}
      <Flex justify="between" align="center" flexShrink="0">
        <Flex gap="2" align="center">
          <Text size="5" weight="bold">
            Agentic Chat
          </Text>
          <Badge color="gray">{channelId}</Badge>
          <Badge color={sessionEnabled ? "blue" : "orange"} title={sessionEnabled ? "Session persistence enabled - messages are saved and can be replayed" : "Ephemeral session - messages are not persisted"}>
            {sessionEnabled ? "Session" : "Ephemeral"}
          </Badge>
        </Flex>
        <Flex gap="2" align="center">
          <Badge color={connected ? "green" : "gray"}>{connected ? "Connected" : status}</Badge>
          {Object.values(participants).map((p) => {
            // Check if this agent has an active message
            const agentMessages = messages.filter((m) => m.senderId === p.id && m.kind === "message");
            const hasActive = agentMessages.some((m) => !m.complete && !m.error);

            return (
              <ParticipantBadgeMenu
                key={p.id}
                participant={p}
                hasActiveMessage={hasActive}
                onCallMethod={onCallMethod ?? (() => {})}
                isGranted={toolApproval ? p.id in toolApproval.settings.agentGrants : false}
                onRevokeAgent={toolApproval?.onRevokeAgent}
                onOpenDebugConsole={onDebugConsoleChange ? (handle) => onDebugConsoleChange(handle) : undefined}
              />
            );
          })}
          {/* Pending/failed agents not yet in roster */}
          {pendingAgents && Array.from(pendingAgents.entries()).map(([handle, info]) => (
            <PendingAgentBadge
              key={`pending-${handle}`}
              handle={handle}
              agentId={info.agentId}
              status={info.status}
              error={info.error}
              onOpenDebugConsole={onDebugConsoleChange}
            />
          ))}
          {onAddAgent && (
            <Button variant="soft" size="1" onClick={onAddAgent}>
              Add Agent
            </Button>
          )}
          {toolApproval && (
            <ToolPermissionsDropdown
              settings={toolApproval.settings}
              participants={participants}
              onSetFloor={toolApproval.onSetFloor}
              onGrantAgent={toolApproval.onGrantAgent}
              onRevokeAgent={toolApproval.onRevokeAgent}
              onRevokeAll={toolApproval.onRevokeAll}
            />
          )}
          <Button variant="soft" onClick={onReset}>
            Reset
          </Button>
        </Flex>
      </Flex>

      {/* Dirty repo warnings */}
      {dirtyRepoWarnings && dirtyRepoWarnings.size > 0 && (
        <Box px="1" flexShrink="0">
          {Array.from(dirtyRepoWarnings.entries()).map(([name, state]) => (
            <DirtyRepoWarning
              key={name}
              agentName={name}
              dirtyRepo={state}
              onDismiss={() => onDismissDirtyWarning?.(name)}
            />
          ))}
        </Box>
      )}

      {/* Messages */}
      <Box flexGrow="1" overflow="hidden" style={{ minHeight: 0, position: "relative" }} asChild>
        <Card>
        <ScrollArea ref={scrollAreaRef} style={{ height: "100%" }}>
          <Flex direction="column" gap="1" p="1" style={{ overflowAnchor: "none" }}>
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
              groupedItems.map((item) => {
                  if (item.type === "inline-group") {
                    return <InlineGroup key={item.key} items={item.inlineItems} onInterrupt={handleTypingInterrupt} />;
                  }

                  const { msg, index } = item;
                  // Debug log to track key issues
                  if (!msg.id) {
                    console.warn(`[ChatPhase] Message at index ${index} has no id:`, msg);
                  }

                  // Skip completed typing indicators - they're ephemeral and shouldn't persist
                  if (msg.contentType === "typing" && msg.complete) {
                    return null;
                  }

                  // Handle inline_ui messages - render compiled MDX inline
                  if (msg.contentType === CONTENT_TYPE_INLINE_UI) {
                    const data = parseInlineUiData(msg.content);
                    if (data) {
                      const compiled = inlineUiComponents?.get(data.id);
                      return (
                        <Box
                          key={msg.id || `fallback-msg-${index}`}
                          style={{ maxWidth: "96%", alignSelf: "flex-start" }}
                        >
                          <InlineUiMessage
                            data={data}
                            compiledComponent={compiled?.Component}
                            compilationError={compiled?.error}
                          />
                        </Box>
                      );
                    }
                  }

                  // Handle system messages (e.g., agent disconnection notifications)
                  if (msg.kind === "system" && msg.disconnectedAgent) {
                    return (
                      <Box
                        key={msg.id || `fallback-msg-${index}`}
                        style={{ maxWidth: "96%", alignSelf: "center" }}
                      >
                        <AgentDisconnectedMessage
                          agent={msg.disconnectedAgent}
                          onFocusPanel={onFocusPanel}
                          onReloadPanel={onReloadPanel}
                        />
                      </Box>
                    );
                  }

                  const sender = getSenderInfo(msg.senderId);
                  const isPanel = sender.type === "panel";
                  // Only show streaming for messages that are actively being streamed (not pending local messages)
                  const isStreaming = msg.kind === "message" && !msg.complete && !msg.pending;
                  const hasError = Boolean(msg.error);
                  const hasContent = msg.content.length > 0;
                  const hasAttachments = msg.attachments && msg.attachments.length > 0;

                  return (
                    <Box
                      key={msg.id || `fallback-msg-${index}`}
                      style={{
                        maxWidth: "96%",
                        alignSelf: isPanel ? "flex-end" : "flex-start",
                      }}
                    >
                      <Card
                        className="message-card"
                        style={{
                          position: "relative",
                          backgroundColor: isPanel
                            ? "var(--gray-5)"
                            : msg.error
                              ? "var(--red-3)"
                              : "var(--gray-3)",
                          opacity: msg.pending ? 0.7 : 1,
                        }}
                      >
                        <Flex direction="column" gap="2">
                          {hasContent && (
                            <Box style={{ color: isPanel ? "white" : "inherit" }}>
                              <MessageContent content={msg.content} isStreaming={isStreaming} />
                            </Box>
                          )}
                          {hasAttachments && (
                            <ImageGallery attachments={msg.attachments!} />
                          )}
                          {hasError && (
                            <Text size="2" color="red" style={{ whiteSpace: "pre-wrap" }}>
                              Error: {msg.error}
                            </Text>
                          )}
                          {isStreaming && (
                            <TypingIndicator
                              isPaused={false}
                              showInterruptButton={true}
                              onInterrupt={() => handleInterruptMessage(msg.id, msg.senderId)}
                            />
                          )}
                          {hasContent && !isStreaming && (
                            <IconButton
                              className="copy-button"
                              size="1"
                              variant="ghost"
                              color="gray"
                              style={{
                                position: "absolute",
                                bottom: 4,
                                right: 4,
                              }}
                              onClick={() => void handleCopyMessage(msg.id, msg.content)}
                              title="Copy message"
                            >
                              {copiedMessageId === msg.id ? <CheckIcon /> : <CopyIcon />}
                            </IconButton>
                          )}
                        </Flex>
                      </Card>
                    </Box>
                  );
              })
            )}
            <div ref={scrollRef} />
          </Flex>
        </ScrollArea>
        {showNewContent && (
          <NewContentIndicator onClick={handleScrollToNewContent} />
        )}
        </Card>
      </Box>

      {activeFeedbacks.size > 0 && (
        <Flex direction="column" gap="2" flexShrink="0">
          {Array.from(activeFeedbacks.values()).map((feedback) => {
            // Render schema-based feedbacks using FeedbackFormRenderer
            if (feedback.type === "schema") {
              return (
                <FeedbackContainer
                  key={feedback.callId}
                  onDismiss={() => onFeedbackDismiss(feedback.callId)}
                  onError={(error) => onFeedbackError(feedback.callId, error)}
                >
                  <FeedbackFormRenderer
                    title={feedback.title}
                    fields={feedback.fields}
                    initialValues={feedback.values}
                    submitLabel={feedback.submitLabel}
                    cancelLabel={feedback.cancelLabel}
                    timeout={feedback.timeout}
                    timeoutAction={feedback.timeoutAction}
                    severity={feedback.severity}
                    hideSubmit={feedback.hideSubmit}
                    hideCancel={feedback.hideCancel}
                    onSubmit={(value) => feedback.complete({ type: "submit", value })}
                    onCancel={() => feedback.complete({ type: "cancel" })}
                    onError={(message) => feedback.complete({ type: "error", message })}
                  />
                </FeedbackContainer>
              );
            }

            // Render TSX-based feedbacks (type === "tsx")
            const FeedbackComponent = feedback.Component;
            if (!FeedbackComponent || typeof FeedbackComponent !== "function") {
              // Report the error and skip rendering
              onFeedbackError(feedback.callId, new Error("Invalid feedback component"));
              return null;
            }
            return (
              <FeedbackContainer
                key={feedback.callId}
                onDismiss={() => onFeedbackDismiss(feedback.callId)}
                onError={(error) => onFeedbackError(feedback.callId, error)}
              >
                <FeedbackComponent
                  onSubmit={(value) => feedback.complete({ type: "submit", value })}
                  onCancel={() => feedback.complete({ type: "cancel" })}
                  onError={(message) => feedback.complete({ type: "error", message })}
                />
              </FeedbackContainer>
            );
          })}
        </Flex>
      )}

      {/* Tool approvals are now handled via the feedback system (activeFeedbacks) */}

      {/* Error display */}
      {sendError && (
        <Box flexShrink="0">
          <Callout.Root color="red" size="1">
            <Callout.Text>
              Failed to send: {sendError}
            </Callout.Text>
          </Callout.Root>
        </Box>
      )}

      {/* Image input - shown when toggled or when images are pending */}
      {(showImageInput || pendingImages.length > 0) && (
        <Box flexShrink="0">
          <Card size="1">
            <ImageInput
              images={pendingImages}
              onImagesChange={onImagesChange}
              onError={(error) => setSendError(error)}
              disabled={!connected}
            />
          </Card>
        </Box>
      )}

      {/* Input */}
      <Box flexShrink="0">
      <Card size="1">
        <Flex align="end" gap="1" p="0">
          <TextArea
            ref={textAreaRef}
            size="2"
            variant="surface"
            style={{ flex: 1, minHeight: 48, maxHeight: 200, resize: "none" }}
            placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!connected}
          />
          <Flex direction="column" gap="2">
            <IconButton
              variant="ghost"
              size="2"
              onClick={() => setShowImageInput(!showImageInput)}
              disabled={!connected}
              color={pendingImages.length > 0 ? "blue" : "gray"}
              title="Attach images"
            >
              <ImageIcon />
            </IconButton>
            <IconButton
              onClick={() => void handleSendMessage()}
              disabled={!connected || (!input.trim() && pendingImages.length === 0)}
              size="2"
              variant="soft"
            >
              <PaperPlaneIcon />
            </IconButton>
          </Flex>
        </Flex>
      </Card>
      </Box>
      </Flex>

      {/* Agent Debug Console Modal */}
      {onDebugConsoleChange && (
        <AgentDebugConsole
          open={!!debugConsoleAgent}
          onOpenChange={(open) => !open && onDebugConsoleChange(null)}
          agentHandle={debugConsoleAgent ?? ""}
          debugEvents={debugEvents ?? []}
        />
      )}
    </Theme>
  );
}
