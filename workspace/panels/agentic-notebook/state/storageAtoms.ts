import { atom } from "jotai";
import type { ChatStore } from "../storage/ChatStore";
import type { ChatMetadata, SyncStatus } from "../types/storage";

/**
 * The chat store instance.
 */
export const chatStoreAtom = atom<ChatStore | null>(null);

/**
 * List of all chat metadata.
 */
export const chatListAtom = atom<ChatMetadata[]>([]);

/**
 * Git sync status.
 */
export const syncStatusAtom = atom<SyncStatus>("synced");

/**
 * Currently active chat ID.
 */
export const currentChatIdAtom = atom<string | null>(null);

/**
 * Whether storage is initialized.
 */
export const storageInitializedAtom = atom<boolean>(false);

/**
 * Search query for filtering chats.
 */
export const chatSearchQueryAtom = atom<string>("");

/**
 * Derived atom for filtered chat list.
 */
export const filteredChatListAtom = atom<ChatMetadata[]>((get) => {
  const chats = get(chatListAtom);
  const query = get(chatSearchQueryAtom).toLowerCase().trim();

  if (!query) {
    return chats;
  }

  return chats.filter(
    (chat) =>
      chat.title.toLowerCase().includes(query) ||
      chat.preview.toLowerCase().includes(query)
  );
});

/**
 * Sorted chat list (most recent first).
 */
export const sortedChatListAtom = atom<ChatMetadata[]>((get) => {
  const chats = get(filteredChatListAtom);
  return [...chats].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
  );
});
