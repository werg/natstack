import React, { useCallback } from "react";
import { Badge, Box, Card, Code, Flex, IconButton, Text } from "@radix-ui/themes";
import { CopyIcon, CheckIcon } from "@radix-ui/react-icons";
import { CONTENT_TYPE_INLINE_UI, isClientParticipantType } from "@workspace/pubsub";
import { TypingIndicator } from "./TypingIndicator";
import { MessageContent } from "./MessageContent";
import { ImageGallery } from "./ImageGallery";
import { InlineUiMessage, parseInlineUiData } from "./InlineUiMessage";
import { AgentDisconnectedMessage } from "./AgentDisconnectedMessage";
import type { ChatMessage, ChatParticipantMetadata, InlineUiComponentEntry } from "../types";
import type { MdxActionHandlers } from "./markdownComponents";

interface MessageCardProps {
  msg: ChatMessage;
  index: number;
  senderType: string;
  isStreaming: boolean;
  /** Whether this specific message was just copied (shows checkmark icon) */
  isCopied: boolean;
  inlineUiComponents?: Map<string, InlineUiComponentEntry>;
  onInterrupt: (msgId: string, senderId: string) => void;
  onCopy: (msgId: string, content: string) => void;
  onClearCopied: (msgId: string) => void;
  onFocusPanel?: (panelId: string) => void;
  onReloadPanel?: (panelId: string) => void;
  mdxActions?: MdxActionHandlers;
}

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
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
  onClearCopied,
  onFocusPanel,
  onReloadPanel,
  mdxActions,
}: MessageCardProps) {
  const key = msg.id || `fallback-msg-${index}`;

  // Per-message closures — created inside the memo boundary
  const handleInterrupt = useCallback(() => {
    onInterrupt(msg.id, msg.senderId);
  }, [onInterrupt, msg.id, msg.senderId]);

  const handleCopy = useCallback(() => {
    void onCopy(msg.id, msg.content);
  }, [onCopy, msg.id, msg.content]);
  const handleClearCopied = useCallback(() => {
    onClearCopied(msg.id);
  }, [onClearCopied, msg.id]);

  // Handle inline_ui messages
  if (msg.contentType === CONTENT_TYPE_INLINE_UI) {
    const data = msg.inlineUi ?? parseInlineUiData(msg.content);
    if (data) {
      const compiled = inlineUiComponents?.get(data.id);
      return (
        <Box
          key={key}
          className="message-row message-row-agent"
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
        className="message-row message-row-system"
      >
        <AgentDisconnectedMessage
          agent={msg.disconnectedAgent}
          onFocusPanel={onFocusPanel}
          onReloadPanel={onReloadPanel}
        />
      </Box>
    );
  }

  if (msg.contentType === "approval" && msg.approval) {
    const approval = msg.approval;
    const color = approval.status === "granted"
      ? "green"
      : approval.status === "denied"
        ? "red"
        : "amber";
    const title = approval.status === "granted"
      ? "Approved"
      : approval.status === "denied"
        ? "Denied"
        : "Approval requested";
    return (
      <Box
        key={key}
        className="message-row message-row-agent"
      >
        <Card className="message-card">
          <Flex direction="column" gap="2">
            <Flex align="center" gap="2" wrap="wrap">
              <Badge color={color} size="1" variant="soft">
                {title}
              </Badge>
            </Flex>
            {approval.question && (
              <Text size="2" style={{ whiteSpace: "pre-wrap" }}>
                {approval.question}
              </Text>
            )}
            {approval.reason && (
              <Text size="1" color={color} style={{ whiteSpace: "pre-wrap" }}>
                {approval.reason}
              </Text>
            )}
          </Flex>
        </Card>
      </Box>
    );
  }

  // Client messages (panel, headless) render right-aligned in the user-side
  // styling. Agent messages render left-aligned in the agent styling.
  const isClient = isClientParticipantType(senderType);
  const hasError = Boolean(msg.error);
  const hasContent = msg.content.length > 0;
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  return (
    <Box
      className={classNames("message-row", isClient ? "message-row-client" : "message-row-agent")}
    >
      <Card
        className={classNames(
          "message-card",
          isClient && "message-card-client",
          hasError && "message-card-error",
        )}
        style={{
          opacity: msg.pending ? 0.7 : 1,
        }}
      >
        <Flex className="message-card-body" direction="column" gap="2">
          {hasContent && (
            <Box className="message-content">
              <MessageContent
                content={msg.content}
                isStreaming={isStreaming}
                mdxActions={mdxActions}
              />
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
              onBlur={handleClearCopied}
              onPointerLeave={handleClearCopied}
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
