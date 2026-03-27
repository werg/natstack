/**
 * MessageState — Imperative wrapper around the message window reducer.
 *
 * Provides the same dedup/trim/pagination logic as the React useReducer
 * version, but usable from headless contexts.
 */

import {
  messageWindowReducer,
  messageWindowInitialState,
  type MessageWindowState,
  type MessageWindowAction,
} from "./message-reducer.js";
import type { ChatMessage } from "./types.js";

export type MessagesChangeHandler = (messages: readonly ChatMessage[]) => void;

export class MessageState {
  private state: MessageWindowState = { ...messageWindowInitialState };
  private onChange: MessagesChangeHandler;

  constructor(onChange: MessagesChangeHandler) {
    this.onChange = onChange;
  }

  get messages(): readonly ChatMessage[] {
    return this.state.messages;
  }

  get oldestLoadedId(): number | null {
    return this.state.oldestLoadedId;
  }

  get paginationExhausted(): boolean {
    return this.state.paginationExhausted;
  }

  get window(): Readonly<MessageWindowState> {
    return this.state;
  }

  dispatch(action: MessageWindowAction): void {
    const prev = this.state;
    this.state = messageWindowReducer(prev, action);
    if (this.state !== prev) {
      this.onChange(this.state.messages);
    }
  }

  /** Convenience: update messages with a replace updater (matches React setState signature) */
  setMessages(updater: (prev: ChatMessage[]) => ChatMessage[]): void {
    this.dispatch({ type: "replace", updater });
  }

  /** Convenience: prepend older messages (pagination) */
  prepend(olderMessages: ChatMessage[], newCursor: number, exhausted: boolean): void {
    this.dispatch({ type: "prepend", olderMessages, newCursor, exhausted });
  }
}
