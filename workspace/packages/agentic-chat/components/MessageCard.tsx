import React, { useCallback, useState } from "react";
import { Badge, Box, Button, Card, Code, Flex, IconButton, Text } from "@radix-ui/themes";
import { CopyIcon, CheckIcon, ChatBubbleIcon, ReloadIcon } from "@radix-ui/react-icons";
import { CONTENT_TYPE_INLINE_UI, isClientParticipantType } from "@workspace/pubsub";
import { TypingIndicator } from "./TypingIndicator";
import { MessageContent } from "./MessageContent";
import { ImageGallery } from "./ImageGallery";
import { InlineUiMessage, parseInlineUiData } from "./InlineUiMessage";
import { AgentDisconnectedMessage } from "./AgentDisconnectedMessage";
import { CustomMessageCard } from "./CustomMessage";
import ModelCredentialRequiredCard from "./ModelCredentialRequiredCard";
import type {
  BrowserHandoffCaller,
  ChannelParticipantId,
  ChatMessage,
  InlineUiComponentEntry,
  MessageTypeComponentEntry,
} from "../types";
import type { SenderInfo } from "./MessageList";
import type { MdxActionHandlers } from "./markdownComponents";

interface MessageCardProps {
  msg: ChatMessage;
  index: number;
  selfId: ChannelParticipantId | null;
  senderType: string;
  senderInfo: SenderInfo;
  mentionLabels: string[];
  replyContext?: { id: string; senderName: string; snippet: string };
  isStreaming: boolean;
  /** Whether this specific message was just copied (shows checkmark icon) */
  isCopied: boolean;
  inlineUiComponents?: Map<string, InlineUiComponentEntry>;
  messageTypeComponents?: Map<string, MessageTypeComponentEntry>;
  chat?: Record<string, unknown>;
  browserHandoffCaller?: BrowserHandoffCaller;
  scope?: Record<string, unknown>;
  scopes?: Record<string, unknown>;
  onInterrupt: (msgId: string, senderId: string) => void;
  onCopy: (msgId: string, content: string) => void;
  onClearCopied: (msgId: string) => void;
  onReply?: (msgId: string) => void;
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
  selfId,
  senderType,
  senderInfo,
  mentionLabels,
  replyContext,
  isStreaming,
  isCopied,
  inlineUiComponents,
  messageTypeComponents,
  chat = {},
  browserHandoffCaller,
  scope = {},
  scopes = {},
  onInterrupt,
  onCopy,
  onClearCopied,
  onReply,
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
  const handleReply = useCallback(() => {
    onReply?.(msg.id);
  }, [onReply, msg.id]);
  const [resumeScheduleState, setResumeScheduleState] = useState<
    "idle" | "scheduling" | "scheduled" | "failed"
  >("idle");
  const handleScheduleResumeAtReset = useCallback(async () => {
    const diagnostic = msg.diagnostic;
    const callMethod = chat["callMethod"];
    if (!diagnostic?.messageId || !diagnostic.resetAt || typeof callMethod !== "function") {
      return;
    }
    setResumeScheduleState("scheduling");
    try {
      const result = await (
        callMethod as (participantId: string, method: string, args: unknown) => Promise<unknown>
      )(msg.senderId, "scheduleResumeAtReset", {
        messageId: diagnostic.messageId,
        resetAt: diagnostic.resetAt,
      });
      const scheduled =
        !!result &&
        typeof result === "object" &&
        (result as { scheduled?: unknown }).scheduled === true;
      setResumeScheduleState(scheduled ? "scheduled" : "failed");
    } catch {
      setResumeScheduleState("failed");
    }
  }, [chat, msg.diagnostic, msg.senderId]);

  // Handle inline_ui messages
  if (msg.contentType === CONTENT_TYPE_INLINE_UI) {
    const data = msg.inlineUi ?? parseInlineUiData(msg.content);
    if (data) {
      const compiled = inlineUiComponents?.get(data.id);
      return (
        <Box key={key} className="message-row message-row-agent">
          <InlineUiMessage
            data={data}
            compiledComponent={compiled?.Component}
            compilationError={compiled?.error}
          />
        </Box>
      );
    }
  }

