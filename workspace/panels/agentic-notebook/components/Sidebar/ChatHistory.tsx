import { useState, useMemo } from "react";
import { Box, Flex, Text, TextField, Card, Badge, AlertDialog, Button, IconButton, ScrollArea } from "@radix-ui/themes";
import { MagnifyingGlassIcon, FileTextIcon, TrashIcon } from "@radix-ui/react-icons";
import type { ChatMetadata } from "../../types/storage";

interface ChatHistoryProps {
  chats: ChatMetadata[];
  currentChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onDeleteChat?: (chatId: string) => void;
  isLoading?: boolean;
}

/**
 * Skeleton loading item for chat list.
 */
function ChatItemSkeleton() {
  return (
    <Card size="1" style={{ background: "transparent" }}>
      <Flex gap="2" align="start">
        <Box
          style={{
            width: 14,
            height: 14,
            borderRadius: 2,
            background: "var(--gray-a4)",
            marginTop: 2,
            animation: "pulse 1.5s ease-in-out infinite",
          }}
        />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Flex justify="between" align="center" gap="2">
            <Box
              style={{
                height: 14,
                width: "60%",
                borderRadius: 2,
                background: "var(--gray-a4)",
                animation: "pulse 1.5s ease-in-out infinite",
              }}
            />
            <Box
              style={{
                height: 12,
                width: 40,
                borderRadius: 2,
                background: "var(--gray-a3)",
                animation: "pulse 1.5s ease-in-out infinite",
              }}
            />
          </Flex>
          <Box
            style={{
              height: 12,
              width: "80%",
              borderRadius: 2,
              background: "var(--gray-a3)",
              marginTop: 6,
              animation: "pulse 1.5s ease-in-out infinite",
            }}
          />
          <Flex gap="1" mt="2">
            <Box
              style={{
                height: 16,
                width: 70,
                borderRadius: 9999,
                background: "var(--gray-a3)",
                animation: "pulse 1.5s ease-in-out infinite",
              }}
            />
          </Flex>
        </Box>
      </Flex>
      <style>
        {`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }`}
      </style>
    </Card>
  );
}

/**
 * Format relative time for chat timestamps.
 */
function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const timestamp = date.getTime();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

/**
 * ChatHistory - Searchable list of chat sessions.
 */
export function ChatHistory({
  chats,
  currentChatId,
  onSelectChat,
  onDeleteChat,
  isLoading = false,
}: ChatHistoryProps) {
  const [searchQuery, setSearchQuery] = useState("");

  // Filter chats by search query
  const filteredChats = useMemo(() => {
    if (!searchQuery.trim()) return chats;
    const query = searchQuery.toLowerCase();
    return chats.filter(
      (chat) =>
        chat.title.toLowerCase().includes(query) ||
        chat.preview?.toLowerCase().includes(query)
    );
  }, [chats, searchQuery]);

  // Sort by most recent
  const sortedChats = useMemo(() => {
    return [...filteredChats].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
    );
  }, [filteredChats]);

  return (
    <Box style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Search */}
      <Box px="3" py="2">
        <TextField.Root
          placeholder="Search titles..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          size="2"
          disabled={isLoading}
        >
          <TextField.Slot>
            <MagnifyingGlassIcon height="14" width="14" />
          </TextField.Slot>
        </TextField.Root>
      </Box>

      {/* Chat list */}
      <ScrollArea type="auto" scrollbars="vertical" style={{ flex: 1 }}>
        <Box px="2" pb="2">
          {isLoading ? (
            <Flex direction="column" gap="1">
              <ChatItemSkeleton />
              <ChatItemSkeleton />
              <ChatItemSkeleton />
            </Flex>
          ) : sortedChats.length === 0 ? (
            <Box py="4" style={{ textAlign: "center" }}>
              <Text size="2" color="gray">
                {searchQuery ? "No matching chats" : "No chats yet"}
              </Text>
            </Box>
          ) : (
            <Flex direction="column" gap="1">
              {sortedChats.map((chat) => (
                <ChatItem
                  key={chat.id}
                  chat={chat}
                  isActive={chat.id === currentChatId}
                  onClick={() => onSelectChat(chat.id)}
                  onDelete={onDeleteChat ? () => onDeleteChat(chat.id) : undefined}
                />
              ))}
            </Flex>
          )}
        </Box>
      </ScrollArea>
    </Box>
  );
}

interface ChatItemProps {
  chat: ChatMetadata;
  isActive: boolean;
  onClick: () => void;
  onDelete?: () => void;
}

/**
 * ChatItem - Individual chat entry in the list.
 */
function ChatItem({ chat, isActive, onClick, onDelete }: ChatItemProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteConfirm(true);
  };

  const handleConfirmDelete = () => {
    onDelete?.();
    setShowDeleteConfirm(false);
  };

  return (
    <Card
      size="1"
      style={{
        cursor: "pointer",
        background: isActive ? "var(--accent-a3)" : "transparent",
        border: isActive ? "1px solid var(--accent-6)" : "1px solid transparent",
      }}
      onClick={onClick}
    >
      <Flex gap="2" align="start">
        <Box style={{ color: "var(--gray-9)", marginTop: "2px" }}>
          <FileTextIcon width="14" height="14" />
        </Box>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Flex justify="between" align="center" gap="2">
            <Text
              size="2"
              weight="medium"
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
              }}
            >
              {chat.title}
            </Text>
            <Flex align="center" gap="1" style={{ flexShrink: 0 }}>
              <Text size="1" color="gray">
                {formatRelativeTime(chat.updatedAt)}
              </Text>
              {onDelete && (
                <AlertDialog.Root open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
                  <AlertDialog.Trigger>
                    <IconButton
                      size="1"
                      variant="ghost"
                      color="gray"
                      onClick={handleDeleteClick}
                      style={{ opacity: 0.5 }}
                      className="delete-button"
                    >
                      <TrashIcon width="12" height="12" />
                    </IconButton>
                  </AlertDialog.Trigger>
                  <AlertDialog.Content maxWidth="400px">
                    <AlertDialog.Title>Delete Chat</AlertDialog.Title>
                    <AlertDialog.Description size="2">
                      Are you sure you want to delete "{chat.title}"? This action cannot be undone.
                    </AlertDialog.Description>
                    <Flex gap="3" mt="4" justify="end">
                      <AlertDialog.Cancel>
                        <Button variant="soft" color="gray">
                          Cancel
                        </Button>
                      </AlertDialog.Cancel>
                      <AlertDialog.Action>
                        <Button variant="solid" color="red" onClick={handleConfirmDelete}>
                          Delete
                        </Button>
                      </AlertDialog.Action>
                    </Flex>
                  </AlertDialog.Content>
                </AlertDialog.Root>
              )}
            </Flex>
          </Flex>
          {chat.preview && (
            <Text
              size="1"
              color="gray"
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                display: "block",
                marginTop: "2px",
              }}
            >
              {chat.preview}
            </Text>
          )}
          <Flex gap="1" mt="1">
            <Badge size="1" color="gray">
              {chat.messageCount} messages
            </Badge>
            {chat.participantIds.length > 2 && (
              <Badge size="1" color="blue">
                {chat.participantIds.length} participants
              </Badge>
            )}
          </Flex>
        </Box>
      </Flex>
    </Card>
  );
}
