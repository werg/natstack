/**
 * Launch new chat session button.
 */

import { Box, Button, Flex, Text } from "@radix-ui/themes";
import { ChatBubbleIcon } from "@radix-ui/react-icons";

interface LaunchSectionProps {
  onLaunch: () => void;
  isLaunching?: boolean;
  agentName?: string;
}

export function LaunchSection({ onLaunch, isLaunching, agentName }: LaunchSectionProps) {
  return (
    <Box>
      <Button
        size="4"
        onClick={onLaunch}
        disabled={isLaunching}
        style={{ width: "100%" }}
      >
        <ChatBubbleIcon />
        {isLaunching ? "Launching..." : "Launch New Chat"}
      </Button>

      {agentName && (
        <Text size="1" color="gray" mt="2" style={{ display: "block", textAlign: "center" }}>
          Will spawn {agentName} agent
        </Text>
      )}
    </Box>
  );
}
