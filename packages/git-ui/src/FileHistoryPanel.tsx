import { Box, Flex, Text, Card, Spinner } from "@radix-ui/themes";
import { useFileHistory } from "./hooks/useFileHistory";
import { formatRelativeTime } from "./utils";

interface FileHistoryPanelProps {
  path: string;
}

export function FileHistoryPanel({ path }: FileHistoryPanelProps) {
  const { history, loading, error } = useFileHistory(path, true);

  if (loading) {
    return (
      <Flex align="center" justify="center" py="3">
        <Spinner size="2" />
      </Flex>
    );
  }

  if (error) {
    return (
      <Box p="3">
        <Text size="2" color="red">
          {error.message}
        </Text>
      </Box>
    );
  }

  if (history.length === 0) {
    return (
      <Box p="3">
        <Text size="2" color="gray">
          No history for this file
        </Text>
      </Box>
    );
  }

  return (
    <Flex direction="column" gap="2">
      {history.map((entry) => (
        <Card key={entry.commit} size="1">
          <Flex direction="column" gap="1">
            <Text size="2" weight="medium">
              {entry.message.split("\n")[0]}
            </Text>
            <Text size="1" color="gray">
              {entry.author.name} - {formatRelativeTime(new Date(entry.author.timestamp * 1000))}
            </Text>
            <Text size="1" color="gray" style={{ fontFamily: "monospace" }}>
              {entry.commit.slice(0, 7)}
            </Text>
          </Flex>
        </Card>
      ))}
    </Flex>
  );
}
