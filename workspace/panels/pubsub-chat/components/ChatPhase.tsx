import { useState, useRef, useEffect, useCallback, type ComponentType } from "react";
import { Badge, Box, Button, Callout, Card, Flex, ScrollArea, Text, TextField, Theme } from "@radix-ui/themes";
import type { Participant } from "@natstack/agentic-messaging";
import type { FieldDefinition, FieldValue } from "@natstack/runtime";
import { MethodHistoryItem } from "./MethodHistoryItem";
import { FeedbackContainer } from "./FeedbackContainer";
import { FeedbackFormRenderer } from "./FeedbackFormRenderer";
import { TypingIndicator } from "./TypingIndicator";
import { MessageContent } from "./MessageContent";
import { ParticipantBadgeMenu } from "./ParticipantBadgeMenu";
import type { FeedbackComponentProps, FeedbackResult } from "../eval/feedbackUiTool";
import type { ChatMessage, ChatParticipantMetadata } from "../types";
import "../styles.css";

// Re-export for backwards compatibility
export type { ChatMessage };

/**
 * Base interface for active feedback items
 */
interface ActiveFeedbackBase {
  callId: string;
  /** Complete the feedback with a result (submit, cancel, or error) */
  complete: (result: FeedbackResult) => void;
  createdAt: number;
}

/**
 * TSX code-based feedback (compiled React component)
 */
export interface ActiveFeedbackTsx extends ActiveFeedbackBase {
  type: "tsx";
  Component: ComponentType<FeedbackComponentProps>;
  /** Cache key for cleanup after feedback completion */
  cacheKey: string;
}

/**
 * Schema-based feedback (uses FormRenderer)
 */
export interface ActiveFeedbackSchema extends ActiveFeedbackBase {
  type: "schema";
  title: string;
  fields: FieldDefinition[];
  values: Record<string, FieldValue>;
  submitLabel?: string;
  cancelLabel?: string;
}

/**
 * Discriminated union of all feedback types
 */
export type ActiveFeedback = ActiveFeedbackTsx | ActiveFeedbackSchema;

interface ChatPhaseProps {
  channelId: string | null;
  connected: boolean;
  status: string;
  messages: ChatMessage[];
  input: string;
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  activeFeedbacks: Map<string, ActiveFeedback>;
  theme: "light" | "dark";
  onInputChange: (value: string) => void;
  onSendMessage: () => Promise<void>;
  onAddAgent: () => void;
  onReset: () => void;
  onFeedbackDismiss: (callId: string) => void;
  onFeedbackError: (callId: string, error: Error) => void;
  onInterrupt?: (agentId: string, messageId: string) => void;
  onCallMethod?: (providerId: string, methodName: string, args: unknown) => void;
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
  onInputChange,
  onSendMessage,
  onAddAgent,
  onReset,
  onFeedbackDismiss,
  onFeedbackError,
  onInterrupt,
  onCallMethod,
}: ChatPhaseProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
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

  const handleSendMessage = useCallback(async () => {
    try {
      setSendError(null);
      await onSendMessage();
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
              />
            );
          })}
          <Button variant="soft" size="1" onClick={onAddAgent}>
            Add Agent
          </Button>
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
              messages.map((msg, index) => {
                // Debug log to track key issues
                if (!msg.id) {
                  console.warn(`[ChatPhase] Message at index ${index} has no id:`, msg);
                }

                if (msg.kind === "method" && msg.method) {
                  return <MethodHistoryItem key={msg.id || `fallback-method-${index}`} entry={msg.method} />;
                }

                const sender = getSenderInfo(msg.senderId);
                const isPanel = sender.type === "panel";
                // Only show streaming for messages that are actively being streamed (not pending local messages)
                const isStreaming = msg.kind === "message" && !msg.complete && !msg.pending;
                const hasError = Boolean(msg.error);
                const hasContent = msg.content.length > 0;

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
              })
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

      {/* Error display */}
      {sendError && (
        <Callout.Root color="red" size="1">
          <Callout.Text>
            Failed to send: {sendError}
          </Callout.Text>
        </Callout.Root>
      )}

      {/* Input */}
      <Flex gap="2">
        <TextField.Root
          style={{ flex: 1 }}
          placeholder="Type a message..."
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!connected}
        />
        <Button onClick={() => void handleSendMessage()} disabled={!connected || !input.trim()}>
          Send
        </Button>
      </Flex>
      </Flex>
    </Theme>
  );
}
