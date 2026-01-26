import { useState, useRef, useEffect, useCallback } from "react";
import { Badge, Box, Button, Callout, Card, Flex, IconButton, ScrollArea, Text, TextArea, Theme } from "@radix-ui/themes";
import { PaperPlaneIcon, ImageIcon } from "@radix-ui/react-icons";
import type { Participant, AttachmentInput } from "@natstack/agentic-messaging";
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
import { type PendingImage, getImagesFromClipboard, createPendingImage, validateImageFiles } from "../utils/imageUtils";
import type { ChatMessage, ChatParticipantMetadata } from "../types";
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
  onInputChange,
  onSendMessage,
  onImagesChange,
  onAddAgent,
  onReset,
  onFeedbackDismiss,
  onFeedbackError,
  onInterrupt,
  onCallMethod,
  toolApproval,
}: ChatPhaseProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showImageInput, setShowImageInput] = useState(false);
  const [showNewContent, setShowNewContent] = useState(false);

  // Refs for scroll position tracking
  const wasNearBottomRef = useRef(true);
  const lastMessageCountRef = useRef(0);

  // Check if user is near the bottom of the scroll area
  const checkIfNearBottom = useCallback(() => {
    const viewport = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]');
    if (!viewport) return true;
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    // Consider "near bottom" if within 100px of the bottom
    return scrollHeight - scrollTop - clientHeight < 100;
  }, []);

  // Update wasNearBottom on scroll and dismiss notification if at bottom
  const handleScroll = useCallback(() => {
    const isNearBottom = checkIfNearBottom();
    wasNearBottomRef.current = isNearBottom;
    if (isNearBottom) {
      setShowNewContent(false);
    }
  }, [checkIfNearBottom]);

  // Attach scroll listener directly to viewport (Radix ScrollArea doesn't bubble scroll events)
  useEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]');
    if (!viewport) return;
    viewport.addEventListener('scroll', handleScroll);
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Handle new content: scroll to bottom or show notification
  // Note: wasNearBottomRef is updated by the scroll handler, which correctly tracks
  // the user's position BEFORE new content is added (scroll events don't fire on DOM changes)
  useEffect(() => {
    const prevCount = lastMessageCountRef.current;
    const newCount = messages.length;

    if (newCount > prevCount && prevCount > 0) {
      // New message(s) added
      if (wasNearBottomRef.current) {
        // User was at bottom - auto-scroll
        scrollRef.current?.scrollIntoView({ behavior: "smooth" });
        setShowNewContent(false);
      } else {
        // User scrolled up - show notification
        setShowNewContent(true);
      }
    } else if (newCount === prevCount && wasNearBottomRef.current) {
      // Content update (streaming) while user is at bottom - keep them there
      scrollRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    // Note: if streaming while scrolled up, we do nothing (user is reading history)

    lastMessageCountRef.current = newCount;
  }, [messages]);

  // Handler to scroll to new content when notification is clicked
  const handleScrollToNewContent = useCallback(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
    setShowNewContent(false);
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
          <Flex direction="column" gap="1" p="1">
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

                    // Handler for interrupting typing indicators
                    const handleTypingInterrupt = (senderId: string) => {
                      // Interrupt the agent - no messageId needed for typing indicators
                      onInterrupt?.(senderId);
                    };

                    return <InlineGroup key={item.key} items={inlineItems} onInterrupt={handleTypingInterrupt} />;
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
                        style={{
                          backgroundColor: isPanel
                            ? "var(--accent-9)"
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
    </Theme>
  );
}
