/**
 * List of child chat sessions.
 */

import { Box, Text, Card, Flex, Button, Spinner } from "@radix-ui/themes";
import { ChatBubbleIcon, ExternalLinkIcon } from "@radix-ui/react-icons";
import type { ChildSessionInfo } from "../types";

interface SessionHistoryProps {
  sessions: ChildSessionInfo[];
  loading?: boolean;
  onNavigate: (sessionId: string) => void;
  onRefresh: () => void;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function SessionHistory({ sessions, loading, onNavigate, onRefresh }: SessionHistoryProps) {
  return (
    <Box>
      <Flex justify="between" align="center" mb="2">
        <Text size="2" weight="medium">
          Chat Sessions
        </Text>
        <Button variant="ghost" size="1" onClick={onRefresh} disabled={loading}>
          {loading ? <Spinner size="1" /> : "Refresh"}
        </Button>
      </Flex>

      {sessions.length === 0 ? (
        <Card size="1">
          <Flex align="center" justify="center" py="4">
            <Text size="2" color="gray">
              No chat sessions yet. Launch a new chat to get started!
            </Text>
          </Flex>
        </Card>
      ) : (
        <Flex direction="column" gap="2">
          {sessions.map((session) => (
            <Card
              key={session.id}
              size="1"
              style={{ cursor: "pointer" }}
              onClick={() => onNavigate(session.id)}
              tabIndex={0}
            >
              <Flex justify="between" align="center">
                <Flex align="center" gap="2">
                  <ChatBubbleIcon />
                  <Flex direction="column" gap="1">
                    <Text size="2" weight="medium">
                      {session.title}
                    </Text>
                    <Text size="1" color="gray">
                      {formatTime(session.createdAt)}
                    </Text>
                  </Flex>
                </Flex>
                <ExternalLinkIcon color="var(--gray-9)" />
              </Flex>
            </Card>
          ))}
        </Flex>
      )}
    </Box>
  );
}
