import React, { useCallback, type ComponentType } from "react";
import { Box, Card, Flex, IconButton, Text } from "@radix-ui/themes";
import { CopyIcon, CheckIcon } from "@radix-ui/react-icons";
import { CONTENT_TYPE_INLINE_UI } from "@workspace/agentic-messaging/utils";
import { TypingIndicator } from "./TypingIndicator";
import { MessageContent } from "./MessageContent";
import { ImageGallery } from "./ImageGallery";
import { InlineUiMessage, parseInlineUiData } from "./InlineUiMessage";
import { AgentDisconnectedMessage } from "./AgentDisconnectedMessage";
import type { ChatMessage, ChatParticipantMetadata } from "../types";

interface MessageCardProps {
  msg: ChatMessage;
  index: number;
  senderType: string;
  isStreaming: boolean;
  /** Whether this specific message was just copied (shows checkmark icon) */
  isCopied: boolean;
  inlineUiComponents?: Map<string, {
    Component?: ComponentType<{ props: Record<string, unknown> }>;
    cacheKey: string;
    error?: string;
  }>;
  onInterrupt: (msgId: string, senderId: string) => void;
  onCopy: (msgId: string, content: string) => void;
  onFocusPanel?: (panelId: string) => void;
  onReloadPanel?: (panelId: string) => void;
}

/**
 * Individual message card — wrapped in React.memo so it only re-renders
 * when its own message data or relevant callbacks change.
 * Closures for onInterrupt/onCopy are created here (inside the memo boundary)
 * so they don't cause parent-level re-renders.
 */
export const MessageCard = React.memo(function MessageCard({
  msg,
  index,
  senderType,
  isStreaming,
  isCopied,
  inlineUiComponents,
  onInterrupt,
  onCopy,
  onFocusPanel,
  onReloadPanel,
}: MessageCardProps) {
  const key = msg.id || `fallback-msg-${index}`;

  // Per-message closures — created inside the memo boundary
  const handleInterrupt = useCallback(() => {
    onInterrupt(msg.id, msg.senderId);
  }, [onInterrupt, msg.id, msg.senderId]);

  const handleCopy = useCallback(() => {
    void onCopy(msg.id, msg.content);
  }, [onCopy, msg.id, msg.content]);

  // Skip completed typing indicators
  if (msg.contentType === "typing" && msg.complete) {
    return null;
  }

  // Handle inline_ui messages
  if (msg.contentType === CONTENT_TYPE_INLINE_UI) {
    const data = parseInlineUiData(msg.content);
    if (data) {
      const compiled = inlineUiComponents?.get(data.id);
      return (
        <Box
          key={key}
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
        key={key}
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

  const isPanel = senderType === "panel";
  const hasError = Boolean(msg.error);
  const hasContent = msg.content.length > 0;
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  return (
    <Box
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
              onInterrupt={handleInterrupt}
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
              onClick={handleCopy}
              title="Copy message"
            >
              {isCopied ? <CheckIcon /> : <CopyIcon />}
            </IconButton>
          )}
        </Flex>
      </Card>
    </Box>
  );
});
