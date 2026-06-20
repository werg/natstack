import { useMemo } from "react";
import type { ReactNode } from "react";
import { Flex } from "@radix-ui/themes";
import { useChatContext } from "../context/ChatContext";
import { useChatInputContext } from "../context/ChatInputContext";
import { MessageList } from "./MessageList";
import { SignalPills } from "./SignalPills";

export interface ChatMessageAreaProps {
  /** Override default message card rendering */
  renderMessage?: (...args: Parameters<NonNullable<import("./MessageList").MessageListProps["renderMessage"]>>) => ReactNode;
  /** Override default inline group rendering */
  renderInlineGroup?: (...args: Parameters<NonNullable<import("./MessageList").MessageListProps["renderInlineGroup"]>>) => ReactNode;
}

/**
 * Message list area with load-earlier button.
 * Reads from ChatContext and passes to MessageList.
 */
export function ChatMessageArea({ renderMessage, renderInlineGroup }: ChatMessageAreaProps = {}) {
  const {
    messages,
    participants,
    selfId,
    allParticipants,
    inlineUiComponents,
    messageTypeComponents,
    hasMoreHistory,
    loadingMore,
    onLoadEarlierMessages,
    onInterrupt,
    onCancelInvocation,
    onFocusPanel,
    onReloadPanel,
    chat,
    browserHandoffCaller,
    clientRef,
  } = useChatContext();
  const { setReplyTo } = useChatInputContext();

  const mdxActions = useMemo(() => ({
    publishMessage: async (content: string) => {
      await chat.send(content);
    },
  }), [chat]);

  return (
    <Flex direction="column" gap="1" style={{ minHeight: 0, flexGrow: 1 }}>
      <SignalPills client={clientRef.current} />
      <MessageList
        messages={messages}
        participants={participants}
        selfId={selfId}
        allParticipants={allParticipants}
        inlineUiComponents={inlineUiComponents}
        messageTypeComponents={messageTypeComponents}
        chat={chat as unknown as Record<string, unknown>}
        browserHandoffCaller={browserHandoffCaller}
        hasMoreHistory={hasMoreHistory}
        loadingMore={loadingMore}
        onLoadEarlierMessages={onLoadEarlierMessages}
        onInterrupt={onInterrupt}
        onCancelInvocation={onCancelInvocation}
        onFocusPanel={onFocusPanel}
        onReloadPanel={onReloadPanel}
        onReply={setReplyTo}
        mdxActions={mdxActions}
        renderMessage={renderMessage}
        renderInlineGroup={renderInlineGroup}
      />
    </Flex>
  );
}
