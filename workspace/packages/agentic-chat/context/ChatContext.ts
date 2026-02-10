import { createContext, useContext } from "react";
import type { ChatContextValue } from "../types";

export const ChatContext = createContext<ChatContextValue | null>(null);

/**
 * Access the chat context. Must be used within a `<ChatProvider>`.
 * Throws if used outside of a ChatProvider.
 */
export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used within a <ChatProvider>");
  }
  return ctx;
}
