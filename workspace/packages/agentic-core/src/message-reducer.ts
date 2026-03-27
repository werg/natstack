/**
 * Message window reducer — single source of truth for messages + pagination.
 *
 * Pure reducer with no React or browser dependencies.
 * Extracted from useChatCore.ts for headless reuse.
 */

import type { ChatMessage } from "./types.js";

const MAX_VISIBLE_MESSAGES = 500;
const TRIM_THRESHOLD = MAX_VISIBLE_MESSAGES * 2;

export interface MessageWindowState {
  messages: ChatMessage[];
  oldestLoadedId: number | null;
  paginationExhausted: boolean;
}

export type MessageWindowAction =
  | { type: "replace"; updater: (prev: ChatMessage[]) => ChatMessage[] }
  | { type: "prepend"; olderMessages: ChatMessage[]; newCursor: number; exhausted: boolean };

export const messageWindowInitialState: MessageWindowState = {
  messages: [],
  oldestLoadedId: null,
  paginationExhausted: false,
};

export function messageWindowReducer(state: MessageWindowState, action: MessageWindowAction): MessageWindowState {
  switch (action.type) {
    case "replace": {
      const updated = action.updater(state.messages);
      if (updated === state.messages) return state;

      // Auto-trim if over threshold
      if (updated.length > TRIM_THRESHOLD) {
        const trimmed = updated.slice(-MAX_VISIBLE_MESSAGES);
        const trimFirstPubsubId = trimmed[0]?.pubsubId;
        return {
          messages: trimmed,
          oldestLoadedId: trimFirstPubsubId ?? state.oldestLoadedId,
          paginationExhausted: false,
        };
      }

      // Initialize cursor if not yet set
      let { oldestLoadedId } = state;
      if (oldestLoadedId === null && updated.length > 0) {
        const firstWithId = updated.find((m) => m.pubsubId !== undefined);
        if (firstWithId?.pubsubId !== undefined) {
          oldestLoadedId = firstWithId.pubsubId;
        }
      }

      return { ...state, messages: updated, oldestLoadedId };
    }
    case "prepend": {
      const existingPubsubIds = new Set(
        state.messages.filter((m) => m.pubsubId != null).map((m) => m.pubsubId)
      );
      const existingMsgIds = new Set(state.messages.map((m) => m.id));
      const deduped = action.olderMessages.filter(
        (m) => (!m.pubsubId || !existingPubsubIds.has(m.pubsubId)) && !existingMsgIds.has(m.id)
      );
      const merged = deduped.length > 0 ? [...deduped, ...state.messages] : state.messages;
      return {
        messages: merged,
        oldestLoadedId: action.newCursor,
        paginationExhausted: action.exhausted,
      };
    }
  }
}
