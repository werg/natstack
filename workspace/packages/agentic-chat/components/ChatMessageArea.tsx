import { useMemo } from "react";
import type { ReactNode } from "react";
import { useChatContext } from "../context/ChatContext";
import { MessageList } from "./MessageList";

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
    hasMoreHistory,
    loadingMore,
    onLoadEarlierMessages,
    onInterrupt,
    onFocusPanel,
    onReloadPanel,
    chat,
  } = useChatContext();

  const mdxActions = useMemo(() => ({
    publishMessage: (content: string) => chat.publish("message", { content }),
  }), [chat]);

  return (
    <MessageList
      messages={messages}
      participants={participants}
      selfId={selfId}
      allParticipants={allParticipants}
      inlineUiComponents={inlineUiComponents}
      hasMoreHistory={hasMoreHistory}
      loadingMore={loadingMore}
      onLoadEarlierMessages={onLoadEarlierMessages}
      onInterrupt={onInterrupt}
      onFocusPanel={onFocusPanel}
      onReloadPanel={onReloadPanel}
      mdxActions={mdxActions}
      renderMessage={renderMessage}
      renderInlineGroup={renderInlineGroup}
    />
  );
}
