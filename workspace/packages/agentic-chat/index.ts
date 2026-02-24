// =============================================================================
// @workspace/agentic-chat — Reusable agentic chat UI + state management
// =============================================================================

// --- Types ---
export type {
  ChatMessage,
  ChatParticipantMetadata,
  DisconnectedAgentInfo,
  PendingAgent,
  PendingAgentStatus,
  ConnectionConfig,
  AgenticChatActions,
  ToolProvider,
  ToolProviderDeps,
  ChatContextValue,
  ChatInputContextValue,
  InlineUiComponentEntry,
} from "./types";

// --- Context ---
export { ChatContext, useChatContext } from "./context/ChatContext";
export { ChatInputContext, useChatInputContext } from "./context/ChatInputContext";
export { ChatProvider } from "./context/ChatProvider";
export type { ChatProviderProps } from "./context/ChatProvider";

// --- Hooks ---
export { useAgenticChat } from "./hooks/useAgenticChat";
export type { UseAgenticChatOptions } from "./hooks/useAgenticChat";

export { useChannelConnection } from "./hooks/useChannelConnection";
export type {
  UseChannelConnectionOptions,
  UseChannelConnectionResult,
  ConnectOptions,
  ConnectionStatus,
} from "./hooks/useChannelConnection";

export { useMethodHistory } from "./hooks/useMethodHistory";

export { dispatchAgenticEvent } from "./hooks/useAgentEvents";
export type {
  AgentEventHandlers,
  DirtyRepoDetails,
  EventMiddleware,
} from "./hooks/useAgentEvents";

// --- High-level components ---
export { AgenticChat } from "./components/AgenticChat";
export type { AgenticChatProps } from "./components/AgenticChat";

// --- Layout components (composable) ---
export { ChatLayout } from "./components/ChatLayout";
export { ChatHeader } from "./components/ChatHeader";
export { ChatMessageArea } from "./components/ChatMessageArea";
export type { ChatMessageAreaProps } from "./components/ChatMessageArea";
export { ChatFeedbackArea } from "./components/ChatFeedbackArea";
export { ChatInput } from "./components/ChatInput";
export { ChatDirtyRepoWarnings } from "./components/ChatDirtyRepoWarnings";
export { ChatDebugConsole } from "./components/ChatDebugConsole";

// --- Primitive components ---
export { MessageList } from "./components/MessageList";
export type { MessageListProps, SenderInfo } from "./components/MessageList";
export { MessageCard } from "./components/MessageCard";
export { MessageContent } from "./components/MessageContent";
export { InlineGroup } from "./components/InlineGroup";
export type { InlineItem } from "./components/InlineGroup";
export { ThinkingPill, ExpandedThinking, PREVIEW_MAX_LENGTH } from "./components/ThinkingMessage";
export { ActionPill, ExpandedAction, parseActionData } from "./components/ActionMessage";
export { CompactMethodPill, ExpandedMethodDetail } from "./components/MethodHistoryItem";
export type { MethodHistoryEntry, MethodCallStatus } from "./components/MethodHistoryItem";
export { MethodArgumentsModal } from "./components/MethodArgumentsModal";
export { TypingPill, parseTypingData } from "./components/TypingMessage";
export { TypingIndicator } from "./components/TypingIndicator";
export { InlineUiMessage, parseInlineUiData } from "./components/InlineUiMessage";
export { ImageGallery } from "./components/ImageGallery";
export { ImageInput, getAttachmentInputsFromPendingImages } from "./components/ImageInput";
export { ParticipantBadgeMenu } from "./components/ParticipantBadgeMenu";
export { ToolPermissionsDropdown } from "./components/ToolPermissionsDropdown";
export { AgentDebugConsole } from "./components/AgentDebugConsole";
export { AgentDisconnectedMessage } from "./components/AgentDisconnectedMessage";
export { DirtyRepoWarning } from "./components/DirtyRepoWarning";
export { PendingAgentBadge } from "./components/PendingAgentBadge";
export { NewContentIndicator } from "./components/NewContentIndicator";
export { ContextUsageRing } from "./components/ContextUsageRing";
export { JsonSchemaForm } from "./components/JsonSchemaForm";
export { ErrorBoundary } from "./components/ErrorBoundary";
export { markdownComponents, mdxComponents } from "./components/markdownComponents";

// --- Utilities ---
export {
  createPendingImage,
  cleanupPendingImages,
  validateImageFile,
  validateImageFiles,
  filterImageFiles,
  fileToAttachmentInput,
  fileToUint8Array,
  createImagePreviewUrl,
  revokeImagePreviewUrl,
  getImagesFromClipboard,
  getImagesFromDragEvent,
  SUPPORTED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  isImageMimeType,
  formatBytes,
} from "./utils/imageUtils";
export type { PendingImage } from "./utils/imageUtils";
