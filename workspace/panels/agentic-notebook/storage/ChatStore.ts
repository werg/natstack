import { GitClient } from "@natstack/git";
import type {
  ChatMetadata,
  StoredChat,
  ChatIndex,
  SyncStatus,
  SyncResult,
  ChatStorageConfig,
  SerializableChatMetadata,
} from "../types/storage";
import {
  createEmptyChatIndex,
  getChatFilePath,
  getChatIndexPath,
  deserializeChatMetadata,
} from "../types/storage";

/**
 * Filesystem interface (subset of fs/promises).
 */
export interface FileSystem {
  readFile(path: string, encoding: "utf-8"): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

/**
 * Extended config for ChatStore.
 *
 * The historyRepoPath is the OPFS path where the history repo is already cloned
 * by bootstrap (e.g., "/args/history"). This replaces the old gitServerUrl approach.
 */
export interface ChatStoreConfig extends ChatStorageConfig {
  /** Path in OPFS where the history repo is cloned (e.g., "/args/history") */
  historyRepoPath: string;
  /** Git server URL for remote operations (needed if bootstrap didn't run) */
  gitServerUrl?: string;
}

/**
 * Error reporter callback for non-fatal errors.
 */
export type ErrorReporter = (message: string, error: unknown) => void;

/**
 * ChatStore - OPFS-backed storage for chat history with git sync.
 *
 * Storage path: /state/notebook-chats/<panelId>/
 * Structure:
 *   - /chats/<chat-id>.json - Individual chat files
 *   - /index.json - Chat metadata index
 */
export class ChatStore {
  private fs: FileSystem;
  private git: GitClient;
  private config: ChatStoreConfig;
  private syncStatus: SyncStatus = "synced";
  private initialized = false;
  private isSyncing = false;
  private errorReporter: ErrorReporter;

  constructor(
    fs: FileSystem,
    git: GitClient,
    config: ChatStoreConfig,
    errorReporter?: ErrorReporter
  ) {
    this.fs = fs;
    this.git = git;
    this.config = config;
    // Default error reporter logs to console but could be connected to UI
    this.errorReporter = errorReporter ?? ((msg, err) => {
      console.warn(`[ChatStore] ${msg}:`, err);
    });
  }

  /**
   * Get the history repo path in OPFS (cloned by bootstrap).
   */
  private getHistoryRepoPath(): string {
    return this.config.historyRepoPath;
  }

  /**
   * Initialize the store.
   *
   * The history repo is already cloned by bootstrap to historyRepoPath.
   * We just need to ensure the panel's subdirectory exists and pull latest.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const repoPath = this.getHistoryRepoPath();

    // The repo should already exist (cloned by bootstrap)
    const isRepo = await this.git.isRepo(repoPath);

    if (isRepo) {
      // Pull latest changes
      try {
        await this.git.pull({ dir: repoPath });
      } catch (error) {
        this.errorReporter("Failed to pull chat history", error);
        // Continue anyway - we have local data
      }
    } else {
      // Repo doesn't exist - this shouldn't happen if bootstrap ran correctly
      // Initialize an empty repo as fallback
      this.errorReporter("History repo not found at " + repoPath + ", initializing new repo", null);
      try {
        await this.fs.mkdir(repoPath, { recursive: true });
        await this.git.init(repoPath);
        // Add remote if we have a server URL, so sync/push can work
        if (this.config.gitServerUrl) {
          const remoteUrl = `${this.config.gitServerUrl.replace(/\/$/, "")}/${repoPath.replace(/^\//, "")}`;
          await this.git.addRemote(repoPath, "origin", remoteUrl);
        }
      } catch (initError) {
        this.errorReporter("Failed to initialize git repo", initError);
        // Continue without git - local only mode
      }
    }

    // Ensure panel directory exists within the history repo
    await this.fs.mkdir(this.config.basePath, { recursive: true });
    await this.fs.mkdir(`${this.config.basePath}/chats`, { recursive: true });

    // Ensure index exists
    const indexPath = getChatIndexPath(this.config.basePath);
    try {
      await this.fs.readFile(indexPath, "utf-8");
    } catch {
      // Create empty index
      await this.fs.writeFile(
        indexPath,
        JSON.stringify(createEmptyChatIndex(), null, 2)
      );
    }

    this.initialized = true;
  }

  /**
   * Save a chat to storage.
   */
  async saveChat(chat: StoredChat): Promise<void> {
    await this.ensureInitialized();

    const chatPath = getChatFilePath(this.config.basePath, chat.metadata.id);
    await this.fs.writeFile(chatPath, JSON.stringify(chat, null, 2));

    // Update index
    await this.updateIndex(chat.metadata);

    this.syncStatus = "local-changes";
  }

