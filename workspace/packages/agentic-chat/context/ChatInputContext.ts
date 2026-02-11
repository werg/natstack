import { createContext, useContext } from "react";
import type { ChatInputContextValue } from "../types";

export const ChatInputContext = createContext<ChatInputContextValue | null>(null);

/**
 * Access the chat input context. Must be used within a `<ChatProvider>`.
 * Throws if used outside of a ChatProvider.
 */
export function useChatInputContext(): ChatInputContextValue {
  const ctx = useContext(ChatInputContext);
  if (!ctx) {
    throw new Error("useChatInputContext must be used within a <ChatProvider>");
  }
  return ctx;
}
