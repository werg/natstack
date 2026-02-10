import { Flex, Theme } from "@radix-ui/themes";
import { useChatContext } from "../context/ChatContext";
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
 * For custom layouts, use the individual components directly:
 * ```tsx
 * <ChatProvider value={chatState}>
 *   <MyCustomHeader />
 *   <ChatMessageArea />
 *   <ChatInput />
 * </ChatProvider>
 * ```
 */
export function ChatLayout() {
  const { theme } = useChatContext();

  return (
    <Theme appearance={theme}>
      <Flex direction="column" height="100vh" p="2" gap="2">
        <ChatHeader />
        <ChatDirtyRepoWarnings />
        <ChatMessageArea />
        <ChatFeedbackArea />
        <ChatInput />
      </Flex>
      <ChatDebugConsole />
    </Theme>
  );
}