  /**
   * Load a chat from storage.
   */
  async loadChat(chatId: string): Promise<StoredChat | null> {
    await this.ensureInitialized();

    const chatPath = getChatFilePath(this.config.basePath, chatId);
    try {
      const data = await this.fs.readFile(chatPath, "utf-8");
      return JSON.parse(data) as StoredChat;
    } catch {
      return null;
    }
  }

  /**
   * Delete a chat from storage.
   */
  async deleteChat(chatId: string): Promise<void> {
    await this.ensureInitialized();

    const chatPath = getChatFilePath(this.config.basePath, chatId);
    try {
      await this.fs.unlink(chatPath);
    } catch {
      // File might not exist
    }

    // Update index
    await this.removeFromIndex(chatId);

    this.syncStatus = "local-changes";
  }

  /**
   * List all chat metadata.
   */
  async listChats(): Promise<ChatMetadata[]> {
    await this.ensureInitialized();

    const index = await this.loadIndex();
    return index.chats.map(deserializeChatMetadata);
  }

  /**
   * Search chats by query.
   */
  async searchChats(query: string): Promise<ChatMetadata[]> {
    const chats = await this.listChats();
    const lowerQuery = query.toLowerCase();

    return chats.filter(
      (chat) =>
        chat.title.toLowerCase().includes(lowerQuery) ||
        chat.preview.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * Sync changes to git (commit and push).
   */
  async sync(): Promise<SyncResult> {
    await this.ensureInitialized();

    // Prevent concurrent sync operations
    if (this.isSyncing) {
      return { success: false, error: "Sync already in progress" };
    }

    const repoPath = this.getHistoryRepoPath();
    this.isSyncing = true;
    this.syncStatus = "syncing";

    try {
      // Check if there are any changes
      const status = await this.git.status(repoPath);
      if (!status.dirty) {
        this.syncStatus = "synced";
        return { success: true, filesChanged: 0 };
      }

      // Stage all changes
      await this.git.addAll(repoPath);

      // Commit
      const commitHash = await this.git.commit({
        dir: repoPath,
        message: `Update chat history for ${this.config.panelId}`,
      });

      // Push
      try {
        await this.git.push({ dir: repoPath });
      } catch (pushError) {
        // Push might fail if remote doesn't exist yet
        this.errorReporter("Failed to push chat history", pushError);
      }

      this.syncStatus = "synced";
      return {
        success: true,
        commitHash,
        filesChanged: status.files.filter((f) => f.status !== "unmodified").length,
      };
    } catch (error) {
      this.syncStatus = "error";
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Pull latest changes from remote.
   */
  async pull(): Promise<void> {
    await this.ensureInitialized();

    const repoPath = this.getHistoryRepoPath();
    try {
      await this.git.pull({ dir: repoPath });
    } catch (error) {
      this.errorReporter("Failed to pull chat history", error);
    }
  }

  /**
   * Get current sync status.
   */
  getSyncStatus(): SyncStatus {
    return this.syncStatus;
  }

  /**
   * Check if there are local changes.
   */
  async hasLocalChanges(): Promise<boolean> {
    const repoPath = this.getHistoryRepoPath();
    try {
      const status = await this.git.status(repoPath);
      return status.dirty;
    } catch {
      return false;
    }
  }

  // ============ Private Methods ============

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private async loadIndex(): Promise<ChatIndex> {
    const indexPath = getChatIndexPath(this.config.basePath);
    try {
      const data = await this.fs.readFile(indexPath, "utf-8");
      return JSON.parse(data) as ChatIndex;
    } catch {
      return createEmptyChatIndex();
    }
  }

  private async saveIndex(index: ChatIndex): Promise<void> {
    const indexPath = getChatIndexPath(this.config.basePath);
    index.lastUpdated = new Date().toISOString();
    await this.fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  }

  private async updateIndex(metadata: SerializableChatMetadata): Promise<void> {
    const index = await this.loadIndex();

    // Find existing entry
    const existingIndex = index.chats.findIndex((c) => c.id === metadata.id);

    if (existingIndex >= 0) {
      // Update existing
      index.chats[existingIndex] = metadata;
    } else {
      // Add new
      index.chats.push(metadata);
    }

    // Prune if over limit
    if (this.config.maxChats && index.chats.length > this.config.maxChats) {
      // Sort by updatedAt descending
      index.chats.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      // Keep only maxChats
      const removed = index.chats.splice(this.config.maxChats);
      // Delete the removed chat files
      for (const chat of removed) {
        const chatPath = getChatFilePath(this.config.basePath, chat.id);
        try {
          await this.fs.unlink(chatPath);
        } catch {
          // Ignore errors
        }
      }
    }

    await this.saveIndex(index);
  }

  private async removeFromIndex(chatId: string): Promise<void> {
    const index = await this.loadIndex();
    index.chats = index.chats.filter((c) => c.id !== chatId);
    await this.saveIndex(index);
  }
}
