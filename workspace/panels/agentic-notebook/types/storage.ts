import type { AnyParticipant, ParticipantCapabilities, SubmitKeyConfig } from "./channel";
import type { SerializableChannelMessage } from "./messages";

/**
 * Chat metadata for quick listing without loading full content.
 */
export interface ChatMetadata {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  /** First few words for preview */
  preview: string;
  /** Participant IDs at time of last save */
  participantIds: string[];
}

/**
 * Serializable chat metadata for storage.
 */
export interface SerializableChatMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
  participantIds: string[];
}

/**
 * Serialized participant for storage.
 * Preserves full participant state including capabilities and type-specific fields.
 */
export interface SerializedParticipant {
  id: string;
  type: AnyParticipant["type"];
  displayName: string;
  capabilities: ParticipantCapabilities;
  avatar?: string;
  metadata?: Record<string, unknown>;
  // Type-specific fields (preserved as metadata for extensibility)
  modelRole?: string;
  modelId?: string;
  systemPrompt?: string;
  sessionId?: string;
  isReady?: boolean;
  executionCount?: number;
  submitKeyConfig?: SubmitKeyConfig;
}

/**
 * Full stored chat (serializable).
 */
export interface StoredChat {
  metadata: SerializableChatMetadata;
  messages: SerializableChannelMessage[];
  participants: SerializedParticipant[];
}

/**
 * Chat storage configuration.
 */
export interface ChatStorageConfig {
  /** Panel ID for namespacing */
  panelId: string;
  /** Base path in OPFS: /state/notebook-chats/<panelId>/ */
  basePath: string;
  /** Maximum number of chats to keep */
  maxChats?: number;
}

/**
 * Git sync status.
 */
export type SyncStatus = "synced" | "local-changes" | "syncing" | "error";

/**
 * Git sync result.
 */
export interface SyncResult {
  success: boolean;
  error?: string;
  commitHash?: string;
  filesChanged?: number;
}

/**
 * Chat index stored at /state/notebook-chats/<panelId>/index.json
 */
export interface ChatIndex {
  version: number;
  chats: SerializableChatMetadata[];
  lastUpdated: string;
}

/**
 * Create a unique chat ID.
 */
export function createChatId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Generate chat title from first user message.
 */
export function generateChatTitle(firstMessage: string): string {
  const maxLength = 50;
  const cleaned = firstMessage.trim().replace(/\s+/g, " ");
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return cleaned.substring(0, maxLength - 3) + "...";
}

/**
 * Generate chat preview from first message.
 */
export function generateChatPreview(firstMessage: string): string {
  const maxLength = 100;
  const cleaned = firstMessage.trim().replace(/\s+/g, " ");
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return cleaned.substring(0, maxLength - 3) + "...";
}

/**
 * Serialize chat metadata for storage.
 */
export function serializeChatMetadata(metadata: ChatMetadata): SerializableChatMetadata {
  return {
    ...metadata,
    createdAt: metadata.createdAt.toISOString(),
    updatedAt: metadata.updatedAt.toISOString(),
  };
}

/**
 * Deserialize chat metadata from storage.
 */
export function deserializeChatMetadata(data: SerializableChatMetadata): ChatMetadata {
  return {
    ...data,
    createdAt: new Date(data.createdAt),
    updatedAt: new Date(data.updatedAt),
  };
}

/**
 * Default chat index.
 */
export function createEmptyChatIndex(): ChatIndex {
  return {
    version: 1,
    chats: [],
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Get the storage path for a chat file.
 */
export function getChatFilePath(basePath: string, chatId: string): string {
  return `${basePath}/chats/${chatId}.json`;
}

/**
 * Get the storage path for the chat index.
 */
export function getChatIndexPath(basePath: string): string {
  return `${basePath}/index.json`;
}
