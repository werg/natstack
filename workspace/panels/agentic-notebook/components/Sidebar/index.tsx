import { useState } from "react";
import { useAtomValue } from "jotai";
import { Box, Flex, Text, IconButton, Tooltip } from "@radix-ui/themes";
import {
  PlusIcon,
  Cross2Icon,
  UploadIcon,
  CheckCircledIcon,
  CrossCircledIcon,
  ReloadIcon,
} from "@radix-ui/react-icons";
import { ChatHistory } from "./ChatHistory";
import {
  chatListAtom,
  currentChatIdAtom,
  syncStatusAtom,
  storageInitializedAtom,
} from "../../state";
import type { SyncStatus } from "../../types/storage";

interface SidebarProps {
  isOpen: boolean;
  isMobile: boolean;
  onClose: () => void;
  onShare: () => void;
  onNewChat: () => void;
  onSelectChat: (chatId: string) => void;
  onDeleteChat?: (chatId: string) => void;
}

interface SyncStatusIndicatorProps {
  syncStatus: SyncStatus;
  onShare: () => void;
  isSyncing: boolean;
}

/**
 * SyncStatusIndicator - Shows git sync status.
 */
function SyncStatusIndicator({ syncStatus, onShare, isSyncing }: SyncStatusIndicatorProps) {
  const getStatusIcon = () => {
    if (isSyncing) {
      return <ReloadIcon style={{ animation: "spin 1s linear infinite" }} />;
    }
    switch (syncStatus) {
      case "synced":
        return <CheckCircledIcon color="var(--green-9)" />;
      case "error":
        return <CrossCircledIcon color="var(--red-9)" />;
      default:
        return <UploadIcon />;
    }
  };

  const getStatusText = () => {
    if (isSyncing) {
      return "Syncing...";
    }
    switch (syncStatus) {
      case "synced":
        return "Synced";
      case "error":
        return "Sync failed";
      default:
        return "Local changes";
    }
  };

  return (
    <Flex align="center" gap="2">
      <Box style={{ display: "flex", alignItems: "center" }}>
        {getStatusIcon()}
      </Box>
      <Text size="1" color="gray">
        {getStatusText()}
      </Text>
      {!isSyncing && (
        <Tooltip content="Share history (commit & push)">
          <IconButton
            size="1"
            variant="ghost"
            onClick={onShare}
          >
            <UploadIcon />
          </IconButton>
        </Tooltip>
      )}
    </Flex>
  );
}

/**
 * Sidebar - Chat history sidebar with sync controls.
 */
export function Sidebar({
  isOpen,
  isMobile,
  onClose,
  onShare,
  onNewChat,
  onSelectChat,
  onDeleteChat,
}: SidebarProps) {
  const chatList = useAtomValue(chatListAtom);
  const currentChatId = useAtomValue(currentChatIdAtom);
  const syncStatus = useAtomValue(syncStatusAtom);
  const storageInitialized = useAtomValue(storageInitializedAtom);
  const [isSyncing, setIsSyncing] = useState(false);

  const handleShare = async () => {
    setIsSyncing(true);
    try {
      await onShare();
    } finally {
      setIsSyncing(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  // Mobile overlay style
  const mobileStyles = isMobile
    ? {
        position: "absolute" as const,
        left: 0,
        top: 0,
        zIndex: 20,
        boxShadow: "4px 0 12px rgba(0, 0, 0, 0.15)",
      }
    : {};

  return (
    <>
      {/* Mobile backdrop */}
      {isMobile && isOpen && (
        <Box
          onClick={onClose}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0, 0, 0, 0.3)",
            zIndex: 15,
          }}
        />
      )}

      <Box
        style={{
          width: "280px",
          height: "100%",
          borderRight: "1px solid var(--gray-a5)",
          background: "var(--gray-1)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          ...mobileStyles,
        }}
      >
        {/* Header */}
        <Flex
          px="3"
          py="2"
          align="center"
          justify="between"
          style={{ borderBottom: "1px solid var(--gray-a5)" }}
        >
          <Text size="3" weight="medium">
            Chats
          </Text>
          <Flex gap="1">
            <Tooltip content="New chat">
              <IconButton size="1" variant="ghost" onClick={onNewChat}>
                <PlusIcon />
              </IconButton>
            </Tooltip>
            <IconButton size="1" variant="ghost" onClick={onClose}>
              <Cross2Icon />
            </IconButton>
          </Flex>
        </Flex>

        {/* Chat History */}
        <Box style={{ flex: 1, overflow: "hidden" }}>
          <ChatHistory
            chats={chatList}
            currentChatId={currentChatId}
            onSelectChat={onSelectChat}
            onDeleteChat={onDeleteChat}
            isLoading={!storageInitialized}
          />
        </Box>

        {/* Footer with sync status */}
        <Box
          px="3"
          py="2"
          style={{ borderTop: "1px solid var(--gray-a5)" }}
        >
          <SyncStatusIndicator
            syncStatus={syncStatus}
            onShare={handleShare}
            isSyncing={isSyncing}
          />
        </Box>
      </Box>

      {/* CSS for spin animation */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
}