  // Model credential connect card — rendered from the channel's unresolved
  // credential requests (agentic.credential-connect.v1 envelopes).
  if (msg.contentType === "credential-connect" && msg.credentialRequest) {
    const request = msg.credentialRequest;
    return (
      <Box key={key} className="message-row message-row-system">
        <ModelCredentialRequiredCard
          props={{
            ...(request.connectSpec as Record<string, unknown>),
            providerId: request.providerId,
            ...(request.modelBaseUrl ? { modelBaseUrl: request.modelBaseUrl } : {}),
            ...(request.reason ? { reason: request.reason } : {}),
            ...(request.failureCode ? { failureCode: request.failureCode } : {}),
            agentParticipantId: request.agentParticipantId,
            ...(selfId ? { modelPersistenceParticipantId: selfId } : {}),
            ...(browserHandoffCaller
              ? {
                  browserHandoffCallerId: browserHandoffCaller.id,
                  browserHandoffCallerKind: browserHandoffCaller.kind,
                }
              : {}),
          }}
          chat={
            chat as {
              callMethod: (
                participantId: string,
                method: string,
                args: unknown
              ) => Promise<unknown>;
            }
          }
        />
      </Box>
    );
  }

  // Handle system messages (e.g., agent disconnection notifications)
  if (msg.kind === "system" && msg.disconnectedAgent) {
    return (
      <Box key={key} className="message-row message-row-system">
        <AgentDisconnectedMessage
          agent={msg.disconnectedAgent}
          onFocusPanel={onFocusPanel}
          onReloadPanel={onReloadPanel}
        />
      </Box>
    );
  }

  if (msg.contentType === "lifecycle" && msg.lifecycle) {
    const color =
      msg.lifecycle.status === "recovered"
        ? "green"
        : msg.lifecycle.status === "failed"
          ? "red"
          : "amber";
    const badgeLabel =
      msg.lifecycle.status === "recovered"
        ? "Recovered"
        : msg.lifecycle.status === "failed"
          ? "Recovery failed"
          : msg.lifecycle.status === "waiting"
            ? "Waiting"
            : "Interrupted";
    return (
      <Box key={key} className="message-row message-row-system">
        <Card className="message-card message-card-lifecycle">
          <Flex align="start" gap="2">
            <Box className="message-lifecycle-icon" aria-hidden="true">
              <ReloadIcon />
            </Box>
            <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
              <Flex align="center" gap="2" wrap="wrap">
                <Badge color={color} size="1" variant="soft">
                  {badgeLabel}
                </Badge>
                <Text size="2" weight="medium">
                  {msg.lifecycle.title}
                </Text>
              </Flex>
              {(msg.lifecycle.detail || msg.content) && (
                <Text size="1" color="gray" style={{ whiteSpace: "pre-wrap" }}>
                  {msg.lifecycle.detail ?? msg.content}
                </Text>
              )}
            </Flex>
          </Flex>
        </Card>
      </Box>
    );
  }

  if (msg.contentType === "diagnostic" && msg.diagnostic) {
    const color =
      msg.diagnostic.severity === "error"
        ? "red"
        : msg.diagnostic.severity === "warning"
          ? "amber"
          : "blue";
    return (
      <Box key={key} className="message-row message-row-system">
        <Card className="message-card message-card-lifecycle">
          <Flex align="start" gap="2">
            <Box className="message-lifecycle-icon" aria-hidden="true">
              <ChatBubbleIcon />
            </Box>
            <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
              <Flex align="center" gap="2" wrap="wrap">
                <Badge color={color} size="1" variant="soft">
                  {msg.diagnostic.severity === "error"
                    ? "Error"
                    : msg.diagnostic.severity === "warning"
                      ? "Notice"
                      : "Info"}
                </Badge>
                <Text size="2" weight="medium">
                  {msg.diagnostic.title}
                </Text>
              </Flex>
              {(msg.diagnostic.detail || msg.content) && (
                <Text size="1" color="gray" style={{ whiteSpace: "pre-wrap" }}>
                  {msg.diagnostic.detail ?? msg.content}
                </Text>
              )}
              {msg.diagnostic.resetAt && msg.diagnostic.messageId && (
                <Flex align="center" gap="2" wrap="wrap">
                  <Button
                    size="1"
                    variant="soft"
                    color={resumeScheduleState === "failed" ? "red" : "blue"}
                    disabled={
                      resumeScheduleState === "scheduling" || resumeScheduleState === "scheduled"
                    }
                    onClick={handleScheduleResumeAtReset}
                    title="Resume this turn when the provider limit resets"
                  >
                    <ReloadIcon />
                    {resumeScheduleState === "scheduling"
                      ? "Scheduling"
                      : resumeScheduleState === "scheduled"
                        ? "Scheduled"
                        : resumeScheduleState === "failed"
                          ? "Retry scheduling"
                          : "Resume at reset"}
                  </Button>
                </Flex>
              )}
            </Flex>
          </Flex>
        </Card>
      </Box>
    );
  }

