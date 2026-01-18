import { useState, useRef, useEffect, useCallback } from "react";
import { Badge, Box, Button, Callout, Card, Flex, ScrollArea, Text, TextArea, Theme } from "@radix-ui/themes";
import { PaperPlaneIcon } from "@radix-ui/react-icons";
import type { Participant } from "@natstack/agentic-messaging";
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
import type { ChatMessage, ChatParticipantMetadata } from "../types";
import "../styles.css";

// Re-export for backwards compatibility
export type { ChatMessage };

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
  onInputChange: (value: string) => void;
  onSendMessage: () => Promise<void>;
  onAddAgent: () => void;
  onReset: () => void;
  onFeedbackDismiss: (callId: string) => void;
  onFeedbackError: (callId: string, error: Error) => void;
  onInterrupt?: (agentId: string, messageId: string) => void;
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
  onInputChange,
  onSendMessage,
  onAddAgent,
  onReset,
  onFeedbackDismiss,
  onFeedbackError,
  onInterrupt,
  onCallMethod,
  toolApproval,
}: ChatPhaseProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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

  const handleSendMessage = useCallback(async () => {
    try {
      setSendError(null);
      await onSendMessage();
      // Reset textarea height after sending
      if (textAreaRef.current) {
        textAreaRef.current.style.height = "auto";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSendError(message);
      console.error("Failed to send message:", error);
    }
  }, [onSendMessage]);

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
      <Flex direction="column" style={{ height: "100vh", padding: 16 }} gap="3">
      {/* Header */}
      <Flex justify="between" align="center">
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
          <Button variant="soft" size="1" onClick={onAddAgent}>
            Add Agent
          </Button>
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
      <Card style={{ flex: 1, overflow: "hidden" }}>
        <ScrollArea style={{ height: "100%" }}>
          <Flex direction="column" gap="2" p="3">
            {messages.length === 0 ? (
              <Text color="gray" size="2">
                Send a message to start chatting
              </Text>
            ) : (
              (() => {
                // Helper to determine if a message is an inline item (thinking, action, or method)
                type InlineItemType = "thinking" | "action" | "method";
                function getInlineItemType(msg: ChatMessage): InlineItemType | null {
                  if (msg.kind === "method" && msg.method) return "method";
                  if (msg.contentType === "thinking") return "thinking";
                  if (msg.contentType === "action") return "action";
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
                      // This shouldn't happen but handle gracefully
                      return {
                        type: "thinking" as const,
                        id: msg.id,
                        content: msg.content || "Unknown",
                        complete: msg.complete ?? false,
                      };
                    });
                    return <InlineGroup key={item.key} items={inlineItems} />;
                  }

                  const { msg, index } = item;
                  // Debug log to track key issues
                  if (!msg.id) {
                    console.warn(`[ChatPhase] Message at index ${index} has no id:`, msg);
                  }

                  const sender = getSenderInfo(msg.senderId);
                  const isPanel = sender.type === "panel";
                  // Only show streaming for messages that are actively being streamed (not pending local messages)
                  const isStreaming = msg.kind === "message" && !msg.complete && !msg.pending;
                  const hasError = Boolean(msg.error);
                  const hasContent = msg.content.length > 0;

                  // Skip empty completed messages (initial placeholder messages that never received content)
                  if (!hasContent && !isStreaming && !hasError) {
                    return null;
                  }

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
                          {hasError && (
                            <Text size="2" style={{ color: "var(--red-11)", whiteSpace: "pre-wrap" }}>
                              {`Error: ${msg.error}`}
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
      </Card>

      {activeFeedbacks.size > 0 && (
        <Flex direction="column" gap="2">
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
        <Callout.Root color="red" size="1">
          <Callout.Text>
            Failed to send: {sendError}
          </Callout.Text>
        </Callout.Root>
      )}

      {/* Input */}
      <Box
        style={{
          position: "relative",
          display: "flex",
          alignItems: "flex-end",
          background: "var(--color-surface)",
          borderRadius: "var(--radius-3)",
        }}
      >
        <TextArea
          ref={textAreaRef}
          style={{
            flex: 1,
            minHeight: "40px",
            maxHeight: "200px",
            resize: "none",
          }}
          placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!connected}
        />
        <Button
          onClick={() => void handleSendMessage()}
          disabled={!connected || !input.trim()}
          size="1"
          style={{
            marginLeft: "8px",
            marginBottom: "8px",
            marginRight: "8px",
            flexShrink: 0,
          }}
        >
          <PaperPlaneIcon />
        </Button>
      </Box>
      </Flex>
    </Theme>
  );
}
