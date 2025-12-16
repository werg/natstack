import { useCallback } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { ChatStore } from "../storage/ChatStore";
import { GitClient } from "@natstack/git";
import {
  chatStoreAtom,
  chatListAtom,
  syncStatusAtom,
  currentChatIdAtom,
  storageInitializedAtom,
  chatSearchQueryAtom,
  sortedChatListAtom,
} from "../state/storageAtoms";
import {
  resetChannelAtom,
  addParticipantAtom,
  toStoredChatAtom,
  loadStoredChatAtom,
  sendMessageAtom,
} from "../state";
import type { SyncStatus } from "../types/storage";
import {
  createUserParticipant,
  createAgentParticipant,
  createSystemParticipant,
} from "../types/channel";

/** User ID constant */
const USER_ID = "user";
const AGENT_ID = "agent";
const SYSTEM_ID = "system";

/**
 * Hook for managing chat storage.
 */
export function useChatStorage(panelId: string) {
  const [chatStore, setChatStore] = useAtom(chatStoreAtom);
  const setChatList = useSetAtom(chatListAtom);
  const [syncStatus, setSyncStatus] = useAtom(syncStatusAtom);
  const [currentChatId, setCurrentChatId] = useAtom(currentChatIdAtom);
  const [isInitialized, setIsInitialized] = useAtom(storageInitializedAtom);

  const storedChat = useAtomValue(toStoredChatAtom);
  const resetChannel = useSetAtom(resetChannelAtom);
  const addParticipant = useSetAtom(addParticipantAtom);
  const loadStoredChat = useSetAtom(loadStoredChatAtom);
  const sendMessage = useSetAtom(sendMessageAtom);

  // Initialize storage
  const initialize = useCallback(
    async (git: GitClient, historyRepoPath: string, gitServerUrl?: string) => {
      // historyRepoPath is where bootstrap cloned the history repo (e.g., "/args/history")
      // basePath is the panel-specific subdirectory within it
      // gitServerUrl is passed as fallback for remote operations if bootstrap didn't run
      const store = new ChatStore(git, {
        panelId,
        basePath: `${historyRepoPath}/${panelId}`,
        historyRepoPath,
        gitServerUrl,
        maxChats: 100,
      });

      await store.initialize();
      setChatStore(store);

      // Load chat list
      const chats = await store.listChats();
      setChatList(chats);
      setSyncStatus(store.getSyncStatus());
      setIsInitialized(true);

      return store;
    },
    [panelId, setChatStore, setChatList, setSyncStatus, setIsInitialized]
  );

  // Add default participants to channel
  const addDefaultParticipants = useCallback(() => {
    addParticipant(createUserParticipant(USER_ID, "You"));
    addParticipant(createAgentParticipant(AGENT_ID, "Assistant", "coding"));
    addParticipant(createSystemParticipant(SYSTEM_ID));
  }, [addParticipant]);

  // Create a new chat
  const createNewChat = useCallback(() => {
    // resetChannel returns the new channel ID
    const newChannelId = resetChannel();
    addDefaultParticipants();
    setCurrentChatId(newChannelId);
    return newChannelId;
  }, [resetChannel, addDefaultParticipants, setCurrentChatId]);

  // Load an existing chat
  const loadChat = useCallback(
    async (chatId: string) => {
      if (!chatStore) {
        throw new Error("Storage not initialized");
      }

      const stored = await chatStore.loadChat(chatId);
      if (!stored) {
        throw new Error(`Chat ${chatId} not found`);
      }

      // Load stored chat data into channel atoms
      loadStoredChat(stored);

      // Re-add participants with proper capabilities
      addDefaultParticipants();

      setCurrentChatId(chatId);
      return chatId;
    },
    [chatStore, loadStoredChat, addDefaultParticipants, setCurrentChatId]
  );

  // Save current chat
  const saveCurrentChat = useCallback(async () => {
    if (!chatStore) return;

    await chatStore.saveChat(storedChat);

    // Refresh chat list
    const chats = await chatStore.listChats();
    setChatList(chats);
    setSyncStatus(chatStore.getSyncStatus());
  }, [chatStore, storedChat, setChatList, setSyncStatus]);

  // Delete a chat
  const deleteChat = useCallback(
    async (chatId: string) => {
      if (!chatStore) return;

      await chatStore.deleteChat(chatId);

      // Refresh chat list
      const chats = await chatStore.listChats();
      setChatList(chats);

      // If deleted current chat, create new one
      if (chatId === currentChatId) {
        createNewChat();
      }
    },
    [chatStore, currentChatId, createNewChat, setChatList]
  );

  // Sync to git
  const sync = useCallback(async () => {
    if (!chatStore) return { success: false, error: "Not initialized" };

    setSyncStatus("syncing");
    const result = await chatStore.sync();
    setSyncStatus(chatStore.getSyncStatus());

    return result;
  }, [chatStore, setSyncStatus]);

  // Pull from git
  const pull = useCallback(async () => {
    if (!chatStore) return;

    await chatStore.pull();

    // Refresh chat list
    const chats = await chatStore.listChats();
    setChatList(chats);
  }, [chatStore, setChatList]);

  // Search chats
  const [searchQuery, setSearchQuery] = useAtom(chatSearchQueryAtom);
  const filteredChats = useAtomValue(sortedChatListAtom);

  return {
    isInitialized,
    chatList: filteredChats,
    currentChatId,
    syncStatus,
    searchQuery,
    setSearchQuery,
    initialize,
    createNewChat,
    loadChat,
    saveCurrentChat,
    deleteChat,
    sync,
    pull,
  };
}

/**
 * Hook for getting sync status.
 */
export function useSyncStatus(): SyncStatus {
  return useAtomValue(syncStatusAtom);
}

/**
 * Hook for getting current chat ID.
 */
export function useCurrentChatId(): string | null {
  return useAtomValue(currentChatIdAtom);
}
