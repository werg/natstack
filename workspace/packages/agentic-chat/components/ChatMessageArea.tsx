import { useMemo } from "react";
import type { ReactNode } from "react";
import { Flex } from "@radix-ui/themes";
import { useChatContext } from "../context/ChatContext";
import { useChatInputContext } from "../context/ChatInputContext";
import { MessageList } from "./MessageList";
import { deriveActiveOutbox } from "./Outbox";
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
    connected,
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

  // Hide exactly the active-outbox set (messages live in the queue OR the
  // transcript, never both — so a fresh send doesn't flash here and then bounce
  // to the queue). deriveActiveOutbox already keeps the right things visible:
  //  - no recipient (sent before any agent joined) → not deliverable → visible;
  //  - offline recipient → excluded → visible with an "agent offline" marker,
  //    self-resolving on return;
  //  - read messages → no longer pending → visible (graduated from the queue).
  // Until connected (replay complete), the Outbox is suppressed, so don't hide
  // anything here either — otherwise a transiently-pending historical message
  // would vanish from BOTH places mid-replay.
  const transcriptMessages = useMemo(() => {
    if (!connected) return messages;
    const hiddenIds = new Set(deriveActiveOutbox(messages, selfId, participants).map((m) => m.id));
    return hiddenIds.size > 0 ? messages.filter((m) => !hiddenIds.has(m.id)) : messages;
  }, [connected, messages, selfId, participants]);

  return (
    <Flex direction="column" gap="1" style={{ minHeight: 0, flexGrow: 1 }}>
      <SignalPills client={clientRef.current} />
      <MessageList
        messages={transcriptMessages}
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
