import { useState, useRef, useEffect, useCallback, type ComponentType } from "react";
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
import type { ChatMessage, ChatParticipantMetadata } from "../types";
import { AgentDisconnectedMessage } from "./AgentDisconnectedMessage";
import { AgentDebugConsole } from "./AgentDebugConsole";
import "../styles.css";

// Re-export for backwards compatibility
export type { ChatMessage };

const MAX_IMAGE_COUNT = 10;

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
  onInterrupt?: (agentId: string, messageId?: string) => void;
  onCallMethod?: (providerId: string, methodName: string, args: unknown) => void;
  /** Focus a disconnected agent's panel */
  onFocusPanel?: (panelId: string) => void;
  /** Reload a disconnected agent's panel */
  onReloadPanel?: (panelId: string) => void;
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
  debugEvents,
  debugConsoleAgent,
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

  // Refs for scroll position tracking
  const lastMessageCountRef = useRef(0);
  const userScrolledAwayRef = useRef(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getViewport = useCallback(() => {
    return scrollAreaRef.current?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]') ?? null;
  }, []);

  // Check if user is near the bottom of the scroll area
  // Returns null if viewport not found (unknown state - don't make assumptions)
  const checkIfNearBottom = useCallback((): boolean | null => {
    const viewport = getViewport();
    if (!viewport) return null;
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    // Consider "near bottom" if within 20px of the bottom (tight threshold to avoid
    // false positives when user has scrolled up even slightly)
    return scrollHeight - scrollTop - clientHeight < 20;
  }, [getViewport]);

  // Handle scroll events - keep track of whether the user left the bottom
  const handleScroll = useCallback(() => {
    const isNearBottom = checkIfNearBottom();
    // If we can't determine scroll position, don't change state
    if (isNearBottom === null) return;

    if (isNearBottom) {
      // User scrolled back to bottom
      userScrolledAwayRef.current = false;
      setShowNewContent(false);
    } else {
      // User scrolled away from bottom
      userScrolledAwayRef.current = true;
    }
  }, [checkIfNearBottom]);

  // Attach scroll listener directly to viewport (Radix ScrollArea doesn't bubble scroll events)
  useEffect(() => {
    const viewport = getViewport();
    if (!viewport) return;
    viewport.addEventListener('scroll', handleScroll);
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, [getViewport, handleScroll]);

  // Cleanup scroll timeout on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  // Auto-scroll helper (throttled for streaming updates)
  const autoScrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    // Cancel any pending timeout from a previous scroll
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    userScrolledAwayRef.current = false;
    const viewport = getViewport();
    if (viewport) {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    } else {
      scrollRef.current?.scrollIntoView({ behavior });
    }

    // Clear throttle after the scroll settles
    scrollTimeoutRef.current = setTimeout(() => {
      scrollTimeoutRef.current = null;
    }, behavior === "smooth" ? 500 : 100);
  }, [getViewport]);

  // Handle new content: stick to bottom only if the user hasn't scrolled away
  useEffect(() => {
    const prevCount = lastMessageCountRef.current;
    const newCount = messages.length;

    // Only auto-scroll when the user hasn't scrolled away from the bottom
    const shouldAutoScroll = !userScrolledAwayRef.current;

    if (newCount > prevCount && prevCount > 0) {
      // New message(s) added
      if (shouldAutoScroll) {
        // User is at bottom - auto-scroll
        autoScrollToBottom();
        setShowNewContent(false);
      } else {
        // User scrolled up - show notification
        setShowNewContent(true);
      }
    } else if (newCount === prevCount && newCount > 0 && shouldAutoScroll) {
      // Content update (streaming) while user is at bottom - keep them there
      // Only trigger a new scroll if we're not already in the middle of one
      // This naturally throttles rapid streaming updates
      if (!scrollTimeoutRef.current) {
        autoScrollToBottom();
      }
    }
    // Note: if streaming while scrolled up, we do nothing (user is reading history)

    lastMessageCountRef.current = newCount;
  }, [messages, autoScrollToBottom]);

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
      onInterrupt?.(senderId, msgId);
    },
    [onInterrupt]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSendMessage();
    }
  };

  const getSenderInfo = (senderId: string) => {
    const participant = participants[senderId];
    return participant?.metadata ?? { name: "Unknown", type: "panel" as const, handle: "unknown" };
  };

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
              (() => {
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

                // Group consecutive inline items (thinking, action, method)
                const groupedItems: Array<
                  | { type: "inline-group"; items: Array<{ msg: ChatMessage; index: number }>; key: string }
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
                      groupedItems.push({
                        type: "inline-group",
                        items: currentInlineGroup,
                        key: `inline-group-${currentInlineGroup[0].msg.id || currentInlineGroup[0].index}`,
                      });
                      currentInlineGroup = [];
                    }
                    groupedItems.push({ type: "message", msg, index });
                  }
                });

                // Flush final inline group
                if (currentInlineGroup.length > 0) {
                  groupedItems.push({
                    type: "inline-group",
                    items: currentInlineGroup,
                    key: `inline-group-${currentInlineGroup[0].msg.id || currentInlineGroup[0].index}`,
                  });
                }

                return groupedItems.map((item) => {
                  if (item.type === "inline-group") {
                    // Convert to InlineItem format
                    const inlineItems: InlineItem[] = item.items.map(({ msg }) => {
                      if (msg.kind === "method" && msg.method) {
                        return { type: "method" as const, entry: msg.method };
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
                      // This shouldn't happen but handle gracefully
                      return {
                        type: "thinking" as const,
                        id: msg.id,
                        content: msg.content || "Unknown",
                        complete: msg.complete ?? false,
                      };
                    });

                    // Deduplicate action/method items: prefer action over method when both exist for the same tool
                    // This handles the case where an action message and a method-call event are both created
                    // for the same conceptual tool call (e.g., when MCP tools delegate to pubsub methods)
                    const actionToolNames = new Set<string>();
                    for (const item of inlineItems) {
                      if (item.type === "action") {
                        actionToolNames.add(prettifyToolName(item.data.type));
                      }
                    }
                    const deduplicatedItems = inlineItems.filter((item) => {
                      if (item.type === "method") {
                        const methodToolName = prettifyToolName(item.entry.methodName);
                        // Skip method items that have a corresponding action with the same tool name
                        if (actionToolNames.has(methodToolName)) {
                          return false;
                        }
                      }
                      return true;
                    });

                    // Handler for interrupting typing indicators
                    const handleTypingInterrupt = (senderId: string) => {
                      // Interrupt the agent - no messageId needed for typing indicators
                      onInterrupt?.(senderId);
                    };

                    return <InlineGroup key={item.key} items={deduplicatedItems} onInterrupt={handleTypingInterrupt} />;
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
                });
              })()
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
