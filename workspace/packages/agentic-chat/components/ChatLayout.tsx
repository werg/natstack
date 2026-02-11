import React from "react";
import { Flex } from "@radix-ui/themes";
import { ChatHeader } from "./ChatHeader";
import { ChatDirtyRepoWarnings } from "./ChatDirtyRepoWarnings";
import { ChatMessageArea } from "./ChatMessageArea";
import { ChatFeedbackArea } from "./ChatFeedbackArea";
import { ChatInput } from "./ChatInput";
import { ChatDebugConsole } from "./ChatDebugConsole";
import "../styles.css";

/**
 * Default full chat layout — drop-in replacement for the old ChatPhase.
 * Composes all sub-components reading from ChatContext.
 *
 * NOTE: Theme is applied in AgenticChat (above ChatProvider) so that
 * ChatLayout does NOT read from context. This prevents keystroke-driven
 * context updates (from ChatInput → setInput) from re-rendering
 * ChatLayout and triggering unnecessary Radix theme context propagation,
 * which can cause layout shifts that break autoscroll.
 *
 * For custom layouts, use the individual components directly:
 * ```tsx
 * <ChatProvider value={chatState}>
 *   <MyCustomHeader />
 *   <ChatMessageArea />
 *   <ChatInput />
 * </ChatProvider>
 * ```
 */
export const ChatLayout = React.memo(function ChatLayout() {
  return (
    <>
      <Flex direction="column" height="100vh" p="2" gap="2">
        <ChatHeader />
        <ChatDirtyRepoWarnings />
        <ChatMessageArea />
        <ChatFeedbackArea />
        <ChatInput />
      </Flex>
      <ChatDebugConsole />
    </>
  );
});