  if (msg.contentType === "approval" && msg.approval) {
    const approval = msg.approval;
    const color =
      approval.status === "granted" ? "green" : approval.status === "denied" ? "red" : "amber";
    const title =
      approval.status === "granted"
        ? "Approved"
        : approval.status === "denied"
          ? "Denied"
          : "Approval requested";
    return (
      <Box key={key} className="message-row message-row-agent">
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

  const custom = msg.contentType === "custom" ? msg.custom : undefined;
  if (custom && custom.displayMode !== "inline") {
    return (
      <Box key={key} className="message-row message-row-agent">
        <CustomMessageCard
          payload={custom}
          entry={messageTypeComponents?.get(custom.typeId)}
          chat={chat}
          scope={scope}
          scopes={scopes}
        />
      </Box>
    );
  }

  // Client messages (panel, headless) render right-aligned in the user-side
  // styling. Agent messages render left-aligned in the agent styling.
  const isClient = isClientParticipantType(senderType);
  const hasError = Boolean(msg.error);
  const hasContent = msg.content.length > 0;
  const hasAttachments = msg.attachments && msg.attachments.length > 0;
  // Tier 2 (secondary salience) renders slighter — see styles.css. Absent ⇒ tier 1.
  const isSecondary = msg.tier === "secondary";

  return (
    <Box
      id={`message-${msg.id}`}
      data-message-tier={msg.tier ?? "primary"}
      className={classNames(
        "message-row",
        isClient ? "message-row-client" : "message-row-agent",
        isSecondary && "message-row-tier2"
      )}
    >
      <Card
        className={classNames(
          "message-card",
          isClient && "message-card-client",
          hasError && "message-card-error",
          isSecondary && "message-card-tier2"
        )}
        style={{
          opacity: msg.pending ? 0.7 : 1,
        }}
      >
        <Flex className="message-card-body" direction="column" gap="2">
          <Flex align="center" justify="between" gap="2">
            <Box style={{ minWidth: 0 }}>
              <Text size="1" weight="medium" truncate>
                {senderInfo.name}
              </Text>
              <Text as="span" size="1" color="gray" style={{ marginLeft: 6 }}>
                @{senderInfo.handle}
              </Text>
            </Box>
            {onReply && hasContent && !isStreaming && (
              <IconButton
                className="copy-button"
                size="1"
                variant="ghost"
                color="gray"
                onClick={handleReply}
                title="Reply"
              >
                <ChatBubbleIcon />
              </IconButton>
            )}
          </Flex>
          {replyContext && (
            <Box
              asChild
              style={{
                borderLeft: "2px solid var(--gray-a7)",
                paddingLeft: 8,
                cursor: "pointer",
              }}
            >
              <a href={`#message-${replyContext.id}`}>
                <Text size="1" color="gray" truncate>
                  Replying to {replyContext.senderName}: {replyContext.snippet}
                </Text>
              </a>
            </Box>
          )}
          {mentionLabels.length > 0 && (
            <Flex gap="1" wrap="wrap">
              {mentionLabels.map((label) => (
                <Badge key={label} size="1" variant="soft" color="blue">
                  @{label}
                </Badge>
              ))}
            </Flex>
          )}
          {hasContent && (
            <Box className="message-content">
              <MessageContent
                content={msg.content}
                isStreaming={isStreaming}
                mdxActions={mdxActions}
              />
            </Box>
          )}
          {hasAttachments && <ImageGallery attachments={msg.attachments!} />}
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
