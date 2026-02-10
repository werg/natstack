import type { ReactNode } from "react";
import { ChatContext } from "./ChatContext";
import type { ChatContextValue } from "../types";

export interface ChatProviderProps {
  value: ChatContextValue;
  children: ReactNode;
}

/**
 * Provides chat state and handlers to all child components via React context.
 *
 * Usage:
 * ```tsx
 * const chat = useAgenticChat({ config, channelName, tools });
 * <ChatProvider value={chat}>
 *   <ChatLayout />
 * </ChatProvider>
 * ```
 */
export function ChatProvider({ value, children }: ChatProviderProps) {
  return (
    <ChatContext.Provider value={value}>
      {children}
    </ChatContext.Provider>
  );
}
