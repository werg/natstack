import type { ReactNode } from "react";
import { ChatContext } from "./ChatContext";
import { ChatInputContext } from "./ChatInputContext";
import type { ChatContextValue, ChatInputContextValue } from "../types";

export interface ChatProviderProps {
  value: ChatContextValue;
  inputValue: ChatInputContextValue;
  children: ReactNode;
}

/**
 * Provides chat state and handlers to all child components via React context.
 *
 * Nests two providers:
 * - ChatContext: messages, connection, participants, etc. (infrequent updates)
 * - ChatInputContext: input text, pending images, send handler (keystroke-frequency updates)
 *
 * Usage:
 * ```tsx
 * const { contextValue, inputContextValue } = useAgenticChat({ config, channelName, tools });
 * <ChatProvider value={contextValue} inputValue={inputContextValue}>
 *   <ChatLayout />
 * </ChatProvider>
 * ```
 */
export function ChatProvider({ value, inputValue, children }: ChatProviderProps) {
  return (
    <ChatContext.Provider value={value}>
      <ChatInputContext.Provider value={inputValue}>
        {children}
      </ChatInputContext.Provider>
    </ChatContext.Provider>
  );
}
