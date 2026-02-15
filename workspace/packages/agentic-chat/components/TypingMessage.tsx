import { Flex, IconButton, Spinner, Text } from "@radix-ui/themes";
import { StopIcon } from "@radix-ui/react-icons";
import type { TypingData } from "@workspace/agentic-messaging";

/**
 * Compact pill for typing indicators.
 * Shows who is typing with an optional context and interrupt button.
 */
export function TypingPill({
  data,
  onInterrupt,
}: {
  data: TypingData;
  onInterrupt?: () => void;
}) {
  return (
    <Flex
      align="center"
      gap="1"
      style={{
        padding: "2px 6px",
        borderRadius: "4px",
        backgroundColor: "var(--purple-a3)",
        display: "inline-flex",
      }}
    >
      <Spinner size="1" />
      <Text size="1" color="purple" weight="medium">
        {data.senderName ?? "Agent"} typing
      </Text>
      {data.context && (
        <Text size="1" color="gray" style={{ opacity: 0.7 }}>
          {data.context}
        </Text>
      )}
      {onInterrupt && (
        <IconButton
          size="1"
          color="gray"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            onInterrupt();
          }}
          aria-label="Interrupt"
          title="Stop"
          style={{ marginLeft: 4 }}
        >
          <StopIcon />
        </IconButton>
      )}
    </Flex>
  );
}

/**
 * Parse typing data from message content.
 */
export function parseTypingData(content: string): TypingData {
  try {
    return JSON.parse(content);
  } catch {
    return { senderId: "" };
  }
}
