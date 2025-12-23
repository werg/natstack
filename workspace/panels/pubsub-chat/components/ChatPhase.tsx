import { useState, useRef, useEffect, useCallback, type ComponentType } from "react";
import { Badge, Box, Button, Callout, Card, Flex, ScrollArea, Text, TextField, Theme } from "@radix-ui/themes";
import type { Participant } from "@natstack/agentic-messaging";
import { ToolHistoryItem } from "./ToolHistoryItem";
import { FeedbackContainer } from "./FeedbackContainer";
import type { FeedbackComponentProps } from "../eval/feedbackUiTool";
import type { ChatMessage, ChatParticipantMetadata } from "../types";

// Re-export for backwards compatibility
export type { ChatMessage };

export interface ActiveFeedback {
  callId: string;
  Component: ComponentType<FeedbackComponentProps>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  createdAt: number;
  /** Cache key for cleanup after feedback completion */
  cacheKey: string;
}

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSendMessage();
    }
  };

  // Compute participant counts
  const panelCount = Object.values(participants).filter((p) => p.metadata.type === "panel").length;
  const aiResponderCount = Object.values(participants).filter((p) => p.metadata.type === "ai-responder").length;
  const claudeCodeCount = Object.values(participants).filter((p) => p.metadata.type === "claude-code").length;
  const codexCount = Object.values(participants).filter((p) => p.metadata.type === "codex").length;

  const getSenderInfo = (senderId: string) => {
    const participant = participants[senderId];
    return participant?.metadata ?? { name: "Unknown", type: "panel" as const };
  };

  return (
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
          {panelCount > 0 && (
            <Badge color="blue">
              {panelCount} Panel{panelCount !== 1 ? "s" : ""}
            </Badge>
          )}
          {aiResponderCount > 0 && (
            <Badge color="purple">
              {aiResponderCount} AI Responder{aiResponderCount !== 1 ? "s" : ""}
            </Badge>
          )}
          {claudeCodeCount > 0 && <Badge color="orange">{claudeCodeCount} Claude Code</Badge>}
          {codexCount > 0 && <Badge color="teal">{codexCount} Codex</Badge>}
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
              messages.map((msg) => {
                if (msg.kind === "tool" && msg.tool) {
                  return <ToolHistoryItem key={msg.id} entry={msg.tool} />;
                }

                const sender = getSenderInfo(msg.senderId);
                const isPanel = sender.type === "panel";
                const isStreaming = !msg.complete && !msg.error;
                return (
                  <Box
                    key={msg.id}
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
                      <Text
                        size="2"
                        style={{
                          color: isPanel ? "white" : msg.error ? "var(--red-11)" : "inherit",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {msg.error ? `Error: ${msg.error}` : msg.content || (isStreaming ? "..." : "")}
                        {isStreaming && <span className="cursor">|</span>}
                      </Text>
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
        <Theme appearance={theme}>
          <Flex direction="column" gap="2">
            {Array.from(activeFeedbacks.values()).map((feedback) => {
              // Guard against invalid/missing components
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
                  <FeedbackComponent resolveTool={feedback.resolve} rejectTool={feedback.reject} />
                </FeedbackContainer>
              );
            })}
          </Flex>
        </Theme>
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
  );
}
